/**
 * ainotelayer for webpack and Rspack: one rule that stamps JSX with source
 * locations before the app's own loaders run.
 *
 *   const { ainotelayerRule } = require('ainotelayer/webpack')
 *   module.exports = { module: { rules: [ainotelayerRule(), ...] } }
 *
 * It does nothing unless the build runs with AINOTELAYER=1 (or `enabled: true`).
 *
 * Options:
 *   enabled   force on or off instead of reading AINOTELAYER
 *   root      folder that paths in notes are relative to (default: the repo root)
 *   test      which files to look at (default: .jsx, .tsx, .js, .mjs)
 *   exclude   which files to leave alone (default: node_modules)
 */
function ainotelayerRule(options = {}) {
  const { test, exclude, ...loaderOptions } = options
  return {
    test: test ?? /\.(jsx|tsx|js|mjs)$/,
    exclude: exclude ?? /node_modules/,
    enforce: 'pre',
    use: [{ loader: require.resolve('./loader.cjs'), options: loaderOptions }],
  }
}

module.exports = { ainotelayerRule }
