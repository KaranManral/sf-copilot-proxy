# sf-copilot-proxy

A tiny local HTTP proxy that lets **GitHub Copilot** use the **Salesforce Models
API** — both the **Claude** models (via the native Anthropic Messages API) and
the Salesforce-hosted **OpenAI/GPT** models (via the OpenAI Responses API or
Chat Completions API). It exposes three endpoints:

- `POST /v1/messages` — Anthropic Messages → Salesforce Bedrock *invoke* path
  (Claude models).
- `POST /v1/responses` — OpenAI **Responses** API → Salesforce `/responses`
  path (GPT models). Near-passthrough: the client already speaks Responses, so
  the proxy only remaps the model alias and sanitizes params. This is the
  **reasoning-capable, forward-looking** path and is intended to eventually
  replace chat-completions.
- `POST /v1/chat/completions` — OpenAI Chat Completions → Salesforce
  `/responses` path (GPT models). The proxy translates the chat-completions
  wire shape into `/responses` and back. Also reasoning-capable. The older
  `/chat/generations` translation is kept in the code as a revertible fallback
  (`handleChatCompletionsViaGenerations`) but is **not** wired to a route —
  note it does **not** support reasoning (`reasoning_effort` is a no-op there).

These GPT models are **not** on Bedrock; they route through the Geo-aware
`/responses` endpoint, which has a different request/response shape the proxy
translates in both directions.

It bridges the incompatibilities that block Copilot's built-in BYOK from
talking to Salesforce directly:

1. **Wire shape.** Copilot sends native Anthropic `POST /v1/messages` (model in
   the JSON body, `anthropic-version` header). Salesforce only speaks the
   Bedrock *invoke* shape — model in the **URL path**
   (`/model/<alias>/invoke[-with-response-stream]`), body carrying
   `anthropic_version: bedrock-2023-05-31`, streaming responses framed as AWS
   `vnd.amazon.eventstream`. The proxy rewrites the request and decodes the
   event-stream back into standard Anthropic SSE.
2. **Auth.** Salesforce needs a short-lived **OrgJWT** (~2 h) minted via the
   OAuth 2.0 `client_credentials` flow. Copilot only holds a static key. The
   proxy mints and auto-refreshes the OrgJWT itself, so Copilot just points at a
   fixed localhost URL with a static local key.

It also strips the `thinking` block from requests, which the Salesforce Bedrock
backend rejects with `502 "No user context has been created"` on Sonnet/Opus.

## Requirements

- Node.js >= 22.6 (runs `.ts` directly via Node's native type stripping — no build step). Node 24 recommended.
- A Salesforce connected app with the `sfap_api` scope and the
  `client_credentials` flow enabled, plus its consumer key/secret.

## Setup

```bash
cd sf-copilot-proxy
cp .env.example .env      # then fill in SF_INSTANCE_URL / SF_CLIENT_ID / SF_CLIENT_SECRET
```

Generate a local shared secret and put it in `.env` as `PROXY_API_KEY` (any
random string). This is the "API key" you give Copilot; it stops anything else
on the machine from spending your Salesforce quota.

## Run

```bash
npm start          # or: node src/server.ts
npm run dev        # auto-restart on file changes
```

### Run as an always-on background service (pm2)

For a service that survives crashes and reboots, run it under
[pm2](https://pm2.keymetrics.io/) instead of a terminal. This repo ships a pm2
config (`ecosystem.config.cjs`).

```bash
npm install -g pm2
cd sf-copilot-proxy
pm2 start ecosystem.config.cjs   # launch under pm2
pm2 save                         # snapshot the process list to ~/.pm2/dump.pm2
```

- `autorestart` is on, so pm2 relaunches the proxy if it crashes.
- Logs go to `logs/out.log` and `logs/error.log` (git-ignored). Tail them with
  `pm2 logs sf-copilot-proxy`.

**Start on boot (Windows).** `pm2 startup` is not supported on Windows, so a
logon script does the job instead. This machine has one at:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\sf-copilot-proxy.cmd
```

It runs `pm2 resurrect`, which restores whatever `pm2 save` last snapshotted.
So the workflow is: get the process list how you want it, then run `pm2 save` —
the logon script brings that exact state back after every reboot. (Registering a
Task Scheduler task is blocked on this managed machine, hence the Startup-folder
approach.)

**Common pm2 commands:**

| Command                          | What it does                                  |
|----------------------------------|-----------------------------------------------|
| `pm2 status` / `pm2 list`        | Show the proxy's state, uptime, restarts.     |
| `pm2 logs sf-copilot-proxy`      | Tail stdout/stderr.                           |
| `pm2 restart sf-copilot-proxy`   | Restart (e.g. after editing `.env` or code).  |
| `pm2 stop sf-copilot-proxy`      | Stop without removing from the list.          |
| `pm2 delete sf-copilot-proxy`    | Remove it from pm2 (then `pm2 save`).         |
| `pm2 resurrect`                  | Restore the saved process list (boot script). |

After editing `.env` or the code, run `pm2 restart sf-copilot-proxy` to load the
change (`pm2 save` alone does **not** — it only snapshots the process list, not
file contents). Then run `pm2 save` so the current state is what `pm2 resurrect`
restores on reboot.

You should see:

```
sf-copilot-proxy listening on http://127.0.0.1:8787
[token] minted OrgJWT, valid ~119 min
```

Quick check:

```bash
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: <PROXY_API_KEY>" \
  -d '{"model":"claude-sonnet-5","max_tokens":32,"messages":[{"role":"user","content":"say pong"}]}'
```

## Wire it into GitHub Copilot

In VS Code: **Copilot Chat → model picker → Manage Models… → Add model → Custom
Endpoint**. Add the proxy once per API type you want to use:

| Field           | Claude models                       | GPT models (recommended)      | GPT models (legacy)                       |
|-----------------|-------------------------------------|-------------------------------|-------------------------------------------|
| Base URL / URL  | `http://127.0.0.1:8787`             | `http://127.0.0.1:8787`       | `http://127.0.0.1:8787`                   |
| API type        | Anthropic Messages (`/v1/messages`) | Responses (`/v1/responses`)   | OpenAI-compatible (`/v1/chat/completions`)|
| API key         | your `PROXY_API_KEY`                | your `PROXY_API_KEY`          | your `PROXY_API_KEY`                      |
| Model id        | e.g. `claude-sonnet-5`              | e.g. `gpt-5.4`                | e.g. `gpt-5.4`                            |

The exact field names shift between Copilot versions; what matters is the
localhost base URL, the API type, and the key. All endpoints share the same
base URL and key — Copilot picks the path from the API type you select.

**Which GPT API type to pick.** Prefer **Responses** (`/v1/responses`): it is a
near-passthrough, supports reasoning, and lets Copilot render reasoning
summaries natively. Chat Completions still works and is also reasoning-capable
via the proxy, but carries only a reasoning-token count, not the reasoning
content. Both GPT paths reach the same Salesforce `/responses` backend, so you
can register both and A/B them.

### `chatLanguageModels.json` examples

Alternatively, add the following provider entries to your VS Code
`chatLanguageModels.json`. The file is usually opened with **Copilot Chat →
Manage Models… → Configure Models**, or can be found under your VS Code user
data directory.

Replace the `${input:chat.lm.secret.…}` values with your own VS Code input
variable names, or use a literal local key if your setup requires it. The
value must match `PROXY_API_KEY` in `.env`.

#### Salesforce Anthropic models

```json
{
  "name": "SF_Anthropic",
  "vendor": "customendpoint",
  "apiKey": ".env_apikey",
  "apiType": "messages",
  "models": [
    {
      "id": "sfdc_ai__DefaultBedrockAnthropicClaude5Sonnet",
      "name": "Sonnet 5",
      "url": "http://127.0.0.1:8787",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 1000000,
      "maxOutputTokens": 128000
    }
  ]
}
```

#### Salesforce OpenAI GPT models — Responses API (recommended)

Set `"apiType": "responses"` so Copilot posts to `/v1/responses`:

```json
{
  "name": "SF_OpenAI",
  "vendor": "customendpoint",
  "apiKey": ".env_apikey",
  "apiType": "responses",
  "models": [
    {
      "id": "sfdc_ai__DefaultGPT56Luna",
      "name": "GPT 5.6 Luna",
      "url": "http://127.0.0.1:8787",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 1050000,
      "maxOutputTokens": 128000
    }
  ]
}
```

To use the legacy Chat Completions path instead, keep the same block but set
`"apiType": "chat-completions"` (Copilot then posts to `/v1/chat/completions`).
Both reach the same Salesforce `/responses` backend through the proxy.

These are array elements, not a complete file. Keep the existing Copilot
provider entry and add both objects inside the top-level JSON array. Model IDs
must match the proxy's Salesforce aliases; display names can be changed freely.

## Available models

These are the routes verified to work on this org (older Bedrock routes 502 on
the thinking/beta flags and are intentionally omitted):

| Model id (send this)   | Routes to Salesforce alias                         |
|------------------------|----------------------------------------------------|
| `claude-opus-4-8`      | `sfdc_ai__DefaultBedrockAnthropicClaude48Opus`     |
| `claude-opus-4-7`      | `sfdc_ai__DefaultBedrockAnthropicClaude47Opus`     |
| `claude-opus-4-6`      | `sfdc_ai__DefaultBedrockAnthropicClaude46Opus`     |
| `claude-sonnet-5`      | `sfdc_ai__DefaultBedrockAnthropicClaude5Sonnet`    |
| `claude-sonnet-4-6`    | `sfdc_ai__DefaultBedrockAnthropicClaude46Sonnet`   |

You can also send a full `sfdc_ai__…` alias directly — it passes through
unchanged. Edit `MODEL_MAP` in `src/config.ts` to add or rename entries.

### OpenAI / GPT models (send to `/v1/responses` or `/v1/chat/completions`)

| Model id (send this) | Routes to Salesforce alias      |
|----------------------|---------------------------------|
| `gpt-5.6-luna`       | `sfdc_ai__DefaultGPT56Luna`     |
| `gpt-5.6-sol`        | `sfdc_ai__DefaultGPT56Sol`      |
| `gpt-5.6-terra`      | `sfdc_ai__DefaultGPT56Terra`    |
| `gpt-5.5`            | `sfdc_ai__DefaultGPT55`         |
| `gpt-5.4`            | `sfdc_ai__DefaultGPT54`         |
| `gpt-5.2`            | `sfdc_ai__DefaultGPT52`         |
| `gpt-5.1`            | `sfdc_ai__DefaultGPT51`         |
| `gpt-5`              | `sfdc_ai__DefaultGPT5`          |

Full `sfdc_ai__DefaultGPT*` aliases pass through unchanged. Edit `GPT_MODEL_MAP`
in `src/config.ts` to add or rename entries. Note the alias prefix decides
routing: `sfdc_ai__DefaultBedrockAnthropic*` uses the Bedrock invoke path,
`sfdc_ai__DefaultGPT*` uses `/responses`.

### Reasoning effort (GPT models)

Both GPT paths honor reasoning. On `/v1/responses` send
`reasoning: { effort: "<level>" }`; on `/v1/chat/completions` send either
`reasoning_effort: "<level>"` or `reasoning: { effort: "<level>" }`. Reasoning
tokens scale up with the level and are returned in the usage details.

Verified against the Salesforce `/responses` backend (gpt-5.4, and
gpt-5.6 luna/terra/sol):

| Level    | Backend support | Notes                                                        |
|----------|-----------------|--------------------------------------------------------------|
| `none`   | ✅              | No reasoning; sampling params (`temperature`/`top_p`) allowed. |
| `low`    | ✅              | Reasoning tokens emitted.                                     |
| `medium` | ✅              | Reasoning tokens emitted.                                     |
| `high`   | ✅              | Reasoning tokens emitted.                                     |
| `xhigh`  | ✅              | Highest tier the backend accepts.                            |
| `max`    | ⚠️ clamped      | Backend rejects `max` (`400 Unexpected value 'max'`). The proxy clamps `max` → `xhigh` and logs it, so Copilot's "max" selector works instead of failing. |

When reasoning is active (any level except `none`), the backend rejects
`temperature`/`top_p`, so the proxy drops them. An explicit `none` is normalized
away (the `reasoning` object is removed) so the backend doesn't reject it. The
`max` → `xhigh` clamp lives in `clampEffort()` in `src/responses.ts`; remove it
if Salesforce adds a distinct `max` tier.

## Configuration (`.env`)

| Var                 | Default                                  | Purpose                                        |
|---------------------|------------------------------------------|------------------------------------------------|
| `SF_INSTANCE_URL`   | —                                        | Your org's my.salesforce.com URL (for token).  |
| `SF_CLIENT_ID`      | —                                        | Connected-app consumer key.                    |
| `SF_CLIENT_SECRET`  | —                                        | Connected-app consumer secret.                 |
| `SF_MODELS_BASE_URL`| `https://api.salesforce.com/ai/gpt/v1`   | Models API base.                               |
| `SF_FEATURE_ID`     | `ai-platform-models-connected-app`       | `x-client-feature-id` header.                  |
| `SF_APP_CONTEXT`    | `EinsteinGPT`                            | `x-sfdc-app-context` header.                   |
| `HOST` / `PORT`     | `127.0.0.1` / `8787`                     | Local bind.                                    |
| `PROXY_API_KEY`     | *(empty = open)*                         | Shared secret Copilot must present.            |
| `STRIP_THINKING`    | `1`                                      | Drop `thinking` blocks (avoids the 502).       |

## Endpoints

- `POST /v1/messages` — translated Anthropic Messages endpoint for Claude models (streaming and non-streaming).
- `POST /v1/responses` — native OpenAI Responses endpoint for GPT models (streaming and non-streaming). Near-passthrough to Salesforce `/responses`; forwards `response.*` SSE frames verbatim.
- `POST /v1/chat/completions` — translated OpenAI Chat Completions endpoint for GPT models (streaming and non-streaming); translates to/from Salesforce `/responses`.
- `GET /health` — status + enabled model ids (both families).
- `GET /v1/models` — combined model list (for clients that probe it).

## Notes & limits

- Keep the process running while you use Copilot; there's no daemon/service
  wrapper. Wrap it with `pm2`, a Windows service, or a startup task if you want
  it always on.
- `.env` holds real secrets and is git-ignored — don't commit it.
- Extended **thinking is disabled** (required for these routes to work). If
  Salesforce later fixes the thinking-triggered 502, set `STRIP_THINKING=0`.
