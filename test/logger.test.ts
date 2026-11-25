// Tests for the file logger (src/logger.ts): JSONL entries, level filter,
// rotation, and the never-throw contract. Log paths always point into a
// temp dir — either passed explicitly or via REMOTE_NOTIFIER_LOG — so the
// suite never touches the real ~/.local/share/opencode/log/ file.
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginDefault from "../src/index.ts"
import { createFileLogger, DEFAULT_LOG_PATH, silentLogger } from "../src/logger.ts"

describe("createFileLogger", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rn-log-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const file = () => path.join(dir, "remote-notifier.log")

  test("writes JSONL entries with level, msg and extra fields", () => {
    const logger = createFileLogger(file())
    logger.info("notification sent", { type: "error", priority: 5 })
    logger.warn("something", { note: "x" })
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!)
    expect(first.level).toBe("info")
    expect(first.msg).toBe("notification sent")
    expect(first.type).toBe("error")
    expect(first.priority).toBe(5)
    expect(typeof first.ts).toBe("string")
    expect(new Date(first.ts).getTime()).not.toBeNaN()
    expect(JSON.parse(lines[1]!).level).toBe("warn")
  })

  test("respects minLevel", () => {
    const logger = createFileLogger(file(), { minLevel: "warn" })
    logger.debug("nope")
    logger.info("nope")
    logger.error("yes")
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toBe("yes")
  })

  test("rotates to .1 once the file exceeds the cap", () => {
    const logger = createFileLogger(file(), { rotationBytes: 1 })
    logger.info("first")
    logger.info("second")
    const rotated = fs.readFileSync(`${file()}.1`, "utf8")
    expect(rotated).toContain("first")
    expect(fs.readFileSync(file(), "utf8")).toContain("second")
  })

  test("an unwritable path never throws", () => {
    const logger = createFileLogger("/proc/definitely/not/writable/remote-notifier.log")
    expect(() => logger.info("boom")).not.toThrow()
  })

  test("silentLogger discards", () => {
    expect(() => silentLogger.info("x")).not.toThrow()
  })
})

describe("DEFAULT_LOG_PATH", () => {
  test("respects REMOTE_NOTIFIER_LOG and defaults next to opencode.log", () => {
    const prev = process.env.REMOTE_NOTIFIER_LOG
    process.env.REMOTE_NOTIFIER_LOG = "/tmp/custom.log"
    expect(DEFAULT_LOG_PATH()).toBe("/tmp/custom.log")
    delete process.env.REMOTE_NOTIFIER_LOG
    if (prev !== undefined) process.env.REMOTE_NOTIFIER_LOG = prev
    expect(DEFAULT_LOG_PATH()).toBe(path.join(os.homedir(), ".local/share/opencode/log/remote-notifier.log"))
  })
})

// ---- Plugin setup wiring ----

describe("plugin setup logging", () => {
  test("setup() routes the plugin log into the REMOTE_NOTIFIER_LOG file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rn-wire-home-"))
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "remote-notifier.json"),
      // Minimal valid config: setup only validates it here; the event
      // subscription holds open and dispose() cancels everything before
      // any delivery. This test asserts the log wiring, not notifications.
      JSON.stringify({ server: "http://127.0.0.1:9", topic: "wiring" }),
    )
    const logFile = path.join(home, "remote-notifier.log")

    const prevHome = process.env.HOME
    const prevLog = process.env.REMOTE_NOTIFIER_LOG
    process.env.HOME = home
    process.env.REMOTE_NOTIFIER_LOG = logFile

    const ctx: any = {
      location: { directory: "/home/dev/work/alpha" },
      session: { get: async () => null },
      event: {
        subscribe: async function* () {
          // Hold the stream open; this test asserts logging, not events.
          await new Promise(() => {})
        },
      },
      rpc: { register: async () => ({ dispose: async () => {} }) },
    }

    try {
      const entries = () =>
        fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      const dispose = (pluginDefault as any).setup(ctx)
      // Both writes are synchronous, so no settling is needed.
      expect(entries().some((e: any) => e.level === "info" && e.msg === "Plugin initialized")).toBe(true)
      dispose()
      expect(entries().some((e: any) => e.msg === "Plugin unloaded")).toBe(true)
    } finally {
      process.env.HOME = prevHome
      if (prevLog === undefined) delete process.env.REMOTE_NOTIFIER_LOG
      else process.env.REMOTE_NOTIFIER_LOG = prevLog
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
