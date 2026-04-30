# OpenCode Remote Notifier Plugin

Push OpenCode events (errors, permission requests, questions, idle) to your phone via [ntfy.sh](https://ntfy.sh).

## Features

- **4 event types**: session errors, permission requests, questions, idle notifications
- **Session titles**: automatically includes the conversation title (supports Unicode/Chinese)
- **Rate limiting**: configurable dedup window and max notifications per minute
- **Retry**: auto-retries up to 3 times with exponential backoff
- **Markdown**: notification bodies support Markdown formatting

## Install

Add to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["opencode-remote-notifier-plugin@git+https://github.com/heunghingwan/opencode-remote-notifier-plugin.git"]
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
| `error` | Session errors (LLM failures, API errors) | 5 (urgent) |
| `permission` | Agent requests permission to access files | 4 (high) |
| `question` | Agent asks the user a question | 4 (high) |
| `idle` | Session becomes idle/waiting for input | 3 (default) |

### Rate Limiting

- **Dedup**: Same event type + same session within `dedupWindowSec` seconds → skipped
- **Rate cap**: At most `maxPerMinute` notifications globally per minute → excess dropped

## How It Works

The plugin subscribes to OpenCode's internal event bus and forwards relevant events as ntfy.sh push notifications:

1. `session.updated` events are intercepted to cache the conversation title
2. When a notification event fires (`error`, `permission`, `question`, `idle`), the cached title is included
3. If the title is still the auto-generated default (`New session - ...`), the plugin waits up to 10 seconds for the LLM to generate a real title before sending

## License

MIT
