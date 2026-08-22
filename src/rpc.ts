const DEFAULT_TIMEOUT_MS = 45_000

export type JsonRpcResponse<T = unknown> = {
  jsonrpc: '2.0'
  id: string | number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

/**
 * POST JSON-RPC 2.0 to a DERO daemon or wallet endpoint (…/json_rpc).
 */
export async function deroJsonRpc<T = unknown>(
  jsonRpcUrl: string,
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: 'dero-mcp',
    method,
  }
  if (params !== undefined) body.params = params

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(jsonRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    // Parse the body before honoring the HTTP status: a daemon (or proxy) can
    // return a JSON-RPC error with a non-2xx status, and that body carries the
    // specific error code (e.g. -32098 DVM compile) we want to surface. Fall
    // back to a raw HTTP error only when the body is not a usable JSON-RPC error.
    let json: JsonRpcResponse<T> | undefined
    try {
      json = JSON.parse(text) as JsonRpcResponse<T>
    } catch {
      json = undefined
    }
    if (json?.error) {
      throw new Error(
        `RPC error ${json.error.code}: ${json.error.message}${json.error.data != null ? ` ${JSON.stringify(json.error.data)}` : ''}`,
      )
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    if (json === undefined) {
      throw new Error(`Invalid JSON from node: ${text.slice(0, 200)}`)
    }
    return json.result as T
  } finally {
    clearTimeout(timer)
  }
}

function parseDaemonUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('DERO daemon URL must be an absolute http(s) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('DERO daemon URL must use http or https')
  }
  if (url.username || url.password) {
    throw new Error('DERO daemon URL must not include userinfo credentials')
  }
  return url
}

export function normalizeDaemonBaseUrl(value: string): string {
  const url = parseDaemonUrl(value)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.pathname.endsWith('/json_rpc')) {
    url.pathname = url.pathname.slice(0, -'/json_rpc'.length)
  }
  return url.toString()
}

export function redactDaemonUrl(value: string): string {
  const url = parseDaemonUrl(value)
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function jsonRpcEndpoint(baseUrl: string): string {
  const url = parseDaemonUrl(baseUrl)
  url.hash = ''
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith('/json_rpc') ? pathname : `${pathname}/json_rpc`
  return url.toString()
}
