/**
 * 第三阶段 Phase 6：模板详情端点（§29/30 + Test 15 前置）
 * - GET /api/templates/:id 内置模板返回完整 def
 * - 用户模板同样可取详情
 * - 404：不存在
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createWorkflowServer } from '../src/index.js';
import { BUILTIN_TEMPLATES } from '../src/templates/builtin.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-p3tpl-'));
const PORT = 3500 + Math.floor(Math.random() * 100);
const server = await createWorkflowServer({ port: PORT, host: '127.0.0.1', mock: true, dataDir: tmp });
const base = `http://127.0.0.1:${PORT}`;

const j = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

afterAll(async () => { await server.close(); });

describe('Phase 6：模板详情端点', () => {
  it('内置模板返回完整 def（节点/连线/身份）', async () => {
    const tpl = BUILTIN_TEMPLATES[0];
    const r = await j('GET', `/api/templates/${tpl.id}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(tpl.id);
    expect(Array.isArray(r.body.def?.nodes)).toBe(true);
    expect(r.body.def.nodes.length).toBe(tpl.def.nodes.length);
    expect(r.body.def.edges.length).toBe(tpl.def.edges.length);
    expect(r.body.def.nodes[0].identity).toBeDefined();
  });

  it('用户模板可取详情', async () => {
    const inst = await j('POST', `/api/templates/${BUILTIN_TEMPLATES[0].id}/instantiate`, { name: '详情测试工作流' });
    const def = (inst.body as { workflow: unknown }).workflow;
    const save = await j('POST', '/api/templates', { name: '详情测试', description: 'd', def });
    expect(save.status).toBe(200);
    const id = (save.body as { template: { id: string } }).template.id;
    const r = await j('GET', `/api/templates/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('详情测试');
    expect(r.body.category).toBe('user');
  });

  it('不存在的模板返回 404', async () => {
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
});
