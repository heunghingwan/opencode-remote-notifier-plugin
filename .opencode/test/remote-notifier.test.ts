// Tests for the V2 plugin port. Event fixtures mirror the @opencode/plugin
// 2.0.21 event schema shapes (session.created/renamed/status/deleted,
// session.execution.failed, permission.asked/replied, form.created) with the
// envelope { id, created, type, data, location }.
import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginDefault, { buildMessage, createNotifier, RateLimiter, readConfig } from "../plugins/remote-notifier.ts"
import type { Config, NotifierDeps } from "../plugins/remote-notifier.ts"

// ---- Fixtures ----

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const config: Config = {
  server: "http://127.0.0.1:9999",
  topic: "test-topic",
  token: "",
  markdown: true,
  events: {
    error:      { enabled: true, priority: 5 },
    permission: { enabled: true, priority: 4 },
    question:   { enabled: true, priority: 4 },
    idle:       { enabled: true, priority: 3 },
  },
  rateLimit: { maxPerMinute: 100, dedupWindowSec: 0 },
}

const SESSION_ID = "ses_abc123"
const PLUGIN_DIR = "/home/dev/work/alpha"

let seq = 0
function ev(type: string, data: Record<string, unknown>, directory: string | null = "/home/dev/work/alpha") {
  const event: Record<string, unknown> = {
    id: `evt_${++seq}`,
    created: Date.now(),
    type,
    data,
  }
  if (directory !== null) event.location = { directory }
  return event
}

function sessionCreated(extra: Record<string, unknown> = {}, sessionID = SESSION_ID) {
  return ev("session.created", {
    sessionID,
    projectID: "prj_1",
    // Real 2.x payload shape (observed live): location is an object.
    location: { directory: "/home/dev/work/alpha" },
    subpath: "",
    slug: "new-session",
    title: "New session - 2026-10-01T10:00:00",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    metadata: {},
    permissions: [],
    version: 2,
    ...extra,
  })
}

const busy = (sessionID = SESSION_ID) =>
  ev("session.status", { sessionID, status: { type: "busy" } })
const idle = (sessionID = SESSION_ID) =>
  ev("session.status", { sessionID, status: { type: "idle" } })

const executionFailed = (sessionID = SESSION_ID) =>
  ev("session.execution.failed", {
    sessionID,
    error: { type: "provider.error", message: "provider rate limited", status: 429, response: "" },
  })

const permissionAsked = (sessionID = SESSION_ID) =>
  ev("permission.asked", {
    id: "req_1",
    sessionID,
    action: "edit",
    resources: ["src/a.ts"],
    save: false,
    metadata: {},
    source: "session",
  })

const permissionReplied = (sessionID = SESSION_ID) =>
  ev("permission.replied", { sessionID, requestID: "req_1", reply: "once" })

const formCreated = (sessionID = SESSION_ID) =>
  ev("form.created", {
    form: {
      id: "form_1",
      sessionID,
      // Real V2 question-tool shape: title is the constant "Questions";
      // the content lives in fields[] (title = header, description = text).
      title: "Questions",
      metadata: {},
      fields: [{
        key: "q0",
        title: "Database",
        description: "Which database should we use?",
        type: "string",
        custom: true,
        options: [
          { value: "postgres", label: "postgres" },
          { value: "sqlite", label: "sqlite" },
        ],
      }],
    },
  })

const textEnded = (text: string, sessionID = SESSION_ID) =>
  ev("session.text.ended", { sessionID, assistantMessageID: "msg_1", ordinal: 0, text })

interface SentCall {
  title: string
  message: string
  priority: number
  topic: string
  tags: string[]
}

function makeNotifier(sender: (p: any) => void, directory = PLUGIN_DIR, deps: Partial<NotifierDeps> = {}) {
  return createNotifier(config, silentLogger, directory, {
    sender,
    idleDebounceMs: 15,
    permissionDebounceMs: 15,
    ...deps,
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- Plugin entry (V2 shape) ----

describe("plugin entry", () => {
  test("default export is a Plugin.define definition with id and setup", () => {
    expect(pluginDefault.id).toBe("remote-notifier")
    expect(typeof pluginDefault.setup).toBe("function")
  })
})

// ---- Error notifications ----

describe("error notifications", () => {
  test("session.execution.failed sends an error notification with error.message", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
    n.handleEvent(executionFailed())
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("🚨 Error")
    expect(calls[0]!.message).toContain("provider rate limited")
    expect(calls[0]!.priority).toBe(5)
    expect(calls[0]!.tags).toEqual([])
  })

  test("error body shows only the error message", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
    n.handleEvent(executionFailed())
    expect(calls[0]!.message).toBe("**alpha**\n\n```\nprovider rate limited\n```")
  })

  test("suppresses the trailing idle that follows an error", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
    n.handleEvent(executionFailed())
    n.handleEvent(idle())
    await sleep(50)
    expect(calls.length).toBe(1)
  })

  test("child session errors are suppressed", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated({ parentID: "ses_parent" }))
    n.handleEvent(executionFailed())
    expect(calls.length).toBe(0)
  })
})

// ---- Permission notifications ----

describe("permission notifications", () => {
  test("permission.asked sends a notification after the debounce with action and resources", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(permissionAsked())
    expect(calls.length).toBe(0)
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("🔐 Permission")
    expect(calls[0]!.message).toContain("`edit` on `src/a.ts`")
    expect(calls[0]!.priority).toBe(4)
  })

  test("permission.replied within the window cancels the notification", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(permissionAsked())
    n.handleEvent(permissionReplied())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("child session permissions are suppressed", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated({ parentID: "ses_parent" }))
    n.handleEvent(permissionAsked())
    await sleep(50)
    expect(calls.length).toBe(0)
  })
})

// ---- Question notifications ----

describe("question notifications", () => {
  test("form.created sends a question notification with the form title", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(formCreated())
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("❓ Question")
    expect(calls[0]!.message).toContain("Which database should we use?")
    expect(calls[0]!.priority).toBe(4)
  })

  test("question body uses the field header, question text and options", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(formCreated())
    expect(calls[0]!.message).toBe(
      "**alpha**\n\n> **Database** — Which database should we use?\n\n`postgres` · `sqlite`",
    )
  })

  test("question body falls back to the form title when there are no fields", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("form.created", {
      form: { id: "form_2", sessionID: SESSION_ID, title: "Confirm deploy?", metadata: {}, fields: [] },
    }))
    expect(calls[0]!.message).toBe("**alpha**\n\n> Confirm deploy?")
  })

  test("form.created includes a renamed session title in the notification title", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.renamed", { sessionID: SESSION_ID, title: "Fix login bug" }))
    n.handleEvent(formCreated())
    expect(calls[0]!.title).toBe("❓ Fix login bug")
  })
})

// ---- Idle notifications ----

describe("idle notifications (V2 execution lifecycle)", () => {
  // In OpenCode 2.0.21 session.status/session.idle have no emitters; the real
  // busy/idle signal is session.execution.started / session.execution.succeeded.
  test("execution.started then succeeded sends an idle notification after debounce", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    expect(calls.length).toBe(0)
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Idle")
    expect(calls[0]!.priority).toBe(3)
  })

  test("succeeded without a prior started is suppressed", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("execution.failed sends the error notification but no idle notification", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(executionFailed())
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("🚨 Error")
  })

  test("a new execution.started cancels a pending idle debounce", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("execution.interrupted (user-initiated) does not notify idle", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.interrupted", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("child session idle via execution.succeeded is suppressed", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated({ parentID: "ses_parent" }))
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("idle notification includes the renamed session title", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.renamed", { sessionID: SESSION_ID, title: "Fix login bug" }))
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Fix login bug")
  })

  test("idle body quotes the last assistant message of the finished turn", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(textEnded("All 42 tests pass.\n\nDetails in the log."))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.message).toBe("**alpha**\n\n> All 42 tests pass.")
  })

  test("idle snippet is single-line and truncated with an ellipsis", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(textEnded("   \n" + "x".repeat(300)))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    const line = calls[0]!.message.split("\n").find((l: string) => l.startsWith("> "))!
    expect(line!.length).toBeLessThanOrEqual(142) // "> " + 140 chars max
    expect(line!.endsWith("…")).toBe(true)
  })

  test("a snippet from an earlier turn is cleared when a new execution starts", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(textEnded("Old turn result."))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls[0]!.message).toContain("> Old turn result.")
    // Next turn produces no text (e.g. tool-only) — the stale snippet must not reappear.
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }))
    await sleep(50)
    expect(calls.length).toBe(2)
    expect(calls[1]!.message).toBe("**alpha**\n\nSession waiting for input")
  })
})

describe("idle notifications (sub-agent orchestration)", () => {
  // The parent's execution ends when it hands off to a sub-agent (Task
  // tool); the child session keeps working. The parent's idle signal in
  // that window is a handoff, not genuine idleness — no notification.
  const CHILD_ID = "ses_child456"
  const execStarted = (sessionID: string) => ev("session.execution.started", { sessionID }, null)
  const execSucceeded = (sessionID: string) => ev("session.execution.succeeded", { sessionID }, null)
  const childCreated = () => sessionCreated({ parentID: SESSION_ID }, CHILD_ID)

  test("parent idle is suppressed while a sub-agent child is still working", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(execStarted(SESSION_ID))
    n.handleEvent(childCreated())
    n.handleEvent(execStarted(CHILD_ID))
    n.handleEvent(execSucceeded(SESSION_ID)) // handoff idle — child still busy
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("a child going busy cancels the parent's pending idle debounce", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(execStarted(SESSION_ID))
    n.handleEvent(execSucceeded(SESSION_ID)) // schedules the idle debounce
    n.handleEvent(childCreated())
    n.handleEvent(execStarted(CHILD_ID)) // child starts — parent isn't really idle
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("the idle debounce re-checks for active children before firing", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(execStarted(SESSION_ID))
    n.handleEvent(execSucceeded(SESSION_ID)) // schedules the idle debounce
    // The child's execution starts before this instance saw session.created,
    // so its parentID is unknown at busy time; created arrives in-window.
    n.handleEvent(execStarted(CHILD_ID))
    n.handleEvent(childCreated())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("parent notifies idle once the child finishes and its next turn completes", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(execStarted(SESSION_ID))
    n.handleEvent(execSucceeded(SESSION_ID)) // handoff
    n.handleEvent(childCreated())
    n.handleEvent(execStarted(CHILD_ID))
    n.handleEvent(execSucceeded(CHILD_ID))
    n.handleEvent(execStarted(SESSION_ID)) // parent resumes with the result
    n.handleEvent(execSucceeded(SESSION_ID)) // genuine idle
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Idle")
  })

  test("a failed child releases its busy state so the parent can still notify idle", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(execStarted(SESSION_ID))
    n.handleEvent(execSucceeded(SESSION_ID)) // handoff
    n.handleEvent(childCreated())
    n.handleEvent(execStarted(CHILD_ID))
    n.handleEvent(executionFailed(CHILD_ID)) // child error — suppressed, must release busy
    n.handleEvent(execStarted(SESSION_ID)) // parent resumes with the error result
    n.handleEvent(execSucceeded(SESSION_ID)) // genuine idle
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Idle")
  })

  test("a deleted child cancels the parent's pending idle debounce", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(execStarted(SESSION_ID))
    n.handleEvent(execSucceeded(SESSION_ID)) // schedules the idle debounce
    n.handleEvent(childCreated())
    n.handleEvent(ev("session.deleted", { sessionID: CHILD_ID })) // spawn aborted
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("parent idle via session.status is suppressed while a child is busy", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy(SESSION_ID))
    n.handleEvent(childCreated())
    n.handleEvent(busy(CHILD_ID))
    n.handleEvent(idle(SESSION_ID))
    await sleep(50)
    expect(calls.length).toBe(0)
  })
})

describe("idle notifications (session.status, future OpenCode versions)", () => {
  test("sends an idle notification after the debounce window", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
    n.handleEvent(idle())
    expect(calls.length).toBe(0)
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Idle")
    expect(calls[0]!.priority).toBe(3)
  })

  test("suppresses idle when the session was never busy", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(idle())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("suppresses child session idle", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated({ parentID: "ses_parent" }))
    n.handleEvent(busy())
    n.handleEvent(idle())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("busy after idle cancels the pending idle notification", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
    n.handleEvent(idle())
    n.handleEvent(busy())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("uses the session's directory as the project name", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/beta")
    n.handleEvent(sessionCreated({ location: { directory: "/home/dev/work/beta" } }))
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "busy" } }, "/home/dev/work/beta"))
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "idle" } }, "/home/dev/work/beta"))
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.message).toContain("**beta**")
  })

  test("falls back to the plugin directory when the event has no location", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/gamma")
    n.handleEvent(sessionCreated({ location: { directory: "/home/dev/work/gamma" } }))
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "busy" } }, null))
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "idle" } }, null))
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.message).toContain("**gamma**")
  })

  test("cleanup cancels a pending idle debounce", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
    n.handleEvent(idle())
    n.cleanup()
    await sleep(50)
    expect(calls.length).toBe(0)
  })
})

// ---- Multi-location ownership ----
// OpenCode V2 instantiates the plugin once per active location (project
// directory) in one shared server, and every instance receives ALL events
// from the global bus. session.execution.* events carry no envelope location,
// so without an ownership filter each instance treats every session as its
// own and N locations produce N duplicate notifications.

describe("multi-location ownership (one plugin instance per location)", () => {
  test("only the instance whose directory owns the session sends the idle notification", async () => {
    const alpha: SentCall[] = []
    const beta: SentCall[] = []
    const a = makeNotifier((p) => alpha.push(p), "/home/dev/work/alpha")
    const b = makeNotifier((p) => beta.push(p), "/home/dev/work/beta")
    const events = [
      sessionCreated({ location: { directory: "/home/dev/work/alpha" } }),
      ev("session.execution.started", { sessionID: SESSION_ID }, null),
      ev("session.execution.succeeded", { sessionID: SESSION_ID }, null),
    ]
    for (const event of events) {
      a.handleEvent(event)
      b.handleEvent(event)
    }
    await sleep(50)
    expect(alpha.length).toBe(1)
    expect(beta.length).toBe(0)
  })

  test("foreign permission requests are skipped — the owning instance notifies", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/beta")
    n.handleEvent(sessionCreated())
    n.handleEvent(permissionAsked())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("event envelope location seeds ownership when session.created was missed", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/beta")
    // No session.created seen; the envelope says the session lives in alpha.
    n.handleEvent(permissionAsked())
    await sleep(50)
    expect(calls.length).toBe(0)
  })

  test("an unseen session's directory is resolved before deciding ownership", async () => {
    const calls: SentCall[] = []
    let resolved = 0
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/alpha", {
      resolveSession: async () => {
        resolved++
        return { directory: "/home/dev/work/alpha", title: null }
      },
    })
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }, null))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }, null))
    expect(calls.length).toBe(0)
    await sleep(60)
    // One fetch resolves ownership; the idle dispatch may fetch once more to
    // backfill a title the first lookup didn't have yet.
    expect(resolved).toBeGreaterThanOrEqual(1)
    expect(calls.length).toBe(1)
  })

  test("a resolved foreign session sends nothing", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/alpha", {
      resolveSession: async () => ({ directory: "/home/dev/work/beta", title: "Other" }),
    })
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }, null))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }, null))
    await sleep(60)
    expect(calls.length).toBe(0)
  })

  test("without a resolver, unknown sessions keep legacy single-instance behavior", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/gamma")
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }, null))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }, null))
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.message).toContain("**gamma**")
  })
})

// ---- Title backfill ----
// OpenCode generates a session's real title with an async LLM call and
// publishes session.renamed exactly once. A plugin instance that boots after
// that (server restart, plugin reload, late location activation) never sees
// the event, so the title must be fetched from the session API at dispatch
// time instead of being blank forever.

describe("title backfill via the session API", () => {
  test("idle dispatch uses a title fetched when session.renamed was missed", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/alpha", {
      resolveSession: async () => ({ directory: "/home/dev/work/alpha", title: "Fix login bug" }),
    })
    // No session.created / session.renamed seen: the instance booted late.
    // The envelope location seeds ownership synchronously.
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }, "/home/dev/work/alpha"))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }, "/home/dev/work/alpha"))
    await sleep(60)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Fix login bug")
  })

  test("immediate error dispatch awaits the title backfill", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/alpha", {
      resolveSession: async () => ({ directory: "/home/dev/work/alpha", title: "Mid-session crash" }),
    })
    n.handleEvent(ev("session.execution.failed", {
      sessionID: SESSION_ID,
      error: { type: "provider.error", message: "boom" },
    }, "/home/dev/work/alpha"))
    await sleep(30)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("🚨 Mid-session crash")
  })

  test("a fresher session.renamed is not clobbered by a stale in-flight fetch", async () => {
    const calls: SentCall[] = []
    let releaseFetch!: (value: { directory: string; title: string }) => void
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/alpha", {
      resolveSession: () => new Promise((resolve) => { releaseFetch = resolve }),
    })
    n.handleEvent(ev("session.execution.failed", {
      sessionID: SESSION_ID,
      error: { type: "provider.error", message: "boom" },
    }, "/home/dev/work/alpha"))
    // renamed wins the race against the still-pending API fetch
    n.handleEvent(ev("session.renamed", { sessionID: SESSION_ID, title: "Fresh title" }, "/home/dev/work/alpha"))
    releaseFetch({ directory: "/home/dev/work/alpha", title: "Stale title" })
    await sleep(30)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("🚨 Fresh title")
  })

  test("a default title from the API is treated as absent", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/dev/work/alpha", {
      resolveSession: async () => ({ directory: "/home/dev/work/alpha", title: "New session - 2026-10-01T10:00:00" }),
    })
    n.handleEvent(ev("session.execution.started", { sessionID: SESSION_ID }, "/home/dev/work/alpha"))
    n.handleEvent(ev("session.execution.succeeded", { sessionID: SESSION_ID }, "/home/dev/work/alpha"))
    await sleep(60)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("💤 Idle")
  })
})

// ---- Plugin setup wiring ----

describe("plugin setup wiring", () => {
  test("setup subscribes to events and resolves session directories via ctx.session.get", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "notifier-home-"))
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "remote-notifier.json"),
      // The idle debounce (default 5s) is cancelled by dispose() before it
      // fires, so the server is never actually reached; it only satisfies
      // config validation. This test asserts the wiring, not delivery.
      JSON.stringify({ server: "http://127.0.0.1:9", topic: "wiring" }),
    )
    const prevHome = process.env.HOME
    process.env.HOME = home

    let sessionGets = 0
    const ctx: any = {
      location: { directory: "/home/dev/work/alpha" },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          sessionGets++
          return { id: sessionID, location: { directory: "/home/dev/work/alpha" }, title: "Wired title" }
        },
      },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          const events = [
            ev("session.execution.started", { sessionID: SESSION_ID }, null),
            ev("session.execution.succeeded", { sessionID: SESSION_ID }, null),
          ]
          for (const event of events) {
            if (signal.aborted) return
            yield event
          }
          // Hold the stream open until the test is done observing.
          await new Promise(() => {})
        },
      },
    }

    try {
      const dispose = (pluginDefault as any).setup(ctx)
      await sleep(80)
      expect(sessionGets).toBe(1)
      dispose()
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---- Message builder ----

describe("buildMessage", () => {
  const withProject = (payload: Record<string, unknown>) => ({ ...payload, project: { name: "alpha" } })

  test("error message embeds the error text in a code block", () => {
    const { title, message } = buildMessage(config, "error", withProject({ error: { type: "provider.error", message: "boom", status: 429 } }), "Fix login")
    expect(title).toBe("🚨 Fix login")
    expect(message).toBe("**alpha**\n\n```\nboom\n```")
  })

  test("permission message shows action and resources", () => {
    const { message } = buildMessage(config, "permission", withProject({ action: "edit", resources: ["src/a.ts"] }))
    expect(message).toBe("**alpha**\n\n`edit` on `src/a.ts`")
  })

  test("question message quotes the form title", () => {
    const { message } = buildMessage(config, "question", withProject({ form: { id: "f", sessionID: "s", title: "Which database?", fields: [] } }))
    expect(message).toBe("**alpha**\n\n> Which database?")
  })

  test("idle message in plain text mode", () => {
    const plain = { ...config, markdown: false }
    const { title, message } = buildMessage(plain, "idle", withProject({}), "New session - 2026-10-01T10:00:00")
    expect(title).toBe("💤 Idle")
    expect(message).toBe("[alpha] session waiting for input")
  })

  test("idle message quotes the last assistant text in plain text mode", () => {
    const plain = { ...config, markdown: false }
    const { message } = buildMessage(plain, "idle", withProject({ lastText: "Done in 3m." }))
    expect(message).toBe("[alpha] Done in 3m.")
  })

  test("question message renders each field as its own quoted line", () => {
    const { message } = buildMessage(config, "question", withProject({
      form: {
        id: "f",
        sessionID: "s",
        title: "Questions",
        fields: [
          { key: "q0", title: "Region", description: "Where to deploy?", options: [{ value: "eu", label: "eu" }] },
          { key: "q1", description: "Enable cache?", options: [] },
        ],
      },
    }))
    expect(message).toBe("**alpha**\n\n> **Region** — Where to deploy?\n> Enable cache?\n\n`eu`")
  })

  test("question message in plain text mode", () => {
    const plain = { ...config, markdown: false }
    const { message } = buildMessage(plain, "question", withProject({
      form: {
        id: "f",
        sessionID: "s",
        title: "Questions",
        fields: [{ key: "q0", title: "DB", description: "Which one?", options: [{ value: "a", label: "a" }, { value: "b", label: "b" }] }],
      },
    }))
    expect(message).toBe("[alpha] DB — Which one? (a, b)")
  })
})

// ---- Rate limiter ----

describe("RateLimiter", () => {
  test("blocks a repeated key within the dedup window", () => {
    const limiter = new RateLimiter(30, 5, silentLogger)
    expect(limiter.allow("k")).toBe(true)
    expect(limiter.allow("k")).toBe(false)
  })

  test("enforces the per-minute cap", () => {
    const limiter = new RateLimiter(0, 2, silentLogger)
    expect(limiter.allow("a")).toBe(true)
    expect(limiter.allow("b")).toBe(true)
    expect(limiter.allow("c")).toBe(false)
  })

  test("skipDedup bypasses the dedup window but not the cap", () => {
    const limiter = new RateLimiter(30, 2, silentLogger)
    expect(limiter.allow("k", true)).toBe(true)
    expect(limiter.allow("k", true)).toBe(true)
    expect(limiter.allow("k", true)).toBe(false)
  })
})

// ---- Config reader ----

describe("readConfig", () => {
  function withHome(files: Record<string, unknown>, fn: (home: string) => void) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "notifier-home-"))
    const dir = path.join(home, ".config", "opencode")
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content))
    }
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      fn(home)
    } finally {
      process.env.HOME = prev
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  test("merges user config over defaults", () => {
    withHome({
      "remote-notifier.json": { server: "http://ntfy.example.com", topic: "t1", markdown: false, events: { idle: { enabled: false } } },
    }, () => {
      const cfg = readConfig(silentLogger)
      expect(cfg).not.toBeNull()
      expect(cfg!.server).toBe("http://ntfy.example.com")
      expect(cfg!.topic).toBe("t1")
      expect(cfg!.markdown).toBe(false)
      expect(cfg!.events.idle.enabled).toBe(false)
      expect(cfg!.events.error.priority).toBe(5)
      expect(cfg!.rateLimit.maxPerMinute).toBe(5)
    })
  })

  test("returns null when the topic is missing", () => {
    withHome({ "remote-notifier.json": { server: "http://ntfy.example.com" } }, () => {
      expect(readConfig(silentLogger)).toBeNull()
    })
  })

  test("returns null when the config file is absent", () => {
    withHome({}, () => {
      expect(readConfig(silentLogger)).toBeNull()
    })
  })
})
