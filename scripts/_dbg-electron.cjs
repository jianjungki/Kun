// Diagnose how Electron resolves punycode from html-to-docx scope.
const { createRequire } = require('node:module')
const path = require('node:path')

const reqDocx = createRequire(
  path.resolve('node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/dist/html-to-docx.umd.js')
)
// resolve then require WITHOUT triggering the automatic warning (we just inspect identity)
const resolved = reqDocx.resolve('punycode')
const mod = reqDocx('punycode')
console.log('resolve ->', resolved)
console.log('require keys ->', Object.keys(mod).sort().join(','))
console.log('version ->', mod.version)

const { app } = require('electron')
if (app) app.quit()
