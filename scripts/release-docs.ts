#!/usr/bin/env npx tsx
/**
 * One-command docs release.
 *
 * After a "Refresh bundled docs index" PR is merged to main, this collapses the
 * manual bump → CHANGELOG → commit → tag → push dance into a single command:
 *
 *   npm run release:docs
 *
 * It auto-increments the PATCH version across every pinned release surface (the
 * same set check:server-json validates), writes a canned CHANGELOG entry, commits, tags
 * vX.Y.Z, and pushes — which fires release.yml (npm + registry + VPS).
 *
 * Pre-flight guards run BEFORE the irreversible tag: on main, clean tree, synced
 * with origin, and the shared offline release gate passes. Aborts loudly otherwise.
 *
 * This is for canonical-upstream DOCS-ONLY releases. Forks and preview READMEs
 * are rejected before any files change. For code changes, bump + CHANGELOG by
 * hand so the changelog is meaningful.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sh(cmd: string, opts: { capture?: boolean } = {}): string {
  return execSync(cmd, { cwd: ROOT, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' })?.toString().trim() ?? ''
}
function shOut(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).toString().trim()
}
function fail(msg: string): never {
  console.error(`\n[release:docs] ABORT — ${msg}\n`)
  process.exit(1)
}

// ── Pre-flight (before anything irreversible) ───────────────────────────────
console.log('[release:docs] pre-flight checks...')

const originUrl = shOut('git remote get-url origin')
if (!/(?:github\.com[/:])DHEBP\/dero-mcp-server(?:\.git)?$/i.test(originUrl)) {
  fail(`canonical upstream only; origin is '${originUrl}'`)
}

const branch = shOut('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') fail(`must be on main, currently on '${branch}'`)

if (shOut('git status --porcelain')) {
  fail('working tree is not clean — commit or stash first (a docs refresh PR should already be merged)')
}

sh('git fetch origin main --quiet')
const localSha = shOut('git rev-parse HEAD')
const originSha = shOut('git rev-parse origin/main')
if (localSha !== originSha) fail('local main is not in sync with origin/main — pull/push first')

const readmePreview = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
if (/source preview/i.test(readmePreview)) {
  fail('README still describes an unpublished source preview — make it release-ready before tagging')
}

console.log('[release:docs] verifying current checkout...')
sh('npm run verify:offline')

// ── Compute the next patch version ──────────────────────────────────────────
const pkgPath = path.join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
const cur = pkg.version
const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/)
if (!m) fail(`package.json version '${cur}' is not X.Y.Z`)
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
console.log(`[release:docs] ${cur} → ${next}`)

// Let npm update package.json + both authoritative package-lock.json fields in
// one operation, then patch the non-npm release surfaces precisely.
sh(`npm version ${next} --no-git-tag-version --ignore-scripts`)

// ── Bump every remaining pinned ref (replace the CURRENT version string) ────
const edits: Array<{ file: string; find: RegExp; replace: string }> = [
  { file: 'server.json', find: new RegExp(`("version":\\s*")${esc(cur)}(")`, 'g'), replace: `$1${next}$2` },
  { file: 'src/server.ts', find: new RegExp(`(version:\\s*')${esc(cur)}(')`, 'g'), replace: `$1${next}$2` },
  { file: 'src/http-server.ts', find: new RegExp(`(PACKAGE_VERSION\\s*=\\s*')${esc(cur)}(')`), replace: `$1${next}$2` },
  { file: 'deploy/.env.example', find: new RegExp(`(^DERO_MCP_VERSION=)${esc(cur)}`, 'm'), replace: `$1${next}` },
  {
    file: 'README.md',
    find: new RegExp(esc(`**Version:** \`${cur}\``)),
    replace: `**Version:** \`${next}\``,
  },
]
for (const e of edits) {
  const p = path.join(ROOT, e.file)
  const before = readFileSync(p, 'utf8')
  const after = before.replace(e.find, e.replace)
  if (after === before) fail(`could not bump version in ${e.file} (pattern not found for ${cur})`)
  writeFileSync(p, after)
}

// ── Prepend a CHANGELOG entry ───────────────────────────────────────────────
const clPath = path.join(ROOT, 'CHANGELOG.md')
const cl = readFileSync(clPath, 'utf8')
const entry = `## [${next}]\n\n### Docs\n- Refresh bundled docs index from dero-docs.\n\n`
// Insert right after the title block, before the first existing "## [".
const idx = cl.indexOf('## [')
if (idx === -1) fail('CHANGELOG.md has no existing version section to anchor against')
const newCl = cl.slice(0, idx) + entry + cl.slice(idx)
writeFileSync(clPath, newCl)

// ── Verify the bump is internally consistent ────────────────────────────────
console.log('[release:docs] verifying release metadata...')
sh('npm run build')
sh('npm run check:server-json')

// ── Commit, tag, push ───────────────────────────────────────────────────────
const tag = `v${next}`
sh('git add package.json package-lock.json server.json src/server.ts src/http-server.ts deploy/.env.example README.md CHANGELOG.md')
sh(`git commit -m "chore(release): ${next} — refresh bundled docs index"`)
sh(`git tag ${tag}`)
console.log(`[release:docs] pushing main + ${tag} (fires release.yml)...`)
sh('git push origin main')
sh(`git push origin ${tag}`)

console.log(`\n[release:docs] ✓ ${tag} pushed. Watch: gh run watch --workflow=release.yml\n`)

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
