# -*- coding: utf-8 -*-
"""Phase 6：Editor 菜单重构——节点 Run/Rework From Here、执行历史、画布菜单补全（LF 行尾）"""
p = 'public/editor.js'
src = open(p, encoding='utf-8').read()

# ---- 1. 节点菜单：三项运行时操作（插在"编辑属性"之后）----
anchor = "    { icon: '✎', label: '编辑属性', fn: () => { S.insTab = 'basic'; renderInspector(); } },\n"
assert src.count(anchor) == 1, ('node menu anchor', src.count(anchor))
src = src.replace(anchor, anchor + (
  "    { icon: '▶', label: 'Run From Here（从此节点起跑）', disabled: isTerminal, fn: () => reworkFromNode(nodeId, null) },\n"
  "    { icon: '↻', label: 'Rework From Here（带新请求继续）', disabled: isTerminal, fn: () => {\n"
  "      const input = prompt('Rework：输入新的任务请求（将注入该节点的 prompt）：');\n"
  "      if (input === null) return;\n"
  "      reworkFromNode(nodeId, input);\n"
  "    } },\n"
  "    { icon: '🕘', label: '查看执行历史', fn: () => showNodeHistory(nodeId) },\n"
  "    '-',\n"
))

# ---- 2. 画布菜单：重置所有连线 + 缩放到全部（插在撤销前）----
anchor2 = "    { icon: '↶', label: '撤销（Ctrl+Z）', fn: () => doUndo() },\n"
assert src.count(anchor2) == 1, ('canvas menu anchor', src.count(anchor2))
src = src.replace(anchor2, (
  "    { icon: '⤫', label: '重置所有连线路径', fn: () => {\n"
  "      for (const e of S.def.edges) {\n"
  "        if (e.routing) e.routing = { mode: 'auto', type: 'bezier', points: [] };\n"
  "      }\n"
  "      S.dirty = true;\n"
  "      statusLine('已重置全部连线路径为自动', 'ok');\n"
  "      render();\n"
  "    } },\n"
  "    { icon: '⤢', label: '缩放到全部', fn: () => {\n"
  "      if (!S.def.nodes.length) return;\n"
  "      const xs = S.def.nodes.map(n => n.position.x), ys = S.def.nodes.map(n => n.position.y);\n"
  "      const minX = Math.min(...xs), minY = Math.min(...ys);\n"
  "      const w = Math.max(...xs) + NODE_W - minX, h = Math.max(...ys) + NODE_H - minY;\n"
  "      const wrap = $('canvas-wrap');\n"
  "      S.view.k = Math.max(0.3, Math.min((wrap.clientWidth - 40) / w, (wrap.clientHeight - 40) / h, 1.3));\n"
  "      S.view.x = Math.max(16, (wrap.clientWidth - w * S.view.k) / 2 - minX * S.view.k + minX * 0);\n"
  "      S.view.x = (wrap.clientWidth - w * S.view.k) / 2 - minX * S.view.k;\n"
  "      S.view.y = (wrap.clientHeight - h * S.view.k) / 2 - minY * S.view.k;\n"
  "      statusLine('已缩放到全部节点', 'ok');\n"
  "      render();\n"
  "    } },\n"
  "    '-',\n"
) + anchor2)

# ---- 3. 辅助函数（文件尾部追加）----
src += (
  "\n// ---------- Phase 6：Run / Rework From Here + 节点执行历史 ----------\n"
  "async function reworkFromNode(nodeId, input) {\n"
  "  if (!S.def) return;\n"
  "  try {\n"
  "    const list = await API.j('GET', '/api/executions');\n"
  "    const parent = (Array.isArray(list) ? list : []).find(x => x.workflowId === S.def.id);\n"
  "    if (!parent) {\n"
  "      statusLine('该工作流还没有执行历史——请先用顶部「运行」完整执行一次', 'err');\n"
  "      return;\n"
  "    }\n"
  "    const r = await API.j('POST', `/api/workflows/${encodeURIComponent(S.def.id)}/rework`, {\n"
  "      parentExecutionId: parent.executionId,\n"
  "      reworkNodeId: nodeId,\n"
  "      input: input || '',\n"
  "    });\n"
  "    statusLine(`Rework 已启动：${r.executionId}（父执行 ${r.parentExecutionId}，从 ${r.reworkNodeId} 继续）`, 'ok');\n"
  "    if (confirm(`已创建 Rework 执行 ${r.executionId}。\\n打开执行面板查看？`)) {\n"
  "      if (typeof openExecPanel === 'function') openExecPanel(r.executionId);\n"
  "    }\n"
  "  } catch (err) { statusLine(`Rework 失败：${err.message}`, 'err'); }\n"
  "}\n"
  "\n"
  "async function showNodeHistory(nodeId) {\n"
  "  if (!S.def) return;\n"
  "  try {\n"
  "    const list = await API.j('GET', '/api/executions');\n"
  "    const mine = (Array.isArray(list) ? list : []).filter(x => x.workflowId === S.def.id);\n"
  "    if (!mine.length) { alert(`节点 ${nodeId}：当前工作流暂无执行历史`); return; }\n"
  "    const lines = mine.map(x =>\n"
  "      `${x.executionId}  ${x.status}  v${x.workflowVersion}` +\n"
  "      `${x.reworkNodeId ? `  ↻rework from ${x.reworkNodeId}` : ''}` +\n"
  "      `  ${(x.startedAt || '').slice(0, 16).replace('T', ' ')}` +\n"
  "      `${x.userInput ? `  「${String(x.userInput).slice(0, 40)}」` : ''}`);\n"
  "    alert(`工作流执行历史（${mine.length} 条，含树形 rework 链）：\\n\\n${lines.join('\\n')}`);\n"
  "  } catch (err) { statusLine(`加载执行历史失败：${err.message}`, 'err'); }\n"
  "}\n"
)

open(p, 'w', encoding='utf-8').write(src)
print('Phase 6 editor patch OK')
