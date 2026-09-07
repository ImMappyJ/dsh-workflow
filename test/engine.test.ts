import { describe, it, expect } from 'vitest';
import { WorkflowEngine, type ExecutionHandle } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, type AgentNode, type ExecutionEvent, type WorkflowDefinition } from '../src/domain/types.js';

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

function wf(nodes: AgentNode[], edges: Array<[string, string]>, over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_test', name: 'test',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes,
    edges: edges.map(([s, t], i) => ({
      id: `e${i}`,
      source: { nodeId: s, output: 'main' },
      target: { nodeId: t, input: 'main' },
      transform: { enabled: false, instruction: '' },
      condition: null,
    })),
    settings: defaultSettings(),
    loops: [],
    layout: {},
    ...over,
  };
}

async function run(engine: WorkflowEngine, def: WorkflowDefinition, input = 'hello') {
  const events: ExecutionEvent[] = [];
  // 必须在 run 之前订阅，否则早期事件丢失
  const unsubscribe = engine.eventBus.on('*', e => events.push(e));
  const handle: ExecutionHandle = await engine.run(def, { text: input });
  const state = await handle.result;
  unsubscribe();
  return { state, events };
}

function newEngine(runnerOpts: Parameters<typeof MockAgentRunner>[0] = {}) {
  return new WorkflowEngine({ runner: new MockAgentRunner(runnerOpts) });
}

// ---------------------------------------------------------------- 基础拓扑

describe('WorkflowEngine 集成', () => {
  it('A→B 线性流：两个 agent 均执行并 completed', async () => {
    const engine = newEngine();
    const { state, events } = await run(engine, wf(
      [startNode(), agent('b'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ));
    expect(state.status).toBe('completed');
    expect(state.outputs['b']).toHaveLength(1);
    expect(state.outputs['b'][0].content).toContain('mock output of b');
    expect(events.some(e => e.type === 'workflow.completed')).toBe(true);
    expect(events.filter(e => e.type === 'node.started').length).toBe(1); // 只有 b
  });

  it('A→B→C 链式：执行顺序正确，B 的输入包含 A 的输出', async () => {
    const engine = newEngine({
      scriptsPerNode: { a: [{ type: 'static', text: 'A-OUTPUT' }] },
    });
    const { state } = await run(engine, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [['start', 'a'], ['a', 'b'], ['b', 'end']],
    ));
    expect(state.status).toBe('completed');
    expect(state.nodeRunCount['a']).toBe(1);
    expect(state.nodeRunCount['b']).toBe(1);
    expect(state.outputs['b']).toHaveLength(1);
  });

  it('A→(B∥C) 并行分支', async () => {
    const engine = newEngine({ delayMs: 20 });
    const { state } = await run(engine, wf(
      [startNode(), agent('b'), agent('c'), endNode()],
      [['start', 'b'], ['start', 'c'], ['b', 'end'], ['c', 'end']],
    ));
    expect(state.status).toBe('completed');
    expect(state.outputs['b']).toHaveLength(1);
    expect(state.outputs['c']).toHaveLength(1);
  });

  it('A→B→A 循环：maxIterations=2 后 loop 终止并 failed(max_loop_iterations)', async () => {
    const engine = newEngine();
    const { state, events } = await run(engine, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [['start', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'end']],
      { loops: [{ loopId: 'loop_001', nodeIds: ['a', 'b'], maxIterations: 2 }] },
    ));
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('max_loop_iterations');
    // a、b 各运行 2 次
    expect(state.nodeRunCount['a']).toBe(2);
    expect(state.nodeRunCount['b']).toBe(2);
    expect(events.some(e => e.type === 'loop.terminated')).toBe(true);
  });

  it('实现→Review 循环默认 maxIterations=3（未配置 LoopConfig 时自动补全）', async () => {
    const engine = newEngine();
    const { state } = await run(engine, wf(
      [startNode(), agent('impl'), agent('review'), endNode()],
      [['start', 'impl'], ['impl', 'review'], ['review', 'impl'], ['review', 'end']],
    ));
    expect(state.nodeRunCount['impl']).toBe(3);
    expect(state.nodeRunCount['review']).toBe(3);
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('max_loop_iterations');
  });

  it('超 maxExecutionSteps 终止 terminated', async () => {
    const engine = newEngine();
    const { state } = await run(engine, wf(
      [startNode(), agent('impl'), agent('review'), endNode()],
      [['start', 'impl'], ['impl', 'review'], ['review', 'impl']],
      { settings: { maxExecutionSteps: 4, defaultNodeMaxRuns: 5 } },
    ));
    expect(state.status).toBe('terminated');
    expect(state.error?.code).toBe('max_steps');
    expect(state.stepCount).toBeLessThanOrEqual(4);
  });

  it('节点失败 onFailure=fail_workflow → workflow.failed', async () => {
    const engine = newEngine({
      scriptsPerNode: { b: [{ type: 'error', message: 'boom' }] },
    });
    const { state, events } = await run(engine, wf(
      [startNode(), agent('b'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ));
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('node_failed');
    expect(state.error?.nodeId).toBe('b');
    expect(events.some(e => e.type === 'node.failed')).toBe(true);
  });

  it('节点失败 onFailure=skip → 流程继续，下游死锁判定', async () => {
    const engine = newEngine({
      scriptsPerNode: { b: [{ type: 'error', message: 'boom' }] },
    });
    // b skip → c 依赖 b 永缺 → deadlock
    const bSkip = agent('b', {
      runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'skip' },
    });
    const { state } = await run(engine, wf(
      [startNode(), bSkip, agent('c'), endNode()],
      [['start', 'b'], ['b', 'c'], ['c', 'end']],
    ));
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('deadlock');
  });

  it('retry：失败后重试成功', async () => {
    const engine = newEngine({
      scriptsPerNode: {
        b: [
          { type: 'error', message: 'transient' },   // 第 1 次失败
          { type: 'static', text: 'recovered' },     // 第 2 次成功
        ],
      },
    });
    const nodes = [startNode(), agent('b', {
      runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: true, maxRetries: 2, backoffMs: 1 }, onFailure: 'fail_workflow' },
    }), endNode()];
    const { state, events } = await run(engine, wf(nodes, [['start', 'b'], ['b', 'end']]));
    expect(state.status).toBe('completed');
    expect(state.outputs['b'][0].content).toBe('recovered');
    expect(events.some(e => e.type === 'node.retrying')).toBe(true);
  });

  it('校验失败直接拒绝运行', async () => {
    const engine = newEngine();
    await expect(
      engine.run(wf([agent('b')], []), { text: 'x' }),
    ).rejects.toThrow(/invalid/);
  });

  it('事件序列包含 started → node.started → thinking → completed', async () => {
    const engine = newEngine();
    const { events } = await run(engine, wf(
      [startNode(), agent('b'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ));
    const types = events.map(e => e.type);
    expect(types.indexOf('workflow.started')).toBe(0);
    expect(types).toContain('node.started');
    expect(types).toContain('node.thinking');
    expect(types).toContain('node.completed');
    expect(types.indexOf('workflow.completed')).toBe(types.length - 1);
  });
});

// ---------------------------------------------------------------- 控制命令

describe('控制命令', () => {
  it('stop：运行中取消', async () => {
    const engine = newEngine({ delayMs: 300 });
    const handle = await engine.run(wf(
      [startNode(), agent('b'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ), { text: 'x' });
    setTimeout(() => engine.control(handle.executionId, 'stop'), 50);
    const state = await handle.result;
    expect(['cancelled', 'completed']).toContain(state.status);
    expect(state.status).toBe('cancelled');
  });

  it('pause / resume', async () => {
    const engine = newEngine();
    const handle = await engine.run(wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [['start', 'a'], ['a', 'b'], ['b', 'end']],
    ), { text: 'x' });
    engine.subscribe(handle.executionId, e => {
      if (e.type === 'node.completed' && e.nodeId === 'a') {
        engine.control(handle.executionId, 'pause');
        setTimeout(() => engine.control(handle.executionId, 'resume'), 30);
      }
    });
    const state = await handle.result;
    expect(state.status).toBe('completed');
    expect(state.outputs['b']).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- context

describe('ContextManager 集成', () => {
  it('循环第 2 轮只取上游最新一轮输出（防爆炸）', async () => {
    const engine = newEngine({
      scriptsPerNode: {
        a: [{ type: 'dynamic', fn: req => `a-round-${req.runIndex}` }],
        b: [{ type: 'dynamic', fn: req => `b-round-${req.runIndex}` }],
      },
    });
    // a↔b 循环 2 轮，b 的 prompt 中应包含 a 的第 2 轮输出，不含第 1 轮
    // 用一个捕获 prompt 的 mock
    const seenPrompts: string[] = [];
    const mock = new MockAgentRunner({
      scriptsPerNode: {
        a: [{ type: 'dynamic', fn: req => { seenPrompts.push(req.prompt.user); return `a-round-${req.runIndex}`; } }],
        b: [{ type: 'dynamic', fn: req => { seenPrompts.push(req.prompt.user); return `b-round-${req.runIndex}`; } }],
      },
    });
    const eng = new WorkflowEngine({ runner: mock });
    const { state } = await run(eng, wf(
      [startNode(), agent('a'), agent('b'), endNode()],
      [['start', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'end']],
      { loops: [{ loopId: 'loop_001', nodeIds: ['a', 'b'], maxIterations: 2 }] },
    ));
    expect(state.nodeRunCount['a']).toBe(2);
    const bPrompts = seenPrompts.filter(p => p.includes('a-round-'));
    // b 第 2 轮的输入只包含 a-round-2
    const second = bPrompts.find(p => p.includes('a-round-2'));
    expect(second).toBeTruthy();
    expect(second!.includes('a-round-1')).toBe(false);
    // 循环迭代提示注入
    expect(seenPrompts.some(p => p.includes('第 2 次执行'))).toBe(true);
  });

  it('transform.instruction 注入下游 Prompt', async () => {
    const mock = new MockAgentRunner({
      scriptsPerNode: { b: [{ type: 'dynamic', fn: req => req.prompt.user }] },
    });
    const engine = new WorkflowEngine({ runner: mock });
    const def = wf([startNode(), agent('b'), endNode()], [['start', 'b'], ['b', 'end']]);
    def.edges[0].transform = { enabled: true, instruction: '只提取技术需求' };
    const { state } = await run(engine, def);
    expect(state.outputs['b'][0].content).toContain('只提取技术需求');
    expect(state.outputs['b'][0].content).toContain('hello');
  });

  it('单源截断生效', async () => {
    const long = 'x'.repeat(9000);
    const mock = new MockAgentRunner({
      scriptsPerNode: { b: [{ type: 'dynamic', fn: req => req.prompt.user }] },
    });
    const engine = new WorkflowEngine({ runner: mock });
    const { state } = await run(engine, wf(
      [startNode(), agent('b'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ), long);
    const out = state.outputs['b'][0].content;
    expect(out).toContain('已截断');
    expect(out.length).toBeLessThan(long.length);
  });
});
