# OpenCode Remote Notifier Plugin

Push OpenCode events (errors, permission requests, questions, idle) to your phone via [ntfy.sh](https://ntfy.sh).

Built for **OpenCode V2** (v2.0.21+). The V1 plugin API is not supported.

## Features

- **4 event types**: session errors, permission requests, questions, idle notifications
- **Compact titles**: `emoji + conversation title` (e.g. `💤 Fix login bug`) — no long prefix, so the session name stays visible on the phone's notification bar
- **Session titles**: automatically includes the conversation title (supports Unicode/Chinese); when the title event was missed (server restart, plugin reload), it is fetched from the session API before notifying
- **Rate limiting**: configurable dedup window and max notifications per minute
- **Retry**: auto-retries up to 3 times with exponential backoff
- **Markdown**: notification bodies support Markdown formatting

## Install

Add to the `plugins` array in your `opencode.json`:

```json
{
  "plugins": ["opencode-remote-notifier-plugin@git+https://github.com/heunghingwan/opencode-remote-notifier-plugin.git"]
}
```

Restart OpenCode. The plugin auto-installs via Bun.

Then create `~/.config/opencode/remote-notifier.json`:

```json
{
  "server": "https://ntfy.sh",
  "topic": "your-unique-topic-name",
  "token": "",
  "markdown": true,
  "events": {
    "error":      { "enabled": true, "priority": 5 },
    "permission": { "enabled": true, "priority": 4 },
    "question":   { "enabled": true, "priority": 4 },
    "idle":       { "enabled": true, "priority": 3 }
  },
  "rateLimit": {
    "maxPerMinute": 5,
    "dedupWindowSec": 30
  }
}
```

Install the [ntfy.sh app](https://ntfy.sh/docs/subscribe/phone/) on your phone and subscribe to the topic.

Verify the plugin is loaded:

```sh
opencode plugin list
```

## Configuration

| Field | Default | Description |
|---|---|---|
| `server` | `https://ntfy.sh` | ntfy.sh server URL |
| `topic` | — | Your unique topic name (required) |
| `token` | `""` | Bearer token for authenticated topics |
| `markdown` | `true` | Enable Markdown in notification body |

### Events

| Event | Trigger | Default Priority |
|---|---|---|
| `error` | Session execution failures (LLM failures, API errors) | 5 (urgent) |
| `permission` | Agent requests permission to access files | 4 (high) |
| `question` | Agent asks the user a question | 4 (high) |
| `idle` | Session becomes idle/waiting for input (suppressed while sub-agents below it are still working — at any nesting depth — and while a background shell the session is waiting on is still pending) | 3 (default) |

### Rate Limiting

- **Dedup**: Same event type + same session within `dedupWindowSec` seconds → skipped
- **Rate cap**: At most `maxPerMinute` notifications globally per minute → excess dropped

## How It Works

The plugin subscribes to OpenCode's V2 server event stream (`ctx.event.subscribe`) and forwards relevant events as ntfy.sh push notifications. If the stream drops (bus error, stream end), it reconnects with exponential backoff (1s→30s) and resets transient tracking state — events missed during the gap could otherwise wedge suppression; session knowledge (titles, directories, family links) survives the gap:

1. `session.created` events are intercepted to cache the session's title and parent (sub-agent sessions are silenced)
2. `session.renamed` events update the cached title; when a notification fires, the real title is included
3. If the title is still the auto-generated default (`New session - ...`) or unknown, the title falls back to the short event label (e.g. `💤 Idle`)
4. `session.renamed` fires exactly once per session — if the instance subscribed after that (server restart, plugin reload, late location activation), the title is fetched via `ctx.session.get` right before notifying, so it is never silently blank

Notification bodies carry event-specific content (the title's emoji identifies the event type, so bodies skip type headings). Every body is prefixed with the project label — the **repository name** as OpenCode resolves it (`ctx.location.project.canonical`): inside a linked git worktree (e.g. `.codenomad/worktrees/<branch>`) the main repository's name is shown, never the worktree's directory name. A `.git`-marker fallback covers hosts without project info:

- **idle** quotes the first line (≤140 chars) of the turn's last assistant message, tracked from `session.text.ended` and cleared when a new execution starts — falls back to "Session waiting for input"
- **question** renders the form's fields (header, question text, choice labels) — the question tool's form title is the constant "Questions", so the fields are where the real question lives
- **error** shows the error message in a code block
- **permission** shows the action and affected resources

Events handled: `session.execution.failed` (error), `permission.asked` / `permission.replied` (permission), `form.created` (question), `session.status` idle/busy (idle). Tracked (no notification of their own): `session.created` / `renamed` / `deleted`, `session.tool.called` / `progress` / `success` / `failed`, `session.text.ended`, `shell.exited` / `shell.deleted` — the idle-suppression machinery below feeds on these.

**Idle suppression** — an idle signal is treated as genuine idleness only after these checks pass:

1. The session was busy first (no no-op idles), and the idle doesn't trail an error notification
2. The session is not a sub-agent, and no sub-agent below it (a direct child or a nested one) is still working — a child that handed off to its own sub-agent goes idle too, which must not read as the whole family finishing
3. **No background shell is pending**: when the agent starts a background shell and ends its turn, the shell's exit wakes it (a synthetic message resumes the session), so the waiting period is not idleness. Background shells have two origins, both tracked:
   - Explicit: `session.tool.called` (`name: "shell"`, `input.background: true`) correlated with `session.tool.progress`/`success` (`metadata.shellID`)
   - Timeout-converted: a *foreground* shell that outlived its timeout is moved to the background by OpenCode — the call succeeds with `metadata: { status: "running", shellID }` while `input.background` never appears; the plugin registers it from that success metadata
   - Released on `shell.exited` / `shell.deleted` / `session.deleted`
   - Sessions waiting on a sub-agent's background shell are covered too (OpenCode's job semantics include background jobs owned by descendant sessions)
   - A background shell that never exits (e.g. a dev server) suppresses idle indefinitely — the session is genuinely waiting for it to wake

## Development

```sh
bun install        # root + .opencode/
bun test           # unit tests (.opencode/test/)
bun run typecheck  # tsc --noEmit
```

## License

MIT
