# SciAILab Worktree 隔离设计

本文给出一版面向当前 SciAILab 架构的 worktree 隔离方案设计。设计目标是借鉴 ClawTeam 在 `git worktree` 上的并行执行卫生能力，但不改变 SciAILab 现有的控制面、事件链、状态真相源，也不改动长时记忆系统。

相关背景文档：

- `docs/CLAWTEAM_SCIAILAB_DESIGN_COMPARISON.md`
- `docs/SCIAILAB_PROGRESS_PLAN.md`
- `docs/SCIAILAB_RULE_MATRIX.md`

---

## 1. 设计目标

本设计要解决的问题不是“把 SciAILab 做成一个通用 swarm shell”，而是：

1. 让并行执行中的 agent 拥有隔离的代码工作区
2. 降低 experiment / writer / reviewer 并行运行时的目录污染和文件互踩
3. 保持当前 `research-core -> FastAPI -> SQLite -> workspace/projects` 主链不变
4. 明确区分“临时执行工作区”和“项目真相源工作区”
5. 明确不改动长时记忆系统

---

## 2. 明确边界

### 2.1 本设计会改变什么

- 增加一层可选的 `execution worktree`
- 为需要隔离代码操作的任务提供临时 git 工作区
- 增加 worktree 生命周期管理：创建、绑定、释放、回收、清理
- 让 OpenClaw `research-core` 或 Python coordinator 在执行前拿到专属 worktree 路径

### 2.2 本设计不会改变什么

- 不改变 SQLite 作为 control-plane truth store
- 不改变 `workspace/projects/<project-id>/` 作为项目真相源工作目录
- 不改变当前任务、事件、消息、包、artifact 的主链
- 不改变 OpenClaw auth/profile 机制
- 不引入 PostgreSQL
- 不引入 tmux 作为核心运行时依赖

### 2.3 本设计明确不碰长时记忆系统

当前长时记忆相关边界保持不变：

- 项目级长期内容仍在 `workspace/projects/<project-id>/memory/`
- 如果未来有全局 memory/index 层，仍按现有规划单独设计
- worktree 不是 memory 真相源
- worktree 中不承载长期 memory 写入职责

结论：

- `memory` 留在 canonical project workspace
- `worktree` 只服务于一次执行或一组短期并行执行

---

## 3. 当前架构下的问题

当前 SciAILab 的项目工作目录是：

- `workspace/projects/<project-id>/`

里面同时承载：

- artifacts
- packages
- inbox / outbox
- runs
- memory
- project.md

这在单 worker 路径下是简单有效的，但一旦后续进入更强的并行执行场景，会出现几个问题：

1. 多个 agent 如果需要对同一个代码仓或同一组文件做修改，会共享一个工作目录。
2. 当前 `workspace_path` 是项目级，不是任务级，也不是执行实例级。
3. 如果 experiment / writer / reviewer 后续都需要真实地对代码、文档、实验脚本进行改写，目录冲突会越来越明显。
4. 项目真相源目录和临时执行目录混在一起，不利于回收、审计和失败隔离。

因此，需要引入“项目真相源工作区”和“临时执行工作区”的分层。

---

## 4. 核心设计：双工作区模型

### 4.1 两类工作区

本设计引入两个层次：

1. `canonical project workspace`
2. `execution worktree`

定义如下：

| 类型 | 路径 | 职责 | 是否长期保留 |
| --- | --- | --- | --- |
| canonical project workspace | `workspace/projects/<project-id>/` | 项目真相源；保存 artifact、package、message 上下文、memory、project.md | 是 |
| execution worktree | `workspace/worktrees/<project-id>/<role>/<task-id>/` | 该次任务的临时执行沙箱，用于代码修改、临时文件、分支隔离 | 否，默认可回收 |

### 4.2 关键原则

- 所有长期状态继续写回 canonical project workspace 和 SQLite
- worktree 只是一层执行环境，不是系统真相源
- 任务完成后，最终产物仍通过现有 artifact/package 注册逻辑回写
- 如果 worktree 被删，SciAILab 的项目状态不丢

---

## 5. worktree 的职责

worktree 只承担以下职责：

1. 给单个 task 或单个 role run 提供隔离目录
2. 承载真实代码修改、临时脚本运行、依赖安装、实验输出中间态
3. 提供与 git 分支绑定的执行环境
4. 在任务结束后可供 checkpoint、比对、归档或删除

worktree 不承担以下职责：

1. 不保存项目主 artifact 真相
2. 不保存长期 memory
3. 不代替 `workspace/projects/<project-id>/packages`
4. 不代替 control-plane 数据库存储

---

## 6. 路径设计

建议新增目录：

```text
workspace/
  projects/
    <project-id>/
      artifacts/
      packages/
      inbox/
      outbox/
      runs/
      memory/
      project.md
  worktrees/
    <project-id>/
      <role>/
        <task-id>/
          repo/
          meta/
          logs/
```

说明：

- `projects/` 继续是 canonical project workspace
- `worktrees/` 是统一的临时执行层
- `repo/` 存真正的 git worktree
- `meta/` 存本次执行的本地元数据快照，例如 branch、base ref、cleanup policy
- `logs/` 存本次执行的局部运行日志

---

## 7. 作用对象：哪些任务需要 worktree

不是所有任务都必须走 worktree。

建议按任务类型分层：

| 任务类型 | 是否默认启用 worktree | 原因 |
| --- | --- | --- |
| explorer | 否 | 当前主要产出 hypotheses / research package，更多是资料整理与结构化输出 |
| experiment | 是，优先 | 最可能运行脚本、改实验代码、生成中间结果 |
| writer | 可选 | 如果 writer 只写 markdown，可不需要；如果 writer 要改代码注释、论文模板、实验说明，可启用 |
| reviewer | 可选 | 如果 reviewer 只读 artifact，不需要；如果 reviewer 要做复核脚本或补验证，可启用 |

结论：

- 第一阶段只对 `experiment` 强制支持
- 第二阶段对 `writer` / `reviewer` 按 route 或 task policy 可选开启

---

## 8. 与当前任务模型的集成方式

当前任务模型核心字段包括：

- `task_id`
- `project_id`
- `owner_agent`
- `workspace_path`
- `dependency`

worktree 集成后，不改现有 `workspace_path` 的语义：

- `workspace_path` 仍指向 canonical project workspace

新增一个执行层概念：

- `execution_workspace_path`

建议来源：

- 不直接覆盖 `workspace_path`
- 在 coordinator claim 或 run 之前，根据 task 解析得到

这样可以保持已有代码大致不动，只在执行入口扩展。

---

## 9. 状态模型设计

建议新增一张 `execution_worktrees` 表。

建议字段：

| 字段 | 含义 |
| --- | --- |
| `worktree_id` | worktree 记录 ID |
| `project_id` | 所属项目 |
| `task_id` | 所属任务 |
| `role` | explorer / experiment / writer / reviewer |
| `source_repo_path` | 原始 git 仓路径 |
| `worktree_path` | worktree 实际路径 |
| `branch_name` | worktree 对应分支名 |
| `base_ref` | 基于哪个 ref 建出 |
| `status` | `prepared` / `active` / `released` / `archived` / `cleanup_failed` |
| `cleanup_policy` | `delete` / `archive` / `keep_on_failure` |
| `created_at` | 创建时间 |
| `released_at` | 释放时间 |
| `last_error` | 最近错误 |

说明：

- 这张表不是新的真相源，而是执行环境注册表
- 任务、artifact、event 主链仍然留在现有表

---

## 10. 生命周期设计

### 10.1 创建

在 coordinator 真正执行前：

1. 判断该 role / task 是否需要 worktree
2. 解析 source repo 路径
3. 选择 base ref
4. 执行 `git worktree add`
5. 在 SQLite 写入 `execution_worktrees` 记录
6. 将 `execution_workspace_path` 注入本次运行上下文

### 10.2 运行

执行期间：

- agent 的 cwd 指向 `execution_workspace_path/repo`
- 仍可读取 canonical project workspace 中的 artifact/package/memory
- 但默认不直接在 canonical workspace 中改代码

### 10.3 结果提交

任务完成后：

- 由当前 coordinator 继续按既有逻辑产出 artifact markdown
- 可选记录 worktree diff 摘要、变更文件列表、commit hash
- 冻结 package 和注册 artifact 的行为保持不变

### 10.4 回收

根据 cleanup policy：

- `delete`: 直接 `git worktree remove`
- `archive`: 保留目录并把状态标记为 `archived`
- `keep_on_failure`: 任务失败时保留 worktree 供排障

---

## 11. source repo 的解析规则

worktree 必须有明确的 git 仓来源。

建议按三层解析：

### 11.1 第一优先：项目级显式声明

未来可在 project metadata 中加：

- `execution_repo_path`
- `execution_base_ref`

这是最稳妥的方式。

### 11.2 第二优先：当前 SciAILab 仓根

对于当前本地开发/自举场景：

- 默认把 SciAILab 仓根作为 source repo

适合当前阶段验证与研发。

### 11.3 第三优先：任务级覆盖

如果某些 task 明确要作用在外部仓库，可在 task metadata 中提供覆盖。

结论：

- 先实现“项目级 repo + 默认仓根 fallback”
- 任务级覆盖留作第二阶段

---

## 12. 与 memory 的关系

这是本文最关键的边界。

### 12.1 明确规则

长时记忆系统不进 worktree。

当前规则应明确为：

- `workspace/projects/<project-id>/memory/` 继续是项目长期 memory 目录
- worktree 中不复制整份 memory 目录
- worktree 中不保存 memory 真相副本
- agent 若需要长期上下文，应通过现有 artifact/package/message/read-model 获取，或读取 canonical workspace 中的 memory

### 12.2 为什么不能把 memory 搬进 worktree

如果把 memory 复制进每个 worktree，会出现：

1. 多副本漂移
2. 回收时难决定哪个副本是真相
3. 让临时执行目录承担长期状态职责
4. 增加同步复杂度

这与本设计的初衷相反。

### 12.3 推荐做法

推荐只做以下处理：

- worktree 运行上下文中提供 canonical memory 路径
- 允许只读访问 canonical memory
- 如需本次执行的临时笔记，写入 worktree 本地 `meta/notes.md`
- 如果这些临时笔记值得进入长期记忆，应通过明确的 runtime 动作回写到 canonical memory，而不是自动覆盖

---

## 13. 与 artifact / package 的关系

当前 artifact/package 模型继续不变。

建议规则：

1. worktree 中的中间文件默认不是 artifact
2. 只有通过现有 `register_artifact` 或 `freeze_package` 流程注册的结果，才进入系统主链
3. worktree 可作为 artifact 的生成环境，但不是 artifact 注册中心

这保证：

- 临时目录中的噪音不会污染项目主链
- 主链的可审计性继续由 runtime 保持

---

## 14. 与 OpenClaw `research-core` 的集成点

当前最适合的集成位置是 `research-core` coordinator 执行入口。

建议扩展点：

1. `project-paths.ts`
   - 增加 worktree root 配置解析
2. `coordinator-agent.ts`
   - 在 claim task 后决定是否准备 worktree
   - 把 `execution_workspace_path` 注入 subagent 运行上下文
3. Python coordinator 路径
   - 若走 Python fallback，同样要用相同 worktree 分配逻辑

关键原则：

- agent path 与 python path 必须共用一套 worktree policy
- 不能只在 OpenClaw 路径有隔离，Python 路径没有

---

## 15. 配置设计

建议新增配置项：

```json5
{
  worktree: {
    enabled: true,
    root: "workspace/worktrees",
    defaultSourceRepo: ".",
    defaultBaseRef: "HEAD",
    cleanupPolicy: "archive",
    roles: {
      experiment: true,
      writer: false,
      reviewer: false,
      explorer: false
    }
  }
}
```

说明：

- `enabled` 控制总开关
- `root` 指定 worktree 根目录
- `defaultSourceRepo` 当前默认可指向 SciAILab 仓根
- `cleanupPolicy` 决定默认回收策略
- `roles` 决定哪些 role 默认启用

---

## 16. 第一阶段最小实现

为了尽快收敛，而不是一开始把所有边界都做满，建议第一阶段只做：

1. 只支持 git 仓场景
2. 只给 `experiment` 开启 worktree
3. source repo 默认就是当前 SciAILab 仓根
4. 每个 task 创建一个独立 worktree
5. 默认 `archive on success, keep on failure`
6. 只记录：
   - worktree 路径
   - branch 名称
   - base ref
   - 状态
   - cleanup 结果

第一阶段不做：

- 多仓路由
- 远程 worktree
- 自动 merge
- P2P worker
- memory 同步
- 通用 branch 策略引擎

---

## 17. 第二阶段可扩展项

在第一阶段稳定后，可以再考虑：

1. 项目级 source repo 配置
2. role 级 / task 级 base ref 策略
3. 自动 diff 摘要采集
4. “从 worktree 生成 checkpoint package”
5. WebUI 中直接查看：
   - 当前 worktree
   - 分支名
   - 最近变更文件
   - cleanup 状态

---

## 18. 失败与回滚策略

worktree 是执行环境，不应拖垮主链。

必须保证：

1. worktree 创建失败时，任务可以：
   - 进入 `blocked`
   - 或回退到非隔离执行
   - 但行为必须显式配置，不能静默
2. worktree 清理失败不影响 artifact/package 主链提交
3. 即使 worktree 丢失，canonical workspace 和 SQLite 仍能还原项目状态

推荐默认：

- 创建失败：任务 `blocked`，并给 operator 明确错误
- 清理失败：标记 `cleanup_failed`，保留路径供排障

---

## 19. 设计结论

最适合 SciAILab 的方案不是“把项目 workspace 全部 worktree 化”，而是：

- 保留现有 `workspace/projects/<project-id>/` 作为项目真相源
- 在其旁边增加 `workspace/worktrees/...` 作为临时执行沙箱
- 让 worktree 只承担执行隔离，不承担长期状态职责

一句话概括：

**SciAILab 应采用“canonical project workspace + ephemeral execution worktree”的双工作区模型。**

这能借到 ClawTeam 最有价值的并行执行卫生能力，同时不动我们当前的长时记忆系统，也不破坏现有控制面和事件驱动主链。

---

## 20. 推荐下一步

如果要把这份设计继续推进成实现，建议按下面顺序做：

1. 在 `docs/SCIAILAB_PROGRESS_PLAN.md` 中登记 worktree 隔离为 P3/P4 过渡项
2. 增加 `execution_worktrees` schema 设计
3. 在 `research-core` coordinator run path 中补 worktree prepare/release
4. 先只给 `experiment` role 启用
5. 在 WebUI `Control` 或 dashboard 增加 worktree 观测卡片

这样能以最小风险把方案落地。
