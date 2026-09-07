# dsh-workflow 首屏闪烁与 Loading UX 审计（LOADING_UX_AUDIT）

> 审计范围：现有 `dsh-workflow`（原生 HTML + TypeScript + CSS3，非 React/Vue）的首屏闪烁、组件闪烁、主题初始化、异步 Loading、DOM 渲染与 Layout Shift 治理。
>
> 审计方法：静态代码走查 `public/index.html`、`public/editor.js`、`public/execution.js`、`public/layout.js`，不启动浏览器即锁定根因。每项按「问题 → 根因 → 影响 → 修复方案」记录。
>
> 关联实施文档：LOADING_UX_IMPLEMENTATION.md

---

## 一、全局现状概览

| 维度 | 现状 | 结论 |
|------|------|------|
| CSS 架构 | 全部内联于 `index.html` `<style>`，双主题靠 `html[data-theme="light"]` 覆盖 `:root` 变量 | 结构清晰，可在此上做 Theme Bootstrap |
| 主题默认值 | `:root` 默认**深色**（`--bg:#17191e`），浅色为覆盖 | **浅色用户刷新时首帧会先深后浅** |
| `body` 背景 | `body { background: var(--bg); }`（已用变量，非硬编码黑） | 方向正确，但变量取值取决于 `data-theme` 是否已就位 |
| 全局 transition | **无** `* { transition: all }`，仅 4 处针对性 `transition`（btn-mode-toggle、exec-resize、node rect filter、wf-card） | **良好**，不需大面积整改 |
| Skeleton | 仅 `.skeleton-line` 一个类（exec-loading 内 3 行），有 `@keyframes sk-shimmer` 但未形成统一体系 | 需扩展为统一 `.skeleton` 基类 + 变体 |
| `prefers-reduced-motion` | 无 | 缺失，需补 |
| Loading 文本 | Workbench 用 `加载中…` 纯文本 | 需升级为 Skeleton |
| DOM 重建 | Workbench 列表 `innerHTML` 全量替换 | 需稳定容器 + 局部更新 |

---

## 二、审计项清单

### A1. 主题初始化晚于首次 Paint —— 首屏黑→白闪烁（最高优先）

**问题**：浅色主题用户打开页面，先出现深色背景，再跳变浅色。

**根因**：主题恢复逻辑位于 `execution.js` 尾部：

```js
// execution.js:694（应用脚本加载之后才执行）
try { const saved = localStorage.getItem('dsh-wf-theme'); if (saved) document.documentElement.setAttribute('data-theme', saved); } catch (_) {}
```

浏览器加载顺序为：`index.html` 内联 CSS（`:root`=深色）→ body 首次 Paint（深色）→ 加载 `layout.js`/`graph-ops.js`/`editor.js`/`execution.js` → 执行 694 行改 `data-theme` → 二次 Paint（浅色）。即浅色用户必然经历 `深色→浅色` 两帧。

**影响**：首屏闪烁、视觉刺眼、破坏"第一帧主题正确"的验收标准。

**修复方案**：在 `index.html` `<head>` 内、`<style>` 之前插入内联主题 Bootstrap 脚本，读取 `dsh-wf-theme` 并设置 `document.documentElement.dataset.theme`，确保首次 Paint 前 `data-theme` 已就位。`execution.js:694` 保留作兜底（幂等）。

---

### A2. 主题切换动画未与初始化区分

**问题**：主题初始化与用户主动切换共用一套样式，无法区分"初始化无过渡 / 切换有过渡"。

**根因**：无专门机制区分初始化与运行时切换。当前虽无全局 `transition: all`，但未来若加主题过渡会误伤首帧。

**影响**：若不加隔离，后续引入主题过渡会重新引入首帧渐变闪烁。

**修复方案**：Theme Bootstrap 阶段在 `documentElement` 打上 `data-theme-boot` 标记；切换主题时仅对 `background-color`/`color`/`border-color` 加受控 `transition`，禁止 `transition: all`。初始化期间不触发任何 transition。

---

### A3. Workbench 列表用文本 Loading 且每次全量重建 —— 内容→空白→内容

**问题**：进入 Workbench 或刷新列表时，先显示"加载中…"文本，数据返回后整个列表重建；切换视图再切回时又一次清空重建。

**根因**：`editor.js` `renderWorkbenchView()`：

```js
list.innerHTML = '加载中…';                       // ① 清空为文本
Promise.all([...]).then(([wfs, execs]) => {
  ...
  if (!arr.length) { list.innerHTML = '...暂无工作流...'; return; }
  list.innerHTML = arr.map(...).join('');          // ② 全量重建卡片
});
```

每次调用都 `innerHTML` 重置，既有内容被清成文本，再重建 DOM。

**影响**：明显的 `内容→文本→内容` 抖动；卡片 `DOM 节点` 被销毁重建，Layout Shift 与闪烁。

**修复方案**：
- 首次加载（无数据）→ 显示 `.skeleton-card` 骨架，保持卡片近似高度。
- 已有数据刷新 → 不清空，顶部加轻量 `↻ refreshing` 指示，数据就位后局部替换。
- 稳定容器 `#wb-card-list` 不变，仅替换其内部内容；用 `S.dirty`/请求序号避免竞态。

---

### A4. Workbench 卡片缺 Skeleton、无空/错/刷四态

**问题**：首次进入无骨架，只有"加载中…"文本；无独立的 empty/error/refreshing 视觉状态。

**根因**：只有文本 Loading，无状态机；错误靠 `.catch(() => [])` 静默吞掉，用户无感知。

**影响**：空白等待体验差；请求失败表现为"暂无工作流"误导。

**修复方案**：引入 `AsyncState` 语义（initialLoading / refreshing / empty / error / success），首屏用 Skeleton，失败显示可重试错误块，空数据显示空态插图，刷新保留旧数据 + 轻量指示。

---

### A5. Canvas 深链加载异步且缺 Graph Loading 态 —— 空画布→完整图

**问题**：通过 `?wf=<id>` 深链打开时，先渲染空画布（`init()` 同步 `render()`），随后异步加载 Workflow 再 `render()` 完整图，产生空→满闪跳；加载期间画布是纯网格无任何提示。

**根因**：`editor.js` `init()`：

```js
(async function init() {
  S.def = newWorkflow();   // 先建空工作流
  render();                // 同步画空图
  (async () => {
    const wfId = new URLSearchParams(location.search).get('wf');
    if (wfId) {
      S.def = await API.j('GET', ...);   // 异步加载
      ...
      render();            // 再画完整图
    }
  })();
})();
```

深链场景 `render()` 被调用两次（空 + 完整），中间无 Loading 层。

**影响**：深链进入编辑页时画布内容突然从空跳为完整图。

**修复方案**：Canvas 区增加 `graph-loading` 覆盖层（轻量占位结构，不模拟复杂拓扑），Graph Model（nodes+edges+positions+controlpoints+viewport）全部就绪后**一次性** `render()`，移除覆盖层。Node/Edge 由 `render()` 同步一次性构建，本就不逐个出现，保持该特性即可。

---

### A6. Execution 面板 Loading 基础较好，但缺局部 Loading 与 Agent 状态态区分

**问题**：Execution 面板已有 `#exec-loading`（含 `skeleton-line`）、`#exec-error`、空态、`exec-review-notice`，基础优于 Workbench；但打开执行时整面板 Loading（含 timeline + canvas + sidebar 整体 skeleton），局部操作（Accept/Reject/Rework/Continue）无独立的按钮级 Loading。

**根因**：`execution.js` 打开执行时整面板 `exec-loading` 显隐；按钮状态无 spinner。

**影响**：整面板 skeleton 仍算可接受；但操作按钮无 loading 反馈，点击后可能误以为没反应而重复点击。

**修复方案**：保留整面板首次 loading；对 Accept/Reject/Rework/Continue 等按钮做「永远存在、disabled + spinner」的局部加载，避免按钮消失/重建导致闪烁。

---

### A7. Skeleton 体系不统一、无 reduced-motion 支持

**问题**：只有 `.skeleton-line` 一类，无统一的 `.skeleton` 基类；无 `prefers-reduced-motion` 降级；无卡片/列表/图像变体。

**根因**：Skeleton 为 Execution 面板临时添加，未抽象成体系。

**影响**：Workbench/Inspector/Canvas 无法复用统一骨架；动画敏感用户得不到降级。

**修复方案**：定义 `.skeleton` 基类（shimmer 渐变 + `sk-shimmer` 动画）+ 变体（`.skeleton-card`/`.skeleton-line`/`.skeleton-text`/`.skeleton-block`），并加：

```css
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
```

---

### A8. Inspector 节点切换无 Loading 态

**问题**：切换选中节点（点击 Reviewer 等）时右侧 Inspector 可能瞬间空白，再填充字段。

**根因**：`renderInspector()` 同步重建 innerHTML，异步字段（如 schema/history）未单独 Loading。

**影响**：切换节点时侧栏内容跳动。

**修复方案**：Inspector 容器稳定，切换时若需异步数据先显示 `.skeleton-line`，就绪后一次性渲染；局部区域更新而非整面板替换。

---

### A9. 全局 Layout Shift 风险点

**问题**：卡片、图片、侧栏在数据到达前后尺寸可能变化（高度由内容撑开）。

**根因**：`wf-card` 高度由内容决定，无 `min-height`；Skeleton 若高度不匹配会造成替换时跳动。

**影响**：Loading→真实内容替换时列表高度变化，滚动跳动。

**修复方案**：Skeleton 占位高度与真实卡片近似（`.skeleton-card` 固定 min-height）；关键容器给稳定尺寸；`img { aspect-ratio }`。

---

### A10. 主题内容部分未走变量（潜在浅色/深色不一致）

**问题**：部分内联样式、`.st-*` 状态色在深色默认、浅色覆盖中有少量硬编码色值（如浅色 `.st-running{background:#d9e7ff}` 等）分散在 `html[data-theme="light"]` 规则里。

**根因**：主题历史上逐步扩展，状态色以覆盖规则维护，非纯变量。

**影响**：非本次闪烁核心，但属一致性隐患；本次仅做确认不重构，避免引入回归。

---

## 三、问题汇总与优先级

| 编号 | 问题 | 优先级 | 根因环节 |
|------|------|--------|---------|
| A1 | 主题初始化晚于首次 Paint（黑→白闪烁） | **P0** | 主题恢复在 execution.js 尾部 |
| A2 | 主题初始化/切换未区分过渡 | P1 | 无 boot 隔离机制 |
| A3 | Workbench 文本 Loading + 全量重建 | **P1** | renderWorkbenchView innerHTML |
| A4 | Workbench 缺 Skeleton 与 empty/error/refreshing 四态 | P1 | 无 AsyncState |
| A5 | Canvas 深链异步加载缺 Loading 态（空→满） | P1 | init 先画空图再异步加载 |
| A6 | Execution 缺按钮级局部 Loading | P2 | 无按钮 spinner |
| A7 | Skeleton 体系不统一、无 reduced-motion | P1 | 未抽象 |
| A8 | Inspector 切换节点缺 Loading | P2 | renderInspector 同步重建 |
| A9 | Skeleton 与真实内容高度不匹配 → Layout Shift | P1 | 无稳定占位 |
| A10 | 部分状态色硬编码非变量 | P3 | 历史遗留 |

**实施范围**：P0+P1（A1/A2/A3/A4/A5/A7/A9）本次落地；P2（A6/A8）随 P1 组件一并做按钮级 Loading 与 Inspector 骨架；P3（A10）确认不重构。

---

*文档结束。修复方案与验证步骤详见 LOADING_UX_IMPLEMENTATION.md。*
