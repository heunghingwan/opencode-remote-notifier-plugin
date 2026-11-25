// Plugin logging.
//
// OpenCode plugins have no server-log API: the plugin context exposes no log
// surface, and console output is discarded when the server runs as the
// background service (its stdout is not the log file — verified: 100% of
// opencode.log lines are structured `timestamp=` records). So this plugin
// keeps its own JSONL log, next to opencode.log, where decisions and
// deliveries are auditable after the fact — which notifications were sent,
// which were suppressed (sub-agent idles, rate-limit drops, foreign
// sessions) and why, and how the event stream reconnects.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export type LoggerLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface FileLoggerOptions {
  /** Rotate the current file away once it exceeds this size. Default 2 MiB. */
  readonly rotationBytes?: number
  /** Minimum level written. Default "debug". */
  readonly minLevel?: LoggerLevel
}

const LEVELS: Record<LoggerLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export const DEFAULT_LOG_PATH = () =>
  process.env.REMOTE_NOTIFIER_LOG ??
  path.join(os.homedir(), ".local/share/opencode/log/remote-notifier.log")

export function createFileLogger(logPath: string = DEFAULT_LOG_PATH(), options: FileLoggerOptions = {}): Logger {
  const rotationBytes = options.rotationBytes ?? 2 * 1024 * 1024
  const minLevel = options.minLevel ?? "debug"
  let warnLimit = 0

  const write = (level: LoggerLevel, message: string, extra?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(extra ?? {}),
    }
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      try {
        const size = fs.statSync(logPath).size
        if (size > rotationBytes) fs.renameSync(logPath, `${logPath}.1`)
      } catch {
        // missing file is fine; other stat failures fall through to the write
      }
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
    } catch (err) {
      // The log must never break the notification path. Surface the problem
      // a few times on console (discarded under the service, visible in
      // foreground) and then go silent rather than spamming.
      if (warnLimit++ < 3) console.error(`[remote-notifier] log write failed: ${String(err)}`)
    }
  }

  return {
    debug: (msg, extra) => write("debug", msg, extra),
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
  }
}

/** Test/diagnostic logger that discards everything. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
