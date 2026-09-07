# -*- coding: utf-8 -*-
"""Phase 9：编辑器 Edge Routing / Arrow（§16-23 / Test 2-3）"""
import io, sys

P = "public/editor.js"
src = io.open(P, "r", encoding="utf-8", newline="").read()
_crlf = "\r\n" in src
src = src.replace("\r\n", "\n")
if "edgeD(" in src:
    print("already patched"); sys.exit(0)

# 1) 渲染处：箭头 defs + edgeD + 控制点
old = """  svg.innerHTML = '';
  const g = el('g', { transform: `translate(${S.view.x},${S.view.y}) scale(${S.view.k})` });
  svg.appendChild(g);
"""
new = old + """
  // Phase 9：箭头 marker（context-stroke 跟随线色）
  const defs = el('defs', {});
  defs.innerHTML = '<marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>';
  svg.insertBefore(defs, svg.firstChild);
"""
assert old in src, "render head missing"
src = src.replace(old, new, 1)

old = """    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    const cls = ['edge', e.review?.enabled ? 'review' : '', S.sel?.kind === 'edge' && S.sel.id === e.id ? 'selected' : ''].filter(Boolean).join(' ');
    const hit = el('path', { d, class: 'edge-hit', 'data-edge': e.id });
    const path = el('path', { d, class: cls });
    g.appendChild(path); g.appendChild(hit);"""
new = """    const d = edgeD(e, x1, y1, x2, y2);
    const cls = ['edge', e.review?.enabled ? 'review' : '', S.sel?.kind === 'edge' && S.sel.id === e.id ? 'selected' : ''].filter(Boolean).join(' ');
    const hit = el('path', { d, class: 'edge-hit', 'data-edge': e.id });
    const path = el('path', { d, class: cls, 'marker-end': 'url(#wf-arrow)' });
    g.appendChild(path); g.appendChild(hit);
    // Phase 9：选中连线时显示可拖拽控制点（manual routing）
    if (S.sel?.kind === 'edge' && S.sel.id === e.id) {
      const er = edgeRoutingOf(e);
      (er.points || []).forEach((pt, i) => {
        g.appendChild(el('circle', { class: 'edge-ctrl', cx: s.position.x + pt.x, cy: s.position.y + pt.y, r: 5, 'data-edge': e.id, 'data-idx': i }));
      });
    }"""
assert old in src, "edge loop missing"
src = src.replace(old, new, 1)

# 2) 辅助函数：插在 render() 之前
anchor = "function render() {"
fns = """// ---------- Phase 9：Edge Routing（§16-23：auto/manual、bezier/straight/orthogonal、控制点） ----------
function edgeRoutingOf(e) {
  return e.routing && e.routing.mode ? e.routing : { mode: 'auto', type: 'bezier', points: [] };
}
// 控制点以「相对源节点位置」存储：移动/自动布局节点后形状跟随，manual 不被覆盖（Test 3）
function edgeD(e, x1, y1, x2, y2) {
  const r = edgeRoutingOf(e);
  if (r.mode === 'manual' && r.points?.length) {
    const s = S.def.nodes.find(n => n.id === e.source.nodeId);
    const pts = [{ x: x1, y: y1 },
      ...r.points.map(p => ({ x: s.position.x + p.x, y: s.position.y + p.y })),
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

""" + anchor
assert anchor in src
src = src.replace(anchor, fns, 1)

# 3) Edge 右键菜单：线型/控制点/重置/数据流（插在 Review Gate 项之后）
old = """    { icon: '◇', label: '条件（MVP 恒空，Phase 8 启用）', disabled: true, fn: () => {} },
    '-',"""
new = """    { icon: '◇', label: '条件（MVP 恒空，Phase 8 启用）', disabled: true, fn: () => {} },
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
      e.routing.points.push({ x: (t.position.x - s.position.x) / 2, y: (t.position.y - s.position.y) / 2 - 40 });
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
      alert(lines.join('\\n'));
    } },
    '-',"""
assert old in src, "edge menu missing"
src = src.replace(old, new, 1)

# 4) 控制点拖拽 + 双击加控制点（追加到快捷键监听之后）
anchor2 = "// ---------- Phase 6：Run / Rework From Here + 节点执行历史 ----------"
listeners = """// ---------- Phase 9：控制点拖拽 + 双击连线追加控制点 ----------
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
  e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] };
  e.routing.mode = 'manual';
  e.routing.points = e.routing.points || [];
  e.routing.points[CTRL_DRAG.idx] = { x: +(w.x - s.position.x).toFixed(1), y: +(w.y - s.position.y).toFixed(1) };
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
  e.routing = e.routing || { mode: 'auto', type: 'bezier', points: [] };
  e.routing.mode = 'manual';
  e.routing.points = e.routing.points || [];
  e.routing.points.push({ x: +(w.x - s.position.x).toFixed(1), y: +(w.y - s.position.y).toFixed(1) });
  e.routing.points.sort((a, b) => a.x - b.x);
  S.dirty = true;
  statusLine('已添加控制点：拖动圆点调整路径', 'ok');
  render();
});

""" + anchor2
assert anchor2 in src
src = src.replace(anchor2, listeners, 1)

if _crlf: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("patched OK")
