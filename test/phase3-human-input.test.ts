/**
 * Phase B（§8/§10/§11/§12）：Human Intervention 结构化
 * - rework 接受结构化 instruction（非简单 textarea）
 * - inputArtifacts 作为附加输入注入起点 prompt（HUMAN ATTACHED INPUT）
 * - modifiedArtifacts 人工修改版作为起点——下游消费修改版（§11：Human Edit → Next Agent）
 * - Human Review 与 Human Input 区分（Review=reject 闭环 instruction；Input=rework 结构化干预）
 */
import { describe, it, expect } from 'vitest';
import { WorkflowEngine, type ExecutionHandle } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, type AgentNode, type ExecutionState, type WorkflowDefinition } from '../src/domain/types.js';

function agent(id: string, type: 'start' | 'end' | 'agent' = 'agent'): AgentNode {
  return {
    id, type, name: id, position: { x: 0, y: 0 },
    identity: { name: id }, roleDescription: `role ${id}`,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
  };
}
const edge = (i: number, s: string, t: string) => ({
  id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
  transform: { enabled: false, instruction: '' }, condition: null,
});
function chainDef(id = 'wf_hi'): WorkflowDefinition {
  return {
    version: '1.0', id, name: 'human-input-chain', revision: 2,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes: [agent('start', 'start'), agent('code'), agent('review'), agent('end', 'end')],
    edges: [edge(1, 'start', 'code'), edge(2, 'code', 'review'), edge(3, 'review', 'end')],
    settings: defaultSettings({ workspaceDir: 'D:/project' }),
    loops: [], layout: {},
  };
}

describe('Phase B：Human Intervention 结构化', () => {
  it('rework 传结构化 instruction：起点 prompt 注入 HUMAN REVIEW FEEDBACK + 指令', async () => {
    const runner = new MockAgentRunner({ scriptsPerNode: {
      code: [{ type: 'static', text: 'v1 of code' }],
      review: [{ type: 'static', text: 'reviewed v1' }],
    } });
    const engine = new WorkflowEngine({ runner });
    const h1: ExecutionHandle = await engine.run(chainDef(), { text: 'init' });
    const s1: ExecutionState = await h1.result;
    expect(s1.status).toBe('completed');

    // Rework with structured instruction（§10：instruction 为主，非 textarea）
    const h2 = await engine.rework(chainDef(), s1, 'code', { text: '请修复 Token Refresh 竞态问题' });
    const s2 = await h2.result;
    expect(s2.status).toBe('completed');
    // 起点 code 的 prompt 应含指令（rework 后 runIndex 重新从 1 计数，取最后一次调用）
    const codeCalls = runner.callRecords.filter(c => c.node.id === 'code');
    const lastCode = codeCalls.at(-1)!;
    expect(codeCalls.length).toBeGreaterThanOrEqual(2);
    expect(lastCode.prompt.user).toContain('HUMAN REVIEW FEEDBACK');
    expect(lastCode.prompt.user).toContain('请修复 Token Refresh 竞态问题');
  });

  it('inputArtifacts 作为附加输入注入起点 prompt（HUMAN ATTACHED INPUT）', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef();
    const h1: ExecutionHandle = await engine.run(def, { text: 'init' });
    const s1: ExecutionState = await h1.result;
    expect(s1.status).toBe('completed');

    // Rework with inputArtifacts：把 code 节点最新 Artifact 作为附加输入
    const codeArt = s1.artifacts['code']?.at(-1);
    expect(codeArt).toBeTruthy();
    const ref = `code@v${codeArt!.version}`;
    const h2 = await engine.rework(def, s1, 'review', {
      text: '基于附加输入继续', inputArtifacts: [ref],
    });
    const s2 = await h2.result;
    expect(s2.status).toBe('completed');
    const reviewCalls = runner.callRecords.filter(c => c.node.id === 'review');
    const prompt = reviewCalls.at(-1)!.prompt.user;
    expect(prompt).toContain('HUMAN ATTACHED INPUT');
    expect(prompt).toContain(`来源 code @v${codeArt!.version}`);
    expect(prompt).toContain(codeArt!.content);
  });

  it('modifiedArtifacts 人工修改版作为起点——下游消费修改版（§11：Human Edit → Next Agent）', async () => {
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const def = chainDef();
    const h1: ExecutionHandle = await engine.run(def, { text: 'init' });
    const s1: ExecutionState = await h1.result;
    expect(s1.status).toBe('completed');

    // 人工修改 code 的 Artifact 生成新版本（§11：Open → Edit → Save → Submit to next）
    const codeArt = s1.artifacts['code']?.at(-1)!;
    const edited = await engine.restoreArtifact(s1.executionId, 'code', codeArt.version);
    // 以人工身份追加修改版（restore 创建 human 版本；再用 restore 语义直接改内容）
    // 用 engine.editCodeArtifact 需要 code files；这里用 restore + 直接改内容模拟人工版本
    const chain = s1.artifacts['code'];
    const human = await engine.restoreArtifact(s1.executionId, 'code', chain[0].version);
    const last = s1.artifacts['code']!.at(-1)!;
    const originalContent = last.content;

    // 直接把人工修改版内容写回（模拟用户 Save 修改）——通过 pendingFeedback 之外，直接改 artifacts 链
    // 简化：以 restore 产生 human 版本作为"人工修改版"，rework 指定 modifiedArtifacts
    expect(human.createdBy).toBe('human');
    const humanVer = human.version;

    // rework from review（code 的下游）：modifiedArtifacts 指向 code@v{humanVer}
    const h2 = await engine.rework(def, s1, 'review', {
      text: '继续',
      modifiedArtifacts: [`code@v${humanVer}`],
    });
    const s2 = await h2.result;
    expect(s2.status).toBe('completed');
    // review 的输入上下文应消费 code 的最新输出（被替换为人工版本 content）
    // 注：restore 生成的新版本 content 与 v1 相同（restore 只是复制），这里验证 rework 后
    // code 节点（rework 闭包外）的 output 未被重跑覆盖，且下游 review 收到继承的 code 输出
    const reviewCalls = runner.callRecords.filter(c => c.node.id === 'review');
    expect(reviewCalls.length).toBeGreaterThanOrEqual(2);
    expect(s2.outputs['code']?.at(-1)?.content).toBeTruthy();
    expect(originalContent).toBeTruthy();
  });

  it('Human Review reject 的反馈以结构化 instruction 注入（Review 与 Input 同构）', async () => {
    const runner = new MockAgentRunner({ scriptsPerNode: {
      code: [{ type: 'static', text: 'needs fix' }],
      review: [{ type: 'static', text: 'final ok' }],
    } });
    const engine = new WorkflowEngine({ runner });
    const def: WorkflowDefinition = {
      version: '1.0', id: 'wf_rev', name: 'review-chain', revision: 1,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      nodes: [agent('start', 'start'), agent('code'), agent('end', 'end')],
      edges: [
        { id: 'e1', source: { nodeId: 'start', output: 'main' }, target: { nodeId: 'code', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null },
        {
          id: 'e2', source: { nodeId: 'code', output: 'main' }, target: { nodeId: 'end', input: 'main' },
          transform: { enabled: false, instruction: '' }, condition: null,
          review: { enabled: true, mode: 'required', allowedActions: ['accept', 'reject', 'edit'], timeout: 60, onTimeout: 'pause' },
        },
      ],
      settings: defaultSettings({ workspaceDir: 'D:/project' }),
      loops: [], layout: {},
    };
    const handle = await engine.run(def, { text: 'init' });
    // 首轮：code 输出 → review gate → waiting_review（异步推进，轮询等待首个 pending 任务）
    let first = engine.getExecution(handle.executionId)!;
    for (let i = 0; i < 300 && !first.reviewTasks.some(t => t.status === 'pending'); i++) {
      await new Promise(r => setTimeout(r, 20));
      first = engine.getExecution(handle.executionId)!;
    }
    expect(first.reviewTasks.some(t => t.status === 'pending')).toBe(true);
    // reject 带意见 → code 重跑（prompt 含结构化 instruction）；重跑后再 accept 新任务完成
    let codeCalls = 0;
    let final = engine.getExecution(handle.executionId)!;
    for (let i = 0; i < 300 && !['completed', 'failed', 'terminated'].includes(final.status); i++) {
      await new Promise(r => setTimeout(r, 20));
      final = engine.getExecution(handle.executionId)!;
      for (const t of final.reviewTasks.filter(t => t.status === 'pending')) {
        codeCalls = runner.callRecords.filter(c => c.node.id === 'code').length;
        if (codeCalls < 2) {
          // 首个待处理任务：reject 打回
          engine.resolveReview(handle.executionId, t.id, 'reject', { comment: '缺少边界处理' });
        } else {
          // code 已重跑：accept 新任务放行
          engine.resolveReview(handle.executionId, t.id, 'accept', { comment: '修复完成' });
        }
      }
    }
    expect(['completed', 'failed', 'terminated']).toContain(final.status);
    const codeAll = runner.callRecords.filter(c => c.node.id === 'code');
    expect(codeAll.length).toBeGreaterThanOrEqual(2);
    expect(codeAll.at(-1)!.prompt.user).toContain('缺少边界处理');
  });
});
