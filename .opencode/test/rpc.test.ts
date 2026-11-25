// Tests for the RPC surface other plugins use to push notifications
// through this plugin (id "remote-notifier", method notify, input
// { title, message, priority? }). The pinned caller is
// opencode-error-handler-plugin, which calls it fire-and-forget and
// degrades silently on failure — so this contract must match what it
// sends exactly.
import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginDefault, { buildMessage, createNotifier } from "../plugins/remote-notifier.ts"
import type { Config, NotifierDeps } from "../plugins/remote-notifier.ts"
import { NotifierRpc, asNotifyInput } from "../plugins/rpc.ts"

// ---- Fixtures (mirroring remote-notifier.test.ts) ----

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
  external: { enabled: true },
  rateLimit: { maxPerMinute: 100, dedupWindowSec: 0 },
}

const SESSION_ID = "ses_abc123"
const PLUGIN_DIR = "/home/dev/work/alpha"

interface SentCall {
  title: string
  message: string
  priority: number
  topic: string
}

function makeNotifier(
  sender: (p: any) => void,
  directory = PLUGIN_DIR,
  deps: Partial<NotifierDeps> = {},
  overrides: Partial<Config> = {},
) {
  return createNotifier({ ...config, ...overrides }, silentLogger, directory, {
    sender,
    idleDebounceMs: 15,
    permissionDebounceMs: 15,
    ...deps,
  })
}

let seq = 0
function ev(type: string, data: Record<string, unknown>, directory: string | null = PLUGIN_DIR) {
  const event: Record<string, unknown> = {
    id: `evt_${++seq}`,
    created: Date.now(),
    type,
    data,
  }
  if (directory !== null) event.location = { directory }
  return event
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- RPC definition (rpc.ts) ----

describe("RPC definition (contract)", () => {
  test("id is remote-notifier with a single notify method", () => {
    expect(NotifierRpc.id).toBe("remote-notifier")
    expect(Object.keys(NotifierRpc.methods)).toEqual(["notify"])
  })

  test("input schema requires title and message; priority is optional", () => {
    const input = (NotifierRpc.methods as any).notify.input
    expect(input.type).toBe("object")
    expect(input.required).toEqual(["title", "message"])
    expect(input.properties.title.type).toBe("string")
    expect(input.properties.message.type).toBe("string")
    expect(input.properties.priority.type).toBe("number")
    expect(input.additionalProperties).toBe(false)
  })

  test("output schema reports whether the notification was accepted", () => {
    const output = (NotifierRpc.methods as any).notify.output
    expect(output.type).toBe("object")
    expect(output.required).toEqual(["sent"])
    expect(output.properties.sent.type).toBe("boolean")
    expect(output.additionalProperties).toBe(false)
  })
})

describe("asNotifyInput (post-schema narrowing)", () => {
  test("accepts a full input", () => {
    expect(asNotifyInput({ title: "t", message: "m", priority: 4 })).toEqual({ title: "t", message: "m", priority: 4 })
  })

  test("accepts input without priority", () => {
    expect(asNotifyInput({ title: "t", message: "m" })).toEqual({ title: "t", message: "m", priority: undefined })
  })

  test("rejects missing title", () => {
    expect(asNotifyInput({ message: "m" })).toBeNull()
  })

  test("rejects missing message", () => {
    expect(asNotifyInput({ title: "t" })).toBeNull()
  })

  test("rejects non-string fields", () => {
    expect(asNotifyInput({ title: 3, message: "m" })).toBeNull()
    expect(asNotifyInput({ title: "t", message: 3 })).toBeNull()
  })

  test("rejects a non-number priority", () => {
    expect(asNotifyInput({ title: "t", message: "m", priority: "high" })).toBeNull()
  })

  test("rejects non-objects", () => {
    expect(asNotifyInput(null)).toBeNull()
    expect(asNotifyInput("x")).toBeNull()
  })
})

// ---- External notify pipeline ----

describe("external notify pipeline", () => {
  test("sends the caller's title and message with the given priority", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    expect(n.notifyExternal({ title: "⚠️ Quota exhausted", message: "anthropic resets at 12:00", priority: 4 })).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0]!.title).toBe("⚠️ Quota exhausted")
    expect(calls[0]!.message).toBe("anthropic resets at 12:00")
    expect(calls[0]!.priority).toBe(4)
    expect(calls[0]!.topic).toBe("test-topic")
  })

  test("defaults the priority to the error event's priority when omitted", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.notifyExternal({ title: "t", message: "m" })
    expect(calls[0]!.priority).toBe(5) // config.events.error.priority
  })

  test("clamps out-of-range priorities into ntfy's 1-5 range", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p))
    n.notifyExternal({ title: "a", message: "m", priority: 9 })
    n.notifyExternal({ title: "b", message: "m", priority: 0 })
    n.notifyExternal({ title: "c", message: "m", priority: 2.6 })
    expect(calls.map((c) => c.priority)).toEqual([5, 1, 3])
  })

  test("does not send when external is disabled", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), PLUGIN_DIR, {}, { external: { enabled: false } })
    expect(n.notifyExternal({ title: "t", message: "m" })).toBe(false)
    expect(calls.length).toBe(0)
  })

  test("dedups identical notifications within the dedup window", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), PLUGIN_DIR, {}, { rateLimit: { maxPerMinute: 100, dedupWindowSec: 30 } })
    expect(n.notifyExternal({ title: "t", message: "m" })).toBe(true)
    expect(n.notifyExternal({ title: "t", message: "m" })).toBe(false) // identical content — dropped
    expect(n.notifyExternal({ title: "t", message: "different" })).toBe(true) // distinct content — sent
    expect(calls.length).toBe(2)
  })

  test("respects the global maxPerMinute cap", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), PLUGIN_DIR, {}, { rateLimit: { maxPerMinute: 2, dedupWindowSec: 0 } })
    expect(n.notifyExternal({ title: "1", message: "m" })).toBe(true)
    expect(n.notifyExternal({ title: "2", message: "m" })).toBe(true)
    expect(n.notifyExternal({ title: "3", message: "m" })).toBe(false)
    expect(calls.length).toBe(2)
  })

  test("shares the global rate limiter with session event notifications", () => {
    const calls: SentCall[] = []
    const n = makeNotifier((p) => calls.push(p), PLUGIN_DIR, {}, { rateLimit: { maxPerMinute: 2, dedupWindowSec: 0 } })
    n.handleEvent(ev("session.created", {
      sessionID: SESSION_ID,
      title: "New session - 2026-10-01T10:00:00",
      location: { directory: PLUGIN_DIR },
    }))
    n.handleEvent(ev("session.status", { sessionID: SESSION_ID, status: { type: "busy" } }))
    n.handleEvent(ev("session.execution.failed", {
      sessionID: SESSION_ID,
      error: { type: "provider.error", message: "boom" },
    }))
    expect(calls.length).toBe(1) // the error notification spent 1 of the 2/min budget
    expect(n.notifyExternal({ title: "quota", message: "m" })).toBe(true) // 2 of 2
    expect(n.notifyExternal({ title: "other", message: "m" })).toBe(false) // budget exhausted
    expect(calls.length).toBe(2)
    expect(calls[1]!.title).toBe("quota")
  })
})

// ---- buildMessage passthrough ----

describe("buildMessage external passthrough", () => {
  test("passes the caller's title and message through verbatim", () => {
    const { title, message } = buildMessage(config, "external", { title: "T", message: "M", project: { name: "alpha" } })
    expect(title).toBe("T")
    expect(message).toBe("M")
  })
})

// ---- Plugin setup wiring ----

describe("plugin setup wiring (RPC registration)", () => {
  test("setup registers the notify RPC and routes calls into the ntfy pipeline", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "notifier-home-"))
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "remote-notifier.json"),
      JSON.stringify({ server: "http://127.0.0.1:9999", topic: "wiring-rpc" }),
    )
    const prevHome = process.env.HOME
    process.env.HOME = home

    // Intercept the transport: this wiring test must not hit the network.
    const fetches: Array<{ url: string; body: any }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      fetches.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200 } as Response
    }) as typeof fetch

    let registered: { definition: any; handlers: any } | null = null
    let disposed = false
    const ctx: any = {
      location: { directory: "/home/dev/work/alpha" },
      session: { get: async () => null },
      event: {
        subscribe: async function* () {
          // Hold the stream open; this test drives the RPC surface, not events.
          await new Promise(() => {})
        },
      },
      rpc: {
        register: async (definition: any, handlers: any) => {
          registered = { definition, handlers }
          return { dispose: async () => { disposed = true } }
        },
      },
    }

    try {
      const dispose = (pluginDefault as any).setup(ctx)
      await sleep(50) // the async registration settles
      expect(registered).not.toBeNull()
      expect(registered!.definition.id).toBe("remote-notifier")

      const out = await registered!.handlers.notify({
        title: "Quota exhausted",
        message: "anthropic resets at 12:00",
        priority: 4,
      })
      expect(out).toEqual({ sent: true })
      await sleep(30) // the fire-and-forget send drains
      expect(fetches.length).toBe(1)
      expect(fetches[0]!.url).toBe("http://127.0.0.1:9999")
      expect(fetches[0]!.body).toMatchObject({
        topic: "wiring-rpc",
        title: "Quota exhausted",
        message: "anthropic resets at 12:00",
        priority: 4,
      })

      // Input the RPC layer's schema would reject never reaches the transport.
      const rejected = await registered!.handlers.notify({ message: "no title" })
      expect(rejected).toEqual({ sent: false })
      expect(fetches.length).toBe(1)

      dispose()
      await sleep(20)
      expect(disposed).toBe(true) // cleanup disposes the registration
    } finally {
      globalThis.fetch = realFetch
      process.env.HOME = prevHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
