// Launch the real built main (out/main/index.js) via Electron, capturing output.
// Verifies whether the DEP0040 punycode warning still fires at startup.
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const electronDir = path.resolve('node_modules/.pnpm/electron@39.8.10/node_modules/electron')
const exe = process.platform === 'win32'
  ? path.join(electronDir, 'dist', 'electron.exe')
  : path.join(electronDir, 'dist', 'electron')

const logPath = path.resolve('scripts/_dbg-main.log')
const mainEntry = path.resolve('out/main/index.js')

const env = Object.assign({}, process.env, { NODE_OPTIONS: '--trace-deprecation' })
console.log('main entry exists:', fs.existsSync(mainEntry))

const child = execFile(exe, ['.'], { cwd: path.resolve('.'), env }, (error, stdout, stderr) => {
  const log = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nEXIT:\n${error ? error.message : 'ok'}\n`
  fs.writeFileSync(logPath, log)
  process.exit(error && /MODULE_NOT_FOUND|Error/.test(String(error)) ? 1 : 0)
})

setTimeout(() => {
  if (child.exitCode === null) {
    console.log('timed out after 25s - killing electron (app launched OK)')
    child.kill()
  }
}, 25000)
