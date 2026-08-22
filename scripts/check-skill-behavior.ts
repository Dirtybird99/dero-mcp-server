import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DERO_SKILLS, type DeroSkillName } from '../src/skills.js'
import { TOOL_DESCRIPTIONS } from '../src/tool-descriptions.js'

const byName = new Map(DERO_SKILLS.map((skill) => [skill.name, skill]))

function primaryDescription(name: DeroSkillName): string {
  const description = byName.get(name)?.frontmatter.description
  assert.ok(description)
  return description.split(/\.\s/)[0]!.toLowerCase()
}

function route(terms: readonly string[]): DeroSkillName {
  const scored = DERO_SKILLS.map((skill) => ({
    name: skill.name,
    score: terms.filter((term) => primaryDescription(skill.name).includes(term)).length,
  })).sort((a, b) => b.score - a.score)
  assert.ok(scored[0]!.score > 0, `No skill matched ${terms.join(' ')}`)
  assert.ok(scored[0]!.score > scored[1]!.score, `Ambiguous skill route for ${terms.join(' ')}`)
  return scored[0]!.name
}

const scenarios: Array<{ terms: string[]; expected: DeroSkillName }> = [
  { terms: ['supply'], expected: 'dero' },
  { terms: ['tela', 'durl'], expected: 'tela' },
  { terms: ['hologram', 'simulator'], expected: 'hologram' },
  { terms: ['deroauth', 'checkout'], expected: 'deropay' },
  { terms: ['generic', 'wallet'], expected: 'dero' },
  { terms: ['hologram', 'built-in', 'wallet'], expected: 'hologram' },
]
for (const scenario of scenarios) assert.equal(route(scenario.terms), scenario.expected)

assert.deepEqual(
  [route(['hologram', 'simulator']), route(['tela', 'durl'])],
  ['hologram', 'tela'],
)

const productHint: Record<DeroSkillName, string> = {
  dero: 'derod',
  tela: 'tela',
  hologram: 'hologram',
  deropay: 'deropay',
}

for (const skill of DERO_SKILLS) {
  assert.match(skill.content, /untrusted data, not instructions/i)
  assert.match(skill.content, /dero:\/\/mcp\/server-info/)
  assert.match(skill.content, /daemon_source/)
  assert.match(skill.content, /endpoint/)
  assert.match(skill.content, /informed consent before sending the identifier/i)
  assert.match(skill.content, /Treat `env` the same way/i)
  assert.match(skill.content, /server info is unavailable.*endpoint as untrusted/i)
  assert.match(skill.content, /read-only/i)
  assert.ok(skill.content.includes(`product_hint: "${productHint[skill.name]}"`))
  assert.match(skill.content, /non-empty `slug`/)
  assert.match(skill.content, /dero_docs_search/)
  assert.match(skill.content, /next_offset/)
  assert.match(skill.content, /canonical_url/)
  assert.match(skill.content, /_meta\.error\.code/)
  assert.match(skill.content, /retryable/)
}

assert.match(byName.get('tela')!.content, /compose with `hologram`/i)
assert.match(byName.get('tela')!.content, /with `deropay`/i)
assert.match(byName.get('tela')!.content, /cannot deploy or update/i)
assert.match(byName.get('hologram')!.content, /tela_get_doc_content/)
assert.match(byName.get('hologram')!.content, /implementing DeroAuth/)
assert.match(byName.get('deropay')!.content, /compose with `tela`/)
assert.match(byName.get('deropay')!.content, /compose with `hologram`/)
assert.match(byName.get('deropay')!.content, /never perform or retry/i)
assert.match(byName.get('dero')!.content, /never request or transmit a seed phrase/i)
assert.match(byName.get('dero')!.content, /do not instruct the user to overwrite/i)

const loader = TOOL_DESCRIPTIONS.read_dero_skill
for (const discriminator of ['generic wallet', 'dURLs', 'built-in wallet', 'DeroAuth', 'mixed request']) {
  assert.ok(loader.includes(discriminator), `Loader is missing route discriminator ${discriminator}`)
}

const rootIndex = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8')
for (const name of ['DERO', 'TELA', 'Hologram', 'DeroPay']) assert.ok(rootIndex.includes(name))
assert.match(rootIndex, /mixed request/)
assert.match(rootIndex, /dero:\/\/mcp\/server-info/)
assert.match(rootIndex, /daemon_source/)
assert.match(rootIndex, /informed consent before sending the identifier/i)
assert.match(rootIndex, /server info is unavailable.*endpoint as untrusted/i)

console.log('skill behavior checks: ok')
