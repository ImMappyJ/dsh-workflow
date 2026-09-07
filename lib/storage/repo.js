/**
 * JsonRepo —— 通用 JSON 文件仓库（详细设计 §9）。
 * 原子写（tmp + rename）；目录：{base}/{collection}/{id}.json
 * 历史保留上限 FIFO（ExecutionRepository 用）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
export class JsonRepo {
    dir;
    maxKeep;
    constructor(dir, maxKeep = 0) {
        this.dir = dir;
        this.maxKeep = maxKeep;
    }
    /** per-id 串行写锁：同一 id 的 save 排队执行，杜绝并发写同一目标文件（Windows rename 目标已存在会抛错） */
    writeLocks = new Map();
    file(id) {
        // 防 path traversal：id 只允许安全字符
        if (!/^[A-Za-z0-9_.-]+$/.test(id))
            throw new Error(`非法 id: ${id}`);
        return path.join(this.dir, `${id}.json`);
    }
    async init() {
        await fs.mkdir(this.dir, { recursive: true });
    }
    async save(item) {
        const prev = this.writeLocks.get(item.id) ?? Promise.resolve();
        const run = prev.then(async () => {
            await fs.mkdir(this.dir, { recursive: true });
            const target = this.file(item.id);
            const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(item, null, 2), 'utf8');
            // rename 目标已存在时（Windows）先删目标再重命名，确保终态快照总能覆盖启动标记
            try {
                await fs.rename(tmp, target);
            }
            catch {
                try {
                    await fs.unlink(target);
                }
                catch { /* 目标不存在 */ }
                await fs.rename(tmp, target);
            }
            if (this.maxKeep > 0)
                await this.evict();
            return item;
        });
        // 队列尾部保存错误引用，供后续 save 感知；单次失败不阻塞队列
        this.writeLocks.set(item.id, run.catch(() => { }));
        return run;
    }
    async get(id) {
        try {
            return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
        }
        catch {
            return null;
        }
    }
    async list() {
        let names;
        try {
            names = await fs.readdir(this.dir);
        }
        catch {
            return [];
        }
        const items = [];
        for (const n of names) {
            if (!n.endsWith('.json'))
                continue;
            try {
                items.push(JSON.parse(await fs.readFile(path.join(this.dir, n), 'utf8')));
            }
            catch { /* 跳过损坏文件 */ }
        }
        return items;
    }
    async remove(id) {
        const prev = this.writeLocks.get(id) ?? Promise.resolve();
        const run = prev.then(async () => {
            try {
                await fs.unlink(this.file(id));
                return true;
            }
            catch {
                return false;
            }
        });
        this.writeLocks.set(id, run.catch(() => false));
        return run;
    }
    /** FIFO 淘汰超出 maxKeep 的最旧文件（按 mtime） */
    async evict() {
        const names = (await fs.readdir(this.dir)).filter(n => n.endsWith('.json'));
        if (names.length <= this.maxKeep)
            return;
        const stats = await Promise.all(names.map(async (n) => ({
            name: n,
            mtime: (await fs.stat(path.join(this.dir, n))).mtimeMs,
        })));
        stats.sort((a, b) => a.mtime - b.mtime);
        for (const s of stats.slice(0, stats.length - this.maxKeep)) {
            try {
                await fs.unlink(path.join(this.dir, s.name));
            }
            catch { /* ignore */ }
        }
    }
}
export function createStorage(baseDir, maxExecutionsKeep = 50) {
    return {
        workflows: new JsonRepo(path.join(baseDir, 'workflows')),
        executions: new JsonRepo(path.join(baseDir, 'executions'), maxExecutionsKeep),
        presets: new JsonRepo(path.join(baseDir, 'presets')),
        templates: new JsonRepo(path.join(baseDir, 'templates')),
        workflowVersions: new JsonRepo(path.join(baseDir, 'workflow-versions')),
    };
}
