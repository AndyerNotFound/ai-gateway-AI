# ai-gateway — one endpoint for every AI API dialect

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="ai-gateway: clients speaking the OpenAI, Claude or Gemini formats connect to one local gateway, which converts every direction and routes to any upstream with per-channel proxies, key round-robin and failover">
</p>

A **zero-dependency** Node.js gateway (born on Termux, happy on any Linux / macOS box): accept requests from **any** AI client, serve them from **any** upstream — OpenAI, Claude, and Gemini formats are converted in every direction, streaming included. Outbound traffic can ride a per-channel **SOCKS5 / HTTP proxy**.

```text
Client (any dialect)                       Upstream (any dialect)
OpenAI ──┐                            ┌──▶  OpenAI official / DeepSeek / relays / llama.cpp
Claude ──┼──▶  ai-gateway :16384  ────┼──▶  Gemini official
Gemini ──┘    convert ⇄ redact       └──▶  Claude official
              balance ⇄ proxy              direct, or per-channel SOCKS5 / HTTP proxy
```

- **Clients stay unchanged** — ChatBox, NextChat, Claude Code, and the OpenAI / Anthropic / Google SDKs all just point at the gateway.
- **Same format = byte-for-byte passthrough**; mixed formats get full conversion — streaming SSE, tool calls, images, thinking content, token accounting.
- **Keys stay flexible** — one model name on several channels: round-robin rotation, automatic failover on 429 / 401 / 5xx / connection errors, invisible switching.
- **Zero npm dependencies** — if Node.js runs, it runs. No `npm install`, no build step.

---

## Quick start

Needs Node.js 18+. Install from a checkout:

```bash
git clone https://github.com/AndyerNotFound/ai-gateway-AI.git ~/ai-gateway
cd ~/ai-gateway
cp data/config.example.json data/config.json   # then add one channel + its API key
bash agw.sh start
```

…or one-shot (Termux / Linux / macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/AndyerNotFound/ai-gateway-AI/main/install.sh | bash
```

Smoke test:

```bash
curl http://127.0.0.1:16384/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'
```

## Speak any dialect

Point existing apps at the gateway — no code changes; whatever the client speaks reaches any upstream:

| Client speaks | Endpoint | Typical clients |
|---|---|---|
| OpenAI | `POST /v1/chat/completions` · `GET /v1/models` | ChatBox, NextChat, openai SDK, most "custom OpenAI" apps |
| Claude | `POST /v1/messages` | Claude Code, anthropic SDK |
| Gemini | `POST /v1beta/models/{model}:generateContent` (`:streamGenerateContent` for SSE) | Google AI SDKs |

`<host>` is the machine or phone running the gateway (`127.0.0.1` locally, its LAN IP for other devices — `ip -4 addr`). If `gatewayKey` is set, it is accepted anywhere a key belongs: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, or `?key=`.

## Routing, conversion, balancing

```jsonc
// data/config.json (excerpt)
{
  "listen": { "host": "0.0.0.0", "port": 16384 },
  "gatewayKey": "",                      // set a password before exposing LAN / internet
  "proxies": {
    "clash": { "type": "socks5", "host": "127.0.0.1", "port": 7890 }
  },
  "channels": [
    { "name": "gemini-official", "type": "gemini",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza...", "proxy": "clash", "models": ["gemini-2.5-flash"] },
    { "name": "deepseek-key1", "type": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...", "models": ["deepseek-chat"], "default": true },
    { "name": "deepseek-key2", "type": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...", "models": ["deepseek-chat"] }
  ]
}
```

- **Model → channel**: exact hit in `modelMap` → the `models` list → the `default` channel → the first channel. `modelMap` renames too: `{"gpt-4o": "gemini-2.5-flash"}` serves a Gemini model to a GPT client.
- **Conversion covers streaming, tool calls, images, thinking content, and usage/token accounting.** A failing channel (429 / 401 / 500–504 / connection error) transparently retries on the next one; genuine client errors (`400`) come back as-is. Once a stream has started, the current channel is locked in.
- **Per-channel egress**: each channel can route through its own proxy (`"proxy": "clash"`), so Gemini/Claude can exit somewhere else than DeepSeek. `insecure: true` tolerates self-signed relays.
- **Context guard**: per-model caps via `bash agw.sh ctxp 'deepseek-*' max 200k warn 160k` — force-truncate or warn before an oversized request burns quota.

### Privacy filter

On by default for requests; `redact.response: true` also masks the response direction.

- Masks values under sensitive fields (`api_key`, `token`, `password`, `authorization`, …) and pattern-matches built-ins: `sk-` keys, GitHub / Slack / AWS / Google / GitLab / HuggingFace tokens, `Bearer` headers, emails, mainland-China mobile numbers, national IDs, bank cards (Luhn-validated), private IPv4.
- **Streaming-safe**: SSE chunks are filtered so secrets split across fragments are still caught.
- **Fast path**: text without sensitive traits skips regex entirely; long contexts use a chunk-level cache that recomputes only changed parts.
- Custom rules: `redact.extra` regexes, editable in the panel, hot-reloaded.

## Managing the gateway

One process hosts every instance; create / rename / start / stop / edit instances hot from the panel — no restarts.

```bash
bash agw.sh start | stop | restart | status | list | logs | show
bash agw.sh config <instance> add | list | remove | set-port | set-key   # channels from the terminal
bash agw.sh ctxp 'model-*' max 200k warn 160k                            # context guard
```

- **Web panel** — `http://<host>:16384/auth`, sign in with the instance `webToken`. Material 3 UI, mobile bottom bar, 8 interface languages: overview, providers, routing, context limits, ports, sessions, key cards, stats (canvas charts), requests, logs, chat. Optional Material You color bridge (`mduCmd` or `mdu.json` → `GET /admin/api/mdu`) to tint the panel like your phone.
- **Key cards** — issue prepaid card keys (generate / charge / ban, registration on/off) so other people can use a model without ever seeing a channel key; holders get self-service pages under `/auth`.
- **HTTPS without root** — `agw-tls setup` for a one-shot enable, `agw-tls all --pure` to serve HTTPS on every instance port: local private CA, per-device trust, automatic re-sign on IP change, <7-day certificate auto-renew and 90-day client-key rotation driven by `ops/guard.sh`. `agw-tls status` / `agw-tls use` for state and ready-made client snippets.
- **Config encryption & portability** — encrypt config files at rest, export / import as JSON or QR code (`bash agw.sh config`).
- **Docker** — `docker compose up -d` (port 16384, state in the `ai-gateway-data` volume).

### OpenAI extended endpoints (opt-in)

```jsonc
"openaiExtras": { "enable": true, "upstreamResponses": false }
```

Exposes `POST /v1/responses` — a full conversion endpoint (streaming, tool calls, reasoning) between Responses and Chat/Claude/Gemini bodies — plus passthrough `images`, `embeddings`, `audio/speech`, `audio/transcriptions`, `audio/translations`, `completions`, and `moderations` for OpenAI-type channels. Channel-level `useResponses: true` lets an OpenAI upstream speak the Responses API. Off by default; restart after enabling.

## Security notes

1. `0.0.0.0` + empty `gatewayKey` means anyone on the Wi-Fi can spend your keys. Set `gatewayKey` before LAN / internet exposure; use `127.0.0.1` for localhost-only.
2. Public paths are whitelisted: only `/v1`, `/v1beta`, `/auth`, `/profile`, and `/admin` exist — everything else 404s.
3. Config files hold your (optionally encrypted) upstream keys; do not share the directory.
4. Redaction is on by default; a key card can opt out with `redact=false`, but the instance setting is the ceiling.

## Project layout

```text
ai-gateway-AI/
├── gateway.js        # entry: one process, every instance
├── server.js …       # routing, conversion, balancing, redaction — one focused module each
├── m3/               # web panel (Material 3, vanilla ESM, zero CDN)
├── agw.sh / agw-tls  # lifecycle + HTTPS management
├── data/             # config.json per instance, logs, pids
├── tls/  ops/        # private-CA scripts, renewal / rotation watchdog
└── test/             # sandbox test suite
```

Tests: `node test/balance_test.js` (77 balance-passthrough / routing assertions) and `node test/redact_test.js` (37 redaction cases) run anywhere; the full converter matrix (all 9 dialect pairs, streaming and not) and proxy/auth/failover E2E run in the maintainer's sandbox — 215/215.

## License

[GPL-3.0](LICENSE)
