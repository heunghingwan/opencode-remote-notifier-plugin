# .opencode/ — Plugin Workspace

**Generated:** 2026-05-05

## OVERVIEW

Runtime workspace for the remote-notifier plugin. OpenCode resolves the plugin git URL, runs `bun install` here, and loads `.ts` source directly. This directory is regenerated on install — `package.json` and lock files are gitignored.

## STRUCTURE

```
.opencode/
├── plugins/              # Source code (single file)
│   └── remote-notifier.ts
├── notifier.json         # Config template (topic: "changeme")
├── package.json          # Runtime deps (regenerated)
└── node_modules/         # Installed dependencies
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Plugin logic | `plugins/remote-notifier.ts` | 554 lines — config reader, rate limiter, HTTP client, session tracking, event handler |
| Dependency manifest | `package-lock.json` | Pinned to `@opencode-ai/plugin@1.14.29` |
| Config template | `notifier.json` | Reference only; actual user config at `~/.config/opencode/remote-notifier.json` |

## CONVENTIONS

- **No transitive deps beyond SDK**: Only `@opencode-ai/plugin` declared. Everything else comes through the SDK.
- **Local `.gitignore` strips lock files**: `package.json`, `package-lock.json`, `bun.lock` are intentionally excluded from version control.
- **Single source file**: No module splitting within plugins.

## NOTES

- Don't edit `package.json` here directly — it gets overwritten by OpenCode on install. Edit the root `package.json` `dependencies` instead.
- `notifier.json` in this directory is NOT the active config — it's a template. The real config lives at the XDG path.
