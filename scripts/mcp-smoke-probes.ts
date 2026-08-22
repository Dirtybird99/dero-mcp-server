#!/usr/bin/env npx tsx
/**
 * Lightweight MCP smoke probes for local stdio server contract checks.
 *
 * Verifies:
 * - tools/list count + name parity
 * - every tool carries the read-only annotation block
 * - resources/list count + URI parity
 * - prompts/list count + name parity
 * - prompts/get returns usable messages
 * - Skills-over-MCP list/get/resources + fallback loader + parser guards
 * - structured tool error payload shape on execution failure
 */
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { z } from 'zod'
import {
  createDeroMcpServer,
  DERO_PROMPT_NAMES,
  DERO_RESOURCE_URIS,
} from '../src/server.js'
import { PUBLIC_DAEMON_BASE } from '../src/daemon-base.js'
import { DERO_SKILL_URIS } from '../src/skills.js'
import { DERO_TOOL_NAMES } from '../src/tool-descriptions.js'
import { checkSkillParser, checkSkillsSurface } from './skill-smoke.js'

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:1'
const NAME_REGISTRY_SCID = '0000000000000000000000000000000000000000000000000000000000000001'

function parseArgs(argv: string[]) {
  let daemonUrl = process.env.DERO_DAEMON_URL ?? DEFAULT_DAEMON_URL
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--daemon-url' || arg === '--url') && argv[i + 1]) {
      daemonUrl = argv[++i]
    } else if (arg.startsWith('--daemon-url=')) {
      daemonUrl = arg.slice('--daemon-url='.length)
    } else if (arg.startsWith('--url=')) {
      daemonUrl = arg.slice('--url='.length)
    }
  }
  return daemonUrl.replace(/\/$/, '')
}

function assertSortedEqual(actual: string[], expected: readonly string[], label: string) {
  const a = [...actual].sort()
  const e = [...expected].sort()
  if (a.length !== e.length) {
    throw new Error(`${label}: expected ${e.length}, got ${a.length}`)
  }
  for (let i = 0; i < e.length; i++) {
    if (a[i] !== e[i]) {
      throw new Error(`${label} mismatch at ${i}: expected ${e[i]}, got ${a[i]}`)
    }
  }
}

type ToolWithAnnotations = {
  name: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

/**
 * Every tool in this server must carry the same read-only annotation block.
 * This lets MCP hosts auto-approve safe calls and prevents future PRs from
 * silently adding wallet/write tools without flipping the annotations.
 */
function assertReadOnlyAnnotations(tools: readonly ToolWithAnnotations[]) {
  const offenders: string[] = []
  for (const tool of tools) {
    const a = tool.annotations
    if (!a) {
      offenders.push(`${tool.name}: missing annotations block`)
      continue
    }
    if (a.readOnlyHint !== true) offenders.push(`${tool.name}: readOnlyHint !== true`)
    if (a.destructiveHint !== false) offenders.push(`${tool.name}: destructiveHint !== false`)
    if (a.idempotentHint !== false) offenders.push(`${tool.name}: idempotentHint !== false`)
    if (a.openWorldHint !== false) offenders.push(`${tool.name}: openWorldHint !== false`)
  }
  if (offenders.length > 0) {
    throw new Error(`annotations: ${offenders.length} tool(s) failed:\n  ${offenders.join('\n  ')}`)
  }
}

function parseFirstTextJson(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const textEntry = result.content.find((c) => c.type === 'text' && typeof c.text === 'string')
  if (!textEntry?.text) {
    throw new Error('Tool result missing text content')
  }
  try {
    return JSON.parse(textEntry.text)
  } catch {
    throw new Error('Tool text content is not valid JSON')
  }
}

const projectedSkillsListSchema = z.object({ skills: z.array(z.unknown()) }).passthrough()
const projectedSkillGetSchema = z.object({ skill: z.unknown() }).passthrough()

async function expectInvalidParams(label: string, request: () => Promise<unknown>): Promise<void> {
  try {
    await request()
  } catch (error) {
    if ((error as { code?: number }).code === -32602) return
    throw new Error(`${label}: expected -32602, got ${String((error as { code?: unknown }).code)}`)
  }
  throw new Error(`${label}: expected -32602, request succeeded`)
}

async function expectUnknownResource(client: Client, label: string): Promise<void> {
  const uri = 'dero://mcp/not-found'
  try {
    await client.readResource({ uri })
  } catch (error) {
    const protocolError = error as { code?: number; data?: Record<string, unknown> }
    if (protocolError.code === -32602 && protocolError.data?.['uri'] === uri) return
    throw new Error(
      `${label}: expected -32602 with URI data, got ${String(protocolError.code)} ${JSON.stringify(protocolError.data)}`,
    )
  }
  throw new Error(`${label}: unknown resources/read URI succeeded`)
}

async function checkSkillsParamValidation(
  client: Client,
  label: string,
  era: 'legacy' | 'modern',
): Promise<void> {
  const omitted = await client.request({ method: 'skills/list' }, projectedSkillsListSchema)
  if (omitted.skills.length !== 4) throw new Error(`${label}: omitted list params failed`)
  if (era === 'modern') {
    if (omitted['ttlMs'] !== 300_000 || omitted['cacheScope'] !== 'public') {
      throw new Error(`${label}: SDK projection missing public 300000ms cache hint`)
    }
  } else if ('ttlMs' in omitted || 'cacheScope' in omitted) {
    throw new Error(`${label}: legacy SDK projection included modern cache hints`)
  }
  const list = await client.request(
    { method: 'skills/list', params: { _meta: { 'acme.example/probe': { ok: true } } } },
    projectedSkillsListSchema,
  )
  if (list.skills.length !== 4) throw new Error(`${label}: namespaced _meta list failed`)

  await expectInvalidParams(`${label} empty cursor`, () =>
    client.request({ method: 'skills/list', params: { cursor: '' } }, projectedSkillsListSchema),
  )
  await expectInvalidParams(`${label} non-string cursor`, () =>
    client.request({ method: 'skills/list', params: { cursor: 42 } }, projectedSkillsListSchema),
  )
  await expectInvalidParams(`${label} extra list param`, () =>
    client.request(
      { method: 'skills/list', params: { unexpected: true } },
      projectedSkillsListSchema,
    ),
  )
  await expectInvalidParams(`${label} empty skill URI`, () =>
    client.request({ method: 'skills/get', params: { uri: '' } }, projectedSkillGetSchema),
  )
  await expectInvalidParams(`${label} non-string skill URI`, () =>
    client.request({ method: 'skills/get', params: { uri: 42 } }, projectedSkillGetSchema),
  )
  await expectInvalidParams(`${label} noncanonical skill URI`, () =>
    client.request(
      { method: 'skills/get', params: { uri: 'DERO://skills/dero' } },
      projectedSkillGetSchema,
    ),
  )
  await expectInvalidParams(`${label} traversal skill URI`, () =>
    client.request(
      { method: 'skills/get', params: { uri: 'dero://skills/dero/../tela' } },
      projectedSkillGetSchema,
    ),
  )
  await expectInvalidParams(`${label} missing skill URI`, () =>
    client.request({ method: 'skills/get', params: {} }, projectedSkillGetSchema),
  )
  await expectInvalidParams(`${label} extra get param`, () =>
    client.request(
      { method: 'skills/get', params: { uri: DERO_SKILL_URIS[0], unexpected: true } },
      projectedSkillGetSchema,
    ),
  )
  await expectUnknownResource(client, `${label} unknown resource`)
}

async function checkPublicFallbackPrivacy(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createDeroMcpServer(PUBLIC_DAEMON_BASE, { daemonSource: 'public' })
  const client = new Client({ name: 'dero-public-privacy-smoke', version: '1.0.0' })
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const instructions = client.getInstructions() ?? ''
    if (!/privacy/i.test(instructions) || !/public fallback/i.test(instructions)) {
      throw new Error('public fallback instructions do not disclose privacy impact')
    }
    const info = await client.readResource({ uri: 'dero://mcp/server-info' })
    const text = info.contents.find((content) => 'text' in content)?.text
    const metadata = JSON.parse(String(text)) as Record<string, unknown>
    if (metadata['daemon_source'] !== 'public' || typeof metadata['privacy_notice'] !== 'string') {
      throw new Error('server-info does not expose public daemon source and privacy notice')
    }
  } finally {
    await client.close()
    await server.close()
  }
}

async function checkModernStdio(daemonUrl: string): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      DERO_DAEMON_URL: daemonUrl,
    } as Record<string, string>,
  })
  const client = new Client(
    { name: 'dero-mcp-modern-smoke-probes', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )

  try {
    await client.connect(transport)
    if (client.getProtocolEra() !== 'modern') {
      throw new Error(`expected modern stdio era, got ${String(client.getProtocolEra())}`)
    }

    const tools = await client.listTools()
    assertSortedEqual(tools.tools.map((tool) => tool.name), DERO_TOOL_NAMES, 'modern tools/list')
    assertReadOnlyAnnotations(tools.tools as ToolWithAnnotations[])

    const resources = await client.listResources()
    assertSortedEqual(resources.resources.map((resource) => resource.uri), DERO_RESOURCE_URIS, 'modern resources/list')

    const prompts = await client.listPrompts()
    assertSortedEqual(prompts.prompts.map((prompt) => prompt.name), DERO_PROMPT_NAMES, 'modern prompts/list')

    await checkSkillsSurface(client, '2026 stdio')
    await checkSkillsParamValidation(client, '2026 stdio', 'modern')

    console.log(`OK  2026 stdio    ${tools.tools.length} tools · ${resources.resources.length} resources · ${prompts.prompts.length} prompts · 4 skills`)
  } finally {
    await client.close()
    await transport.close()
  }
}

async function main() {
  const daemonUrl = parseArgs(process.argv.slice(2))
  console.log(`[smoke:mcp] daemon=${daemonUrl}`)
  console.log('================================')

  checkSkillParser()
  console.log('OK  skills/parser   canonical + strict frontmatter guards')

  await checkPublicFallbackPrivacy()
  console.log('OK  privacy         public fallback instructions + server-info disclosure')

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      DERO_DAEMON_URL: daemonUrl,
    } as Record<string, string>,
  })

  const client = new Client({
    name: 'dero-mcp-smoke-probes',
    version: '1.0.0',
  })

  try {
    await client.connect(transport)
    if (client.getProtocolEra() !== 'legacy') {
      throw new Error(`expected legacy stdio era, got ${String(client.getProtocolEra())}`)
    }

    const tools = await client.listTools()
    const toolNames = tools.tools.map((t) => t.name)
    assertSortedEqual(toolNames, DERO_TOOL_NAMES, 'tools/list')
    console.log(`OK  tools/list      ${toolNames.length} tools`)

    assertReadOnlyAnnotations(tools.tools as ToolWithAnnotations[])
    console.log(`OK  tools/list      annotations (read-only) on ${toolNames.length}/${toolNames.length}`)

    const resources = await client.listResources()
    const resourceUris = resources.resources.map((r) => r.uri)
    assertSortedEqual(resourceUris, DERO_RESOURCE_URIS, 'resources/list')
    console.log(`OK  resources/list  ${resourceUris.length} resources`)

    const prompts = await client.listPrompts()
    const promptNames = prompts.prompts.map((p) => p.name)
    assertSortedEqual(promptNames, DERO_PROMPT_NAMES, 'prompts/list')
    console.log(`OK  prompts/list    ${promptNames.length} prompts`)

    const prompt = await client.getPrompt({
      name: 'inspect_smart_contract',
      arguments: { scid: NAME_REGISTRY_SCID },
    })
    if (!prompt.messages?.length) {
      throw new Error('prompts/get returned zero messages')
    }
    console.log('OK  prompts/get     inspect_smart_contract')

    // MCP prompt arguments are always strings. These two prompts take a
    // numeric / boolean-shaped optional arg; their schemas must coerce the
    // string form (z.coerce.number / z.enum('true','false')) or a
    // spec-compliant client supplying them gets InvalidParams. Probe with the
    // string values to lock the coercion in.
    const promptWithNumberArg = await client.getPrompt({
      name: 'network_health_check',
      arguments: { reference_topoheight: '7000000' },
    })
    if (!promptWithNumberArg.messages?.length) {
      throw new Error('prompts/get network_health_check rejected string reference_topoheight')
    }
    const promptWithBoolArg = await client.getPrompt({
      name: 'estimate_deploy_for_contract',
      arguments: {
        sc_source: 'Function Initialize() Uint64\n10 RETURN 0\nEnd Function',
        include_breakdown: 'false',
      },
    })
    if (!promptWithBoolArg.messages?.length) {
      throw new Error('prompts/get estimate_deploy_for_contract rejected string include_breakdown')
    }
    console.log('OK  prompts/get     string-typed args coerce (number + boolean)')

    await checkSkillsSurface(client, '2025 stdio')
    await checkSkillsParamValidation(client, '2025 stdio', 'legacy')
    console.log('OK  skills          native list/get/resources + fallback loader')

    const structuredErrorProbe = (await client.callTool({
      name: 'dero_get_block',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> }
    // Tool failures must be flagged at the protocol level so hosts that branch
    // on isError (before parsing content) see the call as failed.
    if (structuredErrorProbe.isError !== true) {
      throw new Error('structured error probe did not set isError: true')
    }
    const errorPayload = parseFirstTextJson(structuredErrorProbe) as {
      ok?: boolean
      _meta?: { error?: { code?: string; hint?: string; retryable?: boolean } }
    }
    if (
      errorPayload.ok !== false ||
      !errorPayload._meta?.error?.code ||
      typeof errorPayload._meta.error.hint !== 'string' ||
      typeof errorPayload._meta.error.retryable !== 'boolean'
    ) {
      throw new Error('structured error probe did not return expected _meta.error shape')
    }
    console.log('OK  tools/call      structured _meta.error probe (isError + envelope)')

    await checkModernStdio(daemonUrl)

    console.log('')
    console.log('All MCP smoke probes passed.')
  } catch (error) {
    console.error('')
    console.error('[smoke:mcp] FAIL:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await client.close()
    await transport.close()
  }
}

main()
