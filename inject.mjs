#!/usr/bin/env node
/**
 * Review layer, build injector. This is what the CI action runs.
 *
 * Takes a built web app (any static output directory), adds the notes overlay
 * to every HTML page, and points it at a Firebase Realtime Database. Deploy the
 * directory as usual afterwards. The app's source is not touched.
 *
 * Usage:
 *   node inject.mjs --dir build \
 *     --db https://<project>-default-rtdb.firebaseio.com \
 *     --app slim --key pr-451 --salt "$REVIEW_SALT" \
 *     --branch feat/x --sha abc1234
 *
 * Options:
 *   --review <id>    use this review id instead of deriving one from app, key and salt
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
  console.error(`review-layer: ${message}`)
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
      if (entry.name !== '__review' && entry.name !== 'node_modules') {
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
if (!/^https?:\/\//.test(db)) {
  fail('--db must be the database URL, for example https://<project>-default-rtdb.firebaseio.com')
}

const app = arg('app', path.basename(process.cwd()))
const key = arg('key', 'preview')
const review = arg('review') || reviewId({ app, key, salt: arg('salt') })
const base = `/${arg('base', '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/')
const meta = {
  app,
  key,
  branch: arg('branch') || undefined,
  sha: arg('sha').slice(0, 7) || undefined,
  previewUrl: arg('preview-url') || undefined,
  builtAt: new Date().toISOString(),
}

const own = path.join(dir, '__review')
fs.mkdirSync(own, { recursive: true })
fs.copyFileSync(path.join(here, 'overlay.js'), path.join(own, 'overlay.js'))
fs.writeFileSync(path.join(own, 'agent.md'), agentGuide({ db, review, meta }))
fs.writeFileSync(path.join(own, 'config.json'), `${JSON.stringify({ db, review, meta }, null, 2)}\n`)

const tag = `<script src="${base}__review/overlay.js" data-db="${attribute(db)}" data-review="${attribute(review)}" defer></script>`
const existing = /<script[^>]*__review\/overlay\.js[^>]*><\/script>/
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

if (!process.argv.includes('--no-register')) {
  try {
    const response = await fetch(restUrl(db, review, 'meta'), { method: 'PUT', body: JSON.stringify(meta) })
    if (!response.ok) {
      console.warn(`review-layer: could not record build info (${response.status}); notes still work`)
    }
  } catch (error) {
    console.warn(`review-layer: could not reach the database (${error.message}); notes still work`)
  }
}

console.log(`review-layer: overlay added to ${pages} page(s) in ${dir}`)
console.log(`review-layer: review id   ${review}`)
console.log(`review-layer: notes       ${restUrl(db, review, 'notes')}`)
console.log(`review-layer: agent page  <preview url>${base}__review/agent.md`)

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `review-id=${review}\nnotes-url=${restUrl(db, review, 'notes')}\nagent-path=${base}__review/agent.md\n`,
  )
}
