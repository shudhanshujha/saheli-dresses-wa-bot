# openwa-bot

A WhatsApp Bot built on [OpenWA](https://github.com/open-wa) — a Node.js automation framework for WhatsApp Web. Features a modern web dashboard, plugin system, campaign management, conversation flows, and MCP/AI support.

## Quick Start

### Prerequisites
- Node.js 18+
- Google Chrome (installed at default path `C:\Program Files\Google\Chrome\Application\chrome.exe`)
- A WhatsApp account paired via QR code on first launch

### Setup

```bash
npm install
cp .env.example .env
# Secure option: run the setup script to set env vars at OS level
# .\setup-env.ps1
# Then start the bot
npm start
```

The dashboard is available at `http://localhost:8080`. First launch shows a QR code for WhatsApp pairing.

## Project Structure

```
openwa-bot/
├── launcher.mjs              # Main bot — Express server + all API endpoints
├── wa.config.mjs             # OpenWA configuration (session, plugins, MCP)
├── package.json              # Dependencies and npm scripts
├── .env.example              # Environment variable template
├── .gitignore
├── src/
│   ├── main.mjs              # Alternate entry (direct open-wa create() API)
│   ├── broadcast.mjs         # Broadcast utility helper
│   └── webhook-receiver.mjs  # Incoming webhook handler
├── public/
│   ├── index.html            # Dashboard SPA shell
│   ├── style.css             # Dark theme styles (custom properties)
│   └── app.js                # Frontend — chat, campaigns, analytics, plugins, flows
├── plugins/
│   ├── greeting-bot.mjs      # Keyword-triggered greeting auto-reply
│   └── moderation.mjs        # Word-based message moderation (block/warn)
├── webhooks/                 # Webhook endpoint definitions
└── data/                     # Persistent JSON data (.gitignored)
    ├── campaigns.json        # Campaign storage
    ├── flows.json            # Conversation flow definitions
    └── templates.json        # Message templates with {{variable}} placeholders
```

## API Reference

### Messaging

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/chats?limit=N` | — | Array of recent chats |
| `GET` | `/api/messages/:chatId?page=1&limit=50` | — | Paginated message array |
| `POST` | `/api/send` | `{ chatId, text }` | `{ success }` |
| `POST` | `/api/send/bulk` | `{ chatIds, text, delayMs? }` | Results array |
| `POST` | `/api/send/media` | `{ chatId, base64, filename?, caption? }` | `{ success }` |
| `POST` | `/api/send/reply` | `{ chatId, messageId, text }` | `{ success }` |
| `POST` | `/api/send/tag` | `{ chatId, messageId, text, tag }` | `{ success }` |
| `POST` | `/api/send/sticker` | `{ chatId, stickerId }` | `{ success }` |
| `DELETE` | `/api/messages/:chatId` | — | Clear all messages for chat |

### Groups (excludes Community channels)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/groups` | — | Array of groups (participant counts, descriptions) |
| `GET` | `/api/groups/:id` | — | Group detail + participants list |
| `POST` | `/api/groups/create` | `{ name, participants?: string[] }` | `{ id, name }` |
| `POST` | `/api/groups/:id/add` | `{ participants: string[] }` | `{ success }` |
| `POST` | `/api/groups/:id/remove` | `{ participantId }` | `{ success }` |
| `POST` | `/api/groups/:id/set-title` | `{ title }` | `{ success }` |
| `POST` | `/api/groups/:id/set-description` | `{ description }` | `{ success }` |
| `POST` | `/api/groups/:id/push-all` | `{ message }` | `{ success, sent, failed }` |

**Note:** Community announcement channels (`@lid`, `@newsletter` IDs) are filtered out from group endpoints because they lack standard group management APIs.

### Contacts & Labels

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/contacts` | Array of all contacts |
| `GET` | `/api/contacts?search=term` | Filtered by name/number |
| `GET` | `/api/contact/:id` | Contact detail |
| `GET` | `/api/profile-pic/:contactId` | SVG profile picture (with hash-based fallback) |
| `GET` | `/api/labels` | Array of WhatsApp labels |
| `GET` | `/api/labels/:id/messages` | Messages in a label |
| `POST` | `/api/contacts/import` | Import CSV or JSON contacts |

### Campaigns & Templates

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/campaigns` | — | Campaign list with progress |
| `POST` | `/api/campaigns` | `{ name, message, contacts[], groupIds[]? }` | Campaign object |
| `POST` | `/api/campaigns/:id/start` | — | Start campaign |
| `DELETE` | `/api/campaigns/:id` | — | Delete campaign |
| `GET` | `/api/campaign-templates` | — | Saved campaign configs |
| `POST` | `/api/campaign-templates` | `{ name, message, targetType?, targetFilter? }` | Template object |
| `DELETE` | `/api/campaign-templates/:id` | — | Delete template |
| `GET` | `/api/templates` | — | Message template list |
| `POST` | `/api/templates` | Template object | Created template |

### Analytics

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/analytics` | Stats: chats, contacts, groups, messages, unread, campaigns, templates, scheduled, topChats |
| `GET` | `/api/charts/overview` | `{ messagesByDay[], activeChatsPerDay, msgStoreCount }` |

### Auto-Reply & Flows

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/auto-reply` | — | Rule list |
| `POST` | `/api/auto-reply` | Rule object | Created rule |
| `PUT` | `/api/auto-reply/:id` | Partial rule | Updated rule |
| `DELETE` | `/api/auto-reply/:id` | — | — |
| `GET` | `/api/flows` | — | Flow list |
| `POST` | `/api/flows` | Flow object | Created flow |
| `PUT` | `/api/flows/:id` | Partial flow | Updated flow |
| `DELETE` | `/api/flows/:id` | — | — |
| `POST` | `/api/flows/:id/trigger` | `{ chatId, input }` | Flow execution result |

### Scheduled Messages

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/scheduled?tab=upcoming\|history&status=...&search=...` | — | `{ items, stats }` |
| `POST` | `/api/scheduled` | Schedule object | Created schedule |
| `PUT` | `/api/scheduled/:id` | Partial update | Updated schedule |
| `DELETE` | `/api/scheduled/:id` | — | — |
| `POST` | `/api/scheduled/:id/pause` | — | — |
| `POST` | `/api/scheduled/:id/resume` | — | — |

### Webhooks

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/webhooks` | — | Webhook list |
| `POST` | `/api/webhooks` | `{ url, events[], secret? }` | Created webhook |
| `DELETE` | `/api/webhooks/:id` | — | — |
| `POST` | `/api/webhooks/:id/trigger` | `{ chatId, event }` | Trigger result |

### Other

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/status` | `{ connected, uptime, queueSize }` |
| `GET` | `/api/search?q=term&limit=20` | Message search results |
| `GET` | `/api/unread-count` | `{ count }` |
| `GET` | `/api/export/:chatId` | Full chat export (JSON) |
| `GET` | `/api/sessions` | List active sessions |
| `POST` | `/api/sessions/create` | Create new session |
| `POST` | `/api/sessions/:id/terminate` | Terminate session |

## Frontend Dashboard Views

- **Chats** — message list, search, infinite scroll, send text/media
- **Groups** — group cards, view participants, message groups
- **Contacts** — search, tag filtering, CSV/JSON import
- **Campaigns** — create broadcasts, track progress per recipient
- **Auto-Reply** — keyword rules with exact/contains/starts-with matching
- **Flows** — visual conversation state machines (send/wait/end steps)
- **Templates** — message templates with `{{variable}}` substitution
- **Scheduled** — create, pause, resume, delete scheduled messages
- **Analytics** — stat cards (chats, contacts, groups, messages, campaigns, etc.)

### Frontend Features
- File upload via paperclip button or Ctrl+V (clipboard images → base64 → `/api/send/media`)
- Chat search filters by name or ID
- Infinite scroll loads more messages on scroll-up
- Tag mentions (`@tag`) and reply threads supported

## Plugin System

### Built-in Plugins

**greeting-bot.mjs** — Responds to trigger words with a welcome message.
- Config keys in `wa.config.mjs` → `pluginConfig.greeting-bot`:
  - `triggerWord` (default `"Hi"`)
  - `greeting` (default `"Welcome! How can I help?"`)

**moderation.mjs** — Blocks or warns on messages containing flagged words.
- Config keys → `pluginConfig.moderation`:
  - `enabled` (default `true`)
  - `blockedWords` (default `["spam", "scam"]`)
  - `maxMessageLength` (default `5000`)

### Writing Custom Plugins

Plugins are ES modules in the `plugins/` directory. Hook into two event types:
- `message.received` — inbound messages
- `message.sent` — outbound confirmations

Example skeleton:

```js
// plugins/your-plugin.mjs
export const name = 'your-plugin';
export const hooks = ['message.received'];

export async function onMessageReceived(msg, client) {
  const body = msg.body || '';
  if (body.includes('hello')) {
    await client.sendText(msg.from, 'Hey there!');
  }
}
```

Register in `wa.config.mjs`:

```js
plugins: [
  new URL('./plugins/your-plugin.mjs', import.meta.url).href,
],
```

## WhatsApp Communities

WhatsApp Community chats and announcement channels (identified by `@lid` or `@newsletter` in their IDs) are **filtered out** from group management endpoints (`/api/groups`). These channel types do not support the standard group management APIs (add/remove participants, set title/description) and calling them on community chats causes errors.

## Security

- **Supabase session auth** — the dashboard requires a login password. Sessions are stored in Supabase with 24-hour expiry and are encrypted.
- **Encrypted sensitive data** — contact notes and message bodies are encrypted at rest in Supabase using AES-256-GCM (set `ENCRYPTION_KEY` env var).
- **Row Level Security (RLS)** — enabled on all Supabase tables; sessions, contacts, and messages are access-controlled per user/session.
- **No hardcoded keys** — Supabase keys and encryption keys are set as system environment variables, never stored in `.env` or committed to version control.
- **Setup script** — run `.\setup-env.ps1` to securely set environment variables at the OS level.
- **API key** — set `WA_API_KEY` in `.env`; endpoints check the `x-api-key` header.
- **Session data** — stored in `session-data/` and `.node-persist/` — these contain sensitive WhatsApp session tokens. Never expose them publicly.
- **Never commit `.env`** — it is gitignored and should only contain non-sensitive defaults.
- **Production** — use a reverse proxy (nginx, Caddy, Cloudflare Tunnel) with Basic Auth or TLS for production exposure.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| QR code not shown | Ensure Chrome is installed at the configured path; no other WhatsApp Web session on your phone |
| Session expires | Re-scan QR code; or delete `session-data/` + `.node-persist/` to start fresh |
| Groups endpoint errors on community chats | Community channels (`@lid`, `@newsletter`) are filtered out. This is expected. |
| Analytics shows 0 messages | The `messageCount` depends on WhatsApp sync; verify data by calling `/api/chats` |
| Dashboard shows nothing | Check if the bot is connected (`/api/status` → `connected: true`) |
| `npm start` fails | Run `npm install` first; ensure Node.js 18+ is installed |

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Launch the bot (uses `src/main.mjs`) |
| `npm run api` | Launch standalone OpenWA API instance |
| `npm run webhook` | Start webhook receiver separately |
| `npm run dev` | Watch mode for development |

## Dependencies

- `@open-wa/wa-automate` — WhatsApp Web automation engine
- `@open-wa/plugin-sdk` — Plugin SDK for custom hooks
- `express` — HTTP server for dashboard + API
- `dotenv` — Environment variable loading

## License

ISC