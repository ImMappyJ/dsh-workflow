# -*- coding: utf-8 -*-
"""Workbench 前端：搜索/筛选/排序 + Name 优先卡片 + 删除确认（§3-§26）"""
import io

# ---------- index.html：工作台对话框升级 + 删除确认 ----------
H = "public/index.html"
s = io.open(H, encoding="utf-8", newline="").read()
crlf = "\r\n" in s
if crlf: s = s.replace("\r\n", "\n")

if 'wb-search' not in s:
    old = """<div id="exec-history-dialog" class="modal-overlay">
  <div class="box" style="width:720px;max-width:92vw">
    <h3>执行历史</h3>
    <div id="exec-history-list" style="max-height:420px;overflow-y:auto;margin:10px 0"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button id="exec-history-close">关闭</button></div>
  </div>
</div>"""
    new = """<div id="exec-history-dialog" class="modal-overlay">
  <div class="box" style="width:760px;max-width:94vw">
    <h3>工作台 <span style="font-size:11px;color:var(--fg-dim);font-weight:400">Workflow Workbench</span></h3>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0">
      <input id="wb-search" placeholder="搜索工作流名称 / 描述…" style="flex:1;min-width:180px">
      <select id="wb-sort" style="width:auto">
        <option value="updated">最近更新</option>
        <option value="created">最近创建</option>
        <option value="name">名称 A→Z</option>
        <option value="status">状态</option>
      </select>
    </div>
    <div id="wb-filters" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
    <div id="exec-history-list" style="max-height:420px;overflow-y:auto;margin:8px 0"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button id="exec-history-close">关闭</button></div>
  </div>
</div>

<!-- Workbench：删除 Execution 确认（§10：绝不直接删） -->
<div id="wb-del-dialog" class="modal-overlay">
  <div class="box" style="width:460px;max-width:92vw">
    <h3>删除执行记录？</h3>
    <p id="wb-del-text" style="font-size:12.5px;line-height:1.6"></p>
    <p class="lib-hint">仅删除此执行记录；工作流定义不会被删除（§11）。</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="wb-del-cancel">取消</button>
      <button id="wb-del-go" class="danger">删除</button>
    </div>
  </div>
</div>"""
    assert old in s, 'wb dialog'
    s = s.replace(old, new, 1)

    css_anchor = '  .exec-history-item {'
    css = '''  .wb-chip { font-size: 11px; border: 1px solid var(--line); border-radius: 10px; padding: 2px 10px; background: transparent; cursor: pointer; }
  .wb-chip.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .exec-history-item h4 .wf-name { font-size: 13px; }
  .exec-history-item .wf-desc { font-size: 11.5px; color: var(--fg-dim); margin-bottom: 4px; }
''' + css_anchor
    assert css_anchor in s
    s = s.replace(css_anchor, css, 1)
    io.open(H, "w", encoding="utf-8", newline="").write(s if not crlf else s.replace("\n", "\r\n"))
    print("index.html patched")
else:
    print("index.html already")

# ---------- editor.js ----------
P = "public/editor.js"
src = io.open(P, encoding="utf-8", newline="").read()
crlf2 = "\r\n" in src
if crlf2: src = src.replace("\r\n", "\n")

old = """async function openExecHistory() {
  const list = $('exec-history-list');
  list.innerHTML = '加载中…';
  $('exec-history-dialog').classList.add('open');
  try {
    renderExecHistory(await API.j('GET', '/api/executions'));
  } catch (err) {
    list.innerHTML = `<div class="ins-empty">加载失败：${esc(err.message)}</div>`;
  }
}"""
new = """// ---------- Workbench（§3-§26）：搜索 / 筛选 / 排序 / 删除确认 ----------
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
  $('wb-filters').querySelectorAll('[data-wbf]').forEach(b => b.onclick = () => { WB.filter = b.dataset.wbf; openExecHistory(); });
}

let WB_DELETE = null;
async function openExecHistory() {
  const list = $('exec-history-list');
  list.innerHTML = '加载中…';
  $('exec-history-dialog').classList.add('open');
  try {
    const all = await API.j('GET', '/api/executions');
    renderWbChips(all);
    const items = wbApply(all);
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
        <span class="status-pill ${ST_CLASS[x.status] || 'st-idle'}"></span>
        <span class="wf-name">${esc(x.workflowName || x.workflowId)}</span>
        ${parent ? `<span style="color:var(--hitl);font-size:11px">↳ Rework from Run #${parent.runNumber ?? '?'}</span>` : ''}
      </h4>
      ${x.userInput ? `<div class="wf-desc">${esc(x.userInput)}</div>` : ''}
      <div class="his-meta">
        ${esc(x.status)} · Run #${x.runNumber ?? 1} · ${wbRelTime(x.updatedAt)}
        ${x.workingDirectory ? ` · <code>${esc(x.workingDirectory)}</code>` : ''}
      </div>
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

$('wb-search').oninput = (ev) => { WB.q = ev.target.value.trim(); openExecHistory(); };
$('wb-sort').onchange = (ev) => { WB.sort = ev.target.value; openExecHistory(); };
$('wb-del-cancel').onclick = () => { WB_DELETE = null; $('wb-del-dialog').classList.remove('open'); };
$('wb-del-go').onclick = async () => {
  if (!WB_DELETE) return;
  try {
    await API.j('DELETE', `/api/executions/${WB_DELETE.id}`);
    $('wb-del-dialog').classList.remove('open');
    statusLine(`已删除执行记录：${WB_DELETE.name}`, 'ok');
    WB_DELETE = null;
    openExecHistory();
  } catch (err) { statusLine(`删除失败：${err.message}`, 'err'); }
};

const _origOpenExecHistory = openExecHistory;"""
assert old in src, 'openExecHistory anchor'
src = src.replace(old, new, 1)

if crlf2: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("editor.js patched")
