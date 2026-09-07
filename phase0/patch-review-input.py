# -*- coding: utf-8 -*-
"""修复：审核意见无法输入（轮询 1.5s 重建面板销毁焦点/内容）"""
import io

P = "public/execution.js"
src = io.open(P, encoding="utf-8", newline="").read()
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")
if "reviewDrafts" in src:
    print("already"); raise SystemExit

old = """function renderSide() {
  const body = $x('exec-side-body');
  const st = EX.state;
  if (!st) { body.innerHTML = '<div class="ins-empty">等待状态…</div>'; return; }"""
new = """function renderSide() {
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
  body.querySelectorAll('textarea[id]').forEach(t => { if (t.value) EX.reviewDrafts[t.id] = t.value; });"""
assert old in src, 'renderSide'
src = src.replace(old, new, 1)

old2 = """  body.innerHTML = html;

  // 批量决策（任务 5 MVP）"""
new2 = """  body.innerHTML = html;
  // 回填草稿（审核意见不因轮询丢失）
  body.querySelectorAll('textarea[id]').forEach(t => {
    const d = EX.reviewDrafts[t.id];
    if (d != null && !t.value) t.value = d;
  });

  // 批量决策（任务 5 MVP）"""
assert old2 in src, 'review backfill'
src = src.replace(old2, new2, 1)

old3 = """function renderHumanTab(body, st) {
  const tasks = st.humanTasks || [];
  if (!tasks.length) return;"""
new3 = """function renderHumanTab(body, st) {
  const tasks = st.humanTasks || [];
  if (!tasks.length) return;
  // 同审核 tab：输入中不重建；重建时回填草稿
  const _ae = document.activeElement;
  if (_ae && body.contains(_ae) && (_ae.tagName === 'TEXTAREA' || _ae.tagName === 'INPUT')) return;
  const _drafts = {};
  body.querySelectorAll('textarea[id]').forEach(t => { if (t.value) _drafts[t.id] = t.value; });"""
assert old3 in src, 'human head'
src = src.replace(old3, new3, 1)

# human tab 用 insertAdjacentHTML 追加，其后回填草稿
anchor_ht = "body.insertAdjacentHTML('beforeend', html);\n\n  body.querySelectorAll('[data-ht]')"
assert anchor_ht in src, 'human insert'
src = src.replace(anchor_ht, """body.insertAdjacentHTML('beforeend', html);
  body.querySelectorAll('textarea[id]').forEach(t => {
    const d = _drafts[t.id];
    if (d != null && !t.value) t.value = d;
  });

  body.querySelectorAll('[data-ht]')""", 1)

if crlf: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("patched")
