import { defineConfig } from 'vitest/config';

/**
 * 全局测试超时放宽：Phase A 后终态快照含 defSnapshot，写盘+轮询在并行负载下可能超过默认 5s。
 * 设 30s 消除负载相关 flaky（各测试内部仍有自己的轮询上限）。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
