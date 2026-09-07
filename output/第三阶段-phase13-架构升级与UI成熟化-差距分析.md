# dsh-workflow 架构升级（积木化 + 可持续迭代）+ UI/UX 成熟化 —— 差距分析

> 依据：用户提供两份文档《dsh-workflow 核心架构升级：积木化 Workflow + 可持续迭代 Execution》《dsh-workflow UI/UX 成熟化设计规范》。
> 日期：2026-09-01。基线：第三阶段 Phase 1-11 + Workbench 已收官，163/163 测试。

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
| **A 版本化 + 快照（架构地基）** | 差距 A/B/D | WorkflowVersion 仓库（保存自动建快照）；`ExecutionState.defSnapshot`（启动深拷贝）；versions 列表端点；run/rework 支持 version；detail 返回 defSnapshot；执行面板历史用快照 | 测试：改版后旧执行仍显示旧结构；run with v1 运行 v1 |
| **B Human Intervention 结构化 + 人工编辑 Artifact** | 差距 C | Rework body 升级 `{instruction, targetNode, inputArtifacts, modifiedArtifacts}`；`pendingFeedback` 扩展；执行完成后在节点详情编辑 Artifact 生成新版本并"继续"（rework 以修改版为起点）；审核 tab Human Input 面板（Attach File/Folder/Artifact） | 测试：修改 Artifact→Submit→下游消费新版本；结构化 intervention 注入 prompt |
| **C 积木操作补全** | 差距 E | 节点 Duplicate/Disable、连线 Reverse/…（graph-ops 纯函数 + 菜单） | graph-ops 测试 |
| **D Toolbar 精简 + ⋯ 菜单 + 组件库分组搜索 + 底部 Zoom 栏** | 差距 F/K/L/M | Editor 布局重构（顶部精简、⋯ 菜单、左库分组搜索、底栏） | 无后端测试，浏览器冒烟 |
| **E 执行页三栏 + 状态驱动 Contextual Action** | 差距 G/H | 左 Timeline 竖列；右 Inspector 按状态显示 Review 决策 / Human Input / 节点详情；审核操作就近 | 真机走查 |
| **F UI Polish（空/加载/错误 + 快捷键 + 视觉）** | 差距 I/J + 第二份 §29/31 | Empty/Loading/Error 组件；快捷键补全；信息层级/留白对齐 | 真机走查 |
| **G 全量回归 + 新增验收** | 第一份 §35 全项 + 第二份禁止事项 | 测试全绿；按 §35 验收清单逐条过 | 163+ 测试 |

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
