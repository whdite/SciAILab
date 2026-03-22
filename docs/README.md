# SciAILab 文档入口

这份索引是当前仓库推荐的阅读入口，目标只有两个：

- 用最少文档理解当前真实工程状态
- 避免继续阅读已经被实现替代的重复设计稿

## 推荐阅读顺序

1. `../setup.md`
   - 看当前可运行的启动、联调、验证方式
2. `SCIAILAB_PROGRESS_PLAN.md`
   - 看当前已经实现到什么程度、最近进展和下一阶段重点
3. `SCIAILAB_RULE_MATRIX.md`
   - 看运行时真实规则、状态机、read-model 契约
4. `SCIAILAB_P3D_EXECUTION_BACKLOG.md`
   - 看 execution isolation、operator board、handoff、completion pipeline 的可执行 backlog
5. `SCIAILAB_AGENT_WORKSPACE_UPDATE_2026-03-22.md`
   - 看 Agent Workspace 最新一轮派生消息、中文回显和聊天气泡样式更新

## 按主题补读

- `SCIAILAB_WORKTREE_ISOLATION_DESIGN.md`
  - 需要理解 worktree / execution context / canonical workspace 分层时再读
- `CLAWTEAM_SCIAILAB_DESIGN_COMPARISON.md`
  - 需要理解为什么借鉴 ClawTeam，以及哪些机制不该照搬时再读
- `ARCHITECTURE_EXPLORATION.md`
  - 需要深入理解 OpenClaw Gateway / agent / plugin / memory 结构时再读
- `SCIAILAB_AGENT_WORKSPACE_UI_IMPLEMENTATION_PLAN.md`
  - 需要回看 Agent Workspace 原始设计边界与阶段目标时再读

## 当前文档分工

- `setup.md`
  - 只记录已验证的启动与排障路径
- `SCIAILAB_PROGRESS_PLAN.md`
  - 只记录当前真实进度、主链状态、近期推进方向
- `SCIAILAB_RULE_MATRIX.md`
  - 只记录当前实现规则，不写理想化流程草图
- `SCIAILAB_P3D_EXECUTION_BACKLOG.md`
  - 只记录可执行 backlog，不重复写总述架构
- `SCIAILAB_WORKTREE_ISOLATION_DESIGN.md`
  - 只记录 worktree 隔离设计
- `CLAWTEAM_SCIAILAB_DESIGN_COMPARISON.md`
  - 只记录对外部项目的借鉴边界
- `SCIAILAB_AGENT_WORKSPACE_UI_IMPLEMENTATION_PLAN.md`
  - 记录 Agent Workspace 的原始实现方案
- `SCIAILAB_AGENT_WORKSPACE_UPDATE_2026-03-22.md`
  - 记录 Agent Workspace 最近一轮真实落地更新

## 已合并或不再保留的重复文档

以下文档已被当前实现、`setup.md`、`SCIAILAB_PROGRESS_PLAN.md` 或本索引覆盖，因此不再作为主入口：

- `RESEARCH_AGENT_ON_OPENCLAW_ENGINEERING_DESIGN.md`
- `RESEARCH_AGENT_TARGET_ARCHITECTURE.md`
- `RESEARCH_AGENT_TECH_STACK_DECISION.md`
- `SCIAILAB_IMPLEMENTATION_ARCHITECTURE.md`
- `SCIAILAB_OPENCLAW_ENABLEMENT.md`
- `SCIAILAB_WEB_BASELINE.md`
- `SCIAILAB_UI_DESIGN_BASELINE.md`
- `SCIAILAB_UI_WIREFRAMES.md`

## 默认原则

- 想知道怎么启动，先看 `setup.md`
- 想知道现在做到哪里，先看 `SCIAILAB_PROGRESS_PLAN.md`
- 想知道系统规则，先看 `SCIAILAB_RULE_MATRIX.md`
- 想继续推进开发，先看 `SCIAILAB_P3D_EXECUTION_BACKLOG.md`
- 想看 Agent Workspace 最近落地变化，先看 `SCIAILAB_AGENT_WORKSPACE_UPDATE_2026-03-22.md`
