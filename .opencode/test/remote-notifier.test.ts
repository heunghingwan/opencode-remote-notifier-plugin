// Tests for the V2 plugin port. Event fixtures mirror the @opencode/plugin
// 2.0.21 event schema shapes (session.created/renamed/status/deleted,
// session.execution.failed, permission.asked/replied, form.created) with the
// envelope { id, created, type, data, location }.
import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginDefault, { buildMessage, createNotifier, RateLimiter, readConfig } from "../plugins/remote-notifier.ts"
import type { Config } from "../plugins/remote-notifier.ts"

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
const PLUGIN_DIR = "/home/wan/work/alpha"

let seq = 0
function ev(type: string, data: Record<string, unknown>, directory: string | null = "/home/wan/work/alpha") {
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
    location: "/home/wan/work/alpha",
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
      title: "Which database?",
      metadata: {},
      fields: [{ id: "f1", label: "DB", options: ["postgres", "sqlite"] }],
    },
  })

interface SentCall {
  title: string
  message: string
  priority: number
  topic: string
  tags: string[]
}

function makeNotifier(sender: (p: any) => void, directory = PLUGIN_DIR) {
  return createNotifier(config, silentLogger, directory, {
    sender,
    idleDebounceMs: 15,
    permissionDebounceMs: 15,
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
    expect(calls[0]!.title).toBe("OpenCode: Error")
    expect(calls[0]!.message).toContain("provider rate limited")
    expect(calls[0]!.priority).toBe(5)
    expect(calls[0]!.tags).toEqual(["rotating_light", "x"])
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
    expect(calls[0]!.title).toBe("OpenCode: Permission")
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
    expect(calls[0]!.title).toBe("OpenCode: Question")
    expect(calls[0]!.message).toContain("Which database?")
    expect(calls[0]!.priority).toBe(4)
  })

  test("form.created includes a renamed session title in the notification title", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.renamed", { sessionID: SESSION_ID, title: "Fix login bug" }))
    n.handleEvent(formCreated())
    expect(calls[0]!.title).toBe("OpenCode: Question - Fix login bug")
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
    expect(calls[0]!.title).toBe("OpenCode: Idle")
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
    expect(calls[0]!.title).toBe("OpenCode: Error")
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
    expect(calls[0]!.title).toBe("OpenCode: Idle - Fix login bug")
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
    expect(calls[0]!.title).toBe("OpenCode: Idle")
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

  test("uses the event location directory as the project name", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.handleEvent(sessionCreated())
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "busy" } }, "/home/wan/work/beta"))
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "idle" } }, "/home/wan/work/beta"))
    await sleep(50)
    expect(calls.length).toBe(1)
    expect(calls[0]!.message).toContain("**beta**")
  })

  test("falls back to the plugin directory when the event has no location", async () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), "/home/wan/work/gamma")
    n.handleEvent(sessionCreated())
    n.handleEvent(busy())
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

// ---- Message builder ----

describe("buildMessage", () => {
  const withProject = (payload: Record<string, unknown>) => ({ ...payload, project: { name: "alpha" } })

  test("error message embeds the error text in a code block", () => {
    const { title, message } = buildMessage(config, "error", withProject({ error: { type: "provider.error", message: "boom", status: 429 } }), "Fix login")
    expect(title).toBe("OpenCode: Error - Fix login")
    expect(message).toBe("**alpha**\n\n⚠️ **Error**\n\n```\nboom\n```")
  })

  test("permission message shows action and resources", () => {
    const { message } = buildMessage(config, "permission", withProject({ action: "edit", resources: ["src/a.ts"] }))
    expect(message).toBe("**alpha**\n\n🔒 **Permission**\n\n`edit` on `src/a.ts`")
  })

  test("question message quotes the form title", () => {
    const { message } = buildMessage(config, "question", withProject({ form: { id: "f", sessionID: "s", title: "Which database?", fields: [] } }))
    expect(message).toBe("**alpha**\n\n❓ **Question**\n\n> Which database?")
  })

  test("idle message in plain text mode", () => {
    const plain = { ...config, markdown: false }
    const { title, message } = buildMessage(plain, "idle", withProject({}), "New session - 2026-10-01T10:00:00")
    expect(title).toBe("OpenCode: Idle")
    expect(message).toBe("[alpha] Idle — session waiting for input")
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
