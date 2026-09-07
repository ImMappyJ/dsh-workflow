import { createWorkflowServer } from '../src/index.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-sse-'));
const server = createWorkflowServer({ port: 3299, host: '127.0.0.1', mock: true, dataDir: tmp });
const BASE = 'http://127.0.0.1:3299';

function agent(id: string, type: any = 'agent'): AgentNode {
  return {
    id, type, name: id, position: { x: 0, y: 0 }, identity: { name: id }, roleDescription: id,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'x' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
  };
}

const def: WorkflowDefinition = {
  version: '1.0', id: 'wf1', name: 'd', createdAt: '', updatedAt: '',
  nodes: [agent('start', 'start'), agent('b'), agent('end', 'end')],
  edges: [['start', 'b'], ['b', 'end']].map(([s, t], i) => ({
    id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
    transform: { enabled: false, instruction: '' }, condition: null,
  })),
  settings: defaultSettings(), loops: [], layout: {},
};

await fetch(BASE + '/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(def) });
const es = await fetch(BASE + '/api/events');
console.log('SSE headers ok');
const reader = es.body!.getReader();
setTimeout(async () => {
  await fetch(BASE + '/api/workflows/wf1/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'X' }) });
  console.log('run sent');
}, 100);

const dec = new TextDecoder();
const t0 = Date.now();
const result: any = await Promise.race([
  reader.read(),
  new Promise(r => setTimeout(() => r({ timeout: true }), 4000)),
]);
console.log('first read', Date.now() - t0, 'ms, result=', JSON.stringify(result.timeout ? 'TIMEOUT' : dec.decode(result.value).slice(0, 120)));
await server.close();
process.exit(0);
