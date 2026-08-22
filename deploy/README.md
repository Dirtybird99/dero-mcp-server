# Hosted `dero-mcp-server` deployment

This folder is a reference deployment for running `dero-mcp-server` as a hosted streamable-HTTP MCP server behind your own domain. The canonical instance is `https://mcp.derod.org/mcp` (DERO ecosystem); anyone is welcome to fork this and host their own.

It is **not the only way to run dero-mcp-server.** For local development, the npm package's stdio mode (`npx dero-mcp-server`) is simpler and more private. Use this deployment when you need a remote URL for clients that don't support local subprocesses (ChatGPT Custom Connectors, Cursor hosted mode, n8n / Zapier / Make integrations, etc.).

---

## What you get

```
                                ┌─────────────────────────────┐
            Internet ───────────▶│   Caddy (TLS, reverse-proxy) │
                                │   :80 + :443                 │
                                └────────────┬────────────────┘
                                             │ HTTP
                                             ▼
                                ┌─────────────────────────────┐
                                │   dero-mcp-server (HTTP)     │
                                │   :8787                      │
                                └────────────┬────────────────┘
                                             │ JSON-RPC
                                             ▼
                                ┌─────────────────────────────┐
                                │   DERO daemon                │
                                │   (your choice of host)      │
                                └─────────────────────────────┘
```

- Two containers (Caddy + the MCP server), one DERO daemon you provide.
- Auto-TLS via Let's Encrypt.
- Host-header and browser-Origin allowlists before MCP routing.
- Optional bearer-token auth.
- Stateless — no session storage, no in-memory state across requests.
- Health endpoint at `/health` for monitoring.
- ~50 MB total container footprint.

---

## Prerequisites

1. A Linux VPS with **Docker** and **Docker Compose v2** installed. Tested on Ubuntu 24.04 / Debian 12. Any provider works (Hetzner, Vultr, DigitalOcean, your basement).
2. A domain whose **A/AAAA record** points at the VPS public IP. Example: `mcp.derod.org` → `203.0.113.42`.
3. **Ports 80 and 443** open to the public internet (for ACME challenge + serving requests). UFW: `ufw allow 80 && ufw allow 443`.
4. A **DERO daemon** the MCP server can reach. Three options — pick one before continuing:
   - **Same VPS, outside Docker (recommended).** Run derod as a systemd service on the host. The MCP container reaches it via `host.docker.internal:10102`.
   - **External host.** Point `DERO_DAEMON_URL` at any reachable JSON-RPC base.
   - **Community / default.** Leave `DERO_DAEMON_URL` empty; the package defaults to a known public node. Lowest control; highest cost-savings.

---

## First-time setup

```bash
# 1. Clone the dero-mcp-server repo on the VPS.
git clone https://github.com/DHEBP/dero-mcp-server.git /opt/dero-mcp-server
cd /opt/dero-mcp-server/deploy

# 2. Copy the env template and edit.
cp .env.example .env
$EDITOR .env
#    Required fields:
#      DOMAIN                (your hostname)
#      ACME_EMAIL            (for Let's Encrypt failure alerts)
#      DERO_DAEMON_URL       (see Prerequisites step 4)
#      DERO_MCP_AUTH_TOKEN   (highly recommended; generate with `openssl rand -base64 48`)
#    DOMAIN is also passed to the MCP process as DERO_MCP_ALLOWED_HOSTS.
#    Optional browser clients: set DERO_MCP_ALLOWED_ORIGINS to a comma-separated
#    list of lowercase hostnames (no schemes or ports).

# 3. Bring it up.
docker compose up -d --build

# 4. Watch the logs while Caddy obtains the certificate.
docker compose logs -f caddy
#    Expect "certificate obtained" within ~30 seconds. If ACME fails,
#    verify DNS A record + open ports 80/443.

# 5. Smoke test.
curl https://${DOMAIN}/health
#    → {"status":"ok","name":"dero-daemon-mcp","version":"<configured release>",...}

curl -X POST https://${DOMAIN}/mcp \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
#    → SSE stream with the current tools/list result.
```

Because the container binds to `0.0.0.0`, HTTP startup requires an allowed
`Host` list. Compose supplies the lowercase `DOMAIN` value automatically. For a
standalone container, set `DERO_MCP_ALLOWED_HOSTS` yourself to comma-separated
lowercase hostnames without schemes or ports. `DERO_MCP_ALLOWED_ORIGINS` is a
separate optional hostname-only list for browser clients; leaving it empty
rejects every request that presents an `Origin` header while allowing clients
that omit `Origin`.

---

## Running a derod daemon on the same VPS

The MCP container talks to the daemon over `host.docker.internal:10102`. To set that up:

```bash
# Download derod (verify checksum from official source!)
wget https://github.com/deroproject/derohe/releases/download/Release126/derohe_linux_amd64.tar.gz
tar xzf derohe_linux_amd64.tar.gz
sudo mv derohe_linux_amd64/derod-linux-amd64 /usr/local/bin/derod

# systemd unit at /etc/systemd/system/derod.service
sudo tee /etc/systemd/system/derod.service <<'EOF'
[Unit]
Description=DERO daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/derod --rpc-bind=0.0.0.0:10102 --p2p-bind=0.0.0.0:50000
User=derod
Group=derod
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo useradd --system --no-create-home derod
sudo systemctl daemon-reload
sudo systemctl enable --now derod
sudo journalctl -u derod -f   # watch initial sync
```

Then in `.env`:
```
DERO_DAEMON_URL=http://host.docker.internal:10102
```

⚠️ **Bind derod's RPC to a public-facing interface only if you intend for anyone to query it.** For internal-only access from the MCP container, prefer `--rpc-bind=127.0.0.1:10102` and use a different `extra_hosts` mapping (or run derod in the same compose).

---

## Operations runbook

### Update the MCP server

```bash
cd /opt/dero-mcp-server
git pull
cd deploy
# Update DERO_MCP_VERSION in .env to the new release
docker compose build --no-cache mcp
docker compose up -d
docker compose logs -f mcp
```

### Update derod

```bash
# Stop service, swap binary, restart
sudo systemctl stop derod
wget ...  # new release
sudo mv derod-linux-amd64 /usr/local/bin/derod
sudo systemctl start derod
sudo journalctl -u derod -f
```

### Daemon sync check

The MCP server returns daemon-derived data, so a stale daemon means stale responses. Quick check:

```bash
curl -s https://${DOMAIN}/mcp \
  -X POST -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"diagnose_chain_health","arguments":{}}}' \
  | grep '"status"'
```

A healthy response includes `"status":"healthy"` and a recent topoheight. Wire this into your monitoring system (Uptime Kuma, BetterStack, etc.).

### Rotate the auth token

```bash
NEW_TOKEN=$(openssl rand -base64 48)
sed -i "s|^DERO_MCP_AUTH_TOKEN=.*|DERO_MCP_AUTH_TOKEN=${NEW_TOKEN}|" .env
docker compose up -d mcp   # picks up new env on restart
# Distribute the new token to authorized clients.
```

### Tear down

```bash
docker compose down -v   # -v removes Caddy's data volume (TLS certs)
# To reuse the same domain immediately, OMIT -v (keeps the cert).
```

---

## Security posture

This deployment ships with these defaults; understand them before exposing:

- **Read-only MCP**: the `dero-mcp-server` package itself has no write tools. Even with no auth, an attacker cannot move funds or mutate chain state through it. The risk surface is: daemon RPC abuse (rate-exhausting the daemon) and information surface (every query reveals what the agent is curious about).
- **Stateless container**: no session storage, no in-memory state across requests, no DB.
- **No request-body logging by default.** Caddy logs status + path; we do not log the JSON-RPC payload. Operators who add their own logging should be deliberate.
- **Daemon URL secrets stay out of disclosures.** `DERO_DAEMON_URL` supports query parameters, but rejects embedded URL userinfo. Query values are redacted from startup logs, `/health`, server-info, and privacy notices.
- **No X-Forwarded-For honored.** The Caddyfile strips it on inbound to avoid log spoofing. Add it back only if you front this with a trusted proxy (Cloudflare, etc.).
- **Host headers are allowlisted.** Compose passes `DOMAIN` as `DERO_MCP_ALLOWED_HOSTS`; malformed or unlisted hosts are rejected before MCP routing. Any standalone non-loopback bind must provide its own lowercase hostname-only list.
- **Browser origins are deny-by-default.** `DERO_MCP_ALLOWED_ORIGINS` accepts lowercase hostnames only (no schemes or ports). When empty, a request with an `Origin` header is rejected; non-browser clients that omit it are unaffected.
- **Auth is optional**. Setting `DERO_MCP_AUTH_TOKEN` requires `Authorization: Bearer ...` on every `/mcp` call. We recommend it strongly unless this is intentionally a public docs-only demo.
- **No rate limiting in this template.** Caddy 2 has rate-limit modules; adding them is on the to-do list. Until then, abuse mitigation is "reverse-proxy via Cloudflare and use their rate limiting" or "rely on the daemon's own RPC rate limits."

---

## What to do if hosted breaks

Hosted MCP isn't the only path. The npm package (`npx dero-mcp-server`) gives users the full feature set running locally. If `mcp.derod.org` is down:

1. Status page: (TBD — link the operator's status page here)
2. Workaround: install via npm, point at your own daemon or a community one
3. File an issue: https://github.com/DHEBP/dero-mcp-server/issues

Document the hosted deployment's deprecation policy publicly if you ever sunset it. Suggested wording for the mcp-server-card.json description:

> _`mcp.derod.org` is provided on a best-effort basis. If sunset, we commit to 90 days notice. The durable path is `npm install dero-mcp-server`._

---

## License

MIT (matches the parent repo).
