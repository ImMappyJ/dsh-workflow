/**
 * 独立启动 dsh-plugin-workflow 后端（mock 模式，脱离 DSH 宿主 GUI）。
 * 提供：完整 HTTP API + SSE + 真实 public/ 前端。
 * 用途：真机级验证（Timeline / Contextual Action / Human Input 审核流）。
 *
 * 用法：node phase0/launch-server.mjs [port] [dataDir]
 *   port    默认 3090
 *   dataDir 默认 phase0/.wf-data（隔离，不污染真实 workflow-plugin 数据）
 */
import { createWorkflowServer } from '../lib/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 3090);
const dataDir = process.argv[3] ?? path.join(__dirname, '.wf-data');

const server = createWorkflowServer({
    mock: true,
    port,
    host: '127.0.0.1',
    dataDir,
});

console.log(`[launch-server] workflow backend UP (mock) http://127.0.0.1:${port}/`);
console.log(`[launch-server] dataDir: ${dataDir}`);
console.log(`[launch-server] health:  http://127.0.0.1:${port}/api/health`);

// 优雅退出
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
