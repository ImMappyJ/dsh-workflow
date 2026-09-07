"""构造含 human_task 节点的工作流并运行，触发 waiting_human 状态（真机级 CA 走查准备）"""
import json, urllib.request, urllib.error, time

BASE = 'http://127.0.0.1:3090'

def agent(id, ntype='agent', extra=None):
    n = {
        'id': id, 'type': ntype, 'name': id,
        'position': {'x': 0, 'y': 0},
        'identity': {'name': f'role-{id}'},
        'roleDescription': f'desc-{id}',
        'inputContract': {'description': '', 'processing': '', 'selection': '', 'ignore': '', 'constraints': [], 'sourceMode': 'all', 'selectedSourceNodeIds': []},
        'outputContract': {'description': '', 'format': 'markdown', 'schema': None, 'requiredSections': [], 'targets': [], 'condition': None},
        'modelConfig': {'provider': 'deepseek', 'model': 'deepseek-chat'},
        'runtimeConfig': {'maxRuns': 5, 'timeoutMs': 120000, 'retry': {'enabled': False, 'maxRetries': 0, 'backoffMs': 0}, 'onFailure': 'fail_workflow'},
        'metadata': {},
    }
    if extra:
        n.update(extra)
    return n

def mkdef():
    nodes = [
        agent('start', 'start'),
        agent('planner'),
        agent('approve', 'human_task', {'roleDescription': '人工审批', 'metadata': {'taskPrompt': '请人工确认上线清单'}}),
        agent('end', 'end'),
    ]
    edges = []
    for i, (s, t) in enumerate([('start', 'planner'), ('planner', 'approve'), ('approve', 'end')]):
        edges.append({
            'id': f'e{i}',
            'source': {'nodeId': s, 'output': 'main'},
            'target': {'nodeId': t, 'input': 'main'},
            'transform': {'enabled': False, 'instruction': ''},
            'condition': None,
        })
    return {
        'version': '1.0', 'id': 'wf_human_ca', 'name': 'human-ca-walkthrough',
        'createdAt': '2026-09-01T00:00:00Z', 'updatedAt': '2026-09-01T00:00:00Z',
        'nodes': nodes, 'edges': edges,
        'settings': {'maxIterations': 10, 'maxExecutionSteps': 100, 'timeoutMs': 300000},
        'loops': [], 'layout': {},
    }

def req(method, path, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        r.add_header('Content-Type', 'application/json')
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {'http_error': e.code, 'body': e.read().decode()[:400]}

defn = mkdef()
print('POST create:', req('POST', '/api/workflows', defn))
time.sleep(0.5)
print('POST run:', req('POST', '/api/workflows/wf_human_ca/run', {'input': 'GO'}))

# 轮询 execution 状态直到 waiting_human 或失败
for i in range(30):
    time.sleep(0.5)
    st = req('GET', '/api/executions/wf_human_ca')
    # 尝试不同状态端点路径
    if isinstance(st, dict) and 'error' not in st and 'status' in st:
        print('state:', st.get('status'), 'nodeStates:', {k: v.get('status') for k, v in (st.get('nodeStates') or {}).items()})
        if st.get('status') in ('waiting_human', 'waiting_review', 'completed', 'failed'):
            break
    else:
        # 可能端点不同
        print('state probe:', json.dumps(st, ensure_ascii=False)[:200])
