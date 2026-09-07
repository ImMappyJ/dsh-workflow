import { describe, it, expect } from 'vitest';
import { tarjanScc, detectLoops, buildAdjacency } from '../src/graph/tarjan.js';
import { validateWorkflow, loopsFromSccs } from '../src/graph/validator.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';

// ---------------------------------------------------------------- helpers

let seq = 0;
function agent(id: string, over: Partial<AgentNode> = {}): AgentNode {
  seq++;
  return {
    id,
    type: 'agent',
    name: id,
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
      retry: { enabled: true, maxRetries: 2, backoffMs: 1000 },
      onFailure: 'fail_workflow',
    },
    metadata: {},
    ...over,
  };
}

function startNode(id = 'start') {
  return agent(id, { type: 'start' });
}
function endNode(id = 'end') {
  return agent(id, { type: 'end' });
}

function wf(nodes: AgentNode[], edges: Array<[string, string]>, over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: '1.0',
    id: 'wf_test',
    name: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
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

// ---------------------------------------------------------------- tarjan

describe('Tarjan SCC', () => {
  it('无环图：每个节点自成一个 SCC', () => {
    const adj = buildAdjacency([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]);
    const sccs = tarjanScc(['a', 'b', 'c'], adj);
    expect(sccs.length).toBe(3);
    expect(detectLoops(['a', 'b', 'c'], adj)).toHaveLength(0);
  });

  it('双节点环 A→B→A', () => {
    const adj = buildAdjacency([{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]);
    const loops = detectLoops(['a', 'b'], adj);
    expect(loops).toHaveLength(1);
    expect(new Set(loops[0])).toEqual(new Set(['a', 'b']));
  });

  it('三节点环 + 尾巴（实现→Review→实现 + End）', () => {
    const adj = buildAdjacency([
      { source: 'impl', target: 'review' },
      { source: 'review', target: 'impl' },
      { source: 'review', target: 'end' },
    ]);
    const loops = detectLoops(['impl', 'review', 'end'], adj);
    expect(loops).toHaveLength(1);
    expect(new Set(loops[0])).toEqual(new Set(['impl', 'review']));
  });

  it('两个独立环', () => {
    const adj = buildAdjacency([
      { source: 'a', target: 'b' }, { source: 'b', target: 'a' },
      { source: 'c', target: 'd' }, { source: 'd', target: 'c' },
    ]);
    expect(detectLoops(['a', 'b', 'c', 'd'], adj)).toHaveLength(2);
  });

  it('自环', () => {
    const adj = buildAdjacency([{ source: 'a', target: 'a' }]);
    expect(detectLoops(['a'], adj)).toEqual([['a']]);
  });

  it('嵌套环（大环套小环）算作一个 SCC', () => {
    // a→b→c→a 且 b→c
    const adj = buildAdjacency([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ]);
    const loops = detectLoops(['a', 'b', 'c'], adj);
    expect(loops).toHaveLength(1);
    expect(loops[0].length).toBe(3);
  });

  it('深链 10000 节点不栈溢出（迭代实现）', () => {
    const edges = Array.from({ length: 9999 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
    const adj = buildAdjacency(edges);
    const nodeIds = Array.from({ length: 10000 }, (_, i) => `n${i}`);
    expect(() => tarjanScc(nodeIds, adj)).not.toThrow();
    expect(detectLoops(nodeIds, adj)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- validator

describe('GraphValidator', () => {
  it('合法线性图通过', () => {
    const r = validateWorkflow(wf(
      [startNode(), agent('b'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ));
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.loops).toHaveLength(0);
  });

  it('缺少 start 报错', () => {
    const r = validateWorkflow(wf([agent('b'), endNode()], [['b', 'end']]));
    expect(r.errors.some(e => e.code === 'missing_start')).toBe(true);
  });

  it('缺少 end 报错', () => {
    const r = validateWorkflow(wf([startNode(), agent('b')], [['start', 'b']]));
    expect(r.errors.some(e => e.code === 'missing_end')).toBe(true);
  });

  it('多个 start 报错', () => {
    const r = validateWorkflow(wf(
      [startNode(), startNode('start2'), agent('b'), endNode()],
      [['start', 'b'], ['start2', 'b'], ['b', 'end']],
    ));
    expect(r.errors.some(e => e.code === 'multiple_start')).toBe(true);
    expect(r.valid).toBe(false);
  });

  it('多个 end 报错（§22 第二阶段）', () => {
    const r = validateWorkflow(wf(
      [startNode(), agent('b'), endNode(), endNode('end2')],
      [['start', 'b'], ['b', 'end'], ['b', 'end2']],
    ));
    expect(r.errors.some(e => e.code === 'multiple_end')).toBe(true);
    expect(r.valid).toBe(false);
  });

  it('零 start / 零 end 均为 invalid（§22 保存与执行前校验）', () => {
    const noStart = validateWorkflow(wf([agent('a'), endNode()], [['a', 'end']]));
    const noEnd = validateWorkflow(wf([startNode(), agent('a')], [['start', 'a']]));
    expect(noStart.valid).toBe(false);
    expect(noStart.errors.some(e => e.code === 'missing_start')).toBe(true);
    expect(noEnd.valid).toBe(false);
    expect(noEnd.errors.some(e => e.code === 'missing_end')).toBe(true);
  });

  it('start 与 end 同时重复：两条错误同时报出', () => {
    const r = validateWorkflow(wf(
      [startNode(), startNode('start2'), agent('b'), endNode(), endNode('end2')],
      [['start', 'b'], ['start2', 'b'], ['b', 'end'], ['b', 'end2']],
    ));
    expect(r.errors.some(e => e.code === 'multiple_start')).toBe(true);
    expect(r.errors.some(e => e.code === 'multiple_end')).toBe(true);
  });

  it('悬空边报错', () => {
    const r = validateWorkflow(wf(
      [startNode(), endNode()],
      [['start', 'ghost'], ['start', 'end']],
    ));
    expect(r.errors.some(e => e.code === 'dangling_edge_target')).toBe(true);
  });

  it('孤立节点（不可达）产生警告但 valid', () => {
    const r = validateWorkflow(wf(
      [startNode(), agent('b'), agent('isolated'), endNode()],
      [['start', 'b'], ['b', 'end']],
    ));
    expect(r.valid).toBe(true);
    expect(r.warnings.some(w => w.code === 'unreachable_node')).toBe(true);
  });

  it('环图：valid=true + cycle 警告 + loop_unconfigured 警告', () => {
    const r = validateWorkflow(wf(
      [startNode(), agent('impl'), agent('review'), endNode()],
      [['start', 'impl'], ['impl', 'review'], ['review', 'impl'], ['review', 'end']],
    ));
    expect(r.valid).toBe(true);
    expect(r.warnings.some(w => w.code === 'cycle_detected')).toBe(true);
    expect(r.warnings.some(w => w.code === 'loop_unconfigured')).toBe(true);
    expect(r.loops).toHaveLength(1);
  });

  it('环图已有 LoopConfig 则无 loop_unconfigured 警告', () => {
    const r = validateWorkflow(wf(
      [startNode(), agent('impl'), agent('review'), endNode()],
      [['start', 'impl'], ['impl', 'review'], ['review', 'impl'], ['review', 'end']],
      { loops: [{ loopId: 'loop_001', nodeIds: ['impl', 'review'], maxIterations: 3 }] },
    ));
    expect(r.warnings.some(w => w.code === 'loop_unconfigured')).toBe(false);
  });

  it('maxExecutionSteps 超硬上限报错', () => {
    const r = validateWorkflow(wf(
      [startNode(), endNode()],
      [['start', 'end']],
      { settings: { maxExecutionSteps: 2000, defaultNodeMaxRuns: 5 } },
    ));
    expect(r.errors.some(e => e.code === 'invalid_max_steps')).toBe(true);
  });

  it('未知 output target 产生警告', () => {
    const r = validateWorkflow(wf(
      [startNode(), agent('b', { outputContract: {
        description: '', format: 'markdown', schema: null,
        requiredSections: [], targets: ['nobody'], condition: null,
      } }), endNode()],
      [['start', 'b'], ['b', 'end']],
    ));
    expect(r.warnings.some(w => w.code === 'unknown_target')).toBe(true);
  });

  it('空图报错', () => {
    const r = validateWorkflow(wf([], []));
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.code === 'empty_graph')).toBe(true);
  });
});

// ---------------------------------------------------------------- loopsFromSccs

describe('loopsFromSccs', () => {
  it('为缺失的 SCC 补全 LoopConfig，已存在的不重复', () => {
    const existing = [{ loopId: 'loop_001', nodeIds: ['impl', 'review'], maxIterations: 5 }];
    const result = loopsFromSccs([['impl', 'review'], ['x', 'y']], existing);
    expect(result.length).toBe(2);
    expect(result.find(l => l.loopId === 'loop_001')?.maxIterations).toBe(5);
    expect(result.find(l => l.nodeIds.includes('x'))?.maxIterations).toBe(3);
  });
});
