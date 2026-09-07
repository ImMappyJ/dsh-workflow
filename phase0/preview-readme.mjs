/**
 * preview-readme.mjs —— 本地双语 README 预览服务。
 *
 * 用途：在浏览器中真实渲染 README.md / README.zh-CN.md，
 *       验证顶部「简体中文 / English」互跳与 [MIT](LICENSE) 链接是否可用。
 *       （单文件预览器托管的是单个文件，相对链接必然 Not Found；
 *        GitHub 上同目录相对链接则正常。本服务模拟同目录多文件环境。）
 *
 * 用法：node phase0/preview-readme.mjs [port]
 *   port 默认 3079（避开插件常用 3080/3081/3090）
 *
 * 路由：
 *   /                  → README.md（渲染）
 *   /README.md         → 渲染
 *   /README.zh-CN.md   → 渲染
 *   /LICENSE 等        → 纯文本
 */
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] ?? 3079);
const HOST = '127.0.0.1';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const page = (title, mdSource) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css">
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<style>
  body { margin: 0; padding: 32px 16px; background: #f6f8fa; }
  .markdown-body { max-width: 980px; margin: 0 auto; padding: 40px 48px; background: #fff; border-radius: 8px; box-sizing: border-box; }
  #fallback { display: none; color: #9a6700; padding: 8px 0; }
</style>
</head>
<body>
<div class="markdown-body">
  <div id="fallback">⚠ marked CDN 加载失败（无外网？），显示纯文本：</div>
  <pre id="src" style="display:none">${esc(mdSource)}</pre>
  <div id="out"></div>
</div>
<script>
  window.addEventListener('load', () => {
    if (window.marked) {
      document.getElementById('out').innerHTML = marked.parse(document.getElementById('src').textContent);
    } else {
      document.getElementById('fallback').style.display = 'block';
      const pre = document.getElementById('src');
      pre.style.display = 'block'; pre.style.whiteSpace = 'pre-wrap';
    }
  });
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel) rel = 'README.md';
    // 只允许根目录内的文件名（不含路径分隔，防目录穿越）
    if (rel.includes('/') || rel.includes('\\') || rel.includes('..')) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const file = path.join(ROOT, rel);
    const src = await fs.readFile(file, 'utf-8'); // 不存在 → catch → 404
    if (rel.endsWith('.md')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(page(`${rel} · dsh-workflow`, src));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(src);
    }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[preview-readme] http://${HOST}:${PORT}/  （/README.md 与 /README.zh-CN.md 可互跳）`);
});
