/**
 * Working Directory 安全边界校验（§36 / Phase 8）。
 *
 * Agent 默认只能访问 Working Directory 及其允许的子目录；
 * 本模块在保存/运行前校验目录合法性，拒绝危险的根目录与系统目录。
 */

export interface WorkspaceIssue {
  code: string;
  message: string;
}

export interface WorkspaceValidation {
  errors: WorkspaceIssue[];
  warnings: WorkspaceIssue[];
}

/** Windows 系统敏感目录（小写、不带尾斜杠）前缀黑名单 */
const SYSTEM_DIR_PREFIXES = [
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/programdata',
  'c:/users',
  '/windows',
  '/program files',
  '/program files (x86)',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/sys',
  '/proc',
  '/dev',
];

/** 归一化：统一斜杠、去尾斜杠（保留根）、小写用于比较 */
function normalize(dir: string): string {
  const d = dir.trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\/$/.test(d)) return d.toLowerCase();
  if (d === '/') return '/';
  return d.replace(/\/+$/, '').toLowerCase();
}

export function validateWorkspaceDir(dir: string | undefined | null): WorkspaceValidation {
  const errors: WorkspaceIssue[] = [];
  const warnings: WorkspaceIssue[] = [];

  if (!dir || !String(dir).trim()) {
    // §32：Workflow 必须绑定 Working Directory——但历史工作流可能没有，降级为警告
    warnings.push({ code: 'workspace_missing', message: '工作流未绑定 Working Directory：Agent 将没有本地工作区，代码/文档类任务建议在设置中指定' });
    return { errors, warnings };
  }

  const raw = String(dir).trim();
  const norm = normalize(raw);

  // 相对路径：无法保证 Agent 工作位置一致
  if (!/^[a-zA-Z]:\//.test(norm) && !norm.startsWith('/')) {
    warnings.push({ code: 'workspace_relative', message: `Working Directory "${raw}" 是相对路径，建议使用绝对路径（如 D:/project）` });
    return { errors, warnings };
  }

  // 根目录（C:/ D:/ 或 /）绝不允许：§36 不要默认开放整个盘符
  if (/^[a-zA-Z]:\/$/.test(norm) || norm === '/') {
    errors.push({ code: 'workspace_root', message: `Working Directory 不能是盘符根目录（${raw}）：Agent 会获得整盘访问能力，请指定具体项目子目录` });
    return { errors, warnings };
  }

  // 系统目录黑名单：任意盘符的第二段目录名（Windows/Program Files 等）+ Unix 前缀
  const seg2 = norm.match(/^[a-z]:\/([^/]+)/);
  const winSystemNames = ['windows', 'program files', 'program files (x86)', 'programdata', 'users', 'system volume information', '$recycle.bin'];
  const driveSystemHit = seg2 && winSystemNames.includes(seg2[1]);
  const hit = SYSTEM_DIR_PREFIXES.find(p => norm === p || norm.startsWith(p + '/'));
  if (driveSystemHit || hit) {
    errors.push({ code: 'workspace_system', message: `Working Directory 不能位于系统目录（${raw}）：违反 §36 安全边界，请使用独立的开发目录` });
    return { errors, warnings };
  }

  return { errors, warnings };
}
