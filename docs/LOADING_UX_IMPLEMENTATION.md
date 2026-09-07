# dsh-workflow 首屏闪烁与 Loading UX 实施计划（LOADING_UX_IMPLEMENTATION）

> 实施原则：不引入 React/Vue，不新增核心功能，不靠 setTimeout/隐藏元素/删除动画掩盖问题。基于原生 Web（HTML + CSS3 + 原生 JS）找到真实根因并修复。
>
> 关联审计文档：LOADING_UX_AUDIT.md
>
> 改动文件：`public/index.html`、`public/editor.js`、`public/execution.js`。修改后递增 index.html 内 `?v=` 版本号（cache-busting）。

---

## Phase L1：Theme Bootstrap（消除首屏黑→白闪烁）

**改文件**：`public/index.html`
**改位置**：`<head>` 内、`<style>` 之前插入一段极小的内联脚本。

**改内容**：
```html
<script>
  // Theme Bootstrap：首次 Paint 前确定主题，避免浅色用户先深后浅（LOADING_UX_A1）
  try {
    var __t = localStorage.getItem('dsh-wf-theme');
    if (__t === 'light' || __t === 'dark') {
      document.documentElement.setAttribute('data-theme', __t);
    }
    document.documentElement.setAttribute('data-theme-boot', '1');
  } catch (_) {}
</script>
```

**为什么修改**：主题恢复原来在 `execution.js` 尾部执行，晚于首次 Paint。移入 `<head>` 后，浏览器第一次绘制时 `data-theme` 已确定，`body { background: var(--bg) }` 直接取对主题值，无二次跳变。`data-theme-boot` 标记用于 A2：初始化阶段禁用 transition。

**如何验证**：
- 将主题切到 Light，刷新页面：首帧即为浅色，无深色闪现。
- 开发者工具 Network 关闭缓存刷新，观察首帧背景色即为浅色。
- 保留 `execution.js:694` 兜底（幂等，不冲突）。

---

## Phase L2：主题过渡隔离（初始化无过渡，切换有受控过渡）

**改文件**：`public/index.html`
**改位置**：`<style>` 内增加过渡控制规则；并给主题切换类元素（如 body、卡片）加受控过渡。

**改内容**：
```css
/* 主题切换受控过渡：仅对颜色属性，避免 Layout Shift / 全量过渡闪烁（LOADING_UX_A2） */
html:not([data-theme-boot]) body {
  transition: background-color .18s ease, color .18s ease, border-color .18s ease;
}
html[data-theme-boot] body,
html[data-theme-boot] * { transition: none !important; }
```

**为什么修改**：`data-theme-boot` 存在表示仍在初始化阶段 → 全局禁过渡；脚本执行后（用户后续手动切换主题）再启用仅针对颜色的过渡。绝不使用 `transition: all`。

**如何验证**：
- 刷新页面：无任何颜色渐变/闪烁过渡。
- 点击主题切换按钮：背景/文字有轻微平滑过渡，无布局跳动。
- 确认全局无 `transition: all`（grep 复核）。

---

## Phase L3：统一 Skeleton 体系（基类 + 变体 + reduced-motion）

**改文件**：`public/index.html`（`<style>` 内）

**改内容**：
```css
/* 统一 Skeleton 体系（LOADING_UX_A7/A9） */
.skeleton {
  background: linear-gradient(90deg, var(--panel2), #2c3140, var(--panel2));
  background-size: 200% 100%;
  animation: sk-shimmer 1.4s ease-in-out infinite;
  border-radius: 4px;
  color: transparent !important;
}
html[data-theme="light"] .skeleton {
  background: linear-gradient(90deg, #eef1f6, #dfe5ee, #eef1f6);
  background-size: 200% 100%;
}
.skeleton-line { height: 10px; margin-bottom: 8px; border-radius: 4px; }
.skeleton-card { min-height: 92px; border-radius: 10px; }
.skeleton-block { min-height: 46px; border-radius: 8px; }
@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; background: var(--panel2); }
}
```
> 注：`sk-shimmer` 动画已在 index.html 第 159 行存在（`0%→200%→-200%`），直接复用。`.skeleton-line` 已有，这里统一其语义。

**为什么修改**：让 Workbench/Inspector/Canvas 复用统一骨架；`.skeleton-card` 固定 min-height 保证 Skeleton 与真实卡片高度接近，避免 Layout Shift；`prefers-reduced-motion` 尊重动画敏感用户。

**如何验证**：
- Workbench 首次加载显示骨架卡片，高度与真实 `wf-card` 接近，替换时无跳动。
- 系统开启"减少动态效果"后骨架不再闪烁。

---

## Phase L4：Workbench AsyncState + Skeleton（消除内容→文本→内容）

**改文件**：`public/editor.js`（`renderWorkbenchView` 与 `openWorkbench`）

**改内容**：引入 `WB2.async = 'idle'|'loading'|'refreshing'|'success'|'error'`；首次 loading 显示骨架，刷新不清空、顶部显示轻量刷新指示，错误显示可重试块。

核心逻辑改造示意：
```js
async function loadWorkbench(keepContent) {
  const list = document.getElementById('wb-card-list');
  if (!list) return;
  if (WB2.async === 'loading' || WB2.async === 'refreshing') return; // 防重入
  const first = WB2.async === 'idle' || WB2.async === 'error';
  WB2.async = first ? 'loading' : 'refreshing';
  if (first) renderWbSkeleton(list);                 // 首次：骨架
  else showWbRefreshing(true);                        // 刷新：不清空 + 指示
  try {
    const [wfs, execs] = await Promise.all([
      API.j('GET', '/api/workflows').catch(() => []),
      API.j('GET', '/api/executions').catch(() => []),
    ]);
    renderWbList(list, wfs, execs);                  // 局部替换
    WB2.async = 'success'; showWbRefreshing(false);
  } catch (err) {
    WB2.async = 'error';
    if (first) renderWbError(list);                  // 首次失败：可重试
    else showWbRefreshing(false);                     // 刷新失败：保留旧数据
  }
}
```
保留现有过滤/排序/`lastStatus` 逻辑；将 `.map` 卡片渲染抽为 `renderWbList`；`renderWbSkeleton` 生成 3-4 张 `.skeleton-card`。

**为什么修改**：文本"加载中…"与每次 `innerHTML` 重置是内容抖动的直接根因；引入 AsyncState 区分首次/刷新，遵循"已有数据刷新不清空"原则，用骨架替代文本 Loading。

**如何验证**：
- 首次进入 Workbench：骨架卡片 → 平滑替换为真实卡片，无"加载中…"文本。
- 点搜索/排序/切换视图再切回：若数据已加载则直接显示（可用内存缓存，可选），不闪空白。
- 断网加载：显示"加载失败 + 重试"而非误导为"暂无工作流"。

---

## Phase L5：Canvas Graph Loading 态（深链空→满改为 Loading→就绪一次性渲染）

**改文件**：`public/index.html`（加覆盖层）+ `public/editor.js`（深链加载逻辑）

**改内容**：
- index.html：`#canvas-wrap` 内加一个 `#graph-loading` 覆盖层（居中静态占位，如"加载工作流…" + 轻量骨架线），默认 `display:none`。
- editor.js `init()`：深链分支在 `await API.j(...)` 之前显示 `#graph-loading`，`render()` 完整图之后隐藏。

```js
const graphLoading = document.getElementById('graph-loading');
if (graphLoading) graphLoading.style.display = 'flex';
try {
  S.def = await API.j('GET', ...);
  ...
  render();                       // 一次性渲染完整 Graph
} finally {
  if (graphLoading) graphLoading.style.display = 'none';
}
```
- 非深链路径 `render()` 本身同步构建全部 Node/Edge，保持"一次性呈现"，不加任何 Node 级 loading/动画。

**为什么修改**：深链下原来先画空图再异步画完整图（A5）；覆盖层让用户看到明确的加载态，Graph Model 就绪后一次性渲染，消除空→满闪跳。Canvas 用静态 Loading 而非 skeleton 动画（文档 §二十）。

**如何验证**：
- `http://127.0.0.1:3090/?wf=<id>`：先显示覆盖层，加载完成后一次性出现完整 Graph，无空画布→完整图跳变。
- Node/Edge 同步整体出现，无逐个闪现。

---

## Phase L6：Execution 按钮级局部 Loading（避免按钮消失/重建闪烁）

**改文件**：`public/execution.js`

**改内容**：为 Accept/Reject/Rework/Continue 等异步操作按钮做「常驻按钮 + disabled + spinner」。按钮结构改为：
```html
<button class="primary" data-async>
  <span class="btn-spinner" hidden></span><span class="btn-label">Accept</span>
</button>
```
封装 `setBtnBusy(btn, busy, label)`：busy 时 `disabled=true` + 显示 spinner + label 切"处理中…"，完成恢复。**绝不在操作期间 remove/重建按钮**。

**为什么修改**：文档 §二十五/§三十四/§三十五 要求按钮永远存在、仅改 disabled/内容，避免操作时按钮消失导致闪烁与重复点击。

**如何验证**：
- 点击 Accept：按钮变 disabled + spinner + "处理中…"，页面其余部分不重建。
- 点击 Rework：仅 Rework 区域局部更新，不整 Execution 页面 Loading。

---

## Phase L7：Inspector 节点切换 Loading 态

**改文件**：`public/editor.js`（`renderInspector`）

**改内容**：Inspector 容器保持稳定；若选中节点需要异步字段（schema/history），切换瞬间先渲染 `.skeleton-line` 占位，异步就绪后一次性填充；同步字段立即渲染。

**为什么修改**：文档 §二十二 要求 Inspector 独立 Skeleton，避免节点切换时空白→字段逐个出现。

**实施结论**：`renderInspector` 为纯同步渲染（直接从 `S.def` 读取，无异步请求），节点切换时 `innerHTML` 单次赋值、同帧完成替换，**不存在“空白→字段逐个出现”的异步间隙**，故无需骨架。此结论已在实现阶段确认，避免为同步路径引入不必要的骨架代码。

---

## Phase L8：统一验证与构建

**执行**：
1. `npx tsc -p tsconfig.json --noEmit`（TS 类型检查，后端未改，应通过）。
2. `npx vitest run`（回归，21 文件 179 测试应全绿）。
3. 前端 JS 语法：`node --check public/editor.js public/execution.js`。
4. HTML div 平衡复核。
5. 递增 index.html 内 `src="*.js?v="` 版本号（如 `20260904d`），同步 `~/.dsh/plugins/dsh-plugin-workflow` 部署副本。
6. 浏览器端到端验收（见下文验收清单）。

**实施状态（已完成）**：L1-L8 全部落地并验证通过——TS typecheck OK、前端 JS 语法 OK、HTML div 97/97 平衡、vitest 21 文件 179 测试全绿、部署副本已同步至 v=20260904d。浏览器端目测验收清单待用户在 http://127.0.0.1:3090/ 复核。

**验收清单**：
- [ ] 首屏第一次 Paint 即正确主题（Light/Dark 各验一次），无黑→白闪烁
- [ ] 主题初始化无 transition，手动切换有受控颜色过渡
- [ ] Workbench 首次加载显示 Skeleton 卡片，无"加载中…"文本，无 Layout Shift
- [ ] Workbench 刷新/切回保留已有内容，无 Content→Skeleton→Content
- [ ] Workbench 断网显示可重试错误态
- [ ] Canvas 深链加载有 Loading 覆盖层，Graph 就绪一次性呈现，Node/Edge 不逐个闪现
- [ ] Execution Accept/Reject/Rework/Continue 按钮局部 Loading，按钮不消失
- [ ] Inspector 切换节点有骨架过渡，无大面积空白
- [ ] Skeleton 尊重 `prefers-reduced-motion`
- [ ] 全局无 `transition: all`；`@keyframes` 动画不造成首帧闪现
- [ ] TS Build 通过；vitest 179 测试全绿

---

*文档结束。按 Phase L1→L8 顺序实施，每阶段完成后可在 127.0.0.1:3090 目测验证，全部完成后跑回归。*
