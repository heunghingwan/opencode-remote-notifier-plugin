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

// Cap for remembered exits of never-registered shells (see recentShellExits
// in createNotifier). Defensive bound only — shell ids are unique.
const RECENT_SHELL_EXIT_CAP = 64

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
// used by opencode's built-in TUI notifications plugin. Sub-agent sessions
// (parentID set) never notify themselves, and a parent's idle signal is
// suppressed while any of its children is still active: when the parent hands
// off to a sub-agent its execution ends and an idle fires, but that idle is a
// tool-call handoff, not genuine idleness. The parent re-busies when the
// child's result returns; its eventual genuine idle notifies then.

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

// One emoji per event type is the whole title prefix — phone notification
// bars truncate early, so "opencode"/type words are deliberately omitted.
// ntfy tag emojis are not sent: the in-title emoji is the single icon.
const EVENT_EMOJI: Record<EventType, string> = {
  error:      "🚨",
  permission: "🔐",
  question:   "❓",
  idle:       "💤",
}

// Fallback label used only when the session's real title is unknown.
const EVENT_LABELS: Record<EventType, string> = {
  error:      "Error",
  permission: "Permission",
  question:   "Question",
  idle:       "Idle",
}

function isDefaultTitle(title: string): boolean {
  return /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(title)
}

// First meaningful line of a text block, collapsed and length-capped for
// notification previews (phone notification bars show little).
const SNIPPET_MAX = 140

function firstLineSnippet(text: unknown): string {
  if (typeof text !== "string") return ""
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ""
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : line
}

// Question forms from the question tool carry the constant title "Questions";
// the real content is the fields: title (header), description (question text),
// options (choices). Other form sources may only have a real title.
function questionLines(form: any): { lines: string; options: string } {
  const fields: any[] = Array.isArray(form?.fields) ? form.fields : []
  const lines = fields
    .map((f) => {
      const header = typeof f?.title === "string" ? f.title.trim() : ""
      const text = firstLineSnippet(f?.description)
      if (header && text) return `**${header}** — ${text}`
      return header || text
    })
    .filter(Boolean)
  const options = fields
    .flatMap((f) => (Array.isArray(f?.options) ? f.options : []))
    .map((o) => (typeof o?.label === "string" ? o.label : ""))
    .filter(Boolean)
    .slice(0, 6)
    .map((label) => `\`${label}\``)
    .join(" · ")
  if (lines.length > 0) return { lines: lines.join("\n> "), options }
  const title = firstLineSnippet(form?.title)
  return { lines: title || "user input needed", options }
}

// V2 payload shapes (see @opencode/plugin 2.x event schemas):
//   error      session.execution.failed  data.{sessionID, error.message}
//   permission permission.asked          data.{sessionID, action, resources}
//   question   form.created              data.form.{sessionID, title}
//   idle       session.status            data.{sessionID, status.type}
// dispatch() injects project.name (directory basename) and lastText (the
// finished turn's last assistant text, tracked from session.text.ended).
export function buildMessage(config: Config, type: EventType, payload: any, sessionTitle?: string | null): { title: string; message: string } {
  const emoji = EVENT_EMOJI[type]
  const effectiveTitle = sessionTitle && !isDefaultTitle(sessionTitle) ? sessionTitle : EVENT_LABELS[type]
  const title = `${emoji} ${effectiveTitle}`
  const md = config.markdown

  switch (type) {
    case "error": {
      const errMsg = (payload?.error?.message ?? "unknown error").slice(0, 200)
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n\`\`\`\n${errMsg}\n\`\`\``
          : `[${project}] ${errMsg}`,
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
          ? `${prefix}\n\n\`${perm}\` on \`${patterns}\``
          : `[${project}] ${perm} on ${patterns}`,
      }
    }
    case "question": {
      const { lines, options } = questionLines(payload?.form)
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n> ${lines}${options ? `\n\n${options}` : ""}`
          : `[${project}] ${lines.replace(/\*\*/g, "")}${options ? ` (${options.replace(/`/g, "").replaceAll(" · ", ", ")})` : ""}`,
      }
    }
    case "idle": {
      const snippet = firstLineSnippet(payload?.lastText)
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n${snippet ? `> ${snippet}` : "Session waiting for input"}`
          : `[${project}] ${snippet || "session waiting for input"}`,
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
   * Fetches a session's location directory and title from the session API.
   * Used when they weren't learned from events: the directory when this
   * instance booted after session.created, and the title when session.renamed
   * already fired before the instance subscribed (OpenCode publishes it
   * exactly once). Production wiring uses ctx.session.get. Without it,
   * sessions of unknown directory are treated as local (legacy
   * single-instance behavior) and unknown titles fall back to the event label.
   */
  resolveSession?: (sessionID: string) => Promise<{ directory: string | null; title?: string | null } | null>
}

export function createNotifier(config: Config, logger: Logger, projectDir: string, deps: NotifierDeps = {}) {
  const send = deps.sender ?? ((payload: NotifyPayload) => sendNotification(payload, logger))
  const idleDebounceMs = deps.idleDebounceMs ?? IDLE_DEBOUNCE_MS
  const permissionDebounceMs = deps.permissionDebounceMs ?? PERMISSION_DEBOUNCE_MS
  const resolveSession = deps.resolveSession
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
  // In-flight session API lookups backing ensureTitle, deduped per session.
  const sessionFetches = new Map<string, Promise<void>>()
  // Last assistant text of the turn in flight, per session (from
  // session.text.ended). Cleared when a new execution starts so idle
  // notifications preview only the turn that just finished.
  const lastText = new Map<string, string>()
  // Background-shell tracking spans two event domains: session.tool.called
  // (input.background) identifies the background call, but only
  // session.tool.progress/success carry the shellID, and the later
  // shell.exited/deleted events carry no sessionID at all — so the id
  // correlation has to live here as shellID → sessionID.
  const bgToolCalls = new Map<string, string>()
  const backgroundShells = new Map<string, string>()
  // Exits seen for shells this instance never registered. Registration is
  // deferred behind the async directory fetch, so an exit can land first —
  // without this, the queued registration would resurrect a dead shell and
  // wedge suppression until session.deleted. Size-capped; shell ids are
  // unique per server, so stale entries only ever skip a dead id.
  const recentShellExits = new Map<string, string>()

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

  // True while any sub-agent child of this session is still executing. Used
  // to suppress the parent's idle notification: when the parent hands off to
  // a sub-agent, the parent's execution ends and an idle signal fires even
  // though the family is still working.
  function hasActiveChild(parentID: string): boolean {
    for (const id of active) {
      if (sessions.get(id)?.parentID === parentID) return true
    }
    return false
  }

  // True if candidateID sits anywhere below ancestorID in the sub-agent
  // tree (candidate itself, a child, or a nested child). Guarded against
  // parentID cycles.
  function isDescendantOf(candidateID: string, ancestorID: string): boolean {
    const seen = new Set<string>()
    let current: string | undefined = candidateID
    while (current !== undefined && !seen.has(current)) {
      if (current === ancestorID) return true
      seen.add(current)
      current = sessions.get(current)?.parentID
    }
    return false
  }

  // True while a background shell owned by this session (or one of its
  // sub-agent descendants — OpenCode's own job semantics include background
  // jobs owned by child and nested subagent sessions) is still pending. When
  // the agent starts a background shell and ends its turn, the shell's exit
  // wakes it via a synthetic message, so this idle is a wait, not genuine
  // idleness.
  function hasPendingBackgroundShell(sessionID: string): boolean {
    for (const owner of backgroundShells.values()) {
      if (isDescendantOf(owner, sessionID)) return true
    }
    return false
  }

  // Backfills the session's title (and directory, when unknown) from the
  // session API. session.renamed fires exactly once per session — if this
  // instance subscribed after that (server restart, plugin reload, late
  // location activation), the API is the only way to ever learn the title.
  // Dedups in-flight per session; a session.renamed arriving during a fetch
  // always wins (the merge only fills unknown titles).
  function ensureTitle(sessionID: string): Promise<void> {
    const info = sessions.get(sessionID)
    if (!info || info.title !== undefined || !resolveSession) return Promise.resolve()
    let fetch = sessionFetches.get(sessionID)
    if (!fetch) {
      fetch = (async () => {
        try {
          const fetched = await resolveSession(sessionID)
          const fresh = sessions.get(sessionID)
          if (!fetched || !fresh) return
          if (fresh.directory === undefined && fetched.directory) {
            fresh.directory = fetched.directory
          }
          if (fresh.title == null && fetched.title && !isDefaultTitle(fetched.title)) {
            fresh.title = fetched.title
            logger.debug("Session title backfilled", { sessionID })
          }
        } catch (err) {
          logger.debug("Session title resolution failed", { sessionID, error: String(err) })
        } finally {
          sessionFetches.delete(sessionID)
        }
      })()
      sessionFetches.set(sessionID, fetch)
    }
    return fetch
  }

  // Dispatch that first backfills an unknown session title, so notifications
  // carry the real conversation title even when session.renamed was missed.
  // Stays synchronous when there is nothing to fetch (no resolver, unknown
  // session, or title already learned) to preserve immediate delivery.
  function dispatchWithTitle(
    eventType: EventType,
    data: any,
    sessionID: string | undefined,
    eventDir: string | null,
  ): void {
    const info = sessionID ? sessions.get(sessionID) : undefined
    if (!sessionID || !info || info.title !== undefined || !resolveSession) {
      dispatch(eventType, data, sessionID, eventDir)
      return
    }
    void ensureTitle(sessionID).then(() => dispatch(eventType, data, sessionID, eventDir))
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
    const extra = eventType === "idle" && sessionID
      ? { lastText: lastText.get(sessionID) }
      : {}
    const { title, message } = buildMessage(config, eventType, { ...data, project: { name: project }, ...extra }, sessionTitle)

    logger.info("Sending notification", { type: eventType, title, priority: config.events[eventType].priority })

    void send({
      server: config.server,
      topic: config.topic,
      token: config.token,
      markdown: config.markdown,
      title,
      message,
      priority: config.events[eventType].priority,
      // The title already carries the single event emoji; ntfy tag emojis
      // would only duplicate it in the notification row.
      tags: [],
    })
  }

  // Shared idle-signal handling. Called from both session.status idle and
  // session.execution.succeeded (the real signal on OpenCode ≤2.0.21, where
  // session.status has no emitter). Runs the mature suppress checks (no prior
  // busy / trailing idle after error / sub-agent child / parent with an active
  // child) then schedules the idle debounce.
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

    // Suppress the parent's idle while a sub-agent child is still working —
    // this idle is the tool-call handoff, not genuine idleness. The parent
    // re-busies when the child's result returns.
    if (hasActiveChild(sessionID)) {
      logger.debug("Parent idle while child active — suppressing", { sessionID })
      return
    }

    // Suppress idle while a background shell the session is waiting on is
    // still pending — the shell's exit wakes it (synthetic message), so this
    // idle is a wait, not genuine idleness.
    if (hasPendingBackgroundShell(sessionID)) {
      logger.debug("Idle with background shell pending — suppressing", { sessionID })
      return
    }

    if (!config.events.idle.enabled) return

    // Schedule idle debounce — another plugin (or the user) may resume the
    // session within the window, in which case a busy signal fires and
    // cancels this timer.
    cancelIdleDebounce(sessionID)
    const timer = setTimeout(() => {
      idleDebounce.delete(sessionID)
      // Re-check at fire time: a sub-agent may have started between the idle
      // signal and now (cross-session event ordering is not guaranteed).
      if (hasActiveChild(sessionID)) {
        logger.debug("Idle debounce fired with child active — suppressing", { sessionID })
        return
      }
      // Same race for background shells: the shell tool events may land
      // after the idle signal but before the debounce fires.
      if (hasPendingBackgroundShell(sessionID)) {
        logger.debug("Idle debounce fired with background shell pending — suppressing", { sessionID })
        return
      }
      logger.debug("Idle debounce fired", { sessionID })
      dispatchWithTitle("idle", data, sessionID, eventDir)
    }, idleDebounceMs)
    idleDebounce.set(sessionID, timer)
    logger.debug("Idle debounce scheduled", { sessionID, ms: idleDebounceMs })
  }

  function markBusy(sessionID: string): void {
    active.add(sessionID)
    errored.delete(sessionID)
    cancelIdleDebounce(sessionID)
    // A new turn started: the previous turn's text preview is stale.
    lastText.delete(sessionID)
    // A child going busy means the parent's pending idle signal was a
    // sub-agent handoff, not genuine idleness — cancel the parent's idle
    // notification. Covers the race where the child's execution starts after
    // the parent's idle signal but before its debounce fires.
    const parentID = sessions.get(sessionID)?.parentID
    if (parentID) cancelIdleDebounce(parentID)
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

    // ---- shell.exited / shell.deleted: release background-shell tracking ----
    // These events carry no sessionID (just {id}), so they must run before the
    // ownership gate below — ownership was already established when the shell
    // was registered from this instance's tool events.
    if (type === "shell.exited" || type === "shell.deleted") {
      const shellID = data?.id
      if (typeof shellID === "string") {
        const owner = backgroundShells.get(shellID)
        if (owner) {
          backgroundShells.delete(shellID)
          // An exited shell wakes its owning session (synthetic message
          // with resume) within milliseconds — cancel the debounce rather
          // than race it. A deleted (killed) running shell wakes the same
          // way with a "Cancelled" notice. Duplicate events are no-ops.
          cancelIdleDebounce(owner)
          // Suppression considers descendant sessions, so release must
          // mirror it: cancel the whole ancestor chain's pending debounces
          // too — the woken descendant keeps the family working.
          let ancestor = sessions.get(owner)?.parentID
          const seen = new Set<string>()
          while (ancestor !== undefined && !seen.has(ancestor)) {
            seen.add(ancestor)
            cancelIdleDebounce(ancestor)
            ancestor = sessions.get(ancestor)?.parentID
          }
          logger.debug("Background shell released", { shellID, sessionID: owner, via: type })
        } else {
          // Unregistered (yet): remember it so a deferred registration of
          // this shell (fetch race) is dropped instead of wedging
          // suppression. Bounded by evicting the oldest entry.
          recentShellExits.set(shellID, type)
          if (recentShellExits.size > RECENT_SHELL_EXIT_CAP) {
            const oldest = recentShellExits.keys().next().value
            if (oldest !== undefined) recentShellExits.delete(oldest)
          }
          logger.debug("Unregistered shell exit recorded", { shellID, via: type })
        }
      }
      return
    }

    // ---- session.deleted: release all tracking state for this session ----
    if (type === "session.deleted") {
      if (data?.sessionID) {
        // A deleted child can no longer keep working — cancel the parent's
        // pending idle notification; the parent re-busies with the result.
        const parentID = sessions.get(data.sessionID)?.parentID
        sessions.delete(data.sessionID)
        active.delete(data.sessionID)
        errored.delete(data.sessionID)
        lastText.delete(data.sessionID)
        // A deleted session's background shells can never wake it — drop
        // them so they cannot hold this (or an ancestor's) idle hostage.
        for (const [shellID, owner] of backgroundShells) {
          if (owner === data.sessionID) backgroundShells.delete(shellID)
        }
        for (const [callID, owner] of bgToolCalls) {
          if (owner === data.sessionID) bgToolCalls.delete(callID)
        }
        cancelIdleDebounce(data.sessionID)
        if (parentID) cancelIdleDebounce(parentID)
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
      if (!resolveSession) {
        // Legacy single-instance behavior: assume the session is local.
        processSessionEvent(type, data, sessionID, eventDir)
        return
      }
      const run = async () => {
        const info = sessions.get(sessionID)
        if (!info) return
        let resolved = info.directory
        let fetched: Awaited<ReturnType<NonNullable<typeof resolveSession>>> = null
        if (resolved === undefined) {
          try {
            fetched = await resolveSession(sessionID)
            resolved = fetched?.directory ?? null
          } catch (err) {
            logger.debug("Session directory resolution failed", { sessionID, error: String(err) })
            resolved = null
          }
          const fresh = sessions.get(sessionID)
          if (fresh) {
            fresh.directory = resolved
            // The same lookup can fill a never-learned title (missed rename).
            if (fetched?.title && fresh.title == null && !isDefaultTitle(fetched.title)) {
              fresh.title = fetched.title
            }
          }
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
    // ---- Last assistant text: idle notifications preview the finished turn ----
    // session.text.ended carries the final text of each assistant part; the
    // last one before the idle signal is the turn's closing message.
    if (type === "session.text.ended") {
      if (sessionID && typeof data?.text === "string" && data.text.trim()) {
        lastText.set(sessionID, data.text.slice(0, 400))
      }
      return
    }

    // ---- Background shell tracking ----
    // session.tool.called is the only reliable foreground/background signal
    // (shell.created's metadata carries just {sessionID} for both kinds);
    // progress/success then reveal the shellID. shell.exited/deleted later
    // carry only {id}, so the correlation is kept in backgroundShells.
    if (type === "session.tool.called") {
      if (
        sessionID &&
        data?.name === "shell" &&
        data?.input?.background === true &&
        data?.executed !== false &&
        typeof data?.id === "string"
      ) {
        // executed:false means the call was denied before running — no
        // shell will exist, so it must never contribute suppression.
        bgToolCalls.set(data.id, sessionID)
        logger.debug("Background shell tool call seen", { sessionID, callID: data.id })
      }
      return
    }

    if (type === "session.tool.progress") {
      const shellID = data?.metadata?.shellID
      const owner = typeof data?.id === "string" ? bgToolCalls.get(data.id) : undefined
      if (owner && typeof shellID === "string") {
        // The callID entry stays until success/failed: CodeMode shares one
        // callID across several shells, and every progress under it must
        // register its own shell.
        if (recentShellExits.delete(shellID)) {
          // This shell already exited before its registration landed (fetch
          // race) — registering it would wedge suppression forever.
          logger.debug("Skipping registration of already-exited shell", { sessionID: owner, shellID })
        } else {
          backgroundShells.set(shellID, owner)
          logger.debug("Background shell registered", { sessionID: owner, shellID })
        }
      }
      return
    }

    if (type === "session.tool.success" || type === "session.tool.failed") {
      const callID = data?.id
      if (typeof callID === "string") {
        const owner = bgToolCalls.get(callID)
        if (owner) {
          // Progress is ephemeral and can be missed; success metadata repeats
          // the shellID as a fallback. A failed call never created a shell —
          // drop the entry so it cannot leak suppression.
          const shellID = data?.metadata?.shellID
          if (type === "session.tool.success" && typeof shellID === "string") {
            if (recentShellExits.delete(shellID)) {
              logger.debug("Skipping registration of already-exited shell", { sessionID: owner, shellID })
            } else {
              backgroundShells.set(shellID, owner)
              logger.debug("Background shell registered via success", { sessionID: owner, shellID })
            }
          }
          bgToolCalls.delete(callID)
        }
      }
      return
    }

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
        dispatchWithTitle("permission", data, sessionID, eventDir)
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
      // Terminal event — always release the busy state, even for suppressed
      // child sessions, so a dead child can't hold the parent's idle
      // notification hostage forever.
      if (sessionID) active.delete(sessionID)
      if (!config.events.error.enabled) return
      if (isChildSession(sessionID)) {
        logger.debug("Child session error — suppressing", { sessionID })
        return
      }
      if (sessionID) {
        errored.add(sessionID)
        cancelIdleDebounce(sessionID)
      }
      dispatchWithTitle("error", data, sessionID, eventDir)
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
      dispatchWithTitle("question", data, sessionID, eventDir)
      return
    }
  }

  function cleanup(): void {
    for (const timer of idleDebounce.values()) clearTimeout(timer)
    for (const timer of permissionDebounce.values()) clearTimeout(timer)
    idleDebounce.clear()
    permissionDebounce.clear()
    pending.clear()
    sessionFetches.clear()
    lastText.clear()
    bgToolCalls.clear()
    backgroundShells.clear()
    recentShellExits.clear()
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
      // Ownership + title resolver: looks up which directory a session
      // belongs to when this instance missed session.created, and the
      // session's current title when session.renamed already fired before
      // this instance subscribed (OpenCode publishes it exactly once).
      // OpenCode V2 runs one plugin instance per active location; without
      // the directory check, every instance would notify.
      resolveSession: async (sessionID) => {
        try {
          const info = await ctx.session.get({ sessionID })
          return { directory: info?.location?.directory ?? null, title: info?.title ?? null }
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
