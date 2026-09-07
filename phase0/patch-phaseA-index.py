# -*- coding: utf-8 -*-
"""Phase A：版本化端点（versions 列表 + GET ?version + run 指定版本）"""
import io

p = "src/index.ts"
s = io.open(p, encoding="utf-8", newline="").read()
crlf = "\r\n" in s
if crlf: s = s.replace("\r\n", "\n")

if "versions$" in s:
    print("already"); raise SystemExit

# 1) versions 列表端点 + GET 支持 ?version
old = """    if ((m = p.match(/^\\/api\\/workflows\\/([^/]+)$/))) {
      const id = m[1];
      if (method === 'GET') {
        const def = await storage.workflows.get(id);
        return def ? json(res, 200, def) : json(res, 404, { error: 'not found' });
      }"""
new = """    // Phase A（§4/§24）：版本快照列表——历史 Version 可枚举、可还原、可指定运行
    if ((m = p.match(/^\\/api\\/workflows\\/([^/]+)\\/versions$/)) && method === 'GET') {
      const id = m[1];
      const all = await storage.workflowVersions.list();
      const versions = all
        .filter(v => v.workflowId === id)
        .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
        .map(v => ({
          revision: v.revision,
          savedAt: v.savedAt,
          name: v.def?.name,
          nodeCount: v.def?.nodes?.length ?? 0,
          edgeCount: v.def?.edges?.length ?? 0,
        }));
      return json(res, 200, versions);
    }
    if ((m = p.match(/^\\/api\\/workflows\\/([^/]+)$/))) {
      const id = m[1];
      if (method === 'GET') {
        // Phase A：?version=N 返回指定历史版本快照（§24：Run with Version N）
        const qv = url.searchParams.get('version');
        if (qv) {
          const snap = await storage.workflowVersions.get(`${id}__v${qv}`);
          return snap?.def ? json(res, 200, snap.def) : json(res, 404, { error: 'version not found' });
        }
        const def = await storage.workflows.get(id);
        return def ? json(res, 200, def) : json(res, 404, { error: 'not found' });
      }"""
assert old in s, "wf-get"
s = s.replace(old, new, 1)

# 2) run 支持 version 参数
old = """    if ((m = p.match(/^\\/api\\/workflows\\/([^/]+)\\/run$/)) && method === 'POST') {
      const def = await storage.workflows.get(m[1]);
      if (!def) return json(res, 404, { error: 'workflow not found' });
      const body = await readBody<{ input?: string; fields?: Record<string, unknown> }>(req);"""
new = """    if ((m = p.match(/^\\/api\\/workflows\\/([^/]+)\\/run$/)) && method === 'POST') {
      const body = await readBody<{ input?: string; fields?: Record<string, unknown>; version?: number | string }>(req);
      // Phase A（§24）：指定 version 时用该历史版本运行，否则用最新
      let def: WorkflowDefinition | null = null;
      if (body.version != null) {
        const snap = await storage.workflowVersions.get(`${m[1]}__v${body.version}`);
        def = snap?.def ?? null;
      } else {
        def = await storage.workflows.get(m[1]);
      }
      if (!def) return json(res, 404, { error: 'workflow not found' });"""
assert old in s, "run"
s = s.replace(old, new, 1)

if crlf: s = s.replace("\n", "\r\n")
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("index patched")
