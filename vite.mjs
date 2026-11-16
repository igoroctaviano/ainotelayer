/**
 * ainotelayer for Vite, Rollup and Rolldown: stamps JSX with source locations.
 *
 *   import ainotelayer from 'ainotelayer/vite'
 *   export default { plugins: [ainotelayer(), react()] }
 *
 * It does nothing unless the build runs with AINOTELAYER=1 (or `enabled: true`),
 * so it can stay in the config: only preview builds pay for it.
 *
 * Options:
 *   enabled   force on or off instead of reading AINOTELAYER
 *   root      folder that paths in notes are relative to (default: the repo
 *             root if one is found above the project, else the project root)
 *   include   (file) => boolean, to narrow or widen which files are stamped
 */
import fs from 'node:fs'
import path from 'node:path'

import { isStampable, labelFor, stamp } from './stamp.mjs'

export function isEnabled(option) {
  return option ?? ['1', 'true'].includes(String(process.env.AINOTELAYER ?? '').toLowerCase())
}

/** Paths relative to the repository root open correctly on GitHub, also in monorepos */
export function repoRoot(from) {
  for (let folder = path.resolve(from); ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) {
      return folder
    }
    if (folder === path.dirname(folder)) {
      return path.resolve(from)
    }
  }
}

export default function ainotelayer(options = {}) {
  const enabled = isEnabled(options.enabled)
  const include = options.include ?? isStampable
  let root = options.root
  return {
    name: 'ainotelayer:stamp',
    enforce: 'pre',
    configResolved(config) {
      root ??= repoRoot(config.root)
    },
    transform(code, id) {
      if (!enabled) {
        return null
      }
      const file = id.split('?')[0]
      if (!include(file)) {
        return null
      }
      root ??= repoRoot(process.cwd())
      const result = stamp(code, file, { label: labelFor(file, root) })
      return result === null ? null : { code: result.code, map: result.map }
    },
  }
}
