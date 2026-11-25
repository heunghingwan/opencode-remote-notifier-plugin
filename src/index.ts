import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

import { NotifierRpc, asNotifyInput } from "./rpc.ts"
import type { NotifyInput } from "./rpc.ts"
import { createFileLogger } from "./logger.ts"

// ---- Logger ----
// OpenCode plugins have no server-log API, and console output is discarded
// by the background service (its stdout is not the log file) — so the
// plugin logs to its own JSONL file (src/logger.ts). The Logger interface
// stays local so tests keep injecting silent stubs.


export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

// ---- Types ----

// "external" is not a session event: it is the RPC entry point other
// plugins call (see rpc.ts), routed through the same dispatch pipeline.
export type EventType = "error" | "permission" | "question" | "idle" | "external"

/** Session-driven notification types — the four keys of config.events. */
export type SessionEventType = Exclude<EventType, "external">

interface EventConfig {
  enabled: boolean
  priority: number
}

export interface Config {
  server: string
  topic: string
  token: string
  markdown: boolean
  events: Record<SessionEventType, EventConfig>
  /** RPC surface for other plugins (see rpc.ts). Enabled by default. */
  external: {
    enabled: boolean
  }
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
  external: {
    enabled: true,
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
      external: {
        enabled: user.external?.enabled ?? DEFAULTS.external.enabled,
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
  /** Set once a session-API metadata fetch has been attempted (or run) — one per session. */
  metaChecked?: boolean
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
// (external has no entry: RPC callers bring their own full title.)
const EVENT_EMOJI: Record<SessionEventType, string> = {
  error:      "🚨",
  permission: "🔐",
  question:   "❓",
  idle:       "💤",
}

// Fallback label used only when the session's real title is unknown.
const EVENT_LABELS: Record<SessionEventType, string> = {
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
// dispatch() injects project.name (repository name — the main repo, not the
// worktree, when the location is a linked git worktree) and lastText (the
// finished turn's last assistant text, tracked from session.text.ended).
export function buildMessage(config: Config, type: EventType, payload: any, sessionTitle?: string | null): { title: string; message: string } {
  const md = config.markdown

  // External notifications arrive fully composed (RPC callers, see rpc.ts):
  // pass the caller's title and message through verbatim — no emoji, no
  // project prefix, no markdown wrapping.
  if (type === "external") {
    return {
      title: typeof payload?.title === "string" ? payload.title : "",
      message: typeof payload?.message === "string" ? payload.message : "",
    }
  }

  const emoji = EVENT_EMOJI[type]
  const effectiveTitle = sessionTitle && !isDefaultTitle(sessionTitle) ? sessionTitle : EVENT_LABELS[type]
  const title = `${emoji} ${effectiveTitle}`

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

// ---- External (RPC) priority mapping ----
// ntfy accepts priorities 1-5 only. RPC callers may pass any number (the
// contract says number): clamp into range, and fall back to the error
// priority — the closest existing default for "something went wrong" —
// when the caller omits it.
function externalPriority(priority: unknown, fallback: number): number {
  if (typeof priority !== "number" || !Number.isFinite(priority)) return fallback
  return Math.min(5, Math.max(1, Math.round(priority)))
}

// ---- Project name resolution ----
// Fallback for hosts that don't provide the project's canonical directory:
// the notification label must be the project (repository) name, not the
// directory name — inside a linked git worktree (e.g. .codenomad/worktrees/x)
// the directory basename is the worktree name. The .git marker tells them
// apart without spawning git: a linked worktree's .git is a file
// "gitdir: <mainRoot>/.git/worktrees/<name>", while the main worktree (and
// non-repo directories) resolve to their own basename.
export function resolveProjectName(directory: string): string {
  const fallback = path.basename(directory) || directory
  try {
    const dotGit = path.join(directory, ".git")
    const stat = fs.statSync(dotGit)
    // Main worktree: .git is a directory and the dir name IS the project name.
    if (stat.isDirectory()) return fallback
    if (!stat.isFile()) return fallback
    const raw = fs.readFileSync(dotGit, "utf8")
    const m = /^gitdir:\s*(.+)$/m.exec(raw)
    if (!m) return fallback
    // Normalize (also resolves relative gitdir paths against the worktree).
    // m[1] always exists: the group is non-optional in the regex above.
    const gitdir = path.resolve(directory, m[1]!.trim())
    // Linked worktree metadata lives at <mainRoot>/.git/worktrees/<name>.
    // Submodules point into <main>/.git/modules/<name> instead — those keep
    // the directory basename (a submodule is its own project).
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`
    const idx = gitdir.indexOf(marker)
    if (idx === -1) return fallback
    return path.basename(gitdir.slice(0, idx)) || fallback
  } catch {
    // No .git (or unreadable) — not a worktree; keep the directory name.
    return fallback
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
  resolveSession?: (sessionID: string) => Promise<{ directory: string | null; title?: string | null; parentID?: string | null } | null>
  /**
   * Notification project label. Production wiring derives it from
   * ctx.location.project.canonical — OpenCode resolves the repository's
   * canonical directory itself (the main checkout, not the linked worktree,
   * when the location is one). When absent (tests, hosts without project
   * info), createNotifier falls back to reading the .git marker.
   */
  projectName?: string
}

export function createNotifier(config: Config, logger: Logger, projectDir: string, deps: NotifierDeps = {}) {
  const send = deps.sender ?? ((payload: NotifyPayload) => sendNotification(payload, logger))
  const idleDebounceMs = deps.idleDebounceMs ?? IDLE_DEBOUNCE_MS
  const permissionDebounceMs = deps.permissionDebounceMs ?? PERMISSION_DEBOUNCE_MS
  const resolveSession = deps.resolveSession
  // Notification label: the repository name (worktree-aware). Prefer the name
  // OpenCode resolved (deps.projectName, from ctx.location.project.canonical);
  // fall back to reading the .git marker ourselves.
  const projectName = deps.projectName ?? resolveProjectName(projectDir)
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
  // Call IDs of shell-tool calls, learned from session.tool.input.started.
  // OpenCode v2.3's session.tool.called payload carries NO tool name (the
  // name only appears on input.started), so the shell identification needs
  // this companion set.
  const shellCallIDs = new Set<string>()
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

  // True while any sub-agent below this session in the tree — a direct
  // child or a nested one — is still executing. Used to suppress the
  // ancestor's idle notification: when a session hands off to a sub-agent,
  // its execution ends and an idle signal fires even though the family is
  // still working. Depth matters: a child that itself handed off to a
  // nested sub-agent goes idle too, so matching direct children alone lets
  // the root of a three-level family notify while a grandchild works.
  function hasActiveDescendant(ancestorID: string): boolean {
    for (const id of active) {
      if (isDescendantOf(id, ancestorID)) return true
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

  // Backfills session metadata (directory, title, parentID) from the session
  // API, once per session. Needed when this instance missed the events that
  // carry them: session.created/renamed (server restart, plugin reload, late
  // location activation). parentID matters even when the envelope location
  // seeds the directory synchronously — without the family link, idle
  // suppression for sub-agent trees and background shells breaks after a
  // reload. Dedups in-flight per session; event data arriving during a fetch
  // always wins (the merge only fills unknown fields).
  function ensureTitle(sessionID: string): Promise<void> {
    const info = sessions.get(sessionID)
    if (!info || info.metaChecked || !resolveSession) return Promise.resolve()
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
          if (fresh.parentID === undefined && fetched.parentID) {
            fresh.parentID = fetched.parentID
            logger.debug("Session parentID backfilled", { sessionID, parentID: fetched.parentID })
          }
        } catch (err) {
          logger.debug("Session metadata resolution failed", { sessionID, error: String(err) })
        } finally {
          // One attempt per session: a second fetch could only return what
          // the first already applied (or couldn't find).
          const fresh = sessions.get(sessionID)
          if (fresh) fresh.metaChecked = true
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
  ): void {
    const info = sessionID ? sessions.get(sessionID) : undefined
    if (!sessionID || !info || info.title !== undefined || !resolveSession) {
      dispatch(eventType, data, sessionID)
      return
    }
    void ensureTitle(sessionID).then(() => dispatch(eventType, data, sessionID))
  }

  // Sends one notification through the shared pipeline: the global rate
  // limiter (per-minute cap + dedup), the message builder, and the ntfy
  // transport with retries. Returns whether the notification was accepted
  // (rate limiting may drop it); session-event callers ignore the value,
  // the RPC surface reports it to its caller.
  function dispatch(
    eventType: EventType,
    data: any,
    sessionID: string | undefined,
  ): boolean {
    // External notifications have no session to key the dedup on — key on
    // the caller's content instead, so a repeat within the window is
    // dropped while distinct messages still pass (subject to the cap).
    const dedupKey = eventType === "external"
      ? `external:${data?.title}:${data?.message}`
      : `${eventType}:${sessionID ?? "unknown"}`
    // idle naturally dedups via the active set; other events use per-key dedup.
    if (!limiter.allow(dedupKey, eventType === "idle")) return false

    const sessionTitle = sessionID ? sessions.get(sessionID)?.title ?? null : null
    // Ownership gating guarantees the session's directory equals this
    // instance's projectDir, so the worktree-aware project name resolved at
    // init is always the right label (sessionDir/eventDir would only repeat
    // it — or, in a worktree, show the worktree name).
    const project = projectName
    const extra = eventType === "idle" && sessionID
      ? { lastText: lastText.get(sessionID) }
      : {}
    const { title, message } = buildMessage(config, eventType, { ...data, project: { name: project }, ...extra }, sessionTitle)
    const priority = eventType === "external"
      ? externalPriority(data?.priority, config.events.error.priority)
      : config.events[eventType].priority

    logger.info("Sending notification", { type: eventType, title, priority })

    void send({
      server: config.server,
      topic: config.topic,
      token: config.token,
      markdown: config.markdown,
      title,
      message,
      priority,
      // The title already carries the single event emoji; ntfy tag emojis
      // would only duplicate it in the notification row.
      tags: [],
    })
    return true
  }

  // ---- RPC entry point (see rpc.ts) ----
  // Other plugins push fully-composed notifications through the exact same
  // pipeline as session events: one global rate limiter (maxPerMinute plus
  // content dedup), one transport, one retry policy. Returns whether the
  // notification entered the pipeline (a false return means the external
  // surface is disabled or rate limiting dropped it).
  function notifyExternal(input: NotifyInput): boolean {
    if (!config.external.enabled) {
      logger.debug("External notify disabled — skipping")
      return false
    }
    return dispatch("external", input, undefined)
  }

  // Shared idle-signal handling. Called from both session.status idle and
  // session.execution.succeeded (the real signal on OpenCode ≤2.0.21, where
  // session.status has no emitter). Runs the mature suppress checks (no prior
  // busy / trailing idle after error / sub-agent child / parent with an active
  // child) then schedules the idle debounce.
  function handleIdleSignal(sessionID: string, data: any): void {
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

    // Suppress the ancestor's idle while a sub-agent below it is still
    // working — this idle is the tool-call handoff, not genuine idleness.
    // The ancestor re-busies when the sub-agent's result returns.
    if (hasActiveDescendant(sessionID)) {
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
      if (hasActiveDescendant(sessionID)) {
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
      dispatchWithTitle("idle", data, sessionID)
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

    // ---- session.moved: the session changed location ----
    // OpenCode V2's SessionMove publishes this from a global service with NO
    // envelope location; data.location is the destination. The bus routes it
    // to both the old and the new location, and — because plugin event
    // subscriptions are unfiltered broadcasts — every instance receives it.
    // Refresh the cached directory here so the ownership gate below tracks
    // the session's live location: the instance the session LEFT must stop
    // treating it as local, and the destination instance must own it (also
    // for later events that carry no envelope location to compare against).
    if (type === "session.moved") {
      if (data?.sessionID) {
        const prev = sessions.get(data.sessionID)
        const loc = data?.location
        const movedDir =
          typeof loc === "string" ? loc : typeof loc?.directory === "string" ? loc.directory : undefined
        sessions.set(data.sessionID, {
          parentID: prev?.parentID,
          title: prev?.title,
          directory: movedDir ?? prev?.directory,
        })
        logger.debug("Session moved", { id: data.sessionID, directory: movedDir ?? null })
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
          if (owner === data.sessionID) {
            bgToolCalls.delete(callID)
            shellCallIDs.delete(callID)
          }
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
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, {})
      // First sight of this session (session.created was missed — server
      // restart, plugin reload). Fire a background metadata fetch so its
      // parentID is learned even when the envelope location seeds the
      // directory synchronously; without the family link, idle suppression
      // for sub-agent trees and background shells breaks after a reload.
      void ensureTitle(sessionID)
    }

    // Refresh the session's directory from the envelope location. The
    // envelope is authoritative for events published by the session's own
    // location services: after a session.move (directory or worktree — same
    // mechanism), post-move events carry the NEW location while the cache
    // still holds the session.created-era one. Seeding only — never
    // refreshing — is what let the instance the session LEFT keep matching
    // its own directory and send duplicate notifications.
    if (eventDir) {
      const info = sessions.get(sessionID)!
      if (info.directory !== eventDir) {
        if (info.directory !== undefined) {
          logger.debug("Session directory updated from event envelope", {
            sessionID,
            from: info.directory,
            to: eventDir,
          })
        }
        info.directory = eventDir
      }
    }

    const dir = sessions.get(sessionID)!.directory
    if (dir === undefined) {
      // Directory unknown (this instance booted after session.created was
      // published). Resolve it asynchronously, serialized per session so
      // event order is preserved.
      if (!resolveSession) {
        // Legacy single-instance behavior: assume the session is local.
        processSessionEvent(type, data, sessionID)
        return
      }
      const run = async () => {
        const info = sessions.get(sessionID)
        if (!info) return
        if (info.directory === undefined) {
          // Shares the in-flight metadata fetch with ensureTitle (deduped)
          // — one session.get backfills directory, title and parentID.
          await ensureTitle(sessionID)
        }
        const fresh = sessions.get(sessionID)
        if (!fresh) return
        // Cache a definitive null so foreign sessions never re-fetch.
        if (fresh.directory === undefined) fresh.directory = null
        if (fresh.directory !== projectDir) {
          logger.debug("Foreign session — skipping", { sessionID, sessionDir: fresh.directory })
          return
        }
        processSessionEvent(type, data, sessionID)
      }
      const prev = pending.get(sessionID) ?? Promise.resolve()
      pending.set(sessionID, prev.then(run, run))
      return
    }

    if (dir !== projectDir) {
      logger.debug("Foreign session — skipping", { sessionID, sessionDir: dir })
      return
    }
    processSessionEvent(type, data, sessionID)
  }

  // Handles a session-scoped event — only called for sessions this instance
  // owns (see the ownership gate in handleEvent).
  function processSessionEvent(
    type: string,
    data: any,
    sessionID: string | undefined,
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
    // The shell tool is identified by session.tool.input.started (OpenCode
    // v2.3's tool.called payload has no name field; older versions put the
    // name directly on called, which is still accepted). input.background
    // marks the call as background. progress/success then reveal the
    // shellID. shell.exited/deleted later carry only {id}, so the
    // correlation is kept in backgroundShells.
    // A background shell has TWO origins: an explicit input.background call,
    // or a foreground command that outlived its timeout — OpenCode moves it
    // to the background and the tool succeeds with metadata
    // { status: "running", shellID } while input stays background-less (see
    // the success handler below).
    //
    // NOTE on `executed`: in v2.3 it means "executed by the provider", and
    // the shell tool always executes locally — so it is false for every
    // real shell call. It must NOT gate registration. A denied call never
    // spawns a shell, so no progress/success ever links a shellID to it;
    // tool.failed drops the entry.
    if (type === "session.tool.input.started") {
      if (sessionID && data?.name === "shell" && typeof data?.id === "string") {
        shellCallIDs.add(data.id)
      }
      return
    }

    if (type === "session.tool.called") {
      if (
        sessionID &&
        typeof data?.id === "string" &&
        (data?.name === "shell" || shellCallIDs.has(data.id)) &&
        data?.input?.background === true
      ) {
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
        const isShellCall = data?.name === "shell" || shellCallIDs.has(callID)
        shellCallIDs.delete(callID)
        const shellID = data?.metadata?.shellID
        // Owner resolution covers two background origins:
        // 1. Explicitly background calls, registered from called
        //    (input.background === true).
        // 2. Foreground shells that outlived their timeout and were moved to
        //    the background by OpenCode — input.background never appears;
        //    the only marker is success metadata reporting the shell still
        //    running (status:"running" + shellID, observed live on 2.3).
        const timedOutToBackground =
          type === "session.tool.success" &&
          isShellCall &&
          data?.metadata?.status === "running" &&
          typeof shellID === "string"
        const owner = bgToolCalls.get(callID) ?? (timedOutToBackground && sessionID ? sessionID : undefined)
        if (owner) {
          // Progress is ephemeral and can be missed; success metadata repeats
          // the shellID as a fallback. A failed call never created a shell —
          // drop the entry so it cannot leak suppression.
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
      if (sessionID) handleIdleSignal(sessionID, data)
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
      if (sessionID) handleIdleSignal(sessionID, data)
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
        dispatchWithTitle("permission", data, sessionID)
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
      dispatchWithTitle("error", data, sessionID)
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
      dispatchWithTitle("question", data, sessionID)
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
    shellCallIDs.clear()
    backgroundShells.clear()
    recentShellExits.clear()
    sessions.clear()
    active.clear()
    errored.clear()
  }

  // Stream-gap reset (the event subscription dropped and reconnected):
  // events during the gap were missed, so transient tracking is stale — a
  // busy session may have gone idle, a background shell may have exited.
  // Clearing trades at most one missed/spurious notification for never
  // wedging on dead state. Durable knowledge (the sessions map: titles,
  // directories, family links) survives — those are facts, not snapshots.
  function reset(): void {
    for (const timer of idleDebounce.values()) clearTimeout(timer)
    for (const timer of permissionDebounce.values()) clearTimeout(timer)
    idleDebounce.clear()
    permissionDebounce.clear()
    lastText.clear()
    bgToolCalls.clear()
    shellCallIDs.clear()
    backgroundShells.clear()
    recentShellExits.clear()
    active.clear()
    errored.clear()
  }

  return { handleEvent, cleanup, reset, notifyExternal }
}

// ---- Subscription with reconnect ----
// The event stream can drop (bus error, server-side stream end). Without a
// retry the plugin goes permanently deaf after the first drop. With a blind
// retry, state learned before the gap goes stale — events missed during the
// gap could wedge suppression forever (e.g. a background shell that exited
// unseen). onGap fires at every drop so the caller can reset transient
// state before resubscribing.

const RESUBSCRIBE_BASE_MS = 1000
const RESUBSCRIBE_MAX_MS = 30000

function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export interface SubscribeRetryOptions {
  subscribe: (signal: AbortSignal) => AsyncIterable<any>
  onEvent: (event: any) => void
  /** Called after each stream drop (error or graceful end), before the resubscribe backoff. */
  onGap?: () => void
  signal: AbortSignal
  logger: Logger
  baseDelayMs?: number
  maxDelayMs?: number
}

export async function subscribeWithRetry(opts: SubscribeRetryOptions): Promise<void> {
  const { subscribe, onEvent, onGap, signal, logger } = opts
  const base = opts.baseDelayMs ?? RESUBSCRIBE_BASE_MS
  const max = opts.maxDelayMs ?? RESUBSCRIBE_MAX_MS
  let attempt = 0
  while (!signal.aborted) {
    try {
      for await (const event of subscribe(signal)) {
        if (attempt !== 0) attempt = 0 // first delivered event: stream is healthy
        onEvent(event)
      }
      if (signal.aborted) return
      logger.warn("Event stream ended — reconnecting")
    } catch (err) {
      if (signal.aborted) return
      logger.error("Event stream failed — reconnecting", { error: String(err) })
    }
    onGap?.()
    const delay = Math.min(base * 2 ** Math.min(attempt, 30), max)
    attempt++
    await abortableSleep(signal, delay)
  }
}

// ---- Plugin Export ----

export default Plugin.define({
  id: "remote-notifier",
  setup(ctx) {
    const logger = createFileLogger()
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
      externalRpc: config.external.enabled,
    })

    const notifier = createNotifier(config, logger, ctx.location.directory, {
      // Project label: OpenCode resolves the repository's canonical directory
      // (the main checkout — never a linked worktree — via its own cached git
      // discovery); its basename is the stable project name. Older runtimes
      // without this field fall back to the .git-marker resolution.
      projectName: typeof ctx.location?.project?.canonical === "string"
        ? path.basename(ctx.location.project.canonical)
        : undefined,
      // Ownership + title resolver: looks up which directory a session
      // belongs to when this instance missed session.created, and the
      // session's current title when session.renamed already fired before
      // this instance subscribed (OpenCode publishes it exactly once).
      // OpenCode V2 runs one plugin instance per active location; without
      // the directory check, every instance would notify.
      resolveSession: async (sessionID) => {
        try {
          const info = await ctx.session.get({ sessionID })
          return {
            directory: info?.location?.directory ?? null,
            title: info?.title ?? null,
            parentID: info?.parentID ?? null,
          }
        } catch {
          return null
        }
      },
    })
    const controller = new AbortController()

    // ---- RPC surface (see rpc.ts): other plugins push notifications ----
    // Registration is async while this setup stays sync (its cleanup
    // contract is a plain function), so the registration promise settles
    // on its own and unload disposes it. OpenCode V2 runs one instance per
    // active location and each registers the same id — the RPC registry
    // routes a call to the latest registration, and every instance reads
    // the same global config, so whichever instance answers behaves
    // identically.
    const registration = ctx.rpc
      .register(NotifierRpc, {
        notify: async (input) => {
          const parsed = asNotifyInput(input)
          if (!parsed) {
            // The RPC layer validates input against the schema before this
            // handler runs; malformed input here means the call bypassed it.
            logger.warn("RPC notify rejected malformed input")
            return { sent: false }
          }
          return { sent: notifier.notifyExternal(parsed) }
        },
      })
      .catch((err: any) => {
        logger.error("RPC registration failed", { error: String(err) })
        return null
      })

    void subscribeWithRetry({
      subscribe: (signal) => ctx.event.subscribe({ signal }),
      onEvent: (event) => notifier.handleEvent(event),
      onGap: () => notifier.reset(),
      signal: controller.signal,
      logger,
    })

    return () => {
      controller.abort()
      notifier.cleanup()
      void registration.then((reg) => {
        void reg?.dispose().catch(() => {})
      })
      logger.info("Plugin unloaded")
    }
  },
})
