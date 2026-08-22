/**
 * Streamable HTTP transport entry for dero-mcp-server.
 *
 * Same factory (`createDeroMcpServer`) as the stdio entry — just a
 * different transport on top. Enable via `dero-mcp-server --http`
 * or `DERO_MCP_HTTP=1` (see index.ts dispatcher).
 *
 * Stateless by design: each request is independent. No session
 * tracking, no in-memory state across requests, no logs of query
 * payloads. Pairs cleanly with read-only semantics and the
 * privacy-first brand.
 *
 * Environment:
 *   DERO_DAEMON_URL       — JSON-RPC base. If unset, resolves local-first:
 *                           a local derod (127.0.0.1:10102) if reachable,
 *                           else the baked-in public fallback.
 *   DERO_MCP_HTTP_PORT    — listen port (default: 8787)
 *   DERO_MCP_HTTP_HOST    — listen address (default: 127.0.0.1)
 *   DERO_MCP_ALLOWED_HOSTS— comma-separated Host allowlist; required for a
 *                           non-loopback listen address.
 *   DERO_MCP_ALLOWED_ORIGINS
 *                         — optional comma-separated browser Origin hostname
 *                           allowlist. An empty list rejects present Origins.
 *   DERO_MCP_AUTH_TOKEN   — if set, require `Authorization: Bearer <token>`
 *                           on /mcp. Constant-time compared. Recommended
 *                           when binding to a public address; required
 *                           if behind a reverse proxy without its own auth.
 *
 * Routes:
 *   POST /mcp     — MCP streamable HTTP endpoint
 *   GET  /health  — health check {status, version, daemon_url, daemon_source}
 *   anything else → 404
 *
 * Reverse-proxy expectations:
 *   - TLS handled upstream (Caddy / Cloudflare / etc.) — this server is
 *     plain HTTP.
 *   - Request bodies and client IP headers are not logged.
 */

import http from 'node:http'
import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node'
import { localhostAllowedHostnames, localhostAllowedOrigins } from '@modelcontextprotocol/server'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createDeroMcpServer } from './server.js'
import {
  daemonPrivacyNotice,
  resolveDaemonBase,
  describeDaemonResolution,
} from './daemon-base.js'
import { docsIndexMeta } from './docs.js'
import { redactDaemonUrl } from './rpc.js'

const PACKAGE_VERSION = '0.7.0'

function readEnv() {
  const port = Number.parseInt(process.env.DERO_MCP_HTTP_PORT ?? '8787', 10)
  const host = process.env.DERO_MCP_HTTP_HOST ?? '127.0.0.1'
  const authToken = process.env.DERO_MCP_AUTH_TOKEN?.trim() || undefined
  const configuredHosts = parseHostnames(process.env.DERO_MCP_ALLOWED_HOSTS)
  const configuredOrigins = parseHostnames(process.env.DERO_MCP_ALLOWED_ORIGINS)
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase())
  if (!loopback && configuredHosts.length === 0) {
    throw new Error('DERO_MCP_ALLOWED_HOSTS is required when DERO_MCP_HTTP_HOST is not loopback')
  }
  return { port, host, authToken, configuredHosts, configuredOrigins, loopback }
}

function parseHostnames(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))]
}

function isAuthorized(req: http.IncomingMessage, expectedToken: string): boolean {
  const header = req.headers['authorization']
  if (!header || Array.isArray(header)) return false
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return false
  const given = m[1]!.trim()
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(a, b)
}

function send(res: http.ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export async function startHttpServer(): Promise<void> {
  const { port, host, authToken, configuredHosts, configuredOrigins, loopback } = readEnv()
  const validateHost =
    loopback && configuredHosts.length === 0
      ? localhostHostValidation()
      : hostHeaderValidation([
          ...(loopback ? localhostAllowedHostnames() : []),
          ...configuredHosts,
        ])
  const validateOrigin =
    loopback && configuredOrigins.length === 0
      ? localhostOriginValidation()
      : originValidation([
          ...(loopback ? localhostAllowedOrigins() : []),
          ...configuredOrigins,
        ])
  const resolution = await resolveDaemonBase()
  const daemonUrl = resolution.base
  const displayDaemonUrl = redactDaemonUrl(daemonUrl)
  const privacyNotice = daemonPrivacyNotice(resolution)
  const reportHandlerError = (err: Error) => {
    process.stderr.write(`[dero-mcp-server] http handler error: ${err.message}\n`)
  }
  const mcpHandler = createMcpHandler(
    ({ era }) =>
      createDeroMcpServer(daemonUrl, {
        daemonSource: resolution.source,
        era,
      }),
    {
      legacy: 'stateless',
      onerror: reportHandlerError,
    },
  )
  const handleMcp = toNodeHandler(mcpHandler, { onerror: reportHandlerError })

  const httpServer = http.createServer(async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      send(res, 400, JSON.stringify({ error: 'bad_request', message: 'Invalid request target.' }))
      return
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      const docsMeta = await docsIndexMeta()
      send(
        res,
        200,
        JSON.stringify({
          status: 'ok',
          name: 'dero-daemon-mcp',
          version: PACKAGE_VERSION,
          transport: 'streamable-http',
          daemon_url: displayDaemonUrl,
          daemon_source: resolution.source,
          privacy_notice: privacyNotice,
          docs_generated_at: docsMeta.docs_generated_at,
          docs_page_count: docsMeta.docs_page_count,
        }),
      )
      return
    }

    if (url.pathname !== '/mcp') {
      send(res, 404, JSON.stringify({ error: 'not_found', message: 'See /mcp for the MCP endpoint, /health for status.' }))
      return
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) return

    // Auth (optional but recommended). When DERO_MCP_AUTH_TOKEN is set,
    // every /mcp request must carry Authorization: Bearer <token>.
    if (authToken && !isAuthorized(req, authToken)) {
      res.setHeader('www-authenticate', 'Bearer realm="dero-mcp"')
      send(res, 401, JSON.stringify({ error: 'unauthorized' }))
      return
    }

    await handleMcp(req, res)
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      const address = httpServer.address()
      const boundPort = typeof address === 'object' && address ? address.port : port
      process.stderr.write(
        `[dero-mcp-server] HTTP listening on ${host}:${boundPort} (POST /mcp · GET /health)\n`,
      )
      process.stderr.write(
        `[dero-mcp-server] ${describeDaemonResolution(resolution)} · auth: ${authToken ? 'bearer required' : 'none (do not expose publicly)'}\n`,
      )
      resolve()
    })
  })

  const shutdown = (signal: string) => {
    process.stderr.write(`[dero-mcp-server] ${signal} received, shutting down\n`)
    void mcpHandler
      .close()
      .catch(reportHandlerError)
      .finally(() => httpServer.close(() => process.exit(0)))
    // Hard exit after 5s if connections won't drain.
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
