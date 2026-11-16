#!/usr/bin/env node
/**
 * ainotelayer, build injector. This is what the CI action runs.
 *
 * Takes a built web app (any static output directory) and adds the notes overlay
 * to every HTML page. Deploy the directory as usual afterwards. The app's source
 * is not touched.
 *
 * With --db the notes are shared through a Firebase Realtime Database. Without
 * it nothing needs setting up: notes stay in each reviewer's browser and are
 * moved around with the overlay's Download and Import.
 *
 * Usage:
 *   node inject.mjs --dir build --app slim --key pr-451 --branch feat/x --sha abc1234
 *
 *   node inject.mjs --dir build \
 *     --db https://<project>-default-rtdb.firebaseio.com \
 *     --app slim --key pr-451 --salt "$REVIEW_SALT" \
 *     --branch feat/x --sha abc1234
 *
 * Options:
 *   --review <id>    use this review id instead of deriving one from app, key and salt
 *   --repo <o/name>  GitHub repository, so notes link to the source file and line
 *   --base <path>    URL path the app is served under (default /)
 *   --preview-url    recorded with the build info
 *   --no-register    do not write the build info to the database
 */
import fs from 'node:fs'
import path from 'node:path'

import { agentGuide, restUrl, reviewId } from './agent-guide.mjs'

const here = import.meta.dirname

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

function fail(message) {
  console.error(`ainotelayer: ${message}`)
  process.exit(1)
}

function attribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function htmlFiles(directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__ainotelayer' && entry.name !== 'node_modules') {
        found.push(...htmlFiles(full))
      }
    } else if (entry.name.endsWith('.html')) {
      found.push(full)
    }
  }
  return found
}

const dir = path.resolve(arg('dir'))
const db = arg('db').replace(/\/$/, '')
if (arg('dir') === '' || !fs.existsSync(dir)) {
  fail(`build directory not found: ${dir}`)
}
const shared = db !== ''
if (shared && !/^https?:\/\//.test(db)) {
  fail('--db must be the database URL, for example https://<project>-default-rtdb.firebaseio.com')
}

const app = arg('app', path.basename(process.cwd()))
const key = arg('key', 'preview')
const review = arg('review') || reviewId({ app, key, salt: arg('salt') })
const base = `/${arg('base', '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/')
const meta = {
  app,
  key,
  repo: arg('repo') || undefined,
  branch: arg('branch') || undefined,
  sha: arg('sha').slice(0, 7) || undefined,
  previewUrl: arg('preview-url') || undefined,
  builtAt: new Date().toISOString(),
}

const own = path.join(dir, '__ainotelayer')
fs.mkdirSync(own, { recursive: true })
fs.copyFileSync(path.join(here, 'overlay.js'), path.join(own, 'overlay.js'))
fs.writeFileSync(path.join(own, 'agent.md'), agentGuide({ db, review, meta }))
fs.writeFileSync(path.join(own, 'config.json'), `${JSON.stringify({ db, review, meta }, null, 2)}\n`)

const where = shared ? ` data-db="${attribute(db)}"` : ''
const tag = `<script src="${base}__ainotelayer/overlay.js"${where} data-review="${attribute(review)}" data-meta="${attribute(JSON.stringify(meta))}" defer></script>`
const existing = /<script[^>]*__ainotelayer\/overlay\.js[^>]*><\/script>/
let pages = 0
for (const file of htmlFiles(dir)) {
  const html = fs.readFileSync(file, 'utf8')
  let next
  if (existing.test(html)) {
    next = html.replace(existing, tag)
  } else if (html.includes('</head>')) {
    next = html.replace('</head>', `${tag}</head>`)
  } else {
    continue
  }
  fs.writeFileSync(file, next)
  pages += 1
}
if (pages === 0) {
  fail(`no HTML page with a </head> found in ${dir}`)
}

if (shared && !process.argv.includes('--no-register')) {
  try {
    const response = await fetch(restUrl(db, review, 'meta'), { method: 'PUT', body: JSON.stringify(meta) })
    if (!response.ok) {
      console.warn(`ainotelayer: could not record build info (${response.status}); notes still work`)
    }
  } catch (error) {
    console.warn(`ainotelayer: could not reach the database (${error.message}); notes still work`)
  }
}

console.log(`ainotelayer: overlay added to ${pages} page(s) in ${dir}`)
console.log(`ainotelayer: review id   ${review}`)
console.log(`ainotelayer: notes       ${shared ? restUrl(db, review, 'notes') : "in each reviewer's browser (no database set)"}`)
console.log(`ainotelayer: agent page  <preview url>${base}__ainotelayer/agent.md`)

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `review-id=${review}\nnotes-url=${shared ? restUrl(db, review, 'notes') : ''}\nagent-path=${base}__ainotelayer/agent.md\n`,
  )
}
