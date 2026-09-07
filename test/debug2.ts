import { WorkflowEngine } from '../src/engine/engine.js';
import { MockAgentRunner } from '../src/engine/runner.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';

function agent(id: string): AgentNode {
  return {
    id, type: 'agent', name: id, position: { x: 0, y: 0 },
    identity: { name: id }, roleDescription: id,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'm' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
  };
}

const mock = new MockAgentRunner({
  scriptsPerNode: {
    a: [{ type: 'dynamic', fn: req => `a-round-${req.runIndex}` }],
    b: [{ type: 'dynamic', fn: req => `b-round-${req.runIndex}` }],
  },
});

const def: WorkflowDefinition = {
  version: '1.0', id: 'wf', name: 't', createdAt: '', updatedAt: '',
  nodes: [{...agent('start'), type:'start'}, agent('a'), agent('b'), {...agent('end'), type:'end'}],
  edges: [['start','a'],['a','b'],['b','a'],['b','end']].map(([s,t],i)=>({
    id:`e${i}`, source:{nodeId:s,output:'main'}, target:{nodeId:t,input:'main'},
    transform:{enabled:false,instruction:''}, condition:null,
  })),
  settings: defaultSettings(),
  loops: [{ loopId: 'loop_001', nodeIds: ['a','b'], maxIterations: 2 }],
  layout: {},
};

const engine = new WorkflowEngine({ runner: mock });
engine.eventBus.on('*', e => {
  if (['node.started','workflow.failed','loop.terminated','workflow.completed'].includes(e.type)) {
    console.log(e.type, e.nodeId ?? '', JSON.stringify(e.payload ?? ''));
  }
});
const h = await engine.run(def, { text: 'hello' });
const s = await h.result;
console.log('FINAL', s.status, JSON.stringify(s.error), JSON.stringify(s.nodeRunCount));
