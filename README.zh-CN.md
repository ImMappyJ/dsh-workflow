# dsh-workflow

<a href="README.md">English</a> · 简体中文

> 一个面向 DeepSeek Harness（DSH）的可视化 Agent Workflow 编排插件。

dsh-workflow 将 DeepSeek Harness 从单 Agent 交互环境，升级为**可视化多 Agent 工作流编排环境**。它不依赖单个长会话 Agent，而是把复杂任务分解为一组专职 Agent，通过显式数据流、人工审核点与可复用的工作流定义连接起来。

> **Workflow 定义流程。Agent 定义职责。Edge 定义数据流。Artifact 定义产出。Review 定义人的控制。Execution 定义实际发生了什么。Rework 定义问题发现之后工作流如何继续。**

面向 DeepSeek Harness 的可视化、可审计、可续跑的 Agent 工作流编排层。

![Version](https://img.shields.io/badge/version-0.1.6-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6)
![Tests](https://img.shields.io/badge/tests-179%20passed-brightgreen)
![Status](https://img.shields.io/badge/status-Experimental-orange)
![License](https://img.shields.io/badge/license-MIT-green)

---

## 为什么不直接用聊天？

传统的 LLM Agent 使用方式：

```text
用户 → Agent → 文本
```

真实的工程任务——分析、实现、评审、测试、修正、文档——全部塞进一个 Agent 会话，会导致：

- Context 过大
- 角色与职责不清晰
- 无法审计"谁产出了什么"
- 中途失败只能整个重来
- 下次遇到类似任务没有任何可复用的东西

dsh-workflow 换一种方式分解任务：

```text
                    ┌──────────────┐
                    │   Agent A    │   专职角色
                    └──────┬───────┘
                           │  Artifact（数据流）
                           ▼
                    ┌──────────────┐
                    │  人工审核     │   Accept / Reject / Edit
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Agent B    │   消费 A 的输出
                    └──────┬───────┘
                           │
                           ▼
                          End
```

> **专职 Agent + 显式数据流 + Artifact + 人工审核 + 执行历史 + Rework**——上面每一个问题都有结构性答案。

## 核心特性

### 可视化工作流编辑器

原生 SVG 编辑器（无前端框架），运行在浏览器中：

- 无限画布上拖拽 Agent 节点，支持缩放 / 平移
- 可视化连线，带方向箭头
- **Edge 是语义化的数据流关系，不只是视觉连线**
- 边曲线控制点，支持手工路由
- 节点选择、右键菜单、节点启用 / 禁用
- 工作流校验（唯一 Start / End、环检测）
- 三个视图：**工作台**（全部工作流）、**编辑**（定义）、**执行**（运行时）

### Agent 即节点

每个节点都是一个带完整契约的 Agent：

| 字段 | 含义 |
|------|------|
| Identity | 自定义角色名，如 `高级 Go 开发`、`代码评审员`、`测试工程师` |
| Role Description | Agent 能做什么、不能做什么、工作约束、验收标准 |
| Input Requirement | 上游传来什么数据、如何处理、使用或忽略哪些信息 |
| Output Requirement | 要产出什么结果、以何种方式交给下游 Agent |
| Model Config | 节点运行的模型 |
| Review Policy | 可选的输出质量门（路由前先审核） |
| Routing Mode | `static` 固定出口 / `condition` 条件表达式 / `agent`（Agent 自主决策）/ `human`（人工选择） |

### 数据流

每条边代表 Agent 之间的有向数据流：

```text
分析 Agent
      │  分析报告（Artifact）
      ▼
编码 Agent
      │  代码变更（Artifact）
      ▼
评审 Agent
```

`A ─────→ B` 表示 **A 生产数据，B 消费数据**。Edge 可携带：

- `artifactKeys` —— 指定跨边流转的 Artifact（默认全部）
- `inputMapping` —— `{ 目标输入名: 源输出名 }` 映射
- 条件分支所需的条件与路由信息

### 人在环（Human-in-the-Loop）

人工审核是**工作流运行时**的一部分，而不只是一个 UI 确认弹窗：

```text
Agent → Artifact → 人工审核
                      ├── Accept  接受
                      ├── Reject  驳回（必须填理由）
                      ├── Edit    编辑（生成新 Artifact 版本）
                      └── Terminate 终止
```

- 查看完整 Artifact（文本、Markdown、带多文件浏览器的代码、被引用的文件）
- 直接编辑 Agent 的结果——编辑成为**新的 Artifact 版本**，原始输出保留
- Reject 必须填理由；理由会反馈给产出节点并触发其重跑
- 审核任务会暂停工作流，直到人做出决策

### Artifact 优先设计

Agent 的输出是 **Artifact**，不是普通字符串。支持的类型：

`text` · `markdown` · `json` · `code`（多文件）· `image` · `file` · `directory` · `office`

- 每个 Artifact 都有**版本号**；人工编辑生成新版本而不是覆盖
- 大输出（> 64 KB）自动切换为引用存储并携带文件元数据
- 代码 Artifact 携带文件列表，每个文件可展开查看全文
- Office 文档以文件引用方式存储（预览 + 外部编辑）

> dsh-workflow 为"Agent 修改真实项目文件与文档"的工作流而设计，不只是生成文本。

### 执行（Execution）

```text
工作流定义 ≠ 工作流执行
```

- 工作流**定义**描述"这个流程应该怎么跑"
- **执行**记录"某一次具体运行中实际发生了什么"
- 定义带版本（`revision`）；每次执行绑定启动时的定义快照——后续修改永不改写历史
- 运行时控制：`pause` / `resume` / `stop` / `step`
- 实时流式：Agent 仍在生成时，节点输出就通过 SSE 流式推送到界面

### 执行历史与 Rework

每次运行都有不可变的记录：

```text
Execution #001  ──── 在节点 B 发现问题 ────┐
                                            ▼
                                    Rework from 节点 B
                                            │
Execution #002（新执行，继承工作上下文）◄────┘
```

- 在已完成的执行中选中任意节点 → **Rework From Here** → 描述问题 → 从该节点启动**新执行**，并注入先前上下文
- `Execution #001` 永远不被修改；Rework 链形成执行树
- 每次执行都可查看 Timeline、各节点状态、输入、输出、Artifact、审核记录与错误

### 循环（Cycle / Loop）

```text
A → B → C
↑       │
└───────┘
```

循环用于建模"评审 → 修改 → 再评审"、"生成 → 测试 → 修复"式的协作。保存时通过 Tarjan SCC 自动检测环，并且**每个环必须有有界阈值**（`maxIterations`，默认 3）——达到阈值后自动退出，不会无限运行。

### 工作目录（Working Directory）

每个工作流绑定一个**工作目录**（本机绝对路径，如 `D:/Development/my-project`）：

- 执行启动时快照工作目录
- Agent 在执行的工作目录内运行（每节点会话以它作为 `cwd`）
- 这让 dsh-workflow 适合真实的软件工程场景——Agent 需要检查并修改已有项目内的文件

### 模板与预设

- **工作流模板** —— 可复用的完整工作流定义。插件内置 10 个模板（见[使用场景](#使用场景)）；任意工作流可另存为用户模板，之后实例化
- **节点预设** —— 可复用的单 Agent 配置（角色描述、输入输出契约），快速创建节点

## 架构

```text
┌──────────────────────────────────────────────────────┐
│                DeepSeek Harness (DSH)                 │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │              dsh-workflow 插件                  │ │
│  │                                                 │ │
│  │  public/  可视化编辑器 + 执行界面（SVG/JS）       │ │
│  │     │  HTTP API + SSE（端口 3090）               │ │
│  │     ▼                                          │ │
│  │  src/index.ts        API 层 / 静态服务           │ │
│  │     │                                          │ │
│  │     ▼                                          │ │
│  │  engine/                                        │ │
│  │    调度器 · 循环控制器（Tarjan SCC）              │ │
│  │    审核管理器（HITL）· Artifact 管理器            │ │
│  │    上下文管理 · Prompt 构建器                     │ │
│  │     │                                          │ │
│  │     ▼                                          │ │
│  │  provider/  DshSessionProvider                 │ │
│  │    （每节点一个独立 DSH 会话，流式输出）           │ │
│  │     │                                          │ │
│  │     ▼                                          │ │
│  │  storage/  JSON 仓库：工作流 / 执行 /            │ │
│  │            预设 / 模板                          │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  DSH 宿主入口：/workflow → 插件界面                   │
└──────────────────────────────────────────────────────┘
```

| 模块 | 职责 |
|------|------|
| `src/domain/` | 核心类型（WorkflowDefinition、AgentNode、Artifact、ReviewTask…） |
| `src/engine/` | 执行引擎：调度、循环、HITL、Artifact、上下文、Prompt |
| `src/graph/` | Tarjan SCC 环检测、工作流校验 |
| `src/provider/` | `DshSessionProvider` —— 每个节点作为独立的流式 DSH 会话运行 |
| `src/storage/` | JSON 文件仓库 |
| `src/templates/` | 内置工作流模板 |
| `public/` | 无框架前端：编辑器、执行视图、工作台 |

## 核心概念

| 概念 | 说明 |
|------|------|
| Workflow（工作流） | 工作流定义（流程、Agent、边） |
| Workflow Version（工作流版本） | 不可变的定义快照（`revision`）；执行绑定其启动时的版本 |
| Node（节点） | 承担特定角色、带输入输出契约的 Agent |
| Edge（边） | Agent 之间的有向数据流 |
| Artifact | 带版本的输出或工作对象（文本、代码、文件、目录…） |
| Review（审核） | 运行时的人工接受 / 驳回 / 编辑决策 |
| Execution（执行） | 一次具体的工作流运行 |
| Rework（返工） | 从历史执行的某节点开始的新执行 |
| Working Directory（工作目录） | 执行在磁盘上的工作空间 |
| 节点预设 | 可复用的 Agent 配置 |
| 工作流模板 | 可复用的完整工作流 |

## 快速开始

环境要求：Node.js（含 npm）、一个终端。

```bash
# 1. 克隆（替换为你的实际仓库地址）
git clone https://github.com/ImMappyJ/dsh-workflow.git
cd dsh-workflow

# 2. 安装依赖（仅开发依赖：TypeScript + Vitest）
npm install

# 3. 构建（TypeScript → lib/）
npm run build

# 4. 启动独立服务器（mock Agent 模式）
node phase0/launch-server.mjs 3090
```

然后在浏览器打开 **http://127.0.0.1:3090/**。

> **关于运行模式**
>
> - `launch-server.mjs` 以 **mock 模式**（`mock: true`）启动插件：完整 UI、工作流引擎、审核流、循环与 Rework 全部真实运行，但 Agent 节点返回脚本化的 mock 输出而不调用模型。这是体验产品最快的途径。
> - 若要以**真实模型驱动的 Agent** 运行，请把插件部署进 DeepSeek Harness 宿主——见下文。

### 作为 DSH 插件部署

插件已发布到 npm，包名为 `@mappyj/dsh-plugin-workflow`。

**方式一 —— DSH 内置插件管理（推荐）。** 打开 DSH Desktop 内置终端（或在 Shell 中运行 `dsh`），使用官方命令安装，它会自动完成安装、profile 注册与状态同步：

```bash
dsh plugin add @mappyj/dsh-plugin-workflow
```

> 注意：DSH 对新发布的包有供应链安全策略（最短发布冷却期）。如果刚发布的版本被拒绝，等几天再装或先固定旧版本。

**方式二 —— 手动 pnpm 安装。** 进入 profile 目录安装：

```bash
cd ~/.dsh/profiles/desktop   # 或 ~/.dsh/profiles/web
pnpm add @mappyj/dsh-plugin-workflow
pnpm approve-builds          # pnpm 11+：放行 postinstall 自动注册脚本
```

然后确认 profile 的 `package.json` 中 `bundles` 数组包含该包（postinstall 脚本被放行时会自动添加）：

```json
"dsh": {
  "profile": {
    "bundles": ["...", "@mappyj/dsh-plugin-workflow"]
  }
}
```

重启 DSH Desktop / Web 宿主后，控制台会输出双语启动横幅（含访问地址），插件在 **3090 端口** 提供服务：

```
[zh] 工作流插件已启动：http://127.0.0.1:3090/
[en] Workflow plugin is up: http://127.0.0.1:3090/
```

> **本地开发替代方案。** 如果你在本地开发插件，可用 `link:` 协议代替：
> ```bash
> # `npm run build` 之后，把运行时产物复制进 DSH 插件目录
> cp -r lib public cordis.patch.yml package.json LICENSE ~/.dsh/plugins/dsh-plugin-workflow/
> # 然后在 profiles/web/package.json 中："dsh-plugin-workflow": "link:../../plugins/dsh-plugin-workflow"
> ```

宿主启动后，插件会：

- 在独立端口提供 UI（默认 **3090**）
- 宿主暴露 web server 时，在 DSH 宿主 Web UI 内注册 `/workflow` 入口（否则静默降级为仅独立端口入口）
- 每个 Agent 节点都经宿主 `apiProxy` 以隔离的流式会话运行

## 配置

插件选项（由宿主传给 `apply(ctx, config)`，`createWorkflowServer` 同样接受）：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3090` | HTTP/SSE 服务端口 |
| `host` | `127.0.0.1` | 绑定地址 |
| `mock` | `false` | 使用 `MockAgentRunner` 替代 DSH 会话 |
| `dataDir` | `<DSH_HOME>/workflow-plugin` | 存储根目录（工作流 / 执行 / 预设）。`DSH_HOME` 环境变量可覆盖默认的 `~/.dsh` |

工作流级配置在编辑器的设置页完成：

- **工作目录** —— 绝对路径；Agent 在其中运行
- 节点级**模型配置** —— 每个 Agent 可选模型
- 节点级**审核门** —— 要求 / 跳过对该节点输出的人工审核
- 每个循环的**循环阈值** —— `maxIterations`

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 探活（apiProxy 接入状态） |
| GET/POST | `/api/workflows` | 列出 / 创建保存（校验；环自动挂 LoopConfig） |
| GET/DELETE | `/api/workflows/:id` | 读取 / 删除 |
| POST | `/api/workflows/:id/run` | 启动执行 |
| POST | `/api/workflows/:id/rework` | 从某节点启动 Rework 执行 |
| GET | `/api/executions` | 执行列表（支持 `?workflowId=` 过滤） |
| GET | `/api/executions/:id` | 执行状态 |
| POST | `/api/executions/:id/control` | `pause` / `resume` / `stop` / `step` |
| POST | `/api/executions/:id/review` | 人工审核决策 |
| GET | `/api/events?executionId=...` | SSE 事件流（25s 心跳） |
| GET | `/api/models` | 可用模型列表（透传宿主） |
| GET/POST/DELETE | `/api/templates[/:id]` | 工作流模板（内置 + 用户） |
| POST | `/api/templates/:id/instantiate` | 从模板创建工作流 |
| GET/POST/DELETE | `/api/presets[/:id]` | 节点预设 |

## 使用场景

10 个内置工作流模板覆盖了主要模式：

**软件工程** —— `本地代码 Demo（编写 → 运行 → 验证）`：编码者在工作目录内写一个 demo 并运行验证；适合 Agent 修改文件的真实代码任务。

**代码评审流水线** —— `编码 → 静态检查 → 安全审查`：编码 Agent 的改动依次流经静态分析与安全审查 Agent，最后到人。

**分析流水线** —— `需求 → 架构 → 评审（带人工门）`：三级流水线，架构师的产出先过人工审核门再进入评审。

**迭代式写作** —— `写作 → 评审循环（最多 3 轮）`：评审者给出修改意见，写作者修订；达到循环阈值后收敛。

**并行视角** —— `双轨评审（技术 / 业务）`：两个 Agent 并行分析，第三个汇总；另有 `任务分解 → 并行执行 → 结果整合`。

**产品流程** —— `PRD → 技术设计 → 测试用例`：产品经理、技术负责人、测试工程师通过显式数据契约交接。

**数据流水线** —— `采集 → 清洗 → 分析 → 报表`：四段式数据流，每段带完整数据契约。

## 截图

截图准备中，将放在 `docs/images/` 下：

```text
docs/images/workflow-editor.png    （规划中）
docs/images/workflow-runtime.png   （规划中）
docs/images/human-review.png       （规划中）
docs/images/execution-history.png  （规划中）
```

## 设计原则

1. Agent 是一等的工作流节点。
2. Edge 是一等的数据流关系。
3. Artifact 是一等的输出。
4. 人工审核是一等的运行时状态。
5. 执行是一等实体。
6. 历史执行不可变。
7. Rework 创建新执行。
8. 工作流定义带版本。
9. 每个工作流恰好有一个 Start 和一个 End。
10. 每个环必须有有界执行阈值。
11. 工作目录是执行上下文的一部分。
12. 模板与实例分离。

## Roadmap

### 已完成

- [x] 可视化工作流编辑器（原生 SVG，无框架）
- [x] 带身份 / 角色 / 输入输出契约的 Agent 节点
- [x] 带 Artifact 与输入映射的有向数据流边
- [x] 边曲线控制点、手工路由
- [x] 人工审核：accept / reject / edit / terminate
- [x] Artifact 版本化，人工编辑生成新版本
- [x] 执行历史（不可变）+ 执行树
- [x] 从历史执行任意节点 Rework
- [x] 循环支持：Tarjan SCC 检测 + 强制阈值
- [x] 工作目录绑定与按执行快照
- [x] 运行时控制（pause / resume / stop / step）
- [x] 按节点 SSE 实时流式
- [x] 10 个内置工作流模板 + 用户模板 + 节点预设
- [x] 工作台 / 编辑 / 执行三视图
- [x] 工作流定义版本化

### 规划中

- [ ] 截图与 Demo GIF（`docs/images/`）
- [ ] 更丰富的 Artifact 查看器（图片预览、代码 Diff 渲染）
- [ ] 更多内置模板

## 项目状态

**Experimental**（v0.1.6）。引擎、编辑器与执行运行时可正常工作，有 179 个通过的测试覆盖；但项目仍在快速开发中——API 与存储格式可能变化。

## 开发

```bash
npm install        # 安装开发依赖
npm run build      # tsc → lib/
npm run typecheck  # 仅类型检查
npm test           # vitest run（21 文件 / 179 测试）
node phase0/launch-server.mjs 3090   # 独立 mock 服务器，手工测试用
```

前端（`public/`）是纯 HTML/JS，直接从磁盘提供——修改后刷新浏览器即生效（改 JS 文件时记得递增 `index.html` 里的 `?v=` 缓存版本号）。

## 贡献

1. Fork 本仓库
2. 创建功能分支
3. 实现，并保持测试全绿（`npm test`）
4. 提交清晰的 commit message
5. 发起 Pull Request

## License

[MIT](LICENSE) © 2026 The dsh-workflow Authors

## FAQ

**它是 DeepSeek Harness 的替代品吗？**
不是。dsh-workflow 是 DSH 的工作流编排扩展——Agent 经 DSH 宿主（`apiProxy`）运行，它不替代宿主。

**每个节点都是 Agent 吗？**
节点类型为 `start` / `end` / `agent` / `human_task`。每个承担工作的节点都是一个带独立身份与契约的 Agent。

**工作流可以有循环吗？**
可以，但每个被检测到的环都会自动获得带界的 LoopConfig（`maxIterations` 默认 3）。

**用户可以审核 Agent 的结果吗？**
可以——审核是运行时状态，会暂停工作流直到人接受、驳回（必须填理由）、编辑或终止。

**Agent 能修改文件吗？**
能。Agent 在执行的工作目录内运行；文件与目录变更会作为带元数据的 Artifact 记录。

**完成的工作流可以续跑吗？**
可以——通过 Rework：在历史执行中选一个节点，从它启动新执行。原执行保持原样。

**历史执行会被修改吗？**
永远不会。每次执行绑定其启动时的工作流定义快照，记录不可变。

**工作流能处理非文本 Artifact 吗？**
能——text、markdown、JSON、多文件代码、图片、文件、目录与 Office 文档引用都是一等的 Artifact 类型。

---

**术语** —— 本 README 统一使用：Workflow（工作流）· Workflow Version（工作流版本）· Node（节点）· Agent · Edge（边）· Data Flow（数据流）· Artifact · Review（审核）· Execution（执行）· Rework（返工）· Working Directory（工作目录）· 节点预设 · 工作流模板。*Execution* = 一次具体的工作流运行；*Rework* = 从历史执行的某节点开始的一次新执行。
