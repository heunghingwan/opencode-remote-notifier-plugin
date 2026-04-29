import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import https from "node:https"
import http from "node:http"

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

    // Dedup check
    const lastSent = this.#dedup.get(key)
    if (lastSent !== undefined && now - lastSent < this.#dedupWindow) {
      return false
    }

    // Rate cap check
    this.#timestamps = this.#timestamps.filter((t) => now - t < 60_000)
    if (this.#timestamps.length >= this.#maxPerMinute) {
      return false
    }

    // Passed — record
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

function sendNotification(payload: NotifyPayload, attempt = 1): Promise<void> {
  return new Promise((resolve) => {
    const url = new URL(`/${payload.topic}`, payload.server)
    const headers: Record<string, string> = {
      "Title": payload.title,
      "Priority": String(payload.priority),
      "Tags": payload.tags.join(","),
      "Content-Type": "text/plain",
    }
    if (payload.markdown) {
      headers["Markdown"] = "yes"
    }
    if (payload.token) {
      headers["Authorization"] = `Bearer ${payload.token}`
    }

    const transport = url.protocol === "https:" ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers,
        timeout: 10_000,
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 200 && status < 300) {
          resolve()
        } else if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000
          setTimeout(() => sendNotification(payload, attempt + 1).then(resolve), delay)
        } else {
          console.warn("[remote-notifier] HTTP send failed after 3 retries, status:", status)
          resolve()
        }
      },
    )

    req.on("error", (err) => {
      if (attempt < 3) {
        const delay = Math.pow(2, attempt) * 1000
        setTimeout(() => sendNotification(payload, attempt + 1).then(resolve), delay)
      } else {
        console.warn("[remote-notifier] HTTP send failed after 3 retries:", err.message)
        resolve()
      }
    })

    req.on("timeout", () => {
      req.destroy()
      if (attempt < 3) {
        const delay = Math.pow(2, attempt) * 1000
        setTimeout(() => sendNotification(payload, attempt + 1).then(resolve), delay)
      } else {
        console.warn("[remote-notifier] HTTP send timed out after 3 retries")
        resolve()
      }
    })

    req.write(payload.message)
    req.end()
  })
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

function buildMessage(config: Config, type: EventType, payload: any): { title: string; message: string } {
  const title = EVENT_TITLES[type]
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
      const tool = payload?.tool ?? "unknown"
      const file = payload?.filePath ?? "unknown"
      const project = payload?.project?.name ?? ""
      const prefix = project ? `**${project}**` : ""
      return {
        title,
        message: md
          ? `${prefix}\n\n\ud83d\udd12 **Permission**\n\n\`${tool}\` on \`${file}\``
          : `[${project}] Permission: ${tool} on ${file}`,
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
  let eventType: EventType | null = null

  if (type === "session.error") eventType = "error"
  else if (type === "permission.asked") eventType = "permission"
  else if (type === "question.asked") eventType = "question"
  else if (type === "session.idle") eventType = "idle"
  else return

  const eventCfg = config.events[eventType]
  if (!eventCfg.enabled) return

  const dedupKey = `${eventType}:${event.payload?.sessionID ?? "unknown"}`
  if (!limiter.allow(dedupKey)) return

  // Resolve project name from payload or fall back to directory basename
  let project = event.payload?.project?.name ?? path.basename(projectDir)
  if (!event.payload || typeof event.payload !== "object") {
    event.payload = {}
  }
  if (!event.payload.project) {
    event.payload.project = { name: project }
  }

  const { title, message } = buildMessage(config, eventType, event.payload)

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
