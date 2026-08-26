import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import {
  experimental_generateVideo,
  generateImage,
  type GeneratedFile,
  type Warning
} from 'ai'
import type {
  StudioGeneratedMedia,
  StudioImageGenerationRequest,
  StudioImageGenerationResponse,
  StudioMediaProviderConfig,
  StudioVideoGenerationRequest,
  StudioVideoGenerationResponse
} from '../../contracts/studio.js'
import type { ModelProviderKind } from '../../contracts/model-provider.js'
import {
  MediaGenerationUnavailableError,
  type MediaGenerationClient
} from '../../ports/media-generation-client.js'

type GenerateImageOptions = Parameters<typeof generateImage>[0]
type GenerateVideoOptions = Parameters<typeof experimental_generateVideo>[0]
type StudioImageModel = GenerateImageOptions['model']
type StudioVideoModel = GenerateVideoOptions['model']

export type AiSdkMediaGenerationClientConfig = {
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

export class AiSdkMediaGenerationClient implements MediaGenerationClient {
  private readonly config: AiSdkMediaGenerationClientConfig

  constructor(config: AiSdkMediaGenerationClientConfig = {}) {
    this.config = config
  }

  async generateImage(input: {
    request: StudioImageGenerationRequest
    config: StudioMediaProviderConfig
    abortSignal?: AbortSignal
  }): Promise<StudioImageGenerationResponse> {
    const model = effectiveModel(input.config, input.request.model)
    const result = await generateImage({
      model: this.createImageModel(input.config, model),
      prompt: input.request.prompt,
      n: input.request.n,
      size: input.request.size as `${number}x${number}` | undefined,
      aspectRatio: input.request.aspectRatio as `${number}:${number}` | undefined,
      seed: input.request.seed,
      providerOptions: input.request.providerOptions as GenerateImageOptions['providerOptions'],
      maxRetries: 0,
      abortSignal: input.abortSignal,
      headers: this.config.headers
    })
    return {
      kind: 'image',
      providerKind: input.config.providerKind,
      model,
      files: result.images.map(generatedFileToMedia),
      warnings: warningsToUnknowns(result.warnings)
    }
  }

  async generateVideo(input: {
    request: StudioVideoGenerationRequest
    config: StudioMediaProviderConfig
    abortSignal?: AbortSignal
  }): Promise<StudioVideoGenerationResponse> {
    const model = effectiveModel(input.config, input.request.model)
    const result = await experimental_generateVideo({
      model: this.createVideoModel(input.config, model),
      prompt: input.request.prompt,
      n: input.request.n,
      aspectRatio: input.request.aspectRatio as `${number}:${number}` | undefined,
      resolution: input.request.resolution as `${number}x${number}` | undefined,
      duration: input.request.duration,
      fps: input.request.fps,
      seed: input.request.seed,
      generateAudio: input.request.generateAudio,
      providerOptions: input.request.providerOptions as GenerateVideoOptions['providerOptions'],
      maxRetries: 0,
      abortSignal: input.abortSignal,
      headers: this.config.headers
    })
    return {
      kind: 'video',
      providerKind: input.config.providerKind,
      model,
      files: result.videos.map(generatedFileToMedia),
      warnings: warningsToUnknowns(result.warnings)
    }
  }

  private createImageModel(config: StudioMediaProviderConfig, modelId: string): StudioImageModel {
    const apiKey = config.apiKey?.trim() || undefined
    const baseURL = baseUrlForProvider(config.providerKind, config.baseUrl)
    const headers = this.config.headers
    const fetch = this.config.fetchImpl
    switch (config.providerKind) {
      case 'openai':
        return createOpenAI({ apiKey, baseURL, headers, fetch }).image(modelId as never)
      case 'google':
        return createGoogle({ apiKey, baseURL, headers, fetch }).image(modelId as never)
      case 'xai':
        return createXai({ apiKey, baseURL, headers, fetch }).image(modelId as never)
      case 'openai-compatible':
        return createOpenAICompatible({
          name: config.providerId?.trim() || 'openai-compatible',
          apiKey,
          baseURL: requireBaseUrl(config),
          headers,
          fetch
        }).imageModel(modelId as never)
      case 'anthropic':
      case 'mistral':
        throw unsupportedProvider(config.providerKind, 'image')
    }
  }

  private createVideoModel(config: StudioMediaProviderConfig, modelId: string): StudioVideoModel {
    const apiKey = config.apiKey?.trim() || undefined
    const baseURL = baseUrlForProvider(config.providerKind, config.baseUrl)
    const headers = this.config.headers
    const fetch = this.config.fetchImpl
    switch (config.providerKind) {
      case 'google':
        return createGoogle({ apiKey, baseURL, headers, fetch }).video(modelId as never)
      case 'xai':
        return createXai({ apiKey, baseURL, headers, fetch }).video(modelId as never)
      case 'openai':
      case 'openai-compatible':
      case 'anthropic':
      case 'mistral':
        throw unsupportedProvider(config.providerKind, 'video')
    }
  }
}

function effectiveModel(config: StudioMediaProviderConfig, override: string | undefined): string {
  const model = override?.trim() || config.model?.trim()
  if (!model) {
    throw new MediaGenerationUnavailableError('studio media generation model is not configured')
  }
  return model
}

function requireBaseUrl(config: StudioMediaProviderConfig): string {
  const baseUrl = config.baseUrl?.trim()
  if (!baseUrl) {
    throw new MediaGenerationUnavailableError('OpenAI-compatible studio media generation requires a base URL')
  }
  return baseUrl
}

function baseUrlForProvider(providerKind: ModelProviderKind, value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed) return trimmed
  switch (providerKind) {
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'xai':
      return 'https://api.x.ai/v1'
    case 'anthropic':
      return 'https://api.anthropic.com/v1'
    case 'mistral':
      return 'https://api.mistral.ai/v1'
    case 'openai-compatible':
      return undefined
  }
}

function unsupportedProvider(
  providerKind: ModelProviderKind,
  mediaKind: 'image' | 'video'
): MediaGenerationUnavailableError {
  return new MediaGenerationUnavailableError(
    `${mediaKind} generation is not supported for provider ${providerKind}`
  )
}

function generatedFileToMedia(file: GeneratedFile): StudioGeneratedMedia {
  const base64 = file.base64
  return {
    mediaType: file.mediaType,
    base64,
    dataUrl: `data:${file.mediaType};base64,${base64}`,
    byteSize: file.uint8Array.byteLength
  }
}

function warningsToUnknowns(warnings: Warning[]): unknown[] {
  return warnings.map((warning) => ({ ...warning }))
}
