# -*- coding: utf-8 -*-
"""Workbench 后端：View Model（workflowName/runNumber）+ DELETE /api/executions/:id（§10-13）"""
import io

P = "src/index.ts"
src = io.open(P, encoding="utf-8", newline="").read()
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")

# 1) 列表端点升级为 Workbench View Model（§28：一次返回 UI 所需，避免 N+1）
old = """        .map(x => ({
          executionId: x.executionId ?? x.id,
          workflowId: x.workflowId,
          workflowVersion: x.workflowVersion ?? 1,
          status: x.status,
          startedAt: x.startedAt,
          endedAt: x.endedAt,
          parentExecutionId: x.parentExecutionId ?? null,
          reworkNodeId: x.reworkNodeId ?? null,
          workingDirectory: x.workingDirectory ?? null,
          userInput: (x.userInput ?? '').slice(0, 120),
        }));
      return json(res, 200, items);"""
new = """        .map(x => ({
          executionId: x.executionId ?? x.id,
          workflowId: x.workflowId,
          workflowVersion: x.workflowVersion ?? 1,
          status: x.status,
          startedAt: x.startedAt,
          endedAt: x.endedAt,
          parentExecutionId: x.parentExecutionId ?? null,
          reworkNodeId: x.reworkNodeId ?? null,
          workingDirectory: x.workingDirectory ?? null,
          userInput: (x.userInput ?? '').slice(0, 120),
        }));
      // Workbench View Model（§23/§28）：主信息为 workflowName + runNumber，技术 ID 退居详情
      const wfList = await storage.workflows.list();
      const wfNames = new Map<string, string>(wfList.map(w => [w.id, w.name]));
      const byWf = new Map<string, typeof items>();
      for (const it of items) {
        const k = it.workflowId ?? '';
        if (!byWf.has(k)) byWf.set(k, []);
        byWf.get(k)!.push(it);
      }
      const runNo = new Map<string, number>();
      for (const arr of byWf.values()) {
        arr.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
        arr.forEach((it, i) => runNo.set(it.executionId, i + 1)); // Run #N：同一 Workflow 第 N 次运行（§24）
      }
      const view = items.map(it => ({
        ...it,
        workflowName: wfNames.get(it.workflowId) ?? (it as any).workflowName ?? `（工作流已删除：${it.workflowId}）`,
        runNumber: runNo.get(it.executionId) ?? 1,
        updatedAt: it.endedAt ?? it.startedAt,
      }));
      return json(res, 200, view);"""
assert old in src, 'list'
src = src.replace(old, new, 1)

# 2) 详情端点补充 workflowName（§8/§9：详情含 Name/ID）
old = """      const disk = await storage.executions.get(id);
      return disk ? json(res, 200, disk) : json(res, 404, { error: 'execution not found' });"""
new = """      const disk = await storage.executions.get(id);
      if (!disk) return json(res, 404, { error: 'execution not found' });
      const wf = await storage.workflows.get(disk.workflowId);
      return json(res, 200, { ...disk, workflowName: wf?.name ?? disk.workflowName ?? null });"""
assert old in src, 'detail'
src = src.replace(old, new, 1)

# 3) DELETE /api/executions/:id（§10-13：确认在前端；后端保护 Execution Tree 与活跃执行）
anchor = "    if ((m = p.match(/^\\/api\\/executions\\/([^/]+)\\/control$/)) && method === 'POST') {"
delcode = """    // Workbench（§10-13）：删除 Execution —— 绝不触碰 Workflow Definition；保护 Execution Tree
    if ((m = p.match(/^\\/api\\/executions\\/([^/]+)$/)) && method === 'DELETE') {
      const id = m[1];
      const st = (engine as any).states?.get?.(id);
      if (st && !['completed', 'failed', 'terminated', 'cancelled'].includes(st.status)) {
        return json(res, 409, { error: '执行仍在运行，请先终止后再删除' });
      }
      const disk = await storage.executions.get(id);
      if (!disk && !st) return json(res, 404, { error: 'execution not found' });
      // §13：存在子 Rework 时禁止直接删除，避免 Execution Tree 断裂
      const all = await storage.executions.list();
      const child = all.find(x => x && x.parentExecutionId === id);
      if (child) {
        return json(res, 409, { error: `该执行存在 Rework 子执行（${child.executionId ?? child.id}），请先删除子执行` });
      }
      const removed = await storage.executions.remove(id);
      return json(res, 200, { removed, workflowId: disk?.workflowId ?? null });
    }
""" + anchor
assert anchor in src, 'delete anchor'
src = src.replace(anchor, delcode, 1)

if crlf: src = src.replace("\n", "\r\n")
io.open(P, "w", encoding="utf-8", newline="").write(src)
print("index.ts patched")
