import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'

export const RUNTIME_TOKEN_FILENAME = 'runtime-token'
const GENERATED_RUNTIME_TOKEN_BYTES = 32

export type ResolvedRuntimeToken = {
  runtimeToken: string
  tokenPath?: string
  generated: boolean
}

export async function resolveServeRuntimeToken(input: {
  dataDir: string
  runtimeToken: string
  insecure: boolean
}): Promise<ResolvedRuntimeToken> {
  if (input.insecure) {
    return { runtimeToken: '', generated: false }
  }
  const explicit = input.runtimeToken.trim()
  if (explicit) {
    return { runtimeToken: explicit, generated: false }
  }

  const tokenPath = join(resolve(input.dataDir), RUNTIME_TOKEN_FILENAME)
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim()
    if (existing) {
      return { runtimeToken: existing, tokenPath, generated: false }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const runtimeToken = randomBytes(GENERATED_RUNTIME_TOKEN_BYTES).toString('base64url')
  await atomicWriteFile(tokenPath, `${runtimeToken}\n`, { mode: 0o600 })
  return { runtimeToken, tokenPath, generated: true }
}
