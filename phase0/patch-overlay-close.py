# -*- coding: utf-8 -*-
"""UX：所有页面内模态窗口点击遮罩（窗口外）自动关闭"""
import io

P = "public/editor.js"
src = io.open(P, encoding="utf-8", newline="").read()
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")

if "OVERLAY_DISMISS" in src:
    print("already"); raise SystemExit

anchor = "// ---------- Workbench（§3-§26）：搜索 / 筛选 / 排序 / 删除确认 ----------"
code = """// ---------- UX：模态窗口点击遮罩（窗口外）自动关闭 ----------
function setupOverlayDismiss() {
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('mousedown', (ev) => {
      if (ev.target === ov) ov.classList.remove('open'); // 点在窗口外（遮罩本身）才关闭
    });
  });
}
setupOverlayDismiss();
const OVERLAY_DISMISS = true;

""" + anchor
assert anchor in src, 'anchor'
src = src.replace(anchor, code, 1)

if crlf: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("patched")
