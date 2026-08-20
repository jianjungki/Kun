import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_TOKEN_FILENAME,
  resolveServeRuntimeToken
} from '../src/cli/runtime-token.js'

describe('standalone runtime token', () => {
  let dataDir = ''

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pengcodex-runtime-token-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('creates and reuses a protected token when serve auth is enabled', async () => {
    const first = await resolveServeRuntimeToken({ dataDir, runtimeToken: '', insecure: false })
    const second = await resolveServeRuntimeToken({ dataDir, runtimeToken: '', insecure: false })
    const tokenPath = join(dataDir, RUNTIME_TOKEN_FILENAME)

    expect(first.generated).toBe(true)
    expect(first.runtimeToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(second).toMatchObject({
      generated: false,
      runtimeToken: first.runtimeToken,
      tokenPath
    })
    expect((await readFile(tokenPath, 'utf8')).trim()).toBe(first.runtimeToken)
    if (process.platform !== 'win32') {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('does not create a token file for explicit insecure mode', async () => {
    await expect(resolveServeRuntimeToken({
      dataDir,
      runtimeToken: '',
      insecure: true
    })).resolves.toEqual({ runtimeToken: '', generated: false })
    await expect(readFile(join(dataDir, RUNTIME_TOKEN_FILENAME), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses an explicit token without copying it to disk', async () => {
    await expect(resolveServeRuntimeToken({
      dataDir,
      runtimeToken: 'explicit-token',
      insecure: false
    })).resolves.toEqual({ runtimeToken: 'explicit-token', generated: false })
    await expect(readFile(join(dataDir, RUNTIME_TOKEN_FILENAME), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})
