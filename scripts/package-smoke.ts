#!/usr/bin/env npx tsx
/**
 * Pack, install, and run the exact npm artifact from an isolated path.
 *
 * The temporary package and process working directories deliberately contain
 * spaces. This catches package-relative asset loading bugs that source-tree
 * probes miss (especially `skills/<name>/SKILL.md` resolution on Windows).
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { checkSkillsSurface } from './skill-smoke.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_FILES = [
  'LICENSE',
  'POSITIONING.md',
  'README.md',
  'SKILL.md',
  'data',
  'docs/assets',
  'dist',
  'skills',
] as const
const EXPECTED_ASSETS = ['dero-mcp-hero.webp', 'dero-mcp-read-flow.svg'] as const
const EXPECTED_SKILLS = ['dero', 'deropay', 'hologram', 'tela'] as const
const EXPECTED_COUNTS = { tools: 34, resources: 8, prompts: 5 } as const
const MAX_HERO_BYTES = 500 * 1024
const MAX_SKILL_BYTES = 16 * 1024 * 1024

type PackageManifest = {
  name?: string
  version?: string
  main?: string
  bin?: Record<string, string>
  files?: string[]
  engines?: { node?: string }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

function safeTempRoot(tempRoot: string): string {
  const resolved = realpathSync(tempRoot)
  const realTempDirectory = realpathSync(tmpdir())
  assert(path.dirname(resolved) === realTempDirectory, 'temporary package root is outside the real system temp directory')
  assert(path.basename(resolved).startsWith('dero package smoke '), 'temporary package root has an unexpected name')
  return resolved
}

function runNpm(args: string[], cwd: string): void {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && existsSync(npmExecPath) && /npm(?:-cli)?\.js$/i.test(npmExecPath)) {
    execFileSync(process.execPath, [npmExecPath, ...args], { cwd, stdio: 'inherit' })
    return
  }

  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

function assertPackedMarkdownLinks(packageRoot: string): void {
  const markdownFiles = [
    'README.md',
    'POSITIONING.md',
    'SKILL.md',
    ...EXPECTED_SKILLS.map((name) => `skills/${name}/SKILL.md`),
  ]
  const packagePrefix = `${path.resolve(packageRoot)}${path.sep}`

  for (const relative of markdownFiles) {
    const markdownPath = path.join(packageRoot, relative)
    const markdown = readFileSync(markdownPath, 'utf8')
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
      const rawTarget = match[1]!.replace(/^<|>$/g, '')
      if (/^(?:#|[a-z][a-z0-9+.-]*:)/i.test(rawTarget)) continue

      let target: string
      try {
        target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]!)
      } catch {
        throw new Error(`${relative} has a malformed local link: ${rawTarget}`)
      }
      if (!target) continue

      const resolved = path.resolve(path.dirname(markdownPath), target)
      assert(resolved.startsWith(packagePrefix), `${relative} link escapes the package root: ${rawTarget}`)
      assert(existsSync(resolved), `${relative} has a broken packed link: ${rawTarget}`)
    }
  }
}

function assertPackageContents(packageRoot: string, workspacePackage: PackageManifest): string {
  const installedPackagePath = path.join(packageRoot, 'package.json')
  const installedPackage = JSON.parse(readFileSync(installedPackagePath, 'utf8')) as PackageManifest

  assert(installedPackage.name === 'dero-mcp-server', 'installed package name drifted')
  assert(installedPackage.version === workspacePackage.version, 'installed package version differs from workspace')
  assert(installedPackage.main === './dist/index.js', 'installed package main must be ./dist/index.js')
  assert(installedPackage.bin?.['dero-mcp-server'] === './dist/index.js', 'installed package bin target drifted')
  assert(installedPackage.engines?.node === '>=20', 'installed package Node engine must remain >=20')
  assert(
    JSON.stringify(sorted(installedPackage.files ?? [])) === JSON.stringify(sorted(EXPECTED_FILES)),
    `installed package files[] must be exactly: ${EXPECTED_FILES.join(', ')}`,
  )

  for (const relative of [...EXPECTED_FILES, 'package.json']) {
    assert(existsSync(path.join(packageRoot, relative)), `packed artifact is missing ${relative}`)
  }
  for (const forbidden of ['src', 'scripts', 'node_modules']) {
    assert(!existsSync(path.join(packageRoot, forbidden)), `packed artifact unexpectedly includes ${forbidden}/`)
  }

  const assetRoot = path.join(packageRoot, 'docs', 'assets')
  const assets = readdirSync(assetRoot)
  assert(
    JSON.stringify(sorted(assets)) === JSON.stringify(sorted(EXPECTED_ASSETS)),
    `packed docs/assets must contain exactly: ${EXPECTED_ASSETS.join(', ')}; got ${assets.join(', ')}`,
  )
  for (const name of EXPECTED_ASSETS) {
    const source = readFileSync(path.join(ROOT, 'docs', 'assets', name))
    const packed = readFileSync(path.join(assetRoot, name))
    assert(source.equals(packed), `packed docs/assets/${name} is not byte-identical to the source asset`)
  }

  const hero = readFileSync(path.join(assetRoot, 'dero-mcp-hero.webp'))
  assert(hero.length >= 12, 'DERO MCP hero is too short to be a WebP file')
  assert(hero.length <= MAX_HERO_BYTES, 'DERO MCP hero must not exceed 500 KiB')
  assert(hero.toString('ascii', 0, 4) === 'RIFF', 'DERO MCP hero is missing its RIFF signature')
  assert(hero.toString('ascii', 8, 12) === 'WEBP', 'DERO MCP hero is missing its WEBP signature')

  const diagram = readFileSync(path.join(assetRoot, 'dero-mcp-read-flow.svg'), 'utf8')
  assert(/<svg\b[^>]*\brole\s*=\s*["']img["'][^>]*>/i.test(diagram), 'DERO MCP diagram must set role="img" on its SVG root')
  assert(/<title\b[^>]*>\s*\S[\s\S]*?<\/title>/i.test(diagram), 'DERO MCP diagram must have a non-empty <title>')
  assert(/<desc\b[^>]*>\s*\S[\s\S]*?<\/desc>/i.test(diagram), 'DERO MCP diagram must have a non-empty <desc>')
  assert(!/<\s*(?:\w+:)?script\b/i.test(diagram), 'DERO MCP diagram must not contain script')
  assert(!/\b(?:xlink:)?href\s*=\s*["']?\s*https?:\/\//i.test(diagram), 'DERO MCP diagram must not contain external HTTP hrefs')

  const readme = readFileSync(path.join(packageRoot, 'README.md'), 'utf8')
  for (const name of EXPECTED_ASSETS) {
    assert(readme.includes(`docs/assets/${name}`), `README.md does not reference docs/assets/${name}`)
  }
  assertPackedMarkdownLinks(packageRoot)

  const skillRoot = path.join(packageRoot, 'skills')
  const skillDirectories = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert(
    JSON.stringify(sorted(skillDirectories)) === JSON.stringify(sorted(EXPECTED_SKILLS)),
    `packed artifact must contain exactly four skill directories; got ${skillDirectories.join(', ')}`,
  )

  for (const name of EXPECTED_SKILLS) {
    const directory = path.join(skillRoot, name)
    const entries = readdirSync(directory)
    assert(entries.length === 1 && entries[0] === 'SKILL.md', `${name} skill directory must contain only SKILL.md`)
    const source = readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'))
    const packed = readFileSync(path.join(directory, 'SKILL.md'))
    assert(source.length > 0 && source.length <= MAX_SKILL_BYTES, `${name}/SKILL.md must be 1 byte..16 MiB`)
    assert(
      !(source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf),
      `${name}/SKILL.md must not start with a UTF-8 BOM`,
    )
    assert(!source.includes(0x00), `${name}/SKILL.md must not contain NUL bytes`)
    assert(!source.includes(0x0d), `${name}/SKILL.md must use LF-only newlines`)
    assert(source[source.length - 1] === 0x0a, `${name}/SKILL.md must end with LF`)
    assert(source.equals(packed), `packed ${name}/SKILL.md is not byte-identical to the source skill`)
  }

  const rootSkill = readFileSync(path.join(packageRoot, 'SKILL.md'), 'utf8')
  assert(rootSkill.startsWith('# DERO MCP Skill Index\n'), 'root SKILL.md must remain a non-frontmatter compatibility index')
  for (const name of EXPECTED_SKILLS) {
    assert(rootSkill.includes(`skills/${name}/SKILL.md`), `root SKILL.md does not link the ${name} skill`)
  }
  assert(rootSkill.includes('read_dero_skill'), 'root SKILL.md must name the compatibility loader')

  const docsIndex = JSON.parse(readFileSync(path.join(packageRoot, 'data', 'docs-index.json'), 'utf8')) as {
    page_count?: number
    pages?: unknown[]
  }
  assert(docsIndex.page_count === 154 && docsIndex.pages?.length === 154, 'packed docs index must contain 154 pages')

  const entry = path.resolve(packageRoot, installedPackage.bin['dero-mcp-server'])
  assert(entry.startsWith(`${path.resolve(packageRoot)}${path.sep}`), 'package bin target escapes the package root')
  assert(existsSync(entry) && lstatSync(entry).isFile(), 'installed package bin target is missing')
  return entry
}

async function checkInstalledServer(
  launch: { command: string; args: string[] },
  foreignCwd: string,
  era: 'legacy' | 'modern',
): Promise<void> {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: foreignCwd,
    env: {
      ...process.env,
      DERO_DAEMON_URL: 'http://127.0.0.1:1',
    } as Record<string, string>,
  })
  const client = era === 'modern'
    ? new Client(
      { name: 'dero-package-smoke-modern', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )
    : new Client({ name: 'dero-package-smoke-legacy', version: '1.0.0' })

  try {
    await client.connect(transport)
    assert(client.getProtocolEra() === era, `${era}: installed server negotiated ${String(client.getProtocolEra())}`)

    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ])
    assert(tools.tools.length === EXPECTED_COUNTS.tools, `${era}: expected 34 tools, got ${tools.tools.length}`)
    assert(resources.resources.length === EXPECTED_COUNTS.resources, `${era}: expected 8 resources, got ${resources.resources.length}`)
    assert(prompts.prompts.length === EXPECTED_COUNTS.prompts, `${era}: expected 5 prompts, got ${prompts.prompts.length}`)
    await checkSkillsSurface(client, `${era} packed install`)
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const workspacePackage = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageManifest
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dero package smoke '))
  safeTempRoot(tempRoot)

  try {
    const packDirectory = path.join(tempRoot, 'packed tarball')
    const consumerRoot = path.join(tempRoot, 'installed consumer')
    const foreignCwd = path.join(tempRoot, 'foreign working directory')
    mkdirSync(packDirectory, { recursive: true })
    mkdirSync(consumerRoot, { recursive: true })
    mkdirSync(foreignCwd, { recursive: true })

    console.log(`[smoke:package] packing ${workspacePackage.name}@${workspacePackage.version}`)
    runNpm(['pack', '--silent', '--pack-destination', packDirectory], ROOT)
    const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith('.tgz'))
    assert(tarballs.length === 1, `npm pack produced ${tarballs.length} tarballs instead of one`)
    const tarball = path.join(packDirectory, tarballs[0]!)

    console.log('[smoke:package] installing tarball into an isolated path with spaces')
    runNpm([
      'install',
      '--prefix', consumerRoot,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ], foreignCwd)

    const packageRoot = path.join(consumerRoot, 'node_modules', 'dero-mcp-server')
    const entry = assertPackageContents(packageRoot, workspacePackage)
    const shim = path.join(
      consumerRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'dero-mcp-server.cmd' : 'dero-mcp-server',
    )
    assert(existsSync(shim), 'npm install did not create the dero-mcp-server bin shim')
    // StdioClientTransport uses cross-spawn, which resolves Unix shims and
    // Windows .cmd launchers (including paths with spaces) without a shell.
    await checkInstalledServer({ command: shim, args: [] }, foreignCwd, 'legacy')
    await checkInstalledServer({ command: process.execPath, args: [entry] }, foreignCwd, 'modern')

    console.log('[smoke:package] OK — tarball installs and runs from a foreign cwd with 34 tools · 8 resources · 5 prompts · 4 skills')
  } finally {
    rmSync(safeTempRoot(tempRoot), { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke:package] FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
