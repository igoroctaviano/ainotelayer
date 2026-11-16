#!/usr/bin/env node
/**
 * Review layer, local mode.
 *
 * A reverse proxy that puts the notes overlay on top of any running web app (a
 * dev server or a built preview) without touching its source. Notes are kept in
 * one JSON file per review and served in the same REST dialect as Firebase
 * Realtime Database, so the overlay and any agent talk to this server exactly
 * as they talk to a hosted preview's database.
 *
 * Usage:
 *   node server.mjs --target http://localhost:3100 --port 3200 --repo ../slim-redesign
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { agentGuide, slug } from './agent-guide.mjs'

const here = import.meta.dirname

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const target = new URL(arg('target', 'http://localhost:3100'))
const port = Number(arg('port', 3200))
const repo = path.resolve(arg('repo', process.cwd()))
const storeDir = path.resolve(arg('store', path.join(here, 'notes')))
const PREFIX = '/__review'
const DB = `${PREFIX}/db`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, PATCH, POST, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
}

let metaCache = { at: 0, value: null }
const watchers = new Set()

function git(...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** Which build is under review; re-read every 10 s so a branch switch is picked up */
function meta() {
  if (Date.now() - metaCache.at > 10_000) {
    const app = path.basename(repo)
    const branch = arg('branch', '') || git('rev-parse', '--abbrev-ref', 'HEAD') || 'unknown'
    metaCache = {
      at: Date.now(),
      value: {
        app,
        branch,
        sha: git('rev-parse', '--short', 'HEAD'),
        review: `${slug(app)}__${slug(branch)}`,
      },
    }
  }
  return metaCache.value
}

/** --- A small JSON tree with Realtime Database semantics ------------------- */

/** Nulls and empty containers do not exist in the database */
function prune(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (Array.isArray(value)) {
    const items = value.map(prune)
    return items.length === 0 ? null : items
  }
  if (typeof value === 'object') {
    const result = {}
    for (const [key, child] of Object.entries(value)) {
      const kept = prune(child)
      if (kept !== null) {
        result[key] = kept
      }
    }
    return Object.keys(result).length === 0 ? null : result
  }
  return value
}

function getAt(tree, segments) {
  let node = tree
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') {
      return null
    }
    node = node[segment] ?? null
  }
  return node ?? null
}

function setAt(tree, segments, value) {
  if (segments.length === 0) {
    return prune(value)
  }
  const root = tree !== null && typeof tree === 'object' ? tree : {}
  let node = root
  for (const segment of segments.slice(0, -1)) {
    if (node[segment] === null || typeof node[segment] !== 'object') {
      node[segment] = {}
    }
    node = node[segment]
  }
  node[segments[segments.length - 1]] = value
  return prune(root)
}

function treeFile(review) {
  return path.join(storeDir, `${review}.json`)
}

/** Read from disk on every request, so edits made to the file directly show up */
function loadTree(review) {
  let text
  try {
    text = fs.readFileSync(treeFile(review), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  return JSON.parse(text)
}

function saveTree(review, tree) {
  fs.mkdirSync(storeDir, { recursive: true })
  const file = treeFile(review)
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(tree ?? {}, null, 2)}\n`)
  fs.renameSync(`${file}.tmp`, file)
}

/** Keys sort by creation time, like the database's own push ids */
function pushId() {
  const time = Date.now().toString(36).padStart(9, '0')
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  return `-${time}${random}`
}

function isPrefix(prefix, segments) {
  return prefix.length <= segments.length && prefix.every((part, index) => part === segments[index])
}

/** Tell every open event stream about a write, relative to the path it watches */
function notify(review, segments, kind, data, tree) {
  for (const watcher of watchers) {
    if (watcher.review !== review) {
      continue
    }
    let event = null
    if (isPrefix(watcher.segments, segments)) {
      const relative = segments.slice(watcher.segments.length).join('/')
      event = { kind, payload: { path: `/${relative}`, data } }
    } else if (isPrefix(segments, watcher.segments)) {
      event = { kind: 'put', payload: { path: '/', data: getAt(tree, watcher.segments) } }
    }
    if (event !== null) {
      watcher.response.write(`event: ${event.kind}\ndata: ${JSON.stringify(event.payload)}\n\n`)
    }
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8_000_000) {
      throw new Error('Body too large')
    }
    chunks.push(chunk)
  }
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, value) {
  response.writeHead(status, {
    ...CORS,
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function database(request, response, url) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS)
    response.end()
    return
  }
  /** Only paths inside one review are served, so reviews cannot be listed */
  const match = url.pathname.slice(DB.length).match(/^\/reviews\/([\w.-]+)((?:\/[^/]+)*)\.json$/)
  if (match === null) {
    json(response, 403, { error: 'Permission denied' })
    return
  }
  const review = match[1]
  const segments = match[2].split('/').filter(Boolean).map(decodeURIComponent)
  let tree = loadTree(review)

  if (request.method === 'GET') {
    if (String(request.headers.accept ?? '').includes('text/event-stream')) {
      response.writeHead(200, {
        ...CORS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      const first = { path: '/', data: getAt(tree, segments) }
      response.write(`event: put\ndata: ${JSON.stringify(first)}\n\n`)
      const watcher = { review, segments, response }
      watchers.add(watcher)
      const beat = setInterval(() => response.write('event: keep-alive\ndata: null\n\n'), 30_000)
      request.on('close', () => {
        clearInterval(beat)
        watchers.delete(watcher)
      })
      return
    }
    json(response, 200, getAt(tree, segments))
    return
  }

  const body = await readJson(request)
  if (request.method === 'PUT') {
    tree = setAt(tree, segments, body)
    saveTree(review, tree)
    notify(review, segments, 'put', prune(body), tree)
    json(response, 200, body)
    return
  }
  if (request.method === 'PATCH') {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      json(response, 400, { error: 'PATCH needs an object' })
      return
    }
    for (const [key, value] of Object.entries(body)) {
      tree = setAt(tree, [...segments, ...key.split('/').filter(Boolean)], value)
    }
    saveTree(review, tree)
    notify(review, segments, 'patch', body, tree)
    json(response, 200, body)
    return
  }
  if (request.method === 'POST') {
    const name = pushId()
    tree = setAt(tree, [...segments, name], body)
    saveTree(review, tree)
    notify(review, [...segments, name], 'put', prune(body), tree)
    json(response, 200, { name })
    return
  }
  if (request.method === 'DELETE') {
    tree = setAt(tree, segments, null)
    saveTree(review, tree)
    notify(review, segments, 'put', null, tree)
    json(response, 200, null)
    return
  }
  json(response, 405, { error: 'Method not allowed' })
}

/** --- Overlay files and the proxy ------------------------------------------ */

function origin(request) {
  return `http://${request.headers.host ?? `localhost:${port}`}`
}

function overlayTag(info) {
  return `<script src="${PREFIX}/overlay.js" data-db="${DB}" data-review="${info.review}" defer></script>`
}

/** Keep the stored build info current, so notes record the build they were made on */
function recordMeta(info) {
  const tree = loadTree(info.review)
  const stored = getAt(tree, ['meta'])
  if (stored === null || stored.sha !== info.sha || stored.branch !== info.branch) {
    saveTree(info.review, setAt(tree, ['meta'], { ...info, target: target.origin }))
  }
}

function serveOwn(request, response, url) {
  const info = meta()
  if (url.pathname === `${PREFIX}/overlay.js`) {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    response.end(fs.readFileSync(path.join(here, 'overlay.js')))
    return
  }
  if (url.pathname === `${PREFIX}/agent.md`) {
    response.writeHead(200, { ...CORS, 'content-type': 'text/markdown; charset=utf-8' })
    response.end(agentGuide({ db: `${origin(request)}${DB}`, review: info.review, meta: info }))
    return
  }
  json(response, 404, { error: 'Not found' })
}

/** Everything that is not the review layer goes to the app; HTML gets the overlay tag */
function proxy(request, response) {
  const headers = { ...request.headers, host: target.host }
  delete headers['accept-encoding']
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: request.url,
      method: request.method,
      headers,
    },
    (reply) => {
      const type = String(reply.headers['content-type'] ?? '')
      if (!type.includes('text/html')) {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
        return
      }
      const chunks = []
      reply.on('data', (chunk) => chunks.push(chunk))
      reply.on('end', () => {
        const info = meta()
        recordMeta(info)
        const tag = overlayTag(info)
        const html = Buffer.concat(chunks).toString('utf8')
        const injected = html.includes('</head>')
          ? html.replace('</head>', `${tag}</head>`)
          : `${html}${tag}`
        const replyHeaders = { ...reply.headers }
        delete replyHeaders['content-encoding']
        delete replyHeaders['transfer-encoding']
        replyHeaders['content-length'] = Buffer.byteLength(injected)
        response.writeHead(reply.statusCode ?? 200, replyHeaders)
        response.end(injected)
      })
    },
  )
  upstream.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain' })
    }
    response.end(`Review layer: cannot reach ${target.origin} (${error.message})`)
  })
  request.pipe(upstream)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://review.local')
  if (url.pathname.startsWith(`${DB}/`)) {
    database(request, response, url).catch((error) => {
      if (!response.headersSent) {
        json(response, 500, { error: error.message })
      } else {
        response.end()
      }
    })
    return
  }
  if (url.pathname.startsWith(`${PREFIX}/`)) {
    serveOwn(request, response, url)
    return
  }
  proxy(request, response)
})

/** Pass WebSocket upgrades through so the dev server's hot reload keeps working */
server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`]
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const key = request.rawHeaders[index]
      const value = key.toLowerCase() === 'host' ? target.host : request.rawHeaders[index + 1]
      lines.push(`${key}: ${value}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) {
      upstream.write(head)
    }
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(port, 'localhost', () => {
  const info = meta()
  console.log(`Review layer: http://localhost:${port} -> ${target.origin}`)
  console.log(`Notes for ${info.app} @ ${info.branch} (${info.sha}): ${treeFile(info.review)}`)
  console.log(`Agent handoff: http://localhost:${port}${PREFIX}/agent.md`)
})
