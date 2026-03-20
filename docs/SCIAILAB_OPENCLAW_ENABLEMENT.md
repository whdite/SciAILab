# SciAILab OpenClaw Enablement

本文说明 SciAILab 如何在当前 OpenClaw workspace 中启用 `research-core`，以及当前已经跑通的最小运行与验证路径。

## 1. 当前集成位置

`research-core` 当前位于：

- `openclaw/extensions/research-core/index.ts`
- `openclaw/extensions/research-core/openclaw.plugin.json`

核心职责：

- 为 OpenClaw 提供 SciAILab research control-plane 插件入口
- 将 OpenClaw tool/gateway/service 接到 Python FastAPI runtime
- 负责 coordinator 任务 claim、subagent 执行、artifact/package/message/event/state 回写

## 2. 当前架构形态

当前推荐的运行形态是：

`OpenClaw research-core -> FastAPI runtime -> SQLite truth store + workspace/projects`

其中：

- OpenClaw 负责插件入口、gateway、tool、subagent runtime
- FastAPI 负责事件、任务、状态和数据访问驱动
- SQLite 负责当前 truth store
- `workspace/projects/<project-id>/` 负责项目工作目录和 artifact 文件

## 3. 当前启用配置

`research-core` 当前推荐配置如下：

```json5
{
  plugins: {
    entries: {
      "research-core": {
        enabled: true,
        config: {
          transport: "fastapi",
          serviceBaseUrl: "http://127.0.0.1:8765",
          dbPath: "../data/research.db",
          workspaceRoot: "../workspace/projects",
          coordinatorExecution: "agent",
          coordinatorAutoRun: true,
          coordinatorPollMs: 3000,
          coordinatorBatchSize: 1,
          coordinatorRunTimeoutMs: 180000,
          coordinatorSessionPrefix: "agent:main:subagent:research-core",
          coordinatorDeleteSession: true
        }
      }
    }
  }
}
```

说明：

- `transport` 当前默认推荐 `fastapi`
- `coordinatorExecution` 当前默认推荐 `agent`
- `coordinatorAutoRun=true` 时，插件 service 会自动轮询任务队列
- `dbPath` 与 `workspaceRoot` 都是相对 SciAILab 项目根解析

## 4. 当前开放的能力面

### 4.1 Gateway Methods

当前已接入：

- `research.project.create`
- `research.project.status`
- `research.control.agent_routing.get`
- `research.control.agent_routing.update`
- `research.control.agent_activation.set`
- `research.control.scheduler_state.get`
- `research.artifact.list`
- `research.message.send`
- `research.message.list`
- `research.event.emit`
- `research.event.list`
- `research.event.consume`
- `research.package.freeze`
- `research.package.list`
- `research.task.create`
- `research.task.list`
- `research.task.update_status`
- `research.state.agent_list`
- `research.coordinator.run`

### 4.2 Agent Tools

当前已接入：

- `research_project`
- `research_control`
- `research_artifact`
- `research_message`
- `research_event`
- `research_freeze`
- `research_task`
- `research_state`
- `research_coordinator`

### 4.3 Coordinator Service

当前 service 行为：

- 自动轮询 FastAPI task queue
- 按 role worker pool 调用 `/v1/tasks/claim`
- 按 explorer / experiment / writer / reviewer 独立并发启动 subagent
- 解析 subagent JSON 输出
- 写入 artifact markdown
- 注册 artifact / package / message
- 调用 `research_task.update_status(..., eventType=...)`
- 更新 agent state
- 拉取 `/v1/control/agent-routing` 并按 role 应用 `active/provider/model/max_concurrency`

### 4.4 Control Plane

当前 FastAPI 已提供控制面接口：

- `GET /v1/control/agent-routing`
- `POST /v1/control/agent-routing`
- `POST /v1/control/agent-activation`
- `GET /v1/control/scheduler-state`

当前 OpenClaw 已暴露对应 gateway/tool：

- gateway: `research.control.agent_routing.get`
- gateway: `research.control.agent_routing.update`
- gateway: `research.control.agent_activation.set`
- gateway: `research.control.scheduler_state.get`
- tool: `research_control`

## 5. 四类 Coordinator 现状

当前四类角色均已接入 agent-backed 主链：

- explorer
- experiment
- writer
- reviewer

当前角色 skill 目录：

- `openclaw/extensions/research-core/skills/sciailab-explorer-coordinator/`
- `openclaw/extensions/research-core/skills/sciailab-experiment-coordinator/`
- `openclaw/extensions/research-core/skills/sciailab-writer-coordinator/`
- `openclaw/extensions/research-core/skills/sciailab-reviewer-coordinator/`

当前统一输出要求：

- subagent 必须返回结构化 JSON
- 至少包含 `artifact_markdown`
- reviewer 的 `event_type` 当前应收敛在以下集合之一：
- `review_requires_ablation`
- `review_requires_evidence`
- `review_requires_revision`
- `review_approved`

## 6. 当前最小运行路径

当前已经跑通的最小主链如下。

### 6.1 创建项目

- FastAPI 创建项目记录
- 初始化 `workspace/projects/<project-id>/`
- 自动生成最小初始 task / state

### 6.2 事件与任务推进

- 事件写入 `events`
- 事件消费器生成下游 task / message / state
- task queue 支持按项目和角色 claim

### 6.3 Agent-backed Coordinator 执行

- OpenClaw `research-core` claim task
- subagent 按角色执行
- coordinator 输出 artifact / message / event
- downstream 在 FastAPI 侧继续推进

### 6.4 Frozen Package

- explorer / experiment 产出可冻结包
- writer 消费 `writing_input_package`
- 写作输入不再依赖“实时最新目录状态”

## 7. 当前 workspace 兼容层

由于当前 OpenClaw workspace 存在 package exports、dist 产物与依赖版本漂移，`research-core` 的本地 enablement 额外依赖几个兼容步骤。

### 7.1 运行时 tsconfig

文件：

- `openclaw/tsconfig.runtime-imports.json`

用途：

- 避开主 `tsconfig.json` 里过重的 `paths`
- 让插件导入优先按 package/runtime 方式解析

### 7.2 plugin-sdk runtime shim

脚本：

- `openclaw/scripts/ensure-plugin-sdk-runtime-shims.mjs`

用途：

- 为 `package.json exports` 中声明但缺失或漂移的 `dist/plugin-sdk/*.js` 生成桥接入口
- 当前用于本地 workspace verify，不是产品层逻辑

### 7.3 pi-ai compatibility patch

脚本：

- `openclaw/scripts/ensure-pi-ai-compat.mjs`

用途：

- 修正 `@mariozechner/pi-ai` 主入口与当前 OpenClaw 运行时代码之间的 OAuth 导出漂移

### 7.4 openclaw self-reference

当前本地 bootstrap 会创建：

- `openclaw/node_modules/openclaw -> openclaw`

用途：

- 解决本地 workspace 下 `openclaw/...` 自引用包名解析

## 8. 当前一键脚本

当前推荐直接使用：

- `scripts/bootstrap_verify_research_core.ps1`

完整执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1
```

只做复验：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1 -VerifyOnly
```

该脚本会自动完成：

- Python runtime editable install
- OpenClaw 最小依赖安装
- workspace 兼容修复
- FastAPI / coordinator / plugin import 验证

## 9. 当前已通过验证

### 9.1 FastAPI Runtime

命令：

- `python scripts/verify_fastapi_runtime.py`

覆盖：

- health
- task create
- artifact transition
- downstream event trigger
- reviewer state update
- control routing update / activation
- scheduler state readback

### 9.2 Python Coordinator Pipeline

命令：

- `python scripts/verify_coordinator_pipeline.py`

覆盖：

- explorer -> experiment -> writer -> reviewer 最小模板链
- task / artifact / package / state / event 落库

### 9.3 OpenClaw Agent-backed Coordinator

命令：

- `tsx scripts/verify_openclaw_agent_coordinator.mjs`

覆盖：

- FastAPI + SQLite 隔离环境
- `runResearchCoordinatorPass(...)`
- task claim
- subagent mock JSON output
- artifact / package / message / event / state 回写

### 9.4 Plugin Import / Registration

命令：

- `tsx --tsconfig tsconfig.runtime-imports.json ..\scripts\verify_openclaw_plugin_import.mjs`

覆盖：

- `research-core` 插件导入
- `register(...)`
- gateway/tool/service 注册数量验证

当前结果：

- `plugin_id = research-core`
- `tool_count = 9`
- `service_count = 1`
- `gateway_count = 19`

### 9.5 Coordinator Worker-Pool Service

命令：

- `tsx scripts/verify_openclaw_coordinator_service_pool.mjs`

覆盖：

- per-role worker pool 并发执行
- 不同 role 使用不同 provider/model 路由
- explorer 并发上限生效
- 某 role 的路由配置不影响其它 role

## 10. 当前边界

当前已经解决的是：

- 当前 workspace 中 `research-core` 可本地运行
- 当前 workspace 中 `research-core` 可本地验证

当前还没有解决的是：

- 整个 OpenClaw 仓库无条件全量 `pnpm install`
- 整个 OpenClaw 仓库全量构建与全量测试恢复
- `auth_profile` 目前只能被控制面存储，尚不能真正透传到 OpenClaw subagent runtime

主要原因：

- OpenClaw 上游 workspace 仍存在私有依赖和构建产物漂移
- 当前兼容方案是为 `research-core` enablement 服务，不是全仓修复完成
- 当前宿主 runtime 的 `SubagentRunParams` 还没有可执行的 `authProfile` 参数

## 11. 下一步建议

当前 OpenClaw enablement 已经从“能接入”推进到“能运行、能验证”。
下一步建议优先做：

- 增强 event -> task 规则表
- 增强 reviewer 回路
- 增强 trace / log / observability
- 把当前 bootstrap/verify 脚本纳入团队日常开发入口

## 12. 一句话收束

`research-core` 当前已经不是一个“可被启用的插件骨架”，而是一个在当前 workspace 下可本地 bootstrap、可本地 verify、并且能够真实驱动 SciAILab event/task/coordinator 主链的 OpenClaw 集成层。
