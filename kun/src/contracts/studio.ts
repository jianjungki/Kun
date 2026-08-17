import { z } from 'zod'
import {
  DEFAULT_MODEL_PROVIDER_KIND,
  MODEL_PROVIDER_KINDS,
  normalizeModelProviderKind
} from './model-provider.js'

const PositiveInt = z.number().int().positive()

export const StudioMediaProviderConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    providerId: z.string().min(1).optional(),
    providerKind: z.preprocess(
      normalizeModelProviderKind,
      z.enum(MODEL_PROVIDER_KINDS)
    ).default(DEFAULT_MODEL_PROVIDER_KIND),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().min(1).optional()
  })
  .strict()

export const StudioRuntimeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    image: StudioMediaProviderConfigSchema.default(() => StudioMediaProviderConfigSchema.parse({})),
    video: StudioMediaProviderConfigSchema.default(() => StudioMediaProviderConfigSchema.parse({}))
  })
  .strict()

export const StudioGeneratedMediaSchema = z
  .object({
    mediaType: z.string().min(1),
    base64: z.string().min(1),
    dataUrl: z.string().min(1),
    byteSize: z.number().int().nonnegative()
  })
  .strict()

export const StudioImageGenerationRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
    model: z.string().trim().min(1).max(128).optional(),
    n: PositiveInt.max(4).optional(),
    size: z.string().regex(/^\d+x\d+$/).optional(),
    aspectRatio: z.string().regex(/^\d+:\d+$/).optional(),
    seed: z.number().int().optional(),
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
  })
  .strict()

export const StudioVideoGenerationRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
    model: z.string().trim().min(1).max(128).optional(),
    n: PositiveInt.max(2).optional(),
    aspectRatio: z.string().regex(/^\d+:\d+$/).optional(),
    resolution: z.string().regex(/^\d+x\d+$/).optional(),
    duration: z.number().positive().max(60).optional(),
    fps: PositiveInt.max(60).optional(),
    seed: z.number().int().optional(),
    generateAudio: z.boolean().optional(),
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
  })
  .strict()

export const StudioImageGenerationResponseSchema = z
  .object({
    kind: z.literal('image'),
    providerKind: z.enum(MODEL_PROVIDER_KINDS),
    model: z.string().min(1),
    files: z.array(StudioGeneratedMediaSchema),
    warnings: z.array(z.unknown()).default([])
  })
  .strict()

export const StudioVideoGenerationResponseSchema = z
  .object({
    kind: z.literal('video'),
    providerKind: z.enum(MODEL_PROVIDER_KINDS),
    model: z.string().min(1),
    files: z.array(StudioGeneratedMediaSchema),
    warnings: z.array(z.unknown()).default([])
  })
  .strict()

export type StudioMediaProviderConfig = z.infer<typeof StudioMediaProviderConfigSchema>
export type StudioRuntimeConfig = z.infer<typeof StudioRuntimeConfigSchema>
export type StudioGeneratedMedia = z.infer<typeof StudioGeneratedMediaSchema>
export type StudioImageGenerationRequest = z.infer<typeof StudioImageGenerationRequestSchema>
export type StudioVideoGenerationRequest = z.infer<typeof StudioVideoGenerationRequestSchema>
export type StudioImageGenerationResponse = z.infer<typeof StudioImageGenerationResponseSchema>
export type StudioVideoGenerationResponse = z.infer<typeof StudioVideoGenerationResponseSchema>
