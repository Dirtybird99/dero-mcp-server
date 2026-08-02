#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createDeroMcpServer } from '../src/server.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  throw new Error(`[export:surface] ${message}`)
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    mcpName: string
    version: string
  }
  const docsIndex = JSON.parse(await readFile(path.join(repoRoot, 'data', 'docs-index.json'), 'utf8')) as {
    generated_at: string
    page_count: number
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createDeroMcpServer('http://127.0.0.1:1')
  const client = new Client({ name: 'dero-surface-export', version: packageJson.version })

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const [toolsResult, resourcesResult, promptsResult, compositesResult] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
      client.readResource({ uri: 'dero://mcp/composites' }),
    ])
    const serverVersion = client.getServerVersion()
    const compositeText = compositesResult.contents.find(
      (content): content is typeof content & { text: string } => 'text' in content,
    )?.text
    if (!compositeText) fail('dero://mcp/composites returned no text')
    const compositeCatalog = JSON.parse(compositeText) as {
      composites?: Array<{ name?: unknown }>
    }
    const composites = (compositeCatalog.composites ?? []).map(({ name }) => {
      if (typeof name !== 'string' || !name) fail('composite resource contains an invalid name')
      return name
    })

    if (serverVersion?.version !== packageJson.version) {
      fail(`runtime version ${String(serverVersion?.version)} != package ${packageJson.version}`)
    }
    if (toolsResult.tools.length !== 33 || resourcesResult.resources.length !== 4 || promptsResult.prompts.length !== 5 || composites.length !== 12) {
      fail(`unexpected surface: ${toolsResult.tools.length} tools, ${resourcesResult.resources.length} resources, ${promptsResult.prompts.length} prompts, ${composites.length} composites`)
    }
    const toolNames = new Set(toolsResult.tools.map(({ name }) => name))
    for (const name of composites) if (!toolNames.has(name)) fail(`composite ${name} is not registered as a tool`)

    const surface = {
      schemaVersion: 1,
      source: {
        repository: 'DHEBP/dero-mcp-server',
        tag: process.env.MCP_RELEASE_TAG ?? `v${packageJson.version}`,
        commit: process.env.MCP_SOURCE_SHA ?? null,
      },
      server: {
        registryName: packageJson.mcpName,
        runtimeName: serverVersion.name,
        title: 'DERO MCP Server',
        version: packageJson.version,
        websiteUrl: 'https://derod.org',
        repositoryUrl: 'https://github.com/DHEBP/dero-mcp-server',
      },
      protocols: ['2025-11-25', '2026-07-28'],
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.derod.org/mcp',
        stateless: true,
      },
      docs: {
        generatedAt: docsIndex.generated_at,
        pageCount: docsIndex.page_count,
      },
      tools: toolsResult.tools.map(({ name, description, annotations }) => ({ name, description, annotations })),
      resources: resourcesResult.resources.map(({ name, uri, description, mimeType }) => ({ name, uri, description, mimeType })),
      prompts: promptsResult.prompts.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
      composites,
    }

    process.stdout.write(`${JSON.stringify(surface, null, 2)}\n`)
  } finally {
    await client.close()
    await server.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
