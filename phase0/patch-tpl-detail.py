# -*- coding: utf-8 -*-
"""Phase 6 收尾：模板详情按钮 + 详情视图（editor.js）"""
import io, re, sys

P = "public/editor.js"
src = io.open(P, "r", encoding="utf-8", newline="").read()

if "showTemplateDetail" in src:
    print("already patched"); sys.exit(0)

# 1) 列表按钮加详情
anchor1 = "<button class=\"primary\" data-use=\"${t.id}\">用此模板新建</button>"
assert anchor1 in src, "anchor1 missing"
src = src.replace(anchor1, anchor1 + "\n          <button data-detail=\"${t.id}\">详情</button>", 1)

# 2) 详情点击处理：挂在 data-del 绑定之后
anchor2 = "list.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {"
idx = src.index(anchor2)
detail_handler = """    list.querySelectorAll('[data-detail]').forEach(b => b.onclick = async () => {
      try {
        const tpl = await API.j('GET', `/api/templates/${b.dataset.detail}`);
        showTemplateDetail(tpl, () => $('btn-tpl-lib').click());
      } catch (err) { statusLine(`加载详情失败：${err.message}`, 'err'); }
    });
"""
src = src[:idx] + detail_handler + src[idx:]

# 3) showTemplateDetail 函数：插在 tpl-close 绑定之后
anchor3 = "$('tpl-close').onclick = () => $('tpl-dialog').classList.remove('open');"
assert anchor3 in src, "anchor3 missing"
fn = anchor3 + """

// ---------- Phase 6：模板详情（§29/30：列表只显用途，详情看完整配置） ----------
function showTemplateDetail(tpl, back) {
  const list = $('tpl-list');
  const def = tpl.def || {};
  const nodes = def.nodes || [];
  const edges = def.edges || [];
  const nodeRows = nodes.map(n => `
    <tr><td>${esc(n.id)}</td><td>${esc(n.type || 'agent')}</td><td>${esc(n.name || '')}</td>
    <td>${esc(n.model || '默认')}</td><td>${esc((n.prompt || '').slice(0, 60))}${(n.prompt || '').length > 60 ? '…' : ''}</td>
    <td>${n.review?.enabled ? `Review（${esc(n.review.mode || 'required')}）` : ''}</td></tr>`).join('');
  const edgeRows = edges.map(e => `
    <tr><td>${esc(e.source)}</td><td>${esc(e.target)}</td><td>${esc(e.routing?.type || e.type || 'bezier')}</td>
    <td>${(e.dataFlow?.artifactKeys || []).map(esc).join(', ') || ''}</td></tr>`).join('');
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
}"""
src = src.replace(anchor3, fn, 1)

io.open(P, "w", encoding="utf-8", newline="").write(src)
print("patched OK")
