# Docs Bundle Sync — how dero-docs reaches the MCP server and the VPS

This server ships a prebuilt search index of the DERO docs
(`data/docs-index.json`) so the `dero_docs_*` tools answer
in-process with no network round trip. That index is generated from the
**dero-docs** repo (the Nextra site behind derod.org) and travels inside the
published npm package. This doc explains the full pipeline, what's automated
vs. manual, the secrets involved, and how to recover when something breaks.

## The pipeline at a glance

```
 dero-docs edit ──auto──▶ index committed to main ──manual──▶ release ──auto──▶ npm + VPS
   (.mdx)                  (rebuilt index)             (bump, tag)     (tag)        (live docs)
```

| Step | Automated? | Mechanism |
|------|-----------|-----------|
| dero-docs push → notify mcp-server | ✅ | `sync-mcp-docs-bundle.yml` (in dero-docs) fires a `repository_dispatch` |
| Rebuild index, commit to main | ✅ | `refresh-docs-bundle.yml` (here) clones dero-docs, runs `build:docs` + `smoke:docs`, commits `data/docs-index.json` to main |
| Bump version + CHANGELOG + tag | ❌ manual | `npm run release:docs` (see below) or by hand |
| npm publish + MCP registry + VPS redeploy | ✅ | `release.yml` on the `v*` tag |
| Verify hosted MCP + sync public discovery docs | ✅ | `release.yml` probes both protocol eras, publishes `mcp-surface.json`, then a GitHub App dispatches to dero-docs |

**Key fact:** a docs edit does **not** reach `mcp.derod.org` until a release is
cut. The live container installs `dero-mcp-server@<version>` from npm, so docs
ride with the versioned package. This is intentional — npm consumers get a
pinned, provenanced snapshot and the VPS stays deterministic.

## Secrets / config

| Secret | Lives on | Purpose | Notes |
|--------|----------|---------|-------|
| npm trusted publisher | npmjs.com | keyless OIDC publish | configured for `DHEBP/dero-mcp-server` + workflow `release.yml`; no token stored |
| `DEPLOY_HOST/USER/KEY/PORT` | this repo | SSH to the VPS for redeploy | dedicated ed25519 key |
| `MCP_SYNC_APP_PRIVATE_KEY` | both repos | mints short-lived cross-repo automation tokens | GitHub App private key; never a personal token |
| `MCP_SYNC_APP_ID` | both repos | identifies the sync App | Actions variable, not a secret |

The sync App must be installed only on `DHEBP/dero-mcp-server` and
`DHEBP/dero-docs`, with **Contents: read/write** and **Pull requests:
read/write**. The docs receiver always opens a PR; it never merges one.

## Manual recovery

**Auto-sync didn't update the index after a docs change:**
1. Check that the sync GitHub App is installed on both repos and that
   `MCP_SYNC_APP_ID` / `MCP_SYNC_APP_PRIVATE_KEY` are configured.
2. Manually trigger: Actions → "Refresh docs bundle" → Run workflow (Level 2), or
   `gh workflow run refresh-docs-bundle.yml -f dero_docs_ref=main`.

**Rebuild the index locally** (Level 1 fallback — needs dero-docs checked out at `../dero-docs`):
```
DERO_DOCS_ROOT=/path/to/dero-docs npm run build:docs
npm run smoke:docs   # validates the rebuilt index, including code-fidelity probes
```

**Cut a docs release** (after the refreshed index is on main):
```
npm run release:docs        # bumps patch, writes CHANGELOG line, tags, pushes
# → release.yml does npm + registry + VPS from the tag
```

## Verifying what's live

`/health` on the running server reports the docs bundle date and page count:
```
curl -s https://mcp.derod.org/health | jq '{version, docs_generated_at, docs_page_count}'
```
Compare `docs_page_count` / `docs_generated_at` against the committed index to
confirm the live server isn't serving a stale bundle.

## Gotchas

- **The index ships code examples.** `mdxToPlainText` (`src/docs-parse.ts`)
  must preserve fenced-code contents — a regex that *deletes* fenced blocks
  silently strips every `curl`/RPC/install example. `smoke:docs` has a
  content-fidelity probe (`mustContain`) guarding this; do not remove it.
- **`prepack` ships the committed index — it does NOT rebuild it.** Rebuilding
  needs dero-docs present, which the release runner doesn't have. Regeneration
  is the refresh workflow's job, not the publish's.
- **`docker compose` requires `DERO_MCP_VERSION` set** (fails loud by design).
  Set it in `deploy/.env`; never rely on a default.
