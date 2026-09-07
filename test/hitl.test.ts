/**
 * Human-in-the-Loop 集成测试（规格 §53-81）：
 * - Review Gate 阻塞下游 / waiting_review 状态
 * - Accept：放行，下游收到成果
 * - Edit：版本 +1，下游拿到人工编辑内容（§72）
 * - Reject：反馈闭环（原任务+历史输出+意见），重新审核（§62/§68）
 * - Terminate：终止 workflow
 * - 审计记录、版本链、超时策略
 */
import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition, type ReviewGateConfig } from '../src/domain/types.js';
import { approvedArtifactOf, artifactVersions } from '../src/engine/artifact-manager.js';

let seq = 0;
function agent(id: string, over: Partial<AgentNode> = {}): AgentNode {
  seq++;
  return {
    id, type: 'agent', name: id,
    position: { x: seq * 100, y: 0 },
    identity: { name: `role-${id}` },
    roleDescription: `desc-${id}`,
    inputContract: {
      description: '', processing: '', selection: '', ignore: '',
      constraints: [], sourceMode: 'all', selectedSourceNodeIds: [],
    },
    outputContract: {
      description: '', format: 'markdown', schema: null,
      requiredSections: [], targets: [], condition: null,
    },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: {
      maxRuns: 5, timeoutMs: 120000,
      retry: { enabled: false, maxRetries: 0, backoffMs: 0 },
      onFailure: 'fail_workflow',
    },
    metadata: {},
    ...over,
  };
}
const startNode = (id = 'start') => agent(id, { type: 'start' });
const endNode = (id = 'end') => agent(id, { type: 'end' });

const REVIEW_REQUIRED: ReviewGateConfig = {
  enabled: true, mode: 'required',
  allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'],
  timeout: null, onTimeout: 'pause',
};

function wf(nodes: AgentNode[], edges: Array<{ s: string; t: string; review?: ReviewGateConfig }>): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_hitl', name: 'hitl',
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
  };
}

/** 运行并在出现 pending review 时执行决策（可多次） */
async function runWithReviews(
  engine: WorkflowEngine,
  def: WorkflowDefinition,
  input: string,
  decisions: Array<{ match: (t: any) => boolean; action: 'accept' | 'reject' | 'edit' | 'accept_after_edit' | 'terminate'; opts?: { comment?: string; content?: string } }>,
  maxWaits = 10,
) {
  const handle = await engine.run(def, { text: input });
  const events: any[] = [];
  engine.eventBus.on('*', e => events.push(e));

  let decisionIdx = 0;
  for (let wait = 0; wait < maxWaits; wait++) {
    const state = engine.getExecution(handle.executionId)!;
    // 处理所有当前 pending 且匹配的决策
    const pending = state.reviewTasks.filter(t => t.status === 'pending');
    for (const task of pending) {
      if (decisionIdx < decisions.length && decisions[decisionIdx].match(task)) {
        const d = decisions[decisionIdx++];
        engine.resolveReview(handle.executionId, task.id, d.action, d.opts);
      }
    }
    const s = engine.getExecution(handle.executionId)!;
    if (['completed', 'failed', 'terminated', 'cancelled'].includes(s.status)) {
      return { state: s, events };
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('测试等待超时：workflow 未结束');
}

describe('HITL：Review Gate', () => {
  it('required 边阻塞下游：A 完成后进 waiting_review，B 未执行', async () => {
    const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
    const handle = await engine.run(wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: REVIEW_REQUIRED }, { s: 'b', t: 'end' }],
    ), { text: 'hello' });

    // 等到 waiting_review
    let state = engine.getExecution(handle.executionId)!;
    for (let i = 0; i < 100 && state.status !== 'waiting_review'; i++) {
      await new Promise(r => setTimeout(r, 10));
      state = engine.getExecution(handle.executionId)!;
    }
    expect(state.status).toBe('waiting_review');
    expect(state.nodeStates['a'].status).toBe('waiting_review');
    expect(state.outputs['b'] ?? []).toHaveLength(0);   // B 未执行
    expect(state.reviewTasks).toHaveLength(1);
    expect(state.reviewTasks[0].status).toBe('pending');
    expect(state.auditLog.some(a => a.action === 'request')).toBe(true);

    // accept 放行
    engine.resolveReview(handle.executionId, state.reviewTasks[0].id, 'accept', { comment: 'LGTM' });
    const final = await handle.result;
    expect(final.status).toBe('completed');
    expect(final.outputs['b']).toHaveLength(1);
    expect(final.auditLog.some(a => a.action === 'accept')).toBe(true);
  });

  it('Accept：下游正常收到成果，审计链完整', async () => {
    const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
    const { state } = await runWithReviews(engine, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: REVIEW_REQUIRED }, { s: 'b', t: 'end' }],
    ), 'hello', [{ match: t => t.sourceNodeId === 'a', action: 'accept', opts: { comment: '通过' } }]);
    expect(state.status).toBe('completed');
    expect(state.auditLog.map(a => a.action)).toContain('request');
    expect(state.auditLog.map(a => a.action)).toContain('accept');
  });

  it('Edit：版本链 v1(agent)→v2(human)，下游拿到编辑后内容（§72）', async () => {
    const engine = new WorkflowEngine({
      runner: new MockAgentRunner({
        scriptsPerNode: {
          a: [{ type: 'static', text: 'IdentityService\nQuestionService\nPaperService' }],
          b: [{ type: 'dynamic', fn: req => req.prompt.user }],
        },
      }),
    });
    const { state } = await runWithReviews(engine, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: REVIEW_REQUIRED }, { s: 'b', t: 'end' }],
    ), 'hello', [{
      match: t => t.sourceNodeId === 'a',
      action: 'edit',
      opts: { content: 'IdentityService\nQuestionService\nPaperService\nPaperGenerationService', comment: '拆分 Paper 服务' },
    }]);
    expect(state.status).toBe('completed');

    // 版本链（§65）：v1 agent 原始、v2 human 编辑
    const versions = artifactVersions(state, 'a');
    expect(versions).toHaveLength(2);
    expect(versions[0].createdBy).toBe('agent');
    expect(versions[1].createdBy).toBe('human');
    expect(versions[1].parentVersion).toBe(1);
    expect(versions[0].content).toContain('PaperService');      // 原始保留，未被覆盖
    expect(approvedArtifactOf(state, 'a')!.version).toBe(2);

    // 下游 B 收到的必须是 Human Edited Artifact（§72）
    const bPrompt = state.outputs['b'][0].content;
    expect(bPrompt).toContain('PaperGenerationService');

    // 审计：edit 动作带版本迁移
    const editAudit = state.auditLog.find(a => a.action === 'edit');
    expect(editAudit?.fromVersion).toBe(1);
    expect(editAudit?.toVersion).toBe(2);
    expect(editAudit?.comment).toBe('拆分 Paper 服务');
  });

  it('Reject：反馈闭环——A 带审核意见重跑，再次进入审核（§61-62/§68）', async () => {
    const engine = new WorkflowEngine({
      runner: new MockAgentRunner({
        scriptsPerNode: {
          a: [
            { type: 'static', text: '方案一：忽略并发' },
            { type: 'dynamic', fn: req => req.prompt.user },   // 第 2 轮：返回 prompt 以验证反馈注入
          ],
        },
      }),
    });
    const { state } = await runWithReviews(engine, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: REVIEW_REQUIRED }, { s: 'b', t: 'end' }],
    ), 'hello', [
      { match: t => t.status === 'pending', action: 'reject', opts: { comment: '数据库设计没有考虑并发场景，请重新设计事务边界。' } },
      { match: t => t.status === 'pending', action: 'accept', opts: { comment: '可以了' } },
    ]);
    expect(state.status).toBe('completed');

    // A 运行了 2 次（原任务 + 反馈重跑），不是简单重试
    expect(state.nodeRunCount['a']).toBe(2);

    // 第 2 轮 prompt 必须包含：原任务输出 + 人工反馈（§62 新任务上下文）
    const aSecondRun = state.outputs['a'][1].content;
    expect(aSecondRun).toContain('数据库设计没有考虑并发场景');
    expect(aSecondRun).toContain('HUMAN REVIEW FEEDBACK');
    expect(aSecondRun).toContain('方案一：忽略并发');

    // 两轮各有独立审核任务（§67：Human Review 与 Agent Run 分离）
    expect(state.reviewTasks).toHaveLength(2);
    expect(state.reviewTasks[0].status).toBe('rejected');
    expect(state.reviewTasks[1].status).toBe('accepted');
    expect(state.auditLog.filter(a => a.action === 'request')).toHaveLength(2);
  });

  it('Terminate：人工终止整个 workflow', async () => {
    const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
    const { state } = await runWithReviews(engine, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: REVIEW_REQUIRED }, { s: 'b', t: 'end' }],
    ), 'hello', [{ match: () => true, action: 'terminate', opts: { comment: '需求不对，停止' } }]);
    expect(state.status).toBe('terminated');
    expect(state.error?.code).toBe('review_terminated');
    expect(state.outputs['b'] ?? []).toHaveLength(0);
    expect(state.auditLog.some(a => a.action === 'terminate')).toBe(true);
  });

  it('Reject 必须携带审核意见，否则报错（§61）', async () => {
    const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
    const handle = await engine.run(wf(
      [startNode(), agent('a'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'end', review: REVIEW_REQUIRED }],
    ), { text: 'x' });
    let state = engine.getExecution(handle.executionId)!;
    for (let i = 0; i < 100 && state.status !== 'waiting_review'; i++) {
      await new Promise(r => setTimeout(r, 10));
      state = engine.getExecution(handle.executionId)!;
    }
    const taskId = state.reviewTasks[0].id;
    expect(() => engine.resolveReview(handle.executionId, taskId, 'reject', {})).toThrow(/审核意见/);
    // 清理：accept 收尾
    engine.resolveReview(handle.executionId, taskId, 'accept');
    await handle.result;
  });

  it('Reject 循环受 loop 限制统一管理（§69：Maximum Loop Iterations）', async () => {
    const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
    // maxRuns=3：reject 两次后第三次到达上限
    const def = wf(
      [startNode(), agent('a', {
        runtimeConfig: { maxRuns: 3, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
      }), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'end', review: REVIEW_REQUIRED }],
    );
    const handle = await engine.run(def, { text: 'x' });
    const decisions = ['reject', 'reject', 'reject'];
    let di = 0;
    let final = engine.getExecution(handle.executionId)!;
    for (let i = 0; i < 300 && !['completed', 'failed', 'terminated'].includes(final.status); i++) {
      await new Promise(r => setTimeout(r, 20));
      final = engine.getExecution(handle.executionId)!;
      for (const t of final.reviewTasks.filter(t => t.status === 'pending')) {
        if (di < decisions.length) {
          engine.resolveReview(handle.executionId, t.id, decisions[di++] as never, { comment: `第${di}次打回` });
        }
      }
    }
    // 第 3 次 reject 后 A 达到 maxRuns=3，不再重跑；workflow 因无可运行节点失败
    expect(final.nodeRunCount['a']).toBe(3);
    expect(['failed', 'terminated']).toContain(final.status);
  });

  it('超时策略 auto_accept：审核超时自动放行（§70）', async () => {
    const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
    const def = wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: { ...REVIEW_REQUIRED, timeout: 1, onTimeout: 'auto_accept' } }, { s: 'b', t: 'end' }],
    );
    const state = await (await engine.run(def, { text: 'x' })).result;
    expect(state.status).toBe('completed');
    expect(state.outputs['b']).toHaveLength(1);
    expect(state.auditLog.some(a => a.action === 'timeout')).toBe(true);
    // 超时后自动通过也记录在案
    const timeoutIdx = state.auditLog.findIndex(a => a.action === 'timeout');
    expect(state.auditLog.slice(timeoutIdx).some(a => a.action === 'accept' && a.operator === 'system')).toBe(true);
  }, 15_000);

  it('includeReviewFeedback：accept 意见进入下游 Context（§73）', async () => {
    const engine = new WorkflowEngine({
      runner: new MockAgentRunner({
        scriptsPerNode: { b: [{ type: 'dynamic', fn: req => req.prompt.user }] },
      }),
    });
    const def = wf(
      [startNode(), agent('a'), agent('b', {
        inputContract: {
          description: '', processing: '', selection: '', ignore: '',
          constraints: [], sourceMode: 'all', selectedSourceNodeIds: [],
          includeReviewFeedback: true,
        },
      }), endNode()],
      [{ s: 'start', t: 'a' }, { s: 'a', t: 'b', review: REVIEW_REQUIRED }, { s: 'b', t: 'end' }],
    );
    const { state } = await runWithReviews(engine, def, 'hello', [
      { match: () => true, action: 'accept', opts: { comment: '请考虑 Redis 缓存一致性问题' } },
    ]);
    expect(state.status).toBe('completed');
    expect(state.outputs['b'][0].content).toContain('请考虑 Redis 缓存一致性问题');
  });
});
