#!/usr/bin/env npx tsx
/**
 * Drift guard for the dero-mcp-server version pin AND the published
 * tool/resource/prompt/skill surface counts.
 *
 * The version appears in ten references across nine files. They MUST agree. This guard
 * reads each and fails non-zero on mismatch — catches the silent drift
 * that happens when one forgets to update e.g. the .env.example after
 * bumping package.json.
 *
 *   1. package.json → version
 *   2. package-lock.json → top-level + packages[""].version
 *   3. server.json → version
 *   4. server.json → packages[].version (npm registry pin)
 *   5. src/server.ts → version: '...' (both literal refs in the SDK
 *      McpServer + the dero://mcp/server-info resource)
 *   6. src/http-server.ts → PACKAGE_VERSION constant
 *   7. deploy/.env.example → DERO_MCP_VERSION=... default
 *   8. README.md → visible registry version
 *   9. CHANGELOG.md → newest release section
 *
 * It also asserts the human-facing surface counts in server.json, README, and
 * the bundled MCP overview match the exported source-of-truth arrays and the
 * four public product skills.
 *
 * Run via `npm run check:server-json`.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DERO_TOOL_NAMES } from '../src/tool-descriptions.js'
import { DERO_PROMPT_NAMES, DERO_RESOURCE_URIS } from '../src/server.js'

const SKILL_NAMES = ['dero', 'tela', 'hologram', 'deropay'] as const
const EXPECTED_DOC_PAGE_COUNT = 154

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

interface Check {
  file: string
  label: string
  extract: (text: string) => string | undefined
}

const CHECKS: Check[] = [
  {
    file: 'package.json',
    label: 'package.json version',
    extract: (text) => {
      const json = JSON.parse(text) as { version?: string }
      return json.version
    },
  },
  {
    file: 'package-lock.json',
    label: 'package-lock.json version',
    extract: (text) => {
      const json = JSON.parse(text) as { version?: string }
      return json.version
    },
  },
  {
    file: 'package-lock.json',
    label: 'package-lock.json packages[""].version',
    extract: (text) => {
      const json = JSON.parse(text) as { packages?: Record<string, { version?: string }> }
      return json.packages?.['']?.version
    },
  },
  {
    file: 'server.json',
    label: 'server.json version',
    extract: (text) => {
      const json = JSON.parse(text) as { version?: string }
      return json.version
    },
  },
  {
    file: 'server.json',
    label: 'server.json packages[].version',
    extract: (text) => {
      const json = JSON.parse(text) as { packages?: Array<{ version?: string }> }
      return json.packages?.[0]?.version
    },
  },
  {
    file: 'src/server.ts',
    label: 'src/server.ts all package version literals',
    extract: (text) => {
      const matches = [...text.matchAll(/version:\s*['"]([\d.]+)['"]/g)]
      if (matches.length !== 2) return undefined
      const values = new Set(matches.map((match) => match[1]))
      return values.size === 1 ? matches[0]?.[1] : undefined
    },
  },
  {
    file: 'src/http-server.ts',
    label: 'src/http-server.ts PACKAGE_VERSION',
    extract: (text) => {
      const m = text.match(/PACKAGE_VERSION\s*=\s*['"]([\d.]+)['"]/)
      return m?.[1]
    },
  },
  {
    file: 'deploy/.env.example',
    label: 'deploy/.env.example DERO_MCP_VERSION default',
    extract: (text) => {
      const m = text.match(/^DERO_MCP_VERSION=([\d.]+)/m)
      return m?.[1]
    },
  },
  {
    file: 'README.md',
    label: 'README.md visible version',
    extract: (text) => text.match(/\*\*Version:\*\*\s*`([\d.]+)`/)?.[1],
  },
  {
    file: 'CHANGELOG.md',
    label: 'CHANGELOG.md newest release',
    extract: (text) => text.match(/^## \[([\d.]+)\]/m)?.[1],
  },
]

/**
 * Assert the human-facing surface counts in server.json and README match the
 * exported arrays. Returns true on drift (so callers can fail the run).
 */
async function checkSurfaceCounts(): Promise<boolean> {
  const toolCount = DERO_TOOL_NAMES.length
  const resourceCount = DERO_RESOURCE_URIS.length
  const promptCount = DERO_PROMPT_NAMES.length
  const skillCount = SKILL_NAMES.length

  const serverJson = await readFile(path.join(ROOT, 'server.json'), 'utf-8')
  const packageJson = await readFile(path.join(ROOT, 'package.json'), 'utf-8')
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf-8')
  const rootSkill = await readFile(path.join(ROOT, 'SKILL.md'), 'utf-8')
  const packageManifest = JSON.parse(packageJson) as { files?: string[]; version?: string }

  type SurfaceCheck = { label: string; ok: boolean; detail: string }
  const checks: SurfaceCheck[] = []

  // server.json description must state the tool count, e.g. "28 tools".
  const descMatch = serverJson.match(/"description":\s*"([^"]*)"/)
  const desc = descMatch?.[1] ?? ''
  // The MCP registry rejects a description over 100 chars with a 422 at publish
  // time (learned the hard way on the 0.4.5 release). Catch it locally instead.
  const REGISTRY_DESC_MAX = 100
  checks.push({
    label: `server.json description ≤ ${REGISTRY_DESC_MAX} chars (MCP registry limit)`,
    ok: desc.length <= REGISTRY_DESC_MAX,
    detail: `description is ${desc.length} chars; the registry rejects > ${REGISTRY_DESC_MAX}`,
  })

  const packageFiles = packageManifest.files ?? []
  checks.push({
    label: 'package.json ships skills/',
    ok: packageFiles.includes('skills'),
    detail: 'expected "skills" in package.json files[]',
  })
  checks.push({
    label: `server.json description states ${toolCount} tools`,
    ok: new RegExp(`\\b${toolCount}\\s+tools\\b`).test(desc),
    detail: `expected "${toolCount} tools" in description`,
  })
  checks.push({
    label: `server.json description states ${resourceCount} resources`,
    ok: new RegExp(`\\b${resourceCount}\\s+resources\\b`).test(desc),
    detail: `expected "${resourceCount} resources" in description`,
  })
  checks.push({
    label: `server.json description states ${promptCount} prompts`,
    ok: new RegExp(`\\b${promptCount}\\s+prompts\\b`).test(desc),
    detail: `expected "${promptCount} prompts" in description`,
  })
  checks.push({
    label: `server.json description states ${skillCount} skills`,
    ok: new RegExp(`\\b${skillCount}\\s+Skills(?:-over-MCP)?\\b`, 'i').test(desc),
    detail: `expected "${skillCount} Skills-over-MCP" in description`,
  })

  const publishedVersion = '0.6.0'
  const publishedSnapshotDate = '2026-08-22'
  const releaseRows = [
    `| **Tools (${toolCount})** in v0.7 | 33 | ${toolCount} |`,
    `| **Resources (${resourceCount})** in v0.7 | 4 | ${resourceCount} |`,
    `| **Prompts (${promptCount})** in v0.7 | 5 | ${promptCount} |`,
    `| **Skills (${skillCount})** in v0.7 | 0 | ${skillCount} |`,
  ]
  checks.push({
    label: 'README distinguishes source and published versions',
    ok: readme.includes(`Published npm / Registry \`${publishedVersion}\``) &&
      readme.includes(`Fork source \`${packageManifest.version}\``) &&
      readme.includes(`**Snapshot checked:** \`${publishedSnapshotDate}\``),
    detail: `expected dated ${publishedVersion} snapshot and source ${packageManifest.version} in the release matrix`,
  })
  for (const row of releaseRows) {
    checks.push({
      label: `README release row ${row.match(/\*\*(.*?)\*\*/)?.[1] ?? row}`,
      ok: readme.includes(row),
      detail: `expected exact row: ${row}`,
    })
  }
  checks.push({
    label: `README pins npm quickstart to ${publishedVersion}`,
    ok: readme.includes(`"args": ["-y", "dero-mcp-server@${publishedVersion}"]`) &&
      !readme.includes('"args": ["-y", "dero-mcp-server"]'),
    detail: `expected only the version-pinned dero-mcp-server@${publishedVersion} subprocess example`,
  })
  checks.push({
    label: 'README states the exact tool breakdown',
    ok: readme.includes('17 daemon RPC reads + 1 local proof decoder + 3 documentation tools + 12 composites'),
    detail: 'expected 17 RPC reads, 1 local decoder, 3 docs tools, and 12 composites',
  })

  for (const name of SKILL_NAMES) {
    checks.push({
      label: `root SKILL.md links ${name}`,
      ok: rootSkill.includes(`skills/${name}/SKILL.md`),
      detail: `expected compatibility link to skills/${name}/SKILL.md`,
    })
  }
  checks.push({
    label: 'root SKILL.md is a compatibility index',
    ok: /^# DERO MCP Skill Index\r?\n/.test(rootSkill) && !rootSkill.startsWith('---'),
    detail: 'root SKILL.md must start with the compatibility-index heading and no frontmatter',
  })
  checks.push({
    label: 'root SKILL.md explains native + fallback discovery',
    ok: rootSkill.includes('skills/list') && rootSkill.includes('read_dero_skill'),
    detail: 'expected both skills/list and read_dero_skill in the root compatibility index',
  })

  // The bundled docs index ships the derod.org "tools/mcp-server" page, which
  // the live server surfaces via dero_docs_search — so it self-documents the
  // tool surface to AI users. It lives in a SEPARATE repo (dero-docs) and has
  // drifted before (stuck at "28 tools" two releases behind). Assert the
  // BUNDLED copy states the current tool count so a stale page can't ship in
  // the npm package. (Fix the source in dero-docs, then `npm run build:docs`.)
  const idxRaw = await readFile(path.join(ROOT, 'data', 'docs-index.json'), 'utf-8')
  const idx = JSON.parse(idxRaw) as {
    page_count?: number
    pages?: Array<{ slug?: string; description?: string; headings?: string[]; plainText?: string }>
  }
  checks.push({
    label: `bundled docs index contains ${EXPECTED_DOC_PAGE_COUNT} pages`,
    ok: idx.page_count === EXPECTED_DOC_PAGE_COUNT && idx.pages?.length === EXPECTED_DOC_PAGE_COUNT,
    detail: `expected page_count and pages.length to both equal ${EXPECTED_DOC_PAGE_COUNT}`,
  })

  const page = idx.pages?.find((candidate) => candidate.slug === 'tools/mcp-server')
  checks.push({
    label: 'bundled docs index contains tools/mcp-server',
    ok: page !== undefined,
    detail: 'required tools/mcp-server overview is absent',
  })
  if (page) {
    const txt = page.plainText ?? ''
    const description = page.description ?? ''
    const overviewChecks: Array<[string, boolean, string]> = [
      [
        'bundled tools/mcp-server metadata describes the current surface',
        description.includes(`${toolCount} tools`) &&
          description.includes(`${resourceCount} resources`) &&
          description.includes(`${promptCount} prompts`) &&
          description.includes(`${skillCount} packaged product skills`),
        'page description must state 34 tools, 8 resources, 5 prompts, and 4 packaged product skills',
      ],
      [
        'bundled tools/mcp-server headings include Skills-over-MCP',
        page.headings?.includes('Skills-over-MCP') === true,
        'expected Skills-over-MCP in the target page headings metadata',
      ],
      [
        `bundled tools/mcp-server doc states ${toolCount} tools`,
        new RegExp(`\\| \\*\\*Tools\\*\\* \\| \\*\\*${toolCount}\\*\\* \\|`).test(txt),
        `expected opening Tools row with count ${toolCount}`,
      ],
      [
        `bundled tools/mcp-server doc states ${resourceCount} resources`,
        new RegExp(`\\| \\*\\*Resources\\*\\* \\| (?:\\*\\*)?${resourceCount}(?:\\*\\*)? \\|`).test(txt),
        `expected opening Resources row with count ${resourceCount}`,
      ],
      [
        `bundled tools/mcp-server doc states ${promptCount} prompts`,
        new RegExp(`\\| \\*\\*Prompts\\*\\* \\| ${promptCount} \\|`).test(txt),
        `expected opening Prompts row with count ${promptCount}`,
      ],
      [
        `bundled tools/mcp-server doc states ${skillCount} skills`,
        new RegExp(`\\| \\*\\*Skills\\*\\* \\| (?:\\*\\*)?${skillCount}(?:\\*\\*)? \\|`).test(txt),
        `expected opening Skills row with count ${skillCount}`,
      ],
      [
        `bundled tools/mcp-server doc states ${EXPECTED_DOC_PAGE_COUNT} pages`,
        txt.includes(`${EXPECTED_DOC_PAGE_COUNT} pages`),
        `expected literal "${EXPECTED_DOC_PAGE_COUNT} pages" in the overview prose`,
      ],
      [
        'bundled tools/mcp-server doc explains both skill discovery paths',
        txt.includes('skills/list') && txt.includes('skills/get') && txt.includes('read_dero_skill'),
        'expected skills/list, skills/get, and read_dero_skill',
      ],
      [
        'bundled tools/mcp-server doc states the exact tool breakdown',
        txt.includes('17 daemon RPC wrappers + 1 local proof decoder + 3 docs-index tools + 12 composites + 1 skill compatibility reader'),
        'expected 17 RPC wrappers, 1 local decoder, 3 docs tools, 12 composites, and 1 skill reader',
      ],
      [
        'bundled tools/mcp-server doc describes local-first daemon selection',
        txt.includes('Omit env for local-first resolution') && !txt.includes('Omit env to use the default public RPC'),
        'expected local-first behavior instead of a direct public-RPC claim',
      ],
      [
        'bundled tools/mcp-server doc has no stale surface prose',
        !/\b33 tools\b|\b147 pages\b|exposes 4 \*\*resources\*\*|per-tool agent operating manual/.test(txt),
        'found stale 33-tool, 4-resource, 147-page, or root-runbook wording',
      ],
    ]
    for (const uri of SKILL_NAMES.map((name) => `skill://${name}/SKILL.md`)) {
      overviewChecks.push([
        `bundled tools/mcp-server doc lists ${uri}`,
        txt.includes(uri),
        `expected ${uri} in the Resources table`,
      ])
    }
    for (const [label, ok, detail] of overviewChecks) checks.push({ label, ok, detail })
  }

  process.stdout.write('\n[check:server-json] verifying surface counts (tools/resources/prompts/skills)...\n\n')
  let drift = false
  for (const c of checks) {
    process.stdout.write(`  ${c.ok ? '✓' : '✗'} ${c.label.padEnd(48)}${c.ok ? '' : ` — ${c.detail}`}\n`)
    if (!c.ok) drift = true
  }
  return drift
}

async function main(): Promise<void> {
  const results: Array<{ check: Check; value: string | undefined; ok: boolean }> = []
  let canonical: string | undefined
  let anyFail = false

  for (const check of CHECKS) {
    const abs = path.join(ROOT, check.file)
    let value: string | undefined
    try {
      const text = await readFile(abs, 'utf-8')
      value = check.extract(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[check:server-json] cannot read ${check.file}: ${msg}\n`)
      anyFail = true
      results.push({ check, value: undefined, ok: false })
      continue
    }
    if (!value) {
      process.stderr.write(`[check:server-json] cannot extract version from ${check.file}\n`)
      anyFail = true
      results.push({ check, value: undefined, ok: false })
      continue
    }
    if (canonical === undefined) {
      canonical = value
    }
    results.push({ check, value, ok: value === canonical })
    if (value !== canonical) anyFail = true
  }

  process.stdout.write(`[check:server-json] verifying version pin across ${CHECKS.length} references...\n\n`)
  for (const r of results) {
    const status = r.ok ? '✓' : '✗'
    process.stdout.write(`  ${status} ${(r.check.label).padEnd(48)} ${r.value ?? '(missing)'}\n`)
  }

  if (anyFail) {
    process.stderr.write(`\n[check:server-json] FAIL — version drift. Canonical (first read) is ${canonical}. Update mismatched refs and rerun.\n`)
  }

  const surfaceDrift = await checkSurfaceCounts()
  if (surfaceDrift) {
    process.stderr.write(`\n[check:server-json] FAIL — release/surface drift. Update package metadata, server.json, README, root SKILL.md, and the bundled MCP overview.\n`)
  }

  if (anyFail || surfaceDrift) process.exit(1)

  process.stdout.write(`\n[check:server-json] OK — version pin agrees on ${canonical}; surface counts match.\n`)
}

main().catch((err) => {
  process.stderr.write(`[check:server-json] error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
