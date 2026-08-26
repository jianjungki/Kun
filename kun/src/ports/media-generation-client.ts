import type {
  StudioImageGenerationRequest,
  StudioImageGenerationResponse,
  StudioMediaProviderConfig,
  StudioVideoGenerationRequest,
  StudioVideoGenerationResponse
} from '../contracts/studio.js'

export type MediaGenerationKind = 'image' | 'video'

export type MediaGenerationClient = {
  generateImage(input: {
    request: StudioImageGenerationRequest
    config: StudioMediaProviderConfig
    abortSignal?: AbortSignal
  }): Promise<StudioImageGenerationResponse>
  generateVideo(input: {
    request: StudioVideoGenerationRequest
    config: StudioMediaProviderConfig
    abortSignal?: AbortSignal
  }): Promise<StudioVideoGenerationResponse>
}

export class MediaGenerationUnavailableError extends Error {
  readonly code: 'media_generation_unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'MediaGenerationUnavailableError'
    this.code = 'media_generation_unavailable'
  }
}
