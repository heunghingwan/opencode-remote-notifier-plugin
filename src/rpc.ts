// RPC surface other plugins call to push notifications through this
// plugin's ntfy pipeline. The pinned caller is opencode-error-handler-plugin
// (src/notify.ts): fire-and-forget, silent degradation, loose types —
//   ctx.rpc({ id: "remote-notifier", methods: { notify: {} } }).notify(input)
// with input { title, message, priority? }. Callers can switch to the typed
// import once this subpath is published:
//   import { NotifierRpc } from "opencode-remote-notifier-plugin/rpc"
import { Rpc } from "@opencode/plugin/rpc"

export const NotifierRpc = Rpc.define({
  id: "remote-notifier",
  methods: {
    notify: {
      input: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          priority: { type: "number" },
        },
        required: ["title", "message"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sent: { type: "boolean" },
        },
        required: ["sent"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

export interface NotifyInput {
  title: string
  message: string
  priority?: number
}

// JSON-Schema definitions type their input as unknown, so narrow it after
// the RPC layer's validation. The RPC server validates input against the
// schema above before the handler runs (missing title/message fail with
// rpc.invalid_input); this guard only defends against bypassed or
// hand-rolled calls, returning null for anything the schema rejects.
export function asNotifyInput(input: unknown): NotifyInput | null {
  if (typeof input !== "object" || input === null) return null
  const { title, message, priority } = input as Record<string, unknown>
  if (typeof title !== "string" || typeof message !== "string") return null
  if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) return null
  return { title, message, priority }
}
