import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'graph-ops.js'), 'utf8');
const fakeModule: { exports: any } = { exports: {} };
new Function('module', 'window', src)(fakeModule, undefined);
const G = fakeModule.exports;

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
    version: '1.0', id: 'wf_ops', name: 'ops',
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

describe('GraphOps.duplicateNode（§57：复制生成新 ID，不复制边）', () => {
  it('复制 agent：新 ID、不复制边、属性独立', () => {
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')],
      [['start', 'a'], ['a', 'end']]);
    const edgeCount = def.edges.length;
    const r = G.duplicateNode(def, 'a');
    expect(r.ok).toBe(true);
    expect(r.node.id).not.toBe('a');
    def.nodes.push(r.node);
    // 不复制边
    expect(def.edges.length).toBe(edgeCount);
    expect(def.edges.some(e => e.source.nodeId === r.node.id || e.target.nodeId === r.node.id)).toBe(false);
    // 深拷贝独立：改副本不影响原件
    r.node.identity.name = 'changed';
    expect(def.nodes.find(n => n.id === 'a')!.identity.name).toBe('a');
  });

  it('复制 Start / End 被拒绝', () => {
    const def = wf([node('start', 'start'), node('end', 'end')], []);
    expect(G.duplicateNode(def, 'start').ok).toBe(false);
    expect(G.duplicateNode(def, 'end').ok).toBe(false);
  });

  it('多次复制不产生 ID 冲突', () => {
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')], []);
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = G.duplicateNode(def, 'a');
      expect(r.ok).toBe(true);
      expect(ids.has(r.node.id)).toBe(false);
      ids.add(r.node.id);
      def.nodes.push(r.node);
    }
  });
});

describe('GraphOps.deleteNode（§57：级联处理边）', () => {
  it('删除节点时级联删除相关边并清理环引用', () => {
    const def = wf([node('start', 'start'), node('a'), node('b'), node('end', 'end')],
      [['start', 'a'], ['a', 'b'], ['b', 'end']]);
    def.loops = [{ loopId: 'loop_001', nodeIds: ['a', 'b'], maxIterations: 3 }];
    const r = G.deleteNode(def, 'a');
    expect(r.ok).toBe(true);
    expect(r.removedEdges).toEqual(['e0', 'e1']);
    expect(def.nodes.map(n => n.id)).toEqual(['start', 'b', 'end']);
    expect(def.edges.map(e => e.id)).toEqual(['e2']);
    expect(def.loops[0].nodeIds).toEqual(['b']);
  });

  it('Start / End 不可删除', () => {
    const def = wf([node('start', 'start'), node('end', 'end')], []);
    expect(G.deleteNode(def, 'start').ok).toBe(false);
    expect(G.deleteNode(def, 'end').ok).toBe(false);
    expect(def.nodes.length).toBe(2);
  });
});

describe('GraphOps.reverseEdge / toggleDisabled / paste / canAdd', () => {
  it('反转边方向', () => {
    const def = wf([node('a'), node('b')], [['a', 'b']]);
    const r = G.reverseEdge(def, 'e0');
    expect(r.ok).toBe(true);
    expect(def.edges[0].source.nodeId).toBe('b');
    expect(def.edges[0].target.nodeId).toBe('a');
  });

  it('切换禁用（Start/End 不允许）', () => {
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')], []);
    expect(G.toggleDisabled(def, 'a')).toEqual({ ok: true, disabled: true });
    expect(def.nodes.find(n => n.id === 'a')!.disabled).toBe(true);
    expect(G.toggleDisabled(def, 'a')).toEqual({ ok: true, disabled: false });
    expect(G.toggleDisabled(def, 'start').ok).toBe(false);
    expect(G.toggleDisabled(def, 'end').ok).toBe(false);
  });

  it('粘贴：再次生成新 ID', () => {
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')], []);
    const r1 = G.duplicateNode(def, 'a');
    def.nodes.push(r1.node);
    const p1 = G.pasteNode(def, r1.node);
    expect(p1.ok).toBe(true);
    expect(p1.node.id).not.toBe(r1.node.id);
    const p2 = G.pasteNode(def, r1.node);
    expect(p2.node.id).not.toBe(p1.node.id);
  });

  it('canAddNodeType 拦截第二个 start/end（§22）', () => {
    const def = wf([node('start', 'start'), node('end', 'end')], []);
    expect(G.canAddNodeType(def, 'start').ok).toBe(false);
    expect(G.canAddNodeType(def, 'end').ok).toBe(false);
    expect(G.canAddNodeType(def, 'agent').ok).toBe(true);
    expect(G.canAddNodeType(def, 'start').message).toContain('只能包含一个 Start 节点');
  });

  it('pasteNode 拒绝粘贴 start/end 副本（§22 唯一性）', () => {
    const def = wf([node('start', 'start'), node('a'), node('end', 'end')], []);
    const r1 = G.pasteNode(def, node('start', 'start'));
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain('Start 节点不可粘贴');
    const r2 = G.pasteNode(def, node('end', 'end'));
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('End 节点不可粘贴');
    // 未产生副本
    expect(def.nodes.filter(n => n.type === 'start').length).toBe(1);
    expect(def.nodes.filter(n => n.type === 'end').length).toBe(1);
  });

  it('deleteNode：唯一 start/end 不可删，但多余副本可删（恢复唯一性）', () => {
    // 唯一 end 场景：不可删
    const def1 = wf([node('start', 'start'), node('a'), node('end', 'end')], []);
    const d1 = G.deleteNode(def1, 'end');
    expect(d1.ok).toBe(false);
    expect(d1.message).toContain('不能删除 End 节点');
    // 存在第二个 end（end2）时：可删除其一（保留至少一个）
    const def2 = wf([node('start', 'start'), node('a'), node('end', 'end'), node('end2', 'end')], []);
    const d2 = G.deleteNode(def2, 'end2');
    expect(d2.ok).toBe(true);
    expect(def2.nodes.map(n => n.id)).toEqual(['start', 'a', 'end']);
    // 此时 end 又变回唯一，再次删除被拦截
    const d3 = G.deleteNode(def2, 'end');
    expect(d3.ok).toBe(false);
    // start 同理：唯一不可删，多余可删
    const def3 = wf([node('start', 'start'), node('start2', 'start'), node('end', 'end')], []);
    const d4 = G.deleteNode(def3, 'start2');
    expect(d4.ok).toBe(true);
    expect(def3.nodes.map(n => n.id)).toEqual(['start', 'end']);
    const d5 = G.deleteNode(def3, 'start');
    expect(d5.ok).toBe(false);
  });
});

describe('GraphOps 撤销/重做快照栈（§57）', () => {
  it('undo 恢复上一状态、redo 恢复撤销前状态', () => {
    const v1 = wf([node('start', 'start'), node('end', 'end')], []);
    const h = G.createHistory(v1);
    // 变更：加节点后提交
    v1.nodes.push(node('a'));
    G.commitSnapshot(h, v1);
    expect(h.undo.length).toBe(1);
    // undo → 回到 2 节点
    const back = G.undoStep(h);
    expect(JSON.parse(back).nodes.length).toBe(2);
    // redo → 回到 3 节点
    const fwd = G.redoStep(h);
    expect(JSON.parse(fwd).nodes.length).toBe(3);
    // 空栈返回 null
    G.undoStep(h);
    expect(G.undoStep(h)).toBeNull();
  });

  it('无变化时不记录快照；新提交清空 redo', () => {
    const v = wf([node('start', 'start'), node('end', 'end')], []);
    const h = G.createHistory(v);
    G.commitSnapshot(h, v);   // 与 current 相同
    expect(h.undo.length).toBe(0);
    v.nodes.push(node('a')); G.commitSnapshot(h, v);
    G.undoStep(h);
    expect(h.redo.length).toBe(1);
    v.nodes.push(node('b')); G.commitSnapshot(h, v);   // 新提交
    expect(h.redo.length).toBe(0);
  });
});
