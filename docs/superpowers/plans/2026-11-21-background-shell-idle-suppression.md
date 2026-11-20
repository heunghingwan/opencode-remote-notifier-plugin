# 背景 Shell 等待期 Idle 抑制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 启动背景 shell 后结束回合等待唤醒期间，不发出 idle 通知（比照子代理抑制模式）。

**Architecture:** 通过 `session.tool.called`（`input.background === true`）识别背景 shell 调用，用 `session.tool.progress`/`session.tool.success` 的 `metadata.shellID` 建立 shellID→sessionID 映射；idle 信号与 debounce 到期时检查该映射（含子代理后代）决定抑制；`shell.exited`/`shell.deleted`/`session.deleted`/`cleanup()` 负责释放。

**Tech Stack:** TypeScript（无构建步骤，Bun 直接加载）、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-21-background-shell-idle-suppression-design.md`

## Global Constraints

- 单文件架构：所有改动在 `.opencode/plugins/remote-notifier.ts`（926 行），测试在 `.opencode/test/remote-notifier.test.ts`；不新建模块。
- 无构建步骤：不新增依赖、不加 tsconfig；验证只用 `cd .opencode && bun test ./test/`（或根目录 `bun run test`）。
- 每实例状态：新状态必须放在 `createNotifier` 闭包内，不得提升到模块级。
- 事件形状以 opencode v2.3.x schema 为准：`session.tool.called` `{sessionID, assistantMessageID, id, name, input, executed}`；`session.tool.progress` `{sessionID, assistantMessageID, id, metadata}`；`session.tool.success/failed` `{sessionID, assistantMessageID, id, metadata?}`；`shell.exited` `{id, exit?, status}`；`shell.deleted` `{id}`。注意 `shell.*` 事件**没有**顶层 `sessionID`。
- 注释与日志风格沿用现有：英文注释说明"为什么"，`logger.debug` 带结构化字段、消息用 " — " 分隔。

## Review Focus

- 多实例（多 location）下，`shell.*` 事件无 sessionID——只有映射中记录过的（即本实例拥有的 session）shell 才能触发抑制/取消，外来 shell 不得影响本实例（Task 1 步骤 1 测试 6 的 fixture 用外来 session 目录）。
- 背景带显式 timeout（`input.timeout: 60000, background: true`）——判别只看 `input.background`，不看 timeout（Task 1 测试 6 覆盖）。
- `session.tool.called` 的 `executed: false` 或 permission 拒绝路径：call 无 shell 产生，`tool.failed`/`tool.success` 必须清掉 callID 项防泄漏（Task 1 测试 4）。
- callID 与 shellID 多对一（CodeMode 共享 callID）：`bgToolCalls` 删除时不得误删已登记的 `backgroundShells`（Task 1 步骤 3 实现里 delete 只作用于 bgToolCalls）。
- 已退出的 shell 再次收到迟到事件（重复 `shell.exited`）：删除幂等，不得抛错或重复取消（Task 2 测试 4）。

---

### Task 1: 背景 shell 跟踪与 idle 抑制

**Files:**
- Modify: `.opencode/plugins/remote-notifier.ts`（状态区 ~L401-411、`hasActiveChild` 后 ~L438、`handleIdleSignal` L539-587、`processSessionEvent` L733+）
- Test: `.opencode/test/remote-notifier.test.ts`（新增 fixtures + describe 块，放在 "idle notifications (sub-agent orchestration)" 之后）

**Interfaces:**
- Consumes: 现有 `sessions: Map<string, SessionInfo>`（含 `parentID`）、`cancelIdleDebounce(sessionID)`、`handleIdleSignal`、`processSessionEvent(type, data, sessionID, eventDir)`。
- Produces（Task 2 依赖）: `bgToolCalls: Map<string, string>`、`backgroundShells: Map<string, string>`（闭包内，Task 2 直接使用这两个名字）；`hasPendingBackgroundShell(sessionID: string): boolean`。

- [ ] **Step 1: 写失败测试**

新增 fixtures（沿用现有 `ev()` helper）：

```ts
const shellToolCalled = (sessionID = SESSION_ID, callID = "call_1", input: Record<string, unknown> = { command: "bun test", background: true }) =>
  ev("session.tool.called", { sessionID, assistantMessageID: "msg_1", id: callID, name: "shell", input, executed: true })
const shellToolProgress = (shellID: string, sessionID = SESSION_ID, callID = "call_1") =>
  ev("session.tool.progress", { sessionID, assistantMessageID: "msg_1", id: callID, metadata: { shellID } })
const shellExited = (shellID: string) => ev("shell.exited", { id: shellID, exit: 0, status: "completed" })
const shellDeleted = (shellID: string) => ev("shell.deleted", { id: shellID })
```

新增 `describe("idle notifications (background shell waiting)", ...)`，8 个测试（模式照抄现有：`makeNotifier` + `handleEvent` 序列 + `await sleep(50)`）：

1. `pending background shell suppresses the idle notification`：`sessionCreated()` → `execution.started` → `shellToolCalled()` → `shellToolProgress("shl_1")` → `execution.succeeded` → `sleep(50)` → `expect(calls.length).toBe(0)`
2. `foreground shell does not suppress idle`：同上但 `shellToolCalled(SESSION_ID, "call_1", { command: "ls" })`（无 background）→ `shellToolProgress("shl_1")` → `succeeded` → 1 次 idle
3. `background shell with explicit timeout is still tracked`：input 含 `timeout: 60000, background: true` → 0 次
4. `a background tool call that fails without a shell does not leak suppression`：`shellToolCalled()` → `ev("session.tool.failed", { sessionID, assistantMessageID: "msg_1", id: "call_1", error: {...} })` → `succeeded` → 1 次 idle
5. `idle debounce re-checks pending background shells at fire time`：`execution.started` → `succeeded` → **之后**才 `shellToolCalled()` + `shellToolProgress("shl_1")` → `sleep(50)` → 0 次
6. `a foreign session's background shell does not suppress local idle`：外来 session 的三个事件（`session.created`、`session.tool.called`、`session.tool.progress`）全部用 `ev(type, data, "/home/dev/work/beta")` 构造（sessionID 用 `"ses_other"`，data 其余字段同 fixtures）→ 本地 `execution.started`/`execution.succeeded` → 1 次 idle
7. `a child session's background shell suppresses the parent's idle`：`sessionCreated()`（parent=ses_abc123）+ `sessionCreated({ parentID: SESSION_ID }, "ses_child")` → parent `execution.started` → child 的 `shellToolCalled("ses_child")` + `shellToolProgress("shl_1", "ses_child")` → parent `execution.succeeded` → 0 次
8. `multiple shells under one callID are all tracked (CodeMode)`：`shellToolCalled()` 一次 → `shellToolProgress("shl_1")` + `shellToolProgress("shl_2")`（同 callID）→ `ev("session.tool.success", { sessionID, assistantMessageID: "msg_1", id: "call_1", metadata: { shellID: "shl_2" } })` → `execution.started` → `execution.succeeded` → 0 次；再 `started`/`succeeded`（shl_2 仍在，不发 exited）→ 仍 0 次（两个都登记、success 清 callID 不清 shells）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd .opencode && bun test ./test/remote-notifier.test.ts`
Expected: 新增 8 项中 1、3、4、5、7、8 FAIL（无抑制逻辑，idle 照发）；2、6 可能 PASS（本就不抑制）——以测试 1 FAIL 为准。

- [ ] **Step 3: 实现跟踪与抑制**

`.opencode/plugins/remote-notifier.ts`：

a) 状态区（`lastText` 声明后）新增两个 map，各带一段"为什么"注释（背景 shell 是 tool 事件与 shell 事件的跨域关联，`shell.*` 无 sessionID）：

```ts
const bgToolCalls = new Map<string, string>()      // tool callID → sessionID（等 progress 关联）
const backgroundShells = new Map<string, string>() // shellID → sessionID（已确认待完成）
```

b) `hasActiveChild` 后新增 `isDescendantOf(candidateID: string, ancestorID: string): boolean`（沿 `sessions.get(current)?.parentID` 上行，`Set` 环保护）与 `hasPendingBackgroundShell(sessionID: string): boolean`（遍历 `backgroundShells.values()`，owner 是自身或后代即 true）。注释引用 opencode job.list 的 descendants 语义。

c) `handleIdleSignal`：`hasActiveChild` 检查后新增同构检查——`hasPendingBackgroundShell(sessionID)` → debug `"Idle with background shell pending — suppressing"` → return；debounce 回调内 `hasActiveChild` re-check 后新增 `hasPendingBackgroundShell` re-check → debug `"Idle debounce fired with background shell pending — suppressing"` → return。

d) `processSessionEvent` 顶部（`session.text.ended` 块后）新增四个分支：

- `session.tool.called`：`data?.name === "shell" && data?.input?.background === true && typeof data?.id === "string" && sessionID` → `bgToolCalls.set(data.id, sessionID)`
- `session.tool.progress`：`typeof data?.metadata?.shellID === "string"` 且 `bgToolCalls.get(data.id)` 存在 → `backgroundShells.set(shellID, owner)`、`bgToolCalls.delete(data.id)`
- `session.tool.success`：同 callID 在 `bgToolCalls` 时，若 `data?.metadata?.shellID` 是 string 先 `backgroundShells.set`（progress 丢失时的兜底），再删 callID 项
- `session.tool.failed`：删 callID 项（无 shell 产生，防泄漏）

每个分支 return，配 debug 日志。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd .opencode && bun test ./test/`
Expected: 全部 PASS（含既有测试无回归）。

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/remote-notifier.ts .opencode/test/remote-notifier.test.ts
git commit -m "feat: suppress idle notification while a background shell is pending"
```

---

### Task 2: 生命周期清理（exit/delete/session.deleted/cleanup）

**Files:**
- Modify: `.opencode/plugins/remote-notifier.ts`（`handleEvent` 的 `session.deleted` 块 L647-664 与 ownership gate 前、`cleanup()` L853-864）
- Test: `.opencode/test/remote-notifier.test.ts`（同 describe 块追加）

**Interfaces:**
- Consumes: Task 1 的 `backgroundShells`、`bgToolCalls`、`cancelIdleDebounce(sessionID)`。
- Produces: 无（终端行为）。

- [ ] **Step 1: 写失败测试**

同 describe 追加 5 个测试：

1. `shell.exited cancels the pending idle debounce of the owning session`：busy → called+progress("shl_1") → succeeded（debounce 已排）→ `shellExited("shl_1")` → **不**发 execution.started → `sleep(50)` → 0 次（证明取消，而非靠 markBusy）
2. `idle notifies after the shell exits and the woken turn finishes`：完整链——busy → called+progress → succeeded → `shellExited("shl_1")` → `execution.started`（唤醒）→ `execution.succeeded` → 1 次 idle
3. `shell.deleted removes the pending shell so idle notifies again`：busy → called+progress → succeeded → `sleep(50)`（0 次，被抑制）→ `shellDeleted("shl_1")` → 再 `execution.started` + `execution.succeeded`（新一轮且无待完成 shell）→ 累计 1 次
4. `duplicate shell.exited is ignored`：测试 1 基础上 `shellExited("shl_1")` 发两次 → 不抛错、0 次
5. `session.deleted releases a child's background shell so the parent can notify idle`：parent+child 会话 → parent busy → child called+progress → parent succeeded（抑制中，sleep 验证 0 次）→ `ev("session.deleted", { sessionID: "ses_child" })` → 再 parent `execution.started` + `succeeded` → 累计 1 次

- [ ] **Step 2: 跑测试确认失败**

Run: `cd .opencode && bun test ./test/remote-notifier.test.ts`
Expected: 测试 1、2、3、5 FAIL（shell 事件无处理、session.deleted 不清 shell；测试 2 此刻会因为第一段抑制已生效而……注意：Task 1 后测试 2 前半 0 次成立、后半 `execution.started`+`succeeded` 会发 1 次 idle——即可能已 PASS；以 1、3、5 FAIL 为准）。

- [ ] **Step 3: 实现清理**

a) `handleEvent` 中、`session.deleted` 块**之前**新增 `shell.exited`/`shell.deleted` 分支（必须在 ownership gate 之前：`shell.*` 事件无顶层 sessionID，gate 会丢弃）：

```ts
if (type === "shell.exited" || type === "shell.deleted") {
  const shellID = data?.id
  if (typeof shellID === "string") {
    const owner = backgroundShells.get(shellID)
    if (owner) {
      backgroundShells.delete(shellID)
      // Exited: the synthetic wake (resume) is imminent — cancel rather than
      // race the debounce against execution.started. Deleted (killed) shells
      // also wake with "Cancelled".
      cancelIdleDebounce(owner)
      logger.debug("Background shell released — cancelled idle debounce", { shellID, sessionID: owner, via: type })
    }
  }
  return
}
```

b) `session.deleted` 块内（`pending.delete` 前）追加：遍历删除 `backgroundShells`、`bgToolCalls` 中 owner 为该 session 的项，注释说明"已删 session 的 shell 不得永久扣住（父）session 的 idle"。

c) `cleanup()` 追加 `bgToolCalls.clear(); backgroundShells.clear()`。

- [ ] **Step 4: 跑全部测试确认通过**

Run: `cd .opencode && bun test ./test/`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/remote-notifier.ts .opencode/test/remote-notifier.test.ts
git commit -m "feat: release background-shell idle suppression on shell exit/delete"
```

---

### Task 3: 文档与版本

**Files:**
- Modify: `README.md`（"How It Works" 节 L80-96、Events L66-74 如需）、`package.json`（version 2.1.0 → 2.2.0）

**Interfaces:** 无。

- [ ] **Step 1: 更新 README**

"How It Works" 的 Events handled 行（L96）后补一段 idle 抑制说明（英文，与现有文风一致）：三点——

1. idle 在下列情况被抑制：错误尾随 idle、子代理会话 idle、父 session 有 active child（现有）；
2. **新增**：`session.tool.called`（name=shell, input.background=true）经 `session.tool.progress`/`success` 的 `metadata.shellID` 登记为待完成背景 shell，期间该 session **及其后代链上的父 session** 的 idle 被抑制；`shell.exited`/`shell.deleted`/`session.deleted` 释放。永不退出的背景 shell（dev server）会持续抑制——session 在等它退出唤醒；
3. 已知不覆盖：用户手动把前景 shell 转背景（input.background 为 false 的路径）。

Events 表（L66-74）中 idle 行为描述如提及触发条件则同步。

- [ ] **Step 2: 版本号**

`package.json` `"version": "2.1.0"` → `"2.2.0"`。

- [ ] **Step 3: 验证与提交**

Run: `cd .opencode && bun test ./test/ && cd .. && bun run typecheck`
Expected: 测试全 PASS、typecheck 无错误。

```bash
git add README.md package.json
git commit -m "docs: document background-shell idle suppression, bump to 2.2.0"
```
