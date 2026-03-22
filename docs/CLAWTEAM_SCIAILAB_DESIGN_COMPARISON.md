# ClawTeam 与 SciAILab 设计对照

本文整理 ClawTeam 中哪些机制适合被 SciAILab 借鉴，哪些不适合直接照搬，以及如果要吸收这些机制，应该落到 SciAILab 当前架构的哪一层。

参考来源：

- ClawTeam README: https://github.com/HKUDS/ClawTeam?tab=readme-ov-file
- `docs/SCIAILAB_PROGRESS_PLAN.md`
- `docs/SCIAILAB_RULE_MATRIX.md`
- `docs/SCIAILAB_WORKTREE_ISOLATION_DESIGN.md`

## 1. 前提判断

ClawTeam 和 SciAILab 不是同一类系统。

- ClawTeam 更像一个面向本地 CLI Agent 的通用 swarm 外壳
- SciAILab 更像一个面向科研流程的专用 runtime 与 control plane

因此，正确问题不是“要不要把 SciAILab 做成 ClawTeam”，而是：

- ClawTeam 哪些操作层机制能降低 SciAILab 的并行协作摩擦
- ClawTeam 哪些底层设计如果直接照抄，会破坏 SciAILab 现在已经建立起来的状态真相源和工作流约束

## 2. 总体结论

适合借鉴的部分：

- 每个 agent 使用隔离工作区
- 面向操作者的轻量任务板 / worker 看板
- 显式的 agent inbox / handoff 交接体验
- 并行运行时的低摩擦监控与清理
- 并行分支的 checkpoint / 合并 / 清理流程

不适合直接照抄的部分：

- 只用 JSON 文件做全局状态存储
- 让 leader agent 成为主要编排器
- 把 tmux 当成核心 runtime 抽象
- 以“兼容任意 CLI agent”作为主目标
- 让工作流语义主要存在于 prompt，而不是 runtime 规则

## 3. 适合借鉴的机制

| ClawTeam 机制 | 带来的价值 | 对 SciAILab 的适配度 | 在 SciAILab 中应如何落地 |
| --- | --- | --- | --- |
| `git worktree` 按 worker 隔离 | 降低并行修改时的目录冲突与分支污染 | 高 | 为 experiment / writer / reviewer 这类并行执行路径增加可选 worktree 隔离，但保留 SQLite 作为控制面真相源 |
| 轻量 board / attach 视图 | 操作者能快速看到当前有哪些 worker 在跑 | 高 | 扩展当前 `Control` 与 `Trace`，增加“当前 role / 当前任务 / 阻塞原因 / 最近交接”的紧凑看板 |
| 显式 inbox send/receive | agent 之间的协作交接更可见、更可审计 | 高 | 直接映射到 SciAILab 现有 `messages` 模型和 WebUI 消息/交接视图，而不是再造一套旁路机制 |
| 一条命令拉起并行 worker | 降低并行启动门槛 | 中高 | 在现有 scheduler/task API 之上补更高层的操作，例如“并行展开实验”或“按角色启动一轮执行” |
| 并行分支的 cleanup / checkpoint / merge | 降低运行时间一长后的环境脏乱 | 高 | 在任务完成后增加显式的 checkpoint、归档、回收 worktree、冻结产物等生命周期动作 |
| 操作者以观察为主 | 多 worker 运行时不必频繁人工介入 | 高 | 与 SciAILab 当前方向一致，应继续强化 dashboard、trace、control 的观测能力 |
| transport 抽象 | 为未来远程 worker 留扩展口 | 低到中 | 只有在 SciAILab 以后需要跨主机 worker 时才有必要，现在不是优先项 |

## 4. 不适合直接照抄的机制

| ClawTeam 机制 | 为什么在 ClawTeam 里成立 | 为什么不该直接照抄到 SciAILab |
| --- | --- | --- |
| 全局状态主要落在 `~/.clawteam/` JSON | 轻量、无服务、易读 | SciAILab 已经依赖 SQLite truth store、event consumer、read model、OpenClaw snapshot 合并；如果退回 JSON 文件，会明显削弱状态一致性与查询能力 |
| leader agent 作为主编排器 | 适合开放式 swarm 协作 | SciAILab 当前编排已经由 FastAPI runtime + 事件规则拥有；如果把编排再交回 leader prompt，会让科研链路变得更难验证、更难复现 |
| tmux 作为一等执行模型 | 对本地 CLI agent 管理很方便 | SciAILab 可以把 tmux 当可选运维工具，但不应该把它升格为 runtime contract，当前主链仍应在 OpenClaw plugin/service 之下 |
| “兼容任意 CLI coding agent” 作为主目标 | 扩大生态适配面 | SciAILab 当前已经围绕 OpenClaw `research-core`、研究 runtime contract 和控制面建起来，过早追求泛化会明显分散主线 |
| prompt 驱动为主的协作语义 | 启动快、自由度高 | SciAILab 需要把 reviewer loop、retry、downstream task 规则放在代码和状态机里，而不是主要依赖 prompt 约定 |
| 无数据库 / 无服务架构 | 对轻量本地工具很合适 | SciAILab 现在已经吃到了 control plane、scheduler state、provider observability、WebUI 的收益，不能为了“轻”把这些能力拆掉 |

## 5. 可以借鉴，但必须改造后再引入

| 机制 | 是否值得引入 | 引入规则 |
| --- | --- | --- |
| team templates | 值得 | 不应只是 prompt 模板，而应变成能生成结构化 project/task/bootstrap 配置的模板 |
| p2p transport | 暂时观望 | 只有在 SciAILab 真的要支持远程 worker 或多主机场景时才值得推进 |
| worker 生命周期命令 | 值得 | 应映射到现有 task / agent state / scheduler 行为，而不是发明第二套生命周期模型 |
| branch 命名与清理规范 | 值得 | 如果后面引入 worktree，这是非常实用的配套能力 |
| 平铺式实时监控 | 值得 | 应做成当前 scheduler、dispatch log、agent state 的 dashboard 模式 |

## 6. 对 SciAILab 最有价值的借鉴顺序

### 6.1 短期最值得吸收的点

这些能力最不破坏当前架构：

1. 增加可选的按 role / 按 task 隔离 worktree
2. 增加更紧凑的 operator board
3. 把 handoff / inbox 做得更显式
4. 增加并行运行后的 checkpoint / cleanup 流程

### 6.2 中期可考虑的点

这些更适合在当前 P3 强化完成后再做：

1. 用项目模板预配置 role routing、auth profile 绑定和 bootstrap task graph
2. 增加“并行实验展开 / 结果收敛”一类操作动作
3. 如果单机 worker 变成瓶颈，再评估远程 transport 抽象

## 7. 明确不建议走的方向

SciAILab 应明确避免以下方向漂移：

1. 不要用文件系统 JSON 协调替换当前 SQLite + FastAPI 真相源。
2. 不要把编排权从 runtime 规则转回 leader agent prompt。
3. 不要把 tmux 升格为主系统的必需运行时依赖。
4. 不要在当前研究工作流还未收稳之前，转向“通用 CLI swarm 平台”。
5. 不要把 `task / event / state / message` 语义塌缩成松散的聊天式 swarm 协议。

## 8. 如果要借鉴，这些机制该落在哪一层

| 借鉴项 | 在 SciAILab 中的落点 |
| --- | --- |
| worktree 隔离 | coordinator 执行环境与 workspace manager |
| board / attach 看板 | `web/Control`、`web/Trace`、首页 dashboard |
| inbox / teammate messaging | 现有 `messages` 模型与 read-model surface |
| checkpoint / merge / cleanup | task completion hook、artifact/package freeze、归档流程 |
| 低摩擦 spawn 操作 | FastAPI control action + OpenClaw `research-core` helper |

## 9. 推荐立场

最合适的策略是：

- 借 ClawTeam 的操作体验与并行协作卫生
- 不借 ClawTeam 的核心状态模型
- 保留 SciAILab 现在“工作流语义由 runtime 持有”的架构方向

一句话总结：

- ClawTeam 是很好的产品和操作机制参考
- SciAILab 不应该被重构成 ClawTeam
- SciAILab 应该只吸收那些能改善并行执行卫生和 operator 体验的部分

## 10. 建议的下一步

如果要把这份对照真正转成工程动作，最值得先做的是：

- 设计一版 SciAILab worktree 隔离方案，并确保它能接入当前  
  `research-core -> FastAPI -> SQLite -> workspace` 主链

这是目前从 ClawTeam 身上最值得借鉴、同时对现有架构破坏最小的一项增强。
