import { describe, it, expect } from 'vitest';
import {
  validateInputFields, defaultSettings,
  type AgentNode, type WorkflowDefinition, type InputSchema,
} from '../src/domain/types.js';
import { WorkflowEngine, composeStartContent } from '../src/engine/engine.js';
import { ContextManager } from '../src/engine/context-manager.js';
import { MockAgentRunner } from '../src/engine/runner.js';

function node(id: string, type: 'start' | 'end' | 'agent' = 'agent', over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, type, name: id, position: { x: 0, y: 0 },
    identity: { name: id }, roleDescription: id,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
    ...over,
  };
}

function wf(nodes: AgentNode[], edges: Array<[string, string]>, schema?: InputSchema): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_is', name: 'input-schema',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes,
    edges: edges.map(([s, t], i) => ({
      id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
      transform: { enabled: false, instruction: '' }, condition: null,
    })),
    settings: defaultSettings(),
    loops: [], layout: {},
    inputSchema: schema,
  };
}

// ---------------- validateInputFields ----------------

describe('validateInputFields（任务 5：启动字段校验）', () => {
  const schema: InputSchema = {
    fields: [
      { name: 'topic', type: 'text', required: true, label: '主题' },
      { name: 'count', type: 'number' },
      { name: 'style', type: 'select', options: ['formal', 'casual'] },
      { name: 'config', type: 'json' },
      { name: 'ref', type: 'file' },
      { name: 'paths', type: 'files' },
      { name: 'flag', type: 'boolean' },
    ],
  };

  it('缺省/无 schema 宽松通过（旧工作流兼容）', () => {
    expect(validateInputFields(undefined, undefined)).toEqual([]);
    expect(validateInputFields({ fields: [] }, { x: 1 })).toEqual([]);
  });

  it('必填缺失报错', () => {
    const errs = validateInputFields(schema, {});
    expect(errs.some(e => e.includes('主题'))).toBe(true);
  });

  it('类型校验：number / boolean / select / json / files', () => {
    expect(validateInputFields(schema, { topic: 'x', count: 'abc' }).some(e => e.includes('count'))).toBe(true);
    expect(validateInputFields(schema, { topic: 'x', count: 3 }).some(e => e.includes('count'))).toBe(false);
    expect(validateInputFields(schema, { topic: 'x', flag: 'maybe' }).some(e => e.includes('flag'))).toBe(true);
    expect(validateInputFields(schema, { topic: 'x', style: 'weird' }).some(e => e.includes('style'))).toBe(true);
    expect(validateInputFields(schema, { topic: 'x', style: 'formal' }).some(e => e.includes('style'))).toBe(false);
    expect(validateInputFields(schema, { topic: 'x', config: '{bad' }).some(e => e.includes('config'))).toBe(true);
    expect(validateInputFields(schema, { topic: 'x', config: '{"a":1}' }).some(e => e.includes('config'))).toBe(false);
    expect(validateInputFields(schema, { topic: 'x', paths: 'not-array' }).some(e => e.includes('paths'))).toBe(true);
    expect(validateInputFields(schema, { topic: 'x', paths: ['/a', '/b'] }).some(e => e.includes('paths'))).toBe(false);
    expect(validateInputFields(schema, { topic: 'x', ref: 42 }).some(e => e.includes('ref'))).toBe(true);
  });
});

// ---------------- composeStartContent ----------------

describe('composeStartContent（Workflow Input → 初始上下文）', () => {
  const schema: InputSchema = {
    fields: [
      { name: 'lang', type: 'select', label: '语言' },
      { name: 'doc', type: 'file', label: '参考文档' },
      { name: 'files', type: 'files', label: '素材' },
      { name: 'flag', type: 'boolean', label: '开关' },
      { name: 'cfg', type: 'json', label: '配置' },
    ],
  };
  const def = wf([node('start', 'start'), node('end', 'end')], [['start', 'end']], schema);

  it('无字段退化为纯文本（旧行为）', () => {
    expect(composeStartContent(def, { text: 'GO' })).toBe('GO');
  });

  it('字段按类型格式化，文件类只写引用（§55.2）', () => {
    const c = composeStartContent(def, {
      text: '任务开始',
      fields: {
        lang: '中文', doc: 'D:/report.docx', files: ['/a.png', '/b.png'],
        flag: true, cfg: { mode: 'fast' },
      },
    });
    expect(c).toContain('任务开始');
    expect(c).toContain('语言: 中文');
    expect(c).toContain('参考文档: [file:D:/report.docx]');
    expect(c).toContain('[file:/a.png], [file:/b.png]');
    expect(c).toContain('开关: true');
    expect(c).toContain('配置: {"mode":"fast"}');
  });
});

// ---------------- 引擎入口拒绝非法字段 ----------------

describe('引擎运行入口：Input Schema 校验', () => {
  it('必填缺失时 run 抛错且不启动执行', async () => {
    const schema: InputSchema = { fields: [{ name: 'topic', type: 'text', required: true }] };
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')],
      [['start', 'a'], ['a', 'end']], schema);
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    await expect(engine.run(def, { text: 'GO' })).rejects.toThrow(/输入字段校验失败/);
    expect(runner.callRecords).toHaveLength(0);   // 未启动任何节点
  });

  it('字段合法时正常启动且字段进入初始上下文', async () => {
    const schema: InputSchema = {
      fields: [{ name: 'topic', type: 'text', required: true }, { name: 'n', type: 'number' }],
    };
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')],
      [['start', 'a'], ['a', 'end']], schema);
    const runner = new MockAgentRunner();
    const engine = new WorkflowEngine({ runner });
    const h = await engine.run(def, { text: 'GO', fields: { topic: '架构评审', n: 3 } });
    await h.result;
    expect(runner.callRecords.length).toBe(1);
    const prompt = runner.callRecords[0].prompt;
    expect(prompt.user).toContain('架构评审');
    expect(prompt.user).toContain('n: 3');
  });
});

// ---------------- ContextManager 类型过滤 ----------------

describe('ContextManager acceptedTypes 过滤（任务 5）', () => {
  function stateOf(outputs: Record<string, { content: string }[]>) {
    return {
      executionId: 'e', workflowId: 'w', workflowVersion: 1, status: 'running',
      startedAt: '', stepCount: 0, nodeRunCount: {}, loopCount: {},
      nodeStates: {}, outputs, edgeState: {}, artifacts: {},
      reviewTasks: [], auditLog: [], pendingFeedback: {}, humanTasks: [],
    } as any;
  }

  it('下游 acceptedTypes 与上游 artifactTypes 无交集 → 该来源被过滤', () => {
    const codeWriter = node('code', 'agent', {
      outputContract: { description: '', format: 'plaintext', schema: null, requiredSections: [], targets: [], condition: null, artifactTypes: ['code'] },
    });
    const docWriter = node('doc', 'agent', {
      outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null, artifactTypes: ['markdown'] },
    });
    const reader = node('reader', 'agent', {
      inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [], acceptedTypes: ['markdown'] },
    });
    const def = wf([node('start', 'start'), codeWriter, docWriter, reader, node('end', 'end')],
      [['start', 'code'], ['start', 'doc'], ['code', 'reader'], ['doc', 'reader'], ['reader', 'end']]);
    const cm = new ContextManager(def);
    const ctx = cm.buildInputContext(reader, stateOf({
      code: [{ content: 'const x = 1;' }],
      doc: [{ content: '# 文档内容' }],
    }));
    expect(ctx.inputs.map(i => i.sourceNodeId)).toEqual(['doc']);
  });

  it('未声明 acceptedTypes 或 artifactTypes → 不过滤（旧定义兼容）', () => {
    const a = node('a');
    const b = node('b');
    const reader = node('reader');
    const def = wf([node('start', 'start'), a, b, reader, node('end', 'end')],
      [['start', 'a'], ['start', 'b'], ['a', 'reader'], ['b', 'reader'], ['reader', 'end']]);
    const cm = new ContextManager(def);
    const ctx = cm.buildInputContext(reader, stateOf({
      a: [{ content: 'A' }], b: [{ content: 'B' }],
    }));
    expect(ctx.inputs).toHaveLength(2);
  });

  it('上游未声明 artifactTypes 时按 format 推导 kind', () => {
    const jsonNode = node('j');   // format: markdown → kind markdown
    const reader = node('reader', 'agent', {
      inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [], acceptedTypes: ['json'] },
    });
    const def = wf([node('start', 'start'), jsonNode, reader, node('end', 'end')],
      [['start', 'j'], ['j', 'reader'], ['reader', 'end']]);
    const cm = new ContextManager(def);
    const ctx = cm.buildInputContext(reader, stateOf({ j: [{ content: '{}' }] }));
    expect(ctx.inputs).toHaveLength(0);   // markdown ≠ json → 过滤
  });
});
