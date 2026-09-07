# -*- coding: utf-8 -*-
"""Phase A 竞态根治：终态持久化 await 化（result resolve 前快照已落盘）"""
import io

p = "src/engine/engine.ts"
s = io.open(p, encoding="utf-8", newline="").read()
crlf = "\r\n" in s
if crlf: s = s.replace("\r\n", "\n")

if "pendingPersist" in s:
    print("already"); raise SystemExit

# 1) onExecutionEnd 类型允许返回 Promise
old = "  onExecutionEnd?: (state: import('../domain/types.js').ExecutionState) => void;"
new = "  onExecutionEnd?: (state: import('../domain/types.js').ExecutionState) => void | Promise<void>;"
assert old in s, "type"
s = s.replace(old, new, 1)

# 2) emit 终态分支：记录持久化 Promise 供 finally await
old = """    if (state && ['workflow.completed', 'workflow.failed', 'workflow.terminated'].includes(type)) {
      try { this.opts.onExecutionEnd?.(state); } catch { /* 持久化失败不影响运行时 */ }
    }"""
new = """    if (state && ['workflow.completed', 'workflow.failed', 'workflow.terminated'].includes(type)) {
      // Phase A：终态持久化 await 化——finally 中等待其完成，保证 result resolve 前快照已落盘（消除 Test 6 竞态）
      try {
        this.pendingPersist.set(executionId, Promise.resolve(this.opts.onExecutionEnd?.(state)).catch(() => {}));
      } catch { /* 持久化失败不影响运行时 */ }
    }"""
assert old in s, "emit"
s = s.replace(old, new, 1)

# 3) 声明 pendingPersist 字段
old = "  private defs = new Map<string, WorkflowDefinition>();"
new = """  private defs = new Map<string, WorkflowDefinition>();
  /** Phase A：终态持久化 Promise 队列（emit 记录，finally await），消除磁盘快照与重启的竞态 */
  private pendingPersist = new Map<string, Promise<void>>();"""
assert old in s, "field"
s = s.replace(old, new, 1)

# 4) run/rework 两处 finally await 持久化
old = """      .finally(() => {
        state.endedAt = new Date().toISOString();
        if (ctrl.reviewTimer) { clearTimeout(ctrl.reviewTimer); ctrl.reviewTimer = null; }
        this.controls.delete(executionId);
        this.loopers.delete(executionId);
        this.defs.delete(executionId);
      });"""
new = """      .finally(async () => {
        state.endedAt = new Date().toISOString();
        if (ctrl.reviewTimer) { clearTimeout(ctrl.reviewTimer); ctrl.reviewTimer = null; }
        this.controls.delete(executionId);
        this.loopers.delete(executionId);
        this.defs.delete(executionId);
        // Phase A：等待终态快照落盘完成，再让 result resolve（Test 6 重启后必读到终态）
        await this.pendingPersist.get(executionId);
        this.pendingPersist.delete(executionId);
      });"""
count = s.count(old)
assert count == 2, f"finally count={count}"
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="").write(s if not crlf else s.replace("\n", "\r\n"))
print("engine patched")
