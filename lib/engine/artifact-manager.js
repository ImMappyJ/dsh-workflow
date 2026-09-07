/**
 * ArtifactManager（§64-65 + 第二阶段任务 5）—— Artifact 主数据管理。
 *
 * 核心原则：
 * 1. 人工修改不覆盖原始输出，形成 Original → Edited → Final 的版本链；
 *    下游拿到的永远是"最新已批准版本"（§72）。
 * 2. Artifact 反转为主数据：Agent 输出 = Artifact[]；文本类 Artifact 的
 *    content 是其 inline 形态（§55.4：Artifact 不设计成 string）。
 * 3. 大内容只存 Reference（§55.2）：超过 INLINE_LIMIT 的文本或显式文件
 *    落盘到 {dataDir}/artifacts/{executionId}/{artifactId}/，JSON 里只留
 *    storageRef + 摘要。
 *
 * 兼容：第一阶段自由函数（recordAgentArtifact/humanEditArtifact/
 * approvedArtifactOf/artifactVersions）保留签名，引擎与 review-manager
 * 无需改动即可继续工作。
 */
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { kindFromLegacyType, kindFromFormat, legacyTypeFromKind } from '../domain/types.js';
import { lineDiff } from './diff.js';
/** 超过该字节数的文本内容落盘为引用存储（~64KB） */
export const INLINE_LIMIT = 64 * 1024;
function now() {
    return new Date().toISOString();
}
function newId() {
    return `artifact_${randomUUID().slice(0, 8)}`;
}
/** 相对路径净化（防 path traversal）：剔除 .. 与空段，统一分隔符 */
function sanitizeRelPath(rel) {
    const parts = rel.replace(/\\/g, '/').split('/').filter(s => s && s !== '..' && s !== '.');
    return parts.length ? parts.join('/') : 'file';
}
export class ArtifactManager {
    dataDir;
    limit;
    constructor(opts = {}) {
        this.dataDir = opts.dataDir ?? path.join(os.homedir(), '.dsh', 'workflow-plugin');
        this.limit = opts.inlineLimit ?? INLINE_LIMIT;
    }
    artifactDir(executionId, artifactId) {
        return path.join(this.dataDir, 'artifacts', executionId, artifactId);
    }
    ext(kind) {
        switch (kind) {
            case 'markdown': return '.md';
            case 'json': return '.json';
            case 'code': return '.txt';
            case 'image': return '.bin';
            default: return '.txt';
        }
    }
    /**
     * 创建 Artifact（create）。Agent 产出或人工提交均走这里。
     * 大内容自动落盘转引用存储；调用方随后自行登记进 state 版本链，
     * 或直接用 registerText / registerFile 一步完成。
     */
    async create(params) {
        const id = newId();
        const artifact = {
            id,
            type: legacyTypeFromKind(params.kind),
            kind: params.kind,
            mimeType: params.mimeType,
            content: '',
            sourceNodeId: params.nodeId,
            version: params.version ?? 1,
            createdBy: params.createdBy,
            parentVersion: params.parentVersion ?? null,
            reviewComment: params.reviewComment ?? null,
            createdAt: now(),
        };
        // 形态 1：显式文件 / 目录 → 复制进管理区，引用存储
        if (params.sourcePath) {
            const stat = await fs.stat(params.sourcePath);
            const dest = this.artifactDir(params.executionId, id);
            await fs.mkdir(dest, { recursive: true });
            const fileName = path.basename(params.sourcePath);
            const destPath = path.join(dest, fileName);
            await fs.copyFile(params.sourcePath, destPath);
            const sha = createHash('sha256').update(await fs.readFile(destPath)).digest('hex');
            artifact.storage = 'reference';
            artifact.storageRef = {
                kind: params.directory ? 'directory' : 'file',
                path: destPath, sizeBytes: stat.size, sha256: sha,
                fileName, mimeType: params.mimeType,
            };
            artifact.content = `[file:${fileName} · ${stat.size} bytes]`; // 摘要，不塞全文
            return artifact;
        }
        // 形态 2：目录引用（Workspace：路径已存在，不复制）
        if (params.directory && params.content) {
            const p = params.content; // 目录绝对路径
            artifact.storage = 'reference';
            artifact.kind = 'directory';
            artifact.storageRef = { kind: 'directory', path: p };
            artifact.content = `[directory:${p}]`;
            return artifact;
        }
        // 形态 3：文本内容——小则 inline，大则落盘
        const text = params.content ?? '';
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > this.limit) {
            const dest = this.artifactDir(params.executionId, id);
            await fs.mkdir(dest, { recursive: true });
            const filePath = path.join(dest, `content${this.ext(params.kind)}`);
            await fs.writeFile(filePath, text, 'utf8');
            artifact.storage = 'reference';
            artifact.storageRef = {
                kind: 'file', path: filePath, sizeBytes: bytes,
                sha256: createHash('sha256').update(text).digest('hex'),
                fileName: `content${this.ext(params.kind)}`, mimeType: params.mimeType,
            };
            // 摘要：前 800 字符 + 省略提示
            artifact.content = text.slice(0, 800) + (text.length > 800 ? '\n…（内容过大，完整版见 storageRef）' : '');
            return artifact;
        }
        artifact.storage = 'inline';
        artifact.content = text;
        return artifact;
    }
    /** 读取完整内容（read）：inline 直接返回；reference 读磁盘 */
    async read(artifact) {
        if (artifact.storage !== 'reference' || !artifact.storageRef)
            return artifact.content;
        if (artifact.storageRef.kind === 'directory') {
            // 目录：返回文件清单摘要
            try {
                const entries = await fs.readdir(artifact.storageRef.path, { recursive: true });
                return `[directory:${artifact.storageRef.path}]\n${entries.slice(0, 200).join('\n')}`;
            }
            catch {
                return `[directory:${artifact.storageRef.path}]（不可读）`;
            }
        }
        return fs.readFile(artifact.storageRef.path, 'utf8');
    }
    // ---------------- code 多文件模型（任务 5 / 验收场景 B：代码修改流）----------------
    /**
     * 创建 code Artifact（多文件）。单个文件超过阈值自动落盘，
     * files[].content 只留摘要（§55.2）；artifact.content 为文件清单。
     */
    async createCode(params) {
        const id = newId();
        const entries = [];
        for (const f of params.files ?? []) {
            const rel = sanitizeRelPath(f.path);
            const bytes = Buffer.byteLength(f.content ?? '', 'utf8');
            const entry = { path: rel, content: f.content ?? '', language: f.language };
            if (bytes > this.limit) {
                const dest = path.join(this.artifactDir(params.executionId, id), 'files', ...rel.split('/'));
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, f.content ?? '', 'utf8');
                entry.storageRef = {
                    kind: 'file', path: dest, sizeBytes: bytes, fileName: rel,
                    sha256: createHash('sha256').update(f.content ?? '').digest('hex'),
                };
                entry.content = `[file:${rel} · ${bytes} bytes]`;
            }
            entries.push(entry);
        }
        const artifact = {
            id,
            type: 'plaintext',
            kind: 'code',
            content: `code workspace: ${entries.length} files\n` + entries.map(e => `- ${e.path}`).join('\n'),
            storage: 'inline',
            sourceNodeId: params.nodeId,
            version: params.version ?? 1,
            createdBy: params.createdBy,
            parentVersion: params.parentVersion ?? null,
            reviewComment: params.reviewComment ?? null,
            createdAt: now(),
            files: entries,
        };
        return artifact;
    }
    /** 读取 code Artifact 中单个文件的完整内容（inline 或磁盘） */
    async readCodeFile(artifact, filePath) {
        const rel = sanitizeRelPath(filePath);
        const entry = artifact.files?.find(f => f.path === rel);
        if (!entry)
            throw new Error(`文件不存在：${rel}`);
        if (entry.storageRef)
            return fs.readFile(entry.storageRef.path, 'utf8');
        return entry.content;
    }
    /** 更新 code Artifact（人工改文件 → 新版本，不覆盖原始输出） */
    async updateCode(params) {
        return this.createCode({
            executionId: params.executionId,
            nodeId: params.prev.sourceNodeId,
            files: params.files,
            createdBy: params.createdBy ?? 'human',
            reviewComment: params.reviewComment ?? null,
            version: params.prev.version + 1,
            parentVersion: params.prev.version,
        });
    }
    /**
     * code 版本对比（任务 5）：按文件集合 diff——added / removed / modified / unchanged，
     * modified 附行级结果；大文件走磁盘读取。
     */
    async diffCode(a, b) {
        const fa = new Map((a.files ?? []).map(f => [f.path, f]));
        const fb = new Map((b.files ?? []).map(f => [f.path, f]));
        const out = [];
        const allPaths = [...new Set([...fa.keys(), ...fb.keys()])];
        for (const p of allPaths) {
            const ea = fa.get(p), eb = fb.get(p);
            if (!ea && eb) {
                out.push({ path: p, status: 'added', added: (await this.readCodeFile(b, p)).split('\n').length, removed: 0 });
                continue;
            }
            if (ea && !eb) {
                out.push({ path: p, status: 'removed', added: 0, removed: (await this.readCodeFile(a, p)).split('\n').length });
                continue;
            }
            const [ta, tb] = await Promise.all([this.readCodeFile(a, p), this.readCodeFile(b, p)]);
            const d = lineDiff(ta, tb);
            out.push({
                path: p,
                status: d.ops.length ? 'modified' : 'unchanged',
                added: d.added, removed: d.removed,
                result: d.ops.length ? d : undefined,
            });
        }
        return out;
    }
    /**
     * 更新（update）：人工编辑产生新版本（不覆盖原始输出，§64）。
     * 返回新 Artifact；调用方负责 push 进版本链并同步下游 outputs。
     */
    async update(params) {
        return this.create({
            executionId: params.executionId,
            nodeId: params.prev.sourceNodeId,
            kind: params.prev.kind ?? kindFromLegacyType(params.prev.type),
            content: params.content,
            createdBy: params.createdBy ?? 'human',
            reviewComment: params.reviewComment ?? null,
            version: params.prev.version + 1,
            parentVersion: params.prev.version,
            mimeType: params.prev.mimeType,
        });
    }
    /** 版本对比（diff） */
    async diff(a, b) {
        const [ta, tb] = await Promise.all([this.read(a), this.read(b)]);
        return lineDiff(ta, tb);
    }
    /** 版本链（version） */
    versions(state, nodeId) {
        return state.artifacts[nodeId] ?? [];
    }
    /**
     * 恢复到指定版本（restore）：不破坏不可变链——把目标版本内容
     * 作为新的人工版本追加（下游因此拿到被恢复的内容）。
     */
    async restore(state, nodeId, targetVersion) {
        const chain = state.artifacts[nodeId] ?? [];
        const target = chain.find(a => a.version === targetVersion);
        if (!target)
            throw new Error(`节点 ${nodeId} 不存在版本 v${targetVersion}`);
        const prev = chain.at(-1);
        if (!prev)
            throw new Error(`节点 ${nodeId} 无版本链`);
        const content = await this.read(target);
        return this.update({
            executionId: state.executionId,
            prev,
            content,
            createdBy: 'human',
            reviewComment: `恢复到 v${targetVersion}`,
        });
    }
}
// ============================================================
// 第一阶段兼容接口（引擎 / review-manager 沿用，签名不变）
// ============================================================
function registerArtifact(state, artifact) {
    (state.artifacts[artifact.sourceNodeId] ??= []).push(artifact);
}
/** Agent 产出：登记 v1 Artifact（同步版，仅文本类；兼容引擎调用） */
export function recordAgentArtifact(state, nodeId, type, content) {
    const versions = state.artifacts[nodeId] ??= [];
    const artifact = {
        id: newId(),
        type,
        kind: kindFromLegacyType(type),
        content,
        storage: 'inline',
        sourceNodeId: nodeId,
        version: 1,
        createdBy: 'agent',
        parentVersion: null,
        createdAt: now(),
    };
    versions.push(artifact);
    return artifact;
}
/**
 * 人工修改：追加 v+1 Artifact（createdBy=human），并把最新 output 记录的
 * content 替换为编辑后内容（下游因此拿到 Human Edited Artifact，§72）。
 */
export function humanEditArtifact(state, nodeId, content, comment = null) {
    const versions = state.artifacts[nodeId] ??= [];
    const prev = versions.at(-1);
    if (!prev)
        throw new Error(`节点 ${nodeId} 尚无 Agent 产出，无法编辑`);
    const artifact = {
        id: newId(),
        type: prev.type,
        kind: prev.kind ?? kindFromLegacyType(prev.type),
        content,
        storage: 'inline',
        sourceNodeId: nodeId,
        version: prev.version + 1,
        createdBy: 'human',
        parentVersion: prev.version,
        reviewComment: comment,
        createdAt: now(),
    };
    versions.push(artifact);
    // 同步下游可见内容：最新 output 记录替换为编辑后内容
    const outputs = state.outputs[nodeId];
    if (outputs?.length) {
        outputs[outputs.length - 1] = { ...outputs[outputs.length - 1], content };
    }
    return artifact;
}
/** 当前批准版本（最新版本） */
export function approvedArtifactOf(state, nodeId) {
    return state.artifacts[nodeId]?.at(-1) ?? null;
}
/** 版本链（含 Agent 原始与历次人工修改） */
export function artifactVersions(state, nodeId) {
    return state.artifacts[nodeId] ?? [];
}
export { kindFromFormat };
