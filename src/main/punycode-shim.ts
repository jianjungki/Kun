/**
 * Pre-entry shim that redirects `require('punycode')` to the userland `punycode`
 * package instead of Node's deprecated built-in module.
 *
 * Background: as of Node 22 the built-in `punycode` module takes unconditional
 * precedence over any `node_modules/punycode` for the bare specifier, so merely
 * installing the userland package does NOT silence the [DEP0040] deprecation
 * warning (it still fires when html-to-docx eagerly `require('punycode')` during
 * main-process startup). This module forces the CJS loader to hand back the
 * userland copy instead, so the built-in never loads and no warning is emitted.
 *
 * This module MUST be the first import in the main entry so the interception is
 * installed before any other module (e.g. write-export-service -> html-to-docx)
 * triggers the built-in load. Importing it is a side effect only; it exports
 * nothing.
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const requireFromHere = createRequire(import.meta.url)

function locateUserlandPunycode(): unknown {
  try {
    // Resolving `punycode/package.json` (a path-style specifier) bypasses the
    // built-in name lookup and returns the real on-disk package path. Requiring
    // that directory by absolute path loads the userland copy.
    const packageJsonPath = requireFromHere.resolve('punycode/package.json')
    return requireFromHere(dirname(packageJsonPath))
  } catch {
    // The userland package is not installed (e.g. a trimmed install). Fall back
    // to letting the runtime resolve `punycode` normally — it may warn again.
    return null
  }
}

const userlandPunycode = locateUserlandPunycode()

if (userlandPunycode !== null) {
  const Module = requireFromHere('module').Module
  const originalLoad = Module._load as (
    request: string,
    parent: object | null,
    isMain: boolean
  ) => unknown

  Module._load = function patchedPunycodeLoad(
    this: unknown,
    request: string,
    parent: object | null,
    isMain: boolean
  ): unknown {
    if (request === 'punycode' || request === 'node:punycode') {
      return userlandPunycode
    }
    return originalLoad.call(this, request, parent, isMain)
  }
}

export {}
