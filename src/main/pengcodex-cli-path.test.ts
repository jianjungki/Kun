import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPengCodexCliLauncher,
  buildPengCodexPowerShellLauncher,
  ensurePengCodexCliOnPath,
  pengCodexCliExecutablePath,
  removePengCodexCliFromPath,
  removeUnixPathBlock,
  upsertUnixPathBlock
} from './pengcodex-cli-path'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pengcodex-cli-path-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe('PengCodex CLI PATH installation', () => {
  it('creates an idempotent Ubuntu launcher and reversible bash profile blocks', async () => {
    const homeDir = await tempRoot()
    const profilePath = join(homeDir, '.profile')
    await writeFile(profilePath, '# user profile\n', 'utf8')
    const dependencies = {
      platform: 'linux' as const,
      homeDir,
      env: { PATH: '/usr/bin', SHELL: '/bin/bash' }
    }

    const first = await ensurePengCodexCliOnPath('/opt/Peng Codex.AppImage', dependencies)
    const second = await ensurePengCodexCliOnPath('/opt/Peng Codex.AppImage', dependencies)

    expect(first.launcherPath).toBe(join(homeDir, '.local', 'bin', 'pengcodex'))
    expect(second).toEqual(first)
    expect(await readFile(first.launcherPath, 'utf8')).toContain(
      "exec '/opt/Peng Codex.AppImage' --pengcodex-cli \"$@\""
    )
    if (process.platform !== 'win32') {
      expect((await stat(first.launcherPath)).mode & 0o111).not.toBe(0)
    }
    for (const path of [profilePath, join(homeDir, '.bashrc')]) {
      const content = await readFile(path, 'utf8')
      expect(content.match(/>>> PengCodex CLI >>>/g)).toHaveLength(1)
      expect(content).toContain(join(homeDir, '.local', 'bin'))
    }

    await removePengCodexCliFromPath(dependencies)
    await expect(readFile(first.launcherPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(profilePath, 'utf8')).toBe('# user profile\n')
    expect(await readFile(join(homeDir, '.bashrc'), 'utf8')).toBe('')
  })

  it('uses zprofile for the default macOS shell', async () => {
    const homeDir = await tempRoot()
    const result = await ensurePengCodexCliOnPath(
      "/Applications/PengCodex.app/Contents/MacOS/PengCodex",
      {
        platform: 'darwin',
        homeDir,
        env: { PATH: '/usr/bin', SHELL: '/bin/zsh' }
      }
    )

    expect(result.profilePaths).toEqual([join(homeDir, '.zprofile')])
    expect(await readFile(join(homeDir, '.zprofile'), 'utf8')).toContain('PengCodex CLI')
  })

  it('uses the persistent AppImage path instead of its temporary mount executable', () => {
    expect(pengCodexCliExecutablePath(
      'linux',
      '/tmp/.mount_PengCodex/usr/bin/pengcodex',
      { APPIMAGE: '/home/user/Applications/PengCodex.AppImage' }
    )).toBe('/home/user/Applications/PengCodex.AppImage')
  })

  it('creates a Windows command shim and delegates user PATH updates', async () => {
    const homeDir = await tempRoot()
    const localAppData = join(homeDir, 'LocalAppData')
    const updateWindowsUserPath = vi.fn(async () => undefined)
    const dependencies = {
      platform: 'win32' as const,
      homeDir,
      env: { LOCALAPPDATA: localAppData, PATH: 'C:\\Windows\\System32' },
      updateWindowsUserPath
    }

    const result = await ensurePengCodexCliOnPath(
      'C:\\Program Files\\PengCodex\\PengCodex.exe',
      dependencies
    )

    expect(result.launcherPath).toBe(join(localAppData, 'PengCodex', 'bin', 'pengcodex.cmd'))
    expect(await readFile(result.launcherPath, 'utf8')).toContain(
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0pengcodex.ps1" %*'
    )
    const powerShellLauncher = join(localAppData, 'PengCodex', 'bin', 'pengcodex.ps1')
    expect(await readFile(powerShellLauncher, 'utf8')).toContain(
      "& 'C:\\Program Files\\PengCodex\\PengCodex.exe' '--pengcodex-cli' @args"
    )
    expect(updateWindowsUserPath).toHaveBeenCalledWith(result.binDir, true)

    await removePengCodexCliFromPath(dependencies)
    await expect(readFile(powerShellLauncher, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(updateWindowsUserPath).toHaveBeenLastCalledWith(result.binDir, false)
  })

  it('does not replace an unmanaged command with the same name', async () => {
    const homeDir = await tempRoot()
    const launcherPath = join(homeDir, '.local', 'bin', 'pengcodex')
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/bin/sh\necho user-owned\n', 'utf8')

    await expect(ensurePengCodexCliOnPath('/opt/PengCodex', {
      platform: 'linux',
      homeDir,
      env: { PATH: '/usr/bin', SHELL: '/bin/bash' }
    })).rejects.toThrow(/unmanaged PengCodex CLI/)
    expect(await readFile(launcherPath, 'utf8')).toContain('user-owned')
  })

  it('quotes launchers and preserves unrelated shell profile content', () => {
    const launcher = buildPengCodexCliLauncher('darwin', "/Applications/Dev's App/PengCodex")
    expect(launcher).toContain("'/Applications/Dev'\"'\"'s App/PengCodex'")
    expect(buildPengCodexPowerShellLauncher("C:\\Dev's App\\PengCodex.exe"))
      .toContain("& 'C:\\Dev''s App\\PengCodex.exe' '--pengcodex-cli' @args")

    const original = 'export EDITOR=vim\n'
    const installed = upsertUnixPathBlock(original, '/Users/test/.local/bin')
    expect(upsertUnixPathBlock(installed, '/Users/test/.local/bin')).toBe(installed)
    expect(removeUnixPathBlock(installed)).toBe(original)
  })
})
