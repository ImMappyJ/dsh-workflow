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

const def: WorkflowDefinition = {
  version: '1.0', id: 'wf', name: 't', createdAt: '', updatedAt: '',
  nodes: [{...agent('start'), type:'start'}, agent('a'), agent('b'), agent('c'), {...agent('end'), type:'end'}],
  edges: [['start','a'],['a','b'],['b','c'],['c','end']].map(([s,t],i)=>({
    id:`e${i}`, source:{nodeId:s,output:'main'}, target:{nodeId:t,input:'main'},
    transform:{enabled:false,instruction:''}, condition:null,
  })),
  settings: defaultSettings(),
  loops: [],
  layout: {},
};

const engine = new WorkflowEngine({ runner: new MockAgentRunner() });
engine.eventBus.on('*', e => console.log(e.type, e.nodeId ?? '', JSON.stringify(e.payload ?? '')));
const h = await engine.run(def, { text: 'x' });
const s = await h.result;
console.log('FINAL', s.status, JSON.stringify(s.error), 'runCount', JSON.stringify(s.nodeRunCount));
console.log('STATES', JSON.stringify(s.nodeStates));
console.log('OUTPUTS', JSON.stringify(Object.fromEntries(Object.entries(s.outputs).map(([k,v])=>[k,v.length]))));
