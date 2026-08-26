import {
  StudioImageGenerationRequestSchema,
  StudioImageGenerationResponseSchema,
  StudioVideoGenerationRequestSchema,
  StudioVideoGenerationResponseSchema
} from '../../contracts/studio.js'
import { MediaGenerationUnavailableError } from '../../ports/media-generation-client.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'

export async function generateStudioImage(
  runtime: ServerRuntime,
  request: Request
): Promise<JsonResponse | Response> {
  const availability = studioAvailability(runtime, 'image')
  if (availability) return availability

  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = StudioImageGenerationRequestSchema.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid studio image generation body', parsed.error.issues)

  try {
    const response = await runtime.mediaGenerationClient!.generateImage({
      request: parsed.data,
      config: runtime.studioConfig!.image,
      abortSignal: request.signal
    })
    return jsonResponse(StudioImageGenerationResponseSchema.parse(response))
  } catch (error) {
    if (error instanceof MediaGenerationUnavailableError) {
      return ERRORS.unavailable(error.message)
    }
    throw error
  }
}

export async function generateStudioVideo(
  runtime: ServerRuntime,
  request: Request
): Promise<JsonResponse | Response> {
  const availability = studioAvailability(runtime, 'video')
  if (availability) return availability

  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = StudioVideoGenerationRequestSchema.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid studio video generation body', parsed.error.issues)

  try {
    const response = await runtime.mediaGenerationClient!.generateVideo({
      request: parsed.data,
      config: runtime.studioConfig!.video,
      abortSignal: request.signal
    })
    return jsonResponse(StudioVideoGenerationResponseSchema.parse(response))
  } catch (error) {
    if (error instanceof MediaGenerationUnavailableError) {
      return ERRORS.unavailable(error.message)
    }
    throw error
  }
}

function studioAvailability(
  runtime: ServerRuntime,
  kind: 'image' | 'video'
): JsonResponse | null {
  if (!runtime.studioConfig?.enabled) return ERRORS.forbidden('studio mode is disabled')
  if (!runtime.studioConfig[kind].enabled) {
    return ERRORS.unavailable(`studio ${kind} generation is disabled`)
  }
  if (!runtime.mediaGenerationClient) return ERRORS.unavailable('studio media generation is unavailable')
  return null
}
