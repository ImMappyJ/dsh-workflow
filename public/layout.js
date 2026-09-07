/* ============================================================
 * DSH Workflow —— 自动布局（布局层，与执行层解耦）
 *
 * 设计约束（第二阶段任务 1 / §55）：
 *  - 支持 Cycle：DFS 识别回边（back edge），分层只在 DAG（前向边）上进行，
 *    绝不把环强行拆成 DAG 或改写 Definition；
 *  - 布局结果只是 UI 坐标（返回 positions Map），不写回 WorkflowDefinition；
 *  - 确定性/稳定：节点按 Definition 顺序遍历，排序使用稳定比较器，
 *    同一输入永远得到同一布局。
 *
 * 算法（经典分层布局的轻量实现，零依赖）：
 *  1) DFS 回边分类（起点优先、Definition 顺序，保证确定性）；
 *  2) 去掉回边后做最长路径分层（layer = 前驱层最大值 + 1）；
 *  3) 层内排序：重心法（barycenter）双向各扫一遍减少交叉，
 *     平手时按 Definition 序号稳定排序；
 *  4) 坐标分配：层 → x，层内序号 → y（按最大层宽度垂直居中）。
 * ============================================================ */
'use strict';

/**
 * @param {{nodes: any[], edges: any[]}} def WorkflowDefinition
 * @param {{nodeW?: number, nodeH?: number, gapX?: number, gapY?: number, pad?: number}} opts
 * @returns {{
 *   positions: Map<string, {x:number,y:number}>,
 *   backEdgeIds: Set<string>,
 *   layerOf: Map<string, number>,
 *   width: number, height: number
 * }}
 */
function computeLayout(def, opts = {}) {
  const NODE_W = opts.nodeW ?? 200;
  const NODE_H = opts.nodeH ?? 88;
  const GAP_X = opts.gapX ?? 100;
  const GAP_Y = opts.gapY ?? 46;
  const PAD = opts.pad ?? 40;

  const nodes = Array.isArray(def.nodes) ? def.nodes : [];
  const edges = Array.isArray(def.edges) ? def.edges : [];
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const ids = nodes.map(n => n.id);

  // ---------- 1) DFS 回边分类 ----------
  // 邻接表只保留两端都存在的边；遍历顺序：start 优先，其余按 Definition 序号
  const out = new Map(ids.map(id => [id, []]));
  for (const e of edges) {
    if (idx.has(e.source.nodeId) && idx.has(e.target.nodeId)) {
      out.get(e.source.nodeId).push(e);
    }
  }
  const order = [...ids].sort((a, b) => {
    const pa = nodes[idx.get(a)].type === 'start' ? 0 : 1;
    const pb = nodes[idx.get(b)].type === 'start' ? 0 : 1;
    return pa - pb || idx.get(a) - idx.get(b);
  });
  const color = new Map();            // 0 未访问 / 1 在栈中 / 2 已完成
  const backEdgeIds = new Set();
  const dfs = (u) => {
    color.set(u, 1);
    for (const e of out.get(u)) {
      const v = e.target.nodeId;
      const c = color.get(v) ?? 0;
      if (c === 1) backEdgeIds.add(e.id);      // 指向栈中祖先 → 回边（环）
      else if (c === 0) dfs(v);
    }
    color.set(u, 2);
  };
  for (const id of order) if ((color.get(id) ?? 0) === 0) dfs(id);

  // ---------- 2) 最长路径分层（只用前向边；此时已是 DAG） ----------
  const preds = new Map(ids.map(id => [id, []]));
  const succs = new Map(ids.map(id => [id, []]));
  for (const e of edges) {
    if (backEdgeIds.has(e.id)) continue;
    if (!idx.has(e.source.nodeId) || !idx.has(e.target.nodeId)) continue;
    preds.get(e.target.nodeId).push(e.source.nodeId);
    succs.get(e.source.nodeId).push(e.target.nodeId);
  }
  const layerOf = new Map();
  const computeLayer = (u, guard) => {
    if (layerOf.has(u)) return layerOf.get(u);
    if (guard.has(u)) return 0;                  // 防御（理论上回边已去除）
    guard.add(u);
    let L = 0;
    for (const p of preds.get(u)) L = Math.max(L, computeLayer(p, guard) + 1);
    layerOf.set(u, L);
    return L;
  };
  for (const id of order) computeLayer(id, new Set());

  // ---------- 3) 层内排序（重心法，双向各一遍） ----------
  const maxLayer = Math.max(0, ...layerOf.values());
  const layers = [];
  for (let L = 0; L <= maxLayer; L++) layers.push([]);
  for (const id of order) layers[layerOf.get(id)].push(id);   // 初始按确定顺序

  const posInLayer = new Map();
  const reindex = () => layers.forEach(list => list.forEach((id, i) => posInLayer.set(id, i)));
  reindex();

  const barycenterSort = (list, neighbors) => {
    const bc = new Map();
    for (const id of list) {
      const ns = neighbors.get(id).filter(n => posInLayer.has(n));
      bc.set(id, ns.length ? ns.reduce((s, n) => s + posInLayer.get(n), 0) / ns.length : posInLayer.get(id));
    }
    list.sort((a, b) => (bc.get(a) - bc.get(b)) || (idx.get(a) - idx.get(b)));
  };
  for (let pass = 0; pass < 2; pass++) {
    // 下行扫描：用前驱重心
    for (let L = 1; L <= maxLayer; L++) { barycenterSort(layers[L], preds); reindex(); }
    // 上行扫描：用后继重心
    for (let L = maxLayer - 1; L >= 0; L--) { barycenterSort(layers[L], succs); reindex(); }
  }

  // ---------- 4) 坐标分配 ----------
  const maxCount = Math.max(1, ...layers.map(l => l.length));
  const positions = new Map();
  layers.forEach((list, L) => {
    const offsetY = ((maxCount - list.length) / 2) * (NODE_H + GAP_Y);
    list.forEach((id, i) => {
      positions.set(id, {
        x: PAD + L * (NODE_W + GAP_X),
        y: PAD + offsetY + i * (NODE_H + GAP_Y),
      });
    });
  });

  return {
    positions,
    backEdgeIds,
    layerOf,
    width: PAD * 2 + (maxLayer + 1) * (NODE_W + GAP_X) - GAP_X,
    height: PAD * 2 + maxCount * (NODE_H + GAP_Y) - GAP_Y,
  };
}

// 供执行画布与编辑器画布共用（浏览器）；Node 环境下也可加载用于测试
if (typeof window !== 'undefined') window.computeLayout = computeLayout;
if (typeof module !== 'undefined' && module.exports) module.exports = { computeLayout };
