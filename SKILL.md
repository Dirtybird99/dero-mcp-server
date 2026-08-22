# DERO MCP Skill Index

Canonical skills shipped with this server:

- [DERO](./skills/dero/SKILL.md) — chain state, transactions, DVM contracts, supply, proofs, and generic wallet docs.
- [TELA](./skills/tela/SKILL.md) — dURL discovery, app manifests, and on-chain files.
- [Hologram](./skills/hologram/SKILL.md) — Hologram browser, built-in wallet, Studio, and simulator guidance.
- [DeroPay](./skills/deropay/SKILL.md) — DeroPay, DeroAuth, checkout, escrow, and merchant guidance.

Clients with Skills-over-MCP support should discover these through `skills/list`. Other clients can load one with `read_dero_skill`.

Load every relevant product skill for a mixed request. Read-only does not mean private; before a chain lookup with a privacy-sensitive identifier, read `daemon_source`, `endpoint`, and `privacy_notice` from `dero://mcp/server-info`. Use `daemon_source` to classify the connection and `endpoint` only to report where it goes. For `public`, disclose the endpoint and get the user's informed consent before sending the identifier. Treat `env` the same way unless the user confirms that endpoint is trusted or private. If server info is unavailable, treat the endpoint as untrusted and obtain consent before the lookup. Prefer `local` or a node the user controls.
