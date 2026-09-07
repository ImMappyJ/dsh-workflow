# -*- coding: utf-8 -*-
import io

p = 'src/index.ts'
s = io.open(p, encoding='utf-8', newline='').read()
crlf = '\r\n' in s
if crlf: s = s.replace('\r\n', '\n')

if 'st0' in s:
    print('already'); raise SystemExit

marker = """          await storage.executions.save({
            id: handle.executionId, executionId: handle.executionId,
            workflowId: def.id, status: 'running', startedAt: new Date().toISOString(),
          } as never).catch(() => {});"""
guard = """        const st0 = engine.getExecution(handle.executionId);
        if (!st0 || !['completed', 'failed', 'terminated'].includes(st0.status)) {
%s
        }""" % marker

# run 处：带后续 unsub 的那个
old1 = marker + "\n        const unsub = engine.subscribe"
new1 = guard + "\n        const unsub = engine.subscribe"
assert old1 in s, 'run'
s = s.replace(old1, new1, 1)

# rework 处：带后续 return json 的那个
old2 = marker.replace('          ', '        ') + "\n        return json(res, 200, { executionId: handle.executionId, parentExecutionId"
guard2 = """        const rst = engine.getExecution(handle.executionId);
        if (!rst || !['completed', 'failed', 'terminated'].includes(rst.status)) {
%s
        }""" % marker.replace('          ', '        ')
new2 = guard2 + "\n        return json(res, 200, { executionId: handle.executionId, parentExecutionId"
assert old2 in s, 'rework'
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s if not crlf else s.replace('\n', '\r\n'))
print('fixed')
