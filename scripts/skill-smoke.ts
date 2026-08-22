import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { z } from 'zod'
import {
  DERO_SKILLS,
  parseDeroSkillFrontmatter,
  type DeroSkillName,
} from '../src/skills.js'

const EXPECTED_SKILL_NAMES = ['dero', 'tela', 'hologram', 'deropay'] as const
const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'

const SkillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().positive(),
}).strict()

const SkillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.object({
    name: z.string(),
    description: z.string().min(1),
  }).strict(),
  resources: z.array(SkillResourceSchema),
}).strict()

const SkillsListResultSchema = z.object({
  // The SDK consumes the wire-level result discriminator before returning.
  resultType: z.literal('complete').optional(),
  skills: z.array(SkillEntrySchema),
})

const SkillsGetResultSchema = z.object({
  resultType: z.literal('complete').optional(),
  skill: SkillEntrySchema,
})

function expectParseFailure(name: DeroSkillName, content: string, label: string): void {
  try {
    parseDeroSkillFrontmatter(name, content)
  } catch {
    return
  }
  throw new Error(`skill parser accepted ${label}`)
}

export function checkSkillParser(): void {
  for (const skill of DERO_SKILLS) {
    const parsed = parseDeroSkillFrontmatter(skill.name, skill.content)
    if (parsed.name !== skill.name || parsed.description !== skill.frontmatter.description) {
      throw new Error(`skill parser disagrees with canonical ${skill.name}`)
    }
  }

  const accepted: Array<{ label: string; content: string; description: string }> = [
    {
      label: 'LF frontmatter',
      content: '---\nname: dero\ndescription: LF workflow\n---\n# Body\n',
      description: 'LF workflow',
    },
    {
      label: 'CRLF frontmatter',
      content: '---\r\nname: dero\r\ndescription: CRLF workflow\r\n---\r\n# Body\r\n',
      description: 'CRLF workflow',
    },
    {
      label: 'no terminal newline',
      content: '---\nname: dero\ndescription: No terminal newline\n---',
      description: 'No terminal newline',
    },
    {
      label: 'multibyte plain scalar',
      content: '---\nname: dero\ndescription: Guía DERO 日本語\n---\n',
      description: 'Guía DERO 日本語',
    },
  ]
  for (const test of accepted) {
    const parsed = parseDeroSkillFrontmatter('dero', test.content)
    if (parsed.name !== 'dero' || parsed.description !== test.description) {
      throw new Error(`skill parser changed ${test.label}`)
    }
  }

  const rejected: Array<{ label: string; content: string }> = [
    { label: 'missing delimiters', content: 'name: dero\ndescription: missing delimiters' },
    { label: 'UTF-8 BOM', content: '\uFEFF---\nname: dero\ndescription: BOM\n---\n' },
    { label: 'missing name', content: '---\ndescription: Missing name\n---\n' },
    { label: 'missing description', content: '---\nname: dero\n---\n' },
    { label: 'empty description', content: '---\nname: dero\ndescription: \n---\n' },
    { label: 'duplicate name', content: '---\nname: dero\nname: dero\ndescription: Duplicate\n---\n' },
    { label: 'duplicate description', content: '---\nname: dero\ndescription: First\ndescription: Second\n---\n' },
    { label: 'extra field', content: '---\nname: dero\ndescription: Extra\ntags: dero\n---\n' },
    { label: 'mismatched name', content: '---\nname: tela\ndescription: Wrong directory\n---\n' },
    { label: 'quoted scalar', content: '---\nname: dero\ndescription: "Quoted"\n---\n' },
    { label: 'inline comment', content: '---\nname: dero\ndescription: Workflow # comment\n---\n' },
    { label: 'block scalar', content: '---\nname: dero\ndescription: |\n  Multiline\n---\n' },
    { label: 'unterminated frontmatter', content: '---\nname: dero\ndescription: Unterminated\n' },
  ]
  for (const test of rejected) expectParseFailure('dero', test.content, test.label)
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  if (result.content.length !== 1 || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') {
    throw new Error('read_dero_skill must return exactly one text content block')
  }
  return result.content[0].text
}

async function expectInvalidParams(run: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await run()
  } catch (error) {
    if ((error as { code?: unknown }).code === -32602) return
    throw new Error(`${label}: expected -32602, got ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`${label}: request unexpectedly succeeded`)
}

/** Exercise the same Skills-over-MCP contract over either connected transport. */
export async function checkSkillsSurface(client: Client, label: string): Promise<void> {
  const capabilities = client.getServerCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined
  const extension = capabilities?.extensions?.[SKILLS_EXTENSION]
  if (!extension || typeof extension !== 'object' || Object.keys(extension).length !== 0) {
    throw new Error(`${label}: missing empty ${SKILLS_EXTENSION} capability`)
  }

  const toolList = await client.listTools()
  const fallback = toolList.tools.find((tool) => tool.name === 'read_dero_skill') as
    | {
      annotations?: Record<string, unknown>
      inputSchema?: {
        type?: unknown
        properties?: Record<string, { enum?: unknown }>
        required?: unknown
        additionalProperties?: unknown
      }
    }
    | undefined
  if (!fallback) throw new Error(`${label}: tools/list is missing read_dero_skill`)
  const expectedAnnotations = {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: true,
  }
  if (
    JSON.stringify(Object.keys(fallback.annotations ?? {}).sort()) !== JSON.stringify(Object.keys(expectedAnnotations).sort()) ||
    Object.entries(expectedAnnotations).some(([key, value]) => fallback.annotations?.[key] !== value)
  ) {
    throw new Error(`${label}: read_dero_skill annotations are not the exact read-only block`)
  }
  const inputSchema = fallback.inputSchema
  if (
    inputSchema?.type !== 'object' ||
    JSON.stringify(Object.keys(inputSchema.properties ?? {})) !== JSON.stringify(['name']) ||
    JSON.stringify(inputSchema.required) !== JSON.stringify(['name']) ||
    inputSchema.additionalProperties !== false ||
    JSON.stringify(inputSchema.properties?.name?.enum) !== JSON.stringify(EXPECTED_SKILL_NAMES)
  ) {
    throw new Error(`${label}: read_dero_skill input schema must require only the canonical name enum`)
  }

  const listed = await client.request(
    { method: 'skills/list', params: {} },
    SkillsListResultSchema,
  )
  const names = listed.skills.map((skill) => skill.frontmatter.name)
  if (names.join('|') !== EXPECTED_SKILL_NAMES.join('|')) {
    throw new Error(`${label}: expected skills ${EXPECTED_SKILL_NAMES.join(', ')}, got ${names.join(', ')}`)
  }

  const advertisedResources = await client.listResources()

  for (const entry of listed.skills) {
    const expectedUri = `skill://${entry.frontmatter.name}/SKILL.md`
    if (entry.uri !== expectedUri || Object.keys(entry.frontmatter).sort().join(',') !== 'description,name') {
      throw new Error(`${label}: malformed entry for ${entry.frontmatter.name}`)
    }
    if (entry.resources.length !== 1 || entry.resources[0]?.uri !== entry.uri) {
      throw new Error(`${label}: ${entry.uri} must have one matching resource`)
    }

    const canonical = DERO_SKILLS.find((skill) => skill.name === entry.frontmatter.name)
    if (!canonical || entry.frontmatter.description !== canonical.frontmatter.description) {
      throw new Error(`${label}: ${entry.uri} frontmatter differs from the canonical skill`)
    }
    const advertised = advertisedResources.resources.find((resource) => resource.uri === entry.uri)
    if (
      advertised?.name !== canonical.name ||
      advertised.description !== canonical.frontmatter.description ||
      advertised.mimeType !== 'text/markdown'
    ) {
      throw new Error(`${label}: resources/list metadata drifted for ${entry.uri}`)
    }

    const read = await client.readResource({ uri: entry.uri })
    if (read.contents.length !== 1) {
      throw new Error(`${label}: ${entry.uri} must return exactly one resource content item`)
    }
    const content = read.contents.find((item) => item.uri === entry.uri) as
      | { uri: string; mimeType?: string; text?: string }
      | undefined
    if (content?.mimeType !== 'text/markdown' || typeof content.text !== 'string') {
      throw new Error(`${label}: ${entry.uri} did not return one text/markdown payload`)
    }
    if (content.text !== canonical.content) {
      throw new Error(`${label}: ${entry.uri} bytes differ from the canonical packaged skill`)
    }

    const resource = entry.resources[0]
    const bytes = Buffer.from(content.text, 'utf8')
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (
      resource.size !== bytes.length ||
      resource.digest !== digest ||
      JSON.stringify(resource) !== JSON.stringify(canonical.resources[0])
    ) {
      throw new Error(`${label}: size/digest mismatch for ${entry.uri}`)
    }

    const fetched = await client.request(
      { method: 'skills/get', params: { uri: entry.uri } },
      SkillsGetResultSchema,
    )
    if (JSON.stringify(fetched.skill) !== JSON.stringify(entry)) {
      throw new Error(`${label}: skills/get disagrees with skills/list for ${entry.uri}`)
    }

    const loaded = await client.callTool({
      name: 'read_dero_skill',
      arguments: { name: entry.frontmatter.name },
    }) as { content: Array<{ type: string; text?: string }> }
    if (firstText(loaded) !== content.text) {
      throw new Error(`${label}: read_dero_skill bytes differ for ${entry.frontmatter.name}`)
    }
  }

  await expectInvalidParams(
    () => client.request(
      { method: 'skills/get', params: { uri: 'skill://missing/SKILL.md' } },
      SkillsGetResultSchema,
    ),
    `${label} unknown skill URI`,
  )
  await expectInvalidParams(
    () => client.request(
      { method: 'skills/list', params: { cursor: 'not-issued' } },
      SkillsListResultSchema,
    ),
    `${label} unknown cursor`,
  )

  try {
    const invalidLoader = await client.callTool({
      name: 'read_dero_skill',
      arguments: { name: 'missing' },
    }) as { isError?: boolean }
    if (invalidLoader.isError !== true) {
      throw new Error(`${label}: invalid read_dero_skill name unexpectedly succeeded`)
    }
  } catch (error) {
    if ((error as { code?: unknown }).code !== -32602) throw error
  }
}
