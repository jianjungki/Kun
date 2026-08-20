import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeStatus,
  publishRuntimeDiscovery,
  removeRuntimeDiscovery,
  runtimeDiscoveryPath
} from '../src/cli/runtime-discovery.js'

describe('runtime discovery', () => {
  let dataDir = ''

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-discovery-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('publishes a versioned credential-free discovery record', async () => {
    const record = await publishRuntimeDiscovery({
      dataDir,
      host: '127.0.0.1',
      port: 8899,
      startedAt: '2026-08-17T00:00:00.000Z',
      pid: 1234,
      instanceId: 'instance-one'
    })

    const stored = JSON.parse(await readFile(runtimeDiscoveryPath(dataDir), 'utf8')) as Record<string, unknown>
    expect(stored).toEqual(record)
    expect(record).toEqual({
      version: 1,
      instanceId: 'instance-one',
      pid: 1234,
      host: '127.0.0.1',
      port: 8899,
      startedAt: '2026-08-17T00:00:00.000Z',
      dataDir: resolve(dataDir)
    })
    expect(stored).not.toHaveProperty('runtimeToken')
    expect(stored).not.toHaveProperty('apiKey')
  })

  it('removes only the discovery record owned by the same instance', async () => {
    await publishRuntimeDiscovery({
      dataDir,
      host: '127.0.0.1',
      port: 8899,
      startedAt: 'now',
      pid: 1234,
      instanceId: 'current-instance'
    })

    await expect(removeRuntimeDiscovery(dataDir, 'older-instance')).resolves.toBe(false)
    await expect(readFile(runtimeDiscoveryPath(dataDir), 'utf8')).resolves.toContain('current-instance')
    await expect(removeRuntimeDiscovery(dataDir, 'current-instance')).resolves.toBe(true)
    await expect(readFile(runtimeDiscoveryPath(dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports missing and malformed records without probing the network', async () => {
    await expect(inspectRuntimeStatus(dataDir)).resolves.toMatchObject({ status: 'missing' })

    await writeFile(runtimeDiscoveryPath(dataDir), '{invalid', 'utf8')
    const fetchHealth = vi.fn()
    await expect(inspectRuntimeStatus(dataDir, {
      fetch: fetchHealth as typeof fetch
    })).resolves.toMatchObject({
      status: 'stale',
      reason: 'runtime discovery record is not valid JSON'
    })
    expect(fetchHealth).not.toHaveBeenCalled()
  })

  it('reports a dead discovered process as stale', async () => {
    await publishRuntimeDiscovery({
      dataDir,
      host: '127.0.0.1',
      port: 8899,
      startedAt: 'now',
      pid: 4242,
      instanceId: 'stale-instance'
    })
    const fetchHealth = vi.fn()

    await expect(inspectRuntimeStatus(dataDir, {
      isProcessAlive: () => false,
      fetch: fetchHealth as typeof fetch
    })).resolves.toMatchObject({
      status: 'stale',
      reason: 'process 4242 is not running'
    })
    expect(fetchHealth).not.toHaveBeenCalled()
  })

  it('reports running only after the local health response is validated', async () => {
    await publishRuntimeDiscovery({
      dataDir,
      host: '0.0.0.0',
      port: 8899,
      startedAt: 'now',
      pid: 4242,
      instanceId: 'live-instance'
    })
    const fetchHealth = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      service: 'kun',
      mode: 'serve'
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(inspectRuntimeStatus(dataDir, {
      isProcessAlive: () => true,
      fetch: fetchHealth as typeof fetch
    })).resolves.toMatchObject({
      status: 'running',
      healthUrl: 'http://127.0.0.1:8899/health'
    })
    expect(fetchHealth).toHaveBeenCalledWith(
      'http://127.0.0.1:8899/health',
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    )
  })

  it('distinguishes a live process with an invalid health endpoint', async () => {
    await publishRuntimeDiscovery({
      dataDir,
      host: '127.0.0.1',
      port: 8899,
      startedAt: 'now',
      pid: 4242,
      instanceId: 'unreachable-instance'
    })

    await expect(inspectRuntimeStatus(dataDir, {
      isProcessAlive: () => true,
      fetch: async () => new Response('{}', { status: 200 })
    })).resolves.toMatchObject({
      status: 'unreachable',
      reason: 'health endpoint returned an unexpected response'
    })
  })
})
