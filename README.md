# dsh-workflow

<a href="README.zh-CN.md">简体中文</a> · English

> A visual Agent workflow orchestration plugin for DeepSeek Harness (DSH).

dsh-workflow turns DeepSeek Harness from a single-agent interaction environment into a **visual multi-agent workflow orchestration environment**. Instead of relying on one long-running Agent conversation, complex tasks are decomposed into specialized Agents connected through explicit data flows, human review points, and reusable workflow definitions.

> **Workflow defines the process. Agent defines the responsibility. Edge defines the data flow. Artifact defines the result. Review defines human control. Execution defines what actually happened. Rework defines how the workflow continues after problems are discovered.**

A visual, auditable and resumable Agent workflow orchestration layer for DeepSeek Harness.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6)
![Tests](https://img.shields.io/badge/tests-179%20passed-brightgreen)
![Status](https://img.shields.io/badge/status-Experimental-orange)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Why not just a chat?

The traditional way of using an LLM Agent:

```text
User → Agent → Text
```

Real engineering tasks — analysis, implementation, review, testing, correction, documentation — stuffed into a single Agent conversation lead to:

- Overloaded context
- Unclear roles and responsibilities
- No audit trail of who produced what
- No way to recover from a mid-task failure without restarting
- Nothing reusable the next time a similar task appears

dsh-workflow decomposes the task instead:

```text
                    ┌──────────────┐
                    │   Agent A    │   specialized role
                    └──────┬───────┘
                           │  Artifact (data flow)
                           ▼
                    ┌──────────────┐
                    │ Human Review │   accept / reject / edit
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Agent B    │   consumes A's output
                    └──────┬───────┘
                           │
                           ▼
                          End
```

> **Specialized Agents + Explicit Data Flow + Artifacts + Human Review + Execution History + Rework** — every problem above gets a structural answer.

## Core Features

### Visual Workflow Editor

A native SVG editor (no frontend framework) running in the browser:

- Drag-and-drop Agent nodes on an infinite canvas with zoom / pan
- Connect nodes visually with directional arrows
- **Edges are semantic data-flow relationships, not merely visual connections**
- Edge curve control points for manual routing
- Node selection, context menu, node enable/disable
- Workflow validation (single Start / End, cycle detection)
- Three views: **Workbench** (all workflows), **Editor** (definition), **Execution** (runtime)

### Agent as a Node

Every node is an Agent with a complete contract:

| Field | Meaning |
|-------|---------|
| Identity | Custom role name, e.g. `Senior Go Developer`, `Code Reviewer`, `QA Engineer` |
| Role Description | What the Agent can do, must not do, working constraints, acceptance criteria |
| Input Requirement | What upstream data arrives, how to process it, which parts to use or ignore |
| Output Requirement | What result to produce and how it is handed to downstream Agents |
| Model Config | Which model the node runs on |
| Review Policy | Optional output quality gate before routing |
| Routing Mode | `static` / `condition` / `agent` (Agent decides) / `human` |

### Data Flow

Every edge represents a directional data flow between Agents:

```text
Analysis Agent
      │  Analysis Report (Artifact)
      ▼
Code Agent
      │  Code Changes (Artifact)
      ▼
Review Agent
```

`A ─────→ B` means **A produces data, B consumes data**. An edge can carry:

- `artifactKeys` — which Artifacts flow across the edge (default: all)
- `inputMapping` — `{ target input name: source output name }` mapping
- Conditions and routing information for conditional branches

### Human-in-the-Loop

Human review is part of the **workflow runtime**, not just a UI confirmation dialog:

```text
Agent → Artifact → Human Review
                      ├── Accept
                      ├── Reject  (reason required)
                      ├── Edit    (creates a new Artifact version)
                      └── Terminate
```

- Inspect the full Artifact (text, markdown, code with a multi-file browser, referenced files)
- Edit the Agent's result — the edit becomes a **new Artifact version**, the original is preserved
- Reject with a mandatory reason; the reason is fed back to the producing node and it re-runs
- Review tasks pause the workflow until a human decision arrives

### Artifact-first Design

Agent outputs are **Artifacts**, not plain strings. Supported kinds:

`text` · `markdown` · `json` · `code` (multi-file) · `image` · `file` · `directory` · `office`

- Every Artifact is **versioned**; human edits create new versions instead of overwriting
- Large outputs (> 64 KB) switch to reference storage with file metadata
- Code Artifacts carry a file list, each file expandable to full text
- Office documents are stored as file references (preview + external editing)

> dsh-workflow is designed for workflows where Agents modify real project files and documents, not only generate text.

### Execution

```text
Workflow Definition ≠ Workflow Execution
```

- A Workflow Definition describes *how the workflow should run*
- An Execution is *what actually happened during a specific run*
- Definitions are versioned (`revision`); each Execution binds the definition snapshot it started with — later edits never rewrite history
- Runtime control: `pause` / `resume` / `stop` / `step`
- Live streaming: per-node output streams to the UI over SSE while the Agent is still generating

### Execution History & Rework

Every run is recorded and immutable:

```text
Execution #001  ──── problem discovered at Node B ────┐
                                                      ▼
                                              Rework from Node B
                                                      │
Execution #002  (new run, inherits working context) ◄─┘
```

- Select any node in a finished Execution → **Rework From Here** → describe the problem → a **new Execution** starts from that node with prior context injected
- `Execution #001` is never modified; Rework chains form an Execution tree
- Timeline, per-node status, inputs, outputs, Artifacts, review records and errors are all inspectable per Execution

### Cycle / Loop Support

```text
A → B → C
↑       │
└───────┘
```

Loops model *Review → Fix → Review*, *Generate → Test → Fix* style collaboration. Cycles are detected automatically via Tarjan SCC on save, and **every loop must have a bounded threshold** (`maxIterations`, default 3) — after the threshold the loop exits instead of running forever.

### Working Directory

Each workflow binds a **Working Directory** (an absolute path on your machine, e.g. `D:/Development/my-project`):

- Executions snapshot the working directory at start
- Agents run in the Execution's working directory (per-node sessions get it as `cwd`)
- This makes dsh-workflow suitable for real software engineering where Agents must inspect and modify files inside an existing project

### Templates & Presets

- **Workflow Templates** — reusable complete definitions. 10 built-in templates ship with the plugin (see [Use Cases](#use-cases)); any workflow can be saved as a user template and instantiated later
- **Node Presets** — reusable single-Agent configurations (role description, contracts) for quick node creation

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│                DeepSeek Harness (DSH)                 │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │               dsh-workflow plugin               │ │
│  │                                                 │ │
│  │  public/  Visual Editor + Execution UI (SVG/JS) │ │
│  │     │  HTTP API + SSE (port 3090)               │ │
│  │     ▼                                          │ │
│  │  src/index.ts        API layer / static server  │ │
│  │     │                                          │ │
│  │     ▼                                          │ │
│  │  engine/                                       │ │
│  │    scheduler · loop-controller (Tarjan SCC)     │ │
│  │    review-manager (HITL) · artifact-manager     │ │
│  │    context-manager · prompt-builder             │ │
│  │     │                                          │ │
│  │     ▼                                          │ │
│  │  provider/  DshSessionProvider                 │ │
│  │    (one DSH session per node, streaming)        │ │
│  │     │                                          │ │
│  │     ▼                                          │ │
│  │  storage/  JSON repos: workflows / executions / │ │
│  │             presets / templates                 │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  DSH host entry: /workflow → plugin UI                │
└──────────────────────────────────────────────────────┘
```

| Module | Responsibility |
|--------|----------------|
| `src/domain/` | Core types (WorkflowDefinition, AgentNode, Artifact, ReviewTask...) |
| `src/engine/` | Execution engine: scheduling, loops, HITL, artifacts, context, prompts |
| `src/graph/` | Tarjan SCC cycle detection, workflow validation |
| `src/provider/` | `DshSessionProvider` — runs each node as an independent streaming DSH session |
| `src/storage/` | JSON file repositories |
| `src/templates/` | Built-in workflow templates |
| `public/` | Framework-free frontend: editor, execution view, workbench |

## Core Concepts

| Concept | Description |
|---------|-------------|
| Workflow | The workflow definition (process, agents, edges) |
| Workflow Version | Immutable definition snapshot (`revision`); executions bind the revision they started with |
| Node | An Agent with a specific role and I/O contract |
| Edge | Directional data flow between Agents |
| Artifact | Versioned output or working object (text, code, file, directory, ...) |
| Review | Human accept / reject / edit decision at runtime |
| Execution | One concrete workflow run |
| Rework | A new execution starting from a node of a historical execution |
| Working Directory | The execution workspace on disk |
| Node Preset | Reusable Agent configuration |
| Workflow Template | Reusable complete workflow |

## Quick Start

Requirements: Node.js (with npm), a terminal.

```bash
# 1. Clone (replace with your actual repository URL)
git clone https://github.com/ImMappyJ/dsh-workflow.git
cd dsh-workflow

# 2. Install dependencies (dev-only: TypeScript + Vitest)
npm install

# 3. Build (TypeScript → lib/)
npm run build

# 4. Start the standalone server (mock Agent mode)
node phase0/launch-server.mjs 3090
```

Then open **http://127.0.0.1:3090/** in your browser.

> **Note on modes**
>
> - `launch-server.mjs` starts the plugin in **mock mode** (`mock: true`): the full UI, workflow engine, review flow, loops and rework all run for real, but Agent nodes return scripted mock outputs instead of calling a model. This is the fastest way to explore the product.
> - To run with **real model-backed Agents**, deploy the plugin into a DeepSeek Harness host — see below.

### Deploy as a DSH plugin

The plugin is published on npm as `@ImMappyJ/dsh-plugin-workflow`. In the DSH profile's `package.json`, add it as a dependency:

```bash
cd ~/.dsh/profiles/web
pnpm add @ImMappyJ/dsh-plugin-workflow
```

The profile's `node_modules` will contain the plugin. The host loads it via `cordis.patch.yml` (which declares the plugin and its `apiProxy` injection).

> **Alternative: local development.** If you are developing the plugin locally, use the `link:` protocol instead:
> ```bash
> # after `npm run build`, copy into the DSH plugins directory
> cp -r lib public cordis.patch.yml package.json LICENSE ~/.dsh/plugins/dsh-plugin-workflow/
> # then in profiles/web/package.json: "dsh-plugin-workflow": "link:../../plugins/dsh-plugin-workflow"
> ```

On host startup the plugin:

- serves the UI at an independent port (**3090** by default)
- registers a `/workflow` entry inside the DSH host web UI when the host exposes a web server (falls back silently to the standalone entry otherwise)
- routes every Agent node through the host's `apiProxy` as an isolated streaming session

## Configuration

Plugin options (passed to `apply(ctx, config)` by the host, also accepted by `createWorkflowServer`):

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `3090` | HTTP/SSE service port |
| `host` | `127.0.0.1` | Bind address |
| `mock` | `false` | Use `MockAgentRunner` instead of DSH sessions |
| `dataDir` | `<DSH_HOME>/workflow-plugin` | Storage root (workflows / executions / presets). `DSH_HOME` env var overrides the default `~/.dsh` |

Workflow-level configuration lives in the editor's settings page:

- **Working Directory** — absolute path; Agents run inside it
- Per-node **Model Config** — model selection per Agent
- Per-node **Review Gate** — require / skip human review of the node's output
- Per-loop **Loop Threshold** — `maxIterations`

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness (apiProxy status) |
| GET/POST | `/api/workflows` | List / create-save (validated; cycles auto-attach LoopConfig) |
| GET/DELETE | `/api/workflows/:id` | Read / delete |
| POST | `/api/workflows/:id/run` | Start an Execution |
| POST | `/api/workflows/:id/rework` | Start a Rework Execution from a node |
| GET | `/api/executions` | Execution list (supports `?workflowId=` filter) |
| GET | `/api/executions/:id` | Execution state |
| POST | `/api/executions/:id/control` | `pause` / `resume` / `stop` / `step` |
| POST | `/api/executions/:id/review` | Human review decision |
| GET | `/api/events?executionId=...` | SSE event stream (25s heartbeat) |
| GET | `/api/models` | Available models (proxied from host) |
| GET/POST/DELETE | `/api/templates[/:id]` | Workflow templates (builtin + user) |
| POST | `/api/templates/:id/instantiate` | Create a workflow from a template |
| GET/POST/DELETE | `/api/presets[/:id]` | Node presets |

## Use Cases

The 10 built-in workflow templates cover the main patterns:

**Software Engineering** — `Local Code Demo (write → run → verify)`: a coder writes a demo inside the working directory and runs it; suits real-project code tasks where Agents modify files.

**Code Review Pipeline** — `Code → Static Check → Security Review`: a coding Agent's changes flow through static-analysis and security-review Agents before reaching a human.

**Analysis Pipelines** — `Requirement → Architecture → Review (with human gate)`: three-stage pipeline where the architect's output passes a human Review Gate before review.

**Iterative Writing** — `Writing → Review loop (max 3 rounds)`: reviewer gives change requests, writer revises; converges after the loop threshold.

**Parallel Perspectives** — `Dual-track review (technical / business)`: two Agents analyze in parallel, a third consolidates; also `Task decomposition → parallel execution → integration`.

**Product Flow** — `PRD → Tech Design → Test Cases`: product manager, tech lead and QA engineer hand off through explicit data contracts.

**Data Pipeline** — `Collect → Clean → Analyze → Report`: four-stage data flow with complete data contracts per stage.

## Screenshots

Screenshots are being prepared and will live under `docs/images/`:

```text
docs/images/workflow-editor.png    (planned)
docs/images/workflow-runtime.png   (planned)
docs/images/human-review.png       (planned)
docs/images/execution-history.png  (planned)
```

## Design Principles

1. Agent is a first-class workflow node.
2. Edge is a first-class data-flow relationship.
3. Artifact is a first-class output.
4. Human Review is a first-class runtime state.
5. Execution is a first-class entity.
6. Historical executions are immutable.
7. Rework creates a new execution.
8. Workflow definitions are versioned.
9. Every workflow has exactly one Start and one End.
10. Every cycle must have a bounded execution threshold.
11. Working Directory is part of execution context.
12. Templates are separated from instances.

## Roadmap

### Completed

- [x] Visual workflow editor (native SVG, no framework)
- [x] Agent nodes with identity / role / I/O contracts
- [x] Directional data-flow edges with artifact & input mapping
- [x] Edge curve control points, manual routing
- [x] Human review: accept / reject / edit / terminate
- [x] Artifact versioning, human-edit creates new versions
- [x] Execution history (immutable) + execution tree
- [x] Rework from any node of a historical execution
- [x] Loop support with Tarjan SCC detection + mandatory threshold
- [x] Working directory binding & per-execution snapshot
- [x] Runtime control (pause / resume / stop / step)
- [x] SSE live streaming per node
- [x] 10 built-in workflow templates + user templates + node presets
- [x] Workbench / Editor / Execution views
- [x] Workflow definition versioning

### Planned

- [ ] Screenshots & demo GIF (`docs/images/`)
- [ ] Richer artifact viewers (image preview, code diff rendering)
- [ ] More built-in templates

## Project Status

**Experimental** (v0.1.0). The engine, editor and execution runtime are functional and covered by 179 passing tests, but the project is under active development — APIs and storage formats may still change.

## Development

```bash
npm install        # install dev dependencies
npm run build      # tsc → lib/
npm run typecheck  # type check without emitting
npm test           # vitest run (21 files / 179 tests)
node phase0/launch-server.mjs 3090   # standalone mock server for manual testing
```

The frontend (`public/`) is plain HTML/JS and served straight from disk — edits take effect on browser reload (bump the `?v=` cache-buster in `index.html` when changing JS files).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Implement, keeping tests green (`npm test`)
4. Commit with a clear message
5. Open a Pull Request

## License

[MIT](LICENSE) © 2026 The dsh-workflow Authors

## FAQ

**Is this a replacement for DeepSeek Harness?**
No. dsh-workflow is a workflow orchestration extension for DSH — it runs Agents through the DSH host (`apiProxy`), it does not replace it.

**Is every node an Agent?**
Node types are `start` / `end` / `agent` / `human_task`. Every work-performing node is an Agent with its own identity and contracts.

**Can workflows contain loops?**
Yes, but every detected cycle automatically gets a LoopConfig with a bounded `maxIterations` (default 3).

**Can users review Agent results?**
Yes — review is a runtime state that pauses the workflow until a human accepts, rejects (with mandatory reason), edits, or terminates.

**Can Agents modify files?**
Yes. Agents run inside the Execution's working directory; file and directory changes are captured as Artifacts with metadata.

**Can a completed workflow be resumed?**
Yes — via Rework: pick a node in a historical execution and start a new execution from it. The original execution stays untouched.

**Are historical executions modified?**
Never. Each execution binds the workflow definition snapshot it started with, and its records are immutable.

**Can workflows handle non-text artifacts?**
Yes — text, markdown, JSON, multi-file code, image, file, directory and office-document references are all first-class Artifact kinds.

---

**Terminology** — this README consistently uses: Workflow · Workflow Version · Node · Agent · Edge · Data Flow · Artifact · Review · Execution · Rework · Working Directory · Node Preset · Workflow Template. *Execution* = one concrete workflow run; *Rework* = a new execution started from a node of a historical execution.
