/**
 * Phase 11 —— Human Task Node（§67：人工产出不伪装成 Agent Run）
 * 覆盖：
 * - 人工任务节点暂停等待输入（不调 LLM）
 * - 提交后内容作为输出流向下游
 * - 人工产出登记为 createdBy=human 的 Artifact（v1）
 * - 空内容被拒
 * - 与并行分支互不阻塞
 */
import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';

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
const humanNode = (id: string, taskPrompt = '请人工确认上线清单') =>
  agent(id, { type: 'human_task', roleDescription: '人工审批', metadata: { taskPrompt } });

function wf(nodes: AgentNode[], edges: Array<{ s: string; t: string }>): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_human', name: 'human',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes,
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      source: { nodeId: e.s, output: 'main' },
      target: { nodeId: e.t, input: 'main' },
      transform: { enabled: false, instruction: '' },
      condition: null,
    })),
    settings: defaultSettings(),
    loops: [],
    layout: {},
  };
}

async function waitForStatus(engine: WorkflowEngine, executionId: string, status: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = engine.getExecution(executionId);
    if (s && s.status === status) return;
    await new Promise(r => setTimeout(r, 15));
  }
  const s = engine.getExecution(executionId);
  throw new Error(`等待 ${status} 超时，当前为 ${s?.status}`);
}

describe('Phase 11 Human Task Node（§67）', () => {
  it('人工任务节点暂停：不调 LLM，进入 waiting_human 并创建任务', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'agent-out' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), agent('planner'), humanNode('approve'), endNode()],
      [
        { s: 'start', t: 'planner' },
        { s: 'planner', t: 'approve' },
        { s: 'approve', t: 'end' },
      ],
    );
    const handle = await engine.run(def, { text: 'GO' });

    await waitForStatus(engine, handle.executionId, 'waiting_human');
    const state = engine.getExecution(handle.executionId)!;
    // planner 已跑完，approve 挂起等人工
    expect(state.nodeStates.planner.status).toBe('success');
    expect(state.nodeStates.approve.status).toBe('waiting_human');
    expect(state.humanTasks.length).toBe(1);
    expect(state.humanTasks[0].status).toBe('pending');
    expect(state.humanTasks[0].prompt).toBe('请人工确认上线清单');
    // 关键：人工节点未触发 LLM（runner 只为 planner 调用过一次）
    expect(runner.callRecords.length).toBe(1);
    expect(runner.callRecords[0].node.id).toBe('planner');

    // 提交人工内容
    engine.submitHumanTask(handle.executionId, state.humanTasks[0].id, { content: '确认上线：已核对 3 项', note: '主管签字' });
    await handle.result;

    const final = engine.getExecution(handle.executionId)!;
    expect(final.status).toBe('completed');
    expect(final.nodeStates.approve.status).toBe('success');
    // 人工产出成为节点输出，流向下游（end 汇点成功）
    expect(final.outputs.approve.at(-1)?.content).toBe('确认上线：已核对 3 项');
    // Artifact 登记为人工版本（§67：不伪装成 Agent）
    const art = final.artifacts.approve.at(-1)!;
    expect(art.createdBy).toBe('human');
    expect(art.content).toBe('确认上线：已核对 3 项');
    // 人工节点仍未产生额外 LLM 调用
    expect(runner.callRecords.length).toBe(1);
  }, 15000);

  it('空内容提交被拒（§67）', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'x' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), humanNode('confirm'), endNode()],
      [{ s: 'start', t: 'confirm' }, { s: 'confirm', t: 'end' }],
    );
    const handle = await engine.run(def, { text: 'GO' });
    await waitForStatus(engine, handle.executionId, 'waiting_human');
    const taskId = engine.getExecution(handle.executionId)!.humanTasks[0].id;

    expect(() => engine.submitHumanTask(handle.executionId, taskId, { content: '   ' })).toThrow(/不能为空/);
    // 任务仍待处理
    expect(engine.getExecution(handle.executionId)!.humanTasks[0].status).toBe('pending');

    engine.submitHumanTask(handle.executionId, taskId, { content: '有效输入' });
    await handle.result;
    expect(engine.getExecution(handle.executionId)!.status).toBe('completed');
  }, 15000);

  it('人工任务与并行 Agent 分支互不阻塞', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'parallel-out' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), humanNode('confirm'), agent('worker'), endNode()],
      [
        { s: 'start', t: 'confirm' },   // 人工分支
        { s: 'start', t: 'worker' },    // Agent 分支
        { s: 'confirm', t: 'end' },
        { s: 'worker', t: 'end' },
      ],
    );
    const handle = await engine.run(def, { text: 'GO' });

    // worker 能跑完，不会因 confirm 挂起而被阻塞
    await waitForStatus(engine, handle.executionId, 'waiting_human');
    const st = engine.getExecution(handle.executionId)!;
    expect(st.nodeStates.worker.status).toBe('success');
    expect(st.nodeStates.confirm.status).toBe('waiting_human');

    engine.submitHumanTask(handle.executionId, st.humanTasks[0].id, { content: 'done' });
    await handle.result;
    expect(engine.getExecution(handle.executionId)!.status).toBe('completed');
    expect(runner.callRecords.length).toBe(1);   // 只有 worker 调了 LLM
  }, 15000);

  it('stop 会取消挂起中的人工任务', async () => {
    const runner = new MockAgentRunner({ defaultScript: { type: 'static', text: 'x' } });
    const engine = new WorkflowEngine({ runner });
    const def = wf(
      [startNode(), humanNode('confirm'), endNode()],
      [{ s: 'start', t: 'confirm' }, { s: 'confirm', t: 'end' }],
    );
    const handle = await engine.run(def, { text: 'GO' });
    await waitForStatus(engine, handle.executionId, 'waiting_human');

    engine.control(handle.executionId, 'stop');
    const final = await handle.result;
    expect(final.status).toBe('cancelled');
    expect(final.humanTasks[0].status).toBe('cancelled');
  }, 15000);
});
