#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createDeroMcpServer } from './server.js'
import { startHttpServer } from './http-server.js'
import { resolveDaemonBase, describeDaemonResolution } from './daemon-base.js'

function isHttpMode(): boolean {
  if (process.argv.includes('--http')) return true
  const env = process.env.DERO_MCP_HTTP?.trim().toLowerCase()
  return env === '1' || env === 'true' || env === 'yes'
}

async function runStdio(): Promise<void> {
  const resolution = await resolveDaemonBase()

  process.stderr.write(`[dero-mcp-server] stdio · ${describeDaemonResolution(resolution)}\n`)

  serveStdio(
    ({ era }) =>
      createDeroMcpServer(resolution.base, {
        daemonSource: resolution.source,
        era,
      }),
    {
      legacy: 'serve',
      onerror: (err) => {
        process.stderr.write(`[dero-mcp-server] stdio handler error: ${err.message}\n`)
      },
    },
  )
}

async function main(): Promise<void> {
  if (isHttpMode()) {
    await startHttpServer()
    return
  }
  await runStdio()
}

main().catch((err) => {
  process.stderr.write(`[dero-mcp-server] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
