# ai-gateway — Universal Local AI Gateway

A **zero-dependency** Node.js gateway running on Termux: one unified AI endpoint for local and LAN devices that
automatically converts between the **OpenAI / Gemini / Claude** API formats, with outbound traffic over **SOCKS5 / HTTP proxies**.

```
Client (any format)                     Upstream (any format)
OpenAI format ──┐                 ┌──▶ OpenAI official / DeepSeek / relays
Claude format ──┼──▶ ai-gateway ──┼──▶ Gemini official
Gemini format ──┘  (auto-convert) └──▶ Claude official
      localhost 127.0.0.1 + LAN IP        direct or SOCKS5/HTTP proxy (per channel)
```

- **One model name, callable three ways**: an OpenAI-format client can hit a Gemini/Claude upstream; the gateway converts requests/responses automatically (including streaming typewriter output, tool calls, images, thinking content, and token accounting)
- **Same-format passthrough**: when formats match, the request body is forwarded verbatim with zero loss
- **Multi-channel round-robin + failover**: configure the same model on several channels; requests rotate automatically, and a failing channel (rate limit / auth failure / server error) retries on the next one
- **Multiple instances**: one config file per instance, fully isolated
- Modular split (`gateway.js` entry + focused modules such as `convert/record/server/pool`), still **zero npm dependencies** — if Node.js runs, it runs

---

## 1. Quick start (3 steps)

```bash
# 1. Edit the config and fill in your API key
nano ~/ai-gateway/config.json

# 2. Start
~/ai-gateway/agw.sh start

# 3. Test
curl http://127.0.0.1:16384/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'
```

Management commands:

```bash
~/ai-gateway/agw.sh start     # start (all instances)
~/ai-gateway/agw.sh stop      # stop
~/ai-gateway/agw.sh restart   # restart after config changes
~/ai-gateway/agw.sh status    # show status
~/ai-gateway/agw.sh logs      # last 50 log lines
```

---

## 2. Configuration (config.json)

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 16384 },
  "gatewayKey": "",
  "maxBodyBytes": 67108864,
  "connectTimeout": 15000,
  "responseTimeout": 180000,
  "proxies": {
    "clash": { "type": "socks5", "host": "127.0.0.1", "port": 7890 }
  },
  "redact": { "enable": true, "response": false, "extra": ["badge[0-9]+"] },
  "channels": [
    {
      "name": "gemini-official",
      "type": "gemini",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza...",
      "proxy": "clash",
      "models": ["gemini-2.0-flash", "gemini-2.5-flash"]
    },
    {
      "name": "deepseek",
      "type": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "default": true
    }
  ]
}
```

| Field | Description |
|---|---|
| `listen.host` | `127.0.0.1` = localhost only; `0.0.0.0` = localhost + LAN (default) |
| `listen.port` | Listening port |
| `gatewayKey` | Password for the gateway itself (empty = no check). Once set, attach it anywhere: `Authorization: Bearer xxx`, `x-api-key: xxx`, or `?key=xxx` |
| `proxies` | Proxy list. `type` supports `socks5` / `http`, optional `username`/`password`. String form also works: `"clash": "socks5://127.0.0.1:7890"` |
| `channels[].type` | Upstream format: `openai` (OpenAI/DeepSeek/relays), `gemini`, `claude` |
| `channels[].baseUrl` | Official or relay address (write it without the trailing `/v1`, e.g. `https://api.deepseek.com`; a trailing `/v1` is also detected) |
| `channels[].apiKey` | The upstream key |
| `channels[].proxy` | Name of an entry in `proxies` to route through; `null` or omitted = direct |
| `channels[].models` | Model names this channel serves (a client's `model` matching here routes to it) |
| `channels[].modelMap` | Rename map: `{"gpt-4o": "gemini-2.0-flash"}` — a client asking for gpt-4o actually uses Gemini |
| `channels[].default` | `true` = fallback channel (requests that match no `models` go here, model name passed through untouched) |
| `channels[].insecure` | `true` = skip HTTPS certificate verification (for self-signed relays) |
| `redact.enable` | Privacy filter master switch (default `true`). A key card can set `redact=false` to opt out; the instance switch is the ceiling |
| `redact.response` | Also mask the response direction (default `false`): upstream content/thinking/tool args are replaced with `***` too |
| `redact.extra` | Custom regex array layered on top of the built-in rules (editable on the panel's Routing page) |

**Routing rule**: exact hit in `modelMap` > the `models` list > the `default` channel > the first channel.

### Privacy filter (sensitive-content masking)

- **Request direction**: before forwarding, the request body JSON is walked; strings under sensitive field names (`api_key`/`secret`/`token`/`password`/`authorization` etc.) are fully masked, other strings are masked per rule; `data:` URLs and the top-level `model` are untouched (protecting images and routing).
- **Response direction** (`redact.response=true`): upstream content, thinking chains, and tool arguments are masked the same way; streaming responses are filtered chunk by chunk, so secrets split across SSE fragments are still caught. When enabled, responses go through the unified conversion path for parseability (same-format traffic is no longer byte-for-byte passthrough).
- **Built-in rules**: `sk-`/GitHub/Slack/AWS/Google/GitLab/HuggingFace API keys, `Bearer` tokens, email addresses, mainland-China mobile numbers, national ID numbers, bank cards (masked only if they pass Luhn, so ordinary long numbers are safe), private IPv4.
- **Custom rules**: each entry in `redact.extra` is one regex, e.g. `"badge[0-9]+"`; editable on the panel's routing page (one per line), hot-reloaded on save.
- **Performance**: ordinary conversation without sensitive traits takes the fast path — no regex, no hashing; long contexts containing secrets use a multi-level CDC cache, recomputing only changed chunks.

### Multi-channel round-robin & failover

Configure the **same model name** on multiple channels; the gateway rotates requests across them and retries on the next channel when one fails:

```json
"channels": [
  { "name": "gemini-key1", "type": "gemini", "baseUrl": "...", "apiKey": "key1", "models": ["gemini-2.0-flash"] },
  { "name": "gemini-key2", "type": "gemini", "baseUrl": "...", "apiKey": "key2", "models": ["gemini-2.0-flash"] },
  { "name": "gemini-key3", "type": "gemini", "baseUrl": "...", "apiKey": "key3", "models": ["gemini-2.0-flash"] }
]
```

- **Round-robin**: 3 keys take turns -> request 1 uses key1, request 2 key2, request 3 key3, request 4 back to key1... no free quota is wasted
- **Failover**: if the current channel returns `429` (rate limit) / `401` (auth failure) / `500`-`504` (server error) or the connection fails -> automatically retry on the next channel, invisible to the user; errors surface only when everything fails
- **No switching**: client errors such as `400` (malformed request) do not switch — another channel would fail the same way; the error is returned as-is
- Streaming requests fail over too: no data has been sent to the client when the error code arrives, so switching is safe; once streaming output starts, the current channel is locked in

---

## 3. Three client styles (one gateway)

Assume the gateway is at `http://***:16384` (phone LAN IP; check with `ip -4 addr` or `ifconfig`).

### 1. OpenAI format (ChatGPT clients, openai SDK, ChatBox, NextChat, etc.)

```bash
curl http://127.0.0.1:16384/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://***:16384/v1", api_key="anything")
r = client.chat.completions.create(model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "hello"}], stream=True)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")
```

### 2. Claude format (Claude Code, anthropic SDK, etc.)

```bash
curl http://***:16384/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gemini-2.0-flash","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}'
```

### 3. Gemini format (Google AI SDK, etc.)

```bash
curl "http://***:16384/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: anything" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

> Model list: `GET /v1/models` (shared by OpenAI/Claude) or `GET /v1beta/models` (Gemini). Health check: probe the TCP port directly (`agw.sh status`).
> Public path whitelist: only `/v1`, `/v1beta`, `/auth`, `/profile` and their subpaths, plus `/admin` (the panel, webToken auth). Everything else returns 404 (`/health`, `/status`, `/user`, `/plugins`, `/credits` are closed; re-add when needed).

---

## 4. Multiple instances

Copy the config and change the port:

```bash
cp ~/ai-gateway/config.json ~/ai-gateway/config.proxy2.json
# Edit config.proxy2.json: change port to 16385, adjust channels/proxies
~/ai-gateway/agw.sh start proxy2
~/ai-gateway/agw.sh status        # both instances running
```

- Instance `default` uses `config.json`; other names use `config.<instance>.json`
- `agw.sh start` (no name) = start all instances
- Stop one instance: `agw.sh stop proxy2`

---

## 5. Common recipes

- **OpenAI-compatible relay**: `"type": "openai", "baseUrl": "https://relay.example.com"` (use the relay's key)
- **DeepSeek**: `"type": "openai", "baseUrl": "https://api.deepseek.com"`
- **Gemini official**: `"type": "gemini", "baseUrl": "https://generativelanguage.googleapis.com"` (needs a proxy in some regions)
- **Claude official**: `"type": "claude", "baseUrl": "https://api.anthropic.com"` (needs a proxy in some regions)
- **Local llama.cpp**: `"type": "openai", "baseUrl": "http://127.0.0.1:8080"` (direct)

---

## 6. Security notes

1. Listening on the LAN (`0.0.0.0`) means **any device on the same Wi-Fi can run models with your keys**.
   Set `"gatewayKey": "a-password"` and attach it anywhere on the client.
2. Config files contain plaintext keys; do not share the `ai-gateway` directory.
3. For localhost-only use, change `listen.host` back to `"127.0.0.1"`.

---

## 7. Layout & tests

```
~/ai-gateway/
├── gateway.js     # the gateway (single file, zero deps)
├── config.json    # default instance config
├── agw.sh         # management script
├── log/           # run logs (one per instance)
└── .run/          # pid files
```

Sandbox test suite: 215/215 passing — converter unit tests, 9 combination-conversion E2E pairs (streaming + non-streaming),
SOCKS5/HTTP proxy tunneling (with auth, HTTPS self-signed), gateway auth, channel routing, multi-instance,
round-robin (strict alternation), failover (429 / connection failure / non-retryable 400 / total failure).

### Admin panel (/auth)

The panel is split into three files, so styling/logic changes no longer touch a 300k-character single file:

```
m3/index.html   # structure (~500 lines) + two references
m3/app.css      # all styles (Material Design 3 tokens + responsive)
m3/app.js       # all frontend logic (data adapter / rendering / charts, native ESM)
m3/vendor/      # Material Web component bundle + icon font (local, zero CDN)
```

All three are served with `no-store`; refresh after editing. Capabilities: 12+2 pages (overview/providers/routing/context/window table/keys/key cards/ports/sessions/replacement/stats/requests/logs/chat);
the mobile bottom bar holds 5 common pages plus a "More" drawer, and every page stays reachable; the stats page has pure-canvas daily-usage and per-model charts.

**Color bridge (Material You primary)**: the panel's "Theme -> pick from phone" requests `GET /admin/api/mdu`; the backend resolves the color in this order:

1. The `mduCmd` config key (or the `AGW_MDU_CMD` env var) — a shell command with a 2.5s timeout;
2. `~/ai-gateway/mdu.json` (written periodically by the bridge itself, avoiding command overhead).

Both methods accept exactly one of these outputs: `#4C6B3C`, `{"primary":"#4C6B3C"}`, `{"tokens":{"primary":"#4C6B3C"}}`.
When nothing works, the panel falls back to "pick a wallpaper image and extract the primary color in the browser" instead of hanging.

```jsonc
// config.json
{ "mduCmd": "my-color-bridge --json" }
```

## 8. HTTPS access (no root)

**Daily use needs one command: `agw-tls` (status), `agw-tls setup` (one-shot enable), `agw-tls use` (client snippets).**
Certificates exported by `agw-tls trust` are auto-deleted after 5 minutes by default (adjust with `--keep N`).
Enable everywhere: `agw-tls all --pure` (each instance serves HTTPS only on its existing port, 38 entries total); `agw-tls all` dual-stacks instead (https = http + 10000).

Without root you cannot get port 443, but each instance can serve HTTPS on its own high port (single-port or dual-stack). Recommended: a local private CA + a user trust store —
install the CA on each device once, and afterwards IP changes only need the server certificate re-signed.

```bash
cd ~/ai-gateway
bash tls/gen-ca.sh                    # create the private CA (once)
bash tls/gen-server.sh                # issue cert.pem (SAN auto-includes every local IP)
agw-tls all --pure                    # all instances: original ports switch to pure HTTPS (current state)
./agw.sh restart
```

Client essentials: Python `httpx.Client(verify="ca.pem")`, Node `NODE_EXTRA_CA_CERTS=ca.pem`,
curl `--cacert ca.pem`; on phones/computers install `tls/ca.pem` as a "CA certificate".

Full guide (per-platform install, SDK examples, IP changes, troubleshooting, security): [docs/HTTPS.md](docs/HTTPS.md)

Certificate auto-renewal (<7 days triggers) and client key rotation (90 days default, 14-day grace) are driven every 5 minutes by the watchdog:
`bash ops/guard.sh` (logs in `log/tls.log`, `log/keyrotation.log`).

---

## OpenAI extended endpoints (Responses / Images / Embeddings / Audio / Completions)

> Since: 2026-09-06. Off by default (backward compatible); see below for enabling.

### Config switches (top level of config.json)

```json
{
  "openaiExtras": {
    "enable": false,            // master switch: expose extended endpoints + allow OpenAI upstreams to use the Responses API
    "upstreamResponses": false  // global default: OpenAI channels use /v1/responses upstream instead of /v1/chat/completions
  }
}
```

Channel-level override (add a field to one OpenAI channel):

```json
{ "name": "my-resp", "type": "openai", "baseUrl": "...", "useResponses": true }
```

- A channel's `useResponses` follows the global `upstreamResponses` when unset; openai-type channels only; effective only when `enable=true`.
- Restart the instance after saving: `bash agw.sh restart <instance>` (the m3 panel restarts automatically on save).

### New gateway endpoints (when enable=true)

| Endpoint | Description |
|---|---|
| `POST /v1/responses` | OpenAI Responses API entry (streaming SSE supported), auto-converts with Chat Completions / Claude / Gemini |
| `POST /v1/images/generations` | Image generation (passthrough to openai channels, JSON) |
| `POST /v1/images/edits` `POST /v1/images/variations` | Image edits/variations (multipart passthrough) |
| `POST /v1/embeddings` | Text embeddings (passthrough) |
| `POST /v1/audio/speech` | TTS (passthrough, binary/streaming) |
| `POST /v1/audio/transcriptions` `POST /v1/audio/translations` | Speech transcription/translation (multipart passthrough) |
| `POST /v1/completions` | Legacy text completions (passthrough) |
| `POST /v1/moderations` | Content moderation (passthrough) |

- Extended passthrough endpoints support openai-type channels only (routed by body.model; modelMap renames apply to JSON endpoints, not multipart); 503 when no channel matches.
- `/v1/responses` is a full conversion endpoint: client Responses <-> upstream Chat/Responses/Claude/Gemini in any combination, including streaming, tool calls, and reasoning.
- With the switch off, all of the above return 404 (matching old behavior).

### Upstream selection matrix

| Client API | Upstream useResponses=false | Upstream useResponses=true |
|---|---|---|
| Chat Completions | passthrough (original behavior) | canonical conversion -> Responses body |
| Responses | canonical conversion -> Chat body | passthrough |
| Claude / Gemini | canonical conversion | canonical conversion -> Responses body |

## Changelog

### 2026-10-27 — Privacy filter upgrade (response direction + more rules + performance)

- Added `redact.response`: masks response content/thinking/tool args; no leaks across streaming fragments; new panel switch.
- Added email/mobile/national-ID/bank-card/private-IPv4 rules; `redact.extra` is panel-editable (one regex per line).
- Fixed: a panel save sending only `{enable}` wiped `extra`; long tokens split across CDC cut points leaked unmasked; chunk fingerprints did not cover the tail deferred by safe cut points.
- Performance: text without sensitive traits takes the prefix/digit fast path (one character scan, ~1ms for an 85KB context; zero regex, zero allocation on a hit); the 13+ built-in rules merged into a single regex pass.
- The top-level `model` field no longer participates in masking, so model names are never rewritten and routing stays intact.

### 2026-10-16 — DSML markup leak fix (thinking chain and tool calls disjointed)

- **Symptom**: some DeepSeek-lineage upstreams (e.g. NVIDIA NIM) wrote tool calls as text inside `content`, like
  `<｜DSML｜tool_calls>...`; the gateway swallowed the whole block as markup, leaving thinking but no tool call, breaking the chain.
- **Root cause**: that dialect only prefixes the **outer** tag with the bar; the inner `<invoke>`/`<parameter>`/`</tool_calls>` are all bare.
  The old state machine assumed every layer carried the prefix, so inner terminator regexes never matched.
- **Fix**: the `dsmlFeed` state machine relaxed its terminator/opener regexes (prefix optional); at block end it now **parses and backfills** structured
  `tool_calls` (including the final flush on the direct passthrough path) instead of just dropping.
- **Verified**: `node --check` passes; 23+ unit cases green; a real-device 17-segment thinking + tool-call chain runs without breaks.
- **Rollback**: `cp ~/ai-gateway/gateway.js.bak-backfill-20261016-1113 ~/ai-gateway/gateway.js && ~/ai-gateway/agw.sh restart`
- **Follow-up**: if the upstream changes its dialect again (new prefix/tag names), capture one raw stream using the `/tmp/dsml/capture.js` approach and
  adjust the three DSML-related regexes in `gateway.js`.

### 2026-10-16 (round 2) — v1.4.4: closing out rare "blank output / broken chain" cases (dialect relaxed again + loose fallback + evidence)

- **Symptom**: even after round 1, a **small-probability** "blank in the middle" remained (broken chain after thinking, no tool call).
- **Three more silent-drop paths found** (all looked like "whole block swallowed -> blank content"):
  1. `dsmlParseCall` required the block to contain the text `DSML`, else returned null immediately;
  2. parsing demanded strict `</invoke>` pairing; a missing closing tag or self-closing `<invoke .../>` failed to parse;
  3. backfill required the function name to match the client's declaration **exactly**; case/namespace differences parsed fine but never backfilled.
- **Fix**:
  - dialects unified to three: (1) the bar with DSML (2) fully bare tags (3) only the bar left, like `<｜tool_calls>`;
  - the parser switched to **structure-based recognition** (no DSML text required) + a loose fallback (missing `</invoke>`, self-closing, unclosed `<parameter>`, JSON-shaped blocks);
  - backfill gate: identical names -> normalized names (case/namespace) -> **single-call fallback** (prefer backfill over silently losing content);
  - on upstream truncation (stream ends inside a block), parse/backfill best-effort before deciding to drop.
- **Evidence**: every "block swallowed without backfill" writes one JSON line to `log/dsml-miss.log` (reason / raw context / declared tool names).
  `AGW_DSML_MISS_LOG=off` disables it; an absolute path relocates it.
- **Verified**: units 25/25 (including 133 fragmentation points fuzzing, char-by-char feeding, three dialects, truncated backfill);
  E2E 12/12 (char-sliced streaming, tool-name mismatches, non-streaming path — all produced structured `tool_calls`).
- **Rollback**: `cp ~/ai-gateway/gateway.js.bak-dsmlv2-*.bak ~/ai-gateway/gateway.js && ~/ai-gateway/agw.sh restart`

### 2026-10-16 (round 3) — v1.4.5: stop/disconnect/crash triple fix

- **Symptom**: occasional "blank / broken chain" persisted, plus the earlier "stop button does nothing, request hangs".
- **Confirmed** (log/dsml-miss.log + gateway logs): the upstream was cut off (or ended naturally) right at `<｜DSML｜ calls>` (note the space variant) -> the whole block was dropped and the UI had no continuation; logs showed `upstream idle timeout (180s)` and `uncaughtException: write after end`.
- **Three root causes**: (1) when the client pressed stop, the gateway did nothing and the upstream kept generating to natural end or the 180s timeout; (2) an upstream connection reset (no `end`) hung the downstream forever; (3) after an upstream `error`, an early `res.end()` followed by the `close` finalization wrote again -> write-after-end killed the whole gateway process.
- **Fix**:
  - client disconnect (`res.close` / `req.aborted`) -> immediately `upReq.destroy()` the upstream;
  - upstream `close` without `end` -> force finalization on all three paths (direct / converted / bare passthrough);
  - if the upstream never sent `[DONE]`, the gateway sends it at stream end so clients stop treating it as unfinished;
  - the error path finalizes through the pipe with a `res.on('error')` fallback, eliminating process-killing uncaughtExceptions.
- **Verified**: units 25/25; E2E passthrough 12/12 (char slicing / name mismatch / non-streaming); E2E abort 3/3 (a broken upstream always gets [DONE]; a client stop cancels the upstream within 2s).
- **Test files in repo**: `test/dsml/` (t2.js units, run.js passthrough, abort.js abort; run with `node test/dsml/t2.js` etc.).
- **Rollback**: `cp ~/ai-gateway/gateway.js.bak-dsmlv3-*.bak ~/ai-gateway/gateway.js && ~/ai-gateway/agw.sh restart`

### 2026-10-16 (round 4) — v1.4.6: targeted diagnosis of orphan-markup truncation (maxTokens + evidence ring)

- **Symptom**: occasional "blank / broken chain" remained, with miss.log uniformly showing `truncated-drop | len=15 | <｜DSML｜ calls>\n` (12 identical signatures).
- **Indication**: deepseek-v4.1-flash (NIM) emits `<｜DSML｜ calls>` (space variant) right after 20-100s of thinking, and the stream ends immediately — likely NIM exhausting its output token budget during thinking, truncating mid-markup.
- **Changes**:
  - new channel-level option `maxTokens` (both openai passthrough and conversion paths; injected only when the client sends no `max_tokens`);
  - evidence ring: the passthrough pipe keeps the last 12 upstream SSE payloads; if the state machine is still attached at stream end (truncation/orphan markup), they are written to `log/dsml-miss.log` together with `finish_reason` (reason=`pipe-final-active`) so nobody has to guess again;
  - `maxTokens: 8192` injected for the four NVIDIA-NIM channels (config backups at `config.NVIDIA-NIM.json.bak-mt-*`).
- **Verified**: units 25/25, E2E passthrough 12/12, E2E abort 3/3.
- **If it recurs**: `tail -3 ~/ai-gateway/log/dsml-miss.log` — check `finish_reason` on the `pipe-final-active` line: `length` -> raise the limit further / confirm NIM's cap; `stop` -> the model stopped on its own, change the handling strategy.
