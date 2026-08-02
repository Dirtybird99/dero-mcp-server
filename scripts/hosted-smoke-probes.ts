#!/usr/bin/env npx tsx

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { readFile } from 'node:fs/promises'
import { DERO_PROMPT_NAMES, DERO_RESOURCE_URIS } from '../src/server.js'
import { DERO_TOOL_NAMES } from '../src/tool-descriptions.js'

const docsIndex = JSON.parse(await readFile(new URL('../data/docs-index.json', import.meta.url), 'utf8')) as { page_count: number }
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const baseUrl = new URL(process.env.DERO_MCP_BASE_URL ?? 'https://mcp.derod.org')
const expectedVersion = process.env.DERO_MCP_EXPECT_VERSION ?? packageJson.version

function assertSortedEqual(actual: string[], expected: readonly string[], label: string): void {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label}: expected ${right.join(', ')}, got ${left.join(', ')}`)
  }
}

async function checkHealth(): Promise<void> {
  const response = await fetch(new URL('/health', baseUrl))
  if (!response.ok) throw new Error(`/health returned ${response.status}`)
  const health = await response.json() as Record<string, unknown>
  if (health.status !== 'ok') throw new Error(`/health status is ${JSON.stringify(health.status)}`)
  if (health.version !== expectedVersion) throw new Error(`/health version ${JSON.stringify(health.version)} != ${expectedVersion}`)
  if (health.transport !== 'streamable-http') throw new Error(`/health transport is ${JSON.stringify(health.transport)}`)
  if (health.docs_page_count !== docsIndex.page_count) {
    throw new Error(`/health docs_page_count ${JSON.stringify(health.docs_page_count)} != ${docsIndex.page_count}`)
  }
  process.stdout.write(`  ✓ health ${expectedVersion} · ${docsIndex.page_count} docs\n`)
}

async function checkClient(era: 'legacy' | 'modern'): Promise<void> {
  let sawSessionHeader = false
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      sawSessionHeader ||= response.headers.has('mcp-session-id')
      return response
    },
  })
  const client = new Client(
    { name: `dero-hosted-${era}-smoke`, version: packageJson.version },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )

  try {
    await client.connect(transport)
    if (client.getProtocolEra() !== era) throw new Error(`${era} client negotiated ${String(client.getProtocolEra())}`)
    if (client.getServerVersion()?.version !== expectedVersion) {
      throw new Error(`${era} MCP version ${String(client.getServerVersion()?.version)} != ${expectedVersion}`)
    }
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ])
    assertSortedEqual(tools.tools.map(({ name }) => name), DERO_TOOL_NAMES, `${era} tools`)
    assertSortedEqual(resources.resources.map(({ uri }) => uri), DERO_RESOURCE_URIS, `${era} resources`)
    assertSortedEqual(prompts.prompts.map(({ name }) => name), DERO_PROMPT_NAMES, `${era} prompts`)
    if (era === 'modern') {
      const parallel = await Promise.all([client.listTools(), client.listTools()])
      for (const result of parallel) assertSortedEqual(result.tools.map(({ name }) => name), DERO_TOOL_NAMES, 'parallel modern tools')
    }
    if (sawSessionHeader) throw new Error(`${era} stateless response included Mcp-Session-Id`)
    process.stdout.write(`  ✓ ${era} · ${tools.tools.length} tools · ${resources.resources.length} resources · ${prompts.prompts.length} prompts\n`)
  } finally {
    await client.close()
    await transport.close()
  }
}

async function main(): Promise<void> {
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('DERO_MCP_BASE_URL must use http or https')
  process.stdout.write(`[smoke:hosted] ${baseUrl.origin}\n`)
  await checkHealth()
  await checkClient('legacy')
  await checkClient('modern')
  process.stdout.write('[smoke:hosted] OK\n')
}

main().catch((error) => {
  process.stderr.write(`[smoke:hosted] FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
