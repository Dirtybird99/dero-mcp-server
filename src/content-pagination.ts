import { Buffer } from 'node:buffer'

export type Utf8ContentPage = {
  content: string
  content_offset: number
  content_length: number
  content_truncated: boolean
  next_offset: number | null
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

/**
 * Page a string by UTF-8 bytes without splitting a code point. Offsets are
 * byte offsets; an offset inside a code point moves back to that code point's
 * start and the response reports the actual offset.
 */
export function paginateUtf8Content(
  content: string,
  requestedOffset = 0,
  maxBytes = 60_000,
): Utf8ContentPage {
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) {
    throw new Error('Content offset must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('Content page size must be a safe integer of at least 4 bytes')
  }

  const bytes = Buffer.from(content, 'utf8')
  let start = Math.min(requestedOffset, bytes.length)
  while (start > 0 && start < bytes.length && isContinuationByte(bytes[start])) start -= 1

  let end = Math.min(start + maxBytes, bytes.length)
  while (end > start && end < bytes.length && isContinuationByte(bytes[end])) end -= 1

  const truncated = end < bytes.length
  return {
    content: bytes.subarray(start, end).toString('utf8'),
    content_offset: start,
    content_length: bytes.length,
    content_truncated: truncated,
    next_offset: truncated ? end : null,
  }
}
