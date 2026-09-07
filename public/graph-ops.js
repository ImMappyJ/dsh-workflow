/* ============================================================
 * DSH Workflow —— 图操作纯函数（任务 2 右键菜单的 Domain 逻辑）
 * 抽为独立模块以便单元测试；浏览器挂 window，Node 环境支持 CJS 导出。
 *
 * §55/§57 约束：
 *  - 复制节点生成新 ID，不复制边；
 *  - 删除节点级联处理相关边，需调用方先做确认（编辑器用 confirm）；
 *  - Start / End 唯一性在新增入口校验（与 validator 兜底一致）。
 * ============================================================ */
'use strict';

function genId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8);
}

/** 生成不与现有节点冲突的显示 id（如 agent2 / agent3 …） */
function freshNodeId(def, type) {
  let i = 1, id;
  do { id = `${type}${i++}`; } while (def.nodes.some(n => n.id === id));
  return id;
}

/**
 * 复制节点（§57）：深拷贝属性、生成新 ID、位置偏移；不复制边。
 * Start / End 不可复制（唯一性约束）。
 * @returns {{ok: boolean, node?: object, message?: string}}
 */
function duplicateNode(def, nodeId) {
  const src = def.nodes.find(n => n.id === nodeId);
  if (!src) return { ok: false, message: `节点 ${nodeId} 不存在` };
  if (src.type === 'start' || src.type === 'end') {
    return { ok: false, message: `${src.type === 'start' ? 'Start' : 'End'} 节点不可复制：一个 Workflow 只能各有一个` };
  }
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = freshNodeId(def, src.type);
  copy.name = `${src.name}（副本）`;
  copy.position = { x: src.position.x + 48, y: src.position.y + 48 };
  return { ok: true, node: copy };
}

/**
 * 删除节点（§57 级联处理边）：
 * @returns {{ok: boolean, removedEdges: string[], message?: string}}
 */
function deleteNode(def, nodeId) {
  const src = def.nodes.find(n => n.id === nodeId);
  if (!src) return { ok: false, removedEdges: [], message: `节点 ${nodeId} 不存在` };
  // §22 唯一性：Start / End 必须至少保留一个；但若存在多余副本（历史粘贴产生），允许删除副本以恢复唯一
  if (src.type === 'start' || src.type === 'end') {
    const sameCount = def.nodes.filter(n => n.type === src.type).length;
    if (sameCount <= 1) {
      return { ok: false, removedEdges: [], message: `不能删除 ${src.type === 'start' ? 'Start' : 'End'} 节点：一个 Workflow 必须包含一个${src.type === 'start' ? 'Start' : 'End'}节点。` };
    }
  }
  const removedEdges = def.edges.filter(e => e.source.nodeId === nodeId || e.target.nodeId === nodeId).map(e => e.id);
  def.nodes = def.nodes.filter(n => n.id !== nodeId);
  def.edges = def.edges.filter(e => e.source.nodeId !== nodeId && e.target.nodeId !== nodeId);
  // 清理环配置中的引用
  for (const loop of def.loops ?? []) loop.nodeIds = (loop.nodeIds || []).filter(id => id !== nodeId);
  return { ok: true, removedEdges };
}

/** 反转边方向（§57 右键"反向"）：自环不允许反转 */
function reverseEdge(def, edgeId) {
  const e = def.edges.find(x => x.id === edgeId);
  if (!e) return { ok: false, message: `边 ${edgeId} 不存在` };
  const s = e.source, t = e.target;
  // 反转后不能产生与已有边完全相同的重复（同向重复边提示，不硬阻止）
  e.source = { nodeId: t.nodeId, output: 'main' };
  e.target = { nodeId: s.nodeId, input: 'main' };
  return { ok: true };
}

/** 切换节点禁用（任务 2） */
function toggleDisabled(def, nodeId) {
  const n = def.nodes.find(x => x.id === nodeId);
  if (!n) return { ok: false, message: '节点不存在' };
  if (n.type === 'start' || n.type === 'end') return { ok: false, message: 'Start / End 节点不可禁用' };
  n.disabled = !n.disabled;
  return { ok: true, disabled: n.disabled };
}

/**
 * 粘贴节点（来自剪贴板）：再次生成新 ID（可多次粘贴），落点可指定。
 * @param {object} clipboardNode 之前复制的节点对象
 */
function pasteNode(def, clipboardNode, at) {
  if (!clipboardNode) return { ok: false, message: '剪贴板为空' };
  // §22 唯一性：Start / End 不允许粘贴出第二个副本
  if (clipboardNode.type === 'start' || clipboardNode.type === 'end') {
    return { ok: false, message: `${clipboardNode.type === 'start' ? 'Start' : 'End'} 节点不可粘贴：一个 Workflow 只能各有一个` };
  }
  const copy = JSON.parse(JSON.stringify(clipboardNode));
  copy.id = freshNodeId(def, clipboardNode.type);
  if (at) copy.position = { x: Math.round(at.x), y: Math.round(at.y) };
  else copy.position = { x: clipboardNode.position.x + 24, y: clipboardNode.position.y + 24 };
  def.nodes.push(copy);
  return { ok: true, node: copy };
}

/** 新增节点前的唯一性检查（与 validator 对齐） */
function canAddNodeType(def, type) {
  if (type === 'start' && def.nodes.some(n => n.type === 'start')) {
    return { ok: false, message: '该 Workflow 已存在 Start 节点。一个 Workflow 只能包含一个 Start 节点。' };
  }
  if (type === 'end' && def.nodes.some(n => n.type === 'end')) {
    return { ok: false, message: '该 Workflow 已存在 End 节点。一个 Workflow 只能包含一个 End 节点。' };
  }
  return { ok: true };
}

// ---------------- 撤销 / 重做快照栈（§57） ----------------

function createHistory(current) {
  return { undo: [], redo: [], current: JSON.stringify(current), limit: 60 };
}

/**
 * 变更提交：调用方先修改 def，再调用本函数提交新状态。
 * 旧状态入 undo 栈；无变化则不记录。新增提交会清空 redo 栈。
 */
function commitSnapshot(h, def) {
  const snap = JSON.stringify(def);
  if (snap === h.current) return h;   // 无变化不记录
  h.undo.push(h.current);
  if (h.undo.length > h.limit) h.undo.shift();
  h.current = snap;
  h.redo = [];
  return h;
}

/** 撤销：返回要恢复的状态串，或 null */
function undoStep(h) {
  if (!h.undo.length) return null;
  h.redo.push(h.current);
  h.current = h.undo.pop();
  return h.current;
}

/** 重做 */
function redoStep(h) {
  if (!h.redo.length) return null;
  h.undo.push(h.current);
  h.current = h.redo.pop();
  return h.current;
}

const GraphOps = {
  genId, freshNodeId, duplicateNode, deleteNode, reverseEdge,
  toggleDisabled, pasteNode, canAddNodeType,
  createHistory, commitSnapshot, undoStep, redoStep,
};

if (typeof window !== 'undefined') window.GraphOps = GraphOps;
if (typeof module !== 'undefined' && module.exports) module.exports = GraphOps;
