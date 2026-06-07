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

// ---- Session Title Cache & Pending Notifications ----

const sessionTitles = new Map<string, string>()

interface PendingNotif {
  timer: ReturnType<typeof setTimeout>
  send: () => void
}
const pendingNotifs = new Map<string, PendingNotif>()

// Tracks sub-agent (child) session IDs — idle events from these are suppressed
// since the main orchestrator continues processing (e.g. during ulw loops).
const childSessions = new Set<string>()

// Maps parent session ID → Set of child session IDs.
// Used to defer the parent's idle notification until all children complete.
const childrenByParent = new Map<string, Set<string>>()

// Tracks child sessions that have completed (idle or deleted) to prevent
// re-tracking via late session.updated events that arrive after releaseChild.
const releasedChildSessions = new Set<string>()

// Remove a child session from tracking and fire the parent's deferred idle
// if no children remain. Used by both session.idle (child completes) and
// session.deleted (child removed) events.
function releaseChild(childID: string, logger: Logger): void {
  releasedChildSessions.add(childID)
  logger.debug("releaseChild called", { childID, trackedParents: [...childrenByParent.keys()] })
  for (const [parentID, children] of childrenByParent.entries()) {
    if (children.has(childID)) {
      children.delete(childID)
      logger.debug("Child session released", { childID, parentID, remaining: children.size })
      if (children.size === 0) {
        childrenByParent.delete(parentID)
        const deferred = deferredIdleByParent.get(parentID)
        if (deferred) {
          // WARNING: Do NOT add setTimeout here. The deferred idle was stored when
          // the parent went idle waiting for children. Now that children are done,
          // the parent is still idle from the user's perspective — fire immediately.
          // Using setTimeout would risk losing the notification to session.status(busy)
          // (from parent resuming), and arbitrary delays can't account for variable
          // sub-agent run times.
          deferredIdleByParent.delete(parentID)
          logger.debug("Deferred idle firing after children complete", { parentID })
          deferred.send()
        } else {
          logger.debug("releaseChild: no deferred idle found for parent", { parentID })
        }
      }
      return
    } else {
      logger.debug("releaseChild: child not in this parent's set", { childID, parentID, children: [...children] })
    }
  }
  logger.debug("releaseChild: child not found in any parent", { childID })
}

// Deferred idle notifications waiting for child sessions to finish.
// When a parent goes idle with active children, the send is stored here
// and released when all children complete.
interface DeferredIdle {
  send: () => void
}
const deferredIdleByParent = new Map<string, DeferredIdle>()

// ---- Idle Notification Debounce ----
// When a session.idle event fires, wait 10s before sending the notification.
// If any non-idle event arrives for the same session within that window, another
// plugin may have continued the session, so the idle notification is cancelled.

interface IdleDebounce {
  timer: ReturnType<typeof setTimeout>
  send: () => void
}
const idleDebounceSend = new Map<string, IdleDebounce>()

function debounceIdleSend(sessionID: string, send: () => void, logger: Logger): void {
  const existing = idleDebounceSend.get(sessionID)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    idleDebounceSend.delete(sessionID)
    logger.debug("Idle debounce fired", { sessionID })
    send()
  }, 10000)

  idleDebounceSend.set(sessionID, { timer, send })
  logger.debug("Idle debounce set", { sessionID })
}

function cancelIdleDebounce(sessionID: string, logger: Logger): void {
  const existing = idleDebounceSend.get(sessionID)
  if (existing) {
    clearTimeout(existing.timer)
    idleDebounceSend.delete(sessionID)
    logger.debug("Idle debounce cancelled", { sessionID })
  }
}

// ---- Event Handler ----

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

function buildMessage(config: Config, type: EventType, payload: any, sessionTitle?: string | null): { title: string; message: string } {
  const baseTitle = EVENT_TITLES[type]
  // Skip auto-generated default titles (e.g. "New session - 2026-...")
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
      const perm = typeof payload?.permission === "string" ? payload.permission : "unknown"
      const patterns = Array.isArray(payload?.patterns) ? payload.patterns.join(", ") : payload?.filePath ?? "unknown"
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

function handleEvent(
  config: Config,
  limiter: RateLimiter,
  projectDir: string,
  event: any,
  logger: Logger,
) {
  const type = event.type as string
  const data = event?.properties ?? event?.payload ?? {}

  logger.debug("Event received", { type, sessionID: data?.sessionID ?? data?.info?.id })

  // Cancel pending idle debounce ONLY for events that explicitly indicate the session
  // has resumed. The idle transition batch-fires informational events (session.updated,
  // session.diff, message.updated, message.part.updated) within milliseconds of the
  // idle event, but none of those mean the session is active again — they're just
  // metadata cleanup. Only session.status(busy), errors, questions, and permissions
  // are genuine signals that the session is no longer idle.
  const cancelSessionID = data?.sessionID ?? data?.info?.id
  const isSessionResumed =
    (type === "session.status" && data?.status?.type === "busy") ||
    type === "session.error" ||
    type === "question.asked" ||
    type === "permission.asked"
  if (type === "session.status") {
    logger.debug("session.status event", { sessionID: cancelSessionID, statusType: data?.status?.type, isIdleDebouncePending: cancelSessionID ? idleDebounceSend.has(cancelSessionID) : null })
  }
  if (cancelSessionID && isSessionResumed) {
    cancelIdleDebounce(cancelSessionID, logger)
  }

  // Track child (sub-agent) sessions so we can suppress their idle events
  if (type === "session.created" || type === "session.updated") {
    const info = data?.info
    if (info?.id && info?.parentID) {
      // Skip if this child was already released (completed idle/deleted) — late
      // session.updated events arrive after releaseChild and would re-trap the
      // parent's deferred idle with a child that will never complete again.
      if (!releasedChildSessions.has(info.id)) {
        childSessions.add(info.id)
        if (!childrenByParent.has(info.parentID)) {
          childrenByParent.set(info.parentID, new Set())
        }
        childrenByParent.get(info.parentID)!.add(info.id)
        logger.debug("Child session tracked", { childID: info.id, parentID: info.parentID })
      }
    }
  }

  // Cache session title from session.updated events
  if (type === "session.updated") {
    const sessionID = data?.sessionID ?? data?.info?.id
    const title = data?.info?.title
    if (sessionID && title) {
      sessionTitles.set(sessionID, title)
      logger.debug("Session title cached", { sessionID, title })
      // If a real title arrived, flush any pending notification immediately
      if (!isDefaultTitle(title)) {
        const pending = pendingNotifs.get(sessionID)
        if (pending) {
          clearTimeout(pending.timer)
          pendingNotifs.delete(sessionID)
          pending.send()
        }
      }
    }
    return
  }

  // session.deleted — clean up child tracking; if no more children for a parent,
  // release any deferred idle notification for that parent
  if (type === "session.deleted") {
    const deletedID = data?.sessionID ?? data?.info?.id
    logger.debug("session.deleted received", { deletedID, inChildSessions: deletedID ? childSessions.has(deletedID) : null })
    if (deletedID) {
      childSessions.delete(deletedID)
      releaseChild(deletedID, logger)
    }
    return
  }

  // session.created doesn't fire notifications — handled above for parentID tracking
  if (type === "session.created") return

  let eventType: EventType | null = null

  if (type === "session.error") eventType = "error"
  else if (type === "permission.asked") eventType = "permission"
  else if (type === "question.asked") eventType = "question"
  else if (type === "session.idle") eventType = "idle"
  else return

  const eventCfg = config.events[eventType]
  if (!eventCfg.enabled) {
    logger.debug("Event type disabled, skipping", { eventType })
    return
  }

  const sessionID = data?.sessionID
  logger.debug("Event mapped to notification", { eventType, sessionID })

  // Suppress idle notifications from sub-agent sessions — main orchestrator continues
  // Also treat child idle as completion: may release parent's deferred idle
  if (eventType === "idle" && sessionID) {
    if (childSessions.has(sessionID)) {
      logger.debug("Child session idle — releasing", { sessionID })
      releaseChild(sessionID, logger)
      return
    } else {
      logger.debug("Session idle — not a tracked child", { sessionID, childSessionsSize: childSessions.size })
    }
  }
  const dedupKey = `${eventType}:${sessionID ?? "unknown"}`

  // Idle events skip the per-session dedup — sessions naturally go idle multiple
  // times. The global rate limit (maxPerMinute) still applies.
  if (!limiter.allow(dedupKey, eventType === "idle")) return

  const doSend = () => {
    const sessionTitle = sessionID ? sessionTitles.get(sessionID) : null
    let project = data?.project?.name ?? path.basename(projectDir)

    const { title, message } = buildMessage(config, eventType, { ...data, project: { name: project } }, sessionTitle)

    logger.info("Sending notification", { type: eventType, title, priority: eventCfg.priority })

    sendNotification({
      server: config.server,
      topic: config.topic,
      token: config.token,
      markdown: config.markdown,
      title,
      message,
      priority: eventCfg.priority,
      tags: EVENT_TAGS[eventType],
    }, logger)
  }

  // ---- Idle debounce: wait 500ms — other plugins may continue the session ----
  if (eventType === "idle" && sessionID) {
    // Parent with active children: defer until children complete. Children may run
    // tool calls or sub-agents while the parent is idle — the notification fires
    // when the last child completes (via a non-cancellable delay in releaseChild).
    const activeChildren = childrenByParent.get(sessionID)
    if (activeChildren && activeChildren.size > 0) {
      if (!deferredIdleByParent.has(sessionID)) {
        deferredIdleByParent.set(sessionID, { send: doSend })
        logger.debug("Parent idle deferred — children active", { sessionID, children: [...activeChildren] })
      } else {
        logger.debug("Parent idle already deferred", { sessionID })
      }
      return
    }

    // 10s debounce: if any event arrives before this fires, the idle notification
    // is cancelled (another plugin continued the session).
    debounceIdleSend(sessionID, () => {
      const cachedTitle = sessionTitles.get(sessionID) ?? null

      if (cachedTitle && !isDefaultTitle(cachedTitle)) {
        doSend()
        return
      }

      // Default/no title — wait up to 10s for session.updated, then send
      logger.debug("Waiting for session title", { sessionID, waitMs: 10000 })
      const timer = setTimeout(() => {
        pendingNotifs.delete(sessionID)
        doSend()
      }, 10000)
      pendingNotifs.set(sessionID, { timer, send: doSend })
    }, logger)
    return
  }

  // Non-idle events, or idle events without a sessionID — send directly
  const cachedTitle = sessionID ? sessionTitles.get(sessionID) : null

  if (cachedTitle && !isDefaultTitle(cachedTitle)) {
    doSend()
    return
  }

  // Default/no title — wait up to 10s for session.updated, then send
  const timer = setTimeout(() => {
    if (sessionID) pendingNotifs.delete(sessionID)
    doSend()
  }, 10000)
  if (sessionID) {
    pendingNotifs.set(sessionID, { timer, send: doSend })
  } else {
    doSend()
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
