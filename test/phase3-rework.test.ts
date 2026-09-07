/**
 * 第三阶段 Phase 5：Rework Runtime（§39-43 / Test 7-8）
 * - Rework From Here 产生新 Execution（parentExecutionId + reworkNodeId），历史不可变
 * - 无关节点不重跑（Test 7）：上游直接 success，LLM 调用次数不增
 * - 上下文继承（§40）：起点 prompt 含上游输出 + 新用户请求
 * - 从 rework 执行再次 rework 形成执行树（Test 8）
 * - 审核不绕过（§43）：起点下游的 Review Gate 重新创建任务
 */
import { describe, it, expect } from 'vitest';
import { WorkflowEngine, type ExecutionHandle } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, effectiveRevision, type AgentNode, type ExecutionState, type WorkflowDefinition } from '../src/domain/types.js';

function agent(id: string, type: 'start' | 'end' | 'agent' = 'agent', over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, type, name: id, position: { x: 0, y: 0 },
    identity: { name: id }, roleDescription: `role ${id}`,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
    ...over,
  };
}
const edge = (i: number, s: string, t: string, review = false) => ({
  id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
  transform: { enabled: false, instruction: '' }, condition: null,
  ...(review ? {
    review: {
      enabled: true, mode: 'required' as const,
      allowedActions: ['accept', 'reject', 'edit'] as never[],
      timeout: 60, onTimeout: 'pause' as const,
    },
  } : {}),
});
function chainDef(reviewAfterC = false): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_rw', name: 'rework-chain', revision: 3,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes: [agent('a', 'start'), agent('b'), agent('c'), agent('d'), agent('e', 'end')],
    edges: [edge(1, 'a', 'b'), edge(2, 'b', 'c'), edge(3, 'c', 'd', reviewAfterC), edge(4, 'd', 'e')],
    settings: defaultSettings({ workspaceDir: 'D:/project' }),
    loops: [], layout: {},
  };
}

describe('Phase 5：Rework Runtime（Test 7-8）', () => {
  it('Test 7：从 C rework——A/B 不重跑，C→D 重新执行，新执行带父子链', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef();
    const h1: ExecutionHandle = await engine.run(def, { text: 'first run' });
    const s1: ExecutionState = await h1.result;
    expect(s1.status).toBe('completed');
    const callsAfterFirst = runner.callRecords.length;
    expect(callsAfterFirst).toBe(3); // b/c/d

    // Rework From C
    const h2 = await engine.rework(def, s1, 'c', { text: 'C 的输出仍有问题，请继续修复' });
    const s2 = await h2.result;
    expect(s2.status).toBe('completed');
    expect(s2.executionId).not.toBe(s1.executionId);
    expect(s2.parentExecutionId).toBe(s1.executionId);
    expect(s2.reworkNodeId).toBe('c');
    expect(s2.userInput).toBe('C 的输出仍有问题，请继续修复');
    // 历史 #001 完全未被修改（原则 3）
    expect(s1.nodeStates.c.status).toBe('success');

    // Test 7 核心：A/B 不重跑（LLM 调用只增加 c/d 两次），C/D 重新执行
    const newCalls = runner.callRecords.slice(callsAfterFirst);
    expect(newCalls.map(x => x.node.id).sort()).toEqual(['c', 'd']);
    // 继承节点状态
    expect(s2.nodeStates.a.status).toBe('success');
    expect(s2.nodeStates.b.status).toBe('success');
    expect(s2.nodeStates.c.status).toBe('success');
    expect(s2.nodeStates.d.status).toBe('success');
    // 继承输出可用（§40）：新执行的 b 输出来自父执行
    expect(s2.outputs.b?.length).toBe(s1.outputs.b.length);
    // 版本快照：rework 基于当前定义 revision（§4）
    expect(s2.workflowVersion).toBe(effectiveRevision(def));
    expect(s2.workingDirectory).toBe('D:/project');
  });

  it('§40：rework 起点 prompt = 上游输出 + 新用户请求', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef();
    const s1 = await (await engine.run(def, { text: 'first' })).result;
    const before = runner.callRecords.length;
    await engine.rework(def, s1, 'c', { text: '修复竞态问题' }).then(h => h.result);
    const cCall = runner.callRecords.slice(before).find(x => x.node.id === 'c')!;
    const flat = JSON.stringify(cCall.prompt);
    expect(flat).toContain('修复竞态问题');          // 新请求（pendingFeedback 通道）
    expect(flat).toContain(s1.outputs.b.at(-1)!.content.slice(0, 20)); // 上游输出继承
  });

  it('Test 8：执行树——从 #002 再 rework 产生 #003，链路完整', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef();
    const s1 = await (await engine.run(def, { text: 'r1' })).result;
    const s2 = await (await engine.rework(def, s1, 'c', { text: 'r2' })).result;
    const s3 = await (await engine.rework(def, s2, 'd', { text: 'r3' })).result;
    expect(s3.parentExecutionId).toBe(s2.executionId);
    expect(s3.reworkNodeId).toBe('d');
    expect(s2.parentExecutionId).toBe(s1.executionId);
    // #001 / #002 均未被修改（原则 3）
    expect(s1.status).toBe('completed');
    expect(s2.status).toBe('completed');
  });

  it('§43：rework 不绕过审核——起点下游 Review Gate 重新创建任务', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef(true); // c→d 带审核门
    const h1 = await engine.run(def, { text: 'r1' });
    // 父执行在 c→d gate 挂起：accept 放行让其完成
    let s1 = engine.getExecution(h1.executionId)!;
    for (let i = 0; i < 50 && (s1.reviewTasks?.length ?? 0) === 0; i++) {
      await new Promise(r => setTimeout(r, 100));
      s1 = engine.getExecution(h1.executionId)!;
    }
    expect(s1.reviewTasks.length).toBe(1);
    const firstTaskId = s1.reviewTasks[0].id;
    engine.resolveReview(h1.executionId, firstTaskId, 'accept', { comment: 'LGTM' });
    s1 = await h1.result;
    expect(s1.status).toBe('completed');

    // Rework from c：c 重跑产出新 artifact → gate 必须重新触发（§43）
    const h2 = await engine.rework(def, s1, 'c', { text: 'r2' });
    let s2 = engine.getExecution(h2.executionId)!;
    for (let i = 0; i < 50 && (s2.reviewTasks?.length ?? 0) === 0; i++) {
      await new Promise(r => setTimeout(r, 100));
      s2 = engine.getExecution(h2.executionId)!;
    }
    expect(s2.reviewTasks.length).toBeGreaterThanOrEqual(1);
    expect(s2.reviewTasks[0].id).not.toBe(firstTaskId);  // 新任务，非继承旧任务
    expect(s2.status).toBe('waiting_review');
    engine.control(h2.executionId, 'stop');
  });

  it('非法 rework 请求被拒（节点不存在 / start 起点 / 父执行缺失由宿主校验）', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef();
    const s1 = await (await engine.run(def, { text: 'r1' })).result;
    await expect(engine.rework(def, s1, 'nope', { text: 'x' })).rejects.toThrow('不存在');
    await expect(engine.rework(def, s1, 'a', { text: 'x' })).rejects.toThrow('start/end');
  });
});
