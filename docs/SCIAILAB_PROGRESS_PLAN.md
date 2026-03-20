# SciAILab Progress Plan

本文记录 SciAILab 当前已经落地的部分、剩余差距，以及接下来的推进顺序。
这里不再保留早期的理想化阶段拆分，而是以当前代码和验证结果为准。

## 1. 当前结论

截至当前版本，SciAILab 已经完成了第一条可运行主链路：

- Python 侧以 FastAPI 驱动 research event/task/runtime
- SQLite 作为当前 truth store 已经跑通
- OpenClaw `research-core` 已接入项目、任务、事件、消息、包、状态管理
- OpenClaw `research-core` 已接入研究控制面，支持 agent routing / activation / scheduler state
- 四类 coordinator 已切到 agent-backed 执行路径
- coordinator 调度已从单 pass 串行演进到按 role worker pool
- coordinator 完成后统一通过 `research_task.update_status(..., eventType=...)` 推进下游
- 当前 workspace 已具备本地 bootstrap 和 verify 能力

这意味着项目已经从“架构规划期”进入“主链路持续强化期”。

## 2. 已落地能力

### 2.1 数据与运行时

已落地：

- SQLite truth store
- FastAPI runtime
- 项目、artifact、message、event、package、task、agent state 表与读写接口
- 事件消费器
- task 驱动器
- artifact state / agent state 更新逻辑

当前判断：

- SQLite 作为当前单机场景的 truth store 是够用的
- 现阶段不需要为了“跨项目全局记忆”立刻引入 PostgreSQL
- 如果未来要做跨项目共享记忆、复杂查询、并发 worker 扩展，再考虑把 PostgreSQL 作为 memory/index/control-plane 扩展层，而不是替换当前 SQLite 主链

### 2.2 OpenClaw 集成

已落地：

- `openclaw/extensions/research-core/`
- gateway methods
- agent tools
- coordinator service
- coordinator config schema
- role skills

当前可用接口覆盖：

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

工具侧已落地：

- `research_project`
- `research_control`
- `research_artifact`
- `research_message`
- `research_event`
- `research_freeze`
- `research_task`
- `research_state`
- `research_coordinator`

### 2.3 Coordinator 主链

已落地：

- explorer
- experiment
- writer
- reviewer

当前执行模式：

- 默认模式为 `agent`
- OpenClaw service 按 role worker pool 轮询并 claim task
- 按角色启动 subagent
- 按 role 读取控制面路由配置并应用 `active/provider/model/max_concurrency`
- subagent 返回结构化 JSON
- 自动写 artifact
- 自动注册 package/message/task completion/event/state

当前默认事件推进：

- explorer -> `hypothesis_ready_for_experiment`
- experiment -> `experiment_results_ready`
- writer -> `review_requested`
- reviewer -> `review_requires_ablation`
- reviewer -> `review_requires_evidence`
- reviewer -> `review_requires_revision`
- reviewer -> `review_approved`

### 2.4 Frozen Package

已落地：

- `research.package.freeze`
- writer 输入冻结包 `writing_input_package`
- explorer / experiment 输出冻结包

当前约束：

- writer 不再直接追“最新目录状态”
- writer 读取冻结输入包，保证当前写作轮次可审计、可复现

## 3. 当前验证状态

以下验证已经通过：

- `python scripts/verify_fastapi_runtime.py`
- `python scripts/verify_coordinator_pipeline.py`
- `tsx scripts/verify_openclaw_agent_coordinator.mjs`
- `tsx scripts/verify_openclaw_coordinator_service_pool.mjs`
- `tsx --tsconfig tsconfig.runtime-imports.json ..\scripts\verify_openclaw_plugin_import.mjs`

此外，已收敛出一键脚本：

- `powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1`

支持两种模式：

- `bootstrap+verify`
- `verify-only`

该脚本已经验证通过，当前 workspace 可本地运行并验证 `research-core`。

## 4. 当前阶段判断

当前建议把项目状态定义为：

### 已完成

- P0 架构冻结
- P1 SQLite + FastAPI truth/runtime 主链
- P2 research-core 启用与最小调用路径
- P3 event bus / frozen package / task 状态推进
- P4 四类 coordinator 接入 event-driven downstream
- P5 agent-backed coordinator 实装
- P6 workspace bootstrap/verify 收敛
- P7 控制面路由接口与按 role worker pool 调度

### 进行中

- coordinator 从“最小可运行”向“更强执行策略”演进
- review loop 的策略细化
- OpenClaw workspace 开发体验稳定化
- control-plane 配置向真正的多 provider / 多凭证执行能力继续演进

### 未完成

- 真正的长期 memory 层
- 多 worker / 多进程并发策略
- 全量 observability 面板
- 大规模 reconcile / retry / dead-letter 策略
- 更完整的 reviewer 决策分叉
- 端到端 demo 工程模板
- `auth_profile` / OAuth 在 subagent runtime 的可执行透传

## 5. 下一阶段优先级

建议接下来按下面顺序推进。

### Priority A

- 强化 `research_task` 生命周期定义
- 补齐 task claim / retry / blocked / requeue 规则
- 明确每类 event 对应的下游 task 生成策略

### Priority B

- 强化 reviewer 回路
- 细化 `review_requires_ablation` 的下游拆解
- 区分“补实验”“补证据”“补写作”三类返工

### Priority C

- 做可观测性
- 增加 coordinator run log / event trace / task trace
- 给 project 级状态页补更清晰的 summary

### Priority D

- 设计跨项目 memory
- 先明确 memory schema 和 retrieval contract
- 再判断是否需要 PostgreSQL / pgvector，而不是先换库

## 6. 当前主要风险

### 风险一：OpenClaw workspace 依赖漂移

现状：

- `research-core` 当前已经可以在本地 workspace 下 bootstrap 和 verify
- 但 OpenClaw 整仓仍存在依赖和构建产物漂移
- 因此需要本地 shim 和 compat 脚本

应对：

- 保留 bootstrap/verify 脚本
- 把 runtime shim 当作当前 workspace 兼容层，而不是产品逻辑

### 风险二：event 规则继续散落

现状：

- 当前链路已跑通
- 但 event -> downstream task 的规则仍需要继续系统化

应对：

- 把事件类型、触发条件、下游 task 模板写成明确规则表

### 风险三：review loop 过于粗糙

现状：

- reviewer 已经具备 `review_requires_ablation` / `review_requires_evidence` / `review_requires_revision` / `review_approved` 四类结果
- 但当前仍主要是最小模板化分支，尚未形成更细的审稿判定准则与回环约束

应对：

- 下一阶段优先补 reviewer 分叉策略，而不是过早扩更多 coordinator 类型

### 风险四：控制面配置与执行面能力暂未完全对齐

现状：

- FastAPI/SQLite 已经能保存 role 级 `provider/model/auth_profile/max_concurrency`
- OpenClaw 当前已执行 `provider/model/max_concurrency/active`
- `auth_profile` 还不能真正送入 subagent runtime

应对：

- 下一步需要在宿主 runtime 补可执行的 auth profile 参数，而不是继续只扩存储层

## 7. 当前完成定义

如果只讨论“当前 research-core enablement 是否完成”，可以定义为：

- 能启动 FastAPI runtime
- 能创建项目和状态数据
- 能消费 event 并生成 downstream task
- 能运行四类 coordinator
- 能经由 agent-backed path 写 artifact / package / message / event / state
- 能在当前 workspace 下一键 bootstrap 和 verify

这个目标当前已经达成。

## 8. 一句话收束

SciAILab 当前不是停留在规划文档阶段，而是已经拥有一条由 FastAPI、SQLite、OpenClaw `research-core`、四类 coordinator 和 event-driven downstream 组成的可运行主链；接下来重点应放在规则强化、review 回路和可观测性，而不是重新讨论底层骨架。
