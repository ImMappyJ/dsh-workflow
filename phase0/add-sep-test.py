# -*- coding: utf-8 -*-
import io

p = 'test/phase3-tpl-detail.test.ts'
s = io.open(p, encoding='utf-8', newline='').read()
if '31：' in s:
    print('already'); raise SystemExit

old = """  it('不存在的模板返回 404', async () => {
    const r = await j('GET', '/api/templates/tpl_nope');
    expect(r.status).toBe(404);
  });
});"""
new = """  it('不存在的模板返回 404', async () => {
    const r = await j('GET', '/api/templates/tpl_nope');
    expect(r.status).toBe(404);
  });

  it('§31：修改 Instance 不影响 Template', async () => {
    const tpl = BUILTIN_TEMPLATES[0];
    const r1 = await j('POST', `/api/templates/${tpl.id}/instantiate`, { name: '分离测试' });
    expect(r1.status).toBe(200);
    const wf1 = (r1.body as { workflow: { id: string; nodes: { name: string }[] } }).workflow;
    // 修改 instance 并保存
    wf1.name = '已被修改的实例';
    wf1.nodes[0].name = 'MUTATED';
    await j('POST', '/api/workflows', wf1);
    // template 保持原样
    const tplAfter = await j('GET', `/api/templates/${tpl.id}`);
    const def = (tplAfter.body as { def: { name: string; nodes: { name: string }[] } }).def;
    expect(def.name).toBe(tpl.def.name);
    expect(def.nodes[0].name).toBe(tpl.def.nodes[0].name);
  });
});"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
