"""查询已运行的 execution 状态（waiting_human 走查）"""
import json, urllib.request, urllib.error, time

BASE = 'http://127.0.0.1:3090'
EXEC = 'exec_1788247995821_2'

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

for i in range(40):
    st = req('GET', f'/api/executions/{EXEC}')
    if isinstance(st, dict) and 'status' in st:
        ns = {k: v.get('status') for k, v in (st.get('nodeStates') or {}).items()}
        ht = [(t.get('id'), t.get('status'), t.get('prompt')) for t in (st.get('humanTasks') or [])]
        rt = [(t.get('id'), t.get('status')) for t in (st.get('reviewTasks') or [])]
        print(f"[{i}] exec={st.get('status')} nodes={ns} humanTasks={ht} reviewTasks={rt}")
        if st.get('status') in ('waiting_human', 'waiting_review', 'completed', 'failed'):
            break
    else:
        print(f"[{i}] probe:", json.dumps(st, ensure_ascii=False)[:300])
    time.sleep(0.5)
