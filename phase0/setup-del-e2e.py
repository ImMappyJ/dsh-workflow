"""删除闭环端到端验证：创建含执行记录的工作流"""
import json, urllib.request, urllib.error, time

BASE = 'http://127.0.0.1:3090'

def agent(id, nt):
    return {
        'id': id, 'type': nt, 'name': id, 'position': {'x': 0, 'y': 0},
        'identity': {'name': id}, 'roleDescription': id,
        'inputContract': {'description': '', 'processing': '', 'selection': '', 'ignore': '', 'constraints': [], 'sourceMode': 'all', 'selectedSourceNodeIds': []},
        'outputContract': {'description': '', 'format': 'markdown', 'schema': None, 'requiredSections': [], 'targets': [], 'condition': None},
        'modelConfig': {'provider': 'deepseek', 'model': 'deepseek-chat'},
        'runtimeConfig': {'maxRuns': 5, 'timeoutMs': 120000, 'retry': {'enabled': False, 'maxRetries': 0, 'backoffMs': 0}, 'onFailure': 'fail_workflow'},
        'metadata': {},
    }

defn = {
    'version': '1.0', 'id': 'wf_del_e2e', 'name': '删除闭环验证',
    'createdAt': '2026-09-02T00:00:00Z', 'updatedAt': '2026-09-02T00:00:00Z',
    'nodes': [agent('start', 'start'), agent('end', 'end')],
    'edges': [{'id': 'e0', 'source': {'nodeId': 'start', 'output': 'main'}, 'target': {'nodeId': 'end', 'input': 'main'}, 'transform': {'enabled': False, 'instruction': ''}, 'condition': None}],
    'settings': {'maxExecutionSteps': 100, 'maxIterations': 10, 'timeoutMs': 300000},
    'loops': [], 'layout': {},
}

def req(m, p, b=None):
    r = urllib.request.Request(BASE + p, method=m)
    if b is not None:
        r.add_header('Content-Type', 'application/json')
        r.data = json.dumps(b).encode()
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {'http_error': e.code, 'body': e.read().decode()[:200]}

print('create:', req('POST', '/api/workflows', defn))
time.sleep(0.3)
run = req('POST', '/api/workflows/wf_del_e2e/run', {'input': 'GO'})
print('run:', run)
exec_id = run.get('executionId')
if exec_id:
    time.sleep(1.2)
    st = req('GET', f'/api/executions/{exec_id}')
    print('exec status:', st.get('status'))
