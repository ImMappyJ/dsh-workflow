"""端到端验证：带 workspaceDir 的工作流运行后 execution 携带 workingDirectory"""
import json, urllib.request, urllib.error, time

BASE = 'http://127.0.0.1:3090'

def agent(id, ntype):
    return {
        'id': id, 'type': ntype, 'name': id, 'position': {'x': 0, 'y': 0},
        'identity': {'name': f'role-{id}'}, 'roleDescription': f'desc-{id}',
        'inputContract': {'description': '', 'processing': '', 'selection': '', 'ignore': '', 'constraints': [], 'sourceMode': 'all', 'selectedSourceNodeIds': []},
        'outputContract': {'description': '', 'format': 'markdown', 'schema': None, 'requiredSections': [], 'targets': [], 'condition': None},
        'modelConfig': {'provider': 'deepseek', 'model': 'deepseek-chat'},
        'runtimeConfig': {'maxRuns': 5, 'timeoutMs': 120000, 'retry': {'enabled': False, 'maxRetries': 0, 'backoffMs': 0}, 'onFailure': 'fail_workflow'},
        'metadata': {},
    }

defn = {
    'version': '1.0', 'id': 'wf_cwd_e2e', 'name': 'cwd-e2e',
    'createdAt': '2026-09-01T00:00:00Z', 'updatedAt': '2026-09-01T00:00:00Z',
    'nodes': [agent('start', 'start'), agent('end', 'end')],
    'edges': [{'id': 'e0', 'source': {'nodeId': 'start', 'output': 'main'}, 'target': {'nodeId': 'end', 'input': 'main'}, 'transform': {'enabled': False, 'instruction': ''}, 'condition': None}],
    'settings': {'maxExecutionSteps': 100, 'maxIterations': 10, 'timeoutMs': 300000, 'workspaceDir': 'D:/projects/myapp'},
    'loops': [], 'layout': {},
}

def req(method, path, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        r.add_header('Content-Type', 'application/json')
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {'http_error': e.code, 'body': e.read().decode()[:300]}

print('create:', req('POST', '/api/workflows', defn))
time.sleep(0.3)
run = req('POST', '/api/workflows/wf_cwd_e2e/run', {'input': 'GO'})
print('run:', run)
exec_id = run.get('executionId')
if exec_id:
    time.sleep(1.2)
    st = req('GET', f'/api/executions/{exec_id}')
    print('exec status:', st.get('status'), '| workingDirectory:', st.get('workingDirectory'))
