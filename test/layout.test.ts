import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';

// layout.js 是浏览器脚本（挂 window，兼容 CJS 导出）；用 Function 沙箱模拟两种环境加载，避免动前端文件。
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'layout.js'), 'utf8');
const fakeModule: { exports: any } = { exports: {} };
new Function('module', 'window', src)(fakeModule, undefined);
const { computeLayout } = fakeModule.exports;

function node(id: string, type: 'start' | 'end' | 'agent' | 'human_task' = 'agent'): AgentNode {
  return {
    id, type, name: id, position: { x: 0, y: 0 },
    identity: { name: id }, roleDescription: id,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
  };
}

function wf(nodes: AgentNode[], edges: Array<[string, string]>): WorkflowDefinition {
  return {
    version: '1.0', id: 'wf_layout', name: 'layout',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nodes,
    edges: edges.map(([s, t], i) => ({
      id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
      transform: { enabled: false, instruction: '' }, condition: null,
    })),
    settings: defaultSettings(),
    loops: [],
    layout: {},
  };
}

describe('computeLayout（布局层与执行层解耦，任务 1）', () => {
  it('线性链：每层一个节点，x 递增、无回边', () => {
    const def = wf([node('start', 'start'), node('a'), node('b'), node('end', 'end')],
      [['start', 'a'], ['a', 'b'], ['b', 'end']]);
    const r = computeLayout(def);
    expect(r.positions.size).toBe(4);
    expect(r.backEdgeIds.size).toBe(0);
    const x = (id: string) => r.positions.get(id)!.x;
    expect(x('start')).toBeLessThan(x('a'));
    expect(x('a')).toBeLessThan(x('b'));
    expect(x('b')).toBeLessThan(x('end'));
  });

  it('含环：识别回边且不丢节点、不拆环（§55：不为 Cycle 强转 DAG）', () => {
    const def = wf([node('start', 'start'), node('writer'), node('critic'), node('end', 'end')],
      [['start', 'writer'], ['writer', 'critic'], ['critic', 'writer'], ['critic', 'end']]);
    const r = computeLayout(def);
    // critic→writer 是回边
    expect(r.backEdgeIds.size).toBe(1);
    const backEdge = def.edges.find(e => r.backEdgeIds.has(e.id))!;
    expect(backEdge.source.nodeId).toBe('critic');
    expect(backEdge.target.nodeId).toBe('writer');
    // 全部节点都有坐标
    expect(r.positions.size).toBe(4);
    // writer 在 critic 左侧（前向分层），但两者都保留在布局里
    expect(r.positions.get('writer')!.x).toBeLessThan(r.positions.get('critic')!.x);
  });

  it('确定性：同一输入两次布局完全一致（稳定布局）', () => {
    const def = wf(
      [node('start', 'start'), node('a'), node('b'), node('c'), node('d'), node('end', 'end')],
      [['start', 'a'], ['start', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'd'], ['d', 'end']]);
    const r1 = computeLayout(def);
    const r2 = computeLayout(def);
    for (const id of def.nodes.map(n => n.id)) {
      expect(r2.positions.get(id)).toEqual(r1.positions.get(id));
    }
    expect(r2.backEdgeIds).toEqual(r1.backEdgeIds);
  });

  it('不回写 Definition（§55：布局结果只用于 UI）', () => {
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')],
      [['start', 'a'], ['a', 'end']]);
    const before = JSON.stringify(def);
    computeLayout(def);
    expect(JSON.stringify(def)).toBe(before);
  });

  it('并行分支：同层节点 y 不同、x 相同', () => {
    const def = wf(
      [node('start', 'start'), node('a'), node('b'), node('end', 'end')],
      [['start', 'a'], ['start', 'b'], ['a', 'end'], ['b', 'end']]);
    const r = computeLayout(def);
    const pa = r.positions.get('a')!, pb = r.positions.get('b')!;
    expect(pa.x).toBe(pb.x);
    expect(pa.y).not.toBe(pb.y);
    // start 在最左、end 在最右
    expect(r.positions.get('start')!.x).toBeLessThan(pa.x);
    expect(r.positions.get('end')!.x).toBeGreaterThan(pa.x);
  });

  it('孤立节点也有坐标，不抛错', () => {
    const def = wf([node('start', 'start'), node('lone'), node('end', 'end')],
      [['start', 'end']]);
    const r = computeLayout(def);
    expect(r.positions.has('lone')).toBe(true);
    expect(Number.isFinite(r.width)).toBe(true);
    expect(Number.isFinite(r.height)).toBe(true);
  });
});
