# AGENTS.md

## opencode-remote-notifier-plugin

OpenCode v2 插件：把 session 事件（錯誤、權限請求、提問、閒置）經 ntfy.sh 推送到手機，
並提供 RPC `notify` 入口讓其他插件借道推送（調用者：opencode-error-handler-plugin）。

## ⚠️ 目錄結構紅線

**插件源碼絕不放在 `.opencode/plugins/` 下。**

OpenCode 會自動載入任何設定目錄（專案的 `.opencode/`、全域 `~/.config/opencode/`）下的
`plugin/` 或 `plugins/` 子目錄裡的所有 `.ts`/`.js`（`packages/core/src/plugin/source-directory.ts`）。
源碼放在 `src/`，因此在倉庫目錄內開 session **不會**自動載入本插件（2.4.0 前源碼放在
`.opencode/plugins/`，開發時自己載入自己——已重構移除）。

```
opencode-remote-notifier-plugin/
├── package.json            # main/exports 指向 src/；依賴 @opencode/plugin
├── tsconfig.json           # 涵蓋 src/ 與 test/（tsc --noEmit）
├── src/
│   ├── index.ts            # 插件主體：事件訂閱、節流、閒置抑制、通知、plugin 入口
│   ├── rpc.ts              # RPC 定義（id "remote-notifier"、method notify）＋輸入窄化
│   └── logger.ts           # JSONL 檔案日誌（2 MiB 輪替；寫檔失敗絕不拋）
├── test/                   # bun test（fixture 以 REMOTE_NOTIFIER_LOG 指向暫存路徑）
├── config.example.json     # 設定範本；真實設定在 ~/.config/opencode/remote-notifier.json
└── README.md
```

## 載入方式（三個階段）

1. **開發中（不自動生效）**：本倉庫內不放任何指向自己的設定；根目錄跑
   `bun install`／`bun test`／`bun run typecheck`。
2. **實機測試**：在一個**拋棄式測試目錄**（不在本倉庫內）放 `opencode.jsonc`：
   `"plugins": ["file:///path/to/opencode-remote-notifier-plugin"]`，
   在那裡開 session 觸發事件驗證通知；源碼修改會熱重載。
3. **正式使用**：全域 `~/.config/opencode/opencode.jsonc` 加
   `"opencode-remote-notifier-plugin@git+https://github.com/heunghingwan/opencode-remote-notifier-plugin.git"`。

## 慣例

- TypeScript 原碼直接由 Bun 載入，無 build step；依賴與 node_modules 收斂在根目錄（唯一一份）
- 只實作 `event` hook；per-instance 狀態（session map、debounce、rate limiter）全部住在
  `createNotifier` 內，模組層不放可變共用狀態（每個 location 一個實例）
- 日誌走 `src/logger.ts`：`~/.local/share/opencode/log/remote-notifier.log`（`REMOTE_NOTIFIER_LOG`
  覆寫；2 MiB 輪至 `.log.1`；寫檔失敗最多三次 console.error 後靜默）——插件沒有官方 log API，
  背景服務的 stdout 也不是 log，console 輸出在生產上不可見，這個檔案是唯一的審計線
- 用戶設定走 XDG 路徑 `~/.config/opencode/remote-notifier.json`，repo 內只有範本；**勿動用戶設定**
- OpenCode 源碼參考：`/path/to/opencode-source`
