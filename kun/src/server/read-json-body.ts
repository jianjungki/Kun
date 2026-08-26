import type { KunErrorBody } from '../contracts/errors.js'
import { jsonResponse, type JsonResponse } from './response.js'

export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: JsonResponse }

export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024

export async function readJsonBody(request: Request): Promise<ReadJsonBodyResult> {
  if (request.body === null) return { ok: true, value: {} }
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    return payloadTooLargeResponse()
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return payloadTooLargeResponse()
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  if (!text) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    const body: KunErrorBody = {
      code: 'validation_error',
      message: 'invalid JSON body',
      details: error instanceof Error ? error.message : String(error)
    }
    return { ok: false, response: jsonResponse(body, 400) }
  }
}

function payloadTooLargeResponse(): ReadJsonBodyResult {
  return {
    ok: false,
    response: jsonResponse({
      code: 'validation_error',
      message: `JSON body exceeds ${MAX_JSON_BODY_BYTES} byte limit`
    }, 413)
  }
}
