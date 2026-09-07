import { mkdtemp, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkflowServer } from '../src/index.ts';
import { defaultSettings } from '../src/domain/types.ts';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'repro-'));
const PORT = 4600;
const server = await createWorkflowServer({ port: PORT, host: '127.0.0.1', mock: true, dataDir: tmp });
const base = `http://127.0.0.1:${PORT}`;
const j = async (m, p, body) => {
  const r = await fetch(base + p, {
    method: m,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const agent = (id, type = 'agent') => ({
  id, type, name: id, position: { x: 0, y: 0 }, identity: { name: id }, roleDescription: id,
  inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
  outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
  modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
  runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
  metadata: {},
});
const edge = (i, s, t) => ({ id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null });
const wf = {
  version: '1.0', id: 'wf_repro', name: 'repro', createdAt: '2026-01-01T00:00:00Z', updatedAt: new Date().toISOString(),
  nodes: [agent('start', 'start'), agent('mid'), agent('end', 'end')],
  edges: [edge(1, 'start', 'mid'), edge(2, 'mid', 'end')],
  settings: defaultSettings({ workspaceDir: 'D:/project' }), loops: [], layout: {},
};

const s1 = await j('POST', '/api/workflows', wf);
console.log('save rev', s1.body?.workflow?.revision);
const run = await j('POST', '/api/workflows/wf_repro/run', { input: 'hello' });
const eid = run.body.executionId;
console.log('eid', eid, 'run status', run.status);
let st = null;
for (let i = 0; i < 50; i++) {
  st = (await j('GET', `/api/executions/${eid}`)).body;
  if (['completed', 'failed', 'terminated'].includes(st.status)) break;
  await new Promise(r => setTimeout(r, 100));
}
console.log('mem status', st.status, 'rev', st.workflowVersion, 'wd', st.workingDirectory);
const snapPath = path.join(tmp, 'executions', `${eid}.json`);
let disk = null;
for (let i = 0; i < 50; i++) {
  try {
    disk = JSON.parse(await readFile(snapPath, 'utf-8'));
    if (['completed', 'failed', 'terminated'].includes(disk.status)) break;
  } catch { /* not yet */ }
  await new Promise(r => setTimeout(r, 100));
}
console.log('disk status', disk?.status, 'has defSnapshot', !!disk?.defSnapshot, 'size', disk ? JSON.stringify(disk).length : -1);
await server.close();
