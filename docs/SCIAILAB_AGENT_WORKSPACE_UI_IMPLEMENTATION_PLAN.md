# SciAILab 多模态 Agent Workspace 实现方案

本文定义一套面向当前 SciAILab 架构的 `Agent Workspace` 实现方案。

目标不是再做一个普通聊天页，也不是只做一个 Web CLI 输入框，而是提供一套“人对指定 agent 的多模态工作台”。

这套工作台应允许用户：

- 用自然语言与指定 agent 沟通
- 像下命令一样给指定 agent 发布明确指令
- 上传图片
- 上传文件
- `@` 工作区文件
- `@` artifact / package / task
- 在同一界面查看 agent 的状态、任务、执行上下文和动作回执

## 1. 设计目标

这套界面要解决六件事：

1. 让用户能对单个 agent 定向沟通
2. 让用户能对单个 agent 定向下达执行指令
3. 让用户能在消息中附带图片、文件和工作区上下文
4. 让用户能像看聊天流一样查看响应、进展和系统回执
5. 让用户能在同一界面看到该 agent 的当前任务、执行上下文、交接和产出
6. 让用户能在不离开当前界面的前提下执行常见 quick action

## 2. 核心定义

`Agent Workspace` 的本质是：

- 一个面向指定 agent 的 Web 工作台
- 同时具备聊天式交互和执行式控制两种能力
- 但底层保持强执行语义和可审计性

因此，它既不是：

- 普通 IM 页面
- 通用聊天产品
- 现有 handoff queue 的可视化壳

也不是：

- 只有命令框的 Web CLI

它应当是：

- 多模态输入
- 结构化线程
- 强上下文绑定
- 和现有 execution / control / handoff 主链一致的 operator 工作台

## 3. 明确边界

### 3.1 本方案会新增什么

- 新增一级页面：`Agents`
- 新增“operator 与 agent 的会话线程”
- 新增“多模态输入 Composer”
- 新增针对 agent 工作区的 overview / thread / attachment / action API

### 3.2 本方案不会改变什么

- 不替换当前 `messages` 作为 agent-to-agent handoff 队列的职责
- 不改变当前 `Dashboard / Trace / Control / Settings` 的核心定位
- 不改变 coordinator 主链
- 不把 operator 工作线程直接塞进当前业务 handoff 模型
- 不改动长时记忆系统

### 3.3 页面职责分工

- `Dashboard`
  - 全局总览
- `Trace`
  - 时序观察、attach、执行链排障
- `Control`
  - 配置、provider、控制动作中心
- `Agents`
  - 用户与指定 agent 的多模态工作界面

## 4. 核心原则

### 4.1 像聊天，但保留执行语义

消息流的表现可以接近聊天，但不能只有“文本气泡”。

每条消息应尽量绑定：

- 发起方
- agent
- project
- task
- execution context
- 输入类型
- 意图
- 处理状态

### 4.2 业务 handoff 与 operator 线程必须分层

当前 `messages` 继续用于：

- agent -> agent handoff
- teammate messaging
- backlog / SLA / queue lens

新界面中的用户输入必须进入独立模型：

- operator -> agent 线程

否则会产生三个问题：

1. 用户自然语言会污染业务 handoff 队列
2. Dashboard / Trace 的 backlog 与 SLA 会失真
3. 后续附件、图片、文件引用很难和业务消息边界分离

### 4.3 输入能力必须多模态

一个统一输入区必须同时支持：

- 自然语言
- 指令型输入
- 图片
- 文件
- `@` 文件引用
- `@` artifact / package / task 引用

### 4.4 后端必须理解“内容”和“意图”是两层

用户可能输入：

- “帮我看一下这个 reviewer 卡在哪”
- “对当前 task 做一次 checkpoint”
- “根据这张图生成实验设计”

这些都可以是自然语言，但意图不同。

所以不能只把输入存成纯文本。

## 5. 信息架构

建议新增一级 tab：`Agents`

页面采用三栏结构。

### 5.1 左栏：Agent 列表

每个 agent 一张卡，展示：

- `agent id / role`
- 当前状态
- 当前任务
- open handoff 数
- blocked / pending 摘要
- SLA 风险
- 最近更新时间

支持筛选：

- `all`
- `active`
- `blocked`
- `waiting`
- `review_pending`
- `idle`

支持排序：

- 最近活跃
- backlog 数量
- SLA 风险

### 5.2 中栏：Agent Thread

展示当前选中 agent 的会话线程。

线程允许混排：

- `operator_message`
- `agent_response`
- `system_event`
- `control_result`
- `attachment_event`

每条消息可以附带：

- 文本
- 图片
- 文件
- 引用对象
- task / context 标签
- 执行状态标签

### 5.3 底部：Composer

Composer 是这套界面的核心。

支持：

- 文本输入
- 发送模式切换
  - `chat`
  - `command`
  - `mixed`
- 图片上传
- 文件上传
- `@` 自动补全
  - workspace file
  - artifact
  - package
  - task
- 可选绑定当前 task
- 可选绑定当前 execution context

### 5.4 右栏：Context Panel

展示当前 agent 的运行上下文：

- 当前任务
- 当前 execution context
- 当前 worktree
- 当前 provider / model / auth profile
- 最近 artifacts / packages
- 最近 handoff
- 最近 quick action

底部放 quick actions：

- `attach`
- `retry`
- `handoff`
- `checkpoint`
- `merge`
- `cleanup`
- `mark_blocked`

## 6. 数据模型设计

## 6.1 不复用现有 `messages`

现有 `messages` 继续保留给业务交接。

多模态 Agent Workspace 需要独立线程模型。

## 6.2 建议新增表

### `agent_threads`

建议字段：

- `thread_id`
- `agent_id`
- `project_id`
- `title`
- `status`
- `created_at`
- `updated_at`
- `last_message_at`
- `metadata`

用途：

- 一个 agent 在一个 project 下至少有一个默认线程
- 后续可以扩展多线程

### `agent_thread_messages`

建议字段：

- `message_id`
- `thread_id`
- `project_id`
- `agent_id`
- `task_id`
- `execution_context_task_id`
- `sender_type`
  - `operator`
  - `agent`
  - `system`
- `message_type`
  - `operator_message`
  - `agent_response`
  - `system_event`
  - `control_result`
  - `attachment_event`
- `input_mode`
  - `chat`
  - `command`
  - `mixed`
- `intent`
  - `chat`
  - `request_status`
  - `request_action`
  - `handoff_request`
  - `analysis_request`
  - `file_context`
  - `image_context`
- `content`
- `status`
  - `queued`
  - `delivered`
  - `processing`
  - `completed`
  - `failed`
- `created_at`
- `updated_at`
- `metadata`

### `agent_thread_attachments`

建议字段：

- `attachment_id`
- `message_id`
- `project_id`
- `attachment_type`
  - `image`
  - `file`
  - `workspace_file_ref`
  - `artifact_ref`
  - `package_ref`
  - `task_ref`
- `name`
- `path`
- `mime_type`
- `size_bytes`
- `metadata`
- `created_at`

用途：

- 存储上传附件和引用对象
- 保证消息内容与附件解析解耦

### `agent_operator_actions`

建议字段：

- `action_id`
- `project_id`
- `agent_id`
- `task_id`
- `action_type`
- `payload`
- `result`
- `status`
- `created_at`
- `updated_at`
- `completed_at`

用途：

- 审计 operator 发起的 quick action
- 用于在 thread 中写回 `control_result`

## 6.3 与现有模型的关系

- `agent_threads`
  - operator 与 agent 的会话容器
- `agent_thread_messages`
  - operator 与 agent 的工作沟通流
- `agent_thread_attachments`
  - 多模态输入与引用层
- `agent_operator_actions`
  - operator 动作审计
- `messages`
  - 继续只承担业务 handoff 队列职责
- `task_execution_contexts`
  - 继续作为 execution context 真相源
- `project_worktrees`
  - 继续作为 worktree 真相源

## 7. 输入模型设计

## 7.1 统一输入对象

建议前后端统一采用一套结构：

- `content`
- `input_mode`
- `intent`
- `attachments`
- `mentions`
- `task_id`
- `execution_context_task_id`
- `metadata`

## 7.2 提及与引用对象

`mentions` 建议支持：

- `workspace_file`
- `artifact`
- `package`
- `task`
- `message`

例如：

- `@workspace:src/app.tsx`
- `@artifact:draft`
- `@package:experiment_bundle`
- `@task:writer-003`

前端只做选择和回显，后端负责标准化解析。

## 7.3 附件规则

图片上传：

- 用于视觉上下文
- 可让 agent 参考 UI 截图、图表、流程图

文件上传：

- 用于临时补充材料
- 例如日志、Markdown、CSV、代码片段压缩包

工作区文件引用：

- 首选 `@workspace file`，而不是复制整个文件内容
- 后端按引用路径解析实际文件内容

## 8. API 设计

## 8.1 Agent 概览 API

### `GET /v1/agents/overview`

作用：

- 给左栏 agent 列表提供单次请求可用的数据

建议返回：

- `agent_id`
- `role`
- `state`
- `current_task_id`
- `current_task_title`
- `open_handoffs`
- `blocked_handoffs`
- `timed_out_pending_handoffs`
- `sla_status`
- `execution_context_summary`
- `last_event_at`
- `last_thread_message_at`

## 8.2 Agent 线程 API

### `GET /v1/agents/{agent_id}/thread`

作用：

- 获取默认线程和消息流

建议参数：

- `project_id`
- `limit`
- `cursor`

返回：

- thread 基本信息
- messages
- attachments
- 最近 context 摘要

### `POST /v1/agents/{agent_id}/thread/messages`

作用：

- operator 向 agent 发送多模态输入

建议 payload：

- `project_id`
- `content`
- `input_mode`
- `intent`
- `task_id`
- `execution_context_task_id`
- `attachments`
- `mentions`
- `metadata`

返回：

- 新写入的 thread message
- 解析后的 mention / attachment receipt
- 若同步触发动作，也返回 action receipt

## 8.3 附件上传 API

### `POST /v1/agents/uploads`

作用：

- 处理前端上传的图片和文件

建议返回：

- `upload_id`
- `name`
- `path`
- `mime_type`
- `size_bytes`
- `preview`

然后由 `POST /thread/messages` 只引用上传结果，不直接把大文件塞进消息接口。

## 8.4 Agent Quick Action API

### `POST /v1/agents/{agent_id}/actions`

统一承载 quick action：

- `attach`
- `retry`
- `handoff`
- `checkpoint`
- `merge`
- `cleanup`
- `mark_blocked`

建议 payload：

- `project_id`
- `task_id`
- `action_type`
- `payload`

返回：

- action status
- action result
- 关联 thread message

## 8.5 Agent 实时流 API

### `GET /v1/agents/{agent_id}/stream`

第一版建议使用 SSE。

推送事件类型：

- `thread_message_created`
- `thread_message_updated`
- `agent_state_changed`
- `task_changed`
- `action_result`
- `execution_context_changed`

## 9. 后端落点建议

建议新增或扩展以下位置：

- `python/research_runtime/storage/schema.sql`
  - 增加线程、附件、动作表
- `python/research_runtime/storage/db.py`
  - 增加 overview / thread / attachment / action 读写
- `python/research_runtime/api/app.py`
  - 增加 overview / thread / uploads / actions / stream API
- `python/research_runtime/openclaw_sync.py`
  - 负责把 operator 消息桥接到 OpenClaw agent 执行面

## 9.1 Overview read-model

左栏概览不要由前端自己拼。

后端应聚合：

- `agent_states`
- `task_execution_contexts`
- `project_worktrees`
- `messages` handoff 指标
- thread 最近消息时间

## 9.2 Thread 写入规则

operator 发消息时：

1. 先写入 `agent_thread_messages`
2. 再写入 `agent_thread_attachments`
3. 再解析 mentions
4. 再决定是否投递到实际 agent 执行面
5. 若投递成功，状态从 `queued` -> `delivered`
6. 若 agent 回写响应，再写入 `agent_response`

## 9.3 Quick Action 审计规则

所有 quick action 都应：

1. 先写 `agent_operator_actions`
2. 执行实际 control action
3. 把结果写回 action 表
4. 在 thread 中补一条 `control_result`

## 10. 前端实现方案

## 10.1 页面与组件

建议新增：

- `web/src/pages/agents-page.tsx`
- `web/src/components/agent-list.tsx`
- `web/src/components/agent-list-item.tsx`
- `web/src/components/agent-thread.tsx`
- `web/src/components/agent-thread-message.tsx`
- `web/src/components/agent-composer.tsx`
- `web/src/components/agent-context-panel.tsx`
- `web/src/components/agent-quick-actions.tsx`
- `web/src/components/agent-attachment-chip.tsx`
- `web/src/components/agent-mention-picker.tsx`

并在：

- `web/src/app.tsx`

中新增一级 tab。

## 10.2 Composer 交互

Composer 必须支持：

- 普通自然语言发送
- “作为指令发送”切换
- 图片上传按钮
- 文件上传按钮
- `@` mention 自动补全
- 当前 task 绑定切换
- 当前 execution context 绑定切换

建议默认模式：

- 默认 `mixed`

原因：

- 用户不必先学习“这句话到底是命令还是聊天”
- 后端仍可根据 `intent` 和上下文决定执行策略

## 10.3 前端状态建议

页面内至少维护：

- `selectedAgentId`
- `overview`
- `thread`
- `attachments`
- `context`
- `composerState`
- `actionBusyState`
- `uploadState`
- `streamConnectionState`

## 10.4 首版交互流程

1. 用户进入 `Agents`
2. 左栏看到 agent 列表和状态
3. 选择一个 agent
4. 中栏加载 thread
5. 右栏加载当前上下文
6. 用户输入文本，并可附图、附文件、`@` 文件
7. UI 立即生成本地消息占位
8. 后端写入消息与附件
9. 若触发执行，回写 `system_event / control_result / agent_response`

## 10.5 文案与视觉要求

- 保持当前 operator 面的高信息密度
- 严格区分 `operator / agent / system`
- 明确展示附件和引用来源
- UI 文案和业务原始值继续严格分层
- 中文 UI 文案统一受控

## 11. 分阶段实现

## Phase 1：只读工作台

目标：

- 不接真实消息投递
- 先把左栏和右栏做起来
- 中栏先展示系统事件、最近控制动作和已有上下文

交付：

- `Agents` 页路由
- 左栏概览
- 右栏 context panel
- 中栏 read-only thread

## Phase 2：多模态消息写入

目标：

- 支持自然语言输入
- 支持图片与文件上传
- 支持 `@` 引用
- 支持 thread 落库
- 暂不要求 agent 自动回复

交付：

- `agent_threads`
- `agent_thread_messages`
- `agent_thread_attachments`
- `uploads` API
- `GET/POST thread` API
- Composer UI

## Phase 3：接入 agent 响应与 SSE

目标：

- 接 OpenClaw / runtime 回写
- 实时看到 agent response 和状态变化

交付：

- SSE stream
- agent response 回写
- 线程实时刷新

## Phase 4：动作与线程闭环

目标：

- quick action 与 thread 完全联动
- 在消息流中看到动作回执

交付：

- `agent_operator_actions`
- 统一 action API
- thread `control_result`

## Phase 5：输入理解增强

目标：

- 对自然语言输入做更好的意图识别
- 对 `@workspace file` 做更稳的解析
- 对图片和文件提供更强上下文摘要

交付：

- input intent 解析器
- mention resolver
- attachment summarizer

## 12. 与现有系统的集成关系

### 与 Dashboard 的关系

- dashboard 继续看全局
- 不承载单 agent 深入交互

### 与 Trace 的关系

- Trace 继续做时序与执行排障
- `Agents` 负责面向单 agent 的工作界面

### 与 Control 的关系

- Control 继续做配置、provider、控制动作中心
- `Agents` 不复制配置能力，只消费当前配置结果

### 与现有 messages 的关系

- `messages` 是业务交接
- `agent_thread_messages` 是 operator 与 agent 的工作线程
- 两者不能混

## 13. 风险与注意事项

### 风险一：把多模态输入做成普通聊天系统

后果：

- 失去执行语义
- 难以追踪与审计

应对：

- 强制结构化 message type
- 强制保留 task / action / context 关联

### 风险二：污染现有 handoff 指标

后果：

- dashboard 和 Trace 的 backlog 失真

应对：

- 坚持新表建模
- 不复用 `messages`

### 风险三：附件与引用失控

后果：

- 文件太大
- 上下文不可控
- 安全边界不清晰

应对：

- 上传与消息写入分两步
- 引用尽量走路径或对象引用，不直接复制大内容
- 后端统一做 mention / attachment 解析

### 风险四：前端自己拼太多状态

后果：

- 页面复杂且容易错

应对：

- 后端提供 overview 聚合接口
- 前端只做展示与交互

## 14. 第一批可执行 backlog

1. 新增 `Agents` 一级导航和空页面
2. 增加 `GET /v1/agents/overview`
3. 用现有 `agent_states + execution_contexts + handoff_metrics` 搭出左栏概览
4. 新增 `agent_threads`
5. 新增 `agent_thread_messages`
6. 新增 `agent_thread_attachments`
7. 增加 `POST /v1/agents/uploads`
8. 接 `GET /v1/agents/{agent_id}/thread`
9. 接 `POST /v1/agents/{agent_id}/thread/messages`
10. 右栏接当前 task / context / worktree / artifact
11. 增加 `POST /v1/agents/{agent_id}/actions`
12. 将 `attach / checkpoint / merge / cleanup` 与 thread 回执打通
13. 最后再接 SSE

## 15. 完成定义

这套界面可以认为第一阶段完成，当且仅当：

- 用户能在 `Agents` 页看到所有 agent 的当前状态
- 用户能进入任意 agent 的专属工作区
- 用户能向该 agent 发送自然语言消息
- 用户能上传图片或文件
- 用户能 `@` 当前工作区文件或任务对象
- 输入会进入独立 thread，而不是污染现有 handoff queue
- 用户能在同页看到当前任务、执行上下文和最近控制动作

## 16. 一句话收束

`多模态 Agent Workspace` 的核心不是“再做一个聊天页”，而是给 SciAILab 补一层“人对单个 agent 的多模态、可审计、可执行工作台”，并且这层必须与现有 handoff、execution context、control action 主链严格分层。
