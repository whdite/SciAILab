# SciAILab Agent Workspace 更新记录 2026-03-22

## 本轮目的

把 `Agents` 页面从“只能看到 operator 自己发送的线程消息”推进到“能像聊天流一样看到真实运行回显”，但不破坏现有分层：

- `messages` 继续承担业务 handoff / inbox / SLA 队列职责
- `agent_thread_messages` 继续承担 operator -> agent 的独立线程职责
- WebUI 对话流补一层 derived message projection，把业务执行结果投影为可读聊天回显

## 已落地

### 1. Agent 线程补齐业务回显

后端 `GET /v1/agents/{agent_id}/thread` 现在不再只返回原始 `agent_thread_messages`。
它会把当前 agent 相关的以下对象投影为派生线程消息：

- `recent_handoffs`
- `recent_artifacts`
- `recent_packages`

当前已落地的派生消息类型：

- `derived_handoff`
- `derived_artifact`
- `derived_package`

这意味着即使 agent 本轮没有主动写入 `agent_thread_messages`，用户仍然能在 chat 流里看到：

- 谁把什么交接给了当前 agent
- 当前 agent 刚产出了什么 artifact
- 系统刚冻结了什么 package / checkpoint / merge bundle

### 2. 对话页改成三类消息气泡

`web/src/pages/agents-page.tsx` 与 `web/src/styles.css` 已经把消息流按语义拆成三类：

- `Agent 输出`
  - 例如草稿、评审报告、实验摘要等产出完成
- `交接消息`
  - 例如 incoming / outgoing handoff
- `系统状态`
  - 例如 checkpoint、merge、package freeze、control result

同时保留：

- `operator` 消息仍然作为用户自己的输入气泡
- 右侧 context panel 继续展示 task / execution context / worktree / recent artifacts / recent packages / recent handoffs

### 3. 中文聊天化文案

派生消息不再直接暴露底层字段名，而是转成更适合 operator 阅读的中文回显，例如：

- `我已产出评审报告 v4，可继续进入下一步。`
- `收到交接：Reviewer requested a draft revision before approval.`
- `系统已冻结执行快照 v11，当前执行快照已归档。`

这样做的目标不是掩盖底层数据，而是降低操作面阅读成本。
原始对象仍然可以通过：

- 右侧 context panel
- Trace
- read-model JSON

继续查看。

## 设计结论

本轮验证了一个重要结论：

`Agent Workspace` 不能只依赖 `agent_thread_messages` 这一张表，否则会天然缺少 coordinator 实际执行过程中的业务回显。

更合适的方式是：

1. 保持 operator thread 与业务 handoff 分层
2. 在 thread read-model 里做 projection
3. 让 WebUI 展示的是“聊天化视图”，而不是直接暴露底层表结构

这比把所有业务事件都硬写进 `agent_thread_messages` 更稳妥，因为：

- 不污染原始业务 handoff 指标
- 不打破现有 `messages` / `artifacts` / `packages` 的语义边界
- 仍然能在 UI 上得到连续可读的会话体验

## 当前限制

当前仍有几项未完成：

- 派生 handoff 文案还没有全部改成更自然的中文业务语气
- `approval / review_request / review_note / artifact_update / package_update` 还可以继续细分显示模板
- 目前还是轮询刷新，不是 SSE / websocket 增量推送
- derived message 目前主要面向可读性，尚未形成 timeline audit 的独立消息分类统计

## 建议的下一步

1. 继续清洗 `Agents` 页面的中文文案与编码残留
2. 把 `approval / review_request / review_note` 做成明确的中文业务模板
3. 让 derived message 支持更强的附件预览
4. 评估是否为 Agent Workspace 单独补 SSE 增量流

## 相关文件

- `python/research_runtime/storage/db.py`
- `web/src/pages/agents-page.tsx`
- `web/src/styles.css`
