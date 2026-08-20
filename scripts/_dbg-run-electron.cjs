// Launch the bundled Electron binary with the diagnostic entry, capturing output to a log.
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const electronDir = path.resolve('node_modules/.pnpm/electron@39.8.10/node_modules/electron')
const exe = process.platform === 'win32'
  ? path.join(electronDir, 'dist', 'electron.exe')
  : path.join(electronDir, 'dist', 'electron')

const logPath = path.resolve('scripts/_dbg-electron.log')
const entry = path.resolve('scripts/_dbg-electron.cjs')

const env = Object.assign({}, process.env, { NODE_OPTIONS: '--trace-deprecation' })

console.log('electron exe:', exe, 'exists:', fs.existsSync(exe))

const child = execFile(exe, [entry], { cwd: path.resolve('.'), env }, (error, stdout, stderr) => {
  const log = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nEXIT:\n${error ? error.message : 'ok'}\n`
  fs.writeFileSync(logPath, log)
  console.log('wrote log to', logPath)
  process.exit(error ? 1 : 0)
})
setTimeout(() => {
  if (child.exitCode === null) {
    console.log('timed out - killing electron')
    child.kill()
  }
}, 15000)
