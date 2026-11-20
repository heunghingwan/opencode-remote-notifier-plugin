# Design: 抑制背景 shell 等待期间的 idle 通知

**日期:** 2026-11-21
**状态:** 已批准（用户选定方案 A：照子代理抑制模式实现）

## 意图

Agent 启动背景 shell 后结束回合、等 shell 退出唤醒自己时，这段等待期间
不应发出 idle 通知——与子代理（parent 有 active child）的抑制行为一致。

## 背景机制（opencode v2.3.x 源码验证）

事件链（`packages/core/src/tool/plugin/shell.ts`、`session/session.ts`）：

1. `session.tool.called` `{sessionID, id: callID, name: "shell", input: {background: true}}`
   — 唯一可靠的前景/背景判别信号（`shell.created` 的 `info.metadata` 只有
   `{sessionID}`，前景背景相同）。
2. `session.tool.progress` `{sessionID, id: callID, metadata: {shellID}}` — 建立
   callID ↔ shellID 关联（ephemeral 事件，live 订阅可收到）。
3. Agent 回合结束 → `session.execution.succeeded` → 现行 5s debounce 后发 idle（bug）。
4. Shell 退出 → `Session.synthetic()`（`resume` 默认 `true`）→ `execution.wake()`
   → `session.execution.started`（`markBusy` 已取消 debounce，无需改动）。
5. 用户 kill 背景 shell 同样走 synthetic wake（"Cancelled" 文案）；
   `shell.exited`/`shell.deleted` 只带 `{id}`。

## 设计

新增状态（`createNotifier` 内，维持每实例独立）：

- `bgToolCalls: Map<callID, sessionID>` — 已见 background tool call、等 shellID 关联。
- `backgroundShells: Map<shellID, sessionID>` — 已确认的待完成背景 shell。

事件处理（`processSessionEvent`，已过 ownership gate）：

- `session.tool.called`：`name === "shell"` 且 `input.background === true` →
  `bgToolCalls.set(callID, sessionID)`。
- `session.tool.progress`：`bgToolCalls` 有该 callID 且 `metadata.shellID` →
  `backgroundShells.set(shellID, sessionID)`，删 callID 项。
- `session.tool.success` / `session.tool.failed`：若 success metadata 带 shellID
  且 callID 在跟踪中先登记；随后删 callID 项（shell 未建成时防泄漏）。

事件处理（`handleEvent`，ownership gate 之前——shell 事件无顶层 sessionID）：

- `shell.exited` / `shell.deleted`：`backgroundShells` 有该 id → 删映射，并
  `cancelIdleDebounce(ownerSessionID)`（wake 即将到来，比照 child 上线取消
  parent debounce 的处理）。
- `session.deleted`：追加清理该 session 拥有的 shell 映射与 callID 项。

抑制检查 `hasPendingBackgroundShell(sessionID)`：

- 遍历 `backgroundShells`：owner 等于 sessionID，**或** owner 沿
  `sessions.parentID` 链上行可到达 sessionID（含嵌套子代理，对齐 OpenCode
  job.list 的 descendants 语义）。带环保护。

接入点：

- `handleIdleSignal`：在 `hasActiveChild` 检查后增加背景 shell 抑制。
- idle debounce 到期回调：re-check `hasPendingBackgroundShell`（比照 child
  re-check）。

## 已确认的判断（用户批准）

1. 永不退出的背景 shell（dev server）→ idle 持续抑制，不设上限（OpenCode
   语义即「session 在等它」）。
2. 子代理拥有的背景 shell 也抑制父 session 的 idle（descendants）。
3. 不覆盖用户手动把前景 shell 转背景的路径（`input.background` 为 false）。

## 非目标

- 不改 permission/question/error 行为。
- 不引入 RPC 轮询（plugin ctx 无 `job` namespace；`shell.hook` 的
  `create.before` payload 无 sessionID/background，不可用）。

## 测试（bun test）

1. busy → 背景 shell 建立 → succeeded → debounce 到期不通知。
2. shell.exited → 唤醒（execution.started）→ 下一轮 succeeded → idle 正常通知。
3. shell.exited 取消 pending idle debounce。
4. 前景 shell（无 background）→ idle 正常通知。
5. tool.called bg 但 tool.failed 无 progress → 不残留抑制。
6. 子代理的背景 shell 抑制父 idle（descendant）。
7. session.deleted 清理 shell 映射后 idle 可恢复。
8. debounce 到期 re-check：idle 信号后才登记的 shell 也抑制。
9. shell.deleted 移除映射 → 下次 idle 正常。
