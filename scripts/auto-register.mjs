/**
 * postinstall 脚本：自动将本插件注册到 DSH profile 的 bundles 数组。
 *
 * 当用户在 DSH profile 目录中运行 `pnpm add @mappyj/dsh-plugin-workflow` 时，
 * npm/pnpm 会将 INIT_CWD 设为该目录，此脚本读取其中的 package.json，
 * 检查 dsh.profile.bundles 是否包含本插件，如没有则自动添加。
 *
 * 环境变量要求：
 *   INIT_CWD — npm/pnpm 在 lifecycle script 中自动设置，指向用户执行 install 的目录。
 *   若不设（如直接 node 运行），则静默跳过，不报错。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const PACKAGE_NAME = '@mappyj/dsh-plugin-workflow';

function tryRegister() {
  const initCwd = process.env.INIT_CWD;
  if (!initCwd) {
    // 非 install 场景（如直接运行脚本），静默跳过
    return;
  }

  const pkgPath = resolve(initCwd, 'package.json');
  if (!existsSync(pkgPath)) {
    console.warn(`[dsh-plugin-workflow] 未找到 package.json: ${pkgPath}，跳过自动注册`);
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    console.warn(`[dsh-plugin-workflow] 无法解析 package.json: ${pkgPath}，跳过自动注册`);
    return;
  }

  // 检查是否为 DSH profile（必须有 dsh.profile.bundles）
  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) {
    // 不是 DSH profile，静默跳过
    return;
  }

  if (bundles.includes(PACKAGE_NAME)) {
    // 已注册，无需操作
    return;
  }

  bundles.push(PACKAGE_NAME);
  pkg.dsh.profile.bundles = bundles;

  try {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log(`[dsh-plugin-workflow] ✅ 已自动注册到 ${basename(initCwd)} profile 的 bundles`);
  } catch (e) {
    console.warn(`[dsh-plugin-workflow] 自动注册失败: ${e?.message ?? e}`);
  }
}

tryRegister();