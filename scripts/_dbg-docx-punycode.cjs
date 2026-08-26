/* Diagnostic: determine which punycode resolves from within html-to-docx's scope
   and whether requiring it triggers DEP0040. Replicates Electron main behavior. */
const { createRequire } = require('module')
const path = require('path')

const htmlToDocxDist = path.resolve(
  'node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/dist/html-to-docx.umd.js'
)
const reqInDocx = createRequire(htmlToDocxDist)
const htmlToDocxMain = path.resolve(
  'node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/package.json'
)
const reqByMain = createRequire(htmlToDocxMain)

function show(label, createRequireFrom) {
  try {
    const r = createRequireFrom.resolve('punycode')
    console.log(label, '-> resolve:', r)
  } catch (e) {
    console.log(label, '-> resolve ERROR:', e.message)
  }
}

show('from dist file', reqInDocx)
show('from package main', reqByMain)

// now require it with trace-deprecation
console.log('--- requiring html-to-docx via dist-file require (trace on) ---')
const proc = require('child_process')
const script = `
  const { createRequire } = require('module');
  const path = require('path');
  const p = path.resolve('node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/dist/html-to-docx.umd.js');
  const req = createRequire(p);
  req('html-to-docx');
  console.log('loaded ok');
`
try {
  const out = proc.execFileSync(process.execPath, ['--trace-deprecation', '-e', script], {
    encoding: 'utf8',
    cwd: process.cwd()
  })
  console.log(out)
} catch (e) {
  console.log('stderr/stdout:', e.stdout, e.stderr)
}
