# SciAILab P3-D 开源协作执行增强 Backlog

本文把 `SCIAILAB_PROGRESS_PLAN.md` 中的 `P3-D 开源协作执行增强计划` 继续拆成可直接执行的 backlog。目标不是再写一版抽象方案，而是把后续开发拆到可以分配、编码、联调、验收的粒度。

相关文档：

- `docs/SCIAILAB_PROGRESS_PLAN.md`
- `docs/SCIAILAB_WORKTREE_ISOLATION_DESIGN.md`
- `docs/CLAWTEAM_SCIAILAB_DESIGN_COMPARISON.md`
- `docs/SCIAILAB_RULE_MATRIX.md`

---

## 1. 执行边界

本 backlog 默认遵守以下约束：

- 不改长时记忆系统，`memory/` 仍留在 canonical workspace
- 不替换 `SQLite` truth store
- 不把 `tmux` 升格为必需运行时依赖
- 不把 leader / coordinator prompt 变成主编排器
- 不把 OpenClaw `research-core` 从现有主链上拆出去

---

## 2. 里程碑顺序

建议按以下顺序推进：

1. `P3-D1` 执行环境隔离
2. `P3-D2` operator board / attach 看板
3. `P3-D3` inbox / handoff / teammate messaging
4. `P3-D4` checkpoint / merge / cleanup / archive
5. `P3-D5` FastAPI control actions + OpenClaw helper

其中：

- `P3-D1` 是后续能力的基础依赖
- `P3-D2` 与 `P3-D3` 可以部分并行，但应共享 read-model contract
- `P3-D4` 需要建立在 `P3-D1` 的执行上下文和 `P3-D3` 的交接可见性之上
- `P3-D5` 最后收口，避免先做入口、后补能力

---

## 3. Epic 级拆分

### P3-D1 执行环境隔离

#### BL-001 扩充 SQLite schema，建立 worktree 与执行上下文表

- 目标：为 canonical workspace、execution worktree、task execution context 建立可查询真相源
- 代码落点：
  - `python/research_runtime/storage/schema.sql`
  - `python/research_runtime/storage/db.py`
- 建议新增表：
  - `project_worktrees`
  - `task_execution_contexts`
  - `task_completion_hooks`
- 完成标准：
  - `project_id` 可映射到 canonical workspace
  - `task_id` 可映射到 execution workspace
  - worktree 具备 `status / branch / created_at / released_at / cleanup_at` 等生命周期字段
  - 支持后续查询“当前哪些任务占用哪些 worktree”

#### BL-002 增加 worktree manager 模块

- 目标：把 `git worktree add/list/remove/prune` 封装成运行时能力，而不是散落在 shell 脚本里
- 代码落点：
  - 新增 `python/research_runtime/orchestrator/worktree_manager.py`
  - `python/research_runtime/settings.py`
- 需要实现：
  - canonical workspace 解析
  - execution worktree 命名规范
  - branch 命名规范
  - worktree 创建、回收、清理、探测
- 完成标准：
  - 能从 `project_id + task_id + role` 稳定生成执行工作区
  - 同一项目下多任务并行时不会互踩目录
  - worktree 清理失败时能保留审计信息

#### BL-003 在 coordinator 执行链中注入 execution workspace

- 目标：让 runtime 真正使用 worktree，而不是只有数据库记录
- 代码落点：
  - `python/research_runtime/coordinators/runner.py`
  - `python/research_runtime/orchestrator/task_driver.py`
  - `python/research_runtime/openclaw_sync.py`
  - `python/research_runtime/cli/worker.py`
- 需要实现：
  - 任务 claim 后创建或绑定 execution context
  - 执行前把 canonical workspace / execution workspace / task metadata 注入 runtime
  - 执行完成后回写 context 状态
- 完成标准：
  - OpenClaw agent-backed 路径能拿到 execution workspace
  - 普通 Python coordinator 路径也能读取相同上下文
  - 日志中可以明确区分 canonical 与 execution 路径

#### BL-004 增加 worktree 控制面 API

- 目标：给 WebUI、CLI、脚本统一暴露查询和操作入口
- 代码落点：
  - `python/research_runtime/api/app.py`
  - `python/research_runtime/storage/db.py`
- 建议 API：
  - `GET /worktrees`
  - `POST /worktrees/prepare`
  - `POST /worktrees/{id}/release`
  - `POST /worktrees/{id}/cleanup`
- 完成标准：
  - 能按 `project_id / task_id / status` 过滤
  - cleanup 有安全检查，禁止删 canonical workspace
  - 返回结构可直接被 `web/src/api.ts` 消费

#### BL-005 把 worktree 进入 read-model surface

- 目标：让 dashboard / Trace / Control 能直接读到执行隔离状态
- 代码落点：
  - `python/research_runtime/api/read_model_page.py`
  - `python/research_runtime/storage/db.py`
  - `web/src/types.ts`
- 完成标准：
  - 项目 read model 中可看到 `execution_contexts / active_worktrees / cleanup_backlog`
  - 首页可聚合显示当前活跃 execution workspace 数

### P3-D2 操作者看板增强

#### BL-006 增加 operator dashboard 聚合接口

- 目标：给首页 dashboard 一个单次请求可拿到的运营视图
- 代码落点：
  - `python/research_runtime/api/app.py`
  - `python/research_runtime/storage/db.py`
  - `web/src/api.ts`
  - `web/src/types.ts`
- 聚合内容：
  - lab 运行状态
  - 活跃 agent 数
  - 任务队列分布
  - 最近产出
  - 最近调度日志
  - worktree 占用情况
- 完成标准：
  - 首页不再依赖过多分散请求拼装核心运营卡片
  - 接口结构与中文 UI 文案层分离，业务原始值不被翻译

#### BL-007 重构首页为 operator dashboard

- 目标：把现有 hero 首页真正变成赛博风格的大屏总览，而不是静态展示页
- 代码落点：
  - `web/src/app.tsx`
  - `web/src/styles.css`
  - `web/src/components/metric-card.tsx`
  - `web/src/components/detail-drawer.tsx`
  - 可新增 `web/src/components/dashboard-*.tsx`
- 需要实现：
  - lab 运行状态总览
  - 产出与包冻结统计
  - 运行 agent 看板
  - 调度日志滚动区
  - attach 入口
- 完成标准：
  - 保留现有页面功能，不删原有入口
  - 中文 UI 文案统一受控
  - 在常见屏宽下无重叠、无溢出、无不可读下拉

#### BL-008 重构 `web/Trace` 为 attach-first 视图

- 目标：让 `Trace` 更像操作者观察台，而不是纯数据列表
- 代码落点：
  - `web/src/pages/trace-page.tsx`
  - `web/src/components/status-badge.tsx`
  - `web/src/api.ts`
- 需要实现：
  - 当前任务链路
  - role / task / blocker / 最近 handoff
  - 事件时间线和调度日志联动
  - attach 到具体任务、agent、worktree 的快捷入口
- 完成标准：
  - Trace 页可直接回答“谁在跑、卡在哪、最近交给了谁”

#### BL-009 重构 `web/Control` 为 operator action board

- 目标：把 `Control` 从配置页升级为控制动作中心
- 代码落点：
  - `web/src/pages/control-page.tsx`
  - `web/src/api.ts`
  - `web/src/types.ts`
- 需要实现：
  - project / role / auth profile / provider / worktree 联动视图
  - 准备 worktree、spawn、checkpoint、cleanup 等动作入口占位
  - 状态栏和下拉可读性强化
- 完成标准：
  - 控制动作与状态观测在同页闭环
  - 所有 UI 文案与业务值分层，语言切换不污染业务原值

### P3-D3 交接与消息增强

#### BL-010 扩充 messages read-model，支持 inbox / handoff 查询

- 目标：不重做消息系统，只增强现有 `messages` 的 operator 可读性
- 代码落点：
  - `python/research_runtime/storage/db.py`
  - `python/research_runtime/api/app.py`
  - `web/src/api.ts`
  - `web/src/types.ts`
- 需要实现：
  - 按 `to_agent / from_agent / status / priority / message_type` 过滤
  - handoff 聚合视图
  - 关联 task / artifact / package 的摘要字段
- 完成标准：
  - 能直接回答“谁在等谁”“哪个 handoff 卡住了”

#### BL-011 增加 inbox / teammate messaging UI

- 目标：在现有 UI 里提供轻量交接工作台
- 代码落点：
  - `web/src/pages/trace-page.tsx`
  - `web/src/pages/control-page.tsx`
  - 可新增 `web/src/components/inbox-*.tsx`
- 需要实现：
  - inbox 列表
  - teammate 消息摘要
  - handoff 状态筛选
  - 关联 artifact/package 快捷跳转
- 完成标准：
  - 不需要进入数据库即可看清当前交接队列

#### BL-012 任务完成与消息交接联动

- 目标：让 task 完成、artifact 生成、message 发送形成标准化交接
- 代码落点：
  - `python/research_runtime/orchestrator/task_driver.py`
  - `python/research_runtime/storage/db.py`
  - `python/research_runtime/orchestrator/event_consumer.py`
- 完成标准：
  - task 完成可自动触发标准 handoff message
  - reviewer / writer / experiment 等角色可共享一致交接模板

### P3-D4 结果收敛与清理

#### BL-013 建立 task completion hook contract

- 目标：把任务完成后的收口动作从散落逻辑收拢为明确 hook
- 代码落点：
  - `python/research_runtime/orchestrator/task_driver.py`
  - `python/research_runtime/storage/db.py`
- hook 内容建议：
  - checkpoint
  - artifact freeze
  - package freeze
  - handoff message
  - worktree release / cleanup enqueue
- 完成标准：
  - 同一类任务的收口动作有固定顺序与幂等约束

#### BL-014 增加 checkpoint / package freeze 元数据链路

- 目标：把“冻结了什么、来自哪里、对应哪个任务”记录清楚
- 代码落点：
  - `python/research_runtime/storage/schema.sql`
  - `python/research_runtime/storage/db.py`
  - `python/research_runtime/api/app.py`
- 完成标准：
  - checkpoint 可关联 `task_id / worktree_id / artifact_ids / package_ids`
  - package freeze 不再只是单点结果，而是可回溯执行快照

#### BL-015 增加 merge / cleanup / archive pipeline

- 目标：形成从执行结束到归档完成的一条标准后处理链
- 代码落点：
  - 新增 `python/research_runtime/orchestrator/archive_manager.py`
  - `python/research_runtime/orchestrator/task_driver.py`
  - `python/research_runtime/storage/db.py`
- 需要实现：
  - merge 前检查
  - cleanup 队列
  - archive 目录规范
  - 保留失败现场策略
- 完成标准：
  - 能区分“已完成但待合并”“已归档待清理”“清理失败待人工处理”

#### BL-016 在 UI 中增加收口流水线可见性

- 目标：不要让 checkpoint / cleanup / archive 只存在于后端日志
- 代码落点：
  - `web/src/pages/trace-page.tsx`
  - `web/src/pages/control-page.tsx`
  - `web/src/types.ts`
- 完成标准：
  - UI 中可看到 checkpoint、freeze、merge、cleanup、archive 当前状态
  - 可直接跳转到相关 artifact / package / worktree

### P3-D5 低摩擦调度动作

#### BL-017 FastAPI control action 统一入口

- 目标：把高频操作者动作统一成明确 API，而不是靠手工拼多条命令
- 代码落点：
  - `python/research_runtime/api/app.py`
  - `python/research_runtime/storage/db.py`
- 建议 action：
  - `spawn_role_run`
  - `prepare_worktree`
  - `attach_context`
  - `checkpoint_now`
  - `merge_now`
  - `cleanup_now`
- 完成标准：
  - 每个 action 都有审计日志
  - 每个 action 都有明确输入、输出和失败状态

#### BL-018 OpenClaw `research-core` helper 封装

- 目标：把对 OpenClaw 的高频辅助操作从散落调用收成 helper
- 代码落点：
  - `python/research_runtime/openclaw_sync.py`
  - 可新增 `python/research_runtime/orchestrator/openclaw_helpers.py`
  - 必要时补 `scripts/`
- 需要实现：
  - spawn 前上下文准备
  - execution workspace 注入
  - attach 所需元信息回传
  - completion hook 需要的运行结果摘要
- 完成标准：
  - FastAPI control action 可直接复用 helper，不重复拼 runtime 参数

#### BL-019 CLI / Web 共用动作契约

- 目标：避免 Web 点按钮和 CLI 调命令走两套语义
- 代码落点：
  - `python/research_runtime/cli/server.py`
  - `python/research_runtime/cli/worker.py`
  - `web/src/api.ts`
- 完成标准：
  - CLI 与 Web 使用同一套 action contract
  - 同一动作在 Web 与 CLI 中返回同类状态结构

#### BL-020 验证与文档收口

- 目标：让这批能力可持续维护，而不是一次性实现
- 代码落点：
  - `setup.md`
  - `docs/SCIAILAB_PROGRESS_PLAN.md`
  - 新增或补充测试与演示脚本
- 最低要求：
  - worktree prepare / release / cleanup 冒烟验证
  - spawn / checkpoint / merge / cleanup API 冒烟验证
  - dashboard / Trace / Control 的基本联调清单
- 完成标准：
  - 新开发者可按文档拉起并验证整条 P3-D 主链

---

## 4. 建议的首批开发批次

如果只切第一批可开工任务，建议先做以下 8 项：

1. `BL-001` schema 扩展
2. `BL-002` worktree manager
3. `BL-003` execution workspace 注入
4. `BL-004` worktree API
5. `BL-005` read-model 暴露 worktree 状态
6. `BL-006` operator dashboard 聚合接口
7. `BL-007` 首页 dashboard 重构
8. `BL-017` control action 入口骨架

原因：

- 这 8 项能先把“执行隔离 + 操作者总览 + 操作入口”主链打通
- inbox / archive / merge 等能力随后补入时，不需要再返工根接口

---

## 5. 完成定义

P3-D backlog 第一阶段可以定义为“完成”的最低条件：

- coordinator 运行时可按任务拿到隔离 execution workspace
- dashboard / `Trace` / `Control` 能看到活跃 task、agent、worktree、最近调度日志
- `messages` 可支撑 handoff / inbox 视图
- task completion hook 能挂接 checkpoint / freeze / cleanup
- Web 与 CLI 至少共享一套高频 control action contract

达到这个完成定义后，再继续补 archive 深化、merge 策略细化和更多 operator workflow 细节。

## 2026-03-21 Execution Status Update

### Completed

- `BL-001` completed
  - SQLite schema now includes `project_worktrees`, `task_execution_contexts`, `task_completion_hooks`
  - `messages` also gained actionable handoff queue state fields
- `BL-002` completed
  - `worktree_manager.py` is in place
  - supports prepare / activate / finalize / release / cleanup
  - supports `git worktree` when canonical workspace is a git repo and safe fallback otherwise
- `BL-003` completed for the mainline
  - coordinator runtime binds execution context before work
  - artifact writes prefer `execution_workspace_path`
- `BL-004` completed
  - worktree and execution-context APIs are live
- `BL-005` completed
  - read-model now exposes active worktrees, execution contexts, completion hooks, inbox, teammate messages
- `BL-007` completed for the current operator-board scope
  - homepage dashboard is now a live operator board instead of a static landing shell
- `BL-008` completed for the current attach-first scope
  - Trace includes attach action, structured attach drawer, execution/worktree/hooks view
- `BL-011` completed for the current MVP
  - Trace includes inbox / teammate messaging UI
  - operators can send teammate messages from attach context
- `BL-013` completed for the current mainline
  - task completion hook contract exists and is visible in read-model / timeline
- `BL-015` completed for the current automatic path
  - `checkpoint -> merge -> cleanup` auto pipeline is wired for `done`
- `BL-016` completed for the current visibility target
  - Trace exposes checkpoint / merge / cleanup records and related execution state
- `BL-017` completed for current control actions
  - attach / checkpoint / merge / cleanup actions are callable from FastAPI
- `BL-019` partially completed
  - CLI and Web already share part of the action contract
  - generic task-status path now also triggers automatic completion hooks
- `BL-020` partially completed
  - compile/build/integration verification has been extended for the new execution and message-queue paths

### In Progress

- `BL-006`
  - dashboard still aggregates data through several requests
  - current UI is already operator-usable, but a dedicated aggregate operator endpoint is still optional follow-up
- `BL-010`
  - message filtering by `handoff_state` is available at API level
  - UI grouping and richer queue analytics are not done yet
- `BL-012`
  - event-driven handoff messages already exist
  - standardized task-completion-to-handoff templates still need refinement
- `BL-014`
  - checkpoint metadata chain exists
  - artifact/package/worktree linkage can still be made more explicit
- `BL-018`
  - OpenClaw helper unification is still pending
  - current actions work, but helper reuse is not fully consolidated

### Newly Added Near-Term Backlog

- `BL-021` message action audit trail
  - write `mark-read / ack / handoff-state change` into timeline-visible events
- `BL-022` queue grouping and SLA surface
  - group inbox by `to_agent / handoff_state / priority`
  - expose blocked handoff backlog and aged pending items
- `BL-023` dashboard quick-action expansion
  - push `attach / checkpoint / merge / cleanup` deeper into homepage operator board
- `BL-024` non-done completion policy
  - define post-processing rules for `blocked / failed / cancelled` tasks

### Recommended Next Slice

The next autonomous slice should follow this order:

1. `BL-021` message action audit trail
2. `BL-022` queue grouping and SLA surface
3. `BL-023` dashboard quick-action expansion
4. `BL-024` non-done completion policy
5. `BL-018` helper unification
