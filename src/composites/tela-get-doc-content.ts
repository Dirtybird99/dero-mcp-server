/**
 * `tela_get_doc_content` — fetch a TELA-DOC-1's actual file content.
 *
 * A TELA-DOC-1 stores its file (HTML/CSS/JS/...) inside a DVM-BASIC comment
 * block in the contract code, NOT in a stored variable. This tool fetches
 * DERO.GetSC (code=true), confirms the SCID is a DOC, and extracts the file
 * content via the shared extractTelaDocContent. Large files are chunked with
 * offset pagination (mirrors dero_docs_get_page).
 *
 * TELA-CLI gzips files (a `.gz` filename), storing them base64-encoded. This
 * tool transparently base64-decodes + gunzips such content (Node's built-in
 * zlib, no new dependency) and returns plaintext when expansion stays within
 * the safety cap. Cap hits fall back to the raw stored content.
 *
 * Read-only; one RPC call. We return content as untrusted data and report the
 * author signature's presence — we do NOT claim to have verified it.
 */

import { z } from 'zod'
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import { attachCitations, type DeroDaemonRpc, type DeroGetScResult } from './_shared.js'
import { classifyTela, parseTelaDoc, extractTelaDocContent } from '../tela-parse.js'
import { paginateUtf8Content } from '../content-pagination.js'

const SCID_HEX_REGEX = /^[0-9a-fA-F]{64}$/

// Per-call content cap, matching dero_docs_get_page's PAGE_CONTENT_CHUNK.
const DOC_CONTENT_CHUNK = 60000
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024

type DecompressionResult = {
  content: string | null
  limited: boolean
}

/**
 * TELA-CLI stores gzipped DOC files as base64-encoded gzip. Decode + gunzip
 * back to the plaintext file. Expansion is capped at 8 MiB. Defensive: the
 * caller keeps the raw stored content when bytes are not gzip, are malformed,
 * or exceed the cap.
 */
function decompressGzipBase64(content: string): DecompressionResult {
  try {
    const buf = Buffer.from(content.trim(), 'base64')
    // gzip magic bytes 0x1f 0x8b — bail early if absent (not really gzip).
    if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      return { content: null, limited: false }
    }
    return {
      content: zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8'),
      limited: false,
    }
  } catch (error) {
    const limited =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_BUFFER_TOO_LARGE'
    return { content: null, limited }
  }
}

export const telaGetDocContentInputSchema = {
  scid: z
    .string()
    .regex(SCID_HEX_REGEX, 'Expected 64-character hex Smart Contract ID')
    .describe('64-char hex Smart Contract ID of a TELA-DOC-1 file contract'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Byte offset into the extracted file content; use next_offset to paginate large files'),
  topoheight: z.number().int().optional().describe('Optional topo height; omit for latest committed state'),
} as const

type TelaGetDocContentInput = { scid: string; offset?: number; topoheight?: number }

export async function telaGetDocContent(rpc: DeroDaemonRpc, args: TelaGetDocContentInput) {
  const params: Record<string, unknown> = { scid: args.scid, code: true, variables: true }
  if (args.topoheight !== undefined) params.topoheight = args.topoheight

  const raw = (await rpc<DeroGetScResult>('DERO.GetSC', params)) ?? {}
  const code = typeof raw.code === 'string' ? raw.code : ''
  const stringkeys =
    raw.stringkeys && typeof raw.stringkeys === 'object'
      ? (raw.stringkeys as Record<string, unknown>)
      : undefined

  const { kind } = classifyTela(stringkeys, code)
  if (kind !== 'tela_doc') {
    // Not a DOC — guide the agent rather than returning empty content.
    const hint =
      kind === 'tela_index'
        ? 'This SCID is a TELA-INDEX-1 manifest, not a DOC. Use tela_inspect to list its DOC SCIDs, then call this tool on a DOC.'
        : 'This SCID is not a TELA-DOC-1 contract. Use tela_inspect or explain_smart_contract to identify it.'
    throw new Error(`INVALID_INPUT: ${hint}`)
  }

  const doc = parseTelaDoc(stringkeys, code)
  const extracted = extractTelaDocContent(code)

  const responseTopoheight =
    typeof args.topoheight === 'number' && Number.isFinite(args.topoheight) ? args.topoheight : null

  // A `.gz` filename means TELA-CLI stored the file as base64'd gzip.
  // Transparently decompress to the plaintext file so the agent reads real
  // HTML/JS/CSS, not a compressed blob. If decompression fails (not actually
  // gzip), fall back to the raw content and flag it.
  const rawExtracted = extracted.content ?? ''
  const looksGzipped = !!doc.filename && /\.gz$/i.test(doc.filename)
  let decompressed = false
  let decompressFailed = false
  let decompressionLimited = false
  let full = rawExtracted
  let displayFilename = doc.filename
  if (looksGzipped && extracted.embedded && rawExtracted) {
    const out = decompressGzipBase64(rawExtracted)
    if (out.content !== null) {
      full = out.content
      decompressed = true
      // Surface the real filename (strip the .gz the user never sees).
      displayFilename = doc.filename!.replace(/\.gz$/i, '')
    } else {
      decompressFailed = true
      decompressionLimited = out.limited
    }
  }

  const page = paginateUtf8Content(full, args.offset ?? 0, DOC_CONTENT_CHUNK)

  const note = extracted.note
    ? extracted.note
    : decompressed
      ? `File was gzip-compressed on-chain (stored as ${doc.filename}); transparently decompressed to plaintext here.`
      : decompressionLimited
        ? `Gzip expansion exceeded the 8 MiB safety limit; returning the raw base64 content stored on-chain.`
        : decompressFailed
          ? `Filename is ${doc.filename} but the content did not decode as base64 gzip; returning the raw stored content.`
          : undefined

  const payload = {
    scid: args.scid,
    topoheight: responseTopoheight,
    filename: displayFilename,
    stored_filename: doc.filename,
    doc_type: doc.doc_type,
    sub_dir: doc.sub_dir,
    content_embedded: extracted.embedded,
    content: extracted.embedded ? page.content : null,
    content_offset: extracted.embedded ? page.content_offset : null,
    content_length: page.content_length,
    content_truncated: page.content_truncated,
    next_offset: page.next_offset,
    compressed: looksGzipped,
    decompressed,
    decompression_limited: decompressionLimited,
    signature: doc.signature,
    signature_note:
      'Signature presence fields are reported; this tool does NOT cryptographically verify the signature.',
    note,
    narrative: extracted.embedded
      ? `Fetched ${page.content_length} bytes of "${displayFilename ?? 'file'}" (${doc.doc_type ?? 'unknown type'}) from TELA-DOC-1 ${args.scid}.${decompressed ? ' Gzip content was decompressed to plaintext.' : ''}${decompressionLimited ? ' Gzip expansion hit the 8 MiB safety limit, so raw stored content is returned.' : ''}${page.content_truncated ? ` Returning bytes ${page.content_offset}–${page.next_offset}; paginate with next_offset.` : ''}`
      : `TELA-DOC-1 ${args.scid} ("${doc.filename ?? 'file'}") has no inline file content (${extracted.note ?? 'DocShard, STATIC, or external'}).`,
  }

  return attachCitations(payload, 'tela_get_doc_content')
}
