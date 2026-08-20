/* Temporary diagnostic: locate packages whose source references the punycode built-in. */
const fs = require('fs')
const path = require('path')

const roots = ['node_modules/.pnpm']
const hits = []

function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const x of entries) {
    const p = path.join(dir, x.name)
    if (x.isDirectory()) {
      walk(p)
    } else if (/\.(js|cjs|mjs)$/.test(x.name)) {
      try {
        const s = fs.readFileSync(p, 'utf8')
        if (/require\(["']punycode|["']node:punycode["']/.test(s)) {
          hits.push(p)
        }
      } catch {
        /* ignore unreadable */
      }
    }
  }
}

for (const r of roots) walk(r)
console.log('FILES referencing punycode built-in:')
console.log(hits.join('\n') || '(none in .pnpm)')
