#!/usr/bin/env npx tsx
/**
 * HTTP smoke probes — boots dero-mcp-server with --http, exercises the
 * core endpoints, kills the subprocess. Complements scripts/mcp-smoke-probes.ts
 * (which covers the stdio path). Run via `npm run smoke:http`.
 *
 * Checks:
 *   1. /health returns 200 with version + transport=streamable-http
 *   2. 2025 and 2026-07-28 clients see the same tools/resources/prompts/skills
 *   3. POST /mcp without bearer returns 401 when DERO_MCP_AUTH_TOKEN is set
 *   4. Unknown paths return 404
 *
 * No daemon network required for steps 1, 3, 4. Step 2 hits tools/list
 * which doesn't itself call the daemon — only invoking a chain-query
 * tool would, and we don't do that here.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { DERO_PROMPT_NAMES, DERO_RESOURCE_URIS } from '../src/server.js'
import { DERO_TOOL_NAMES } from '../src/tool-descriptions.js'
import { DERO_SKILL_URIS } from '../src/skills.js'
import { jsonRpcEndpoint, normalizeDaemonBaseUrl, redactDaemonUrl } from '../src/rpc.js'
import { checkSkillsSurface } from './skill-smoke.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js')

const HOST = '127.0.0.1'
const AUTH_TOKEN = 'smoke-test-token-do-not-use-in-production'
const URL_SECRET = 'sentinel-daemon-query-secret'
let baseUrl = ''
let serverStderr = ''

type JsonObject = Record<string, unknown>
type WireExchange = {
  request: JsonObject
  requestHeaders: Record<string, string>
  responses: JsonObject[]
}

const projectedSkillsListSchema = z.object({ skills: z.array(z.unknown()) }).passthrough()
const projectedSkillGetSchema = z.object({ skill: z.unknown() }).passthrough()

function assertSortedEqual(actual: string[], expected: readonly string[], label: string): void {
  const a = [...actual].sort()
  const e = [...expected].sort()
  if (a.length !== e.length || a.some((value, index) => value !== e[index])) {
    throw new Error(`${label}: expected ${e.join(', ')}, got ${a.join(', ')}`)
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseWireMessages(text: string): JsonObject[] {
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  const parsed = payloads.length > 0 ? payloads.map((payload) => JSON.parse(payload)) : [JSON.parse(text)]
  return parsed.flatMap((value) => (Array.isArray(value) ? value : [value])) as JsonObject[]
}

function wireResult(exchange: WireExchange): JsonObject {
  const response = exchange.responses.find((message) => message['id'] === exchange.request['id'])
  if (!response) throw new Error(`missing wire response for ${String(exchange.request['method'])}`)
  if (response['error']) {
    throw new Error(`${String(exchange.request['method'])} wire error: ${JSON.stringify(response['error'])}`)
  }
  return response['result'] as JsonObject
}

function findExchange(exchanges: WireExchange[], method: string): WireExchange {
  const exchange = exchanges.find((candidate) => candidate.request['method'] === method)
  if (!exchange) throw new Error(`wire capture missing ${method}`)
  return exchange
}

async function postCapturedRequest(
  template: WireExchange,
  request: JsonObject,
): Promise<JsonObject> {
  const headers = { ...template.requestHeaders }
  delete headers['content-length']
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  if (response.status !== 200 && response.status !== 400) {
    throw new Error(`raw HTTP probe returned ${response.status}, expected JSON-RPC HTTP 200/400`)
  }
  if (response.headers.has('mcp-session-id')) {
    throw new Error('raw stateless HTTP response included Mcp-Session-Id')
  }
  const messages = parseWireMessages(await response.text())
  const match = messages.find((message) => message['id'] === request['id'])
  if (!match) throw new Error('raw HTTP probe response ID mismatch')
  return match
}

function findSkillsCapability(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const object = value as JsonObject
  const extensions = (object['capabilities'] as JsonObject | undefined)?.['extensions'] as
    | JsonObject
    | undefined
  if (extensions && 'io.modelcontextprotocol/skills' in extensions) {
    return extensions['io.modelcontextprotocol/skills']
  }
  for (const child of Object.values(object)) {
    const found = findSkillsCapability(child)
    if (found !== undefined) return found
  }
  return undefined
}

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
    const protocolError = error as { code?: number; data?: JsonObject }
    if (protocolError.code === -32602 && protocolError.data?.['uri'] === uri) return
    throw new Error(
      `${label}: expected -32602 with URI data, got ${String(protocolError.code)} ${JSON.stringify(protocolError.data)}`,
    )
  }
  throw new Error(`${label}: unknown resources/read URI succeeded`)
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit').then(([code, signal]) => ({
    code: code as number | null,
    signal,
  }))
  child.kill('SIGTERM')
  const cleanExit = await Promise.race([
    exited,
    sleep(5000).then(() => undefined),
  ])
  if (!cleanExit) {
    child.kill('SIGKILL')
    await once(child, 'exit')
    throw new Error('HTTP server did not exit within 5s of SIGTERM')
  }
  // On Windows, Node implements child.kill('SIGTERM') with TerminateProcess;
  // the child cannot run its JS signal handler or translate that into exit 0.
  // POSIX must prove the graceful handler completed with code 0.
  const windowsTerminate = process.platform === 'win32' && cleanExit.signal === 'SIGTERM'
  if (cleanExit.code !== 0 && !windowsTerminate) {
    throw new Error(`HTTP server exited with code ${String(cleanExit.code)} (${String(cleanExit.signal)})`)
  }
}

async function waitForReady(maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await sleep(100)
  }
  throw new Error(`HTTP server did not become ready within ${maxMs}ms`)
}

function spawnServer(): { child: ChildProcess; listening: Promise<string> } {
  serverStderr = ''
  const child = spawn('node', [SERVER_ENTRY, '--http'], {
    env: {
      ...process.env,
      DERO_MCP_HTTP_PORT: '0',
      DERO_MCP_HTTP_HOST: HOST,
      DERO_MCP_AUTH_TOKEN: AUTH_TOKEN,
      DERO_DAEMON_URL: `http://127.0.0.1:1/rpc?token=${URL_SECRET}`,
    },
    stdio: ['ignore', 'inherit', 'pipe'],
  })
  const listening = new Promise<string>((resolve, reject) => {
    let stderr = ''
    let settled = false
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      process.stderr.write(text)
      serverStderr += text
      stderr += text
      const match = stderr.match(/HTTP listening on .*:(\d+) \(POST \/mcp/)
      if (match && !settled) {
        settled = true
        resolve(`http://${HOST}:${match[1]}`)
      }
    })
    child.once('error', (error) => {
      if (!settled) reject(error)
    })
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`HTTP server exited before listening (${String(code ?? signal)})`))
    })
  })
  return { child, listening }
}

function checkDaemonUrlSafety(): void {
  const tokenized = `https://node.example/rpc?token=${URL_SECRET}`
  const fullEndpoint = `https://node.example/rpc/json_rpc?token=${URL_SECRET}`
  if (jsonRpcEndpoint(tokenized) !== `https://node.example/rpc/json_rpc?token=${URL_SECRET}`) {
    throw new Error('jsonRpcEndpoint did not preserve the query while appending /json_rpc')
  }
  if (
    jsonRpcEndpoint(fullEndpoint) !== fullEndpoint ||
    normalizeDaemonBaseUrl(fullEndpoint) !== tokenized
  ) {
    throw new Error('a full /json_rpc URL was duplicated or normalized incorrectly')
  }
  for (const query of ['token=abc/', 'token=a/?b']) {
    const base = `https://node.example/rpc?${query}`
    if (
      normalizeDaemonBaseUrl(base) !== base ||
      jsonRpcEndpoint(base) !== `https://node.example/rpc/json_rpc?${query}`
    ) {
      throw new Error(`daemon URL normalization corrupted query value: ${query}`)
    }
  }
  if (normalizeDaemonBaseUrl(`${tokenized}#fragment`) !== tokenized) {
    throw new Error('daemon base normalization did not preserve query/remove fragment')
  }
  if (redactDaemonUrl(tokenized) !== 'https://node.example/rpc') {
    throw new Error('daemon display URL did not remove query credentials')
  }
  try {
    jsonRpcEndpoint(`https://user:${URL_SECRET}@node.example`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('must not include userinfo') || message.includes(URL_SECRET)) {
      throw new Error(`userinfo rejection was not secret-safe: ${message}`)
    }
    process.stdout.write('  ✓ daemon URLs preserve private query data, redact displays, reject userinfo\n')
    return
  }
  throw new Error('daemon URL userinfo credentials were accepted')
}

async function checkNonLoopbackRequiresAllowlist(): Promise<void> {
  const child = spawn('node', [SERVER_ENTRY, '--http'], {
    env: {
      ...process.env,
      DERO_MCP_HTTP_PORT: '0',
      DERO_MCP_HTTP_HOST: '0.0.0.0',
      DERO_MCP_ALLOWED_HOSTS: '',
      DERO_MCP_ALLOWED_ORIGINS: '',
      DERO_DAEMON_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const result = await Promise.race([
    once(child, 'close').then(([code]) => code as number | null),
    sleep(3000).then(() => undefined),
  ])
  if (result === undefined) {
    child.kill('SIGKILL')
    await once(child, 'close')
    throw new Error('non-loopback HTTP server started without DERO_MCP_ALLOWED_HOSTS')
  }
  if (result !== 1 || !stderr.includes('DERO_MCP_ALLOWED_HOSTS is required')) {
    throw new Error(`non-loopback allowlist guard exited ${String(result)}: ${stderr.trim()}`)
  }
  process.stdout.write('  ✓ non-loopback bind requires DERO_MCP_ALLOWED_HOSTS\n')
}

function rawMcpStatus(extraHeaders: Record<string, string>): Promise<number> {
  const target = new URL(baseUrl)
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: target.host,
        authorization: `Bearer ${AUTH_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function checkRequestGuards(): Promise<void> {
  const attempts: Array<[string, Record<string, string>]> = [
    ['malformed Host', { host: '[' }],
    ['foreign Host', { host: 'evil.example' }],
    ['foreign Origin', { origin: 'https://evil.example' }],
    ['opaque Origin', { origin: 'null' }],
  ]
  for (const [label, headers] of attempts) {
    const status = await rawMcpStatus(headers)
    if (status !== 403) throw new Error(`${label} returned ${status}, expected 403`)
  }
  await checkHealth()
  process.stdout.write('  ✓ Host/Origin guards → 403 and server survives malformed input\n')
}

async function checkHealth(): Promise<void> {
  const res = await fetch(`${baseUrl}/health`)
  if (res.status !== 200) throw new Error(`/health returned ${res.status}, expected 200`)
  const body = (await res.json()) as Record<string, unknown>
  if (body['status'] !== 'ok') throw new Error(`/health status: ${JSON.stringify(body['status'])}`)
  if (body['transport'] !== 'streamable-http') throw new Error(`/health transport: ${JSON.stringify(body['transport'])}`)
  if (typeof body['version'] !== 'string' || !body['version']) throw new Error('/health version missing')
  if (body['daemon_source'] !== 'env') throw new Error(`/health daemon_source: ${JSON.stringify(body['daemon_source'])}`)
  if (typeof body['privacy_notice'] !== 'string' || !body['privacy_notice']) throw new Error('/health privacy_notice missing')
  if (JSON.stringify(body).includes(URL_SECRET) || serverStderr.includes(URL_SECRET)) {
    throw new Error('daemon URL query secret leaked through health metadata or stderr')
  }
  process.stdout.write(`  ✓ /health → 200 ${JSON.stringify(body)}\n`)
}

async function checkMcpClient(era: 'legacy' | 'modern'): Promise<void> {
  let sawSessionHeader = false
  const exchanges: WireExchange[] = []
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: { token: async () => AUTH_TOKEN },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const requestText = await request.clone().text()
      const response = await fetch(request)
      sawSessionHeader ||= response.headers.has('mcp-session-id')
      if (requestText) {
        const requestMessages = parseWireMessages(requestText)
        const responseText = await response.clone().text()
        const responseMessages = responseText ? parseWireMessages(responseText) : []
        for (const requestMessage of requestMessages) {
          exchanges.push({
            request: requestMessage,
            requestHeaders: Object.fromEntries(request.headers.entries()),
            responses: responseMessages,
          })
        }
      }
      return response
    },
  })
  const client = new Client(
    { name: `dero-http-${era}-smoke`, version: '1.0.0' },
    era === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : {},
  )

  try {
    await client.connect(transport)
    if (client.getProtocolEra() !== era) {
      throw new Error(`${era} client negotiated ${String(client.getProtocolEra())}`)
    }

    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ])
    assertSortedEqual(tools.tools.map((tool) => tool.name), DERO_TOOL_NAMES, `${era} tools/list`)
    assertSortedEqual(resources.resources.map((resource) => resource.uri), DERO_RESOURCE_URIS, `${era} resources/list`)
    assertSortedEqual(prompts.prompts.map((prompt) => prompt.name), DERO_PROMPT_NAMES, `${era} prompts/list`)
    await checkSkillsSurface(client, `${era === 'modern' ? '2026' : '2025'} HTTP`)

    const skillsListCallsBefore = exchanges.filter(
      (exchange) => exchange.request['method'] === 'skills/list',
    ).length
    const parallel = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.request({ method: 'skills/list', params: {} }, projectedSkillsListSchema),
      ),
    )
    if (parallel.some((result) => result.skills.length !== 4)) {
      throw new Error(`${era} concurrent skills/list returned an incomplete catalog`)
    }
    const skillsListCallsAfter = exchanges.filter(
      (exchange) => exchange.request['method'] === 'skills/list',
    ).length
    if (skillsListCallsAfter - skillsListCallsBefore !== 8) {
      throw new Error(`${era} concurrency probe did not issue eight HTTP requests`)
    }

    const omittedList = await client.request({ method: 'skills/list' }, projectedSkillsListSchema)
    if (omittedList.skills.length !== 4) throw new Error(`${era} omitted list params failed`)
    const metaList = await client.request(
      { method: 'skills/list', params: { _meta: { 'acme.example/probe': { ok: true } } } },
      projectedSkillsListSchema,
    )
    if (metaList.skills.length !== 4) throw new Error(`${era} namespaced _meta list failed`)
    await expectInvalidParams(`${era} empty cursor`, () =>
      client.request({ method: 'skills/list', params: { cursor: '' } }, projectedSkillsListSchema),
    )
    await expectInvalidParams(`${era} non-string cursor`, () =>
      client.request({ method: 'skills/list', params: { cursor: 42 } }, projectedSkillsListSchema),
    )
    await expectInvalidParams(`${era} extra list param`, () =>
      client.request(
        { method: 'skills/list', params: { unexpected: true } },
        projectedSkillsListSchema,
      ),
    )
    await expectInvalidParams(`${era} empty skill URI`, () =>
      client.request({ method: 'skills/get', params: { uri: '' } }, projectedSkillGetSchema),
    )
    await expectInvalidParams(`${era} non-string skill URI`, () =>
      client.request({ method: 'skills/get', params: { uri: 42 } }, projectedSkillGetSchema),
    )
    await expectInvalidParams(`${era} noncanonical skill URI`, () =>
      client.request(
        { method: 'skills/get', params: { uri: 'DERO://skills/dero' } },
        projectedSkillGetSchema,
      ),
    )
    await expectInvalidParams(`${era} traversal skill URI`, () =>
      client.request(
        { method: 'skills/get', params: { uri: 'dero://skills/dero/../tela' } },
        projectedSkillGetSchema,
      ),
    )
    await expectInvalidParams(`${era} missing skill URI`, () =>
      client.request({ method: 'skills/get', params: {} }, projectedSkillGetSchema),
    )
    await expectInvalidParams(`${era} extra get param`, () =>
      client.request(
        { method: 'skills/get', params: { uri: DERO_SKILL_URIS[0], unexpected: true } },
        projectedSkillGetSchema,
      ),
    )
    await expectUnknownResource(client, `${era} unknown resource`)

    const listWire = wireResult(findExchange(exchanges, 'skills/list'))
    if (listWire['resultType'] !== 'complete') throw new Error(`${era} skills/list missing raw resultType`)
    if (era === 'modern') {
      if (listWire['ttlMs'] !== 300_000 || listWire['cacheScope'] !== 'public') {
        throw new Error('modern skills/list missing public 300000ms cache hint on wire')
      }
    } else if ('ttlMs' in listWire || 'cacheScope' in listWire) {
      throw new Error('legacy skills/list unexpectedly included modern cache hints')
    }
    const getWire = wireResult(findExchange(exchanges, 'skills/get'))
    if ('ttlMs' in getWire || 'cacheScope' in getWire) {
      throw new Error(`${era} skills/get unexpectedly included cache hints`)
    }

    const listTemplate = findExchange(exchanges, 'skills/list')
    const malformedMeta = {
      ...listTemplate.request,
      id: `raw-${era}-invalid-meta`,
      params: { _meta: null },
    }
    const malformedMetaResponse = await postCapturedRequest(listTemplate, malformedMeta)
    const malformedMetaCode = (malformedMetaResponse['error'] as JsonObject | undefined)?.['code']
    if (malformedMetaCode !== -32600) {
      throw new Error(`${era} malformed _meta returned ${String(malformedMetaCode)}, expected -32600`)
    }

    const handshakeMethod = era === 'modern' ? 'server/discover' : 'initialize'
    const handshakeWire = wireResult(findExchange(exchanges, handshakeMethod))
    const capability = findSkillsCapability(handshakeWire)
    if (!capability || JSON.stringify(capability) !== '{}') {
      throw new Error(`${era} handshake missing io.modelcontextprotocol/skills capability`)
    }
    const capabilities = client.getServerCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined
    if (JSON.stringify(capabilities?.extensions?.['io.modelcontextprotocol/skills']) !== '{}') {
      throw new Error(`${era} SDK projection missing io.modelcontextprotocol/skills capability`)
    }

    const info = await client.readResource({ uri: 'dero://mcp/server-info' })
    const infoText = info.contents.find((content) => 'text' in content)?.text
    const metadata = JSON.parse(String(infoText)) as JsonObject
    if (metadata['daemon_source'] !== 'env' || typeof metadata['privacy_notice'] !== 'string') {
      throw new Error(`${era} server-info missing daemon source/privacy notice`)
    }
    if (String(infoText).includes(URL_SECRET)) throw new Error(`${era} server-info leaked daemon URL query secret`)
    if (sawSessionHeader) throw new Error(`${era} stateless HTTP response included Mcp-Session-Id`)

    process.stdout.write(
      `  ✓ ${era === 'modern' ? '2026' : '2025'} HTTP client → ${tools.tools.length} tools · ${resources.resources.length} resources · ${prompts.prompts.length} prompts · 4 skills · 8 concurrent raw calls\n`,
    )
  } finally {
    await client.close()
    await transport.close()
  }
}

async function checkAuthEnforced(): Promise<void> {
  const attempts: Array<[string, string | undefined]> = [
    ['missing bearer', undefined],
    ['wrong same-length bearer', `Bearer ${'x'.repeat(AUTH_TOKEN.length)}`],
    ['wrong different-length bearer', 'Bearer wrong'],
    ['wrong auth scheme', `Basic ${AUTH_TOKEN}`],
  ]
  for (const [label, authorization] of attempts) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    }
    if (authorization) headers['authorization'] = authorization
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    if (res.status !== 401) {
      throw new Error(`/mcp ${label} returned ${res.status}, expected 401`)
    }
    const wwwAuth = res.headers.get('www-authenticate')
    if (!wwwAuth || !wwwAuth.toLowerCase().includes('bearer')) {
      throw new Error(`/mcp ${label} 401 missing WWW-Authenticate: Bearer header`)
    }
  }
  process.stdout.write('  ✓ POST /mcp auth failures → 401 (missing/same-length/different-length/scheme)\n')
}

async function checkReconnect(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: { token: async () => AUTH_TOKEN },
  })
  const client = new Client({ name: 'dero-http-reconnect-smoke', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assertSortedEqual(tools.tools.map((tool) => tool.name), DERO_TOOL_NAMES, 'reconnect tools/list')
  } finally {
    await client.close()
    await transport.close()
  }
  process.stdout.write('  ✓ fresh HTTP client reconnect → connect/list/close\n')
}

async function checkStatelessMethods(): Promise<void> {
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (res.status !== 405) throw new Error(`${method} /mcp returned ${res.status}, expected 405`)
    if (res.headers.has('mcp-session-id')) {
      throw new Error(`${method} /mcp stateless response included Mcp-Session-Id`)
    }
  }
  process.stdout.write('  ✓ GET/DELETE /mcp → 405 without session headers\n')
}

async function checkUnknownPath(): Promise<void> {
  const res = await fetch(`${baseUrl}/this-path-does-not-exist`)
  if (res.status !== 404) {
    throw new Error(`/this-path-does-not-exist returned ${res.status}, expected 404`)
  }
  process.stdout.write(`  ✓ GET /unknown-path → 404\n`)
}

async function main(): Promise<void> {
  checkDaemonUrlSafety()
  await checkNonLoopbackRequiresAllowlist()
  process.stdout.write('[smoke:http] booting dero-mcp-server --http on an ephemeral port\n')
  const { child, listening } = spawnServer()
  try {
    baseUrl = await listening
    process.stdout.write(`[smoke:http] endpoint=${baseUrl}/mcp\n`)
    await waitForReady()
    await checkHealth()
    await Promise.all([checkMcpClient('legacy'), checkMcpClient('modern')])
    await checkReconnect()
    await checkAuthEnforced()
    await checkRequestGuards()
    await checkStatelessMethods()
    await checkUnknownPath()
    process.stdout.write('\n[smoke:http] OK — HTTP transport contract holds.\n')
  } finally {
    await stopServer(child)
  }
}

main().catch((err) => {
  process.stderr.write(`\n[smoke:http] FAIL — ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
