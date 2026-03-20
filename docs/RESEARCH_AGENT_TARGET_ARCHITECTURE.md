# 科研 Agent 目标架构

本文定义科研 Agent 系统的目标架构，基于前面多轮讨论后的修正版本形成。目标不是一个“会聊天的科研助手”，而是一个可持续运行、可回环推进、可审计、可恢复的科研多智能体工作平台。

## 1. 目标

系统目标：

- 支持多智能体协作科研工作流
- 支持长期运行而不是一次性调用
- 支持结构化状态管理
- 支持长记忆与文档沉淀
- 支持用户通过统一入口管控系统
- 支持必要时与某个 specialist agent 直接交互
- 支持回环式科研流程，而不是单向流水线

这个系统不以“单轮回答质量”作为唯一目标，而以“持续推进科研项目”的能力作为核心目标。

## 2. 总体架构

系统由五层组成：

1. Control Plane
2. Explorer Cluster
3. Experiment / Engineering Cluster
4. Writer Cluster
5. Reviewer / Evaluator Cluster

其中：

- Control Plane 是系统控制层，不是普通 agent
- 其他四层是领域工作层
- 所有层都通过结构化事件、artifact 状态和消息协议协作

## 3. Control Plane

## 3.1 定位

Control Plane 是系统的统一控制面，负责：

- 用户指令接入
- WebSocket / Chat 网关接入
- 任务分发
- 事件路由
- 状态汇总
- 进度汇报
- 系统协调

它不是单个普通 agent，而是“系统层 + 协调智能模块”的组合。

## 3.2 职责

Control Plane 负责以下内容：

- 接收用户输入
- 将用户输入写入统一指令流
- 维护 task queue
- 维护 artifact registry
- 维护 agent 状态表
- 维护项目状态表
- 路由 agent 间消息
- 唤醒下游 agent
- 对用户展示进度和状态

## 3.3 不负责的事情

Control Plane 不负责：

- 代替 explorer 写研究结论
- 代替 experiment 写实验结果
- 代替 writer 写论文正文
- 代替 reviewer 写审查结论

它负责协调，不负责代写主产物。

## 4. 工作层角色

## 4.1 Explorer Cluster

职责：

- 阅读顶刊、前沿论文
- 阅读用户自有数据
- 分析研究趋势
- 提出研究问题
- 形成假设
- 形成候选创新点
- 给 experiment 与 writer 提供约束和方向

主要输出：

- `topic_map.md`
- `literature_review.md`
- `research_gaps.md`
- `hypotheses.md`
- `experiment_candidates.yaml`
- `writing_notes.md`

## 4.2 Experiment / Engineering Cluster

职责：

- 根据 hypothesis 与 experiment plan 拉项目、改代码、跑实验
- 自动创建实验和记录实验过程
- 形成实验结果、失败报告和可行性反馈
- 给 explorer 与 writer 反馈约束和事实边界

主要输出：

- `experiment_plan.yaml`
- `implementation_log.md`
- `results_summary.md`
- `failure_analysis.md`
- `engineering_exploration.md`
- `run_registry.db`

## 4.3 Writer Cluster

职责：

- 读取冻结后的研究输入和实验输入
- 组织论文结构
- 产出初版论文
- 结合 skill 和 CLI 适配不同论文格式
- 向 experiment / explorer 请求缺失证据

主要输出：

- `paper_outline.md`
- `draft_v1.md`
- `draft_v2.md`
- `figures_manifest.yaml`
- `citation_map.json`
- `submission_format_log.md`

## 4.4 Reviewer / Evaluator Cluster

职责：

- 检查论文论点是否被证据支持
- 检查是否缺实验、缺 baseline、缺 ablation
- 检查结论是否超出实验事实
- 检查写作逻辑是否存在跳步
- 形成风险标注和补充实验要求

主要输出：

- `review_report.md`
- `missing_evidence.yaml`
- `required_experiments.yaml`
- `risk_flags.json`

## 5. 协作原则

## 5.1 主产物 ownership 原则

每类主产物都必须有 owner agent。

原则：

- owner 负责修改主产物
- 非 owner 不允许直接修改主产物
- 其他 agent 只能提出建议、反馈、请求

例如：

- `hypotheses.md` 的 owner 是 explorer
- `results_summary.md` 的 owner 是 experiment
- `draft_v1.md` 的 owner 是 writer
- `review_report.md` 的 owner 是 reviewer

## 5.2 用户也不能直接修改主产物

用户不能直接编辑主产物。

用户只能：

- 写入新指令
- 写入规划要求
- 写入约束条件
- 写入期刊格式要求

这些输入进入 Control Plane，再由系统写入：

- 规划输入
- 用户需求输入包
- agent inbox

## 5.3 双向通信允许，但不能互写主文档

agent 间允许双向传递：

- explorer -> writer
- experiment -> explorer
- experiment -> writer
- writer -> experiment
- reviewer -> explorer / experiment / writer

但这种传递只能通过：

- message
- feedback
- request
- review note

不能通过直接改写对方主产物实现。

## 6. Agent 通信机制

## 6.1 Inbox / Outbox

每个 agent 或 cluster coordinator 必须具备：

- inbox
- outbox

### inbox

用于接收：

- 上游建议
- 下游反馈
- reviewer 审查意见
- control plane 分派任务
- 用户定向消息

### outbox

用于发送：

- 请求
- 反馈
- 限制说明
- 补充说明
- 风险提醒

## 6.2 建议的消息模型

每条消息至少应包含：

- `message_id`
- `project_id`
- `from`
- `to`
- `message_type`
- `priority`
- `artifact_ref`
- `created_at`
- `status`
- `content`

`status` 建议包含：

- `pending`
- `read`
- `accepted`
- `rejected`
- `superseded`

## 6.3 为什么不用自由文本互写

如果继续使用“建议 md 到处写”的方式，会很快出现：

- 建议无法追踪
- 已处理/未处理不清楚
- 无法做自动路由
- 无法做状态统计

所以通信必须从“自由文本互写”升级成“结构化消息协议”。

## 7. Artifact Registry

## 7.1 作用

Artifact Registry 是系统内所有关键产物的索引层。

它负责回答：

- 当前有哪些产物
- 谁是 owner
- 当前版本是多少
- 当前状态是什么
- 依赖哪些上游产物
- 最后更新时间是什么

## 7.2 每个 artifact 的最小字段

建议至少包含：

- `artifact_id`
- `project_id`
- `artifact_type`
- `owner`
- `version`
- `state`
- `path`
- `updated_at`
- `upstream_dependencies`

## 7.3 为什么必须有 Artifact Registry

没有 artifact registry，系统会退化成“看目录猜状态”。

后果包括：

- 下游不知道该读哪个版本
- control plane 无法判断系统进度
- 无法可靠触发状态迁移

## 8. 事件总线

## 8.1 作用

事件总线是系统主调度机制。

系统不应依赖业务轮询驱动工作，而应依赖事件驱动工作。

## 8.2 典型事件

建议至少定义这些事件：

- `user_instruction_added`
- `artifact_updated`
- `artifact_state_changed`
- `hypothesis_ready_for_experiment`
- `experiment_failed_due_to_complexity`
- `experiment_results_ready`
- `writer_needs_evidence`
- `review_requested`
- `review_requires_ablation`
- `agent_blocked`
- `agent_recovered`

## 8.3 事件驱动原则

主原则：

- 事件触发下游读取和规划
- 不是所有文件变化都触发工作
- 只有关键状态迁移触发下游工作

## 9. 状态机设计

## 9.1 Artifact 状态机

每个关键产物都应该有状态机。

例如 hypothesis：

- `draft`
- `updated`
- `ready_for_experiment`
- `revising`
- `frozen`
- `deprecated`

例如 experiment result：

- `running`
- `partial`
- `complete`
- `failed`
- `frozen`

例如 writing input package：

- `assembling`
- `ready`
- `frozen`
- `superseded`

## 9.2 Agent 状态机

每个 agent 也应有自己的运行状态。

建议包含：

- `idle`
- `waiting_input`
- `planning`
- `executing`
- `blocked`
- `needs_human`
- `review_pending`
- `done`

这样 Control Plane 才能准确判断：

- agent 是没任务
- 还是在执行
- 还是被卡住
- 还是在等上游

## 9.3 状态机的真正作用

状态机不是为了“描述得好看”，而是为了：

- 决定何时唤醒下游
- 决定何时允许读取新产物
- 决定何时冻结输入
- 决定何时进入回环

## 10. heartbeat 设计

## 10.1 heartbeat 保留，但只做健康检查

heartbeat 不应该做主业务调度。

heartbeat 只负责：

- agent 是否存活
- agent 当前是否 busy
- 当前在执行什么
- 最近一次成功时间
- 是否疑似卡住

## 10.2 不应再让 heartbeat 驱动业务轮询

不应继续采用：

- agent 周期性扫描全部上游目录
- 周期性重读所有规划文档
- 每轮都重建 todo list

这种方式会导致：

- 成本高
- 重复消费
- todo 抖动
- 系统不稳定

## 10.3 正确关系

应采用：

- 主机制：事件驱动
- 辅机制：低频 reconcile
- heartbeat：健康检查

## 11. 低频 reconcile

## 11.1 允许存在，但不是主机制

为了防止事件丢失，可以保留一个低频 reconcile 机制。

例如每隔较长时间检查：

- inbox 是否有未处理消息
- artifact version 与缓存是否一致
- 某些长任务是否超时
- 状态组合是否异常

## 11.2 reconcile 只能做兜底

它不能替代主调度。

主调度仍然应由：

- 事件
- 状态机
- task queue

驱动。

## 12. Frozen Package 机制

## 12.1 为什么必须有冻结点

如果 explorer、experiment、writer 一直双向互动，而 writer 又始终追最新输入，论文写作将无法收敛。

因此必须引入冻结点。

## 12.2 需要冻结的对象

建议至少冻结：

- hypothesis package
- experiment result bundle
- writing input package

例如：

- `research_package_v3`
- `experiment_bundle_v5`
- `writing_input_v2`

## 12.3 Writer 的输入原则

Writer 不应永远跟踪最新变化。

Writer 应基于一个冻结版本写作。

如果新变化出现，应通过：

- 新 version
- superseded 状态
- 新写作任务

来切换，而不是隐式覆盖当前写作输入。

## 13. 用户交互模型

## 13.1 默认模式

用户默认应通过 Control Plane 交互。

原因：

- 保持系统一致性
- 保持任务调度统一
- 方便进度汇总
- 防止多入口冲突

## 13.2 允许定向交流，但应受控

系统可以允许用户直连某个 specialist agent，但应满足：

- direct message 进入统一事件总线
- control plane 可见
- 相关项目状态会同步更新

也就是说：

- 可直连
- 但不能绕过系统

## 14. 最小 MVP

建议第一版不要一开始就把所有复杂性全上齐。

## 14.1 MVP 角色

第一版先做：

- Control Plane
- Explorer
- Experiment
- Writer
- Reviewer

每类先只做单 coordinator，不先做大规模 cluster 自治。

## 14.2 MVP 核心机制

第一版必须先有：

- artifact registry
- inbox / outbox
- event bus
- artifact state machine
- agent state machine
- frozen package

## 14.3 MVP 可以暂缓的部分

可以后补：

- cluster 内多 worker 自治
- 复杂 planner
- 高级 memory 图谱
- 更复杂的用户直连模式

## 15. 一句话结论

科研 Agent 的目标架构不应该是“多个 agent 彼此读文档并轮询工作”，而应该是：

**一个由 Control Plane、Artifact Registry、Event Bus、状态机和多类专职 agent 共同组成的科研工作平台。**

## 16. 最终架构原则

最后将架构原则压缩为以下几点：

- Control Plane 是控制层，不是普通 agent
- 主产物有 owner，非 owner 不可直接修改
- agent 间通过 inbox / outbox 交换结构化建议、请求、反馈
- 主工作流由事件和状态机驱动，不由业务轮询驱动
- heartbeat 只负责健康检查
- Writer 必须消费冻结输入包，而不是永远追逐最新变化
- 用户默认通过 Control Plane 交互，直连 specialist agent 只作为受控能力存在
