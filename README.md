# zen2api

**OpenCode Zen free-tier gateway** — exposes the OpenCode Zen free model pool as a standard
OpenAI-compatible / Anthropic-compatible API endpoint. Single-file [Bun](https://bun.sh) server,
no upstream API key required, built-in read-only status panel.

> Community project. Not affiliated with OpenCode / SST. The free tier is a third-party service —
> it can change or rate-limit at any time (see [Caveats](#caveats)).

---

## Why this exists

OpenCode's free tier only accepts requests that *look like they come from the official OpenCode
client* (a client-fingerprint gate — requests without it get
`403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`).

This gateway completes the request shape (client headers, tool schema, protocol lanes) and
proxies to `https://opencode.ai/inference/openai/v1`, streaming the response back verbatim.
That lets **any** OpenAI- or Anthropic-compatible client use the free models.

## Features

- **Three lanes** — `/v1/chat/completions`, `/v1/responses`, `/v1/messages`
- **No upstream key** — the free pool needs none; client auth is optional (`ZEN_CLIENT_KEY`)
- **Dynamic model list** — `GET /v1/models` returns the live free set
  (rule: name ends with `-free`, plus `big-pickle`); refreshed at startup, every 12 h, and on
  demand via `POST /v1/models/refresh`
- **Built-in aliases** — `claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5 / claude-fable-5`
  → `muse-spark-1.3-contributor-free`
- **Egress proxy support** — put it behind any HTTP proxy pool (resin, clash, warp, squid…);
  the free tier rate-limits per egress IP, so a rotating pool helps a lot
- **Read-only panel** — gateway health, model list vs upstream catalog, egress pool status,
  live request log (all optional, env-driven)

## Quick start

Requires [Bun](https://bun.sh) (≥ 1.1).

```bash
git clone https://github.com/nakamotosai/zen2api.git
cd zen2api

# 1) (optional) configure
cp .env.example .env      # edit as needed — sane defaults work out of the box

# 2) run the gateway
bun server.js
# → zen2api v2 listening on http://127.0.0.1:18500 -> https://opencode.ai/inference/openai/v1

# 3) smoke test
curl -s http://127.0.0.1:18500/v1/chat/completions \
  -H "Authorization: Bearer any" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'
```

### Run as a service (systemd)

```bash
sudo mkdir -p /opt/zen2api && sudo cp -r . /opt/zen2api/
sudo cp /opt/zen2api/.env.example /opt/zen2api/service.env   # then edit
sudo cp /opt/zen2api/deploy/zen2api.service /etc/systemd/system/
sudo systemctl enable --now zen2api
```

(Adjust `User=` / paths in the unit to match your setup. `deploy/zen2api-panel.service` is the
same thing for the panel.)

## Connect a client

**Claude Code** (Anthropic protocol lane):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18500
export ANTHROPIC_AUTH_TOKEN=any
claude        # model: claude-sonnet-5 (auto-mapped) — or any *-free model id
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[model_providers.zen]
name = "zen2api"
base_url = "http://127.0.0.1:18500/v1"
env_key = "ZEN_KEY"
wire_api = "responses"

# ZEN_KEY=any codex -m muse-spark-1.3-contributor-free -c model_provider=zen
```

**OpenAI SDK / anything OpenAI-compatible**: base URL `http://127.0.0.1:18500/v1`, any API key.

**List the free models:**

```bash
curl -s http://127.0.0.1:18500/v1/models
```

## Egress proxy (resin-style pools)

The gateway reads `HTTPS_PROXY` / `HTTP_PROXY` (Bun-native) and routes **all** upstream traffic
through them — no extra config:

```bash
HTTPS_PROXY=http://<pool-user>:<pool-token>@127.0.0.1:2260 \
HTTP_PROXY=http://<pool-user>:<pool-token>@127.0.0.1:2260 \
bun server.js
```

Verify it took effect — the startup line shows `... via http://***@host:port`.

> Why: the free tier's `429 FreeUsageLimitError` counts per egress IP (volume + freshness).
> A rotating pool of fresh IPs is the single most effective mitigation.

## Panel

A read-only status page for the gateway (no writes, no auth — bind it to a private network):

```bash
PANEL_GW=http://127.0.0.1:18500 PANEL_REQ_LOG=./requests.jsonl bun panel/server.js
# → http://127.0.0.1:18505
```

Cards shown depend on what you configure (see `.env.example`):

| Card | Needs |
|---|---|
| Gateway health + model list vs upstream catalog | nothing (just `PANEL_GW`) |
| Live request log | `PANEL_REQ_LOG` |
| CPA whitelist column | `PANEL_CPA_CONFIG` |
| Sync receipt | `PANEL_LAST_SYNC` |
| Egress pool (resin-style admin API) | `PANEL_RESIN_*` (four vars) |

## Caveats

- **Free tier limits**: `429 FreeUsageLimitError` is normal under load — it counts per account
  and request shape, and a fresh egress IP helps. Don't hammer it.
- **The request shape is load-bearing**: the gateway's job is to look like the official client.
  If you modify the fingerprint headers / tool schema / lanes, expect `403` from upstream.
- **Availability is not guaranteed**: this depends on an undocumented upstream endpoint that can
  change without notice (that is exactly what retired v1).
- **Not affiliated** with OpenCode/SST. Use at your own risk.

## Layout

```
server.js               gateway (single file, no deps)
panel/server.js         read-only status panel
deploy/*.service        systemd unit templates
scripts/sanitize-gate.sh  repo hygiene gate (CI)
.env.example            every supported env var, documented
SPEC.md / PLAN.md / TRACK_TREE.md / progress.md / HANDOFF.md   project state (long-project layout)
```

## License

MIT — see [LICENSE](LICENSE).
