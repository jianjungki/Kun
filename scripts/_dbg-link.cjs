const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')

const link = 'node_modules/.pnpm/html-to-docx@1.8.0/node_modules/punycode'
const real = fs.realpathSync(link)
console.log('link realpath:', real)

// Require via absolute symlink path
const viaLink = require(path.resolve(link))
console.log('via absolute symlink version:', viaLink.version)

// Require via createRequire from the docx scope using bare specifier
const reqDocx = createRequire(path.resolve('node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/dist/html-to-docx.umd.js'))
const viaSpec = reqDocx('punycode')
console.log('via docx-scope bare specifier version:', viaSpec.version)

// Check everything Node would walk for the bare specifier from html-to-docx
const docxDir = path.resolve('node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/dist')
let d = docxDir
const nmDirs = []
while (d) {
  nmDirs.push(path.join(d, 'node_modules'))
  const parent = path.dirname(d)
  if (parent === d) break
  d = parent
}
console.log('node_modules dirs walked for bare spec:')
for (const nm of nmDirs) {
  const target = path.join(nm, 'punycode')
  console.log('  ', target, 'exists:', fs.existsSync(target))
}
