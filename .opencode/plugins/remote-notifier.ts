import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

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

function readConfig(): Config | null {
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
    console.error("[remote-notifier] config error:", err.message)
    return null
  }
}

// ---- Rate Limiter ----

class RateLimiter {
  #dedup = new Map<string, number>()
  #timestamps: number[] = []
  #dedupWindow: number
  #maxPerMinute: number

  constructor(dedupWindowSec: number, maxPerMinute: number) {
    this.#dedupWindow = dedupWindowSec * 1000
    this.#maxPerMinute = maxPerMinute
  }

  allow(key: string): boolean {
    const now = Date.now()

    const lastSent = this.#dedup.get(key)
    if (lastSent !== undefined && now - lastSent < this.#dedupWindow) {
      return false
    }

    this.#timestamps = this.#timestamps.filter((t) => now - t < 60_000)
    if (this.#timestamps.length >= this.#maxPerMinute) {
      return false
    }

    this.#dedup.set(key, now)
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

async function sendNotification(payload: NotifyPayload): Promise<void> {
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
      if (res.ok) return
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000))
      } else {
        console.warn("[remote-notifier] HTTP send failed after 3 retries, status:", res.status)
      }
    } catch (err: any) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000))
      } else {
        console.warn("[remote-notifier] HTTP send failed after 3 retries:", err?.message ?? err)
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

// Remove a child session from tracking and release the parent's deferred idle
// if no children remain. Used by both session.idle (child completes) and
// session.deleted (child removed) events.
function releaseChild(childID: string): void {
  childSessions.delete(childID)
  for (const [parentID, children] of childrenByParent.entries()) {
    if (children.has(childID)) {
      children.delete(childID)
      if (children.size === 0) {
        childrenByParent.delete(parentID)
        const deferred = deferredIdleByParent.get(parentID)
        if (deferred) {
          deferredIdleByParent.delete(parentID)
          deferred.send()
        }
      }
      break
    }
  }
}

// Deferred idle notifications waiting for child sessions to finish.
// When a parent goes idle with active children, the send is deferred here.
const deferredIdleByParent = new Map<string, { send: () => void }>()

// ---- Idle Notification Debounce ----
// When a session.idle event fires, wait 500ms before sending the notification.
// If any non-idle event arrives for the same session within that window, another
// plugin may have continued the session, so the idle notification is cancelled.

interface IdleDebounce {
  timer: ReturnType<typeof setTimeout>
  send: () => void
}
const idleDebounceSend = new Map<string, IdleDebounce>()

function debounceIdleSend(sessionID: string, send: () => void): void {
  const existing = idleDebounceSend.get(sessionID)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    idleDebounceSend.delete(sessionID)
    send()
  }, 500)

  idleDebounceSend.set(sessionID, { timer, send })
}

function cancelIdleDebounce(sessionID: string): void {
  const existing = idleDebounceSend.get(sessionID)
  if (existing) {
    clearTimeout(existing.timer)
    idleDebounceSend.delete(sessionID)
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
) {
  const type = event.type as string
  const data = event?.properties ?? event?.payload ?? {}

  // Cancel pending idle debounce if any non-idle event arrives — another plugin may
  // have continued the session, so it's no longer idle.
  const cancelSessionID = data?.sessionID ?? data?.info?.id
  if (cancelSessionID && type !== "session.idle") {
    cancelIdleDebounce(cancelSessionID)
  }

  // Track child (sub-agent) sessions so we can suppress their idle events
  if (type === "session.created" || type === "session.updated") {
    const info = data?.info
    if (info?.id && info?.parentID) {
      childSessions.add(info.id)
      // Track by parent so we can defer the parent's idle notification
      if (!childrenByParent.has(info.parentID)) {
        childrenByParent.set(info.parentID, new Set())
      }
      childrenByParent.get(info.parentID)!.add(info.id)
    }
  }

  // Cache session title from session.updated events
  if (type === "session.updated") {
    const sessionID = data?.sessionID ?? data?.info?.id
    const title = data?.info?.title
    if (sessionID && title) {
      sessionTitles.set(sessionID, title)
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
    if (deletedID) releaseChild(deletedID)
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
  if (!eventCfg.enabled) return

  const sessionID = data?.sessionID

  // Suppress idle notifications from sub-agent sessions — main orchestrator continues
  // Also treat child idle as completion: may release parent's deferred idle
  if (eventType === "idle" && sessionID && childSessions.has(sessionID)) {
    releaseChild(sessionID)
    return
  }
  const dedupKey = `${eventType}:${sessionID ?? "unknown"}`

  if (!limiter.allow(dedupKey)) return

  const doSend = () => {
    const sessionTitle = sessionID ? sessionTitles.get(sessionID) : null
    let project = data?.project?.name ?? path.basename(projectDir)

    const { title, message } = buildMessage(config, eventType, { ...data, project: { name: project } }, sessionTitle)

    sendNotification({
      server: config.server,
      topic: config.topic,
      token: config.token,
      markdown: config.markdown,
      title,
      message,
      priority: eventCfg.priority,
      tags: EVENT_TAGS[eventType],
    })
  }

  // ---- Idle debounce: wait 500ms — other plugins may continue the session ----
  if (eventType === "idle" && sessionID) {
    // Parent with active children: defer until children complete, then debounce
    const activeChildren = childrenByParent.get(sessionID)
    if (activeChildren && activeChildren.size > 0) {
      if (!deferredIdleByParent.has(sessionID)) {
        deferredIdleByParent.set(sessionID, { send: () => debounceIdleSend(sessionID, doSend) })
      }
      return
    }

    // 500ms debounce: if any event arrives before this fires, the idle notification
    // is cancelled (another plugin continued the session).
    debounceIdleSend(sessionID, () => {
      const cachedTitle = sessionTitles.get(sessionID) ?? null

      if (cachedTitle && !isDefaultTitle(cachedTitle)) {
        doSend()
        return
      }

      // Default/no title — wait up to 10s for session.updated, then send
      const timer = setTimeout(() => {
        pendingNotifs.delete(sessionID)
        doSend()
      }, 10000)
      pendingNotifs.set(sessionID, { timer, send: doSend })
    })
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

export const RemoteNotifier: Plugin = async (input) => {
  const config = readConfig()
  if (!config) {
    console.warn("[remote-notifier] config not found or invalid, plugin disabled")
    return {}
  }

  const limiter = new RateLimiter(
    config.rateLimit.dedupWindowSec,
    config.rateLimit.maxPerMinute,
  )

  return {
    event: async ({ event }) => {
      handleEvent(config, limiter, input.directory, event)
    },
  }
}
