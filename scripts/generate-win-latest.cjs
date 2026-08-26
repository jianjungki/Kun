#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readdir, stat, writeFile } = require('node:fs/promises')
const { basename, resolve, join } = require('node:path')
const { version: packageVersion } = require('../package.json')

function sha512Base64(path) {
  const hash = createHash('sha512')
  return new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('base64')))
  })
}

async function main() {
  const distDir = resolve(
    process.argv[2] ||
    process.env.PENGCODEX_DIST_DIR ||
    process.env.DEEPSEEK_GUI_DIST_DIR ||
    'dist'
  )
  const version = (
    process.argv[3] ||
    process.env.PENGCODEX_APP_VERSION ||
    process.env.DEEPSEEK_GUI_APP_VERSION ||
    packageVersion
  ).trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected an x.y.z app version, got: ${version}`)
  }

  const installers = (await readdir(distDir))
    .map((fileName) => {
      const match = fileName.match(/^PengCodex-(\d+\.\d+\.\d+)-win-x64\.exe$/)
      return match ? { fileName, version: match[1], path: join(distDir, fileName) } : null
    })
    .filter(Boolean)
    .filter((installer) => installer.version === version)

  if (installers.length !== 1) {
    throw new Error(
      `Expected one Windows ${version} installer in ${distDir}, found ${installers.length}`
    )
  }

  const installer = installers[0]
  const info = await stat(installer.path)
  const sha512 = await sha512Base64(installer.path)
  const fileName = basename(installer.fileName)
  const lines = [
    `version: ${installer.version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${info.size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ]

  const latestPath = join(distDir, 'latest.yml')
  await writeFile(latestPath, lines.join('\n'), 'utf8')
  console.log(`Generated ${latestPath}`)
}

main().catch((error) => {
  console.error(`[generate-win-latest] ${error.message}`)
  process.exit(1)
})
