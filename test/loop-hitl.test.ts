/**
 * Phase 10 —— Loop + HITL 集成（规格 §69）：
 * - Reject 重跑必须受 Loop Controller 统一管理，不能无限退回
 * - 环节点：连续 reject 达 maxIterations → failed(max_loop_iterations)
 * - 非环节点：连续 reject 耗尽 maxRuns → failed(max_node_runs)，而非误报 deadlock
 * - 环内审核通过后正常收敛完成
 * - loop.iteration 事件在环重跑时正确递增
 */
import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition, type ReviewGateConfig } from '../src/domain/types.js';

let seq = 0;
function agent(id: string, over: Partial<AgentNode> = {}): AgentNode {
  seq++;
  return {
    id, type: 'agent', name: id,
    position: { x: seq * 100, y: 0 },
    identity: { name: `role-${id}` },
    roleDescription: `desc-${id}`,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
    ...over,
  };
}
const startNode = () => agent('start', { type: 'start' });
const endNode = () => agent('end', { type: 'end' });

const REVIEW_REQUIRED: ReviewGateConfig = {
  enabled: true, mode: 'required',
  allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'],
  timeout: null, onTimeout: 'pause',
};

function wf(nodes: AgentNode[], edges: Array<{ s: string; t: string; review?: ReviewGateConfig }>, extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_loop_hitl', name: 'loop-hitl',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes,
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      source: { nodeId: e.s, output: 'main' },
      target: { nodeId: e.t, input: 'main' },
      transform: { enabled: false, instruction: '' },
      condition: null,
      review: e.review,
    })),
    settings: defaultSettings(),
    loops: [],
    layout: {},
    ...extra,
  };
}

/** 循环轮询状态并按决策队列处理审核 */
async function runWithDecisions(
  engine: WorkflowEngine,
  def: WorkflowDefinition,
  input: string,
  decisions: Array<{ match: (t: any) => boolean; action: 'accept' | 'reject' | 'edit' | 'accept_after_edit' | 'terminate'; opts?: { comment?: string; content?: string } }>,
  maxWaits = 30,
) {
  const events: any[] = [];
  const off = engine.eventBus.on('*', e => events.push(e));
  // 先订阅再启动：MockAgentRunner 执行极快，后置订阅会丢失早期事件（如首个 loop.iteration）
  const handle = await engine.run(def, { text: input });
  let idx = 0;
  for (let wait = 0; wait < maxWaits; wait++) {
    const state = engine.getExecution(handle.executionId)!;
    for (const task of state.reviewTasks.filter(t => t.status === 'pending')) {
      if (idx < decisions.length && decisions[idx].match(task)) {
        engine.resolveReview(handle.executionId, task.id, decisions[idx].action, decisions[idx].opts);
        idx++;
      }
    }
    const s = engine.getExecution(handle.executionId)!;
    if (['completed', 'failed', 'terminated', 'cancelled'].includes(s.status)) {
      off();
      return { state: s, events };
    }
    await new Promise(r => setTimeout(r, 20));
  }
  off();
  throw new Error('workflow 未在限定轮次内结束');
}

describe('Phase 10 Loop + HITL 集成（§69）', () => {
  it('环节点连续 reject：达 maxIterations 后以 max_loop_iterations 终止，不误报死锁', async () => {
    // writer ↔ critic 环（maxIterations=2）；critic→end 边挂审核，审核人连续退回
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'draft' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), agent('writer'), agent('critic'), endNode()],
      [
        { s: 'start', t: 'writer' },
        { s: 'writer', t: 'critic' },
        { s: 'critic', t: 'writer' },                          // 环回边
        { s: 'critic', t: 'end', review: REVIEW_REQUIRED },   // 环出口审核
      ],
      { loops: [{ loopId: 'loop_001', nodeIds: ['writer', 'critic'], maxIterations: 2 }] },
    );
    const { state, events } = await runWithDecisions(engine, def, 'GO', [
      { match: () => true, action: 'reject', opts: { comment: '第一轮：论据不足' } },
      { match: () => true, action: 'reject', opts: { comment: '第二轮：仍不合格' } },
      { match: () => true, action: 'reject', opts: { comment: '第三轮：不应有机会执行' } },
    ]);
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('max_loop_iterations');
    // §32/§33: Loop 终止仅依赖执行上限，不再依赖审核 accept。
    // maxIterations=2 → writer 跑 2 轮、critic 跑 2 轮（含 1 次 reject 重跑）
    expect(state.nodeRunCount.critic).toBe(2);
    expect(state.nodeRunCount.writer).toBe(2);
    expect(events.some(e => e.type === 'loop.terminated')).toBe(true);
    // reject 反馈确实注入过（第二轮写手带着意见重跑）
    expect(state.auditLog.filter(a => a.action === 'reject').length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('非环节点连续 reject：耗尽 maxRuns 后以 max_node_runs 终止，而非 deadlock', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'out' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), agent('solo', { runtimeConfig: { maxRuns: 2, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' } }), endNode()],
      [
        { s: 'start', t: 'solo' },
        { s: 'solo', t: 'end', review: REVIEW_REQUIRED },
      ],
    );
    const { state } = await runWithDecisions(engine, def, 'GO', [
      { match: () => true, action: 'reject', opts: { comment: '退回 1' } },
      { match: () => true, action: 'reject', opts: { comment: '退回 2' } },
      { match: () => true, action: 'reject', opts: { comment: '不应执行' } },
    ]);
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('max_node_runs');      // 关键断言：不是 deadlock
    expect(state.nodeRunCount.solo).toBe(2);
  }, 15000);

  it('环内 reject 后 accept：第 2 轮产出放行，环继续至 maxIterations（§32/§33）', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'v-draft' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), agent('writer'), agent('critic'), endNode()],
      [
        { s: 'start', t: 'writer' },
        { s: 'writer', t: 'critic' },
        { s: 'critic', t: 'writer' },
        { s: 'critic', t: 'end', review: REVIEW_REQUIRED },
      ],
      { loops: [{ loopId: 'loop_001', nodeIds: ['writer', 'critic'], maxIterations: 3 }] },
    );
    const { state, events } = await runWithDecisions(engine, def, 'GO', [
      { match: () => true, action: 'reject', opts: { comment: '补充数据来源说明' } },
      { match: () => true, action: 'accept', opts: { comment: '第 2 轮通过' } },
      { match: () => true, action: 'accept' },  // 后续轮次自动放行
      { match: () => true, action: 'accept' },
      { match: () => true, action: 'accept' },
      { match: () => true, action: 'accept' },
    ]);
    // §32/§33: Loop 终止仅依赖执行上限，accept 不再冻结环。
    // 环继续运行至 maxIterations=3，writer 跑 3 轮、critic 跑 4 轮（含 1 次 reject 重跑）
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('max_loop_iterations');
    expect(state.nodeRunCount.writer).toBeGreaterThanOrEqual(3);
    expect(state.nodeRunCount.critic).toBeGreaterThanOrEqual(3);
    // 审计链包含 reject + accept
    const actions = state.auditLog.map(a => a.action);
    expect(actions).toContain('reject');
    expect(actions).toContain('accept');
    // 环终止事件：max iterations（非收敛冻结）
    expect(events.some(e => e.type === 'loop.terminated'
      && (e.payload as any)?.reason === 'max iterations')).toBe(true);
  }, 15000);

  it('loop.iteration 事件随环重跑递增至 maxIterations', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'x' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), agent('writer'), agent('critic'), endNode()],
      [
        { s: 'start', t: 'writer' },
        { s: 'writer', t: 'critic' },
        { s: 'critic', t: 'writer' },
        { s: 'critic', t: 'end', review: REVIEW_REQUIRED },
      ],
      { loops: [{ loopId: 'loop_001', nodeIds: ['writer', 'critic'], maxIterations: 3 }] },
    );
    const { events } = await runWithDecisions(engine, def, 'GO', [
      { match: () => true, action: 'reject', opts: { comment: '再来' } },
      { match: () => true, action: 'accept' },
      { match: () => true, action: 'accept' },
      { match: () => true, action: 'accept' },
      { match: () => true, action: 'accept' },
    ]);
    const iters = events.filter(e => e.type === 'loop.iteration').map(e => e.payload.iteration);
    // §32/§33: 环不受 accept 冻结，继续运行至 maxIterations=3
    expect(iters.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...iters)).toBeGreaterThanOrEqual(3);
  }, 15000);
});
