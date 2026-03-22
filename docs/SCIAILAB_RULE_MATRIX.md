# SciAILab Rule Matrix

本文记录当前 SciAILab runtime 的可读规则矩阵。

这里描述的是当前代码已经实现的行为，而不是理想化工作流草图。

主要实现来源：

- `python/research_runtime/orchestrator/state_machine.py`
- `python/research_runtime/orchestrator/event_consumer.py`
- `python/research_runtime/orchestrator/task_driver.py`
- `python/research_runtime/coordinators/runner.py`
- `python/research_runtime/storage/db.py`
- `openclaw/extensions/research-core/src/coordinator-agent.ts`

## 1. 适用范围

本矩阵覆盖：

- task 生命周期与状态流转
- agent state
- coordinator 完成事件
- event 到下游任务的派生规则
- reviewer loop
- package 关系
- read-model / Trace / Control 的主要契约
- auth profile 与 provider observability 的控制面边界

## 2. Task 状态矩阵

当前 task 状态：

- `todo`
- `in_progress`
- `blocked`
- `retry`
- `done`

### 2.1 允许的状态流转

| 当前状态 | 允许流向 |
| --- | --- |
| `todo` | `in_progress`、`blocked`、`retry` |
| `in_progress` | `blocked`、`retry`、`todo`、`done` |
| `blocked` | `retry`、`todo`、`in_progress` |
| `retry` | `in_progress`、`blocked`、`todo`、`done` |
| `done` | 无 |

### 2.2 操作语义

| 状态 | 含义 |
| --- | --- |
| `todo` | 新下游任务，等待被 claim |
| `in_progress` | 已被 coordinator 或 worker claim，正在执行 |
| `blocked` | 执行失败，或等待解除阻塞 |
| `retry` | 可再次运行，但明确属于重试路径 |
| `done` | 已完成的终态 |

### 2.3 Claim 规则

`/v1/tasks/claim` 当前只能 claim：

- `todo`
- `retry`

claim 后统一进入：

- `in_progress`

## 3. Agent State 矩阵

当前 agent state：

- `idle`
- `waiting_input`
- `planning`
- `executing`
- `blocked`
- `needs_human`
- `review_pending`
- `done`

当前最重要的运行时流转：

| 触发条件 | 目标 agent | 写入状态 |
| --- | --- | --- |
| 项目 bootstrap | `explorer` | `planning` |
| coordinator claim task | task owner | `executing`，reviewer 例外时为 `review_pending` |
| 实验下游任务创建 | `experiment` | `planning` 或 `executing` |
| 写作下游任务创建 | `writer` | `planning` |
| 审稿下游任务创建 | `reviewer` | `review_pending` |
| coordinator 成功完成 | 当前 owner | `idle` |
| `agent_blocked` | payload 中指定 agent 或事件来源 agent | `blocked` |
| `agent_recovered` | payload 中指定 agent 或事件来源 agent | `idle` |
| `review_approved` | `writer` 的下一阶段 agent | `done` |

## 4. Coordinator 完成矩阵

当前各 coordinator 默认 completion event：

| Coordinator | 主要产物 | 完成事件 |
| --- | --- | --- |
| `explorer` | `hypotheses` | `hypothesis_ready_for_experiment` |
| `experiment` | `results_summary` | `experiment_results_ready` |
| `writer` | `draft` | `review_requested` |
| `reviewer` | `review_report` | `review_requires_ablation`、`review_requires_evidence`、`review_requires_revision` 或 `review_approved` |

当前统一要求：

- coordinator 不直接手工造下游任务
- 下游推进统一通过 `research_task.update_status(..., eventType=...)`

## 5. Event 到下游任务矩阵

这些规则当前由 `event_consumer.py` 持有。

| Event Type | 下游 owner | Scope | 下游任务标题 | 消息类型 | Agent State |
| --- | --- | --- | --- | --- | --- |
| `hypothesis_ready_for_experiment` | `experiment` | `experiment` | 为假设包设计并运行实验 | `request` | `planning` |
| `experiment_results_ready` | `writer` | `writer` | 基于实验结果包撰写草稿 | `handoff` | `planning` |
| `writer_needs_evidence` | `experiment` | `experiment` | 补充 writer 请求的证据 | `need_evidence` | `executing` |
| `review_requested` | `reviewer` | `review` | 审阅最新草稿并返回反馈 | `review_request` | `review_pending` |
| `review_requires_ablation` | `experiment` | `experiment` | 执行 reviewer 要求的 ablation | `review_note` | `planning` |
| `review_requires_evidence` | `experiment` | `experiment` | 补充 reviewer 要求的证据 | `review_note` | `planning` |
| `review_requires_revision` | `writer` | `writer` | 根据 reviewer 反馈修订草稿 | `review_note` | `planning` |

### 5.1 非任务类事件

| Event Type | 影响 |
| --- | --- |
| `agent_blocked` | 将目标 agent 标记为 `blocked`；若 payload 含 `task_id`，相关 task 也标记为 `blocked` |
| `agent_recovered` | 将目标 agent 标记为 `idle` |
| `task_retry_requested` | 相关 task 转入 `retry`；owner agent 转入 `planning` |
| `task_requeued` | 相关 task 转回 `todo`；owner agent 转入 `planning` |
| `review_approved` | 不再新建下游任务；若提供 `next_agent`，可将其标记为 `done` |

### 5.2 下游任务复用规则

当前 runtime 已做一层幂等保护。

如果一个 event 解析出下游依赖，例如：

- `package_id`
- `artifact_id`
- `draft_artifact_id`

并且已经存在同一组：

- `project_id`
- `owner_agent`
- `dependency`

且状态仍处于：

- `todo`
- `in_progress`
- `blocked`
- `retry`

则复用现有 task，而不是重复创建。

这条规则当前最常见于：

- 同一 draft 的重复 `review_requested`
- 指向同一 `review_report` 的重复 follow-up
- 指向同一 package 或 artifact 的重复 handoff

## 6. Reviewer Loop 矩阵

当前 reviewer loop 是一个最小可验证闭环。

| 审稿轮次 | reviewer 事件 | 路由到 | 含义 |
| --- | --- | --- | --- |
| 第 1 轮 | `review_requires_ablation` | `experiment` | 追加 ablation |
| 第 2 轮 | `review_requires_evidence` | `experiment` | 补更强证据 |
| 第 3 轮 | `review_requires_revision` | `writer` | 基于已有证据重写草稿 |
| 第 4 轮及以后 | `review_approved` | `writer` | 结束当前 MVP 审稿闭环 |

设计原则：

- 当前循环是刻意确定性的
- 目的不是模拟真实学术流程，而是保证本阶段链路可测试、可复验

### 6.1 Reviewer 反馈传播规则

当前 runtime 已把 reviewer 反馈继续带入下游上下文：

- 依赖 `review_report` 的 experiment follow-up task，会把该 review report 作为 upstream dependency
- 依赖 `review_report` 的 writer revision task，也会把该 review report 作为 upstream dependency
- reviewer artifact metadata 会记录：
  - `review_cycle`
  - `requested_action`
- reviewer completion event 也会携带 `review_cycle`

因此当前 reviewer loop 虽然仍是确定性规则，但已经不是“盲模板循环”。

## 7. Package 矩阵

| Package Type | 由谁产出 | 被谁消费 |
| --- | --- | --- |
| `research_package` | explorer 输出冻结 | experiment |
| `experiment_bundle` | experiment 输出冻结 | writer |
| `writing_input_package` | writer 输入组装冻结 | writer 本轮运行与 review provenance |

## 8. Read Model 与 Trace 面

### 8.1 JSON Read Model

接口：

- `/v1/projects/{project_id}/read-model`

当前输出重点包括：

- project metadata
- summary counts
- task status distribution
- event type distribution
- latest artifacts by type
- latest packages by type
- active tasks
- agent states
- active worktrees
- execution contexts
- recent hooks
- pending inbox
- teammate messages
- handoff metrics
- handoff SLA
- recent timeline

### 8.2 Trace 页面

当前 Trace 不再只是原始列表，而是 operator 观察台。

当前重点包括：

- attach-first 执行视图
- task / worktree / execution context / hook 联动
- inbox / teammate messaging
- queue 分组与过滤
- handoff backlog / SLA
- unified timeline

### 8.3 WebUI 契约方向

当前契约方向很明确：

- JSON read-model 是稳定的机器接口
- HTML Trace 或 Web Trace 都只是该接口之上的观察面
- 不再额外发明第二套项目状态 API

## 9. Control / Auth Profile 矩阵

本节记录当前控制面中的认证与 provider 边界。

主要实现来源：

- `python/research_runtime/api/app.py`
- `python/research_runtime/storage/db.py`
- `python/research_runtime/openclaw_sync.py`
- `web/src/pages/control-page.tsx`

### 9.1 真相源分层

| 层 | 存什么 | 真相源角色 |
| --- | --- | --- |
| SciAILab SQLite `auth_profiles` | `label`、`auth_type`、`status`、`credential_ref`、`login_hint` 等控制面元数据 | 本地控制面元数据真相源 |
| OpenClaw `auth-profiles.json` | 实际 provider 凭据与 OpenClaw auth runtime 状态 | 凭据真相源 |
| OpenClaw usage/auth snapshot | cooldown、disable、last-used、quota、failure counters | 运行态与可观测性真相源 |

当前规则：

- `credential_ref` 不是秘密存储
- API key、OAuth token 等真实凭据仍由 OpenClaw auth storage 持有

### 9.2 控制面接口矩阵

| Endpoint | 作用 | 主要落点 |
| --- | --- | --- |
| `GET /v1/control/auth-profiles` | 获取合并后的认证库存视图 | SQLite + OpenClaw snapshot |
| `POST /v1/control/auth-profiles` | 更新本地 profile 元数据 | SQLite |
| `POST /v1/control/auth-profiles/api-key` | 快速录入 API key profile | 先写 OpenClaw，再同步 SQLite |
| `POST /v1/control/auth-profiles/test` | 刷新 / 测试合并后的认证状态 | snapshot 驱动 |
| `GET /v1/control/provider-observability` | 获取 provider 运行态 | SQLite + OpenClaw snapshot |

### 9.3 WebUI 录入矩阵

当前 `web/Control` 故意拆成两条 operator 路径：

| UI 面 | 用途 | 是否写入真实密钥 |
| --- | --- | --- |
| Quick API-key entry | 创建或更新真实 provider API-key profile | 是 |
| Advanced metadata editor | 编辑本地 profile 元数据、备注、绑定提示 | 否 |

当前规则：

- Quick API-key entry 是主要入口
- metadata editor 只负责本地记录
- 仅编辑 `credential_ref` 不代表已经写入可用凭据

### 9.4 Profile 合并规则

当前库存合并规则：

- 先从 SQLite 读取本地 profile
- 再从 OpenClaw `auth-profiles.json` 读取 runtime profile
- 按 `profile_id` 合并

由 OpenClaw 运行态覆盖的字段主要包括：

- connection status
- cooldown / disabled windows
- last used
- failure counters

由 SciAILab 本地控制面继续持有的字段主要包括：

- `label`
- `login_hint`
- 本地 `account_label`
- 人工维护的 `credential_ref`

### 9.5 API-key 录入规则

当前 direct API-key 流程：

1. WebUI 提交 provider、API key 与可选 metadata 到 `POST /v1/control/auth-profiles/api-key`
2. FastAPI 在 OpenClaw auth store 中写入 `api_key` profile
3. FastAPI 在 SQLite 中同步镜像一条本地 profile
4. 后续 inventory / observability 读取合并视图

直接结果：

- 新录入的 API-key profile 可以立即出现在 role binding 下拉里
- 同一凭据随后进入现有 `auth_profile` 路由模型

### 9.6 UI 分层规则

WebUI 必须严格区分三类东西：

- UI 文案与交互文案
- SciAILab 本地控制面元数据
- OpenClaw 运行态 / 业务原始值

原因是：

- 本地化不能翻译业务原始值
- 视觉改版不能污染 runtime 数据
- operator workflow 不能反向改写不该改的字段

## 10. 验证矩阵

当前本地验证覆盖：

| 验证项 | 覆盖内容 |
| --- | --- |
| `python scripts/verify_fastapi_runtime.py` | task 状态流转、event 下游规则、read-model JSON、trace 页面 |
| `python scripts/verify_coordinator_pipeline.py` | Python coordinator 链路与 reviewer loop |
| `tsx scripts/verify_openclaw_agent_coordinator.mjs` | OpenClaw agent-backed coordinator 主链与 reviewer 事件 |
| `tsx --tsconfig tsconfig.runtime-imports.json ..\\scripts\\verify_openclaw_plugin_import.mjs` | 插件导入与注册 |

## 11. 当前边界

本矩阵当前仍未覆盖这些高级规则：

- retry limit
- dead-letter routing
- 人工介入策略
- 跨项目 memory retrieval
- 更复杂的多 worker 并发策略
- 独立 WebUI 的完整交互契约细节

这些仍属于下一阶段的 workflow hardening 范围，而不是当前最小规则集的一部分。
