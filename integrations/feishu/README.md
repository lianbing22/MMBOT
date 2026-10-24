# Feishu connector (`integrations/feishu`)

A zero-dependency MCP stdio server that gives MMBOT Bots Feishu (Lark) tools: send messages, list chats, read chat history and look up users. Authentication uses a self-built Feishu app (`FEISHU_APP_ID` / `FEISHU_APP_SECRET` → tenant access token, cached and refreshed ahead of expiry). Keys live only in environment variables and never appear in logs.

- **Quick start**: create a self-built app at `open.feishu.cn` with `im:message`, `im:chat:readonly`, `contact:user.id:readonly` scopes, then register the server with DSH as an MCP server:

  ```json
  { "mcpServers": { "feishu": { "command": "node", "args": ["/path/to/integrations/feishu/server.mjs"], "env": { "FEISHU_APP_ID": "cli_xxx", "FEISHU_APP_SECRET": "xxx" } } } }
  ```

  After restart, every Bot can call `feishu_send_message`, `feishu_list_chats`, `feishu_get_chat_history` and `feishu_get_user`.

- **Inspect without a Feishu app**: `node integrations/feishu/server.mjs --print-tools` prints the tool schemas as JSON.
- **Develop**: `cd integrations/feishu && node --test` — 24 tests run against a local mock, no network access.

The [Chinese README](README.zh.md) is the primary document: step-by-step app creation, the exact scopes, the DSH registration snippet, a parameter table for each tool, return and error structures, token/retry/timeout behavior, troubleshooting and security notes.
