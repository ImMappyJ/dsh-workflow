"""调试：检查执行记录中的 workflowId 字段与删除级联逻辑"""
import json, urllib.request, urllib.error, time, os, glob, tempfile

# 用一个临时数据目录起一个 mock server 来复现
import subprocess, sys

# 直接检查 3090 真实宿主（旧代码，无级联）上的执行记录字段
BASE = 'http://127.0.0.1:3090'
with urllib.request.urlopen(BASE + '/api/executions') as r:
    execs = json.loads(r.read().decode())
# 打印最近几条的字段
for x in execs[:3]:
    print({k: x.get(k) for k in ['executionId', 'workflowId', 'status']})
