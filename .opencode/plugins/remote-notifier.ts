import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

// ---- Logger ----
// V2 plugin context has no structured log endpoint; console output is
// captured by the server log (filter role=server).

type LoggerLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

function createLogger(): Logger {
  const log = (level: LoggerLevel, message: string, extra?: Record<string, unknown>) => {
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ""
    const line = `[remote-notifier] ${message}${suffix}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else if (level === "debug") console.debug(line)
    else console.log(line)
  }
  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  }
}

// ---- Types ----

export type EventType = "error" | "permission" | "question" | "idle"

interface EventConfig {
  enabled: boolean
  priority: number
}

export interface Config {
  server: string
  topic: string
  token: string
  markdown: boolean
  events: Record<EventType, EventConfig>
  rateLimit: {
    maxPerMinute: number
    dedupWindowSec: number
  }
}

const DEFAULTS: Config = {
  server: "https://ntfy.sh",
  topic: "",
  token: "",
  markdown: true,
  events: {
    error:      { enabled: true, priority: 5 },
    permission: { enabled: true, priority: 4 },
    question:   { enabled: true, priority: 4 },
    idle:       { enabled: true, priority: 3 },
  },
  rateLimit: {
    maxPerMinute: 5,
    dedupWindowSec: 30,
  },
}

// Debounce windows (ms). Idle waits for the session to stay idle (another plugin
// may continue it). Permission waits for a reply — if the user (allow OR block)
// or an auto-accept replies within the window, no notification is sent.
const IDLE_DEBOUNCE_MS = 5000
const PERMISSION_DEBOUNCE_MS = 5000

// ---- Config Reader ----

export function readConfig(logger: Logger): Config | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ""
  const filePath = path.join(homeDir, ".config", "opencode", "remote-notifier.json")
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const user = JSON.parse(raw)
    const merged: Config = {
      server: user.server || DEFAULTS.server,
      topic: user.topic || "",
      token: user.token || DEFAULTS.token,
      markdown: user.markdown ?? DEFAULTS.markdown,
      events: {
        error:      { ...DEFAULTS.events.error, ...user.events?.error },
        permission: { ...DEFAULTS.events.permission, ...user.events?.permission },
        question:   { ...DEFAULTS.events.question, ...user.events?.question },
        idle:       { ...DEFAULTS.events.idle, ...user.events?.idle },
      },
      rateLimit: {
        maxPerMinute: user.rateLimit?.maxPerMinute ?? DEFAULTS.rateLimit.maxPerMinute,
        dedupWindowSec: user.rateLimit?.dedupWindowSec ?? DEFAULTS.rateLimit.dedupWindowSec,
      },
    }
    if (!merged.server || !merged.topic) {
      throw new Error("missing required fields: server, topic")
    }
    return merged
  } catch (err: any) {
    if (err.code === "ENOENT") return null
    logger.error("Config parse error", { message: err.message })
    return null
  }
}

// ---- Rate Limiter ----

export class RateLimiter {
  #dedup = new Map<string, number>()
  #timestamps: number[] = []
  #dedupWindow: number
  #maxPerMinute: number
  #logger: Logger

  constructor(dedupWindowSec: number, maxPerMinute: number, logger: Logger) {
    this.#dedupWindow = dedupWindowSec * 1000
    this.#maxPerMinute = maxPerMinute
    this.#logger = logger
  }

  allow(key: string, skipDedup = false): boolean {
    const now = Date.now()

    if (!skipDedup) {
      const lastSent = this.#dedup.get(key)
      if (lastSent !== undefined && now - lastSent < this.#dedupWindow) {
        this.#logger.debug("Dedup hit, skipping", { key })
        return false
      }
    }

    this.#timestamps = this.#timestamps.filter((t) => now - t < 60_000)
    if (this.#timestamps.length >= this.#maxPerMinute) {
      this.#logger.debug("Rate limit exceeded, skipping", { count: this.#timestamps.length })
      return false
    }

    if (!skipDedup) {
      this.#dedup.set(key, now)
    }
    this.#timestamps.push(now)
    return true
  }
}

// ---- Notifier Client ----

export interface NotifyPayload {
  server: string
  topic: string
  token: string
  markdown: boolean
  title: string
  message: string
  priority: number
  tags: string[]
}

async function sendNotification(payload: NotifyPayload, logger: Logger): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (payload.token) {
    headers["Authorization"] = `Bearer ${payload.token}`
  }

  const body = JSON.stringify({
    topic: payload.topic,
    title: payload.title,
    message: payload.message,
    priority: payload.priority,
    tags: payload.tags,
    ...(payload.markdown ? { markdown: true } : {}),
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      const res = await fetch(payload.server, {
        method: "POST",
        headers,
        body,
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        logger.info("Notification sent successfully", { status: res.status })
        return
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000))
      } else {
        logger.warn("HTTP send failed after 3 retries", { status: res.status })
      }
    } catch (err: any) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000))
      } else {
        logger.warn("HTTP send failed after 3 retries", { error: err?.message ?? err })
      }
    }
  }
}

// ---- Session Tracking ----
// Minimal parent/child + active/errored tracking, mirroring the mature pattern
// used by opencode's built-in TUI notifications plugin. The OpenCode core
// guarantees parent idle fires after foreground children finish, so we do NOT
// implement our own parent/child join — we simply suppress any session whose
// parentID is set (sub-agent sessions never notify).

interface SessionInfo {
  parentID?: string
  title?: string
  /**
   * Directory of the location this session belongs to (from session.created's
   * data.location, an event envelope location, or the session API). Used to
   * decide ownership: OpenCode V2 instantiates this plugin once per active
   * location, all instances receive every event, and only the instance whose
   * directory matches the session's may notify.
   * undefined = never learned yet; null = looked up but unknown.
   */
  directory?: string | null
}

// ---- Event constants & message builder ----

const EVENT_TAGS: Record<EventType, string[]> = {
  error:      ["rotating_light", "x"],
  permission: ["lock", "key"],
  question:   ["question", "grey_question"],
  idle:       ["zzz", "sleeping"],
}

const EVENT_TITLES: Record<EventType, string> = {
  error:      "OpenCode: Error",
  permission: "OpenCode: Permission",
  question:   "OpenCode: Question",
  idle:       "OpenCode: Idle",
}

function isDefaultTitle(title: string): boolean {
  return /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(title)
}

// V2 payload shapes (see @opencode/plugin 2.x event schemas):
//   error      session.execution.failed  data.{sessionID, error.message}
//   permission permission.asked          data.{sessionID, action, resources}
//   question   form.created              data.form.{sessionID, title}
//   idle       session.status            data.{sessionID, status.type}
export function buildMessage(config: Config, type: EventType, payload: any, sessionTitle?: string | null): { title: string; message: string } {
  const baseTitle = EVENT_TITLES[type]
  const effectiveTitle = sessionTitle && !isDefaultTitle(sessionTitle) ? sessionTitle : null
  const title = effectiveTitle ? `${baseTitle} - ${effectiveTitle}` : baseTitle
  const md = config.markdown

  switch (type) {
    case "error": {
      const errMsg = (payload?.error?.message ?? "unknown error").slice(0, 200)
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n\u26a0\ufe0f **Error**\n\n\`\`\`\n${errMsg}\n\`\`\``
          : `[${project}] Error: ${errMsg}`,
      }
    }
    case "permission": {
      const perm = payload?.action ?? payload?.permission ?? "unknown"
      const patterns = Array.isArray(payload?.resources) ? payload.resources.join(", ")
        : Array.isArray(payload?.patterns) ? payload.patterns.join(", ")
        : payload?.filePath ?? "unknown"
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n\ud83d\udd12 **Permission**\n\n\`${perm}\` on \`${patterns}\``
          : `[${project}] Permission: ${perm} on ${patterns}`,
      }
    }
    case "question": {
      const text = (payload?.form?.title ?? "user input needed").slice(0, 80)
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n\u2753 **Question**\n\n> ${text}`
          : `[${project}] Question: ${text}`,
      }
    }
    case "idle": {
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n\ud83d\udca4 **Idle**\n\nSession waiting for input`
          : `[${project}] Idle — session waiting for input`,
      }
    }
  }
}

// ---- Notifier core ----
// Owns all per-instance state (session map, debounce timers) so the plugin
// can be unloaded cleanly and multiple locations never share state.

export interface NotifierDeps {
  /** Transport used to deliver notifications. Defaults to the ntfy HTTP client. */
  sender?: (payload: NotifyPayload) => Promise<void> | void
  idleDebounceMs?: number
  permissionDebounceMs?: number
  /**
   * Resolves a session's location directory when it wasn't learned from
   * events (e.g. this instance booted after session.created was published).
   * Production wiring uses ctx.session.get. Without it, sessions of unknown
   * directory are treated as local (legacy single-instance behavior).
   */
  resolveSessionDir?: (sessionID: string) => Promise<string | null>
}

export function createNotifier(config: Config, logger: Logger, projectDir: string, deps: NotifierDeps = {}) {
  const send = deps.sender ?? ((payload: NotifyPayload) => sendNotification(payload, logger))
  const idleDebounceMs = deps.idleDebounceMs ?? IDLE_DEBOUNCE_MS
  const permissionDebounceMs = deps.permissionDebounceMs ?? PERMISSION_DEBOUNCE_MS
  const resolveSessionDir = deps.resolveSessionDir
  const limiter = new RateLimiter(config.rateLimit.dedupWindowSec, config.rateLimit.maxPerMinute, logger)

  const sessions = new Map<string, SessionInfo>()
  // Sessions that were busy/retry before going idle. Suppresses no-op idles fired
  // for sessions that were never active (e.g. freshly-created children, or the
  // idle emitted after a cancel with no prior busy).
  const active = new Set<string>()
  // Sessions that errored. Suppresses the trailing idle that follows an error so
  // the user gets one notification, not two.
  const errored = new Set<string>()

  const idleDebounce = new Map<string, ReturnType<typeof setTimeout>>()
  const permissionDebounce = new Map<string, ReturnType<typeof setTimeout>>()
  // Serializes async ownership resolution per session so events keep their
  // order (started must be processed before succeeded).
  const pending = new Map<string, Promise<void>>()

  function cancelIdleDebounce(sessionID: string): void {
    const timer = idleDebounce.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      idleDebounce.delete(sessionID)
    }
  }

  function cancelPermissionDebounce(sessionID: string): void {
    const timer = permissionDebounce.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      permissionDebounce.delete(sessionID)
    }
  }

  function isChildSession(sessionID: string | undefined): boolean {
    if (!sessionID) return false
    return Boolean(sessions.get(sessionID)?.parentID)
  }

  function dispatch(
    eventType: EventType,
    data: any,
    sessionID: string | undefined,
    eventDir: string | null,
  ): void {
    const dedupKey = `${eventType}:${sessionID ?? "unknown"}`
    // idle naturally dedups via the active set; other events use per-key dedup.
    if (!limiter.allow(dedupKey, eventType === "idle")) return

    const sessionTitle = sessionID ? sessions.get(sessionID)?.title ?? null : null
    // Prefer the session's own directory (learned from session.created or the
    // session API), then the event envelope location; the plugin instance's
    // directory is only the fallback for events without a location.
    const sessionDir = sessionID ? sessions.get(sessionID)?.directory ?? null : null
    const project = path.basename(sessionDir ?? eventDir ?? projectDir)
    const { title, message } = buildMessage(config, eventType, { ...data, project: { name: project } }, sessionTitle)

    logger.info("Sending notification", { type: eventType, title, priority: config.events[eventType].priority })

    void send({
      server: config.server,
      topic: config.topic,
      token: config.token,
      markdown: config.markdown,
      title,
      message,
      priority: config.events[eventType].priority,
      tags: EVENT_TAGS[eventType],
    })
  }

  // Shared idle-signal handling. Called from both session.status idle and
  // session.execution.succeeded (the real signal on OpenCode ≤2.0.21, where
  // session.status has no emitter). Runs the mature suppress checks (no prior
  // busy / trailing idle after error / sub-agent child) then schedules the
  // idle debounce.
  function handleIdleSignal(sessionID: string, data: any, eventDir: string | null): void {
    // Suppress no-op idle (session was never busy first).
    if (!active.has(sessionID)) {
      logger.debug("Idle without prior busy — suppressing", { sessionID })
      return
    }
    active.delete(sessionID)

    // Suppress the trailing idle that follows an error (already notified).
    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      logger.debug("Trailing idle after error — suppressing", { sessionID })
      return
    }

    // Suppress sub-agent (child) idle — the parent orchestrator drives the flow.
    if (isChildSession(sessionID)) {
      logger.debug("Child session idle — suppressing", { sessionID, parentID: sessions.get(sessionID)?.parentID })
      return
    }

    if (!config.events.idle.enabled) return

    // Schedule idle debounce — another plugin (or the user) may resume the
    // session within the window, in which case a busy signal fires and
    // cancels this timer.
    cancelIdleDebounce(sessionID)
    const timer = setTimeout(() => {
      idleDebounce.delete(sessionID)
      logger.debug("Idle debounce fired", { sessionID })
      dispatch("idle", data, sessionID, eventDir)
    }, idleDebounceMs)
    idleDebounce.set(sessionID, timer)
    logger.debug("Idle debounce scheduled", { sessionID, ms: idleDebounceMs })
  }

  function markBusy(sessionID: string): void {
    active.add(sessionID)
    errored.delete(sessionID)
    cancelIdleDebounce(sessionID)
  }

  // ---- Event Handler ----
  // V2 event envelope: { id, created, type, data, location?, metadata? }

  function handleEvent(event: any): void {
    const type = event?.type as string
    const data = event?.data ?? {}
    const sessionID: string | undefined = data?.sessionID ?? data?.form?.sessionID
    const eventDir: string | null =
      typeof event?.location?.directory === "string" ? event.location.directory : null

    logger.debug("Event received", { type, sessionID })

    // ---- Track & update the session map (id, parentID, title) ----
    // session.created carries parentID (set for sub-agent sessions) and the
    // (initially default) title; session.renamed delivers title updates.
    if (type === "session.created") {
      if (data?.sessionID) {
        const prev = sessions.get(data.sessionID)
        const loc = data?.location
        const createdDir =
          typeof loc === "string" ? loc : typeof loc?.directory === "string" ? loc.directory : undefined
        sessions.set(data.sessionID, {
          parentID: data.parentID ?? prev?.parentID,
          title: data.title ?? prev?.title,
          directory: createdDir ?? prev?.directory,
        })
        logger.debug("Session tracked", { id: data.sessionID, parentID: data.parentID ?? null, hasTitle: Boolean(data.title), directory: createdDir ?? null })
      }
      return
    }

    if (type === "session.renamed") {
      if (data?.sessionID && typeof data.title === "string") {
        const prev = sessions.get(data.sessionID)
        sessions.set(data.sessionID, {
          parentID: prev?.parentID,
          title: data.title,
          directory: prev?.directory,
        })
        logger.debug("Session renamed", { id: data.sessionID })
      }
      return
    }

    // ---- session.deleted: release all tracking state for this session ----
    if (type === "session.deleted") {
      if (data?.sessionID) {
        sessions.delete(data.sessionID)
        active.delete(data.sessionID)
        errored.delete(data.sessionID)
        cancelIdleDebounce(data.sessionID)
        cancelPermissionDebounce(data.sessionID)
        pending.delete(data.sessionID)
        logger.debug("Session cleaned up", { id: data.sessionID })
      }
      return
    }

    // ---- Ownership gate ----
    // OpenCode V2 boots one plugin instance per active location in a shared
    // server, and every instance receives every event from the global bus.
    // Only the instance whose directory owns the session may act on it;
    // otherwise N locations would emit N duplicate notifications.
    if (!sessionID) return
    if (!sessions.has(sessionID)) sessions.set(sessionID, {})

    // Seed the session's directory from the envelope location (authoritative
    // for events published by the session's own location services).
    if (eventDir) {
      const info = sessions.get(sessionID)!
      if (info.directory === undefined) info.directory = eventDir
    }

    const dir = sessions.get(sessionID)!.directory
    if (dir === undefined) {
      // Directory unknown (this instance booted after session.created was
      // published). Resolve it asynchronously, serialized per session so
      // event order is preserved.
      if (!resolveSessionDir) {
        // Legacy single-instance behavior: assume the session is local.
        processSessionEvent(type, data, sessionID, eventDir)
        return
      }
      const run = async () => {
        const info = sessions.get(sessionID)
        if (!info) return
        let resolved = info.directory
        if (resolved === undefined) {
          try {
            resolved = await resolveSessionDir(sessionID)
          } catch (err) {
            logger.debug("Session directory resolution failed", { sessionID, error: String(err) })
            resolved = null
          }
          const fresh = sessions.get(sessionID)
          if (fresh) fresh.directory = resolved
        }
        if (resolved !== projectDir) {
          logger.debug("Foreign session — skipping", { sessionID, sessionDir: resolved })
          return
        }
        processSessionEvent(type, data, sessionID, eventDir)
      }
      const prev = pending.get(sessionID) ?? Promise.resolve()
      pending.set(sessionID, prev.then(run, run))
      return
    }

    if (dir !== projectDir) {
      logger.debug("Foreign session — skipping", { sessionID, sessionDir: dir })
      return
    }
    processSessionEvent(type, data, sessionID, eventDir)
  }

  // Handles a session-scoped event — only called for sessions this instance
  // owns (see the ownership gate in handleEvent).
  function processSessionEvent(
    type: string,
    data: any,
    sessionID: string | undefined,
    eventDir: string | null,
  ): void {
    // ---- Execution lifecycle: the real busy/idle signal on OpenCode ≤2.0.21 ----
    // session.status/session.idle exist in the schema but have no emitter in
    // 2.0.21 (marked deprecated); emitters were only added after 2.0.21. Drive
    // idle notifications from the execution lifecycle instead:
    //   started    → busy
    //   succeeded  → idle signal (debounced notification)
    //   failed     → error notification (handled below), no idle notification
    //   interrupted → user-initiated stop (user is present) — no notification
    if (type === "session.execution.started") {
      if (sessionID) markBusy(sessionID)
      return
    }

    if (type === "session.execution.succeeded") {
      if (sessionID) handleIdleSignal(sessionID, data, eventDir)
      return
    }

    if (type === "session.execution.interrupted") {
      if (sessionID) {
        active.delete(sessionID)
        cancelIdleDebounce(sessionID)
      }
      return
    }

    // ---- session.status: busy/idle signal on newer OpenCode versions ----
    // (no emitter in 2.0.21; kept for forward compatibility)
    if (type === "session.status") {
      const statusType = data?.status?.type
      if (statusType === "busy" || statusType === "retry") {
        if (sessionID) markBusy(sessionID)
        return
      }
      if (statusType !== "idle") return
      if (sessionID) handleIdleSignal(sessionID, data, eventDir)
      return
    }

    // ---- Permission: debounce, cancelled by any reply (allow OR block) ----
    if (type === "permission.asked") {
      if (!config.events.permission.enabled) return
      // Sub-agent permissions are suppressed — the parent orchestrator handles them.
      if (isChildSession(sessionID)) {
        logger.debug("Child session permission — suppressing", { sessionID })
        return
      }
      // A permission request means the session resumed — cancel any stale idle debounce.
      if (sessionID) cancelIdleDebounce(sessionID)

      const key = sessionID ?? "unknown"
      cancelPermissionDebounce(key)
      const timer = setTimeout(() => {
        permissionDebounce.delete(key)
        logger.debug("Permission debounce fired", { sessionID: key })
        dispatch("permission", data, sessionID, eventDir)
      }, permissionDebounceMs)
      permissionDebounce.set(key, timer)
      logger.debug("Permission debounce scheduled", { sessionID: key, ms: permissionDebounceMs })
      return
    }

    // Any reply (allow once / allow always / reject) cancels the pending
    // permission notification — the user (or an auto-accept) has responded.
    if (type === "permission.replied") {
      if (sessionID) {
        cancelPermissionDebounce(sessionID)
        logger.debug("Permission replied — cancelling debounce", { sessionID })
      }
      return
    }

    // ---- Error: send immediately (and suppress the trailing idle) ----
    if (type === "session.execution.failed") {
      if (!config.events.error.enabled) return
      if (isChildSession(sessionID)) {
        logger.debug("Child session error — suppressing", { sessionID })
        return
      }
      if (sessionID) {
        errored.add(sessionID)
        cancelIdleDebounce(sessionID)
      }
      dispatch("error", data, sessionID, eventDir)
      return
    }

    // ---- Question (form): send immediately (needs user input) ----
    if (type === "form.created") {
      if (!config.events.question.enabled) return
      if (isChildSession(sessionID)) {
        logger.debug("Child session question — suppressing", { sessionID })
        return
      }
      if (sessionID) cancelIdleDebounce(sessionID)
      dispatch("question", data, sessionID, eventDir)
      return
    }
  }

  function cleanup(): void {
    for (const timer of idleDebounce.values()) clearTimeout(timer)
    for (const timer of permissionDebounce.values()) clearTimeout(timer)
    idleDebounce.clear()
    permissionDebounce.clear()
    pending.clear()
    sessions.clear()
    active.clear()
    errored.clear()
  }

  return { handleEvent, cleanup }
}

// ---- Plugin Export ----

export default Plugin.define({
  id: "remote-notifier",
  setup(ctx) {
    const logger = createLogger()
    const config = readConfig(logger)
    if (!config) {
      logger.warn("Config not found/invalid, plugin disabled")
      return
    }

    logger.info("Plugin initialized", {
      server: config.server,
      topicLength: config.topic.length,
      markdown: config.markdown,
      enabledEvents: Object.entries(config.events)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k),
    })

    const notifier = createNotifier(config, logger, ctx.location.directory, {
      // Ownership resolver: looks up which directory a session belongs to
      // when this instance missed session.created (e.g. it booted after the
      // session was created). OpenCode V2 runs one plugin instance per
      // active location; without this, every instance would notify.
      resolveSessionDir: async (sessionID) => {
        try {
          const info = await ctx.session.get({ sessionID })
          return info?.location?.directory ?? null
        } catch {
          return null
        }
      },
    })
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          notifier.handleEvent(event)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          logger.error("Event subscription failed", { error: String(err) })
        }
      }
    })()

    return () => {
      controller.abort()
      notifier.cleanup()
      logger.info("Plugin unloaded")
    }
  },
})
