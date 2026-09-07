import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ArtifactManager, recordAgentArtifact, humanEditArtifact,
  approvedArtifactOf, artifactVersions, INLINE_LIMIT,
} from '../src/engine/artifact-manager.js';
import { lineDiff, renderUnifiedDiff } from '../src/engine/diff.js';
import { defaultSettings, type Artifact, type ExecutionState, type WorkflowDefinition } from '../src/domain/types.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'art-test-'));

function emptyState(): ExecutionState {
  return {
    executionId: 'exec_art', workflowId: 'wf_art', workflowVersion: 1,
    status: 'running', startedAt: new Date().toISOString(), stepCount: 0,
    nodeRunCount: {}, loopCount: {}, nodeStates: {}, outputs: {},
    artifacts: {}, reviewTasks: [], auditLog: [], pendingFeedback: {},
    humanTasks: [], edgeState: {},
  };
}

describe('ArtifactManager.create/read（任务 5：多类型 + 引用存储）', () => {
  it('小文本 → inline 存储，content 全文保留', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const a = await mgr.create({ executionId: 'e1', nodeId: 'a', kind: 'markdown', content: '# Hello', createdBy: 'agent' });
    expect(a.storage).toBe('inline');
    expect(a.kind).toBe('markdown');
    expect(a.type).toBe('markdown');   // 兼容字段同步
    expect(a.content).toBe('# Hello');
    expect(a.version).toBe(1);
    expect(await mgr.read(a)).toBe('# Hello');
  });

  it('大文本（>64KB）→ reference 存储，JSON 只有摘要', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const big = 'x'.repeat(INLINE_LIMIT + 1024);
    const a = await mgr.create({ executionId: 'e1', nodeId: 'a', kind: 'text', content: big, createdBy: 'agent' });
    expect(a.storage).toBe('reference');
    expect(a.storageRef?.kind).toBe('file');
    expect(a.content.length).toBeLessThan(big.length);   // §55.2：不塞全文
    expect(a.content).toContain('storageRef');
    // 磁盘真实存在且完整可读
    const disk = await fs.readFile(a.storageRef!.path, 'utf8');
    expect(disk.length).toBe(big.length);
    expect(await mgr.read(a)).toBe(big);
    expect(a.storageRef!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('显式文件 → 复制进管理区并登记引用', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const src = path.join(tmp, 'src-report.txt');
    await fs.writeFile(src, 'REPORT-BODY-12345');
    const a = await mgr.create({ executionId: 'e2', nodeId: 'n', kind: 'file', sourcePath: src, createdBy: 'human' });
    expect(a.storage).toBe('reference');
    expect(a.storageRef!.fileName).toBe('src-report.txt');
    expect(a.storageRef!.path).toContain(path.join('artifacts', 'e2', a.id));
    expect(a.content).toContain('file:src-report.txt');
    expect(await mgr.read(a)).toBe('REPORT-BODY-12345');
  });

  it('目录 Workspace → directory 类型，read 返回清单', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const ws = path.join(tmp, 'workspace');
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'main.ts'), 'const x = 1;');
    const a = await mgr.create({ executionId: 'e3', nodeId: 'n', kind: 'directory', content: ws, directory: true, createdBy: 'agent' });
    expect(a.kind).toBe('directory');
    expect(a.storage).toBe('reference');
    expect(a.storageRef!.kind).toBe('directory');
    const listing = await mgr.read(a);
    expect(listing).toContain('main.ts');
  });
});

describe('ArtifactManager 版本链：update / versions / diff / restore', () => {
  async function chain() {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const state = emptyState();
    const v1 = await mgr.create({ executionId: 'ev', nodeId: 'w', kind: 'markdown', content: 'v1 原始输出', createdBy: 'agent' });
    state.artifacts.w = [v1];
    return { mgr, state, v1 };
  }

  it('update 追加新版本不覆盖原始输出（Original → Edited）', async () => {
    const { mgr, state, v1 } = await chain();
    const v2 = await mgr.update({ executionId: 'ev', prev: v1, content: 'v2 人工编辑', reviewComment: '改了结论' });
    state.artifacts.w.push(v2);
    expect(v2.version).toBe(2);
    expect(v2.parentVersion).toBe(1);
    expect(v2.createdBy).toBe('human');
    expect(v2.reviewComment).toBe('改了结论');
    // 原始输出未被覆盖
    expect(state.artifacts.w[0].content).toBe('v1 原始输出');
    expect(mgr.versions(state, 'w')).toHaveLength(2);
  });

  it('diff 产生行级差异', async () => {
    const { mgr, state, v1 } = await chain();
    const v2 = await mgr.update({ executionId: 'ev', prev: v1, content: 'v1 原始输出改过' });
    state.artifacts.w.push(v2);
    const d = await mgr.diff(v1, v2);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
    expect(renderUnifiedDiff(d)).toContain('-');
    expect(renderUnifiedDiff(d)).toContain('+');
  });

  it('restore 到旧版本：以新人工版本追加，下游拿到恢复内容', async () => {
    const { mgr, state, v1 } = await chain();
    const v2 = await mgr.update({ executionId: 'ev', prev: v1, content: 'v2 坏版本' });
    state.artifacts.w.push(v2);
    const v3 = await mgr.restore(state, 'w', 1);
    state.artifacts.w.push(v3);
    expect(v3.version).toBe(3);
    expect(v3.parentVersion).toBe(2);
    expect(v3.createdBy).toBe('human');
    expect(v3.reviewComment).toContain('恢复到 v1');
    expect(await mgr.read(v3)).toBe('v1 原始输出');
    // 链上三个版本都在（不可变）
    expect(state.artifacts.w.map(a => a.version)).toEqual([1, 2, 3]);
  });

  it('restore 不存在的版本报错', async () => {
    const { mgr, state } = await chain();
    await expect(mgr.restore(state, 'w', 99)).rejects.toThrow(/不存在版本/);
  });

  it('大文本版本链：diff 走磁盘引用（>64KB 落盘）', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    // 1500 行 × ~50 字符 ≈ 75KB（超过 INLINE_LIMIT），且在 LCS 上限内
    const big1 = Array.from({ length: 1500 }, (_, i) => `line ${i}: ${'payload data here '.repeat(2)}`).join('\n') + '\ntail-A';
    const big2 = big1.replace('tail-A', 'tail-B');
    expect(Buffer.byteLength(big1)).toBeGreaterThan(INLINE_LIMIT);
    const a = await mgr.create({ executionId: 'eb', nodeId: 'n', kind: 'text', content: big1, createdBy: 'agent' });
    expect(a.storage).toBe('reference');   // 确实走了引用存储
    const b = await mgr.update({ executionId: 'eb', prev: a, content: big2 });
    const d = await mgr.diff(a, b);
    expect(d.degraded).toBe(false);
    expect(d.removed).toBe(1);   // 只有 tail 行不同（其余 1500 行 LCS 命中 same）
    expect(d.added).toBe(1);
  });

  it('超规模文本降级为整段替换（不卡死）', () => {
    const lines = Array.from({ length: 3000 }, () => 'x');
    const big = lines.join('\n');
    const d = lineDiff(big, big.replace('x', 'y'));
    expect(d.degraded).toBe(true);
    expect(d.removed).toBe(3000);
  });
});

describe('第一阶段兼容接口（100 测试不破坏）', () => {
  it('recordAgentArtifact / humanEditArtifact 保持旧行为 + 新字段', () => {
    const state = emptyState();
    state.outputs.a = [{ runIndex: 1, content: 'old', durationMs: 1, finishedAt: '' }];
    const v1 = recordAgentArtifact(state, 'a', 'markdown', 'v1');
    expect(v1.version).toBe(1);
    expect(v1.kind).toBe('markdown');
    expect(v1.storage).toBe('inline');
    const v2 = humanEditArtifact(state, 'a', 'v2-edited', '意见');
    expect(v2.version).toBe(2);
    expect(v2.parentVersion).toBe(1);
    expect(approvedArtifactOf(state, 'a')!.content).toBe('v2-edited');
    expect(artifactVersions(state, 'a')).toHaveLength(2);
    // 下游 outputs 同步为编辑后内容（§72 兼容行为）
    expect(state.outputs.a.at(-1)!.content).toBe('v2-edited');
  });

  it('humanEditArtifact 在无产出时报错（保持旧契约）', () => {
    const state = emptyState();
    expect(() => humanEditArtifact(state, 'ghost', 'x')).toThrow(/尚无 Agent 产出/);
  });
});

describe('lineDiff 基础', () => {
  it('相同文本无差异', () => {
    expect(lineDiff('a\nb', 'a\nb').ops).toHaveLength(0);
  });
  it('插入/删除行统计正确', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
    expect(d.ops.some(o => o.type === 'del' && o.text === 'b')).toBe(true);
    expect(d.ops.some(o => o.type === 'add' && o.text === 'x')).toBe(true);
  });
});
