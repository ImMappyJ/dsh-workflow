# -*- coding: utf-8 -*-
"""Phase 11b：图标统一对齐 + 控制点拖拽不被画布平移抢占"""
import io

# ---------- editor.js ----------
P = "public/editor.js"
src = io.open(P, encoding="utf-8", newline="").read()
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")

# 1) 画布平移让位给控制点拖拽（平移监听注册在前，需在开头让位）
old = "svg.addEventListener('mousedown', (ev) => {\n  const portEl = ev.target.closest('.port');"
new = ("svg.addEventListener('mousedown', (ev) => {\n"
       "  // Phase 11b：控制点拖拽优先，画布平移不得抢占\n"
       "  if (ev.target.closest('.edge-ctrl')) return;\n"
       "  const portEl = ev.target.closest('.port');")
assert old in src, 'pan anchor'
src = src.replace(old, new, 1)

# 2) 菜单图标统一：固定宽度列 + 对齐（不再随 emoji 宽度抖动）
old = "return `<button data-i=\"${i}\" class=\"${it.danger ? 'danger' : ''}\" ${it.disabled ? 'disabled' : ''}>${it.icon ?? ''} ${esc(it.label)}</button>`;"
new = "return `<button data-i=\"${i}\" class=\"${it.danger ? 'danger' : ''}\" ${it.disabled ? 'disabled' : ''}><span class=\"ctx-icon\">${it.icon ?? ''}</span>${esc(it.label)}</button>`;"
assert old in src, 'ctx item anchor'
src = src.replace(old, new, 1)

# 3) 工具栏按钮去 emoji（文本统一、尺寸一致），仅保留独立主题圆钮
for a, b in [
    ('>🕘 历史</button>', '>历史</button>'),
    ('>◐ 主题</button>', '>主题</button>'),
    ('>▶ 运行</button>', '>运行</button>'),
    ('>⧉ 自动布局</button>', '>自动布局</button>'),
    ('>⊕ 新建</button>', '>新建</button>'),
]:
    src = src.replace(a, b)

if crlf: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("editor.js patched")

# ---------- index.html ----------
H = "public/index.html"
s = io.open(H, encoding="utf-8", newline="").read()
if "ctx-icon" not in s:
    anchor = '  #ctx-menu button { display: flex; width: 100%; align-items: center; gap: 8px; background: transparent; border: none; border-radius: 5px; padding: 6px 10px; font-size: 12.5px; text-align: left; }'
    assert anchor in s, 'ctx css anchor'
    add = (anchor
           + '\n  #ctx-menu .ctx-icon { flex: 0 0 18px; width: 18px; text-align: center; font-size: 13px; line-height: 1; }'
           + '\n  /* Phase 11b：工具栏图标/文本统一对齐 */'
           + '\n  .toolbar button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; }'
           + '\n  .toolbar button svg, .toolbar button img { width: 14px; height: 14px; }'
           + '\n  #btn-theme-2 { width: 28px; padding: 0; font-size: 14px; }')
    s = s.replace(anchor, add, 1)
    io.open(H, "w", encoding="utf-8", newline="").write(s)
    print("index.html patched")
else:
    print("css already")
