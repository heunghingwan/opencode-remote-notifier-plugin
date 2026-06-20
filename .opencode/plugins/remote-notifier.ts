import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

// ---- Logger ----

type LoggerLevel = "debug" | "info" | "warn" | "error"

interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

function createLogger(client: any): Logger {
  const log = (level: LoggerLevel, message: string, extra?: Record<string, unknown>) => {
    client.app.log({
      body: { service: "remote-notifier", level, message, extra },
    }).catch(() => {})
  }
  return {
    debug: (msg, extra) => log("info", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  }
}

// ---- Types ----

type EventType = "error" | "permission" | "question" | "idle"

interface EventConfig {
  enabled: boolean
  priority: number
}

interface Config {
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

function readConfig(logger: Logger): Config | null {
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

class RateLimiter {
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

interface NotifyPayload {
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
// used by opencode's built-in TUI notifications plugin and CodeNomad's UI.
// The OpenCode core guarantees parent idle fires after foreground children
// finish, so we do NOT implement our own parent/child join — we simply suppress
// any session whose parentID is set (sub-agent sessions never notify).

interface SessionInfo {
  parentID?: string
  title?: string
}

const sessions = new Map<string, SessionInfo>()
// Sessions that were busy/retry before going idle. Suppresses no-op idles fired
// for sessions that were never active (e.g. freshly-created children, or the
// idle emitted after a cancel with no prior busy).
const active = new Set<string>()
// Sessions that errored. Suppresses the trailing idle that follows an error so
// the user gets one notification, not two.
const errored = new Set<string>()

interface Debounce {
  timer: ReturnType<typeof setTimeout>
  send: () => void
}

const idleDebounce = new Map<string, Debounce>()
const permissionDebounce = new Map<string, Debounce>()

function cancelIdleDebounce(sessionID: string): void {
  const d = idleDebounce.get(sessionID)
  if (d) {
    clearTimeout(d.timer)
    idleDebounce.delete(sessionID)
  }
}

function cancelPermissionDebounce(sessionID: string): void {
  const d = permissionDebounce.get(sessionID)
  if (d) {
    clearTimeout(d.timer)
    permissionDebounce.delete(sessionID)
  }
}

function cleanupSession(sessionID: string): void {
  sessions.delete(sessionID)
  active.delete(sessionID)
  errored.delete(sessionID)
  cancelIdleDebounce(sessionID)
  cancelPermissionDebounce(sessionID)
}

function isChildSession(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  return Boolean(sessions.get(sessionID)?.parentID)
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

// Reads both v1 (permission/patterns/filePath) and v2 (action/resources) payload
// shapes so the plugin works across opencode versions.
function buildMessage(config: Config, type: EventType, payload: any, sessionTitle?: string | null): { title: string; message: string } {
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
      const text = (payload?.questions?.[0]?.question ?? "user input needed").slice(0, 80)
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

function dispatch(
  config: Config,
  limiter: RateLimiter,
  projectDir: string,
  eventType: EventType,
  data: any,
  sessionID: string | undefined,
  logger: Logger,
): void {
  const dedupKey = `${eventType}:${sessionID ?? "unknown"}`
  // idle naturally dedups via the active set; other events use per-key dedup.
  if (!limiter.allow(dedupKey, eventType === "idle")) return

  const sessionTitle = sessionID ? sessions.get(sessionID)?.title ?? null : null
  const project = data?.project?.name ?? path.basename(projectDir)
  const { title, message } = buildMessage(config, eventType, { ...data, project: { name: project } }, sessionTitle)

  logger.info("Sending notification", { type: eventType, title, priority: config.events[eventType].priority })

  sendNotification({
    server: config.server,
    topic: config.topic,
    token: config.token,
    markdown: config.markdown,
    title,
    message,
    priority: config.events[eventType].priority,
    tags: EVENT_TAGS[eventType],
  }, logger)
}

// ---- Event Handler ----

function handleEvent(
  config: Config,
  limiter: RateLimiter,
  projectDir: string,
  event: any,
  logger: Logger,
): void {
  const type = event.type as string
  const data = event?.properties ?? event?.payload ?? {}
  const sessionID: string | undefined = data?.sessionID ?? data?.info?.id

  logger.debug("Event received", { type, sessionID })

  // ---- Build & update the session map (id, parentID, title) ----
  // session.created and session.updated both carry the full Session record
  // under properties.info, including parentID (set for sub-agent sessions).
  if (type === "session.created" || type === "session.updated") {
    const info = data?.info
    if (info?.id) {
      const prev = sessions.get(info.id)
      sessions.set(info.id, {
        parentID: info.parentID ?? prev?.parentID,
        title: info.title ?? prev?.title,
      })
      logger.debug("Session tracked", { id: info.id, parentID: info.parentID ?? null, hasTitle: Boolean(info.title) })
    }
    return
  }

  // ---- session.deleted: release all tracking state for this session ----
  if (type === "session.deleted") {
    const id = sessionID ?? data?.info?.id
    if (id) {
      cleanupSession(id)
      logger.debug("Session cleaned up", { id })
    }
    return
  }

  // ---- session.status: the modern idle/busy signal (session.idle is deprecated) ----
  // On busy/retry we mark the session active and cancel any pending idle
  // debounce (the session resumed). On idle we run the mature suppress checks
  // (no prior busy / trailing idle after error / sub-agent child) then schedule
  // the idle debounce.
  if (type === "session.status") {
    const statusType = data?.status?.type
    if (statusType === "busy" || statusType === "retry") {
      if (sessionID) {
        active.add(sessionID)
        errored.delete(sessionID)
        cancelIdleDebounce(sessionID)
      }
      return
    }
    if (statusType !== "idle") return
    if (!sessionID) return

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
    // session within the window, in which case session.status busy fires and
    // cancels this timer.
    const existing = idleDebounce.get(sessionID)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      idleDebounce.delete(sessionID)
      logger.debug("Idle debounce fired", { sessionID })
      dispatch(config, limiter, projectDir, "idle", data, sessionID, logger)
    }, IDLE_DEBOUNCE_MS)
    idleDebounce.set(sessionID, {
      timer,
      send: () => dispatch(config, limiter, projectDir, "idle", data, sessionID, logger),
    })
    logger.debug("Idle debounce scheduled", { sessionID, ms: IDLE_DEBOUNCE_MS })
    return
  }

  // ---- Permission: debounce, cancelled by any reply (allow OR block) ----
  // Listen to BOTH v1 (permission.asked) and v2 (permission.v2.asked) for
  // cross-version stability. Same for the reply events.
  if (type === "permission.asked" || type === "permission.v2.asked") {
    if (!config.events.permission.enabled) return
    // Sub-agent permissions are suppressed — the parent orchestrator handles them.
    if (isChildSession(sessionID)) {
      logger.debug("Child session permission — suppressing", { sessionID })
      return
    }
    // A permission request means the session resumed — cancel any stale idle debounce.
    if (sessionID) cancelIdleDebounce(sessionID)

    const key = sessionID ?? "unknown"
    const existing = permissionDebounce.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      permissionDebounce.delete(key)
      logger.debug("Permission debounce fired", { sessionID: key })
      dispatch(config, limiter, projectDir, "permission", data, sessionID, logger)
    }, PERMISSION_DEBOUNCE_MS)
    permissionDebounce.set(key, {
      timer,
      send: () => dispatch(config, limiter, projectDir, "permission", data, sessionID, logger),
    })
    logger.debug("Permission debounce scheduled", { sessionID: key, ms: PERMISSION_DEBOUNCE_MS })
    return
  }

  // Any reply (allow once / allow always / reject) cancels the pending
  // permission notification — the user (or an auto-accept) has responded.
  if (type === "permission.replied" || type === "permission.v2.replied") {
    if (sessionID) {
      cancelPermissionDebounce(sessionID)
      logger.debug("Permission replied — cancelling debounce", { sessionID })
    }
    return
  }

  // ---- Error: send immediately (and suppress the trailing idle) ----
  if (type === "session.error") {
    if (!config.events.error.enabled) return
    if (isChildSession(sessionID)) {
      logger.debug("Child session error — suppressing", { sessionID })
      return
    }
    if (sessionID) {
      errored.add(sessionID)
      cancelIdleDebounce(sessionID)
    }
    dispatch(config, limiter, projectDir, "error", data, sessionID, logger)
    return
  }

  // ---- Question: send immediately (needs user input) ----
  if (type === "question.asked" || type === "question.v2.asked") {
    if (!config.events.question.enabled) return
    if (isChildSession(sessionID)) {
      logger.debug("Child session question — suppressing", { sessionID })
      return
    }
    if (sessionID) cancelIdleDebounce(sessionID)
    dispatch(config, limiter, projectDir, "question", data, sessionID, logger)
    return
  }
}

// ---- Plugin Export ----

export const RemoteNotifier: Plugin = async ({ client, directory }) => {
  const logger = createLogger(client)
  const config = readConfig(logger)
  if (!config) {
    logger.warn("Config not found/invalid, plugin disabled")
    return {}
  }

  logger.info("Plugin initialized", {
    server: config.server,
    topicLength: config.topic.length,
    markdown: config.markdown,
    enabledEvents: Object.entries(config.events)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k),
  })

  const limiter = new RateLimiter(
    config.rateLimit.dedupWindowSec,
    config.rateLimit.maxPerMinute,
    logger,
  )

  return {
    event: async ({ event }) => {
      handleEvent(config, limiter, directory, event, logger)
    },
  }
}
