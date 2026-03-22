# SciAILab Progress Plan

## 2026-03-22 Update

- 已完成一轮真实的 `zai / glm-5` coordinator 全链路验证，短项目 `g1` 收敛结果为：
  - `12` 个任务全部 `done`
  - `0` 个 `blocked_tasks`
  - `0` 个 `active_tasks`
  - `review_approved` 已出现
  - `worktrees / execution_contexts / completion_hooks` 均完成自动收口
- OpenClaw `research-core` 已补 `subagent.allowModelOverride = true`
- FastAPI 运行已切到短 worktree 根目录 `C:\\wt`，规避 Windows 长路径问题
- `Agents` 页已从“只有 operator thread”推进到“operator thread + derived business replay”
- Agent Workspace 当前已支持三类聊天化回显：
  - `Agent 输出`
  - `交接消息`
  - `系统状态`
- 当前最值得继续推进的不是再扩架构，而是：
  - 继续清洗 `Agents` 页中文文案
  - 细化 `approval / review_request / review_note` 中文模板
  - 评估 `Agents` 页增量推送而不是纯轮询

本文只记录当前代码已经落地的事实、已验证结果，以及下一阶段仍应推进的事项。

默认阅读顺序：

1. `setup.md`
2. `docs/README.md`
3. 本文
4. `docs/SCIAILAB_RULE_MATRIX.md`
5. `docs/SCIAILAB_P3D_EXECUTION_BACKLOG.md`

## 1. 当前结论

截至 `2026-03-21`，SciAILab 已经不再处于纯设计阶段，而是进入“主链可运行、持续补强”的阶段。

当前已经稳定成立的主链是：

`OpenClaw research-core -> FastAPI runtime -> SQLite truth store -> workspace/projects + worktrees -> WebUI operator surfaces`

这条主链已经具备以下特征：

- OpenClaw 负责插件注册、subagent 执行、gateway method、auth/runtime 对接
- FastAPI 负责项目、任务、事件、消息、状态、控制动作和 read-model
- SQLite 继续作为当前单机场景下的 truth store
- coordinator 已切到以 agent-backed 为主的执行路径
- worktree / execution context / completion hook 已进入运行时主链
- WebUI 已具备 dashboard、Trace、Control、Settings 四类操作入口

## 2. 当前架构基线

### 2.1 运行时分层

- `openclaw/extensions/research-core`
  - 插件入口
  - gateway methods
  - agent tools
  - coordinator service
- `python/research_runtime`
  - FastAPI API
  - SQLite 访问层
  - state machine
  - event consumer
  - task driver
  - worktree / execution context / completion hook 读写
- `workspace/projects/<project-id>/`
  - canonical project workspace
- `workspace/worktrees/<project-id>/<role>/<task-id>/`
  - execution workspace
- `web/`
  - 独立前端应用
  - dashboard / Trace / Control / Settings

### 2.2 当前边界

- 不改长时记忆系统
- 不替换 SQLite
- 不把 tmux 升格为运行时契约
- 不把 leader prompt 变成主编排器
- 不把 SciAILab 改造成通用 swarm shell

## 3. 已落地能力

### 3.1 数据与运行时

已落地：

- FastAPI runtime
- SQLite truth store
- 项目、任务、事件、消息、artifact、package、agent state 基础表与 API
- task state machine
- event consumer
- task driver
- project read-model

当前判断：

- 单机开发与联调阶段，SQLite 足够
- PostgreSQL 仍属于后续扩展项，不是当前主线阻塞

### 3.2 OpenClaw 集成

已落地：

- `research-core` 插件注册
- gateway methods
- agent tools
- coordinator service
- 基于角色的 subagent 执行
- provider / model / auth profile / max concurrency 路由

当前主角色：

- `explorer`
- `experiment`
- `writer`
- `reviewer`

### 3.3 Coordinator 主链

已落地：

- coordinator 默认走 `agent` 执行模式
- 通过 `research_task.update_status(..., eventType=...)` 统一推进下游
- role worker-pool 可按角色 claim task
- 结构化输出会回写 artifact / package / message / event / state

当前默认事件推进：

- `explorer -> hypothesis_ready_for_experiment`
- `experiment -> experiment_results_ready`
- `writer -> review_requested`
- `reviewer -> review_requires_ablation`
- `reviewer -> review_requires_evidence`
- `reviewer -> review_requires_revision`
- `reviewer -> review_approved`

### 3.4 执行隔离与结果收口

已落地：

- `project_worktrees`
- `task_execution_contexts`
- `task_completion_hooks`
- `/v1/worktrees`
- `/v1/execution-contexts`
- `/v1/completion-hooks`
- `/v1/control/actions/attach`
- `/v1/control/actions/checkpoint`
- `/v1/control/actions/merge`
- `/v1/control/actions/cleanup`

当前行为：

- coordinator 优先把实际输出写入 `execution_workspace_path`
- 任务进入 `done` 后会触发自动收口链
- 当前自动链路为：
  - `done -> checkpoint -> merge -> cleanup`

说明：

- 当前 `merge` 仍是保守的 promote/copy 语义
- 这不是完整 git merge
- 但已经满足当前 artifact/package 归档与收口需求

### 3.5 消息交接与 operator 视图

已落地：

- `messages` 已从被动记录升级为可操作 handoff queue
- message action：
  - `mark-read`
  - `ack`
  - `handoff-state`
- timeline audit event 已接入消息动作
- read-model 已提供：
  - `pending_inbox`
  - `teammate_messages`
  - `recent_messages`
  - `handoff_metrics`
  - `handoff_sla`

当前可见能力：

- blocked handoff 统计
- timed-out pending 统计
- unacked 统计
- 按 agent 的 SLA 面板
- queue 分组与过滤

### 3.6 WebUI

当前页面：

- 首页 dashboard
- `Trace`
- `Control`
- `Projects`
- `Settings`

已完成的关键能力：

- 首页已从展示页转成 operator dashboard
- dashboard 已接入：
  - lab 运行状态
  - handoff queue
  - operator backlog
  - agent SLA
  - worktree
  - execution context
  - 调度日志
- `Trace` 已支持：
  - attach-first 视图
  - worktree / execution context / hook 详情
  - inbox / teammate messaging
  - queue 分组 / 过滤 / quick action
- `Control` 已支持：
  - role routing
  - activation
  - auth profile inventory / quick API-key entry
  - provider observability
  - worktree / execution context / hooks 面板
  - runtime policy 只读面板
- `Settings` 已支持：
  - API / Gateway 地址
  - 自动刷新
  - 语言
  - handoff SLA 阈值配置

### 3.7 文档收口

本轮已完成文档收口：

- `docs/README.md` 作为统一阅读入口
- `setup.md` 作为统一启动说明
- 删除已被当前实现替代的重复设计文档

## 4. 已验证

已明确通过的验证包括：

- `python -m compileall python/research_runtime`
- `npm --prefix web run build`
- `python scripts/verify_fastapi_runtime.py`
- `python scripts/verify_coordinator_pipeline.py`
- `tsx scripts/verify_openclaw_agent_coordinator.mjs`
- `tsx scripts/verify_openclaw_coordinator_service_pool.mjs`
- `tsx --tsconfig tsconfig.runtime-imports.json ..\\scripts\\verify_openclaw_plugin_import.mjs`

运行时配置 smoke 也已验证：

- 默认 `handoff_pending_timeout_seconds = 1800` 时，旧 pending 会进入 `aged_pending_count`
- 调高到合法大阈值后，`aged_pending_count` 会按预期下降到 `0`

## 5. 当前最值得继续推进的工作

### 5.1 P3-D 收尾

优先继续补强这些闭环：

1. dashboard 上继续补 `attach / checkpoint / merge / cleanup` 操作入口
2. completion policy 继续从“只处理 done”扩展到 `blocked / failed`
3. CLI / Web / OpenClaw helper 继续统一 control action 契约

### 5.2 runtime policy

下一步不再只做 handoff SLA，而要继续扩展：

- queue escalation policy
- completion hook policy
- blocked / failed task post-processing policy

### 5.3 UI 与文案清洗

仍需继续清理：

- operator-facing UI 文案残留的编码噪声
- 部分控件与状态文本的中英混杂
- 历史页面残留的措辞不一致

### 5.4 provider / auth 侧能力

仍值得继续增强：

- quota 观测
- failover policy
- role 级 provider policy
- auth inventory 与运行时状态的更清晰映射

## 6. 当前执行顺序建议

建议继续按这个顺序推进：

1. 完成 operator 面剩余闭环
2. 完成 runtime policy 第二阶段
3. 继续清洗 UI 文案与文档
4. 再评估更远期的 memory / remote worker / 更强 scheduler

原因是：

- 当前主链已经成立
- 继续开新架构分支收益不高
- 现阶段最大价值来自“把 operator 闭环做完整”

## 7. 当前主要风险

### 风险一：UI 与文案债务

现状：

- 页面功能已经显著超出早期基线
- 但文案、语言层、历史遗留编码问题仍可能影响可读性

应对：

- 继续按页面做文案与编码清洗
- 保持“UI 文案”和“业务原始值”严格分层

### 风险二：runtime policy 仍偏薄

现状：

- handoff SLA 已落地
- 但 blocked / failed / escalation / completion hook policy 仍不完整

应对：

- 继续把 policy 前置到 runtime 读写模型和设置面板

### 风险三：结果收口仍偏保守

现状：

- 当前 `merge` 主要是安全 promote/copy
- 对复杂代码分支场景，能力还不够强

应对：

- 先保持保守语义
- 等 operator 面和 policy 面稳定后，再评估更强 merge 策略

## 8. 当前完成定义

如果只讨论“当前 SciAILab 主链是否已经可用”，完成定义可以写成：

- 能启动 FastAPI runtime
- 能启动 OpenClaw gateway 与 `research-core`
- 能通过 WebUI 和 API 看到 project / task / event / message / state
- 能由 coordinator 通过 agent-backed 路径完成下游推进
- 能在任务完成后触发 checkpoint / merge / cleanup 自动链
- 能在 dashboard / Trace / Control 中看到 operator 所需核心状态

按这个定义，当前版本已经满足“可用主链已成立”。

## 9. 一句话收束

SciAILab 当前最重要的事情，不是重新讨论架构，而是继续把已经跑通的 execution isolation、handoff queue、operator board、runtime policy 和结果收口闭环做完整。
