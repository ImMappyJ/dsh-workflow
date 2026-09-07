# -*- coding: utf-8 -*-
"""Phase 10：Template 两级展示（§28-31：分组列表 + 预设详情 + Instance 分离）"""
import io, sys

P = "public/editor.js"
src = io.open(P, "r", encoding="utf-8", newline="").read()
_crlf = "\r\n" in src
src = src.replace("\r\n", "\n")
if "showPresetDetail" in src:
    print("already patched"); sys.exit(0)

# 1) 模板库列表：按 内置/用户 分组（两级展示第一级）
old = """    const tpls = await API.j('GET', '/api/templates');
    if (!tpls.length) { list.innerHTML = '<div class="ins-empty">暂无模板</div>'; return; }
    list.innerHTML = tpls.map(t => `"""
new = """    const tpls = await API.j('GET', '/api/templates');
    if (!tpls.length) { list.innerHTML = '<div class="ins-empty">暂无模板</div>'; return; }
    // Phase 10（§30）：两级展示第一级——内置 / 用户分组，列表只显用途
    const groupHtml = (title, arr) => arr.length
      ? `<div class="tpl-group-title">${title}（${arr.length}）</div>` + arr.map(tplRow).join('')
      : '';
    window.__tplRow = tplRow;
    function tplRow(t) { return `"""
item = """      <div class="tpl-item">
        <h4>${esc(t.name)}<span class="tpl-badge">${t.category === 'builtin' ? '内置' : '用户'}</span></h4>
        <div class="tpl-desc">${esc(t.description || '（无描述）')}</div>
        <div class="tpl-meta">${t.nodeCount} 节点 · ${t.edgeCount} 连线</div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="primary" data-use="${t.id}">用此模板新建</button>
          <button data-detail="${t.id}">详情</button>
          ${t.category === 'user' ? `<button class="danger" data-del="${t.id}">删除</button>` : ''}
        </div>
      </div>`;"""
tail = """    }
    list.innerHTML = groupHtml('内置模板', tpls.filter(t => t.category === 'builtin')) +
      groupHtml('用户模板', tpls.filter(t => t.category !== 'builtin'));"""
assert old in src, "tpl list anchor missing"
src = src.replace(old, new + "\n" + item + "\n" + tail, 1)

# 2) 预设库：列表去掉模型行（§28 只显名称/用途/类型）+ 详情按钮 + 详情视图
old = """    const presets = await API.j('GET', '/api/presets');
    if (!presets.length) { list.innerHTML = '<div class="ins-empty">暂无预设。右键节点 →「存为预设」创建。</div>'; return; }
    list.innerHTML = presets.map(t => `
      <div class="tpl-item">
        <h4>${esc(t.name)}<span class="tpl-badge">${t.nodeType === 'human_task' ? '人工任务' : 'Agent'}</span></h4>
        <div class="tpl-desc">${esc(t.description || '（无描述）')}</div>
        <div class="tpl-meta">模型：${esc(t.model || '默认')}</div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="primary" data-insert="${t.id}">插入画布</button>
          <button class="danger" data-pdel="${t.id}">删除</button>
        </div>
      </div>`).join('');"""
new = """    const presets = await API.j('GET', '/api/presets');
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
    });"""
assert old in src, "preset list anchor missing"
src = src.replace(old, new, 1)

# 3) showPresetDetail 函数：插在 showTemplateDetail 函数结束之后（reworkFromNode 之前）
anchor = "// ---------- Phase 7：执行历史 UI"
fn = """// ---------- Phase 10：预设（Node Template）详情（§29：完整配置不堆在列表） ----------
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

""" + anchor
assert anchor in src
src = src.replace(anchor, fn, 1)

if _crlf: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("patched OK")
