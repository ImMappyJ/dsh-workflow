"""补丁：lib/index.js 删除工作流时级联清理 executions（磁盘+内存）与 versions"""
import io, re, sys

p = r'C:\Users\Administrator\Documents\lingxi-claw\20260828-17-57-06-274\dsh-plugin-workflow\lib\index.js'
s = open(p, encoding='utf-8').read()

old = """            if (method === 'DELETE') {
                return json(res, 200, { removed: await storage.workflows.remove(id) });
            }"""

new = """            if (method === 'DELETE') {
                // 级联清理：删除工作流时一并移除其全部执行记录（磁盘快照 + 引擎内存态）与版本快照
                const diskExecs = await storage.executions.list();
                const memExecs = [...engine.states.values()];
                const execIds = new Set([
                    ...diskExecs.filter(x => x && x.workflowId === id).map(x => x.executionId ?? x.id),
                    ...memExecs.filter(x => x && x.workflowId === id).map(x => x.executionId ?? x.id),
                ]);
                for (const eid of execIds) {
                    const st = engine.states.get(eid);
                    if (st && !['completed', 'failed', 'terminated', 'cancelled'].includes(st.status)) {
                        try { engine.control(eid, 'stop'); } catch { /* 已结束则忽略 */ }
                    }
                    await storage.executions.remove(eid).catch(() => { });
                    engine.states.delete(eid);
                }
                // 版本快照：key 为 {workflowId}__v{rev}
                const versions = await storage.workflowVersions.list();
                for (const v of versions) {
                    if (v && (v.workflowId === id || (v.id ?? '').startsWith(`${id}__v`))) {
                        await storage.workflowVersions.remove(v.id).catch(() => { });
                    }
                }
                const removed = await storage.workflows.remove(id);
                return json(res, 200, { removed, removedExecutions: execIds.size, removedVersions: versions.filter(v => v && (v.workflowId === id || (v.id ?? '').startsWith(`${id}__v`))).length });
            }"""

assert old in s, 'anchor not found'
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched lib/index.js')

# 语法检查
import subprocess
r = subprocess.run(['node', '--check', p], capture_output=True, text=True)
print('node --check:', 'OK' if r.returncode == 0 else r.stderr[:500])
sys.exit(r.returncode)
