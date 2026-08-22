# Positioning — DERO MCP

> Why this server exists, who it's for, and how it relates to the rest of the agent-tooling landscape.

## The thesis

The agent-tooling world is rapidly standardizing on identified, logged, regulated rails — Stripe, the Agent Commerce Protocol, Visa, Crossmint, Skyfire's KYA, ICANN-anchored identity. KYC at the registrar. Real-world identity at the payment processor. Transaction graphs at the chain layer.

That's the right answer for one set of use cases. **DERO MCP is the other one.**

This is a read-only Model Context Protocol server for the [DERO privacy blockchain](https://derod.org) — a private-by-default Layer 1 with homomorphically encrypted balances, ring-signature-hidden senders, zero-knowledge range-proofed amounts, and no public transaction graph. The server inherits the chain's posture: stateless by design, no request logs, no telemetry, no tracking.

It is infrastructure for people who chose DERO for a reason.

---

## Who DERO MCP is for

- **Privacy-respecting application developers** building tools whose users have a reasonable expectation that their on-chain activity is not surveilled.
- **OPSEC-conscious researchers** — security professionals, journalists, civil-society technologists — who need agent-mediated blockchain queries without a metadata exhaust.
- **Threat-model-aware agent builders** designing autonomous agents that operate on DERO and need the tooling layer to not be the leak point.
- **Anonymous DAO operators** running governance, treasury, or settlement workflows on DERO who want agent automation without re-introducing transparent-ledger artifacts.
- **Users of DERO ecosystem tools** (Engram, Hologram, TELA apps, DeroPay) who want their AI assistant to be conversant with the same chain they already operate on.

If any of those describe your use case, this server is built for you.

---

## Who DERO MCP is not for

- **Mass-market commerce agents** that need chargeback rails, KYC-anchored merchant identity, or USD settlement guarantees. Use Stripe, ACP, or Crossmint.
- **Audit-trail-mandatory enterprise integrations** that require a per-transaction transparency record. DERO does not, by design, produce one.
- **Compliance-first deployments** where the requirement is a logged, KYB-tied, identified-agent posture. Use Skyfire KYAPay or a comparable identified-agent stack.
- **Generic "blockchain agent" needs** spanning Ethereum, Bitcoin, Solana, and friends. This server is deliberately DERO-only. If you need multi-chain, use a generic blockchain MCP.

This isn't a values judgment — those are legitimate use cases, served by legitimate stacks. DERO MCP simply isn't the right surface for them.

---

## Where this sits in the agent-tooling landscape

| Stack | Surface | Identity | Privacy | Where it's the right answer |
| --- | --- | --- | --- | --- |
| **Stripe Agents / x402** | Bright lights | KYC + KYB anchored, US-business gated | Logged | Mass-market commerce agents needing card / USDC settlement and chargeback rails |
| **ACP (OpenAI / Crossmint)** | Bright lights | Mandate-signed (Skyfire KYA, ACP HMAC) | Logged | Identified-agent commerce — ChatGPT Instant Checkout shape |
| **Skyfire KYAPay** | Bright lights | Persistent agent KYA (Experian-verified) | Logged | B2B verified-agent settlement with a paper trail |
| **AP2 (Google)** | Mixed | SD-JWT-VC mandate envelope, transport-agnostic | Per-design | Authorization-layer interop across multiple settlement rails |
| **DERO MCP** | **Quiet** | **`*.dero` self-sovereign (when paired with name registration)** | **Stateless, no logs, no telemetry** | **Read-only chain inspection and agent tooling for the privacy-pilled** |

The bright-lights stacks are doing the right thing for the audience they serve. We're the deliberate inverse for the audience they structurally can't serve — because privacy is part of our contract, not a feature flag.

---

## The posture (the technical receipts)

Positioning means nothing without the engineering to back it up. This server is built with the same privacy posture as the chain it serves:

- **No request logs.** Stateless by design. The server holds no per-request state across calls.
- **No telemetry.** The server does not phone home — not on install, not on update, not on use.
- **No tracking.** No analytics, no cookies, no third-party fetches embedded in tool responses.
- **Header hygiene.** The reference Caddyfile in [`deploy/`](https://github.com/Dirtybird99/dero-mcp-server/tree/main/deploy) strips `X-Forwarded-For` before requests reach the server.
- **Constant-time auth.** The bearer-token comparison for the HTTP transport is constant-time to avoid timing side-channels.
- **Read-only by design.** The server cannot move funds, broadcast transactions, or invoke contracts. The write surface is excluded at the tool registration layer — there is no flag to flip.

If you are building agents that operate on DERO, your tooling should not be what leaks. This is the substrate.

---

## What this is *not* claiming

A few precision points to head off common misreads:

- **This is not anti-Stripe.** Stripe is doing excellent work for a different audience. Both stacks can exist. They serve different threat models.
- **This is not a regulatory-evasion tool.** Read-only chain inspection has no compliance implication. The privacy properties of the underlying chain are matters of cryptography, not jurisdiction.
- **This is not a guarantee of agent anonymity.** Smart-contract interactions on DERO that record `SIGNER()` are publicly visible (see [`derod.org/privacy/account-based-privacy.md`](https://derod.org/privacy/account-based-privacy.md) for the asymmetry). The posture is "private value transfer, identifiable contract activity" — not "untraceable."
- **This is not a darknet endorsement.** Like Signal, Tor, or any privacy-respecting infrastructure, the right framing is "infrastructure neutral to use case." We provide tools; users provide intent.

---

## On the cypherpunk lineage

The intellectual ancestry here is explicit: A Cypherpunk's Manifesto (Eric Hughes, 1993), the Crypto Anarchist Manifesto (Tim May, 1988), Phil Zimmermann's PGP defense, the development of Tor, Signal, Monero. The thesis across all of them is the same: **privacy is the power to selectively reveal yourself, and that power should not be contingent on the goodwill of an intermediary.**

DERO is one of the few currently-operating production blockchains that ships native-cryptographic privacy at the L1 layer rather than as an opt-in mixer or rollup. This server is the agent-tooling layer for that chain, built by people who think the lineage matters.

---

## See also

- [`README.md`](./README.md) — installation, quick start, and a tour of what you can ask
- [`skills/`](./skills/) — focused DERO, TELA, Hologram, and DeroPay workflow runbooks exposed through Skills over MCP
- [`SKILL.md`](./SKILL.md) — compatibility index for clients that expect a root skill file
- [`deploy/README.md`](https://github.com/Dirtybird99/dero-mcp-server/blob/main/deploy/README.md) — self-hosted streamable-HTTP reference deployment with Caddy + auto-TLS
- [derod.org/privacy](https://derod.org/privacy) — the chain-level privacy primitives this server inherits its posture from
- [DERO Foundation](https://github.com/deroproject/derohe) — the upstream chain implementation
