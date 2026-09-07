/* ============================================================
 * DSH Workflow —— 执行面板：运行 / 控制 / 状态渲染 / 审核操作
 * 数据模型（与 src/domain/types.ts 对齐）：
 *   ExecutionState: {status, stepCount, nodeRunCount, nodeStates, outputs,
 *                    artifacts, reviewTasks, auditLog, edgeState, pendingFeedback, workflowId}
 *   NodeRuntimeState: {status, iteration, inputReady, attempt, lastInputVersion}
 *   NodeOutputRecord: {runIndex, content, durationMs, tokenUsage{prompt,completion}, finishedAt}
 *   ReviewTask: {id, edgeId, sourceNodeId, targetNodeIds, artifactId, status, comment, ...}
 *   auditLog[]: {reviewId, artifactId, action, operator, comment, fromVersion, toVersion, timestamp}
 * ============================================================ */
'use strict';

// 注：NODE_W / NODE_H 由 editor.js 在全局作用域声明，此处不重复声明（重复会抛 SyntaxError）
// 执行画布节点卡尺寸（任务 1：更大卡片承载摘要信息）
const XNODE_W = 200, XNODE_H = 130;

// 状态双通道（任务 1）：图标 + 文字 + 颜色三编码，单一色觉障碍也能区分
const NODE_STATUS_META = {
  idle:           { icon: '●', text: '空闲',     v: '--st-idle' },
  queued:         { icon: '◉', text: '排队中',   v: '--st-run' },
  running:        { icon: '◉', text: '运行中',   v: '--st-run' },
  waiting_review: { icon: '!', text: '待审核',   v: '--st-review' },
  waiting_human:  { icon: '⚑', text: '待人工',   v: '--st-human' },
  success:        { icon: '✓', text: '成功',     v: '--st-ok' },
  failed:         { icon: '✗', text: '失败',     v: '--st-err' },
  skipped:        { icon: '–', text: '已跳过',   v: '--st-idle' },
  cancelled:      { icon: '–', text: '已取消',   v: '--st-idle' },
};
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- 轻量零依赖 Markdown 渲染器（审核面板可读性）----------
// 先经 escX 转义再逐行转换，避免 XSS；仅处理常用子集（标题/加粗/斜体/行内代码/代码块/链接/列表/引用/表格/分隔线）。
function renderMarkdown(src) {
  const text = escX(String(src ?? ''));
  const lines = text.split('\n');
  const out = [];
  let i = 0, para = [];
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^```/.test(t)) { flushPara(); const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; } i++;
      out.push('<pre><code>' + buf.join('\n') + '</code></pre>'); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) { flushPara(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); out.push('<hr>'); i++; continue; }
    if (/^&gt;/.test(t)) { flushPara(); const buf = [];
      while (i < lines.length && /^&gt;/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^&gt;\s?/, '')); i++; }
      out.push('<blockquote>' + buf.map(x => inline(x)).join('<br>') + '</blockquote>'); continue; }
    if (/^\|/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      flushPara(); const rows = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(rows[0]); const body = rows.slice(2).map(cells);
      out.push('<table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        body.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>'); continue; }
    if (/^[-*+]\s+/.test(t)) { flushPara(); const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*+]\s+/, '')); i++; }
      out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>'); continue; }
    if (/^\d+\.\s+/.test(t)) { flushPara(); const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+\.\s+/, '')); i++; }
      out.push('<ol>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ol>'); continue; }
    if (t === '') { flushPara(); i++; continue; }
    para.push(t); i++;
  }
  flushPara();
  return out.join('\n');
}

// ---------- Artifact Viewer 注册表（任务 5：按类型渲染）----------
// kind → {icon, label, render(a, state) => html}。未注册类型退化为文本查看。
const ARTIFACT_VIEWERS = {
  text:     { icon: '📄', label: '文本',     render: (a) => `<pre class="detail-block">${escX(a.content)}</pre>` },
  markdown: { icon: '📝', label: 'Markdown', render: (a) => `<div class="md-view">${renderMarkdown(a.content)}</div>` },
  json:     { icon: '{}', label: 'JSON',     render: (a) => { let pretty = a.content; try { pretty = JSON.stringify(JSON.parse(a.content), null, 2); } catch (_) {} return `<pre class="detail-block">${escX(pretty)}</pre>`; } },
  code:     { icon: '</>', label: '代码',     render: (a) => renderCodeViewer(a) },
  image:    { icon: '🖼', label: '图像',
              render: (a) => a.storageRef?.path
                ? `<div class="ins-empty">图像引用：${escX(a.storageRef.path)}</div>`
                : `<pre class="detail-block">${escX(a.content)}</pre>` },
  file:     { icon: '📎', label: '文件',     render: (a) => `<div class="audit-row">📎 ${escX(a.storageRef?.fileName ?? a.content)}${a.storageRef?.sizeBytes ? ` · ${a.storageRef.sizeBytes} bytes` : ''}</div>` },
  directory:{ icon: '📁', label: '目录',     render: (a) => `<div class="audit-row">📁 ${escX(a.storageRef?.path ?? a.content)}</div>` },
  office:   { icon: '📊', label: 'Office',   render: (a) => `<div class="audit-row">📊 ${escX(a.storageRef?.fileName ?? a.content)} <span style="color:var(--fg-dim)">（预览 + 外部编辑）</span></div>` },
};
// code 多文件浏览器（Phase 8）：a.files 存在时渲染文件列表，点击调 code-file 端点展开全文。
// 无 files（旧单 content 形态）退化为单 pre。
function renderCodeViewer(a) {
  if (!Array.isArray(a.files) || !a.files.length) {
    return `<pre class="detail-block" style="font-family:Consolas,monospace">${escX(a.content)}</pre>`;
  }
  const rows = a.files.map((f, i) => `<div class="audit-row code-file-row" data-cf="${escX(f.path)}" data-vidx="${i}" style="cursor:pointer;font-family:Consolas,monospace">📄 ${escX(f.path)}${f.storageRef ? ' <span style="color:var(--fg-dim)">· 大文件/引用</span>' : ''}</div>`).join('');
  return `<div class="code-viewer" data-code-art="${escX(a.id)}">${rows}<div class="code-file-content" style="display:none"></div></div>`;
}

// code Viewer 事件委托（文档级，适配 review 面板与节点详情两处宿主）：
// 点击文件行 → 调 code-file 端点展开全文；展开全文后提供"编辑此文件"（人工提交新 code 版本）。
document.addEventListener('click', async (ev) => {
  const row = ev.target.closest('.code-file-row');
  if (!row) return;
  const viewer = row.closest('.code-viewer');
  const artId = viewer?.dataset.codeArt;
  const path = row.dataset.cf;
  const st = EX.state;
  if (!artId || !path || !st) return;
  // 反查 nodeId + version：artifact id → 所属节点链 → 版本链里的 artifact。
  let nodeId = null, art = null;
  for (const [nid, chain] of Object.entries(st.artifacts || {})) {
    const found = chain.find(a => a.id === artId);
    if (found) { nodeId = nid; art = found; break; }
  }
  if (!art) return;
  const box = viewer.querySelector('.code-file-content');
  if (box.dataset.openPath === path && box.style.display !== 'none') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.dataset.openPath = path;
  box.innerHTML = '<div style="font-size:11px;color:var(--fg-dim)">读取中…</div>';
  try {
    const r = await API.j('POST', `/api/executions/${EX.id}/artifacts/code-file`, { nodeId, version: art.version, path });
    box.innerHTML = `
      <div class="audit-row" style="font-family:Consolas,monospace;font-size:11px">${escX(r.path)} · v${r.version}
        <button class="code-file-edit-btn" style="margin-left:auto">✎ 编辑此文件</button>
      </div>
      <pre class="detail-block" style="font-size:11px">${escX(r.content)}</pre>
      <div class="code-edit-wrap" style="display:none">
        <textarea rows="10" style="width:100%;font-family:Consolas,monospace;font-size:11px">${escX(r.content)}</textarea>
        <div class="review-actions">
          <button class="primary code-edit-submit">✓ 提交为新版本</button>
          <button class="code-edit-cancel">取消</button>
        </div>
      </div>`;
    const wrap = box.querySelector('.code-edit-wrap');
    box.querySelector('.code-file-edit-btn').onclick = () => { wrap.style.display = 'block'; };
    box.querySelector('.code-edit-cancel').onclick = () => { wrap.style.display = 'none'; };
    box.querySelector('.code-edit-submit').onclick = async () => {
      const newContent = wrap.querySelector('textarea').value;
      // 提交整组文件：只替换被编辑的那个，其余保持原样（后端 update 整组 → 新版本）。
      const files = art.files.map(f => f.path === path ? { path, content: newContent, language: f.language } : { path: f.path, content: null, language: f.language });
      try {
        const r2 = await API.j('POST', `/api/executions/${EX.id}/artifacts/code-edit`, { nodeId, files, comment: `人工编辑 ${path}` });
        statusLine(`已提交为新 code 版本 v${r2.newVersion}`, 'ok');
        wrap.style.display = 'none';
        pollState();
      } catch (err) { statusLine(`提交失败：${err.message}`, 'err'); }
    };
  } catch (err) {
    box.innerHTML = `<div class="ins-empty">读取失败：${escX(err.message)}</div>`;
  }
});

function artifactKind(a) { return a.kind || (a.type === 'markdown' ? 'markdown' : a.type === 'json' ? 'json' : 'text'); }
function renderArtifactViewer(a, state) {
  const kind = artifactKind(a);
  const v = ARTIFACT_VIEWERS[kind] || ARTIFACT_VIEWERS.text;
  const storage = a.storage === 'reference' ? '· 引用存储' : '';
  return `<div style="font-size:11px;color:var(--fg-dim);margin:4px 0 2px">${v.icon} ${v.label} · v${a.version} · ${a.createdBy === 'human' ? '人工' : 'Agent'} ${storage}</div>${v.render(a, state)}`;
}

const EX = {
  id: null,            // executionId
  state: null,         // ExecutionState
  def: null,           // WorkflowDefinition（按 workflowId 单独加载）
  es: null,
  timer: null,
  tab: 'review',
  selNode: null,
  events: [],
  view: { x: 0, y: 0, k: 1 },
};

const $x = (id) => document.getElementById(id);
const escX = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const STATUS_LABEL = {
  created: '已创建', running: '运行中', paused: '已暂停',
  waiting_review: '等待人工审核', waiting_human: '等待人工任务', completed: '已完成',
  failed: '失败', terminated: '已终止', error: '错误',
};

const NODE_STATUS_COLOR = {
  idle: '#555c6d', queued: '#4f8cff', running: '#4f8cff',
  waiting_review: '#f39c12', waiting_human: '#5bc0de', success: '#3ecf8e', failed: '#ff6b6b',
  skipped: '#8a90a0', cancelled: '#8a90a0',
};

// ---------- 打开/关闭 ----------
$x('btn-run').onclick = () => {
  renderRunSchemaForm();   // 任务 5：按当前定义动态渲染启动表单
  $x('run-dialog').classList.add('open');
};
$x('run-cancel').onclick = () => $x('run-dialog').classList.remove('open');
$x('run-go').onclick = async () => {
  const id = $x('wf-id').value.trim();
  if (!id || !S.def) { statusLine('请先填写工作流并构建节点', 'err'); return; }
  // 收集并本地校验字段（后端也会校验，这里先拦住省一次请求）
  let fields = {};
  try {
    fields = collectRunFields();
  } catch (err) {
    statusLine(`启动参数有误：${err.message}`, 'err');
    return;
  }
  $x('run-dialog').classList.remove('open');
  const input = $x('run-input').value.trim() || 'GO';
  try {
    // 运行前先保存（确保后端是最新定义）
    await API.j('POST', '/api/workflows', { ...S.def, id, updatedAt: new Date().toISOString() });
    const r = await API.j('POST', `/api/workflows/${id}/run`, { input, fields });
    openExecPanel(r.executionId);
    statusLine(`已启动 ${r.executionId}`, 'ok');
    loadWorkflowList();
  } catch (err) {
    statusLine(`启动失败：${err.message}`, 'err');
  }
};

// ---- 启动表单：按 inputSchema 动态渲染（任务 5）----
const FIELD_TYPE_LABEL = {
  text: '文本', number: '数字', boolean: '开关', select: '下拉选择',
  file: '文件路径', files: '多文件路径', directory: '目录路径', json: 'JSON', artifact: 'Artifact ID',
};
function renderRunSchemaForm() {
  const wrap = $x('run-schema-fields');
  const box = $x('run-fields');
  const fields = S.def?.inputSchema?.fields ?? [];
  if (!fields.length) { wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  box.innerHTML = fields.map(f => {
    const label = `${f.label || f.name}${f.required ? ' *' : ''}`;
    const ph = f.placeholder || '';
    let ctrl;
    if (f.type === 'select') {
      ctrl = `<select data-fname="${f.name}" data-ftype="select">${(f.options || []).map(o => `<option>${o}</option>`).join('') || '<option value="">（无选项）</option>'}</select>`;
    } else if (f.type === 'boolean') {
      ctrl = `<select data-fname="${f.name}" data-ftype="boolean"><option value="true">true</option><option value="false">false</option></select>`;
    } else if (f.type === 'json') {
      ctrl = `<textarea data-fname="${f.name}" data-ftype="json" rows="3" placeholder="{\"key\":\"value\"}">${ph}</textarea>`;
    } else if (f.type === 'files') {
      ctrl = `<input type="text" data-fname="${f.name}" data-ftype="files" placeholder="路径用逗号分隔，如 D:/a.txt, D:/b.txt">`;
    } else {
      ctrl = `<input type="text" data-fname="${f.name}" data-ftype="${f.type}" placeholder="${FIELD_TYPE_LABEL[f.type] || f.type}${ph ? ' · ' + ph : ''}">`;
    }
    return `<label class="field">${label} <span style="opacity:.6;font-size:11px">（${FIELD_TYPE_LABEL[f.type] || f.type}）</span></label>${ctrl}`;
  }).join('');
}
function collectRunFields() {
  const out = {};
  document.querySelectorAll('#run-fields [data-fname]').forEach(el => {
    const name = el.dataset.fname, type = el.dataset.ftype;
    const raw = el.value;
    if (raw === '' || raw === undefined) return;
    switch (type) {
      case 'number': {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new Error(`字段 ${name} 需要数字`);
        out[name] = n; break;
      }
      case 'boolean': out[name] = raw === 'true'; break;
      case 'files': out[name] = raw.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'json': {
        try { out[name] = raw; JSON.parse(raw); } catch { throw new Error(`字段 ${name} 不是合法 JSON`); }
        break;
      }
      default: out[name] = raw;
    }
  });
  return out;
}

function openExecPanel(executionId) {
  EX.id = executionId;
  EX.state = null;
  EX.def = null;
  EX.events = [];
  EX.thinkingText = {};  // 节点流式输出缓存（nodeId → 当前累积文本）
  EX._outputTextLen = {};  // 输出 <pre> 文本长度缓存（用于判断是否新增内容）
  EX._outputScroll = {};  // 输出 <pre> 滚动位置缓存（重建前捕获，重建后恢复）
  EX.selNode = null;
  EX.layout = null;
  EX.layoutKey = null;
  EX.view = { x: 0, y: 0, k: 1 };
  $x('exec-id').textContent = executionId;
  // 切换到执行模式（非全屏覆盖）
  if (typeof switchToExecuteMode === 'function') switchToExecuteMode();
  $x('exec-view').classList.add('open');
  // 保存最后执行 ID 到 localStorage（页面重载后恢复）
  localStorage.setItem('wf_last_exec', executionId);
  // Phase F（§27/§28）：打开即显示 Loading 骨架，隐藏错误
  const ld = $x('exec-loading'); if (ld) ld.style.display = 'flex';
  const er = $x('exec-error'); if (er) er.style.display = 'none';
  connectSse();
  startPolling();
}

$x('exec-close').onclick = () => {
  if (typeof switchToEditMode === 'function') switchToEditMode();
  $x('exec-view').classList.remove('open');
  stopPolling();
  disconnectSse();
};

// ---------- SSE（实时事件日志） ----------
function connectSse() {
  disconnectSse();
  EX.es = new EventSource('/api/events');
  EX.es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.executionId !== EX.id) return;
      EX.events.push(data);
      if (EX.events.length > 600) EX.events.shift();
      if (['node.started', 'node.completed', 'node.failed', 'node.skipped',
        'workflow.completed', 'workflow.failed', 'workflow.terminated',
        'execution.paused', 'execution.resumed',
        'review.requested', 'human_task.requested', 'human_task.completed'].includes(data.type)) {
        // 节点完成/失败后清除流式缓存
        if (['node.completed', 'node.failed', 'node.skipped'].includes(data.type) && data.nodeId) {
          delete EX.thinkingText[data.nodeId];
        }
        pollState();
      }
      // §16：实时流式输出——收到 delta 立即更新节点文本，不等待 pollState
      if (data.type === 'node.thinking' && data.nodeId) {
        const prev = EX.thinkingText[data.nodeId] || '';
        EX.thinkingText[data.nodeId] = prev + (data.payload?.delta || '');
        renderExecStatus();  // 增量渲染 SVG
        if (EX.tab === 'output' && EX.selNode === data.nodeId) renderOutput();
      }
      if (EX.tab === 'log') renderLog();
    } catch (_) { /* ignore */ }
  };
}
function disconnectSse() { if (EX.es) { EX.es.close(); EX.es = null; } }

// ---------- 轮询状态 ----------
function startPolling() { stopPolling(); pollState(); EX.timer = setInterval(pollState, 1500); }
function stopPolling() { if (EX.timer) { clearInterval(EX.timer); EX.timer = null; } }

async function pollState() {
  if (!EX.id) return;
  EX._errCount = (EX._errCount || 0);
  try {
    const r = await fetch(`/api/executions/${EX.id}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    EX._errCount = 0;
    const er = $x('exec-error'); if (er) er.style.display = 'none';
    EX.state = await r.json();
    // Phase 8（34）：工作目录继承状态展示
    $x('exec-wd').textContent = EX.state.workingDirectory || '';
    $x('exec-wd').style.display = EX.state.workingDirectory ? '' : 'none';
    // Phase A（§5/§23）：历史 Execution 永远显示启动时绑定的 def 快照（workflow 改版不影响审计）
    if (!EX.def && EX.state.workflowId) {
      if (EX.state.defSnapshot) {
        EX.def = EX.state.defSnapshot;
      } else {
        fetch(`/api/workflows/${EX.state.workflowId}`).then(async r2 => {
          if (r2.ok) EX.def = await r2.json();
        }).catch(() => {});
      }
    }
    renderExec();
    // 终态停止轮询
    if (['completed', 'failed', 'terminated', 'error'].includes(EX.state.status)) stopPolling();
  } catch (err) {
    // Phase F（§28）：连续失败才提示错误，避免网络抖动闪烁
    EX._errCount++;
    if (EX._errCount >= 2) {
      const ld = $x('exec-loading'); if (ld) ld.style.display = 'none';
      const er = $x('exec-error');
      if (er) {
        er.style.display = 'flex';
        const m = $x('exec-error-msg');
        if (m) m.textContent = `拉取执行状态失败（${err.message || '网络异常'}）。可点击重试，或稍后手动刷新。`;
      }
    }
  }
}

// ---------- 控制 ----------
async function control(cmd) {
  try {
    await API.j('POST', `/api/executions/${EX.id}/control`, { cmd });
    statusLine(`已发送 ${cmd}`, 'ok');
    if (EX.state && ['completed', 'failed', 'terminated', 'error'].includes(EX.state.status)) startPolling();
    pollState();
  } catch (err) { statusLine(`控制失败：${err.message}`, 'err'); }
}
$x('ctl-pause').onclick = () => control('pause');
$x('ctl-resume').onclick = () => control('resume');
$x('ctl-step').onclick = () => control('step');
$x('ctl-stop').onclick = () => control('stop');

// ---------- 侧栏 tab ----------
document.querySelectorAll('#exec-side-tabs button').forEach(b => {
  b.onclick = () => {
    EX.tab = b.dataset.tab;
    document.querySelectorAll('#exec-side-tabs button').forEach(x => x.classList.toggle('active', x === b));
    renderSide();
  };
});

// LOADING_UX L6 v2：按钮级局部 Loading（exec 作用域）—— 文字透明 + spinner 绝对居中覆盖，宽度不变
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
async function runBtnBusy(btn, task, busyLabel) {
  setBtnBusy(btn, true, busyLabel);
  try { return await task(); } finally { setBtnBusy(btn, false); }
}

// ---------- 主渲染 ----------
// 控制按钮按执行状态禁用（需求 5）：终态全禁；pause 仅运行态；resume/step 仅暂停态。
const TERMINAL_STATUSES = ['completed', 'failed', 'terminated', 'error', 'cancelled'];
function updateControlButtons(status) {
  const terminal = TERMINAL_STATUSES.includes(status);
  const paused = status === 'paused';
  const running = !terminal && !paused;
  const set = (id, disabled, title) => {
    const b = $x(id);
    if (!b) return;
    b.disabled = disabled;
    b.title = title || '';
  };
  set('ctl-pause', !running, running ? '暂停执行' : '仅运行中可用');
  set('ctl-resume', !paused, paused ? '继续执行' : '仅暂停时可用');
  set('ctl-step', !paused, paused ? '单步执行一个节点' : '仅暂停时可用');
  set('ctl-stop', terminal, terminal ? '已结束' : '终止执行');
}

function renderExec() {
  const st = EX.state;
  if (!st) return;
  // Phase F（§28）：首帧就绪后隐藏 Loading 骨架
  const ld = $x('exec-loading'); if (ld && ld.style.display !== 'none') ld.style.display = 'none';
  const pill = $x('exec-status');
  pill.textContent = `${STATUS_LABEL[st.status] || st.status} · step ${st.stepCount}`;
  pill.className = `status-pill st-${st.status}`;
  updateControlButtons(st.status);
  // 环收敛提示（§69）：人工 accept 后环被冻结，在状态栏可见化，避免用户误以为还在迭代。
  const converged = Object.keys(st.convergedLoops || {}).filter(k => st.convergedLoops[k]);
  const iterBadge = document.getElementById('exec-iter-badge');
  if (iterBadge) {
    if (converged.length) {
      iterBadge.textContent = `◉ 环已收敛冻结：${converged.join(', ')}`;
      iterBadge.style.display = 'inline-block';
    } else if (Object.keys(st.loopCount || {}).length) {
      const parts = Object.entries(st.loopCount).map(([k, v]) => `${k}:${v}`);
      iterBadge.textContent = `↻ 环迭代 ${parts.join(' ')}`;
      iterBadge.style.display = 'inline-block';
    } else {
      iterBadge.style.display = 'none';
    }
  }
  // Review 主动通知（§8：waiting_review 时醒目提示“需要你做决定”），点击跳转审核 tab
  const rvNotice = document.getElementById('exec-review-notice');
  const rvPending = (st.reviewTasks || []).filter(t => t.status === 'pending');
  if (rvNotice) {
    if (rvPending.length) {
      rvNotice.textContent = `⚖ 待审核（${rvPending.length}）`;
      rvNotice.style.display = 'inline-block';
      rvNotice.onclick = () => {
        EX.tab = 'review';
        document.querySelectorAll('#exec-side-tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === 'review'));
        renderSide();
      };
    } else {
      rvNotice.style.display = 'none';
    }
  }
  renderExecCanvas();
  renderExecTimeline();
  renderSide();
}

/**
 * 执行画布渲染（任务 1 / §55 重构）：
 *  - 布局层与执行层解耦：调用 computeLayout 得到纯 UI 坐标，
 *    不读也不写 Definition.position，不影响执行（环不强行拆成 DAG）；
 *  - 节点卡只显示摘要：Name / Identity / 状态（图标+文字双通道）/ Run·Loop 分式；
 *  - 回边以弧线绘制并标注 ↺，环路径一目了然；
 *  - 颜色全部走 CSS 变量，Dark/Light 双主题均满足对比度。
 */
function renderExecCanvas() {
  const svg = $x('exec-canvas');
  const st = EX.state, def = EX.def;
  if (!st) return;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  svg.innerHTML = '';
  if (!def) {
    const t = mk('text', { x: 20, y: 30, fill: cssVar('--fg-dim'), 'font-size': 13 });
    t.textContent = '加载工作流定义中…';
    svg.appendChild(t);
    return;
  }

  // ---- 布局（结构变化才重算；结果不入 Definition，§55）----
  const structKey = def.id + '|' + def.nodes.map(n => n.id).join(',') + '|' + (def.edges || []).map(e => e.source.nodeId + '>' + e.target.nodeId).join(',');
  if (!EX.layout || EX.layoutKey !== structKey) {
    EX.layout = computeLayout(def, { nodeW: XNODE_W, nodeH: XNODE_H });
    EX.layoutKey = structKey;
    fitExecView();   // 布局确定后自动适配视图（首次）
  }
  const { positions, backEdgeIds } = EX.layout;

  const g = mk('g', { transform: `translate(${EX.view.x},${EX.view.y}) scale(${EX.view.k})` });
  svg.appendChild(g);

  // 箭头 marker
  const defs = mk('defs');
  const marker = mk('marker', { id: 'xarrow', markerWidth: 10, markerHeight: 8, refX: 8, refY: 4, orient: 'auto' });
  marker.appendChild(mk('path', { d: 'M0,0 L8,4 L0,8 Z', class: 'xedge-arrow' }));
  defs.appendChild(marker);
  g.appendChild(defs);

  // ---- edges：前向边走右侧→左侧，回边走底部弧线 ----
  for (const e of def.edges) {
    const sp = positions.get(e.source.nodeId), tp = positions.get(e.target.nodeId);
    if (!sp || !tp) continue;
    const es = st.edgeState?.[e.id];
    const blocked = es && !es.passable;
    const isBack = backEdgeIds.has(e.id);
    const cls = ['xedge', e.review?.enabled ? 'review' : '', blocked ? 'blocked' : '', isBack ? 'back' : ''].filter(Boolean).join(' ');
    let d, badgePos;
    if (isBack) {
      // 回边：源节点底中 → 目标节点底中，下探弧线（偏移随距离增大，多条回边错开）
      const x1 = sp.x + XNODE_W / 2, y1 = sp.y + XNODE_H;
      const x2 = tp.x + XNODE_W / 2, y2 = tp.y + XNODE_H;
      const drop = 34 + Math.abs(x2 - x1) * 0.12;
      d = `M ${x1} ${y1} C ${x1} ${y1 + drop}, ${x2} ${y2 + drop}, ${x2} ${y2 + 6}`;
      badgePos = { x: (x1 + x2) / 2, y: Math.max(y1, y2) + drop * 0.72 };
    } else {
      const x1 = sp.x + XNODE_W, y1 = sp.y + XNODE_H / 2;
      const x2 = tp.x, y2 = tp.y + XNODE_H / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2);
      d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 2} ${y2}`;
      badgePos = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8 };
    }
    const path = mk('path', { d, class: cls, 'marker-end': isBack ? '' : 'url(#xarrow)' });
    g.appendChild(path);
    if (e.review?.enabled || isBack) {
      const badge = mk('text', { x: badgePos.x, y: badgePos.y, class: 'xedge-badge', 'text-anchor': 'middle' });
      badge.textContent = isBack ? '↺ 环' : (blocked ? '⚖ BLOCKED' : '⚖ REVIEW');
      if (blocked) badge.setAttribute('fill', cssVar('--st-err'));
      if (isBack) badge.setAttribute('fill', cssVar('--accent2'));
      g.appendChild(badge);
    }
  }

  // ---- nodes：摘要卡片（Name / Identity / 状态双通道 / Run·Loop 分式）----
  for (const n of def.nodes) {
    const pos = positions.get(n.id);
    if (!pos) continue;
    const ns = st.nodeStates[n.id] || { status: 'idle', iteration: 0 };
    const meta = NODE_STATUS_META[ns.status] || NODE_STATUS_META.idle;
    const color = cssVar(meta.v) || '#8a90a0';
    const ng = mk('g', {
      transform: `translate(${pos.x},${pos.y})`,
      class: `xnode ${n.type === 'start' || n.type === 'end' ? n.type : ''} ${EX.selNode === n.id ? 'selected' : ''}`,
    });
    ng.setAttribute('data-node', n.id);
    ng.appendChild(mk('rect', { class: 'xnode-body', width: XNODE_W, height: XNODE_H, rx: 9, style: `stroke:${color};stroke-width:1.8` }));

    // 行 1：类型图标 + 节点名（截断）
    const typeIcon = n.type === 'start' ? '▶' : n.type === 'end' ? '■' : n.type === 'human_task' ? '👤' : '🤖';
    const name = mk('text', { class: 'xnode-name', x: 12, y: 22 });
    name.textContent = `${typeIcon} ${trunc(n.name || n.id, 18)}`;
    ng.appendChild(name);

    // 行 2：Identity（只有摘要）
    const identity = mk('text', { class: 'xnode-identity', x: 12, y: 38 });
    identity.textContent = trunc(n.identity?.name || n.roleDescription || '—', 26);
    ng.appendChild(identity);

    // 行 3：状态双通道（图标 + 文字）
    const statusLine = mk('text', { class: 'xnode-status', x: 12, y: 58, fill: color });
    statusLine.textContent = `${meta.icon} ${meta.text}`;
    ng.appendChild(statusLine);

    // 行 4：流式输出内容（§16：实时显示 DSH delta，节点完成/失败后清空）
    const thinkText = EX.thinkingText?.[n.id] || '';
    if (thinkText && ns.status === 'running') {
      const stream = mk('text', { class: 'xnode-stream', x: 12, y: 96 });
      // 流式显示裁剪：节点宽 200px，9.5px 字号下约可容纳 ~22 字符，超长截断 + textLength 强制不溢出容器
      const display = thinkText.length > 26 ? '…' + thinkText.slice(-25) : thinkText;
      stream.textContent = display.replace(/\n/g, ' ').slice(0, 26);
      stream.setAttribute('textLength', XNODE_W - 24);
      stream.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      ng.appendChild(stream);
    }
    // 行 5：Run / Loop 分式摘要（如 run 2/5 · iter 2/3）
    const runs = st.nodeRunCount?.[n.id] ?? 0;
    const maxRuns = n.runtimeConfig?.maxRuns;
    const parts = [];
    if (n.type === 'agent' || n.type === 'human_task') {
      parts.push(maxRuns ? `run ${runs}/${maxRuns}` : `run ${runs}`);
    }
    const loop = (def.loops || []).find(l => (l.nodeIds || []).includes(n.id));
    if (loop) {
      const iter = st.loopCount?.[loop.loopId] ?? ns.iteration ?? 0;
      parts.push(`iter ${iter}/${loop.maxIterations}`);
      if (st.convergedLoops?.[loop.loopId]) parts.push('◉已收敛');
    }
    if (parts.length) {
      const counter = mk('text', { class: 'xnode-counter', x: 12, y: thinkText ? 112 : 76 });
      counter.textContent = parts.join(' · ');
      ng.appendChild(counter);
    }

    // 运行中呼吸动画（图标层）
    if (ns.status === 'running') {
      const pulse = mk('circle', { cx: XNODE_W - 16, cy: 18, r: 4, fill: 'none', stroke: color, 'stroke-width': 2 });
      pulse.appendChild(mk('animate', { attributeName: 'r', from: 4, to: 11, dur: '1.1s', repeatCount: 'indefinite' }));
      pulse.appendChild(mk('animate', { attributeName: 'opacity', from: 1, to: 0, dur: '1.1s', repeatCount: 'indefinite' }));
      ng.appendChild(pulse);
    }
    ng.appendChild(mk('circle', { cx: XNODE_W - 16, cy: 18, r: 4, fill: color }));

    ng.addEventListener('click', () => {
      EX.selNode = n.id; EX.tab = 'node';
      document.querySelectorAll('#exec-side-tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === 'node'));
      renderExec();
    });
    g.appendChild(ng);
  }
}

// 文本截断（节点卡片只显示摘要，避免长文本破坑）
function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------- Phase E：Execution Timeline（§8/§9：左侧进度列，点击 → Graph 定位 + Inspector 详情） ----------
function renderExecTimeline() {
  const body = $x('exec-timeline-body');
  const st = EX.state, def = EX.def;
  if (!st || !def) { if (body) body.innerHTML = '<div class="tl-empty">加载中…</div>'; return; }
  const rows = def.nodes.map(n => {
    const ns = st.nodeStates[n.id] || { status: 'idle' };
    const meta = NODE_STATUS_META[ns.status] || NODE_STATUS_META.idle;
    const color = cssVar(meta.v) || '#8a90a0';
    const icon = n.type === 'start' ? '▶' : n.type === 'end' ? '■' : n.type === 'human_task' ? '👤' : '🤖';
    return { id: n.id, name: n.name || n.id, icon, status: ns.status, text: meta.text, color };
  });
  body.innerHTML = rows.map(r => `
    <div class="tl-item ${EX.selNode === r.id ? 'selected' : ''}" data-tlnode="${escX(r.id)}">
      <span class="tl-ico" style="color:${r.color}">${r.icon}</span>
      <span class="tl-name">${escX(r.name)}</span>
      <span class="tl-state" style="color:${r.color}">${escX(r.text)}</span>
    </div>`).join('') || '<div class="tl-empty">无节点</div>';
  body.querySelectorAll('[data-tlnode]').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.tlnode;
      EX.selNode = id;
      EX.tab = 'node';
      document.querySelectorAll('#exec-side-tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === 'node'));
      focusExecNode(id);
      renderExec();
    });
  });
}

/** Phase E：Graph 定位到指定节点（保持缩放，平移使节点居中） */
function focusExecNode(nodeId) {
  if (!EX.layout) return;
  const pos = EX.layout.positions.get(nodeId);
  if (!pos) return;
  const svg = $x('exec-canvas');
  const cx = pos.x + XNODE_W / 2, cy = pos.y + XNODE_H / 2;
  EX.view.x = svg.clientWidth / 2 - cx * EX.view.k;
  EX.view.y = svg.clientHeight / 2 - cy * EX.view.k;
  renderExecCanvas();
}

// 视图自适应：布局宽高 → 等比缩放到画布
function fitExecView() {
  const svg = $x('exec-canvas');
  if (!EX.layout || !svg.clientWidth) return;
  const { width, height } = EX.layout;
  const k = Math.min((svg.clientWidth - 24) / Math.max(width, 1), (svg.clientHeight - 24) / Math.max(height, 1), 1.4);
  EX.view.k = Math.max(0.25, k);
  EX.view.x = Math.max(12, (svg.clientWidth - width * EX.view.k) / 2);
  EX.view.y = Math.max(12, (svg.clientHeight - height * EX.view.k) / 2);
}

// “自动布局”按钮：强制重算并适配视图（§55：不回写 Definition）
$x('btn-autolayout').onclick = () => {
  EX.layout = null;
  EX.layoutKey = null;
  if (EX.def) renderExecCanvas();
};

// 主题切换（Dark/Light 双主题，任务 1）
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('dsh-wf-theme', t); } catch (_) {}
  renderExecCanvas();
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}
$x('btn-theme').onclick = toggleTheme;
$x('btn-theme-2').onclick = toggleTheme;
try { const saved = localStorage.getItem('dsh-wf-theme'); if (saved) document.documentElement.setAttribute('data-theme', saved); } catch (_) {}

function renderSide() {
  const body = $x('exec-side-body');
  const st = EX.state;
  if (!st) { body.innerHTML = '<div class="ins-empty">等待状态…</div>'; return; }
  // UX 修复：用户正在审核/人工任务输入框中打字时，轮询不得重建面板（会销毁焦点与已输入内容）
  const ae = document.activeElement;
  if (EX.tab === 'review' && ae && body.contains(ae)
      && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
    return;
  }
  // 非焦点重建时保留草稿（状态刷新后回填）
  EX.reviewDrafts = EX.reviewDrafts || {};
  body.querySelectorAll('textarea[id]').forEach(t => { if (t.value) EX.reviewDrafts[t.id] = t.value; });
  if (EX.tab === 'review') { renderReviewTab(body, st); return renderHumanTab(body, st); }
  if (EX.tab === 'node') return renderNodeTab(body, st);
  if (EX.tab === 'audit') return renderAuditTab(body, st);
  if (EX.tab === 'output') return renderOutput();
  if (EX.tab === 'log') return renderLog();
}

// ---- 审核 tab（§58-73） ----
function renderReviewTab(body, st) {
  const pending = st.reviewTasks.filter(t => t.status === 'pending');
  const done = st.reviewTasks.filter(t => t.status !== 'pending');
  let html = '';
  // 批量操作（任务 5 MVP：Accept All / Reject All）
  if (pending.length > 1) {
    html += `<div class="review-actions" style="margin-bottom:10px">
      <button class="primary" data-rvall="accept">✓ 全部通过（${pending.length}）</button>
      <button class="danger" data-rvall="reject">✗ 全部退回（需统一意见）</button>
    </div>`;
  }
  if (!pending.length) html += '<div class="ins-empty">当前无待审任务</div>';

  for (const t of pending) {
    // 任务 5：审核对象 = Artifact 集合（退化兼容：无集合时取主 artifact）
    const chain = st.artifacts[t.sourceNodeId] ?? [];
    const ids = (t.artifactIds && t.artifactIds.length) ? t.artifactIds : [t.artifactId];
    const artifacts = ids.map(id => chain.find(a => a.id === id)).filter(Boolean);
    const primary = artifacts.at(-1) || chain.find(a => a.id === t.artifactId);
    const edge = EX.def?.edges.find(e => e.id === t.edgeId);
    const rv = edge?.review;
    const allowed = rv?.allowedActions ?? ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'];
    const label = { accept: '✓ 通过', reject: '✗ 退回', edit: '✎ 编辑', accept_after_edit: '✓ 编辑后通过', terminate: '⏹ 终止' };
    html += `<div class="review-card">
      <h4>⚖ ${t.sourceNodeId} → ${(t.targetNodeIds || []).join(', ') || edge?.target?.nodeId || '?'}（${rv?.mode ?? 'required'}）· ${artifacts.length} 个 Artifact</h4>
      <div style="font-size:11px;color:var(--fg-dim)">任务 ${t.id} · ${new Date(t.createdAt).toLocaleTimeString()}${t.timeoutAt ? ` · 超时 ${new Date(t.timeoutAt).toLocaleTimeString()}` : ''}</div>
      ${artifacts.map(a => `<details ${a === primary ? 'open' : ''}><summary style="cursor:pointer;font-size:11px;color:var(--fg-dim)">${ARTIFACT_VIEWERS[artifactKind(a)]?.icon ?? '📄'} ${a.id} · v${a.version} · ${a.createdBy === 'human' ? '人工' : 'Agent'}${a === primary ? '（主）' : ''}</summary><div class="review-artifact">${renderArtifactViewer(a, st)}</div></details>`).join('')}
      <div class="review-artifact" style="display:none" id="rv-primary-${t.id}">${escX(primary?.content ?? '（无内容）')}</div>
      <textarea id="rv-comment-${t.id}" rows="2" placeholder="审核意见（reject 必填）" style="width:100%"></textarea>
      <div style="display:none" id="rv-editwrap-${t.id}">
        <label class="field">编辑后内容（原始输出将保留为 v${primary?.version ?? 1}，编辑存为新版本）</label>
        <textarea id="rv-content-${t.id}" rows="6" style="width:100%">${escX(primary?.content ?? '')}</textarea>
      </div>
      <div class="review-actions">
        ${allowed.map(a => `<button data-rv="${a}" data-task="${t.id}" class="${a === 'terminate' ? 'danger' : (a === 'accept' || a === 'accept_after_edit') ? 'primary' : ''}">${label[a] || a}</button>`).join('')}
      </div>
    </div>`;
  }

  if (done.length) {
    html += '<h4 style="margin-top:16px;color:var(--fg-dim)">已处理</h4>' + done.map(t =>
      `<div class="audit-row">${t.sourceNodeId} → ${(t.targetNodeIds || []).join(',')}：<b>${t.status}</b>${t.comment ? ` · ${escX(t.comment)}` : ''}</div>`).join('');
  }
  body.innerHTML = html;
  // 回填草稿（审核意见不因轮询丢失）
  body.querySelectorAll('textarea[id]').forEach(t => {
    const d = EX.reviewDrafts[t.id];
    if (d != null && !t.value) t.value = d;
  });

  // 批量决策（任务 5 MVP）
  body.querySelectorAll('[data-rvall]').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.rvall;
      let comment = null;
      if (action === 'reject') {
        comment = prompt('统一退回意见（必填，将随每个任务下发）：');
        if (!comment) return;
      }
      runBtnBusy(btn, async () => {
        try {
          const r = await API.j('POST', `/api/executions/${EX.id}/review-all`, { action, comment });
          statusLine(`已批量 ${action} ${r.processed} 个任务`, 'ok');
          pollState();
        } catch (err) { statusLine(`批量操作失败：${err.message}`, 'err'); }
      }, '处理中…');
    };
  });

  body.querySelectorAll('[data-rv]').forEach(btn => {
    btn.onclick = async () => {
      const taskId = btn.dataset.task;
      const action = btn.dataset.rv;
      const comment = body.querySelector(`#rv-comment-${taskId}`)?.value || null;
      const content = body.querySelector(`#rv-content-${taskId}`)?.value;
      runBtnBusy(btn, async () => {
        try {
          await API.j('POST', `/api/executions/${EX.id}/review`, { taskId, action, comment, content });
          statusLine(`审核 ${action} 已提交`, 'ok');
          pollState();
        } catch (err) { statusLine(`审核失败：${err.message}`, 'err'); }
      }, '提交中…');
    };
  });
  body.querySelectorAll('[data-rv="edit"]').forEach(btn => {
    btn.onclick = () => {
      const wrap = body.querySelector(`#rv-editwrap-${btn.dataset.task}`);
      if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
    };
  });
}

// ---- Human Task（Phase 11，§67）：追加在审核 tab 下方，统一呈现“需要人工处理”的事项 ----
function renderHumanTab(body, st) {
  const tasks = st.humanTasks || [];
  if (!tasks.length) return;
  // 同审核 tab：输入中不重建；重建时回填草稿
  const _ae = document.activeElement;
  if (_ae && body.contains(_ae) && (_ae.tagName === 'TEXTAREA' || _ae.tagName === 'INPUT')) return;
  const _drafts = {};
  body.querySelectorAll('textarea[id]').forEach(t => { if (t.value) _drafts[t.id] = t.value; });
  const pending = tasks.filter(t => t.status === 'pending');
  const done = tasks.filter(t => t.status !== 'pending');

  let html = '';
  for (const t of pending) {
    html += `<div class="human-card">
      <h4>👤 人工任务 · 节点 ${escX(t.nodeId)}</h4>
      <div style="font-size:11px;color:var(--fg-dim)">${t.id} · 创建于 ${new Date(t.createdAt).toLocaleTimeString()}</div>
      <div class="review-artifact">${escX(t.prompt)}</div>
      <textarea id="ht-content-${t.id}" rows="5" placeholder="请输入结果内容（必填：人工产出不伪装成 Agent Run）" style="width:100%"></textarea>
      <label class="field">备注（可选）</label>
      <input type="text" id="ht-note-${t.id}" placeholder="如：负责人/签字" style="width:100%">
      <div class="review-actions">
        <button class="primary" data-ht="${t.id}">✓ 提交结果</button>
      </div>
    </div>`;
  }
  if (done.length) {
    html += '<h4 style="margin-top:12px;color:var(--fg-dim)">已完成的人工任务</h4>' + done.map(t =>
      `<div class="audit-row">节点 ${escX(t.nodeId)}：<b>${t.status}</b> · ${new Date(t.resolvedAt || t.createdAt).toLocaleTimeString()}${t.note ? ` · ${escX(t.note)}` : ''}</div>`).join('');
  }
  body.insertAdjacentHTML('beforeend', html);
  body.querySelectorAll('textarea[id]').forEach(t => {
    const d = _drafts[t.id];
    if (d != null && !t.value) t.value = d;
  });

  body.querySelectorAll('[data-ht]').forEach(btn => {
    btn.onclick = async () => {
      const taskId = btn.dataset.ht;
      const content = body.querySelector(`#ht-content-${taskId}`)?.value ?? '';
      const note = body.querySelector(`#ht-note-${taskId}`)?.value || undefined;
      try {
        await API.j('POST', `/api/executions/${EX.id}/human-task`, { taskId, content, note });
        statusLine('人工任务已提交', 'ok');
        pollState();
      } catch (err) { statusLine(`提交失败：${err.message}`, 'err'); }
    };
  });
}

// ---------- Phase E：Contextual Action（§10/§24：状态驱动，就近呈现，不堆顶部） ----------
function renderContextualActions(st, nodeId) {
  const ns = st.nodeStates?.[nodeId];
  if (!ns) return '';
  let html = '';
  // 等待人工审核 → Review 决策（§10：仅 Waiting for Review 出现）
  if (ns.status === 'waiting_review') {
    const tasks = (st.reviewTasks || []).filter(t => t.sourceNodeId === nodeId && t.status === 'pending');
    if (tasks.length) {
      const edge = EX.def?.edges.find(e => e.id === tasks[0].edgeId);
      const rv = edge?.review;
      const allowed = rv?.allowedActions ?? ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'];
      const label = { accept: '✓ 通过', reject: '✗ 退回', edit: '✎ 编辑', accept_after_edit: '✓ 编辑后通过', terminate: '⏹ 终止' };
      html += `<div class="review-card" style="border-color:var(--hitl);margin-bottom:10px">
        <h4 style="color:var(--hitl)">⚖ Review Required · ${escX(nodeId)}</h4>
        <div style="font-size:11px;color:var(--fg-dim);margin-bottom:6px">等待人工审核（${tasks.length} 个待处理任务）</div>
        ${tasks.map(t => {
          const chain = st.artifacts[nodeId] ?? [];
          const ids = (t.artifactIds && t.artifactIds.length) ? t.artifactIds : [t.artifactId];
          const arts = ids.map(id => chain.find(a => a.id === id)).filter(Boolean);
          const primary = arts.at(-1) || chain.find(a => a.id === t.artifactId);
          return `
            <div style="border-top:1px dashed var(--line);padding-top:6px;margin-top:6px">
              <div style="font-size:11px;color:var(--fg-dim)">任务 ${t.id} · ${new Date(t.createdAt).toLocaleTimeString()}</div>
              ${primary ? `<div class="review-artifact" style="max-height:90px;overflow:auto">${escX((primary.content || '').slice(0, 200))}${(primary.content || '').length > 200 ? '…' : ''}</div>` : ''}
              <textarea id="ca-comment-${t.id}" rows="2" placeholder="审核意见（reject 必填）" style="width:100%;margin-top:4px"></textarea>
              <div class="review-actions" style="margin-top:6px">
                ${allowed.map(a => `<button data-carv="${a}" data-catask="${t.id}" class="${a === 'terminate' ? 'danger' : (a === 'accept' || a === 'accept_after_edit') ? 'primary' : ''}">${label[a] || a}</button>`).join('')}
              </div>
            </div>`;
        }).join('')}
      </div>`;
    }
  }
  // 等待人工任务 → 就地提交（§11）
  if (ns.status === 'waiting_human') {
    const tasks = (st.humanTasks || []).filter(t => t.nodeId === nodeId && t.status === 'pending');
    if (tasks.length) {
      html += `<div class="human-card" style="margin-bottom:10px">
        <h4>👤 人工任务 · 节点 ${escX(nodeId)}</h4>
        ${tasks.map(t => `
          <div style="font-size:11px;color:var(--fg-dim)">任务 ${t.id} · ${new Date(t.createdAt).toLocaleTimeString()}</div>
          <div class="review-artifact" style="max-height:90px;overflow:auto">${escX(t.prompt)}</div>
          <textarea id="ca-ht-${t.id}" rows="4" placeholder="请输入结果内容（必填：人工产出不伪装成 Agent Run）" style="width:100%"></textarea>
          <input type="text" id="ca-htn-${t.id}" placeholder="备注（可选）" style="width:100%;margin-top:4px">
          <div class="review-actions" style="margin-top:6px">
            <button class="primary" data-caht="${t.id}">✓ 提交结果</button>
          </div>`).join('')}
      </div>`;
    }
  }
  // 终态节点（成功/失败）→ Rework / Run Again 入口（§11：Rework 成为核心操作）
  const TERMINAL_NODE = ['success', 'completed', 'failed', 'terminated', 'error', 'skipped'];
  if (TERMINAL_NODE.includes(ns.status)) {
    const isFail = ['failed', 'terminated', 'error'].includes(ns.status);
    const wfId = st.workflowId;
    html += `<div class="review-card" style="margin-bottom:10px;border-color:${isFail ? 'var(--err)' : 'var(--ok)'}">
      <h4>${isFail ? '⚠ 节点未成功完成' : '✓ 节点已完成'}</h4>
      <div style="font-size:11px;color:var(--fg-dim);margin-bottom:8px">基于本执行从该节点继续迭代（下游重跑，上游结果继承）</div>
      <div class="review-actions">
        ${wfId && typeof openReworkDialog === 'function' ? `<button class="primary" data-node-rework>↻ Rework From Here</button>` : ''}
        ${wfId ? `<button data-node-rerun>▶ 重新运行工作流</button>` : ''}
      </div>
    </div>`;
  }
  return html;
}

// ---- 节点详情 tab ----
function renderNodeTab(body, st) {
  if (!EX.selNode) { body.innerHTML = '<div class="ins-empty">点击画布中的节点查看详情</div>'; return; }
  const id = EX.selNode;
  const ns = st.nodeStates[id] || { status: 'idle' };
  const outputs = st.outputs[id] || [];
  const artifacts = st.artifacts[id] || [];
  const feedback = st.pendingFeedback?.[id];
  body.innerHTML = `
    ${renderContextualActions(st, id)}
    <h3>节点 ${id}</h3>
    <div class="audit-row">状态：<b style="color:${cssVar((NODE_STATUS_META[ns.status] || NODE_STATUS_META.idle).v)}">${(NODE_STATUS_META[ns.status] || {}).text || ns.status}（${ns.status}）</b></div>
    ${st.workingDirectory ? `<div class="audit-row">工作目录（34 继承）：<code>${escX(st.workingDirectory)}</code></div>` : ""}
    <div class="audit-row">运行次数：${st.nodeRunCount?.[id] ?? 0}${ns.iteration > 1 ? ` · 当前迭代 ${ns.iteration}` : ''}${ns.lastInputVersion ? ` · 输入版本 ${ns.lastInputVersion}` : ''}</div>
    ${feedback ? `<div class="audit-row" style="color:var(--hitl)">待注入反馈：${escX(feedback.text)}</div>` : ''}
    <h4 style="margin-top:12px;color:var(--fg-dim)">输出（${outputs.length}）</h4>
    ${outputs.map((o, i) => `<details ${i === outputs.length - 1 ? 'open' : ''}><summary>第 ${o.runIndex} 次 · ${(o.durationMs / 1000).toFixed(1)}s${o.tokenUsage ? ` · token ${o.tokenUsage.prompt}+${o.tokenUsage.completion}` : ''}</summary><pre class="detail-block">${escX(o.content)}</pre></details>`).join('') || '<div class="ins-empty">暂无输出</div>'}
    <h4 style="margin-top:12px;color:var(--fg-dim)">Artifact 版本链（${artifacts.length}）</h4>
    ${artifacts.map((a, i) => `<details ${i === artifacts.length - 1 ? 'open' : ''}>
      <summary style="cursor:pointer">${ARTIFACT_VIEWERS[artifactKind(a)]?.icon ?? '📄'} v${a.version} · ${a.createdBy === 'human' ? '人工' : 'Agent'} · ${new Date(a.createdAt).toLocaleTimeString()}${a.reviewComment ? ` · 意见：${escX(a.reviewComment)}` : ''}</summary>
      ${renderArtifactViewer(a, st)}
      <div class="review-actions" style="margin:4px 0 8px">
        ${i < artifacts.length - 1 ? `<button data-restore="${a.version}">↺ 恢复此版本</button>` : ''}
        ${i > 0 ? `<button data-diff="${a.version}">⇆ 与上一版对比</button>` : ''}
      </div>
      <div id="diffbox-${a.version}" style="display:none"></div>
    </details>`).join('') || '<div class="ins-empty">暂无</div>'}`;

  // 版本恢复（任务 5）
  body.querySelectorAll('[data-restore]').forEach(btn => {
    btn.onclick = async () => {
      const v = +btn.dataset.restore;
      const ok = await uiConfirm({ title: '恢复版本？', message: `确认将节点 <b>${escX(id)}</b> 恢复到 <b>v${v}</b>？<br>将以新人工版本追加（原链不变），后续运行拿到恢复内容。`, okText: '恢复', danger: true });
      if (!ok) return;
      try {
        const r = await API.j('POST', `/api/executions/${EX.id}/artifacts/restore`, { nodeId: id, targetVersion: v });
        statusLine(`已恢复为 v${r.newVersion}`, 'ok');
        pollState();
      } catch (err) { statusLine(`恢复失败：${err.message}`, 'err'); }
    };
  });
  // 版本对比：code（多文件）走 code-diff 按文件着色；其余走通用行级 diff（任务 5）。
  body.querySelectorAll('[data-diff]').forEach(btn => {
    btn.onclick = async () => {
      const to = +btn.dataset.diff;
      const box = body.querySelector(`#diffbox-${to}`);
      const art = artifacts.find(a => a.version === to);
      if (art && Array.isArray(art.files)) {
        try {
          const r = await API.j('POST', `/api/executions/${EX.id}/artifacts/code-diff`, { nodeId: id, fromVersion: to - 1, toVersion: to });
          box.style.display = 'block';
          const BADGE = { added: ['🆕 新增', 'var(--st-ok)'], removed: ['🗑 删除', 'var(--st-err)'], modified: ['✎ 修改', 'var(--st-review)'], unchanged: ['＝ 未变', 'var(--fg-dim)'] };
          box.innerHTML = `<div style="font-size:11px;color:var(--fg-dim)">code 对比 v${r.from.version} → v${r.to.version}</div>` + r.files.map(f => {
            const [label, color] = BADGE[f.status] || BADGE.unchanged;
            const lines = f.result ? `<pre class="detail-block" style="font-size:11px">${f.result.ops.slice(0, 80).map(op => `<div style="color:${op.type === 'add' ? 'var(--st-ok)' : op.type === 'del' ? 'var(--st-err)' : 'var(--fg-dim)'}">${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '} ${escX(op.text)}</div>`).join('')}${f.result.ops.length > 80 ? '<div style="color:var(--fg-dim)">…已截断</div>' : ''}</pre>` : '';
            return `<div class="audit-row" style="font-family:Consolas,monospace">${escX(f.path)} <span style="color:${color}">${label} +${f.added} / -${f.removed}</span></div>${lines}`;
          }).join('');
        } catch (err) { statusLine(`对比失败：${err.message}`, 'err'); }
        return;
      }
      try {
        const r = await API.j('POST', `/api/executions/${EX.id}/artifacts/diff`, { nodeId: id, fromVersion: to - 1, toVersion: to });
        box.style.display = 'block';
        const lines = r.ops.slice(0, 120).map(op => {
          const cls = op.type === 'add' ? 'color:var(--st-ok)' : op.type === 'del' ? 'color:var(--st-err)' : 'color:var(--fg-dim)';
          const pre = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
          return `<div style="${cls}">${pre} ${escX(op.text)}</div>`;
        }).join('');
        box.innerHTML = `<div style="font-size:11px;color:var(--fg-dim)">v${r.from.version} → v${r.to.version}：+${r.added} / -${r.removed}${r.degraded ? ' · 降级展示' : ''}</div>
          <pre class="detail-block" style="font-size:11px">${lines}</pre>${r.ops.length > 120 ? '<div style="font-size:11px;color:var(--fg-dim)">…已截断</div>' : ''}`;
      } catch (err) { statusLine(`对比失败：${err.message}`, 'err'); }
    };
  });

  // 终态上下文操作：Rework From Here / 重新运行（§11：Rework 核心操作）
  const wfId2 = st.workflowId;
  body.querySelector('[data-node-rework]')?.addEventListener('click', () => {
    if (typeof openReworkDialog === 'function') openReworkDialog(wfId2, EX.id);
  });
  body.querySelector('[data-node-rerun]')?.addEventListener('click', async () => {
    try {
      if (typeof S !== 'undefined' && S && wfId2) {
        S.def = await API.j('GET', `/api/workflows/${encodeURIComponent(wfId2)}`);
        if (document.getElementById('wf-id')) document.getElementById('wf-id').value = S.def.id;
        if (document.getElementById('wf-name')) document.getElementById('wf-name').value = S.def.name;
      }
      if (typeof switchToEditMode === 'function') switchToEditMode();
      const runBtn = document.getElementById('btn-run');
      if (runBtn) runBtn.click();
    } catch (err) { statusLine(`加载工作流失败：${err.message}`, 'err'); }
  });

  // ---- Phase B：Human Intervention（§8/§10/§11：向节点输入新任务并继续）----
  const wfId = st.workflowId;
  if (wfId && st.status && !['running', 'paused', 'waiting_review', 'waiting_human'].includes(st.status)) {
    // 收集可 Attach 的 Artifact（各节点最新版）作为 inputArtifacts 附加输入
    const attachOpts = [];
    for (const [nid, chain] of Object.entries(st.artifacts || {})) {
      const a = chain[chain.length - 1];
      if (a) attachOpts.push({ ref: `${nid}@v${a.version}`, label: `${nid}@v${a.version}（${a.createdBy === 'human' ? '人工' : 'Agent'}）` });
    }
    body.insertAdjacentHTML('beforeend', `
      <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
        <h4 style="color:var(--hitl);margin-bottom:2px">人工干预（Human Input）</h4>
        <div style="font-size:11px;color:var(--fg-dim);margin-bottom:6px">向节点 <b>${escX(id)}</b> 输入新要求，从该节点继续执行。历史执行不可变，将创建新 Execution。</div>
        <textarea id="hi-instruction" rows="4" placeholder="请输入给 ${escX(id)} 的新指令（如：修复 Token Refresh 竞态问题）" style="width:100%;box-sizing:border-box"></textarea>
        <label class="field" style="margin-top:6px">附加输入 Artifact（inputArtifacts，可选）</label>
        <div id="hi-attach" style="max-height:120px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px">
          ${attachOpts.length ? attachOpts.map(o => `<label style="display:block;font-size:11px;padding:1px 0"><input type="checkbox" value="${escX(o.ref)}" data-hi-attach> ${escX(o.label)}</label>`).join('') : '<div style="font-size:11px;color:var(--fg-dim)">暂无可用 Artifact</div>'}
        </div>
        <div class="review-actions" style="margin-top:8px">
          <button data-hi-go>继续执行（Rework）</button>
        </div>
      </div>`);
    body.querySelector('[data-hi-go]').onclick = async () => {
      const instruction = (body.querySelector('#hi-instruction')?.value ?? '').trim();
      if (!instruction) { statusLine('请输入指令', 'err'); return; }
      const inputArtifacts = [...body.querySelectorAll('[data-hi-attach]:checked')].map(c => c.value);
      runBtnBusy(body.querySelector('[data-hi-go]'), async () => {
        try {
          const r = await API.j('POST', `/api/workflows/${encodeURIComponent(wfId)}/rework`, {
            parentExecutionId: EX.id,
            reworkNodeId: id,
            instruction,
            inputArtifacts,
          });
          statusLine(`已从 ${id} 继续：${r.executionId}（父 ${r.parentExecutionId}）`, 'ok');
          if (typeof openExecPanel === 'function') openExecPanel(r.executionId);
        } catch (err) { statusLine(`继续失败：${err.message}`, 'err'); }
      }, '提交中…');
    };
  }

  // Phase E：Contextual Action 事件绑定（审核 / 人工任务就地提交）
  body.querySelectorAll('[data-carv]').forEach(btn => {
    btn.onclick = async () => {
      const taskId = btn.dataset.catask;
      const action = btn.dataset.carv;
      const comment = body.querySelector(`#ca-comment-${taskId}`)?.value || null;
      runBtnBusy(btn, async () => {
        try {
          await API.j('POST', `/api/executions/${EX.id}/review`, { taskId, action, comment });
          statusLine(`审核 ${action} 已提交`, 'ok');
          pollState();
        } catch (err) { statusLine(`审核失败：${err.message}`, 'err'); }
      }, '提交中…');
    };
  });
  body.querySelectorAll('[data-caht]').forEach(btn => {
    btn.onclick = async () => {
      const taskId = btn.dataset.caht;
      const content = body.querySelector(`#ca-ht-${taskId}`)?.value ?? '';
      const note = body.querySelector(`#ca-htn-${taskId}`)?.value || undefined;
      try {
        await API.j('POST', `/api/executions/${EX.id}/human-task`, { taskId, content, note });
        statusLine('人工任务已提交', 'ok');
        pollState();
      } catch (err) { statusLine(`提交失败：${err.message}`, 'err'); }
    };
  });
}

// ---- 审计 tab（§66 + 任务 5：Audit Timeline）----
// 聚合：审核审计链 + 人工任务 + 版本恢复 + 环收敛，按时间排序为单一时间线。
function renderAuditTab(body, st) {
  const ACT_LABEL = { request: '发起审核', accept: '通过', reject: '退回', edit: '人工编辑', accept_after_edit: '编辑后通过', terminate: '终止', timeout: '超时处理' };
  const events = [];

  for (const a of st.auditLog || []) {
    events.push({
      ts: a.timestamp,
      icon: a.action === 'reject' ? '✗' : a.action === 'accept' ? '✓' : a.action === 'request' ? '⚖' : a.action === 'edit' || a.action === 'accept_after_edit' ? '✎' : a.action === 'terminate' ? '⏹' : '⏱',
      title: ACT_LABEL[a.action] || a.action,
      color: a.action === 'reject' ? 'var(--st-err)' : a.action === 'accept' ? 'var(--st-ok)' : 'var(--st-review)',
      who: a.operator === 'human' ? '人工' : '系统',
      detail: `${a.fromVersion != null ? `v${a.fromVersion}${a.toVersion != null ? '→v' + a.toVersion : ''}` : ''}${a.comment ? ` · 意见：${a.comment}` : ''}`,
    });
  }
  for (const t of st.humanTasks || []) {
    events.push({ ts: t.createdAt, icon: '⚑', title: `人工任务派发（节点 ${t.nodeId}）`, color: 'var(--st-human)', who: '系统', detail: '' });
    if (t.resolvedAt) events.push({ ts: t.resolvedAt, icon: '✓', title: `人工提交产出（节点 ${t.nodeId}）`, color: 'var(--st-ok)', who: '人工', detail: t.note ? `备注：${t.note}` : '' });
  }
  for (const e of EX.events || []) {
    if (e.type === 'artifact.restored') {
      events.push({ ts: new Date(e.timestamp).toISOString(), icon: '↺', title: `版本恢复（节点 ${e.nodeId}）`, color: 'var(--accent2)', who: '人工', detail: `v${e.payload?.targetVersion} → v${e.payload?.newVersion}` });
    }
    if (e.type === 'loop.terminated') {
      events.push({ ts: new Date(e.timestamp).toISOString(), icon: '◉', title: `环终止（${e.payload?.loopId ?? ''}）`, color: 'var(--accent2)', who: '系统', detail: e.payload?.reason ?? '' });
    }
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  body.innerHTML = '<h3>Audit Timeline</h3>' + (events.length
    ? `<div style="border-left:2px solid var(--line);margin-left:8px;padding-left:14px">` + events.map(e => `
      <div class="audit-row" style="position:relative">
        <span style="position:absolute;left:-21px;top:6px;width:10px;height:10px;border-radius:50%;background:${e.color}"></span>
        <b style="color:${e.color}">${e.icon} ${e.title}</b> · ${e.who} · ${new Date(e.ts).toLocaleTimeString()}
        ${e.detail ? `<br><span style="color:var(--fg-dim)">${escX(e.detail)}</span>` : ''}
      </div>`).join('') + '</div>'
    : '<div class="ins-empty">暂无审计事件</div>');
}

// ---- 事件日志 tab ----
function renderLog() {
  const body = $x('exec-side-body');
  const filterEl = body.querySelector('#event-filter');
  const filter = filterEl ? filterEl.value : (EX.logFilter || '');
  EX.logFilter = filter;
  const evs = EX.events.filter(e => !filter || e.type.includes(filter));
  body.innerHTML = `<input type="text" id="event-filter" placeholder="过滤事件类型…" value="${escX(filter)}" style="width:100%;margin-bottom:6px">
    <div style="font-size:11px;color:var(--fg-dim);margin-bottom:4px">共 ${EX.events.length} 条，显示最近 ${Math.min(200, evs.length)} 条</div>
    <div id="event-log">${evs.slice(-200).map(e =>
      `<div class="ev"><span class="t">${new Date(e.timestamp).toLocaleTimeString()}</span> ${e.type}${e.nodeId ? ` [${e.nodeId}]` : ''}${e.edgeId ? ` (${e.edgeId})` : ''}</div>`).join('')}</div>`;
  body.querySelector('#event-filter').oninput = renderLog;
}

// ---- 输出 tab：实时流式输出 + 最终输出 ----
function renderOutput() {
  const body = $x('exec-side-body');
  const st = EX.state;
  if (!st) { body.innerHTML = '<div class="ins-empty">等待状态…</div>'; return; }
  const nodeId = EX.selNode;
  if (!nodeId) {
    body.innerHTML = '<div class="ins-empty">在画布或 Timeline 中点击节点查看实时输出</div>';
    return;
  }
  const ns = st.nodeStates?.[nodeId];
  const thinkText = EX.thinkingText?.[nodeId] || '';
  const outputs = st.outputs?.[nodeId] || [];
  const lastOutput = outputs.length ? outputs[outputs.length - 1].content : '';
  const artifacts = st.artifacts?.[nodeId] || [];
  // 渲染模式键：判断是否仍处于“同一节点的流式/最终输出”，决定走增量还是全量重建
  const mode = (ns?.status === 'running' && thinkText) ? 'stream' : (lastOutput ? 'final' : 'none');
  const key = nodeId + '|' + mode + '|' + artifacts.length;

  // ---- 流式增量分支：同一节点同一模式且 pre 已存在时，仅更新文本，避免全量重建 DOM 导致滚动被打断 ----
  if (key === EX._outKey) {
    const pre = body.querySelector('pre[data-out-pre]');
    if (pre) {
      const wasBottom = (pre.scrollTop + pre.clientHeight) >= (pre.scrollHeight - 24);
      const text = mode === 'stream' ? thinkText : (lastOutput || '');
      const hadNew = text.length > (EX._outLen || 0);
      pre.textContent = text;
      if (hadNew && wasBottom) pre.scrollTop = pre.scrollHeight; // 只看底部时跟随新内容；已上滑则保持
      EX._outLen = text.length;
      // 同步更新“流式接收中”/“最终输出”标题文字（DOM 结构不变，仅改文案）
      const cap = body.querySelector('[data-out-cap]');
      if (cap) cap.textContent = mode === 'stream' ? '流式接收中…' : '最终输出';
      return;
    }
  }
  EX._outKey = key;
  EX._outLen = (mode === 'stream' ? thinkText : (lastOutput || '')).length;

  let html = '<h4 style="margin-bottom:8px">' + escX(nodeId) + ' 输出</h4>';
  // Artifact 优先（§23）：先列文件/Artifact，文本其次
  if (artifacts.length) {
    html += '<h4 style="margin:4px 0 6px;color:var(--fg-dim);font-size:11px">Artifacts</h4>';
    html += artifacts.map((a, i) => {
      const meta = (a.files && a.files.length)
        ? '<div style="font-size:11px;color:var(--fg-dim);font-family:Consolas,monospace;max-height:64px;overflow:auto">' + a.files.map(f => '📄 ' + escX(f.path)).join('<br>') + '</div>'
        : '';
      return '<details ' + (i === artifacts.length - 1 ? 'open' : '') + ' style="margin-bottom:6px"><summary style="cursor:pointer;font-size:11.5px">' + (ARTIFACT_VIEWERS[artifactKind(a)]?.icon ?? '📄') + ' v' + a.version + ' · ' + (a.createdBy === 'human' ? '人工' : 'Agent') + ' · ' + new Date(a.createdAt).toLocaleTimeString() + '</summary>' + meta + '<div class="review-artifact" style="max-height:120px;overflow:auto">' + renderArtifactViewer(a, st) + '</div></details>';
    }).join('');
  }
  if (ns?.status === 'running' && thinkText) {
    // 运行中：显示实时流式文本
    html += '<div data-out-cap style="font-size:11px;color:var(--accent);margin-bottom:4px">流式接收中…</div>';
    html += '<pre data-out-pre class="detail-block" style="white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:50vh;overflow-y:auto">' + escX(thinkText) + '</pre>';
  } else if (lastOutput) {
    // 已完成：显示最终输出
    html += '<div data-out-cap style="font-size:11px;color:var(--fg-dim);margin-bottom:4px">最终输出</div>';
    html += '<pre data-out-pre class="detail-block" style="white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:50vh;overflow-y:auto">' + escX(lastOutput) + '</pre>';
  } else if (ns && ns.status !== 'idle' && ns.status !== 'queued') {
    html += '<div class="ins-empty">节点无输出内容</div>';
  } else {
    html += '<div class="ins-empty">节点尚未运行，无输出</div>';
  }
  // 如果有标签信息，显示 token 用量
  if (outputs.length && outputs[outputs.length - 1].tokenUsage) {
    const tu = outputs[outputs.length - 1].tokenUsage;
    html += '<div style="margin-top:8px;font-size:11px;color:var(--fg-dim)">token：' + (tu.prompt || 0) + ' prompt / ' + (tu.completion || 0) + ' completion</div>';
  }
  body.innerHTML = html;
  // 首帧全量渲染后：若正处在流式输出，直接滚到底跟随新内容
  const pre = body.querySelector('pre[data-out-pre]');
  if (pre && mode === 'stream') pre.scrollTop = pre.scrollHeight;
}

// ---------- 画布缩放（执行面板） ----------
$x('exec-canvas').addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.1 : 0.9;
  EX.view.k = Math.min(2.5, Math.max(0.3, EX.view.k * factor));
  renderExecCanvas();
}, { passive: false });

// ---------- 侧边栏左右拉伸（宽度持久化到 localStorage） ----------
(function initSideResize() {
  const handle = $x('exec-resize');
  const side = $x('exec-side');
  if (!handle || !side) return;
  try {
    const saved = +localStorage.getItem('dsh-wf-side-w');
    if (saved >= 220) side.style.width = saved + 'px';
  } catch (_) {}
  let dragging = false;
  handle.addEventListener('mousedown', (ev) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const w = Math.min(Math.max(window.innerWidth - ev.clientX, 220), window.innerWidth * 0.62);
    side.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem('dsh-wf-side-w', parseInt(side.style.width, 10) || 360); } catch (_) {}
    if (EX.layout) fitExecView();   // 画布区域变宽后重新适配视图
    renderExecCanvas();
  });
})();

// Phase F（§28）：执行面板加载失败 → 重试
(function () {
  const btn = $x('exec-error-retry');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const er = $x('exec-error'); if (er) er.style.display = 'none';
    const ld = $x('exec-loading'); if (ld) ld.style.display = 'flex';
    EX._errCount = 0;
    pollState();
  });
})();
