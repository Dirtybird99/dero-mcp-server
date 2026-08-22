import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { paginateUtf8Content } from '../src/content-pagination.js'
import { getDeroDocPage } from '../src/docs.js'
import {
  rankRecommendations,
  recommendDocsPath,
} from '../src/composites/recommend-docs-path.js'
import { telaGetDocContent } from '../src/composites/tela-get-doc-content.js'
import { type DeroDaemonRpc } from '../src/composites/_shared.js'

const SCID = 'a'.repeat(64)

function docRpc(filename: string, storedContent: string): DeroDaemonRpc {
  const result = {
    code: [
      'Function InitializePrivate() Uint64',
      '10 RETURN 0',
      'End Function',
      '/*',
      storedContent,
      '*/',
    ].join('\n'),
    stringkeys: {
      var_header_name: filename,
      docType: 'TELA-HTML-1',
      fileCheckC: 'c',
      fileCheckS: 's',
    },
  }
  return async <T>() => result as T
}

function checkUtf8Pagination(): void {
  const asciiFirst = paginateUtf8Content('abcdefgh', 0, 4)
  assert.deepEqual(asciiFirst, {
    content: 'abcd',
    content_offset: 0,
    content_length: 8,
    content_truncated: true,
    next_offset: 4,
  })
  assert.equal(paginateUtf8Content('abcdefgh', 4, 4).content, 'efgh')
  assert.deepEqual(paginateUtf8Content('abcdefgh', 99, 4), {
    content: '',
    content_offset: 8,
    content_length: 8,
    content_truncated: false,
    next_offset: null,
  })

  const source = `${'a'.repeat(59_997)}😀éz`
  const first = paginateUtf8Content(source, 0, 60_000)
  assert.equal(first.content_length, Buffer.byteLength(source, 'utf8'))
  assert.equal(Buffer.byteLength(first.content, 'utf8'), 59_997)
  assert.equal(first.next_offset, 59_997)
  assert.equal(first.content.includes('\ufffd'), false)

  assert.notEqual(first.next_offset, null)
  const second = paginateUtf8Content(source, first.next_offset!, 60_000)
  assert.equal(first.content + second.content, source)
  assert.equal(second.content_offset, first.next_offset)
  assert.equal(second.next_offset, null)

  const insideEmoji = paginateUtf8Content(source, 59_999, 60_000)
  assert.equal(insideEmoji.content_offset, 59_997)
  assert.equal(insideEmoji.content, '😀éz')
}

async function checkTelaGzip(): Promise<void> {
  const plaintext = `${'a'.repeat(59_997)}😀éz`
  const stored = zlib.gzipSync(Buffer.from(plaintext)).toString('base64')
  const first = await telaGetDocContent(docRpc('index.html.gz', stored), { scid: SCID })
  assert.equal(first.decompressed, true)
  assert.equal(first.decompression_limited, false)
  assert.equal(first.content_length, Buffer.byteLength(plaintext, 'utf8'))
  assert.ok(first.next_offset !== null)
  const second = await telaGetDocContent(docRpc('index.html.gz', stored), {
    scid: SCID,
    offset: first.next_offset!,
  })
  assert.equal((first.content ?? '') + (second.content ?? ''), plaintext)

  const exactLimit = 'B'.repeat(8 * 1024 * 1024)
  const exactStored = zlib.gzipSync(Buffer.from(exactLimit)).toString('base64')
  const allowed = await telaGetDocContent(docRpc('exact.html.gz', exactStored), { scid: SCID })
  assert.equal(allowed.decompressed, true)
  assert.equal(allowed.decompression_limited, false)
  assert.equal(allowed.content_length, Buffer.byteLength(exactLimit, 'utf8'))

  const oversized = 'A'.repeat(8 * 1024 * 1024 + 1)
  const oversizedStored = zlib.gzipSync(Buffer.from(oversized)).toString('base64')
  const limited = await telaGetDocContent(docRpc('large.html.gz', oversizedStored), { scid: SCID })
  assert.equal(limited.decompressed, false)
  assert.equal(limited.decompression_limited, true)
  assert.equal(limited.content, oversizedStored)
  assert.equal(limited.content_length, Buffer.byteLength(oversizedStored, 'utf8'))

  const malformedStored = Buffer.from([0x1f, 0x8b, 0x08, 0x00]).toString('base64')
  const malformed = await telaGetDocContent(docRpc('broken.html.gz', malformedStored), { scid: SCID })
  assert.equal(malformed.decompressed, false)
  assert.equal(malformed.decompression_limited, false)
  assert.equal(malformed.content, malformedStored)
}

async function checkBundledDocsPagination(): Promise<void> {
  let offset = 0
  let joined = ''
  let expectedLength: number | null = null
  for (;;) {
    const page = await getDeroDocPage({ product: 'derod', slug: 'captain', offset })
    expectedLength ??= page.content_length
    assert.equal(page.content_offset, offset)
    assert.equal(page.content_length, expectedLength)
    assert.ok(Buffer.byteLength(page.content, 'utf8') <= 60_000)
    joined += page.content
    if (page.next_offset === null) break
    offset = page.next_offset
  }
  assert.equal(Buffer.byteLength(joined, 'utf8'), expectedLength)
}

async function checkRecommendations(): Promise<void> {
  const fakeHits = new Map([
    [
      'deropay' as const,
      [
        {
          product: 'deropay' as const,
          slug: '',
          title: 'Root',
          canonical_url: 'https://example.invalid/root',
          headings: [],
          excerpt: '',
          score: 100,
        },
        {
          product: 'deropay' as const,
          slug: 'dero-auth/checkout',
          title: 'Checkout',
          canonical_url: 'https://example.invalid/checkout',
          headings: ['Checkout'],
          excerpt: '',
          score: 10,
        },
      ],
    ],
  ])
  const ranked = rankRecommendations(
    'DeroAuth checkout',
    'deropay',
    fakeHits as unknown as Parameters<typeof rankRecommendations>[2],
  )
  assert.deepEqual(ranked.map((entry) => entry.slug), ['dero-auth/checkout'])

  const live = await recommendDocsPath({ intent: 'DeroAuth checkout', product_hint: 'deropay' })
  assert.equal(live.limit_per_product, 4)
  assert.ok(live.recommended.length > 0)
  assert.ok(live.recommended.every((entry) => entry.slug.trim().length > 0))
}

checkUtf8Pagination()
await checkTelaGzip()
await checkBundledDocsPagination()
await checkRecommendations()
console.log('content hardening checks: ok')
