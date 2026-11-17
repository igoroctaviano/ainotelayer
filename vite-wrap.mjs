#!/usr/bin/env node
/**
 * ainotelayer, source stamping without touching the app.
 *
 * Writes a Vite config that is the app's own config with the stamping plugin
 * put in front, so a build can tag JSX with source locations although the
 * app's repository does not mention ainotelayer anywhere. This is what the
 * `stamp` action runs.
 *
 * Usage:
 *   node vite-wrap.mjs --root <app folder> --out <file to write>
 *
 * It prints the arguments to add to the app's build command:
 *   --config <file> --configLoader native
 * and nothing when the app has no Vite config, so the build simply runs
 * without stamps. `--configLoader native` needs Node 22.18 or newer when the
 * app's config is TypeScript.
 *
 * Options:
 *   --config <path>   the app's Vite config, when it is not vite.config.* in
 *                     the root
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const root = path.resolve(arg('root', '.'))
const out = path.resolve(arg('out', path.join(root, 'ainotelayer.vite.config.mjs')))

function findConfig() {
  const given = arg('config')
  if (given !== '') {
    return path.resolve(root, given)
  }
  for (const name of ['ts', 'mts', 'js', 'mjs', 'cjs']) {
    const candidate = path.join(root, `vite.config.${name}`)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

const config = findConfig()
if (config === null || !fs.existsSync(config)) {
  console.error(`ainotelayer: no Vite config found in ${root}; building without source stamps`)
  process.exit(0)
}

const plugin = pathToFileURL(path.join(here, 'vite.mjs')).href
const app = pathToFileURL(config).href
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(
  out,
  `/**
 * Written by ainotelayer (vite-wrap.mjs): the app's own Vite config with the
 * source-stamping plugin put in front. Nothing in the app's repository changes.
 */
import ainotelayer from ${JSON.stringify(plugin)}
import app from ${JSON.stringify(app)}

export default async (env) => {
  const base = typeof app === 'function' ? await app(env) : await app
  return { ...base, plugins: [ainotelayer({ enabled: true }), ...(base.plugins ?? [])] }
}
`,
)
console.error(`ainotelayer: source stamping on, through ${out}`)
console.log(`--config ${out} --configLoader native`)
