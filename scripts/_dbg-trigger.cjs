/* Diagnostics: for each candidate, run in a clean subprocess with --trace-deprecation
   and report whether DEP0040 is emitted. */
const { execFileSync } = require('child_process')
const path = require('path')

const candidates = {
  tr46: path.resolve('node_modules/.pnpm/tr46@0.0.3/node_modules/tr46/index.js'),
  'ent/encode': path.resolve('node_modules/.pnpm/ent@2.2.2/node_modules/ent/encode.js'),
  'ent/decode': path.resolve('node_modules/.pnpm/ent@2.2.2/node_modules/ent/decode.js'),
  'html-to-docx': path.resolve('node_modules/.pnpm/html-to-docx@1.8.0/node_modules/html-to-docx/dist/html-to-docx.umd.js')
}

for (const [label, file] of Object.entries(candidates)) {
  const script = `require(${JSON.stringify(file)}); console.log('loaded '+${JSON.stringify(label)})`
  try {
    const out = execFileSync(process.execPath, ['--trace-deprecation', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd()
    })
    const warned = /DEP0040/.test(out)
    console.log(`[${label}] DEP0040? ${warned ? 'YES' : 'no'}`)
    if (warned) {
      console.log(out.split('\n').slice(0, 12).join('\n'))
    }
  } catch (e) {
    console.log(`[${label}] ERROR`, (e.stderr || e.message))
  }
}
