import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const DERO_SKILL_NAMES = ['dero', 'tela', 'hologram', 'deropay'] as const
const MAX_SKILL_BYTES = 16 * 1024 * 1024

export type DeroSkillName = (typeof DERO_SKILL_NAMES)[number]

function parsePlainScalar(name: DeroSkillName, key: string, raw: string): string {
  const value = raw.trim()
  if (
    !value ||
    /^(?:[-?:](?:\s|$)|[!&*{}[\],#|>@`"'%])/.test(value) ||
    /(?:^|\s)#/.test(value) ||
    /:\s/.test(value)
  ) {
    throw new Error(`Skill ${name} frontmatter ${key} must be a single-line plain scalar`)
  }
  return value
}

export function parseDeroSkillFrontmatter(name: DeroSkillName, content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) throw new Error(`Skill ${name} must start with YAML frontmatter`)

  const frontmatter = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z][a-z0-9_-]*):[ \t]*(.+)$/.exec(line)
    if (!field || !['name', 'description'].includes(field[1]!)) {
      throw new Error(`Skill ${name} frontmatter supports only name and description`)
    }
    if (frontmatter.has(field[1]!)) {
      throw new Error(`Skill ${name} has duplicate frontmatter field ${field[1]}`)
    }
    frontmatter.set(field[1]!, parsePlainScalar(name, field[1]!, field[2]!))
  }

  const parsedName = frontmatter.get('name')
  const description = frontmatter.get('description')
  if (frontmatter.size !== 2 || parsedName !== name || !description) {
    throw new Error(`Skill ${name} must declare matching name and a description`)
  }

  return { name, description }
}

function loadSkill(name: DeroSkillName) {
  const bytes = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url))
  if (bytes.byteLength > MAX_SKILL_BYTES) {
    throw new Error(`Skill ${name} exceeds the 16 MiB Skills-over-MCP limit`)
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const frontmatter = parseDeroSkillFrontmatter(name, content)

  const uri = `skill://${name}/SKILL.md`
  return {
    name,
    uri,
    content,
    frontmatter,
    resources: [
      {
        uri,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.byteLength,
      },
    ],
  }
}

export type DeroSkill = ReturnType<typeof loadSkill>

export const DERO_SKILLS: DeroSkill[] = DERO_SKILL_NAMES.map(loadSkill)
export const DERO_SKILL_URIS = DERO_SKILLS.map((skill) => skill.uri)
