# -*- coding: utf-8 -*-
"""Phase 7：Execution History UI（历史对话框 + 树形 rework 链 + Rework 面板化入口）"""
import io, sys

H = "public/index.html"
J = "public/editor.js"

# ---------- index.html ----------
s = io.open(H, encoding="utf-8", newline="").read()
changed = False

if "btn-exec-history" not in s:
    anchor = '<button id="btn-preset-lib" title="节点预设库：保存/插入单节点配置模板">预设库</button>'
    assert anchor in s, "toolbar anchor missing"
    s = s.replace(anchor, anchor + '\n    <button id="btn-exec-history" title="执行历史：查看所有运行记录与 Rework 链">🕘 历史</button>', 1)
    changed = True

if "exec-history-dialog" not in s:
    anchor = '<div id="run-dialog" class="modal-overlay">'
    assert anchor in s, "run-dialog anchor missing"
    dialog = '''<!-- Phase 7：执行历史对话框（树形 rework 链 + Rework 入口） -->
<div id="exec-history-dialog" class="modal-overlay">
  <div class="box" style="width:720px;max-width:92vw">
    <h3>执行历史</h3>
    <div id="exec-history-list" style="max-height:420px;overflow-y:auto;margin:10px 0"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button id="exec-history-close">关闭</button></div>
  </div>
</div>

<!-- Phase 7：Rework 面板化入口（替代 confirm/prompt 流程） -->
<div id="rework-dialog" class="modal-overlay">
  <div class="box" style="width:560px;max-width:92vw">
    <h3>Rework From Here</h3>
    <p class="lib-hint" style="margin:0 0 8px">基于父执行 <span id="rework-parent-id" style="font-family:monospace"></span> 创建重跑执行：起点之后的下游节点将重新运行，其余节点结果继承。</p>
    <label class="field">重跑起点节点</label>
    <select id="rework-node" style="width:100%"></select>
    <label class="field" style="margin-top:10px">补充输入（注入起点节点 prompt）</label>
    <textarea id="rework-input" rows="3" placeholder="例如：上次产出缺少边界情况覆盖，请补充…"></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="rework-cancel">取消</button>
      <button id="rework-go" class="primary">启动 Rework</button>
    </div>
  </div>
</div>

'''
    s = s.replace(anchor, dialog + anchor, 1)
    changed = True

if "exec-history-item" not in s:
    css_anchor = '  .detail-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0 14px; }'
    assert css_anchor in s, "css anchor missing"
    css = '''  .exec-history-item { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; background: var(--panel2); }
  .exec-history-item h4 { font-size: 12px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .exec-history-item .his-meta { font-size: 11px; color: var(--fg-dim); margin-bottom: 6px; }
  .exec-history-item .his-actions { display: flex; gap: 6px; }
  .exec-history-tree { margin-left: 22px; border-left: 2px dashed var(--line); padding-left: 12px; }
  .status-pill { display: inline-block; font-size: 11px; border-radius: 8px; padding: 1px 8px; border: 1px solid var(--line); }
  .status-pill.st-run { color: var(--st-run); border-color: var(--st-run); }
  .status-pill.st-ok { color: var(--st-ok); border-color: var(--st-ok); }
  .status-pill.st-err { color: var(--st-err); border-color: var(--st-err); }
  .status-pill.st-review { color: var(--hitl); border-color: var(--hitl); }
  .status-pill.st-idle { color: var(--fg-dim); }
''' + css_anchor
    s = s.replace(css_anchor, css, 1)
    changed = True

if changed:
    io.open(H, "w", encoding="utf-8", newline="").write(s)
    print("index.html patched")
else:
    print("index.html already patched")

# ---------- editor.js ----------
j = io.open(J, encoding="utf-8", newline="").read()
if "openExecHistory" in j:
    print("editor.js already patched"); sys.exit(0)

anchor = "// ---------- 节点预设库（需求 4：人才市场式） ----------"
assert anchor in j, "preset anchor missing"
code = '''// ---------- Phase 7：执行历史 UI（树形 rework 链 + Rework 面板化入口） ----------
const ST_CLASS = { running: 'st-run', queued: 'st-run', success: 'st-ok', failed: 'st-err', cancelled: 'st-err', waiting_review: 'st-review', waiting_human: 'st-review' };

function renderExecHistory(items) {
  const list = $('exec-history-list');
  if (!Array.isArray(items) || !items.length) {
    list.innerHTML = '<div class="ins-empty">暂无执行记录。点击顶部「▶ 运行」启动第一次执行。</div>';
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
    if (typeof openExecPanel === 'function') openExecPanel(b.dataset.open);
  });
  list.querySelectorAll('[data-rework-parent]').forEach(b => b.onclick = () => openReworkDialog(b.dataset.reworkWf, b.dataset.reworkParent));
}

async function openExecHistory() {
  const list = $('exec-history-list');
  list.innerHTML = '加载中…';
  $('exec-history-dialog').classList.add('open');
  try {
    renderExecHistory(await API.j('GET', '/api/executions'));
  } catch (err) {
    list.innerHTML = `<div class="ins-empty">加载失败：${esc(err.message)}</div>`;
  }
}

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

$('btn-exec-history').onclick = openExecHistory;
$('exec-history-close').onclick = () => $('exec-history-dialog').classList.remove('open');
$('rework-cancel').onclick = () => $('rework-dialog').classList.remove('open');
$('rework-go').onclick = async () => {
  const nodeId = $('rework-node').value;
  const input = $('rework-input').value.trim();
  if (!nodeId) { alert('请选择重跑起点节点'); return; }
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
};

''' + anchor
j = j.replace(anchor, code, 1)
io.open(J, "w", encoding="utf-8", newline="").write(j)
print("editor.js patched")
