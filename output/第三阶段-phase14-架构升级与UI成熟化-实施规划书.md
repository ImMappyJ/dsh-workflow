# dsh-workflow 架构升级（积木化 + 可持续迭代）+ UI/UX 成熟化 —— 实施规划书

> 依据：用户提供两份文档《dsh-workflow 核心架构升级：积木化 Workflow + 可持续迭代 Execution》《dsh-workflow UI/UX 成熟化设计规范》。
> 日期：2026-09-01。基线：第三阶段 Phase 1-11 + Workbench 已收官（163 测试）。
> **实施进度**：Phase A ✅（版本化 + def 快照 + Test 6 竞态根治）、Phase B ✅（Human Intervention 结构化后端+前端面板，测试 4 项）、Phase C ✅（Duplicate/Disable/Reverse 确认已有 + graph-ops 测试覆盖）、Phase D ✅（Toolbar 精简 + ⋯ 菜单 + 组件库分组搜索 + 底部 Zoom 栏，浏览器冒烟通过）、**Phase E ✅（执行页三栏 Timeline/Graph/Inspector + 状态驱动 Contextual Action，浏览器冒烟通过）**、**Phase F ✅（UI Polish：空/加载/错误态 + 快捷键补全，静态前端验证通过）**、**Phase G ✅（全量回归 + §35 全项验收 + 禁止事项对照，171/171 + typecheck 通过，验收报告 phase15 已生成）**。全量回归 171/171。
> 下一步：第三阶段全部 Phase A-G 收官；waiting_human CA 已通过独立后端真机级走查闭环。剩余 Test 1-15 的 🧑 项（尤其 Test 14 Office 依赖真实文件）需 DSH Desktop GUI 宿主开启后进行（宿主无法自动化启动，需手动开启桌面快捷方式）。

---

## 一、已有实现与两份文档的重合度

以下能力在第三阶段已实现，**无需重建**，仅需少量对齐：

| 需求点 | 现状 | 备注 |
|--------|------|------|
| Start/End 唯一（§28） | ✅ validator 三入口强制 | |
| Edge 箭头表达数据流（§26/§11） | ✅ 编辑器 marker 箭头 + bezier/straight/orthogonal | Phase 9 |
| 控制点拖拽 + 持久化（§26） | ✅ manual routing 相对源节点存储 | |
| Loop 阈值自动终止（§27） | ✅ LoopController maxIterations | |
| Execution 持久化 / 重启保留（§6） | ✅ 终态快照 + 启动标记（竞态已修） | Test 6 |
| Rework 创建新 Execution 保留 Parent（§9/14/15） | ✅ engine.rework + Execution Tree | Test 7/8 |
| Execution 完成后仍可 Rework（§13/9） | ✅ 工作台/执行面板入口 | |
| Artifact 一等公民 + 版本链（§29） | ✅ ArtifactManager v1/v2/v3 + diff + restore | Test 9 |
| Human Review（Accept/Reject/Edit，§12） | ✅ ReviewManager + 审核 tab（输入不吞字已修） | |
| Working Directory 是 Execution Context（§16） | ✅ 快照 + 父快照优先 + 安全校验 | Test 10/11 |
| Node 可复用（Node Template，§7/25） | ✅ 预设库 + 详情 + 插入画布 | Test 15 |
| Template 列表简洁详情完整（§19/20） | ✅ 模板/预设两级展示 | |
| Workbench 名称优先 / 搜索 / 筛选 / 删除确认（§21） | ✅ View Model + wb UI | |
| 模态/窗口外点击关闭 | ✅ | |
| Artifact Viewer 注册表 | ✅ Preview/Edit/Diff/Restore | |

---

## 二、核心差距（架构层，第一份文档）

### 差距 A：Workflow 版本化存储缺失（§4/§5/§22/§35 关键）
- **现状**：`storage.workflows` 单文件覆盖（同一 id 只存一份）；`revision` 自增但**历史版本本体不保留**。
- **后果**：Workflow v2 覆盖 v1 后，v1 无法还原；用户修改已执行 Workflow 时，历史 Execution 绑定的旧结构已不可得。
- **目标**：`WorkflowVersion` 仓库（`workflows/{id}__v{n}.json`），保存时若结构/版本变化创建新版本快照；`GET /api/workflows/:id/versions` 列出；运行可指定版本。

### 差距 B：Execution 不绑定 def 本体快照（§5/§23/§35）
- **现状**：`ExecutionState.workflowVersion` 只存 revision 数字，**无 def 快照**；执行面板打开历史执行时 `EX.def = fetch(/api/workflows/:id)` 取的是**当前 def**。
- **后果**：Workflow 改版后打开历史 Execution，显示的节点/连线是新的，审计失真（违反"历史 Execution 永远不可变"）。
- **目标**：`ExecutionState.defSnapshot`（启动时深拷贝 effectiveDef）；detail 端点返回 `defSnapshot`；前端历史面板优先用快照。

### 差距 C：Human Input 未结构化（§8/§10/§11/§12）
- **现状**：rework 输入是 `{text}`，经 `pendingFeedback {text, reviewId}` 注入。
- **后果**：不支持"附加 Artifact / 修改 Artifact 后继续"，无法表达 `HumanIntervention{instruction, targetNode, inputArtifacts, modifiedArtifacts}`。
- **目标**：Rework 端点接受结构化 body；`pendingFeedback` 升级为 `{instruction, inputArtifacts, modifiedArtifacts, ...}`；执行完成后可编辑 Artifact 并以新版本作为起点继续（§11/§19 场景 3）。

### 差距 D：Run with Version（§24）
- **现状**：run 默认当前 def。
- **目标**：run/rework 支持指定 `version`（默认最新），高级设置可选"Run with Version N"。

### 差距 E：节点/连线积木操作完整度（§7/§25/§26）
- **现状**：节点右键有 编辑/存为预设/删除；连线右键有 线型/控制点/重置/数据流。
- **差距**：缺 **Duplicate（复制）**、连线 **Reverse Direction（反向）**、节点 **Disable（禁用旁路）**（此前 P4 提到禁用=旁路，需确认 UI 入口）。
- **目标**：补 Duplicate/Reverse/Disable 菜单项（纯前端 graph-ops 扩展）。

---

## 三、核心差距（UI 层，第二份文档）

| 差距 | 规范要求 | 现状 | 改动 |
|------|---------|------|------|
| F. Toolbar 按钮墙 | 顶部只留 Navigation / 名称 / Primary(Run) / ⋯（§3/§21/§30） | 顶部 14+ 按钮 | 精简为 `← Workbench` `名称` `[Run]` `[⋯]`；次要（保存/校验/模板/预设/示例/存为模板/删除/历史）入 ⋯ 菜单 |
| G. 执行页三栏 | 左 Timeline / 中 Graph / 右 Inspector（§8/§9/§10） | 中 Graph + 右侧 tabs（审核/节点/审计/日志） | 左加 Execution Timeline 竖列（点节点→Graph 定位→Inspector 详情）；审核/人工操作就近到右侧 Inspector（状态驱动） |
| H. 状态驱动操作 | 按状态只显示可用操作（§10/§24） | updateControlButtons 部分；审核操作已在审核 tab | 执行面板按 节点状态 在右侧呈现 Contextual Action（Review 决策 / Human Input 面板） |
| I. 空/加载/错误独立设计 | 至少 Loading/Empty/Error/Success...（§27/§28） | 仅 ins-empty 简文 | 补 Empty State（标题+说明+CTA）、Loading 骨架、Error 重试 |
| J. 快捷键 | Ctrl+S/Z/Shift+Z/D/C/V/Delete/+/-、Space 平移（§26） | 仅 Delete 删除、部分滚轮 | 补全；宿主冲突以宿主为准 |
| K. 危险操作隐藏 | Delete/Reset 入 ⋯ + 确认（§25） | btn-delete 在 toolbar | 移入 ⋯ 菜单 + 确认（已有确认） |
| L. 左侧组件库分组+搜索 | AGENTS/HUMAN/CONTROL 分组 + 搜索 + 节点模板可拖（§17/§18） | 简单 5 项 + 连线 | 分组 + 搜索框 + 内嵌"节点模板"可拖 |
| M. 底部画布操作 | Zoom/Fit/Minimap（§15） | 缩放到全部在画布菜单 | 底部加 [−] % [+] [Fit]（Minimap 可选） |

---

## 四、分阶段实施计划（沿用渐进式交付节奏）

| Phase | 内容 | 关键交付 | 验收锚点 |
|-------|------|---------|---------|
| **A 版本化 + 快照（架构地基）** ✅ 已完成 | 差距 A/B/D | `workflowVersions` 仓库（key `{id}__v{rev}`）；`ExecutionState.defSnapshot`；`GET /api/workflows/:id/versions`；run 支持 version；detail 返回 defSnapshot；前端历史优先快照。**竞态修复**：`JsonRepo.save` per-id 串行锁 + rename 兜底（启动标记与终态快照并发写同文件导致终态丢失） | `test/phase3-version.test.ts` 4 项 + Test 6 磁盘轮询全绿；169/169 |
| **B Human Intervention 结构化（后端✅）** | 差距 C | Rework/run body 支持 `{instruction, inputArtifacts, modifiedArtifacts}`；`pendingFeedback` 升级 `HumanIntervention & {text, reviewId}`；引擎 resolveArtifactRef 按 `nodeId@vN`/文件名解析；prompt 注入 instruction + HUMAN ATTACHED INPUT；rework 装配时 modifiedArtifacts 替换起点输出；review-manager reject 同步结构化。**待做**：前端 Human Input 面板（instruction+Attach+Submit） | `test/phase3-human-input.test.ts` 4 项通过（结构化 instruction / inputArtifacts 注入 / modifiedArtifacts 起点 / reject 同构） |
| **B Human Intervention 结构化 + 人工编辑 Artifact** | 差距 C | Rework body 升级 `{instruction, targetNode, inputArtifacts, modifiedArtifacts}`；`pendingFeedback` 扩展；执行完成后在节点详情编辑 Artifact 生成新版本并"继续"（rework 以修改版为起点）；审核 tab Human Input 面板（Attach File/Folder/Artifact） | 测试：修改 Artifact→Submit→下游消费新版本；结构化 intervention 注入 prompt |
| **C 积木操作补全（✅ 无需新增）** | 差距 E | 确认 `graph-ops.js` 已有 duplicateNode/toggleDisabled/reverseEdge 纯函数 + 编辑器节点/连线/画布菜单均已接线 + `test/graph-ops.test.ts` 覆盖 | graph-ops 测试已有 |
| **D Toolbar 精简 + ⋯ 菜单 + 组件库分组搜索 + 底部 Zoom 栏（✅ 已完成）** | 差距 F/K/L/M | index.html Toolbar 精简（只留 标题/id/名称/加载/运行/⋯）；次要操作（新建/保存/校验/示例/模板库/预设库/存为模板/历史/主题/删除）入 ⋯ 菜单；组件库分组 AGENTS/HUMAN/CONTROL + 搜索框；canvas-wrap 底部 Zoom 栏 [−]%[+]Fit；editor.js 增加 more 菜单开合/点外关闭、lib 搜索过滤、zoomCanvasAt/zoomFit + render 同步 zoom-pct | 浏览器冒烟通过（⋯开合/点外关闭/搜索过滤/Fit 缩放/菜单项可用均验证） |
| **E 执行页三栏 + 状态驱动 Contextual Action（✅ 已完成）** | 差距 G/H | index.html 加 `#exec-timeline` 列（172px）+ `.tl-*` CSS；execution.js 新增 `renderExecTimeline`（节点状态/图标/颜色，点击→`focusExecNode` Graph 定位 + Inspector 详情 + Timeline 高亮）、`renderContextualActions`（拼进详情模板顶部，不覆盖详情：waiting_review 显示 Review 决策卡片、waiting_human 显示就地提交）；CA 事件绑定在 renderNodeTab 末尾（`data-carv`/`data-caht` 就近提交，不堆顶部按钮墙） | 浏览器冒烟通过：Timeline 5 节点状态正确（start 成功/analyst 待审核等）；点击 Timeline 项 → Graph 定位（view 平移）+ Graph 节点选中 + Timeline 高亮同步；waiting_review 就近审核真实可用（点「通过」→ analyst 变 success、architect 变 running、卡片消失）；waiting_human 分支已通过独立后端真机级走查闭环（见 Phase G 补验） |
| **F UI Polish（✅ 已完成）** | 差距 I/J + 第二份 §29/31 | ① 空/加载/错误态：`.ui-state` 通用覆盖层（标题+说明+CTA），编辑器空画布 Empty State（`#editor-empty` + 两个 CTA 按钮中心添加节点）、执行面板 Loading 骨架（`#exec-loading` + shimmer 动画）、Error 重试（`#exec-error` + 消息 + 重试按钮，连续 2 次失败才提示避免抖动）；② 快捷键补全：Ctrl+S 保存、Ctrl+D 复制、Ctrl+C/V 复制粘贴（复用 CLIPBOARD）、+/− 缩放（zoomCanvasAt）、空格按住任意位置平移（S.spaceDown + mousedown 拦截）、已有 Ctrl+Z/Y/Shift+Z 撤销重做与 Delete 删除；③ 视觉：右下角快捷键提示条 | 静态前端验证通过（无后端也可验 UI）：空态显隐（0 节点→flex、有节点→none）、空态 CTA 添加 agent 生效且自动隐藏、Space 按下/抬起切换 S.spaceDown、Ctrl+D 复制 4→5 且新增 agent2、Ctrl+C/V 复制粘贴生效、+/− 缩放 100→120→100、执行面板打开即显示 Loading、API 404 连续失败后显示 Error+重试且重试可再次触发轮询。**修复**：Ctrl+D 首版漏 `S.def.nodes.push(r.node)` 导致复制不增节点；editor.js 行尾被污染为 `\r\r\n`（双 CR），已统一修复为 LF |
| **G 全量回归 + §35 验收（✅ 已完成）** | 第一份 §35 全项 + 第二份禁止事项 | vitest 全量回归 171/171（21 文件，12.01s）绿 + typecheck（tsc --noEmit）exit=0；验收报告 `output/第三阶段-phase15-PhaseG-全量回归与验收报告.md`：按 phase13 差距分析（A-M）+ phase12 Test 1-15 重建 §35 验收对照表（✅自动化 / 🖥静态前端 / 🧑需 GUI 宿主 三态标注）；六条禁止事项逐条确认无倒退 | 171/171 + typecheck 通过；**waiting_human CA 已真机级走查闭环**（独立后端 createWorkflowServer mock 模式：Timeline 待人工→Inspector 就地提交→approve/end success→人工 artifact v1），剩余 Test 1-15 的 🧑 项（尤其 Test 14 Office 依赖真实文件）待 GUI 宿主 |

---

## 五、禁止事项对照（第二份 §30，防倒退）

- ✅ 不把全部操作堆顶（Phase D）
- ✅ 不每个操作都弹 Modal（Inspector 优先）
- ✅ 不在每个节点放一排常驻按钮（Floating Toolbar / 右键 / Inspector）
- ✅ 不所有字段同时展开（Progressive Disclosure：Advanced 折叠）
- ✅ Delete 不进 Primary 区（Phase D 移入 ⋯）
- ✅ 不用 ID 作主要 UI 信息（Workbench 已达标，Phase A 后历史执行也用 Name）

---

## 六、建议实施顺序与风险

- **先 A（版本化+快照）**：是所有后续迭代/审计的地基，也是"执行后编辑不改历史"的硬保证。改动集中在 storage/engine/index + 前端 def 来源，有明确测试。
- **再 B（Human Input 结构化）**：在 A 的 defSnapshot 基础上，人工编辑 Artifact 后可精确以"旧版本 + 人工修改版"为起点 rework。
- **C 小步**：graph-ops 纯函数，风险低。
- **D/E/F 前端为主**：不碰后端逻辑，逐项冒烟。

---

## 七、结论

两份文档约 70% 的能力已在第三阶段落地（见第一节重合表）；**真正的结构性缺口是 Workflow 版本化存储（A）、Execution def 快照（B）与 UI 布局成熟化（D/E/F）**。按 Phase A→G 渐进实施，每阶段回归测试 + 真机冒烟后交付。
