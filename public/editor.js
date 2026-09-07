/* ============================================================
 * DSH Workflow Editor —— 画布 / 交互 / Inspector / 存储
 * 依赖：无外部框架，原生 SVG + DOM
 * ============================================================ */
'use strict';

const API = {
  async j(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${path}`);
    return data;
  },
};

// ---------- 全局状态 ----------
const S = {
  def: null,                 // WorkflowDefinition
  sel: null,                 // {kind:'node'|'edge', id}
  insTab: 'basic',
  view: { x: 0, y: 0, k: 1 },
  drag: null,                // 节点拖动
  pan: null,                 // 画布平移
  linking: null,             // {fromNodeId, fromPort}
  dirty: false,
};

// 自动防抖保存：S.dirty = true 后 2 秒无更改则触发保存
let _autoSaveTimer = null;
let _autoSaveReady = false; // 初始加载完成前不触发
Object.defineProperty(S, 'dirty', {
  configurable: true,
  enumerable: true,
  get() { return this._dirty; },
  set(v) {
    this._dirty = v;
    if (v && _autoSaveReady) {
      if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(() => {
        if (S.def && S.dirty) $('btn-save').click();
      }, 2000);
    }
  },
});
// 初始化时完成加载后启用自动保存
const _origInit = () => { _autoSaveReady = true; };

const NODE_W = 150, NODE_H = 54, PORT_R = 6;
const $ = (id) => document.getElementById(id);
const statusLine = (msg, cls = '') => { const el = $('status-line'); el.textContent = msg; el.className = cls; };

function newWorkflow() {
  const ts = new Date().toISOString();
  return {
    version: '1.0',
    id: 'wf_' + Date.now().toString(36),
    name: '未命名工作流',
    createdAt: ts, updatedAt: ts,
    nodes: [
      mkNode('start', 'start', 80, 200),
      mkNode('end', 'end', 620, 200),
    ],
    edges: [],
    settings: { maxExecutionSteps: 100, defaultNodeMaxRuns: 5 },
    loops: [], layout: {},
  };
}

function mkNode(type, id, x, y) {
  return {
    id, type, name: id,
    position: { x, y },
    identity: { name: id },
    roleDescription: type === 'agent' ? '描述该 Agent 的角色职责。' : '',
    inputContract: {
      description: '', processing: '', selection: '', ignore: '',
      constraints: [], sourceMode: 'all', selectedSourceNodeIds: [], includeReviewFeedback: true,
    },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 180000, retry: { enabled: false, maxRetries: 1, backoffMs: 2000 }, onFailure: 'fail_workflow' },
    metadata: {},
  };
}

function mkEdge(sourceId, targetId) {
  return {
    id: 'e_' + Math.random().toString(36).slice(2, 8),
    source: { nodeId: sourceId, output: 'main' },
    target: { nodeId: targetId, input: 'main' },
    transform: { enabled: false, instruction: '' },
    condition: null,
    review: undefined,
  };
}

function defaultReview() {
  return {
    enabled: true, mode: 'required',
    allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'],
    timeout: null, onTimeout: 'pause',
  };
}

// ---------- 画布渲染 ----------
const svg = $('canvas');
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

function screenToWorld(sx, sy) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (sx - rect.left - S.view.x) / S.view.k,
    y: (sy - rect.top - S.view.y) / S.view.k,
  };
}

// ---------- Phase 9：Edge Routing（§16-23：auto/manual、bezier/straight/orthogonal、控制点） ----------
// ---------- Phase 11（原则 19）：UI Layout 与 Graph Semantics 分离 ----------
// 布局属于独立 UI 层（def.layout）；node.position 仅作为语义默认值/回退，不再被 UI 直接改写
function posOf(n) {
  const l = S.def?.layout?.[n.id];
  return l || n.position;
}
function setPos(n, x, y) {
  if (!S.def.layout) S.def.layout = {};
  S.def.layout[n.id] = { x: Math.round(x), y: Math.round(y) };
}

function edgeRoutingOf(e) {
  return e.routing && e.routing.mode ? e.routing : { mode: 'auto', type: 'bezier', points: [] };
}
// 检测环路 edge：source 和 target 在同一个 LoopConfig 中
function isLoopEdge(e) {
  if (!S.def?.loops) return false;
  return S.def.loops.some(l => l.nodeIds.includes(e.source.nodeId) && l.nodeIds.includes(e.target.nodeId));
}
// 环路自动避障：生成外侧正交路径控制点
function autoLoopPath(e, x1, y1, x2, y2) {
  const s = S.def.nodes.find(n => n.id === e.source.nodeId);
  const t = S.def.nodes.find(n => n.id === e.target.nodeId);
  if (!s || !t) return null;
  const sp = posOf(s), tp = posOf(t);
  // 源节点在目标节点右侧 → 环从上方绕行，否则从下方绕行
  const goAbove = sp.x >= tp.x;
  const gap = 40;
  const loopY = goAbove ? Math.min(sp.y, tp.y) - gap : Math.max(sp.y + NODE_H, tp.y + NODE_H) + gap;
  const midX = (sp.x + tp.x + NODE_W) / 2;
  return [
    { x: sp.x + NODE_W, y: sp.y + NODE_H / 2 },
    { x: midX, y: sp.y + NODE_H / 2 },
    { x: midX, y: loopY },
    { x: tp.x, y: loopY },
    { x: tp.x, y: tp.y + NODE_H / 2 },
  ];
}
// 控制点以「相对源节点位置」存储：移动/自动布局节点后形状跟随，manual 不被覆盖（Test 3）
function edgeD(e, x1, y1, x2, y2) {
  const r = edgeRoutingOf(e);
  // 环路自动避障：auto 模式下环路 edge 走外侧正交路径
  if (r.mode === 'auto' && isLoopEdge(e)) {
    const pts = autoLoopPath(e, x1, y1, x2, y2);
    if (pts) {
      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
      return d;
    }
  }
  if (r.mode === 'manual' && r.points?.length) {
    const s = S.def.nodes.find(n => n.id === e.source.nodeId);
    const pts = [{ x: x1, y: y1 },
      ...r.points.map(p => { const sp = posOf(s); return { x: sp.x + p.x, y: sp.y + p.y }; }),
      { x: x2, y: y2 }];
    // Catmull-Rom → 三次贝塞尔（平滑折线）
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6}, ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6}, ${p2.x} ${p2.y}`;
    }
    return d;
  }
  const type = r.type || 'bezier';
  if (type === 'straight') return `M ${x1} ${y1} L ${x2} ${y2}`;
  if (type === 'orthogonal') {
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
  }
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function render() {
  updateZoomPct();
  // Phase F（§27）：空画布 Empty State 显隐
  const emptyEl = document.getElementById('editor-empty');
  if (emptyEl) emptyEl.style.display = (S.def && S.def.nodes && S.def.nodes.length === 0) ? 'flex' : 'none';
  if (!S.def) return;
  svg.innerHTML = '';
  const g = el('g', { transform: `translate(${S.view.x},${S.view.y}) scale(${S.view.k})` });
  svg.appendChild(g);

  // Phase 9：箭头 marker（context-stroke 跟随线色）
  const defs = el('defs', {});
  defs.innerHTML = '<marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>';
  svg.insertBefore(defs, svg.firstChild);

  // 计算射线与节点矩形边界的交点（箭头终止于 Node 外边界，不被遮挡）
  function boundaryPoint(nx, ny, cx, cy) {
    // (nx,ny) 为节点左上角，(cx,cy) 为节点中心，返回射线从外部射入时与矩形边界的交点
    const halfW = NODE_W / 2, halfH = NODE_H / 2;
    const xc = nx + halfW, yc = ny + halfH;
    const dx = cx - xc, dy = cy - yc;
    if (dx === 0 && dy === 0) return { x: xc, y: yc }; // 重合
    const absDx = Math.abs(dx), absDy = Math.abs(dy);
    let t;
    if (absDx * halfH > absDy * halfW) {
      // 与左右边界相交
      t = halfW / absDx;
      return { x: nx + (dx > 0 ? NODE_W : 0), y: yc + dy * t };
    } else {
      // 与上下边界相交
      t = halfH / absDy;
      return { x: xc + dx * t, y: ny + (dy > 0 ? NODE_H : 0) };
    }
  }

  // edges 先画（在节点下层）
  for (const e of S.def.edges) {
    const s = S.def.nodes.find(n => n.id === e.source.nodeId);
    const t = S.def.nodes.find(n => n.id === e.target.nodeId);
    if (!s || !t) continue;
    const sp0 = posOf(s), tp0 = posOf(t);
    const x1 = sp0.x + NODE_W, y1 = sp0.y + NODE_H / 2;
    const x2 = tp0.x, y2 = tp0.y + NODE_H / 2;
    // 计算 path 终点在目标节点边界上的交点（箭头不被节点遮挡）
    const bp = boundaryPoint(tp0.x, tp0.y, (x1 + x2) / 2, (y1 + y2) / 2);
    const d = edgeD(e, x1, y1, bp.x, bp.y);
    const cls = ['edge', e.review?.enabled ? 'review' : '', S.sel?.kind === 'edge' && S.sel.id === e.id ? 'selected' : ''].filter(Boolean).join(' ');
    const hit = el('path', { d, class: 'edge-hit', 'data-edge': e.id });
    const path = el('path', { d, class: cls, 'marker-end': 'url(#wf-arrow)' });
    g.appendChild(path); g.appendChild(hit);
    // Phase 9：选中连线时显示可拖拽控制点（manual routing）
    if (S.sel?.kind === 'edge' && S.sel.id === e.id) {
      const er = edgeRoutingOf(e);
      (er.points || []).forEach((pt, i) => {
        g.appendChild(el('circle', { class: 'edge-ctrl', cx: sp0.x + pt.x, cy: sp0.y + pt.y, r: 5, 'data-edge': e.id, 'data-idx': i }));
      });
    }
    if (e.review?.enabled) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const badge = el('text', { x: mx, y: my - 6, class: 'edge-badge', 'text-anchor': 'middle' });
      badge.textContent = '⚖ REVIEW';
      g.appendChild(badge);
    }
  }

  // nodes
  for (const n of S.def.nodes) {
    const ng = el('g', { class: `node ${n.type} ${S.sel?.kind === 'node' && S.sel.id === n.id ? 'selected' : ''}`, 'data-node': n.id, transform: `translate(${posOf(n).x},${posOf(n).y})` });
    ng.appendChild(el('rect', { class: 'node-body', width: NODE_W, height: NODE_H, rx: 8 }));
    const icon = n.type === 'start' ? '▶' : n.type === 'end' ? '■' : n.type === 'human_task' ? '👤' : '🤖';
    const title = el('text', { class: 'node-title', x: 12, y: 22 });
    title.textContent = `${icon} ${n.name}`;
    const sub = el('text', { class: 'node-type', x: 12, y: 40 });
    sub.textContent = n.type + (n.reviewCount ? '' : '');
    ng.appendChild(title); ng.appendChild(sub);
    if (n.type !== 'start') {
      ng.appendChild(el('circle', { class: 'port port-in', cx: 0, cy: NODE_H / 2, r: PORT_R, 'data-node': n.id, 'data-dir': 'in' }));
    }
    if (n.type !== 'end') {
      ng.appendChild(el('circle', { class: 'port port-out', cx: NODE_W, cy: NODE_H / 2, r: PORT_R, 'data-node': n.id, 'data-dir': 'out' }));
    }
    g.appendChild(ng);
  }

  // 连线中的幽灵线
  if (S.linking) {
    const s = S.def.nodes.find(n => n.id === S.linking.fromNodeId);
    if (s) {
      const x1 = posOf(s).x + NODE_W, y1 = posOf(s).y + NODE_H / 2;
      const gh = el('path', { id: 'ghost-edge', d: `M ${x1} ${y1} L ${S.linking.mx} ${S.linking.my}` });
      g.appendChild(gh);
    }
  }
  renderInspector();
}

// ---------- 画布交互 ----------
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.1 : 0.9;
  const k = Math.min(2.5, Math.max(0.3, S.view.k * factor));
  const rect = svg.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  S.view.x = mx - (mx - S.view.x) * (k / S.view.k);
  S.view.y = my - (my - S.view.y) * (k / S.view.k);
  S.view.k = k;
  render();
}, { passive: false });

svg.addEventListener('mousedown', (ev) => {
  // Phase 11b：控制点拖拽优先，画布平移不得抢占
  if (ev.target.closest('.edge-ctrl')) return;
  // Phase F（§26）：空格按住 → 任意位置强制平移
  if (S.spaceDown) {
    S.sel = null;
    S.pan = { sx: ev.clientX, sy: ev.clientY, ox: S.view.x, oy: S.view.y };
    svg.classList.add('panning');
    ev.preventDefault();
    render();
    return;
  }
  const portEl = ev.target.closest('.port');
  if (portEl && portEl.getAttribute('data-dir') === 'out') {
    S.linking = { fromNodeId: portEl.getAttribute('data-node'), mx: 0, my: 0 };
    ev.stopPropagation();
    return;
  }
  const nodeEl = ev.target.closest('g.node');
  const edgeHit = ev.target.closest('.edge-hit');
  // 连线模式（需求 1）：两步点选 / 从源出发后点目标
  if (nodeEl && (S.pendingLink || S.linking)) {
    const id = nodeEl.getAttribute('data-node');
    if (S.linking) {
      if (id !== S.linking.fromNodeId) {
        S.def.edges.push(mkEdge(S.linking.fromNodeId, id));
        S.dirty = true;
        statusLine(`已连线 ${S.linking.fromNodeId} → ${id}`, 'ok');
      }
      S.linking = null;
    } else if (S.pendingLink) {
      if (!S.pendingLink.source) { S.pendingLink.source = id; statusLine(`源：${id}，点击目标节点`, 'ok'); }
      else if (id !== S.pendingLink.source) {
        S.def.edges.push(mkEdge(S.pendingLink.source, id));
        S.dirty = true;
        statusLine(`已连线 ${S.pendingLink.source} → ${id}`, 'ok');
        S.pendingLink = null;
      }
    }
    render();
    return;
  }
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-node');
    S.sel = { kind: 'node', id };
    const n = S.def.nodes.find(n => n.id === id);
    const w = screenToWorld(ev.clientX, ev.clientY);
    const np0 = posOf(n); S.drag = { id, dx: w.x - np0.x, dy: w.y - np0.y };
    render();
    return;
  }
  if (edgeHit) {
    S.sel = { kind: 'edge', id: edgeHit.getAttribute('data-edge') };
    render();
    return;
  }
  S.sel = null;
  S.pan = { sx: ev.clientX, sy: ev.clientY, ox: S.view.x, oy: S.view.y };
  svg.classList.add('panning');
  render();
});

window.addEventListener('mousemove', (ev) => {
  if (S.drag) {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const n = S.def.nodes.find(n => n.id === S.drag.id);
    setPos(n, w.x - S.drag.dx, w.y - S.drag.dy);
    S.dirty = true;
    render();
  } else if (S.pan) {
    S.view.x = S.pan.ox + (ev.clientX - S.pan.sx);
    S.view.y = S.pan.oy + (ev.clientY - S.pan.sy);
    render();
  } else if (S.linking) {
    const w = screenToWorld(ev.clientX, ev.clientY);
    S.linking.mx = w.x; S.linking.my = w.y;
    render();
  }
});

window.addEventListener('mouseup', (ev) => {
  if (S.linking) {
    const portEl = ev.target.closest?.('.port');
    if (portEl && portEl.getAttribute('data-dir') === 'in') {
      const to = portEl.getAttribute('data-node');
      if (to !== S.linking.fromNodeId) {
        S.def.edges.push(mkEdge(S.linking.fromNodeId, to));
        S.dirty = true;
        statusLine(`已连线 ${S.linking.fromNodeId} → ${to}`, 'ok');
      }
    }
    S.linking = null;
    render();
  }
  S.drag = null;
  S.pan = null;
  svg.classList.remove('panning');
});

// 拖入新节点
document.querySelectorAll('.lib-item').forEach(item => {
  item.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('node-type', item.getAttribute('data-type'));
  });
});
$('canvas-wrap').addEventListener('dragover', (ev) => ev.preventDefault());
$('canvas-wrap').addEventListener('drop', (ev) => {
  ev.preventDefault();
  const type = ev.dataTransfer.getData('node-type');
  if (!type) return;
  const w = screenToWorld(ev.clientX, ev.clientY);
  // 连线组件（需求 1）：拖到节点上 → 从该节点出发连线；拖到空白 → 依次点源/目标
  if (type === 'edge') {
    const nodeEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('g.node');
    if (nodeEl) {
      S.linking = { fromNodeId: nodeEl.getAttribute('data-node'), mx: w.x, my: w.y };
      statusLine(`连线模式：从 ${S.linking.fromNodeId} 出发，点击目标节点完成连线（Esc 取消）`, 'ok');
    } else {
      S.pendingLink = { source: null };
      statusLine('连线模式：先点击源节点，再点击目标节点（Esc 取消）', 'ok');
    }
    render();
    return;
  }
  let id, i = 1;
  do { id = `${type}${i++}`; } while (S.def.nodes.some(n => n.id === id));
  const n = mkNode(type, id, Math.round(w.x - NODE_W / 2), Math.round(w.y - NODE_H / 2));
  // 保证 start / end 唯一（§22：编辑器拦截，文案规范；Domain 层另有 validator 兑底）
  if (type === 'start' && S.def.nodes.some(n => n.type === 'start')) {
    statusLine('该 Workflow 已存在 Start 节点。一个 Workflow 只能包含一个 Start 节点。', 'err'); return;
  }
  if (type === 'end' && S.def.nodes.some(n => n.type === 'end')) {
    statusLine('该 Workflow 已存在 End 节点。一个 Workflow 只能包含一个 End 节点。', 'err'); return;
  }
  S.def.nodes.push(n);
  S.sel = { kind: 'node', id };
  S.dirty = true;
  render();
});

// Delete 键删除
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && (S.linking || S.pendingLink)) {
    S.linking = null; S.pendingLink = null;
    statusLine('已取消连线模式', 'ok');
    render();
    return;
  }
  if (ev.key !== 'Delete' || !S.sel || !S.def) return;
  if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (S.sel.kind === 'node') {
    const id = S.sel.id;
    const target = S.def.nodes.find(n => n.id === id);
    if (!target) return;
    // §22 唯一性：Start / End 必须至少保留一个；但存在多余副本（历史粘贴产生）时允许删除副本以恢复唯一
    if (target.type === 'start' || target.type === 'end') {
      const sameCount = S.def.nodes.filter(n => n.type === target.type).length;
      if (sameCount <= 1) {
        statusLine(`不能删除 ${target.type === 'start' ? 'Start' : 'End'} 节点：一个 Workflow 必须包含一个${target.type === 'start' ? 'Start' : 'End'}节点。`, 'err');
        return;
      }
    }
    S.def.nodes = S.def.nodes.filter(n => n.id !== id);
    S.def.edges = S.def.edges.filter(e => e.source.nodeId !== id && e.target.nodeId !== id);
  } else {
    S.def.edges = S.def.edges.filter(e => e.id !== S.sel.id);
  }
  S.sel = null;
  S.dirty = true;
  render();
});

// ---------- Inspector ----------
const INS_TABS = {
  node: [['basic', '基本'], ['role', '角色'], ['input', '输入契约'], ['output', '输出契约'], ['model', '模型'], ['runtime', '运行时'], ['review', '审核配置']],
  edge: [['conn', '连线'], ['transform', 'Transform'], ['review', 'Review Gate'], ['routing', 'Routing']],
  workflow: [['wf', '工作流设置']],
};

function renderInspector() {
  const tabsEl = $('ins-tabs'), body = $('ins-body');
  if (!S.def) { tabsEl.innerHTML = ''; body.innerHTML = '<div class="ins-empty">无工作流</div>'; return; }
  if (!S.sel) {
    tabsEl.innerHTML = '';
    const loopRows = (S.def.loops || []).map((l, i) => `
      <div class="checkbox-row" style="align-items:flex-start">
        <span style="min-width:0">环 ${l.loopId}：<span style="color:var(--fg)">${(l.nodeIds || []).join(' ↔ ')}</span></span>
      </div>
      <label class="field">&nbsp;&nbsp;maxIterations</label>
      <input type="number" data-loopmax="${i}" value="${l.maxIterations}" style="margin-bottom:6px">`).join('');
    body.innerHTML = `
      <h3>工作流设置</h3>
      <label class="field">maxExecutionSteps（全局硬上限）</label>
      <input type="number" id="wf-steps" value="${(S.def.settings || {}).maxExecutionSteps || 100}">
      <label class="field">defaultNodeMaxRuns（节点默认运行上限）</label>
      <input type="number" id="wf-maxruns" value="${(S.def.settings || {}).defaultNodeMaxRuns || 5}">
      <label class="field">本地工作目录（代码/文档读写位置，可留空）</label>
      <div style="display:flex;gap:4px;align-items:center">
        <input type="text" id="wf-workspace" placeholder="如 D:/projects/myapp" value="${(S.def.settings || {}).workspaceDir || ''}" style="flex:1;min-width:0">
        <button type="button" id="wf-workspace-pick" title="调用系统文件夹选择器">选择文件夹…</button>
      </div>
      <p class="lib-hint" style="margin:2px 0 0">设置后注入每个 Agent 的 prompt（# WORKSPACE 段），Agent 将在该目录编写/运行代码、撰写文档。</p>
      <h3 style="margin-top:16px">环配置（Loop）</h3>
      ${loopRows || '<p class="lib-hint">当前未配置环。保存/校验时后端会自动检测环并补全默认配置；也可在模板中直接使用迭代环模板。</p>'}
      <h3 style="margin-top:16px">启动参数 Schema（inputSchema）</h3>
      <div id="schema-rows">${schemaRowsHtml()}</div>
      <button id="schema-add" style="margin-top:6px">+ 添加字段</button>
      <p class="lib-hint" style="margin-top:14px">节点数：${S.def.nodes.length}，连线数：${S.def.edges.length}</p>
      <p class="lib-hint">环出口审核被人工 accept 即冻结该环；reject 携带反馈重跑，受 maxIterations 与节点 maxRuns 统一约束。</p>`;
    body.querySelector('#wf-steps').onchange = (e) => { S.def.settings.maxExecutionSteps = +e.target.value; S.dirty = true; };
    body.querySelector('#wf-maxruns').onchange = (e) => { S.def.settings.defaultNodeMaxRuns = +e.target.value; S.dirty = true; };
    body.querySelector('#wf-workspace').onchange = (e) => {
      const v = e.target.value.trim();
      if (v) S.def.settings.workspaceDir = v; else delete S.def.settings.workspaceDir;
      S.dirty = true;
      statusLine(v ? `工作目录已设置：${v}` : '工作目录已清空', 'ok');
    };
    // 选择文件夹…：优先调宿主原生目录选择器（后端中转 host.pickDirectory），
    // 拿不到时降级 webkitdirectory（Electron 下 f.path 为绝对路径），
    // 两者都拿不到绝对路径时提示手动填写。
    const pickBtn = body.querySelector('#wf-workspace-pick');
    const applyDir = (dir) => {
      const wf = body.querySelector('#wf-workspace');
      wf.value = dir;
      wf.dispatchEvent(new Event('change'));
    };
    // 目录选择：后端调 Python tkinter 系统原生文件夹选择器（Windows SHBrowseForFolderW）。
    // 不使用 webkitdirectory（浏览器弹的是"上传文件"对话框而非文件夹选择器）。
    pickBtn.onclick = async () => {
      statusLine('正在打开文件夹选择器…', 'ok');
      try {
        const r = await fetch('/api/pick-directory', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok && j.path) {
          applyDir(String(j.path).replace(/\\/g, '/'));
          return;
        }
      } catch (_) { /* 忽略 */ }
      statusLine('文件夹选择器未响应：请在上方输入框手动填写绝对路径，如 D:/projects/myapp', 'err');
    };
    body.querySelectorAll('[data-loopmax]').forEach(inp => inp.onchange = (e) => {
      S.def.loops[+inp.dataset.loopmax].maxIterations = +e.target.value; S.dirty = true;
    });
    bindSchemaEditor(body);
    return;
  }
  const tabs = INS_TABS[S.sel.kind];
  tabsEl.innerHTML = tabs.map(([k, label]) => `<button data-tab="${k}" class="${S.insTab === k ? 'active' : ''}">${label}</button>`).join('');
  tabsEl.querySelectorAll('button').forEach(b => b.onclick = () => { S.insTab = b.dataset.tab; renderInspector(); });
  body.innerHTML = '';

  if (S.sel.kind === 'node') return renderNodeInspector(body);
  if (S.sel.kind === 'edge') return renderEdgeInspector(body);
}

// ---- Input Schema 编辑器（任务 5：启动参数表单定义）----
const FIELD_TYPES = ['text', 'number', 'boolean', 'select', 'file', 'files', 'directory', 'json', 'artifact'];
function schemaRowsHtml() {
  const fields = S.def.inputSchema?.fields ?? [];
  return fields.map((f, i) => `
    <div class="mini-list" style="border:1px solid var(--line);border-radius:6px;padding:6px;margin-bottom:6px">
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
        <input type="text" data-sch="${i}" data-k="name" value="${esc(f.name)}" placeholder="字段 key" style="width:34%">
        <input type="text" data-sch="${i}" data-k="label" value="${esc(f.label || '')}" placeholder="显示名" style="width:34%">
        <select data-sch="${i}" data-k="type" style="width:24%">
          ${FIELD_TYPES.map(t => `<option ${f.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <button data-schdel="${i}" class="danger" style="padding:2px 6px">✕</button>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" data-schreq="${i}" ${f.required ? 'checked' : ''}><label>必填</label>
      </div>
      ${f.type === 'select' ? `<input type="text" data-sch="${i}" data-k="options" value="${esc((f.options || []).join('|'))}" placeholder="选项（竖线分隔）">` : ''}
    </div>`).join('') || '<p class="lib-hint">未定义字段：启动对话框只有主输入框。</p>';
}
function bindSchemaEditor(body) {
  const ensure = () => { (S.def.inputSchema ??= {}).fields ??= []; return S.def.inputSchema.fields; };
  body.querySelectorAll('[data-sch]').forEach(el => el.onchange = () => {
    const fields = ensure();
    const f = fields[+el.dataset.sch];
    if (!f) return;
    const k = el.dataset.k;
    if (k === 'options') f.options = el.value.split('|').map(s => s.trim()).filter(Boolean);
    else f[k] = el.value;
    S.dirty = true;
    renderInspector();
  });
  body.querySelectorAll('[data-schreq]').forEach(el => el.onchange = () => {
    const fields = ensure();
    const f = fields[+el.dataset.schreq];
    if (f) { f.required = el.checked; S.dirty = true; }
  });
  body.querySelectorAll('[data-schdel]').forEach(btn => btn.onclick = () => {
    const fields = ensure();
    fields.splice(+btn.dataset.schdel, 1);
    S.dirty = true;
    renderInspector();
  });
  const addBtn = body.querySelector('#schema-add');
  if (addBtn) addBtn.onclick = () => {
    const fields = ensure();
    let i = 1, name;
    do { name = `field${i++}`; } while (fields.some(f => f.name === name));
    fields.push({ name, type: 'text', label: '', required: false });
    S.dirty = true;
    renderInspector();
  };
}

function fld(label, inner) { return `<label class="field">${label}</label>${inner}`; }
function bind(body, sel, fn) { const e = body.querySelector(sel); if (e) e.onchange = fn; }

function renderNodeInspector(body) {
  const n = S.def.nodes.find(n => n.id === S.sel.id);
  if (!n) return;
  const set = (fn) => (e) => { fn(e.target.value); S.dirty = true; };

  if (S.insTab === 'basic') {
    body.innerHTML =
      fld('节点 ID', `<input type="text" value="${n.id}" disabled>`) +
      fld('类型', `<input type="text" value="${n.type}" disabled>`) +
      fld('名称', `<input type="text" id="f-name" value="${n.name}">`) +
      fld('坐标', `<div class="row2"><input type="number" id="f-x" value="${posOf(n).x}"><input type="number" id="f-y" value="${posOf(n).y}"></div>`) +
      fld('路由模式（Routing Mode）', `<select id="f-rmode">
        <option value="static" ${n.routingMode === 'static' || !n.routingMode ? 'selected' : ''}>static — 固定出口（默认）</option>
        <option value="condition" ${n.routingMode === 'condition' ? 'selected' : ''}>condition — 条件表达式</option>
        <option value="agent" ${n.routingMode === 'agent' ? 'selected' : ''}>agent — Agent 自主决策</option>
        <option value="human" ${n.routingMode === 'human' ? 'selected' : ''}>human — 人工选择</option>
      </select>`);
    bind(body, '#f-name', set(v => { n.name = v; render(); }));
    bind(body, '#f-x', set(v => { setPos(n, +v, posOf(n).y); render(); }));
    bind(body, '#f-y', set(v => { setPos(n, posOf(n).x, +v); render(); }));
    bind(body, '#f-rmode', set(v => { n.routingMode = v || undefined; }));
  } else if (S.insTab === 'role') {
    body.innerHTML =
      fld('Identity Name', `<input type="text" id="f-idname" value="${n.identity.name}">`) +
      (n.type === 'human_task' ?
        fld('任务提示（执行时展示给人工）', `<textarea id="f-taskprompt" rows="8" placeholder="如：请核对以下三项并填写结论">${esc(n.metadata?.taskPrompt ?? '')}</textarea>`)
        : fld('角色描述（roleDescription）', `<textarea id="f-role" rows="8">${esc(n.roleDescription)}</textarea>`));
    bind(body, '#f-idname', set(v => { n.identity.name = v; }));
    if (n.type === 'human_task') {
      bind(body, '#f-taskprompt', set(v => { n.metadata = n.metadata || {}; n.metadata.taskPrompt = v; }));
    } else {
      bind(body, '#f-role', set(v => { n.roleDescription = v; }));
    }
  } else if (S.insTab === 'input') {
    const ic = n.inputContract;
    body.innerHTML =
      fld('输入说明', `<textarea id="f-ic-desc" rows="3">${esc(ic.description)}</textarea>`) +
      fld('来源模式', `<select id="f-srcmode"><option value="all" ${ic.sourceMode === 'all' ? 'selected' : ''}>all（全部上游）</option><option value="selected" ${ic.sourceMode === 'selected' ? 'selected' : ''}>selected（指定节点）</option></select>`) +
      fld('指定来源节点（逗号分隔）', `<input type="text" id="f-srcids" value="${(ic.selectedSourceNodeIds || []).join(',')}">`) +
      fld('处理规则（processing）', `<textarea id="f-proc" rows="3">${esc(ic.processing)}</textarea>`) +
      fld('筛选规则（selection）', `<textarea id="f-sel" rows="2">${esc(ic.selection)}</textarea>`) +
      fld('忽略规则（ignore）', `<textarea id="f-ign" rows="2">${esc(ic.ignore)}</textarea>`) +
      `<div class="checkbox-row"><input type="checkbox" id="f-incfb" ${ic.includeReviewFeedback ? 'checked' : ''}><label for="f-incfb">包含人工审核反馈（includeReviewFeedback）</label></div>`;
    bind(body, '#f-ic-desc', set(v => ic.description = v));
    bind(body, '#f-srcmode', set(v => ic.sourceMode = v));
    bind(body, '#f-srcids', set(v => ic.selectedSourceNodeIds = v.split(',').map(s => s.trim()).filter(Boolean)));
    bind(body, '#f-proc', set(v => ic.processing = v));
    bind(body, '#f-sel', set(v => ic.selection = v));
    bind(body, '#f-ign', set(v => ic.ignore = v));
    body.querySelector('#f-incfb').onchange = (e) => { ic.includeReviewFeedback = e.target.checked; S.dirty = true; };
  } else if (S.insTab === 'output') {
    const oc = n.outputContract;
    body.innerHTML =
      fld('输出说明', `<textarea id="f-oc-desc" rows="3">${esc(oc.description)}</textarea>`) +
      fld('格式', `<select id="f-fmt"><option value="markdown" ${oc.format === 'markdown' ? 'selected' : ''}>markdown</option><option value="json" ${oc.format === 'json' ? 'selected' : ''}>json</option><option value="text" ${oc.format === 'text' ? 'selected' : ''}>text</option></select>`) +
      fld('必填小节（逗号分隔）', `<input type="text" id="f-secs" value="${(oc.requiredSections || []).join(',')}">`) +
      '<p class="lib-hint">schema 与 targets/condition 为高级选项，暂通过 JSON 编辑。</p>';
    bind(body, '#f-oc-desc', set(v => oc.description = v));
    bind(body, '#f-fmt', set(v => oc.format = v));
    bind(body, '#f-secs', set(v => oc.requiredSections = v.split(',').map(s => s.trim()).filter(Boolean)));
  } else if (S.insTab === 'model') {
    body.innerHTML =
      fld('Provider', `<input type="text" id="f-prov" value="${n.modelConfig.provider}">`) +
      fld('Model', `<input type="text" id="f-model" value="${n.modelConfig.model}">`);
    bind(body, '#f-prov', set(v => n.modelConfig.provider = v));
    bind(body, '#f-model', set(v => n.modelConfig.model = v));
  } else if (S.insTab === 'runtime') {
    const rc = n.runtimeConfig;
    body.innerHTML =
      fld('最大运行次数（maxRuns）', `<input type="number" id="f-maxruns" value="${rc.maxRuns}">`) +
      fld('超时（秒）', `<input type="number" id="f-timeout" value="${Math.round(rc.timeoutMs / 1000)}">`) +
      fld('失败策略', `<select id="f-onfail"><option value="fail_workflow" ${rc.onFailure === 'fail_workflow' ? 'selected' : ''}>fail_workflow</option><option value="skip_downstream" ${rc.onFailure === 'skip_downstream' ? 'selected' : ''}>skip_downstream</option></select>`) +
      `<div class="checkbox-row"><input type="checkbox" id="f-retry" ${rc.retry.enabled ? 'checked' : ''}><label for="f-retry">启用重试</label></div>` +
      fld('重试次数', `<input type="number" id="f-retry-n" value="${rc.retry.maxRetries}">`);
    bind(body, '#f-maxruns', set(v => rc.maxRuns = +v));
    bind(body, '#f-timeout', set(v => rc.timeoutMs = +v * 1000));
    bind(body, '#f-onfail', set(v => rc.onFailure = v));
    body.querySelector('#f-retry').onchange = (e) => { rc.retry.enabled = e.target.checked; S.dirty = true; };
    bind(body, '#f-retry-n', set(v => rc.retry.maxRetries = +v));
  } else if (S.insTab === 'review') {
    const rv = n.review;
    body.innerHTML =
      `<div class="checkbox-row"><input type="checkbox" id="f-nrv" ${rv?.enabled ? 'checked' : ''}><label for="f-nrv">启用节点级审核（输出质量门，§22/§36）</label></div>` +
      (rv ? fld('模式', `<select id="f-nrv-mode"><option value="required" ${rv.mode === 'required' ? 'selected' : ''}>required（必须审核）</option><option value="optional" ${rv.mode === 'optional' ? 'selected' : ''}>optional</option></select>`) +
        fld('超时（秒）', `<input type="number" id="f-nrv-to" value="${rv.timeout ?? ''}">`) +
        fld('超时策略', `<select id="f-nrv-ontimeout"><option value="pause" ${rv.onTimeout === 'pause' ? 'selected' : ''}>pause（等待）</option><option value="accept" ${rv.onTimeout === 'accept' ? 'selected' : ''}>accept（自动通过）</option><option value="reject" ${rv.onTimeout === 'reject' ? 'selected' : ''}>reject（自动打回）</option><option value="fail" ${rv.onTimeout === 'fail' ? 'selected' : ''}>fail（审核失败）</option></select>`) : '');
    body.querySelector('#f-nrv').onchange = (ev) => {
      n.review = ev.target.checked ? (n.review || { enabled: true, mode: 'required', allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'], timeout: null, onTimeout: 'pause' }) : undefined;
      S.dirty = true;
      renderInspector();
    };
    if (rv) {
      bind(body, '#f-nrv-mode', set(v => n.review.mode = v));
      bind(body, '#f-nrv-to', set(v => n.review.timeout = v ? +v : null));
      bind(body, '#f-nrv-ontimeout', set(v => n.review.onTimeout = v));
    }
  }
}

function renderEdgeInspector(body) {
  const e = S.def.edges.find(e => e.id === S.sel.id);
  if (!e) return;
  const set = (fn) => (ev) => { fn(ev.target.value); S.dirty = true; };

  if (S.insTab === 'conn') {
    const opts = (cur) => S.def.nodes.map(n => `<option value="${n.id}" ${n.id === cur ? 'selected' : ''}>${n.name} (${n.type})</option>`).join('');
    body.innerHTML =
      fld('连线 ID', `<input type="text" value="${e.id}" disabled>`) +
      fld('源节点', `<select id="f-src">${opts(e.source.nodeId)}</select>`) +
      fld('目标节点', `<select id="f-tgt">${opts(e.target.nodeId)}</select>`);
    bind(body, '#f-src', set(v => { e.source.nodeId = v; render(); }));
    bind(body, '#f-tgt', set(v => { e.target.nodeId = v; render(); }));
  } else if (S.insTab === 'transform') {
    body.innerHTML =
      `<div class="checkbox-row"><input type="checkbox" id="f-tf" ${e.transform.enabled ? 'checked' : ''}><label for="f-tf">启用 Transform</label></div>` +
      fld('Transform 指令（注入目标节点 INPUT CONTRACT 段）', `<textarea id="f-tf-ins" rows="5">${esc(e.transform.instruction)}</textarea>`);
    body.querySelector('#f-tf').onchange = (ev) => { e.transform.enabled = ev.target.checked; S.dirty = true; };
    bind(body, '#f-tf-ins', set(v => e.transform.instruction = v));
  } else if (S.insTab === 'review') {
    const rv = e.review;
    const actions = ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'];
    body.innerHTML =
      `<div class="checkbox-row"><input type="checkbox" id="f-rv" ${rv?.enabled ? 'checked' : ''}><label for="f-rv">启用人工审核（Review Gate 绑定在边上）</label></div>` +
      (rv ? (
        fld('模式', `<select id="f-rv-mode"><option value="required" ${rv.mode === 'required' ? 'selected' : ''}>required（必须审核）</option><option value="optional" ${rv.mode === 'optional' ? 'selected' : ''}>optional</option></select>`) +
        fld('允许动作', `<div>${actions.map(a => `<div class="checkbox-row"><input type="checkbox" data-act="${a}" ${rv.allowedActions.includes(a) ? 'checked' : ''}><label>${a}</label></div>`).join('')}</div>`) +
        fld('超时（秒，空=不超时）', `<input type="number" id="f-rv-to" value="${rv.timeout ?? ''}">`) +
        fld('超时策略', `<select id="f-rv-onto"><option value="pause" ${rv.onTimeout === 'pause' ? 'selected' : ''}>pause（暂停等待）</option><option value="auto_accept" ${rv.onTimeout === 'auto_accept' ? 'selected' : ''}>auto_accept</option><option value="auto_reject" ${rv.onTimeout === 'auto_reject' ? 'selected' : ''}>auto_reject</option></select>`)
      ) : '<p class="lib-hint">勾选上方启用后展开配置。</p>');
    body.querySelector('#f-rv').onchange = (ev) => {
      e.review = ev.target.checked ? defaultReview() : undefined;
      S.dirty = true; renderInspector(); render();
    };
    if (rv) {
      bind(body, '#f-rv-mode', set(v => rv.mode = v));
      bind(body, '#f-rv-to', set(v => rv.timeout = v === '' ? null : Math.max(1, +v)));
      bind(body, '#f-rv-onto', set(v => rv.onTimeout = v));
      body.querySelectorAll('[data-act]').forEach(cb => cb.onchange = () => {
        rv.allowedActions = [...body.querySelectorAll('[data-act]:checked')].map(c => c.dataset.act);
        if (rv.allowedActions.length === 0) rv.allowedActions = ['accept'];
        S.dirty = true;
      });
    }
  } else if (S.insTab === 'routing') {
    body.innerHTML =
      fld('路由键（Routing Key）', `<input type="text" id="f-rk" value="${esc(e.routingKey || '')}" placeholder="如 improve / finish">` +
        '<p class="lib-hint" style="margin:0">Agent 输出中的 route 字段匹配此值决定走哪条边。留空=默认边。</p>') +
      fld('路由模式', `<select id="f-rm"><option value="" ${!e.routing?.mode ? 'selected' : ''}>自动（auto）</option><option value="manual" ${e.routing?.mode === 'manual' ? 'selected' : ''}>手动（manual，控制点可拖拽）</option></select>`) +
      fld('路径类型', `<select id="f-rt"><option value="bezier" ${(!e.routing || e.routing.type === 'bezier') ? 'selected' : ''}>贝塞尔（bezier）</option><option value="straight" ${e.routing?.type === 'straight' ? 'selected' : ''}>直线（straight）</option><option value="orthogonal" ${e.routing?.type === 'orthogonal' ? 'selected' : ''}>正交（orthogonal）</option></select>`);
    bind(body, '#f-rk', set(v => { e.routingKey = v || undefined; }));
    bind(body, '#f-rm', set(v => { e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] }; e.routing.mode = v || 'auto'; S.dirty = true; render(); }));
    bind(body, '#f-rt', set(v => { e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] }; e.routing.type = v; S.dirty = true; render(); }));
  }
}

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

// ---------- Toolbar 动作 ----------

$('btn-new').onclick = () => { S.def = newWorkflow(); S.sel = null; S.dirty = true; $('wf-id').value = S.def.id; $('wf-name').value = S.def.name; render(); };
$('btn-sample').onclick = async () => {
  S.def = newWorkflow();
  S.def.name = '示例：需求分析→架构设计';
  S.def.nodes.push(mkNode('agent', 'analyst', 320, 120));
  S.def.nodes.push(mkNode('agent', 'architect', 320, 300));
  S.def.nodes.find(n => n.id === 'analyst').roleDescription = '需求分析师：把用户需求拆解为功能点清单。';
  S.def.nodes.find(n => n.id === 'architect').roleDescription = '架构师：基于功能点清单给出技术选型建议。';
  S.def.edges.push(mkEdge('start', 'analyst'));
  const e2 = mkEdge('analyst', 'architect'); e2.review = defaultReview();
  S.def.edges.push(e2, mkEdge('architect', 'end'));
  S.sel = null; S.dirty = true;
  $('wf-id').value = S.def.id; $('wf-name').value = S.def.name;
  render();
  statusLine('已生成示例模板（含 analyst→architect 的 Review Gate）', 'ok');
};

/** 工作目录必须为绝对路径（宿主 sessions.create 校验 cwd，相对路径会导致运行失败） */
function workspaceDirInvalid(dir) {
  const v = String(dir || '').trim();
  if (!v) return null; // 未配置：仅提示，不阻止
  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(v);
  const isUnixAbs = v.startsWith('/');
  if (isWinAbs || isUnixAbs) return null;
  return `工作目录必须使用绝对路径（如 D:/projects/myapp），当前值 "${v}" 是相对路径，运行时会找不到目标目录`;
}

$('btn-save').onclick = async () => {
  if (!S.def) return;
  S.def.id = $('wf-id').value.trim() || S.def.id;
  S.def.name = $('wf-name').value.trim() || S.def.name;
  S.def.updatedAt = new Date().toISOString();
  // 工作目录绝对路径校验（§36）：相对路径会导致宿主会话创建失败
  const wsErr = workspaceDirInvalid(S.def.settings?.workspaceDir);
  if (wsErr) {
    statusLine(`保存失败：${wsErr}`, 'err');
    return;
  }
  try {
    const r = await API.j('POST', '/api/workflows', S.def);
    S.def = r.workflow;
    S.dirty = false;
    statusLine(`已保存${r.warnings?.length ? `（${r.warnings.length} 条警告）` : ''}`, 'ok');
    if (r.warnings?.length) console.warn('save warnings:', r.warnings);
  } catch (err) {
    statusLine(`保存失败：${err.message}`, 'err');
  }
};

$('btn-validate').onclick = async () => {
  if (!S.def) return;
  try {
    const body = { ...S.def, id: $('wf-id').value.trim() || S.def.id };
    const r = await API.j('POST', '/api/workflows/validate', body);
    if (r.valid) {
      statusLine(`✓ 校验通过${r.warnings?.length ? `，${r.warnings.length} 条警告` : ''}${r.loops?.length ? `，检测到 ${r.loops.length} 个环` : ''}`, 'ok');
      if (r.warnings?.length) console.warn('warnings:', r.warnings);
    } else {
      statusLine(`✗ 校验失败：${(r.errors || []).map(e => e.message).join('；')}`, 'err');
    }
  } catch (err) {
    statusLine(`校验失败：${err.message}`, 'err');
  }
};

$('btn-delete').onclick = async () => {
  const id = $('wf-id').value.trim();
  if (!id) return;
  const name = (S.def && S.def.name) || id;
  const ok = await uiConfirm({
    title: '删除工作流？',
    message: `确认删除工作流 <b>${esc(name)}</b>（<code>${esc(id)}</code>）？<br>删除后不可恢复，其执行历史记录也将一并移除。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await API.j('DELETE', `/api/workflows/${id}`);
    // 删除的是当前正在编辑的工作流 → 自动新建一个空白工作流
    if (S.def && S.def.id === id) {
      S.def = newWorkflow();
      $('wf-id').value = S.def.id;
      $('wf-name').value = S.def.name;
      resetAfterDelete();
      render();
      statusLine(`已删除 ${id}，已新建空白工作流`, 'ok');
    } else {
      resetAfterDelete();
      statusLine(`已删除 ${id}`, 'ok');
    }
  } catch (err) { statusLine(`删除失败：${err.message}`, 'err'); }
};

// ---------- 导入 / 导出 ----------
$('btn-export').onclick = () => {
  if (!S.def) { statusLine('无工作流可导出', 'err'); return; }
  const blob = new Blob([JSON.stringify(S.def, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (S.def.name || S.def.id || 'workflow') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  statusLine('已导出工作流定义', 'ok');
};

$('btn-import').onclick = () => {
  $('import-json').value = '';
  $('import-errors').textContent = '';
  $('import-file').value = '';
  $('import-dialog').classList.add('open');
};
$('import-close').onclick = () => $('import-dialog').classList.remove('open');
$('import-file').onchange = (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => { $('import-json').value = e.target.result; };
  reader.readAsText(file);
};
$('import-confirm').onclick = async () => {
  const raw = $('import-json').value.trim();
  if (!raw) { $('import-errors').textContent = '请粘贴 JSON 或选择文件'; return; }
  let def;
  try { def = JSON.parse(raw); } catch (e) { $('import-errors').textContent = 'JSON 解析失败：' + e.message; return; }
  if (!def.id || !def.nodes) { $('import-errors').textContent = '无效的工作流定义：缺少 id 或 nodes'; return; }
  try {
    const r = await API.j('POST', '/api/workflows/import', def);
    $('import-dialog').classList.remove('open');
    S.def = r.workflow;
    $('wf-id').value = S.def.id;
    $('wf-name').value = S.def.name;
    S.sel = null; S.dirty = false;
    render();
    statusLine(`已导入工作流 ${S.def.name}`, 'ok');
  } catch (err) { $('import-errors').textContent = '导入失败：' + err.message; }
};

// ---------- 我的工作流（工作流列表 + 状态）----------
// 替换 btn-exec-history 为工作流管理对话框
$('exec-history-close').onclick = () => $('exec-history-dialog').classList.remove('open');

// 工作台入口：btn-exec-history 已由 toolbar 的 btn-view-wb 取代，保留 onclick 以防其它引用
const _btnExecHistory = document.getElementById('btn-exec-history');
if (_btnExecHistory) _btnExecHistory.onclick = () => switchToWorkbench();

$('wf-id').oninput = () => { if (S.def) { S.def.id = $('wf-id').value; S.dirty = true; } };
$('wf-name').oninput = () => { if (S.def) { S.def.name = $('wf-name').value; S.dirty = true; } };

// ---------- 启动 ----------
(async function init() {
  S.def = newWorkflow();
  $('wf-id').value = S.def.id;
  $('wf-name').value = S.def.name;
  render();
  // 深链：?wf=<id> 自动打开指定工作流（宿主 /workflow 落地页跳转入口）
  (async () => {
    try {
      const wfId = new URLSearchParams(location.search).get('wf');
      if (wfId) {
        const graphLoading = document.getElementById('graph-loading');
        if (graphLoading) graphLoading.style.display = 'flex'; // LOADING_UX L5：异步加载期间显示覆盖层
        try {
          S.def = await API.j('GET', `/api/workflows/${encodeURIComponent(wfId)}`);
          $('wf-id').value = S.def.id;
          $('wf-name').value = S.def.name;
          S.sel = null; S.dirty = false;
          render(); // 一次性渲染完整 Graph（Node/Edge 同步整体出现）
          // 深链加载具体 workflow → 直接进入编辑视图
          switchToEditMode();
          statusLine(`已加载 ${S.def.name}`, 'ok');
        } catch (err) { statusLine(`深链加载失败：${err.message}`, 'err'); }
        finally { if (graphLoading) graphLoading.style.display = 'none'; }
      }
    } catch (err) { statusLine(`深链加载失败：${err.message}`, 'err'); }
  })();
  _autoSaveReady = true;
  // 页面加载时恢复模式：延迟到 DOMContentLoaded，确保 execution.js 已加载（openExecPanel 可用）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreMode);
  } else {
    restoreMode();
  }
})();

// ---------- 编辑/执行模式切换 ----------
// 导航高亮辅助：高亮当前视图对应按钮
function navHighlight(view) {
  const wbBtn = document.getElementById('btn-view-wb');
  const mtBtn = document.getElementById('btn-mode-toggle');
  // 三态互斥：workbench 高亮工作台按钮、不激活任何模式段；edit/execute 反之
  if (wbBtn) wbBtn.className = view === 'workbench' ? 'primary' : '';
  if (mtBtn) {
    const segs = mtBtn.querySelectorAll('.seg');
    segs.forEach(s => s.classList.toggle('active', s.dataset.mode === view));
  }
}

// ---------- 三视图切换：Workbench / Editor / Execution ----------
function switchToWorkbench() {
  document.getElementById('editor-view').classList.add('hidden');
  document.getElementById('exec-view').classList.remove('open');
  const wb = document.getElementById('workbench-view');
  if (wb) wb.classList.remove('hidden');
  localStorage.setItem('wf_mode', 'workbench');
  document.documentElement.setAttribute('data-mode', 'workbench');
  showEditorToolbar(true);
  navHighlight('workbench');
  // 关闭执行连接
  if (typeof stopPolling === 'function') stopPolling();
  if (typeof disconnectSse === 'function') disconnectSse();
  // 渲染工作台卡片
  if (typeof renderWorkbenchView === 'function') renderWorkbenchView();
}

function switchToEditMode() {
  document.getElementById('editor-view').classList.remove('hidden');
  document.getElementById('exec-view').classList.remove('open');
  const wb = document.getElementById('workbench-view');
  if (wb) wb.classList.add('hidden');
  localStorage.setItem('wf_mode', 'edit');
  document.documentElement.setAttribute('data-mode', 'edit');
  showEditorToolbar(true);
  navHighlight('edit');
  // 返回编辑模式：隐藏执行空状态层
  const empty = document.getElementById('exec-empty');
  if (empty) empty.style.display = 'none';
}

function switchToExecuteMode() {
  document.getElementById('editor-view').classList.add('hidden');
  document.getElementById('exec-view').classList.add('open');
  const wb = document.getElementById('workbench-view');
  if (wb) wb.classList.add('hidden');
  localStorage.setItem('wf_mode', 'execute');
  document.documentElement.setAttribute('data-mode', 'execute');
  showEditorToolbar(false);
  navHighlight('execute');
  // 进入执行模式：若未加载任何 execution，显示空状态层
  const empty = document.getElementById('exec-empty');
  if (empty) empty.style.display = EX && EX.id ? 'none' : 'flex';
}

function showEditorToolbar(editMode) {
  // LOADING_UX L6 v2：用 .tb-hide 类平滑显隐（保留占位 + 透明度过渡），替代 display 硬切换导致的重排闪烁
  const setHide = (id, hide) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('tb-hide', hide);
  };
  // 编辑模式：显示保存、名称、更多菜单；隐藏运行
  setHide('btn-save', !editMode);
  setHide('btn-more', !editMode);
  setHide('wf-id', !editMode);
  setHide('wf-name', !editMode);
  // 运行按钮只在执行模式显示
  setHide('btn-run', editMode);
}

function restoreMode() {
  const mode = localStorage.getItem('wf_mode');
  if (mode === 'execute') {
    // execute 分支：即使没有 lastExec 或 openExecPanel 暂不可用，也应进入执行模式视图（显示空态），而非回退工作台
    switchToExecuteMode();
    const lastExec = localStorage.getItem('wf_last_exec');
    if (lastExec && typeof openExecPanel === 'function') {
      openExecPanel(lastExec);
    }
    return;
  }
  if (mode === 'edit') { switchToEditMode(); return; }
  // 默认进入 Workbench
  switchToWorkbench();
}

// ---- 视图导航按钮 ----
document.getElementById('btn-view-wb')?.addEventListener('click', () => switchToWorkbench());

// f3：分段切换控件 —— 点击某段即切到该模式
document.getElementById('btn-mode-toggle')?.addEventListener('click', (ev) => {
  const seg = ev.target.closest('.seg');
  if (!seg) return;
  const target = seg.dataset.mode;
  if (target === 'execute') switchToExecuteMode();
  else switchToEditMode();
});

// ---- Workbench 独立视图渲染 ----
let WB2 = { q: '', sort: 'updated', filter: 'all', async: 'idle', _wfs: null, _execs: null };
function renderWorkbenchView(force) {
  const list = document.getElementById('wb-card-list');
  if (!list) return;
  // LOADING_UX L4：AsyncState —— idle/loading/refreshing/success/error，缓存过滤避免每次全量重取
  if (force) WB2.async = 'idle';
  const first = WB2.async === 'idle' || WB2.async === 'error';
  if (WB2.async === 'loading' || WB2.async === 'refreshing') return; // 防重入
  WB2.async = first ? 'loading' : 'refreshing';
  if (first) {
    list.innerHTML = '<div class="skeleton skeleton-card"></div>'
      + '<div class="skeleton skeleton-card"></div>'
      + '<div class="skeleton skeleton-card"></div>'; // 首屏骨架，高度接近 wf-card
  } else {
    showWbRefreshing(true); // 刷新保留已有内容 + 轻量指示，不清空
  }
  Promise.all([
    API.j('GET', '/api/workflows').catch(() => []),
    API.j('GET', '/api/executions').catch(() => []),
  ]).then(([wfs, execs]) => {
    WB2._wfs = Array.isArray(wfs) ? wfs : [];
    WB2._execs = Array.isArray(execs) ? execs : [];
    WB2.async = 'success';
    renderWbCards();
    showWbRefreshing(false);
  }).catch(err => {
    if (first) {
      WB2.async = 'error';
      list.innerHTML = `<div class="ins-empty">加载失败：${esc(err.message)} <button class="primary" id="wb-retry" style="font-size:12px">↻ 重试</button></div>`;
      const rt = document.getElementById('wb-retry');
      if (rt) rt.onclick = () => renderWorkbenchView(true);
    } else {
      WB2.async = 'success'; // 刷新失败保留已有数据
      showWbRefreshing(false);
    }
  });
}

// 从缓存渲染卡片（搜索/排序/过滤共用，不再重新请求）
function renderWbCards() {
  const list = document.getElementById('wb-card-list');
  if (!list) return;
  const wfs = WB2._wfs || [];
  const execs = WB2._execs || [];
  // 每个工作流最后一次执行的状态
  const lastStatus = new Map();
  for (const ex of execs) {
    const wid = ex.workflowId;
    if (!lastStatus.has(wid) || new Date(ex.updatedAt || ex.createdAt) > new Date(lastStatus.get(wid).time)) {
      lastStatus.set(wid, { status: ex.status, time: ex.updatedAt || ex.createdAt, runNumber: ex.runNumber });
    }
  }
  // 过滤 + 排序
  let arr = wfs.slice();
  if (WB2.q) {
    const q = WB2.q.toLowerCase();
    arr = arr.filter(w => (w.name || '').toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q));
  }
  if (WB2.filter !== 'all') {
    arr = arr.filter(w => {
      const s = lastStatus.get(w.id)?.status || '';
      if (WB2.filter === 'running') return ['running', 'queued'].includes(s);
      if (WB2.filter === 'review') return ['waiting_review', 'waiting_human'].includes(s);
      if (WB2.filter === 'completed') return ['success', 'completed'].includes(s);
      if (WB2.filter === 'failed') return ['failed', 'terminated', 'cancelled'].includes(s);
      return false;
    });
  }
  const cmp = {
    updated: (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
    created: (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    name: (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')),
    status: (a, b) => String(lastStatus.get(a.id)?.status ?? '').localeCompare(String(lastStatus.get(b.id)?.status ?? '')),
  }[WB2.sort];
  if (cmp) arr.sort(cmp);
  if (!arr.length) {
    list.innerHTML = '<div class="ins-empty">暂无工作流。点击「＋ 新建工作流」创建。</div>';
    return;
  }
  list.innerHTML = arr.map(w => {
    const ls = lastStatus.get(w.id);
    const st = ls ? ls.status : '';
    const stCls = st ? (ST_CLASS[st] || 'st-idle') : 'st-idle';
    const nodeCount = (w.nodes || []).filter(n => n.type === 'agent').length;
    const edgeCount = (w.edges || []).length;
    return `<div class="wf-card">
      <div class="wf-card-header">
        <div>
          <div class="wf-name">${esc(w.name || w.id)}</div>
          <div class="wf-id">${esc(w.id)}</div>
        </div>
        <div>
          ${st ? `<span class="status-pill ${stCls}">${esc(st)}</span>` : '<span class="status-pill st-idle" style="opacity:0.4">未运行</span>'}
        </div>
      </div>
      <div class="wf-card-body">
        <div class="wf-card-stats">
          <span>🧩 节点 ${nodeCount}</span>
          <span>🔗 连线 ${edgeCount}</span>
          ${ls ? `<span>⏱ ${wbRelTime(ls.time)}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--fg-dim)">${ls ? `Run #${ls.runNumber ?? 1} · ${wbRelTime(ls.time)}` : '从未运行'}</div>
      </div>
      <div class="wf-card-footer">
        <button class="primary" data-load-wf="${esc(w.id)}">打开</button>
        <button data-del-wf="${esc(w.id)}" data-del-name="${esc(w.name || w.id)}">删除</button>
      </div>
    </div>`;
  }).join('');
  // 操作绑定
  list.querySelectorAll('[data-load-wf]').forEach(b => b.onclick = async () => {
    try {
      S.def = await API.j('GET', `/api/workflows/${b.dataset.loadWf}`);
      $('wf-id').value = S.def.id;
      $('wf-name').value = S.def.name;
      S.sel = null; S.dirty = false;
      render();
      // 打开 = 直达该工作流最近一次执行的状态；从未运行过则进入编辑视图
      const execs = await API.j('GET', `/api/executions?workflowId=${encodeURIComponent(S.def.id)}`).catch(() => []);
      const own = (Array.isArray(execs) ? execs : [])
        .filter(x => x.workflowId === S.def.id) // 前端兜底：后端旧版忽略 query 时仍只取本工作流的执行
        .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
      if (own.length && typeof openExecPanel === 'function') {
        switchToExecuteMode();
        openExecPanel(own[0].executionId); // 最近一次执行（含 Rework 链的最新状态）
      } else {
        switchToEditMode();
      }
      statusLine(`已加载 ${S.def.name}`, 'ok');
    } catch (err) { statusLine(`加载失败：${err.message}`, 'err'); }
  });
  list.querySelectorAll('[data-del-wf]').forEach(b => b.onclick = async () => {
    const id = b.dataset.delWf;
    const name = b.dataset.delName;
    const ok = await uiConfirm({
      title: '删除工作流？',
      message: `确认删除工作流 <b>${esc(name)}</b>（<code>${esc(id)}</code>）？<br>删除后不可恢复，其执行历史也将一并移除。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.j('DELETE', `/api/workflows/${id}`);
      if (S.def && S.def.id === id) {
        S.def = newWorkflow();
        $('wf-id').value = S.def.id;
        $('wf-name').value = S.def.name;
        resetAfterDelete();
        render();
      }
      renderWorkbenchView(true);
      statusLine(`已删除 ${name}`, 'ok');
    } catch (err) { statusLine(`删除失败：${err.message}`, 'err'); }
  });
}

// 轻量刷新指示器：已有内容刷新时不切换为骨架
function showWbRefreshing(on) {
  const el = document.getElementById('wb-refreshing');
  if (el) el.style.display = on ? 'inline-flex' : 'none';
}

// ---- Workbench 搜索 / 排序绑定 ----
document.getElementById('wbcard-search')?.addEventListener('input', (ev) => { WB2.q = ev.target.value.trim(); if (WB2._wfs) renderWbCards(); else renderWorkbenchView(); });
document.getElementById('wbcard-sort')?.addEventListener('change', (ev) => { WB2.sort = ev.target.value; if (WB2._wfs) renderWbCards(); else renderWorkbenchView(); });

document.getElementById('wb-new')?.addEventListener('click', () => {
  S.def = newWorkflow();
  $('wf-id').value = S.def.id;
  $('wf-name').value = S.def.name;
  S.sel = null; S.dirty = true;
  render();
  switchToEditMode();
});

// 历史按钮：进入执行视图并打开该工作流的执行历史
// ---------- Phase 9：模板库 ----------
$('btn-tpl-lib').onclick = async () => {
  const dlg = $('tpl-dialog');
  const list = $('tpl-list');
  list.innerHTML = '加载中…';
  dlg.classList.add('open');
  try {
    const tpls = await API.j('GET', '/api/templates');
    if (!tpls.length) { list.innerHTML = '<div class="ins-empty">暂无模板</div>'; return; }
    // Phase 10（§30）：两级展示第一级——内置 / 用户分组，列表只显用途
    const groupHtml = (title, arr) => arr.length
      ? `<div class="tpl-group-title">${title}（${arr.length}）</div>` + arr.map(tplRow).join('')
      : '';
    function tplRow(t) { return `
      <div class="tpl-item">
        <h4>${esc(t.name)}<span class="tpl-badge">${t.category === 'builtin' ? '内置' : '用户'}</span></h4>
        <div class="tpl-desc">${esc(t.description || '（无描述）')}</div>
        <div class="tpl-meta">${t.nodeCount} 节点 · ${t.edgeCount} 连线</div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="primary" data-use="${t.id}">用此模板新建</button>
          <button data-detail="${t.id}">详情</button>
          ${t.category === 'user' ? `<button class="danger" data-del="${t.id}">删除</button>` : ''}
        </div>
      </div>`;
    }
    list.innerHTML = groupHtml('内置模板', tpls.filter(t => t.category === 'builtin')) +
      groupHtml('用户模板', tpls.filter(t => t.category !== 'builtin'));
    list.querySelectorAll('[data-use]').forEach(b => b.onclick = async () => {
      try {
        const r = await API.j('POST', `/api/templates/${b.dataset.use}/instantiate`, {});
        S.def = r.workflow;
        $('wf-id').value = S.def.id;
        $('wf-name').value = S.def.name;
        S.sel = null; S.dirty = false;
        dlg.classList.remove('open');
        render();
        statusLine(`已从模板创建 ${S.def.name}`, 'ok');
      } catch (err) { statusLine(`创建失败：${err.message}`, 'err'); }
    });
        list.querySelectorAll('[data-detail]').forEach(b => b.onclick = async () => {
      try {
        const tpl = await API.j('GET', `/api/templates/${b.dataset.detail}`);
        showTemplateDetail(tpl, () => $('btn-tpl-lib').click());
      } catch (err) { statusLine(`加载详情失败：${err.message}`, 'err'); }
    });
list.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      try {
        await API.j('DELETE', `/api/templates/${b.dataset.del}`);
        statusLine('模板已删除', 'ok');
        $('btn-tpl-lib').click();   // 刷新列表
      } catch (err) { statusLine(`删除失败：${err.message}`, 'err'); }
    });
  } catch (err) {
    list.innerHTML = `<div class="ins-empty">加载失败：${esc(err.message)}</div>`;
  }
};
$('tpl-close').onclick = () => $('tpl-dialog').classList.remove('open');

// ---------- Phase 6：模板详情（§29/30：列表只显用途，详情看完整配置） ----------
function showTemplateDetail(tpl, back) {
  const list = $('tpl-list');
  const def = tpl.def || {};
  const nodes = def.nodes || [];
  const edges = def.edges || [];
  const nodeRows = nodes.map(n => `
    <tr><td>${esc(n.id)}</td><td>${esc(n.type || 'agent')}</td><td>${esc(n.name || '')}</td>
    <td>${esc(n.modelConfig?.model || '默认')}</td><td>${esc(n.roleDescription || n.prompt || '').slice(0, 60)}${(n.roleDescription || n.prompt || '').length > 60 ? '…' : ''}</td>
    <td>${n.review?.enabled ? `Review（${esc(n.review.mode || 'required')}）` : ''}</td></tr>`).join('');
  const edgeRows = edges.map(e => `
    <tr><td>${esc(e.source && typeof e.source === 'object' ? e.source.nodeId : e.source)}${e.source && e.source.output ? '（' + esc(e.source.output) + '）' : ''}</td><td>${esc(e.target && typeof e.target === 'object' ? e.target.nodeId : e.target)}${e.target && e.target.input ? '（' + esc(e.target.input) + '）' : ''}</td><td>${esc(e.routing?.type || e.type || 'bezier')}</td>
    <td>${(e.dataFlow?.artifactKeys || []).map(esc).join(', ')}${e.review?.enabled ? ' · Review' : ''}</td></tr>`).join('');
  const inputRows = Object.entries(def.inputSchema?.properties || def.inputSchema?.schema?.properties || {}).map(([k, v]) => `
    <tr><td>${esc(k)}</td><td>${esc(v.type || 'string')}</td><td>${esc(v.description || '')}</td></tr>`).join('');
  const loopRows = (def.loops || []).map(l => `
    <tr><td>${esc(l.id)}</td><td>${esc((l.nodes || []).join(' → '))}</td><td>${esc(String(l.maxIterations ?? ''))}</td></tr>`).join('');
  list.innerHTML = `
    <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center">
      <button id="tpl-detail-back">&larr; 返回列表</button>
      <h3 style="margin:0">${esc(tpl.name)} <span class="tpl-badge">${tpl.category === 'builtin' ? '内置' : '用户'}</span></h3>
    </div>
    <p class="tpl-desc">${esc(tpl.description || '（无描述）')}</p>
    ${def.settings?.workspaceDir ? `<p><b>工作目录要求：</b><code>${esc(def.settings.workspaceDir)}</code></p>` : ''}
    <h4>节点（${nodes.length}）</h4>
    ${nodes.length ? `<table class="detail-table"><thead><tr><th>id</th><th>类型</th><th>名称</th><th>模型</th><th>角色摘要</th><th>审核</th></tr></thead><tbody>${nodeRows}</tbody></table>` : '<p class="lib-hint">无节点</p>'}
    <h4>连线（${edges.length}）</h4>
    ${edges.length ? `<table class="detail-table"><thead><tr><th>来源</th><th>目标</th><th>线型</th><th>产物</th></tr></thead><tbody>${edgeRows}</tbody></table>` : '<p class="lib-hint">无连线</p>'}
    <h4>输入字段</h4>
    ${inputRows ? `<table class="detail-table"><thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead><tbody>${inputRows}</tbody></table>` : '<p class="lib-hint">无输入字段（运行时以自然语言提供目标）</p>'}
    ${loopRows ? `<h4>迭代环</h4><table class="detail-table"><thead><tr><th>id</th><th>节点</th><th>最大迭代</th></tr></thead><tbody>${loopRows}</tbody></table>` : ''}
  `;
  $('tpl-detail-back').onclick = back;
}

// ---------- Phase 10：预设（Node Template）详情（§29：完整配置不堆在列表） ----------
function showPresetDetail(pr) {
  const list = $('preset-list');
  const n = pr.node || {};
  const ic = n.inputContract || {}, oc = n.outputContract || {};
  const rc = n.runtimeConfig || {};
  const rows = (pairs) => pairs.filter(p => p[1])
    .map(([k, v]) => `<div class="audit-row"><b>${k}：</b>${v}</div>`).join('');
  list.innerHTML = `
    <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center">
      <button id="preset-detail-back">&larr; 返回列表</button>
      <h3 style="margin:0">${esc(pr.name)} <span class="tpl-badge">${n.type === 'human_task' ? '人工任务' : 'Agent'}</span></h3>
    </div>
    <p class="tpl-desc">${esc(pr.description || '（无描述）')}</p>
    <h4>Identity / Role</h4>
    ${rows([['身份', esc(n.identity?.name || '')], ['角色描述', esc(n.roleDescription || '')]])}
    <h4>Input Requirement</h4>
    ${rows([['说明', esc(ic.description || '')], ['处理方式', esc(ic.processing || '')], ['选择策略', esc(ic.selection || '')], ['忽略规则', esc(ic.ignore || '')], ['来源模式', esc(ic.sourceMode || 'all')]])}
    <h4>Output Requirement</h4>
    ${rows([['说明', esc(oc.description || '')], ['格式', esc(oc.format || '')], ['必备小节', (oc.requiredSections || []).map(esc).join('、')], ['产出目标', (oc.targets || []).map(esc).join('、')], ['Schema', oc.schema ? '<code>已定义</code>' : '']])}
    <h4>Model / Runtime</h4>
    ${rows([['模型', esc(n.modelConfig?.model || '默认')], ['最大运行次数', rc.maxRuns], ['超时', rc.timeoutMs ? rc.timeoutMs + 'ms' : ''], ['失败策略', esc(rc.onFailure || '')]])}
    <h4>Review Policy</h4>
    ${rows([['审核', n.review?.enabled ? `启用（${esc(n.review.mode || 'required')}，超时 ${esc(n.review.onTimeout || 'pause')}）` : '未启用']])}
  `;
  $('preset-detail-back').onclick = () => $('btn-preset-lib').click();
}

// ---------- Phase 7：执行历史 UI（树形 rework 链 + Rework 面板化入口） ----------
const ST_CLASS = { running: 'st-run', queued: 'st-run', success: 'st-ok', failed: 'st-err', cancelled: 'st-err', waiting_review: 'st-review', waiting_human: 'st-review' };

function renderExecHistory(items) {
  const list = $('exec-history-list');
  if (!Array.isArray(items) || !items.length) {
    list.innerHTML = '<div class="ins-empty">暂无执行记录。点击「▶ 运行」启动第一次执行。</div>';
    return;
  }
  const children = new Map();
  for (const x of items) {
    const key = x.parentExecutionId || '__root__';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(x);
  }
  const fmtTime = (t) => (t || '').slice(0, 16).replace('T', ' ');
  const row = (x, depth) => `
    <div class="exec-history-item">
      <h4>
        <span class="status-pill ${ST_CLASS[x.status] || 'st-idle'}">${esc(x.status)}</span>
        <span style="font-family:monospace">${esc(x.executionId)}</span>
        <span style="color:var(--fg-dim)">${esc(x.workflowId)} · v${x.workflowVersion}</span>
        ${x.reworkNodeId ? `<span style="color:var(--hitl)">↻ Rework from ${esc(x.reworkNodeId)}</span>` : ''}
      </h4>
      <div class="his-meta">
        ${fmtTime(x.startedAt)}${x.endedAt ? ' → ' + fmtTime(x.endedAt) : ' · 进行中'}
        ${x.workingDirectory ? ` · 目录 <code>${esc(x.workingDirectory)}</code>` : ''}
        ${x.userInput ? `<br>输入：「${esc(x.userInput)}」` : ''}
      </div>
      <div class="his-actions">
        <button class="primary" data-open="${esc(x.executionId)}">查看</button>
        <button data-rework-parent="${esc(x.executionId)}" data-rework-wf="${esc(x.workflowId)}">Rework</button>
      </div>
    </div>`;
  const buildTree = (parentId) => {
    const kids = (children.get(parentId) || []).slice().sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    if (!kids.length) return '';
    return `<div class="${parentId === '__root__' ? '' : 'exec-history-tree'}">` +
      kids.map(x => row(x) + buildTree(x.executionId)).join('') + '</div>';
  };
  list.innerHTML = buildTree('__root__');
  list.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    $('exec-history-dialog').classList.remove('open');
    switchToExecuteMode(); // 查看某次执行 → 进入执行视图
    if (typeof openExecPanel === 'function') openExecPanel(b.dataset.open);
  });
  list.querySelectorAll('[data-rework-parent]').forEach(b => b.onclick = () => openReworkDialog(b.dataset.reworkWf, b.dataset.reworkParent));
}

// ---------- UX：模态窗口点击遮罩（窗口外）自动关闭 ----------
function setupOverlayDismiss() {
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('mousedown', (ev) => {
      if (ev.target === ov) ov.classList.remove('open'); // 点在窗口外（遮罩本身）才关闭
    });
  });
}
setupOverlayDismiss();
const OVERLAY_DISMISS = true;

// ---------- Phase D：⋯ 更多菜单（开合 + 点外关闭 + 菜单项点击后收起） ----------
function updateZoomPct() {
  const el = document.getElementById('zoom-pct');
  if (el) el.textContent = Math.round((S?.view?.k ?? 1) * 100) + '%';
}
function toggleMoreMenu(open) {
  const m = document.getElementById('more-menu');
  if (!m) return;
  const will = open !== undefined ? open : !m.classList.contains('open');
  m.classList.toggle('open', will);
}
document.addEventListener('click', (ev) => {
  const m = document.getElementById('more-menu');
  if (!m || !m.classList.contains('open')) return;
  if (!ev.target.closest('.more-wrap')) toggleMoreMenu(false);   // 点 ⋯ 菜单外收起
});
const btnMore = document.getElementById('btn-more');
if (btnMore) btnMore.addEventListener('click', (ev) => { ev.stopPropagation(); toggleMoreMenu(); });
document.querySelectorAll('#more-menu button').forEach(b => {
  b.addEventListener('click', () => toggleMoreMenu(false));   // 点击菜单项后收起（原 onClick 仍生效）
});
// 菜单项触发对应隐藏按钮（data-trigger → 原 id 的 .click()）
document.querySelectorAll('#more-menu button[data-trigger]').forEach(b => {
  b.addEventListener('click', () => {
    const target = document.getElementById(b.dataset.trigger);
    if (target) target.click();
  });
});

// ---------- Phase D：组件库搜索（按分组/标签/文本过滤） ----------
const libSearch = document.getElementById('lib-search');
if (libSearch) libSearch.addEventListener('input', () => {
  const q = libSearch.value.trim().toLowerCase();
  document.querySelectorAll('#library .lib-item').forEach(item => {
    const txt = (item.textContent + ' ' + (item.dataset.tag || '')).toLowerCase();
    item.style.display = (!q || txt.includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('#library .lib-group').forEach(g => {
    const any = [...g.querySelectorAll('.lib-item')].some(i => i.style.display !== 'none');
    g.style.display = any ? '' : 'none';
  });
});

// ---------- Phase D：底部 Zoom 栏 ----------
function zoomCanvasAt(factor) {
  const wrap = document.getElementById('canvas-wrap');
  if (!wrap || !S) return;
  const k = Math.min(2.5, Math.max(0.3, S.view.k * factor));
  const rect = wrap.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;   // 绕画布中心缩放
  S.view.x = mx - (mx - S.view.x) * (k / S.view.k);
  S.view.y = my - (my - S.view.y) * (k / S.view.k);
  S.view.k = k;
  render();
  updateZoomPct();
}
const zIn = document.getElementById('zoom-in'), zOut = document.getElementById('zoom-out'), zFit = document.getElementById('zoom-fit');
if (zIn) zIn.addEventListener('click', () => zoomCanvasAt(1.2));
if (zOut) zOut.addEventListener('click', () => zoomCanvasAt(1 / 1.2));
if (zFit) zFit.addEventListener('click', () => {
  if (!S || !S.def.nodes.length) return;
  const xs = S.def.nodes.map(n => posOf(n).x), ys = S.def.nodes.map(n => posOf(n).y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) + NODE_W - minX, h = Math.max(...ys) + NODE_H - minY;
  const wrap = document.getElementById('canvas-wrap');
  S.view.k = Math.max(0.3, Math.min((wrap.clientWidth - 40) / w, (wrap.clientHeight - 40) / h, 1.3));
  S.view.x = (wrap.clientWidth - w * S.view.k) / 2 - minX * S.view.k;
  S.view.y = (wrap.clientHeight - h * S.view.k) / 2 - minY * S.view.k;
  render();
  updateZoomPct();
  statusLine('已缩放到全部节点', 'ok');
});

// ---------- Workbench（§3-§26）：搜索 / 筛选 / 排序 / 删除确认 ----------
const WB = { filter: 'all', q: '', sort: 'updated' };

function wbRelTime(t) {
  if (!t) return '';
  const d = Date.now() - new Date(t).getTime();
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  return `${Math.floor(d / 86400e3)} 天前`;
}

function wbApply(items) {
  let arr = items.slice();
  if (WB.q) {
    const q = WB.q.toLowerCase();
    arr = arr.filter(x => (x.workflowName || '').toLowerCase().includes(q)
      || (x.userInput || '').toLowerCase().includes(q)
      || (x.workingDirectory || '').toLowerCase().includes(q));
  }
  if (WB.filter === 'running') arr = arr.filter(x => ['running', 'queued'].includes(x.status));
  else if (WB.filter === 'review') arr = arr.filter(x => ['waiting_review', 'waiting_human'].includes(x.status));
  else if (WB.filter !== 'all') arr = arr.filter(x => x.status === WB.filter);
  const cmp = {
    updated: (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
    created: (a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
    name: (a, b) => String(a.workflowName ?? '').localeCompare(String(b.workflowName ?? '')),
    status: (a, b) => String(a.status ?? '').localeCompare(String(b.status ?? '')),
  }[WB.sort];
  arr.sort(cmp);
  return arr;
}

function renderWbChips(items) {
  const counts = { all: items.length, running: 0, review: 0, completed: 0, failed: 0 };
  for (const x of items) {
    if (['running', 'queued'].includes(x.status)) counts.running++;
    else if (['waiting_review', 'waiting_human'].includes(x.status)) counts.review++;
    else if (['success', 'completed'].includes(x.status)) counts.completed++;
    else if (['failed', 'terminated', 'cancelled'].includes(x.status)) counts.failed++;
  }
  $('wb-filters').innerHTML = [['all', '全部'], ['running', '运行中'], ['review', '待审核'], ['completed', '已完成'], ['failed', '失败']]
    .map(([k, label]) => `<button class="wb-chip ${WB.filter === k ? 'on' : ''}" data-wbf="${k}">${label} ${counts[k]}</button>`).join('');
  $('wb-filters').querySelectorAll('[data-wbf]').forEach(b => b.onclick = () => { WB.filter = b.dataset.wbf; openWorkbench(); });
}

let WB_DELETE = null;
async function openWorkbench(execId) {
  const list = $('exec-history-list');
  list.innerHTML = '加载中…';
  $('exec-history-dialog').classList.add('open');
  try {
    const all = await API.j('GET', '/api/executions');
    renderWbChips(all);
    const items = execId ? all.filter(x => x.executionId === execId) : wbApply(all);
    renderWorkbench(items, all);
  } catch (err) {
    list.innerHTML = `<div class="ins-empty">加载失败：${esc(err.message)}</div>`;
  }
}

function renderWorkbench(items, all) {
  const list = $('exec-history-list');
  if (!Array.isArray(items) || !items.length) {
    list.innerHTML = '<div class="ins-empty">无匹配的执行记录。</div>';
    return;
  }
  const byId = new Map(all.map(x => [x.executionId, x]));
  const children = new Map();
  for (const x of all) {
    const key = x.parentExecutionId || '__root__';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(x);
  }
  const row = (x) => {
    const parent = x.parentExecutionId ? byId.get(x.parentExecutionId) : null;
    return `
    <div class="exec-history-item">
      <h4>
        <span class="status-pill ${ST_CLASS[x.status] || 'st-idle'}">${esc(x.status)}</span>
        <span class="wf-name">${esc(x.workflowName || x.workflowId)}</span>
        ${parent ? `<span style="color:var(--hitl);font-size:11px">↳ Rework from Run #${parent.runNumber ?? '?'}</span>` : ''}
      </h4>
      ${x.userInput ? `<div class="wf-desc">${esc(x.userInput)}</div>` : ''}
      <div class="his-meta">
        ${esc(x.status)} · Run #${x.runNumber ?? 1} · ${wbRelTime(x.updatedAt)}
      </div>
      ${x.workingDirectory ? `<div class="wf-cwd">工作目录：<code>${esc(x.workingDirectory)}</code></div>` : ''}
      <div class="his-actions">
        <button class="primary" data-open="${esc(x.executionId)}">详情</button>
        <button data-wbdel="${esc(x.executionId)}" data-wbname="${esc(x.workflowName || x.workflowId)}">删除</button>
        <button data-rework-parent="${esc(x.executionId)}" data-rework-wf="${esc(x.workflowId)}">Rework</button>
      </div>
    </div>`;
  };
  // 树形：根执行按当前排序，Rework 子链缩进（§25）
  const visible = new Set(items.map(x => x.executionId));
  const buildTree = (parentId) => {
    const kids = (children.get(parentId) || []).filter(x => visible.has(x.executionId));
    if (!kids.length) return '';
    return `<div class="${parentId === '__root__' ? '' : 'exec-history-tree'}">` +
      kids.map(x => row(x) + buildTree(x.executionId)).join('') + '</div>';
  };
  list.innerHTML = buildTree('__root__');
  list.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    $('exec-history-dialog').classList.remove('open');
    if (typeof openExecPanel === 'function') openExecPanel(b.dataset.open);
  });
  list.querySelectorAll('[data-wbdel]').forEach(b => b.onclick = () => {
    WB_DELETE = { id: b.dataset.wbdel, name: b.dataset.wbname };
    $('wb-del-text').innerHTML = `<b>${esc(WB_DELETE.name)}</b><br>此执行记录将从工作台移除。`;
    $('wb-del-dialog').classList.add('open');
  });
  list.querySelectorAll('[data-rework-parent]').forEach(b => b.onclick = () => openReworkDialog(b.dataset.reworkWf, b.dataset.reworkParent));
}

$('wb-search').oninput = (ev) => { WB.q = ev.target.value.trim(); openWorkbench(); };
$('wb-sort').onchange = (ev) => { WB.sort = ev.target.value; openWorkbench(); };
$('wb-del-cancel').onclick = () => { WB_DELETE = null; $('wb-del-dialog').classList.remove('open'); };
$('wb-del-go').onclick = async () => {
  if (!WB_DELETE) return;
  try {
    await API.j('DELETE', `/api/executions/${WB_DELETE.id}`);
    $('wb-del-dialog').classList.remove('open');
    statusLine(`已删除执行记录：${WB_DELETE.name}`, 'ok');
    WB_DELETE = null;
    openWorkbench();
  } catch (err) { statusLine(`删除失败：${err.message}`, 'err'); }
};

const _origOpenWorkbench = openWorkbench;

let REWORK = { workflowId: null, parentExecutionId: null };
async function openReworkDialog(workflowId, parentExecutionId) {
  REWORK = { workflowId, parentExecutionId };
  $('rework-parent-id').textContent = parentExecutionId;
  $('rework-input').value = '';
  const sel = $('rework-node');
  sel.innerHTML = '<option value="">加载节点中…</option>';
  $('rework-dialog').classList.add('open');
  try {
    const def = await API.j('GET', `/api/workflows/${encodeURIComponent(workflowId)}`);
    sel.innerHTML = (def.nodes || [])
      .filter(n => n.type === 'agent' || n.type === 'human_task')
      .map(n => `<option value="${esc(n.id)}">${esc(n.id)}（${esc(n.name || '')}${n.review?.enabled ? ' · Review' : ''}）</option>`)
      .join('') || '<option value="">（无可选节点）</option>';
  } catch (err) {
    sel.innerHTML = `<option value="">加载失败：${esc(err.message)}</option>`;
  }
}

$('exec-history-close').onclick = () => $('exec-history-dialog').classList.remove('open');
$('rework-cancel').onclick = () => $('rework-dialog').classList.remove('open');
$('rework-go').onclick = () => {
  const nodeId = $('rework-node').value;
  const input = $('rework-input').value.trim();
  if (!nodeId) { alert('请选择重跑起点节点'); return; }
  const btn = $('rework-go');
  runBtnBusy(btn, async () => {
    try {
      const r = await API.j('POST', `/api/workflows/${encodeURIComponent(REWORK.workflowId)}/rework`, {
        parentExecutionId: REWORK.parentExecutionId,
        reworkNodeId: nodeId,
        input,
      });
      $('rework-dialog').classList.remove('open');
      statusLine(`Rework 已启动：${r.executionId}（父 ${r.parentExecutionId}，从 ${r.reworkNodeId} 继续）`, 'ok');
      if (typeof openExecPanel === 'function') openExecPanel(r.executionId);
    } catch (err) { statusLine(`Rework 失败：${err.message}`, 'err'); }
  }, '启动中…');
};

// LOADING_UX L6 v2：按钮级局部 Loading —— 文字透明 + spinner 绝对居中覆盖，宽度/布局完全不变，杜绝闪烁
function setBtnBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.origLabel == null) btn.dataset.origLabel = btn.textContent;
    if (!btn.querySelector(':scope > .btn-spinner')) {
      const sp = document.createElement('span');
      sp.className = 'btn-spinner';
      sp.setAttribute('aria-hidden', 'true');
      btn.appendChild(sp);
    }
    btn.disabled = true;
    btn.classList.add('btn-loading');
  } else {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    const sp = btn.querySelector(':scope > .btn-spinner');
    if (sp) sp.remove();
    if (btn.dataset.origLabel != null) btn.textContent = btn.dataset.origLabel;
  }
}
// 包装异步任务：开始置 busy，finally 恢复
async function runBtnBusy(btn, task, busyLabel) {
  setBtnBusy(btn, true, busyLabel);
  try { return await task(); } finally { setBtnBusy(btn, false); }
}

// ---------- 节点预设库（需求 4：人才市场式） ----------
$('btn-preset-lib').onclick = async () => {
  const dlg = $('preset-dialog');
  const list = $('preset-list');
  list.innerHTML = '加载中…';
  dlg.classList.add('open');
  try {
    const presets = await API.j('GET', '/api/presets');
    if (!presets.length) { list.innerHTML = '<div class="ins-empty">暂无预设。右键节点 →「存为预设」创建。</div>'; return; }
    // Phase 10（§28）：列表只显名称/一句话用途/类型；完整配置进详情
    list.innerHTML = presets.map(t => `
      <div class="tpl-item">
        <h4>${esc(t.name)}<span class="tpl-badge">${t.nodeType === 'human_task' ? '人工任务' : 'Agent'}</span></h4>
        <div class="tpl-desc">${esc(t.description || '（无描述）')}</div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="primary" data-insert="${t.id}">插入画布</button>
          <button data-pdetail="${t.id}">详情</button>
          <button class="danger" data-pdel="${t.id}">删除</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-pdetail]').forEach(b => b.onclick = async () => {
      try {
        const pr = await API.j('GET', `/api/presets/${b.dataset.pdetail}`);
        showPresetDetail(pr);
      } catch (err) { statusLine(`加载预设详情失败：${err.message}`, 'err'); }
    });
    list.querySelectorAll('[data-insert]').forEach(b => b.onclick = async () => {
      try {
        const pr = await API.j('GET', `/api/presets/${b.dataset.insert}`);
        const node = structuredClone(pr.node);
        let id, i = 1;
        const base = (pr.node.name || 'preset').replace(/[^A-Za-z0-9_]/g, '') || 'preset';
        do { id = `${base}${i++}`; } while (S.def.nodes.some(x => x.id === id));
        node.id = id;
        node.position = { x: 120 + (S.def.nodes.length % 4) * 60, y: 80 + S.def.nodes.length * 40 };
        if (S.def.layout) setPos(node, node.position.x, node.position.y);
        S.def.nodes.push(node);
        S.sel = { kind: 'node', id };
        S.dirty = true;
        dlg.classList.remove('open');
        render();
        statusLine(`已插入预设节点 ${id}（${pr.name}）`, 'ok');
      } catch (err) { statusLine(`插入失败：${err.message}`, 'err'); }
    });
    list.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => {
      const ok = await uiConfirm({ title: '删除预设？', message: `确认删除预设 <b>${esc(b.dataset.pdel)}</b>？`, okText: '删除', danger: true });
      if (!ok) return;
      try { await API.j('DELETE', `/api/presets/${b.dataset.pdel}`); $('btn-preset-lib').click(); }
      catch (err) { statusLine(`删除失败：${err.message}`, 'err'); }
    });
  } catch (err) {
    list.innerHTML = `<div class="ins-empty">加载失败：${esc(err.message)}</div>`;
  }
};
$('preset-close').onclick = () => $('preset-dialog').classList.remove('open');

$('btn-save-tpl').onclick = async () => {
  if (!S.def) return;
  const name = prompt('模板名称：', `${S.def.name} 模板`);
  if (name === null) return;
  const description = prompt('模板描述（可空）：', '') ?? '';
  try {
    const body = { ...S.def, id: $('wf-id').value.trim() || S.def.id };
    const r = await API.j('POST', '/api/templates', { def: body, name: name.trim(), description: description.trim() });
    statusLine(`已存为模板 ${r.template.id}`, 'ok');
  } catch (err) { statusLine(`存模板失败：${err.message}`, 'err'); }
};

// ============================================================
// 任务 2：右键上下文菜单（Node / Edge / Canvas 三套）+ 撤销/重做
// ============================================================
const ctxMenu = $('ctx-menu');
const CLIPBOARD = { node: null };
let S_history = null;

// ---------- 通用确认弹窗（全站统一，替代原生 confirm） ----------
let _cfResolve = null;   // 当前确认回调
function uiConfirm({ title = '确认操作', message = '', okText = '确定', danger = false } = {}) {
  $('cf-title').textContent = title;
  $('cf-msg').innerHTML = message;
  const ok = $('cf-ok');
  ok.textContent = okText;
  ok.className = danger ? 'danger' : 'primary';   // 与 wb-del-go 等全站 danger 按钮样式一致
  $('confirm-dialog').classList.add('open');
  return new Promise((resolve) => { _cfResolve = resolve; });
}
function _cfClose(val) {
  $('confirm-dialog').classList.remove('open');
  if (_cfResolve) { const r = _cfResolve; _cfResolve = null; r(val); }
}
$('cf-ok').onclick = () => _cfClose(true);
$('cf-cancel').onclick = () => _cfClose(false);
$('confirm-dialog').addEventListener('click', (ev) => { if (ev.target.id === 'confirm-dialog') _cfClose(false); });

/** 删除后内存回收：重置编辑状态（选中/撤销栈/剪贴板/交互态/历史面板） */
function resetAfterDelete() {
  S.sel = null;
  S_history = null;
  CLIPBOARD.node = null;
  S.drag = null; S.pan = null; S.linking = null;
  S.dirty = false;
  if (typeof EX !== 'undefined' && EX && EX.def) EX.def = null;   // 执行面板状态清理
}

function historyInit() {
  if (S.def) S_history = GraphOps.createHistory(S.def);
}
function historyCommit() {
  if (!S_history || !S.def) return;
  GraphOps.commitSnapshot(S_history, S.def);
}
// 关键变更点挂提交（包装原有流程）：
// - 拖动/平移/连线过程中不记录快照（避免逐帧刷屏撤销栈）；
// - 离散变更（菜单操作、Inspector 修改）在 render 时提交。
const _origRender = render;
render = function () {
  if (S.def && !S_history) S_history = GraphOps.createHistory(S.def);
  if (S.def && S_history && !S.drag && !S.pan && !S.linking && !S.viewChanging) GraphOps.commitSnapshot(S_history, S.def);
  _origRender();
};

function closeCtxMenu() { ctxMenu.classList.remove('open'); ctxMenu.innerHTML = ''; }
document.addEventListener('click', (ev) => { if (!ctxMenu.contains(ev.target)) closeCtxMenu(); });
document.addEventListener('scroll', closeCtxMenu, true);
window.addEventListener('resize', closeCtxMenu);

function openCtxMenu(ev, title, items) {
  ev.preventDefault();
  ctxMenu.innerHTML = `<div class="ctx-title">${title}</div>` + items.map((it, i) => {
    if (it === '-') return '<div class="ctx-sep"></div>';
    return `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}><span class="ctx-icon">${it.icon ?? ''}</span>${esc(it.label)}</button>`;
  }).join('');
  ctxMenu.querySelectorAll('button[data-i]').forEach(b => {
    b.onclick = () => {
      const item = items[+b.dataset.i];
      closeCtxMenu();
      if (!item.disabled && item.fn) item.fn();
    };
  });
  ctxMenu.classList.add('open');
  // 位置：避免超出视口
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - mw - 8) + 'px';
  ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - mh - 8) + 'px';
}

// ---------- Node 菜单 ----------
function nodeMenu(ev, nodeId) {
  const n = S.def.nodes.find(x => x.id === nodeId);
  if (!n) return;
  S.sel = { kind: 'node', id: nodeId };
  render();
  const isTerminal = n.type === 'start' || n.type === 'end';
  openCtxMenu(ev, `节点：${n.name || nodeId}`, [
    { icon: '✎', label: '编辑属性', fn: () => { S.insTab = 'basic'; renderInspector(); } },
    { icon: '▶', label: 'Run From Here（从此节点起跑）', disabled: isTerminal, fn: () => reworkFromNode(nodeId, null) },
    { icon: '↻', label: 'Rework From Here（带新请求继续）', disabled: isTerminal, fn: () => {
      const input = prompt('Rework：输入新的任务请求（将注入该节点的 prompt）：');
      if (input === null) return;
      reworkFromNode(nodeId, input);
    } },
    { icon: '🕘', label: '查看执行历史', fn: () => showNodeHistory(nodeId) },
    '-',
    { icon: '⧉', label: '复制（不复制边）', disabled: isTerminal, fn: () => {
      const r = GraphOps.duplicateNode(S.def, nodeId);
      if (!r.ok) return statusLine(r.message, 'err');
      CLIPBOARD.node = r.node;   // 副本同时入剪贴板
      statusLine(`已复制 ${nodeId} → 剪贴板（粘贴时生成新 ID）`, 'ok');
    } },
    { icon: '⊕', label: '克隆（立即放置副本）', disabled: isTerminal, fn: () => {
      const r = GraphOps.duplicateNode(S.def, nodeId);
      if (!r.ok) return statusLine(r.message, 'err');
      S.def.nodes.push(r.node);
      S.sel = { kind: 'node', id: r.node.id };
      S.dirty = true;
      statusLine(`已克隆为 ${r.node.id}`, 'ok');
      render();
    } },
    '-',
    { icon: n.disabled ? '☑' : '☐', label: n.disabled ? '启用节点' : '禁用节点（执行时旁路）', disabled: isTerminal, fn: () => {
      const r = GraphOps.toggleDisabled(S.def, nodeId);
      if (!r.ok) return statusLine(r.message, 'err');
      S.dirty = true;
      statusLine(`节点 ${nodeId} 已${r.disabled ? '禁用（执行时跳过，依赖透传）' : '启用'}`, 'ok');
      render();
    } },
    { icon: '◫', label: '应用预设（Agent 通用）', disabled: isTerminal, fn: () => {
      n.roleDescription = n.roleDescription || '请基于上游输入，按输出契约完成本环节任务。';
      n.inputContract.sourceMode = n.inputContract.sourceMode || 'all';
      n.runtimeConfig.maxRuns = n.runtimeConfig.maxRuns || 5;
      n.runtimeConfig.retry = n.runtimeConfig.retry || { enabled: false, maxRetries: 1, backoffMs: 2000 };
      S.dirty = true;
      statusLine(`已对 ${nodeId} 应用预设配置`, 'ok');
      render();
    } },
    { icon: '📌', label: '存为预设（入预设库）', disabled: isTerminal, fn: async () => {
      const name = prompt('预设名称：', n.name || nodeId);
      if (name === null) return;
      try {
        await API.j('POST', '/api/presets', { node: structuredClone(n), name });
        statusLine(`已存为预设：${name}`, 'ok');
      } catch (err) { statusLine(`存预设失败：${err.message}`, 'err'); }
    } },
    { icon: '⌕', label: '查看输入 / 输出契约', fn: () => {
      const ic = n.inputContract, oc = n.outputContract;
      alert(`【输入契约】\n来源模式：${ic.sourceMode}\n说明：${ic.description || '（空）'}\n\n【输出契约】\n格式：${oc.format}\n说明：${oc.description || '（空）'}\n必填小节：${(oc.requiredSections || []).join('、') || '（无）'}`);
    } },
    '-',
    { icon: '✕', label: '删除节点（级联删除连线）', danger: true, disabled: isTerminal, fn: async () => {
      const related = S.def.edges.filter(e => e.source.nodeId === nodeId || e.target.nodeId === nodeId);
      const ok = await uiConfirm({ title: '删除节点？', message: `确认删除节点 <b>${esc(n.name || nodeId)}</b>？<br>将同时删除 ${related.length} 条相关连线。`, okText: '删除', danger: true });
      if (!ok) return;
      const r = GraphOps.deleteNode(S.def, nodeId);
      if (!r.ok) return statusLine(r.message, 'err');
      S.sel = null;
      S.dirty = true;
      statusLine(`已删除 ${nodeId} 及其 ${r.removedEdges.length} 条连线`, 'ok');
      render();
    } },
  ]);
}

// ---------- Edge 菜单 ----------
function edgeMenu(ev, edgeId) {
  const e = S.def.edges.find(x => x.id === edgeId);
  if (!e) return;
  S.sel = { kind: 'edge', id: edgeId };
  render();
  openCtxMenu(ev, `连线：${e.source.nodeId} → ${e.target.nodeId}`, [
    { icon: '✎', label: '编辑连线', fn: () => { S.insTab = 'conn'; renderInspector(); } },
    { icon: '⇄', label: `Transform：${e.transform?.enabled ? '已启用 → 关闭' : '未启用 → 开启'}`, fn: () => {
      e.transform = { enabled: !(e.transform?.enabled), instruction: e.transform?.instruction || '' };
      S.dirty = true;
      statusLine(`Transform 已${e.transform.enabled ? '启用' : '关闭'}`, 'ok');
      render();
    } },
    { icon: '⚖', label: `Review Gate：${e.review?.enabled ? '已启用 → 移除' : '未启用 → 启用'}`, fn: () => {
      e.review = e.review?.enabled ? undefined : defaultReview();
      S.dirty = true;
      statusLine(`Review Gate 已${e.review ? '启用（默认：必须审核/超时暂停）' : '移除'}`, 'ok');
      render();
    } },
    { icon: '◇', label: '条件（MVP 恒空，Phase 8 启用）', disabled: true, fn: () => {} },
    '-',
    { icon: '⌒', label: `线型：${edgeRoutingOf(e).type || 'bezier'}（点击切换）`, fn: () => {
      const order = ['bezier', 'straight', 'orthogonal'];
      const r = edgeRoutingOf(e);
      const next = order[(order.indexOf(r.type || 'bezier') + 1) % order.length];
      e.routing = { mode: next === (e.routing?.mode || 'auto') ? (e.routing?.mode || 'auto') : 'auto', type: next, points: r.points || [] };
      if (!e.routing.points?.length) e.routing.mode = 'auto';
      S.dirty = true;
      statusLine(`连线路径已切换为 ${next}`, 'ok');
      render();
    } },
    { icon: '＋', label: '添加控制点（中点，可拖拽）', fn: () => {
      const s = S.def.nodes.find(n => n.id === e.source.nodeId);
      const t = S.def.nodes.find(n => n.id === e.target.nodeId);
      if (!s || !t) return;
      e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] };
      e.routing.mode = 'manual';
      e.routing.points = e.routing.points || [];
      const mps = posOf(s), mpt = posOf(t);
      e.routing.points.push({ x: (mpt.x - mps.x) / 2, y: (mpt.y - mps.y) / 2 - 40 });
      S.dirty = true;
      statusLine('已转为手动路径并添加控制点（拖动圆点调整，双击连线追加）', 'ok');
      render();
    } },
    { icon: '↺', label: '重置路径（恢复自动）', fn: () => {
      e.routing = { mode: 'auto', type: e.routing?.type || 'bezier', points: [] };
      S.dirty = true;
      statusLine('连线路径已重置为自动', 'ok');
      render();
    } },
    { icon: '⇉', label: '查看数据流', fn: () => {
      const df = e.dataFlow;
      const lines = [
        `连线：${e.source.nodeId} → ${e.target.nodeId}`,
        `产物过滤（artifactKeys）：${df?.artifactKeys?.length ? df.artifactKeys.join(', ') : '（全部）'}`,
        `输入映射（inputMapping）：${df?.inputMapping ? JSON.stringify(df.inputMapping) : '（无）'}`,
        `Transform：${e.transform?.enabled ? e.transform.instruction || '（已启用，无指令）' : '未启用'}`,
        `Review Gate：${e.review?.enabled ? `启用（${e.review.mode || 'required'}）` : '未启用'}`,
      ];
      alert(lines.join('\n'));
    } },
    '-',
    { icon: '⇋', label: '反转方向', fn: () => {
      if (e.source.nodeId === e.target.nodeId) return statusLine('自环不能反转', 'err');
      const r = GraphOps.reverseEdge(S.def, edgeId);
      if (!r.ok) return statusLine(r.message, 'err');
      S.dirty = true;
      statusLine(`已反转为 ${e.source.nodeId} → ${e.target.nodeId}`, 'ok');
      render();
    } },
    { icon: '✕', label: '删除连线', danger: true, fn: async () => {
      const ok = await uiConfirm({ title: '删除连线？', message: `确认删除连线 <b>${esc(e.source.nodeId)} → ${esc(e.target.nodeId)}</b>？`, okText: '删除', danger: true });
      if (!ok) return;
      S.def.edges = S.def.edges.filter(x => x.id !== edgeId);
      S.sel = null;
      S.dirty = true;
      statusLine('连线已删除', 'ok');
      render();
    } },
  ]);
}

// ---------- Canvas 菜单 ----------
function canvasMenu(ev) {
  const w = screenToWorld(ev.clientX, ev.clientY);
  const addNode = (type) => {
    const chk = GraphOps.canAddNodeType(S.def, type);
    if (!chk.ok) return statusLine(chk.message, 'err');
    let i = 1, id;
    do { id = `${type}${i++}`; } while (S.def.nodes.some(n => n.id === id));
    S.def.nodes.push(mkNode(type, id, Math.round(w.x - NODE_W / 2), Math.round(w.y - NODE_H / 2)));
    S.sel = { kind: 'node', id };
    S.dirty = true;
    render();
  };
  openCtxMenu(ev, '画布', [
    { icon: '🤖', label: '添加 Agent 节点', fn: () => addNode('agent') },
    { icon: '👤', label: '添加人工任务节点', fn: () => addNode('human_task') },
    { icon: '▶', label: '添加 Start（仅可一个）', disabled: S.def.nodes.some(n => n.type === 'start'), fn: () => addNode('start') },
    { icon: '■', label: '添加 End（仅可一个）', disabled: S.def.nodes.some(n => n.type === 'end'), fn: () => addNode('end') },
    '-',
    { icon: '⎘', label: '粘贴节点', disabled: !CLIPBOARD.node, fn: () => {
      const r = GraphOps.pasteNode(S.def, CLIPBOARD.node, w);
      if (!r.ok) return statusLine(r.message, 'err');
      S.sel = { kind: 'node', id: r.node.id };
      S.dirty = true;
      statusLine(`已粘贴为 ${r.node.id}`, 'ok');
      render();
    } },
    { icon: '⧉', label: '自动布局', fn: () => {
      const r = window.computeLayout(S.def, { nodeW: NODE_W, nodeH: NODE_H, gapX: 70, gapY: 40 });
      for (const n of S.def.nodes) {
        const p = r.positions.get(n.id);
        if (p) { setPos(n, p.x, p.y); }
      }
      S.dirty = true;
      // 视图适配
      const wrap = $('canvas-wrap');
      const k = Math.min((wrap.clientWidth - 40) / r.width, (wrap.clientHeight - 40) / r.height, 1.3);
      S.view.k = Math.max(0.3, k);
      S.view.x = Math.max(16, (wrap.clientWidth - r.width * S.view.k) / 2);
      S.view.y = Math.max(16, (wrap.clientHeight - r.height * S.view.k) / 2);
      statusLine('已自动布局', 'ok');
      render();
    } },
    '-',
    { icon: '⤫', label: '重置所有连线路径', fn: () => {
      for (const e of S.def.edges) {
        if (e.routing) e.routing = { mode: 'auto', type: 'bezier', points: [] };
      }
      S.dirty = true;
      statusLine('已重置全部连线路径为自动', 'ok');
      render();
    } },
    { icon: '⤢', label: '缩放到全部', fn: () => {
      if (!S.def.nodes.length) return;
      const xs = S.def.nodes.map(n => posOf(n).x), ys = S.def.nodes.map(n => posOf(n).y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const w = Math.max(...xs) + NODE_W - minX, h = Math.max(...ys) + NODE_H - minY;
      const wrap = $('canvas-wrap');
      S.view.k = Math.max(0.3, Math.min((wrap.clientWidth - 40) / w, (wrap.clientHeight - 40) / h, 1.3));
      S.view.x = Math.max(16, (wrap.clientWidth - w * S.view.k) / 2 - minX * S.view.k + minX * 0);
      S.view.x = (wrap.clientWidth - w * S.view.k) / 2 - minX * S.view.k;
      S.view.y = (wrap.clientHeight - h * S.view.k) / 2 - minY * S.view.k;
      statusLine('已缩放到全部节点', 'ok');
      render();
    } },
    '-',
    { icon: '↶', label: '撤销（Ctrl+Z）', fn: () => doUndo() },
    { icon: '↷', label: '重做（Ctrl+Y）', fn: () => doRedo() },
  ]);
}

function doUndo() {
  if (!S_history) return;
  const snap = GraphOps.undoStep(S_history);
  if (!snap) return statusLine('无可撤销操作', '');
  S.def = JSON.parse(snap);
  S.sel = null;
  S.dirty = true;
  _origRender();
}
function doRedo() {
  if (!S_history) return;
  const snap = GraphOps.redoStep(S_history);
  if (!snap) return statusLine('无可重做操作', '');
  S.def = JSON.parse(snap);
  S.sel = null;
  S.dirty = true;
  _origRender();
}

// ---------- 右键事件分发 ----------
svg.addEventListener('contextmenu', (ev) => {
  if (!S.def) return;
  const nodeEl = ev.target.closest('g.node');
  const edgeHit = ev.target.closest('.edge-hit');
  if (nodeEl) nodeMenu(ev, nodeEl.getAttribute('data-node'));
  else if (edgeHit) edgeMenu(ev, edgeHit.getAttribute('data-edge'));
  else canvasMenu(ev);
});

// 快捷键：撤销/重做
window.addEventListener('keydown', (ev) => {
  if (!S.def) return;
  const inField = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (inField) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); doUndo(); }
  else if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) { ev.preventDefault(); doRedo(); }
});

// ---------- Phase F（§26）：快捷键补全 ----------
S.spaceDown = false;
window.addEventListener('keydown', (ev) => {
  const inField = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key.toLowerCase();
  // Space：平移状态（输入框内不拦截）
  if (ev.code === 'Space' && !inField) {
    S.spaceDown = true;
    if (ev.target === document.body) ev.preventDefault();
    return;
  }
  if (inField || !S.def) return;
  if (mod && k === 's') { ev.preventDefault(); if ($('btn-save')) $('btn-save').click(); return; }
  if (mod && k === 'd') {
    ev.preventDefault();
    if (S.sel && S.sel.kind === 'node') {
      const r = GraphOps.duplicateNode(S.def, S.sel.id);
      if (r.ok) { S.def.nodes.push(r.node); CLIPBOARD.node = r.node; S.sel = { kind: 'node', id: r.node.id }; S.dirty = true; statusLine(`已复制为 ${r.node.id}`, 'ok'); render(); }
      else statusLine(r.message, 'err');
    } else statusLine('请先选中一个节点再复制', '');
    return;
  }
  if (mod && k === 'c') {
    ev.preventDefault();
    if (S.sel && S.sel.kind === 'node') {
      const n = S.def.nodes.find(x => x.id === S.sel.id);
      if (n) {
        // §22 唯一性：Start / End 不允许复制
        if (n.type === 'start' || n.type === 'end') {
          statusLine(`${n.type === 'start' ? 'Start' : 'End'} 节点不可复制：一个 Workflow 只能各有一个`, 'err');
          return;
        }
        CLIPBOARD.node = JSON.parse(JSON.stringify(n)); statusLine(`已复制 ${n.id} 到剪贴板`, 'ok');
      }
    } else statusLine('请先选中一个节点', '');
    return;
  }
  if (mod && k === 'v') {
    ev.preventDefault();
    if (!CLIPBOARD.node) { statusLine('剪贴板为空', ''); return; }
    const rect = svg.getBoundingClientRect();
    const w = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const r = GraphOps.pasteNode(S.def, CLIPBOARD.node, w);
    if (r.ok) { S.sel = { kind: 'node', id: r.node.id }; S.dirty = true; statusLine(`已粘贴为 ${r.node.id}`, 'ok'); render(); }
    else statusLine(r.message, 'err');
    return;
  }
  if ((ev.key === '+' || ev.key === '=') && !mod) { ev.preventDefault(); zoomCanvasAt(1.2); return; }
  if (ev.key === '-' && !mod) { ev.preventDefault(); zoomCanvasAt(1 / 1.2); return; }
});
window.addEventListener('keyup', (ev) => { if (ev.code === 'Space') S.spaceDown = false; });



// ---------- Phase 9：控制点拖拽 + 双击连线追加控制点 ----------
let CTRL_DRAG = null;
svg.addEventListener('mousedown', (ev) => {
  const c = ev.target.closest('.edge-ctrl');
  if (!c || !S.def) return;
  ev.preventDefault();
  const e = S.def.edges.find(x => x.id === c.dataset.edge);
  if (!e) return;
  CTRL_DRAG = { edgeId: e.id, idx: +c.dataset.idx };
  S.sel = { kind: 'edge', id: e.id };
});
window.addEventListener('mousemove', (ev) => {
  if (!CTRL_DRAG || !S.def) return;
  const e = S.def.edges.find(x => x.id === CTRL_DRAG.edgeId);
  if (!e) return;
  const s = S.def.nodes.find(n => n.id === e.source.nodeId);
  if (!s) return;
  const w = screenToWorld(ev.clientX, ev.clientY);
  const spd = posOf(s);
  e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] };
  e.routing.mode = 'manual';
  e.routing.points = e.routing.points || [];
  e.routing.points[CTRL_DRAG.idx] = { x: +(w.x - spd.x).toFixed(1), y: +(w.y - spd.y).toFixed(1) };
  S.dirty = true;
  render();
});
window.addEventListener('mouseup', () => { CTRL_DRAG = null; });
svg.addEventListener('dblclick', (ev) => {
  if (!S.def) return;
  const hit = ev.target.closest('.edge-hit');
  if (!hit) return;
  const e = S.def.edges.find(x => x.id === hit.getAttribute('data-edge'));
  if (!e) return;
  const s = S.def.nodes.find(n => n.id === e.source.nodeId);
  if (!s) return;
  const w = screenToWorld(ev.clientX, ev.clientY);
  const spd2 = posOf(s);
  e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] };
  e.routing.mode = 'manual';
  e.routing.points = e.routing.points || [];
  e.routing.points.push({ x: +(w.x - spd2.x).toFixed(1), y: +(w.y - spd2.y).toFixed(1) });
  e.routing.points.sort((a, b) => a.x - b.x);
  S.dirty = true;
  statusLine('已添加控制点：拖动圆点调整路径', 'ok');
  render();
});

// ---------- Phase 6：Run / Rework From Here + 节点执行历史 ----------
async function reworkFromNode(nodeId, input) {
  if (!S.def) return;
  try {
    const list = await API.j('GET', '/api/executions');
    const parent = (Array.isArray(list) ? list : []).find(x => x.workflowId === S.def.id);
    if (!parent) {
      statusLine('该工作流还没有执行历史——请先用顶部「运行」完整执行一次', 'err');
      return;
    }
    const r = await API.j('POST', `/api/workflows/${encodeURIComponent(S.def.id)}/rework`, {
      parentExecutionId: parent.executionId,
      reworkNodeId: nodeId,
      input: input || '',
    });
    statusLine(`Rework 已启动：${r.executionId}（父执行 ${r.parentExecutionId}，从 ${r.reworkNodeId} 继续）`, 'ok');
    const openPanel = await uiConfirm({ title: 'Rework 已启动', message: `已创建 Rework 执行 <b>${esc(r.executionId)}</b>。<br>打开执行面板查看？`, okText: '打开', danger: false });
    if (openPanel && typeof openExecPanel === 'function') openExecPanel(r.executionId);
  } catch (err) { statusLine(`Rework 失败：${err.message}`, 'err'); }
}

async function showNodeHistory(nodeId) {
  if (!S.def) return;
  try {
    const list = await API.j('GET', '/api/executions');
    const mine = (Array.isArray(list) ? list : []).filter(x => x.workflowId === S.def.id);
    if (!mine.length) { alert(`节点 ${nodeId}：当前工作流暂无执行历史`); return; }
    const lines = mine.map(x =>
      `${x.executionId}  ${x.status}  v${x.workflowVersion}` +
      `${x.reworkNodeId ? `  ↻rework from ${x.reworkNodeId}` : ''}` +
      `  ${(x.startedAt || '').slice(0, 16).replace('T', ' ')}` +
      `${x.userInput ? `  「${String(x.userInput).slice(0, 40)}」` : ''}`);
    alert(`工作流执行历史（${mine.length} 条，含树形 rework 链）：\n\n${lines.join('\n')}`);
  } catch (err) { statusLine(`加载执行历史失败：${err.message}`, 'err'); }
}

// ---------- Phase F（§27）：空画布 Empty State CTA ----------
function addNodeCentered(type) {
  if (!S.def) return;
  const chk = GraphOps.canAddNodeType(S.def, type);
  if (!chk.ok) return statusLine(chk.message, 'err');
  let i = 1, id;
  do { id = `${type}${i++}`; } while (S.def.nodes.some(n => n.id === id));
  const rect = svg.getBoundingClientRect();
  const w = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  S.def.nodes.push(mkNode(type, id, Math.round(w.x - NODE_W / 2), Math.round(w.y - NODE_H / 2)));
  S.sel = { kind: 'node', id };
  S.dirty = true;
  render();
}
const _ea1 = document.getElementById('empty-add-agent');
const _ea2 = document.getElementById('empty-add-human');
if (_ea1) _ea1.addEventListener('click', () => addNodeCentered('agent'));
if (_ea2) _ea2.addEventListener('click', () => addNodeCentered('human_task'));
