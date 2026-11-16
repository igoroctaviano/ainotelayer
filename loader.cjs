/**
 * ainotelayer loader for webpack and Rspack: stamps JSX with source locations.
 * Add it through the rule from webpack.cjs, which runs it before the app's own
 * loaders. It passes files through untouched unless AINOTELAYER=1.
 */
const fs = require('node:fs')
const path = require('node:path')

function isEnabled(option) {
  return option ?? ['1', 'true'].includes(String(process.env.AINOTELAYER ?? '').toLowerCase())
}

function repoRoot(from) {
  for (let folder = path.resolve(from); ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) {
      return folder
    }
    if (folder === path.dirname(folder)) {
      return path.resolve(from)
    }
  }
}

module.exports = function ainotelayerLoader(source, map) {
  const options = typeof this.getOptions === 'function' ? this.getOptions() : {}
  if (!isEnabled(options.enabled)) {
    return source
  }
  const done = this.async()
  const file = this.resourcePath
  const root = options.root ?? repoRoot(this.rootContext ?? process.cwd())
  import('./stamp.mjs')
    .then(({ isStampable, labelFor, stamp }) => {
      const result = isStampable(file) ? stamp(source, file, { label: labelFor(file, root) }) : null
      if (result === null) {
        done(null, source, map)
      } else {
        done(null, result.code, JSON.parse(result.map.toString()))
      }
    })
    .catch((error) => done(error))
}
