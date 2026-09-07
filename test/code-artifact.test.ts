import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArtifactManager, INLINE_LIMIT } from '../src/engine/artifact-manager.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'code-art-'));

describe('ArtifactManager.createCode / readCodeFile（任务 5：多文件模型）', () => {
  it('创建 code Artifact：content 为文件清单，files 保留全文', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const a = await mgr.createCode({
      executionId: 'ec1', nodeId: 'coder',
      files: [
        { path: 'src/main.ts', content: 'const x = 1;\nconsole.log(x);', language: 'ts' },
        { path: 'README.md', content: '# hello', language: 'md' },
      ],
      createdBy: 'agent',
    });
    expect(a.kind).toBe('code');
    expect(a.version).toBe(1);
    expect(a.files).toHaveLength(2);
    expect(a.content).toContain('code workspace: 2 files');
    expect(a.content).toContain('src/main.ts');
    // inline 存储：全文在 files 里
    expect(a.files[0].content).toContain('console.log(x)');
    expect(a.files[0].storageRef).toBeUndefined();
    // 读取单文件
    expect(await mgr.readCodeFile(a, 'src/main.ts')).toContain('console.log(x)');
    expect(await mgr.readCodeFile(a, 'README.md')).toBe('# hello');
  });

  it('大文件自动落盘：files[].content 仅摘要，磁盘有真实文件', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const big = 'x'.repeat(INLINE_LIMIT + 100);
    const a = await mgr.createCode({
      executionId: 'ec2', nodeId: 'coder',
      files: [{ path: 'big.txt', content: big }],
      createdBy: 'agent',
    });
    const entry = a.files![0];
    expect(entry.storageRef).toBeDefined();
    expect(entry.content).toContain('[file:big.txt');
    expect(entry.content.length).toBeLessThan(big.length);
    // 磁盘真实可读且完整
    const disk = await fs.readFile(entry.storageRef!.path, 'utf8');
    expect(disk.length).toBe(big.length);
    expect(await mgr.readCodeFile(a, 'big.txt')).toBe(big);
  });

  it('路径净化：防止 path traversal', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const big = 'y'.repeat(INLINE_LIMIT + 50);
    const a = await mgr.createCode({
      executionId: 'ec3', nodeId: 'coder',
      files: [{ path: '../../evil.sh', content: big }],
      createdBy: 'agent',
    });
    // 落盘路径必须在管理区内（.. 段被剔除）
    const refPath = a.files![0].storageRef!.path;
    expect(refPath).toContain(path.join('artifacts', 'ec3'));
    expect(refPath.includes('..')).toBe(false);
    expect(path.resolve(refPath).startsWith(path.resolve(path.join(tmp, 'artifacts')))).toBe(true);
    // 读取时用净化后的相对路径
    await expect(mgr.readCodeFile(a, 'evil.sh')).resolves.toBe(big);
  });

  it('readCodeFile 不存在文件报错', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const a = await mgr.createCode({ executionId: 'ec4', nodeId: 'n', files: [{ path: 'a.ts', content: 'x' }], createdBy: 'agent' });
    await expect(mgr.readCodeFile(a, 'nope.ts')).rejects.toThrow(/不存在/);
  });
});

describe('updateCode / diffCode（验收场景 B：代码修改流）', () => {
  async function base() {
    const mgr = new ArtifactManager({ dataDir: tmp });
    const v1 = await mgr.createCode({
      executionId: 'ed1', nodeId: 'coder',
      files: [
        { path: 'src/app.ts', content: 'function add(a, b) {\n  return a + b;\n}' },
        { path: 'src/old.ts', content: 'deprecated' },
      ],
      createdBy: 'agent',
    });
    return { mgr, v1 };
  }

  it('updateCode 追加人工版本不覆盖原始（Original → Edited）', async () => {
    const { mgr, v1 } = await base();
    const v2 = await mgr.updateCode({
      executionId: 'ed1', prev: v1,
      files: [{ path: 'src/app.ts', content: 'function add(a, b) {\n  return a + b; // fixed\n}' }],
      reviewComment: '补了注释',
    });
    expect(v2.version).toBe(2);
    expect(v2.parentVersion).toBe(1);
    expect(v2.createdBy).toBe('human');
    expect(v2.reviewComment).toBe('补了注释');
    // 原始未被覆盖
    expect(v1.files![0].content).not.toContain('fixed');
  });

  it('diffCode：识别 added / removed / modified / unchanged', async () => {
    const { mgr, v1 } = await base();
    const v2 = await mgr.updateCode({
      executionId: 'ed1', prev: v1,
      files: [
        { path: 'src/app.ts', content: 'function add(a, b) {\n  return a + b; // fixed\n}' },   // modified
        { path: 'src/new.ts', content: 'export const y = 2;' },                                  // added
        // src/old.ts 被删除 → removed
      ],
    });
    const diffs = await mgr.diffCode(v1, v2);
    const byPath = Object.fromEntries(diffs.map(d => [d.path, d]));
    expect(byPath['src/app.ts'].status).toBe('modified');
    expect(byPath['src/app.ts'].added).toBe(1);
    expect(byPath['src/app.ts'].removed).toBe(1);
    expect(byPath['src/new.ts'].status).toBe('added');
    expect(byPath['src/old.ts'].status).toBe('removed');
  });

  it('diffCode：无变化文件标记 unchanged', async () => {
    const { mgr, v1 } = await base();
    const v2 = await mgr.updateCode({
      executionId: 'ed1', prev: v1,
      files: [
        { path: 'src/app.ts', content: v1.files![0].content },   // 一字未改
        { path: 'src/old.ts', content: v1.files![1].content },
      ],
    });
    const diffs = await mgr.diffCode(v1, v2);
    expect(diffs.every(d => d.status === 'unchanged')).toBe(true);
    expect(diffs.every(d => d.added === 0 && d.removed === 0)).toBe(true);
  });

  it('diffCode：大文件修改走磁盘读取', async () => {
    const mgr = new ArtifactManager({ dataDir: tmp });
    // 1400 行 × ~60 字符 ≈ 85KB > INLINE_LIMIT，且在 LCS 行数上限内；尾行差异验证行级 diff 有效。
    const body = Array.from({ length: 1400 }, (_, i) => `line ${i}: ${'code body '.repeat(5)}`).join('\n');
    const big = body + '\npayload-A';
    expect(Buffer.byteLength(big)).toBeGreaterThan(INLINE_LIMIT);
    const v1 = await mgr.createCode({ executionId: 'ed2', nodeId: 'n', files: [{ path: 'big.ts', content: big }], createdBy: 'agent' });
    expect(v1.files![0].storageRef).toBeDefined();   // 创建即落盘（§55.2）
    const v2 = await mgr.updateCode({ executionId: 'ed2', prev: v1, files: [{ path: 'big.ts', content: big.replace('payload-A', 'payload-B') }] });
    expect(v2.files![0].storageRef).toBeDefined();   // 大文件落盘
    const diffs = await mgr.diffCode(v1, v2);
    expect(diffs[0].status).toBe('modified');
    expect(diffs[0].added).toBe(1);
    expect(diffs[0].removed).toBe(1);
  });
});

describe('引擎 editCodeArtifact（验收场景 D：人工编辑后下游拿编辑版）', () => {
  it('编辑追加版本并同步下游 outputs', async () => {
    const { WorkflowEngine } = await import('../src/engine/engine.js');
    const { MockAgentRunner } = await import('../src/engine/runner.js');
    const { defaultSettings } = await import('../src/domain/types.js');

    const mkNode = (id: string, type: string) => ({
      id, type, name: id, position: { x: 0, y: 0 },
      identity: { name: id }, roleDescription: id,
      inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
      outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
      modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
      runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
      metadata: {},
    });
    const def: any = {
      version: '1.0', id: 'wf_code', name: 'code', createdAt: '', updatedAt: '',
      nodes: [mkNode('start', 'start'), mkNode('coder', 'agent'), mkNode('end', 'end')],
      edges: [['start', 'coder'], ['coder', 'end']].map(([s, t], i) => ({
        id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
        transform: { enabled: false, instruction: '' }, condition: null,
      })),
      settings: defaultSettings(), loops: [], layout: {},
    };
    const engine = new WorkflowEngine({ runner: new MockAgentRunner(), dataDir: tmp });
    const h = await engine.run(def, { text: 'write code' });
    await h.result;
    const execId = h.executionId;

    // coder 先有 Agent 版本；手动注入一个 code v1 便于走编辑流（模拟 Agent 产出 code）
    const state = engine.getExecution(execId)!;
    const v1 = await engine.artifacts.createCode({
      executionId: execId, nodeId: 'coder',
      files: [{ path: 'src/app.ts', content: 'const a = 1;' }], createdBy: 'agent',
    });
    state.artifacts.coder.push(v1);

    // 人工编辑 → v2
    const v2 = await engine.editCodeArtifact(execId, 'coder',
      [{ path: 'src/app.ts', content: 'const a = 1; // human edit' }], '我改了代码');
    expect(v2.version).toBeGreaterThan(v1.version);
    expect(v2.createdBy).toBe('human');
    expect(state.artifacts.coder.map(a => a.version)).toContain(v2.version);
    // 下游 outputs 同步为文件清单（编辑版，§72）
    expect(state.outputs.coder.at(-1)!.content).toContain('src/app.ts');

    // 增量合并：只提交被修改的文件（其余 content 为 null），未修改文件从上一版回填；可新增文件（§72）
    const v3 = await engine.editCodeArtifact(execId, 'coder',
      [
        { path: 'src/app.ts', content: null as any },                    // 未修改 → 回填 v2 内容（含 human edit）
        { path: 'src/util.ts', content: 'export const u = 2;' },        // 人工新增文件
      ], '新增 util');
    expect(v3.files!.map(f => f.path).sort()).toEqual(['src/app.ts', 'src/util.ts']);
    // 未提交的文件沿用上一版内容（含人工注释），新文件落盘可读。
    const app = await engine.artifacts.readCodeFile(v3, 'src/app.ts');
    expect(app).toContain('human edit');
    const util = await engine.artifacts.readCodeFile(v3, 'src/util.ts');
    expect(util).toContain('export const u = 2');
    // diff v2→v3：util 新增、app 未变
    const d = await engine.artifacts.diffCode(v2, v3);
    expect(d.find(f => f.path === 'src/util.ts')?.status).toBe('added');
    expect(d.find(f => f.path === 'src/app.ts')?.status).toBe('unchanged');

    // 无 code 版本的节点编辑报错
    await expect(engine.editCodeArtifact(execId, 'start', [{ path: 'x', content: '' }]))
      .rejects.toThrow(/无 code Artifact/);
  }, 15_000);
});
