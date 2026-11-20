#!/usr/bin/env node
/**
 * ainotelayer, local mode.
 *
 * A reverse proxy that puts the notes overlay on top of any running web app (a
 * dev server or a built preview) without touching its source. Notes are kept in
 * one JSON file per review and served in the same REST dialect as Firebase
 * Realtime Database, so the overlay and any agent talk to this server exactly
 * as they talk to a hosted preview's database.
 *
 * Usage:
 *   node server.mjs --target http://localhost:3100 --port 3200 --repo ../slim-redesign
 *
 * Options:
 *   --pr <number>      keep notes as comments on that pull request instead of in
 *                      local files (the repository is read from the git remote,
 *                      or given with --github owner/name)
 *   --mock-github      with --pr: talk to a simulated GitHub served by this
 *                      server, for trying things out without touching GitHub.
 *                      Its tokens are `mock-<login>`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { agentGuide, overlayBundle, slug } from './agent-guide.mjs'

const here = import.meta.dirname

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const target = new URL(arg('target', 'http://localhost:3100'))
if (target.protocol !== 'http:') {
  console.error(`ainotelayer: --target must be an http:// address (a dev server or a local preview), not ${target.protocol}//`)
  process.exit(1)
}
/** A target without a port in its address is on the default one */
const targetPort = Number(target.port) || 80
const port = Number(arg('port', 3200))
const repo = path.resolve(arg('repo', process.cwd()))
const storeDir = path.resolve(arg('store', path.join(here, 'notes')))
const PREFIX = '/__ainotelayer'
const DB = `${PREFIX}/db`
const MOCK = `${PREFIX}/mock-github`
const pullRequest = arg('pr', '')
const mockGithub = process.argv.includes('--mock-github')
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
    /** owner/name on GitHub, so notes can link to the source file and line */
    const remote = /github\.com[:/](.+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'))
    metaCache = {
      at: Date.now(),
      value: {
        app,
        ...(remote === null ? {} : { repo: remote[1] }),
        branch,
        sha: git('rev-parse', '--short', 'HEAD'),
        review: `${slug(app)}__${slug(branch)}`,
      },
    }
  }
  return metaCache.value
}

/** --- A small JSON tree with Realtime Database semantics ------------------- */

/**
 * Keys that mean something to every object. A path or a body that names one
 * would write to the object's prototype instead of the notes.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

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
      const kept = UNSAFE_KEYS.has(key) ? null : prune(child)
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
  if (segments.some((segment) => UNSAFE_KEYS.has(segment))) {
    json(response, 400, { error: 'This path cannot be used' })
    return
  }

  if (request.method === 'GET') {
    const tree = loadTree(review)
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

  /**
   * The file is read after the whole body has arrived, and written back
   * without waiting for anything in between: two writes at the same moment
   * then follow each other instead of one undoing the other.
   */
  const body = await readJson(request)
  let tree = loadTree(review)
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
    const changes = Object.entries(body).map(([key, value]) => [key.split('/').filter(Boolean), value])
    if (changes.some(([keys]) => keys.some((key) => UNSAFE_KEYS.has(key)))) {
      json(response, 400, { error: 'This path cannot be used' })
      return
    }
    for (const [keys, value] of changes) {
      tree = setAt(tree, [...segments, ...keys], value)
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

function attribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The repository whose pull request holds the notes, when --pr is given */
function githubRepo(info) {
  return arg('github', '') || info.repo || ''
}

function overlayTag(info) {
  const meta = ` data-meta="${attribute(JSON.stringify(info))}"`
  const repository = githubRepo(info)
  if (pullRequest !== '' && repository !== '') {
    const api = mockGithub ? ` data-github-api="${MOCK}"` : ''
    return `<script src="${PREFIX}/overlay.js" data-github="${attribute(repository)}" data-pr="${attribute(pullRequest)}"${api} data-review="${info.review}"${meta} defer></script>`
  }
  return `<script src="${PREFIX}/overlay.js" data-db="${DB}" data-review="${info.review}"${meta} defer></script>`
}

/** --- A simulated GitHub, for trying the pull-request store locally -------- */

function mockFile(owner, name, number) {
  return path.join(storeDir, `mock-github__${slug(owner)}__${slug(name)}__${slug(number)}.json`)
}

function mockLoad(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { next: 1000, comments: [] }
    }
    throw error
  }
}

/** `Bearer mock-<login>` signs in as <login>; anything else is not signed in */
function mockLogin(request) {
  const found = /^(?:Bearer|token) mock-([\w-]+)$/.exec(String(request.headers.authorization ?? ''))
  return found === null ? null : found[1]
}

async function mockApi(request, response, url) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS)
    response.end()
    return
  }
  const route = url.pathname.slice(MOCK.length)
  const login = mockLogin(request)
  if (login === null && request.headers.authorization !== undefined) {
    /** Like GitHub: a token it does not know is refused, even for reading */
    json(response, 401, { message: 'Bad credentials' })
    return
  }
  if (route === '/user') {
    json(response, login === null ? 401 : 200, login === null ? { message: 'Bad credentials' } : { login })
    return
  }
  const list = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(route)
  if (list !== null) {
    const file = mockFile(list[1], list[2], list[3])
    const store = mockLoad(file)
    if (request.method === 'GET') {
      const since = url.searchParams.get('since') ?? ''
      const size = Number(url.searchParams.get('per_page') ?? 30)
      const page = Number(url.searchParams.get('page') ?? 1)
      const matching = store.comments.filter((comment) => comment.updated_at >= since)
      json(response, 200, matching.slice((page - 1) * size, page * size))
      return
    }
    if (request.method === 'POST') {
      if (login === null) {
        json(response, 401, { message: 'Requires authentication' })
        return
      }
      const input = await readJson(request)
      const now = new Date().toISOString()
      const comment = {
        id: store.next,
        body: String(input?.body ?? ''),
        /** Logins starting with "outsider" stand for people without access to the repository */
        user: { login, type: /bot$/.test(login) ? 'Bot' : 'User' },
        author_association: login.startsWith('outsider') ? 'NONE' : 'COLLABORATOR',
        created_at: now,
        updated_at: now,
        html_url: `https://github.com/${list[1]}/${list[2]}/pull/${list[3]}#issuecomment-${store.next}`,
      }
      store.next += 1
      store.comments.push(comment)
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
      json(response, 201, comment)
      return
    }
  }
  const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(route)
  if (pull !== null && request.method === 'GET') {
    json(response, 200, { number: Number(pull[3]), head: { sha: `mocksha${pull[3]}` } })
    return
  }
  const statuses =
    /^\/repos\/([^/]+)\/([^/]+)\/statuses\/([\w]+)$/.exec(route) ??
    /^\/repos\/([^/]+)\/([^/]+)\/commits\/([\w]+)\/statuses$/.exec(route)
  if (statuses !== null) {
    const file = path.join(storeDir, `mock-github__${slug(statuses[1])}__${slug(statuses[2])}__statuses.json`)
    const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    if (request.method === 'GET') {
      json(response, 200, stored[statuses[3]] ?? [])
      return
    }
    if (request.method === 'POST') {
      if (login === null) {
        json(response, 401, { message: 'Requires authentication' })
        return
      }
      const input = await readJson(request)
      stored[statuses[3]] = [{ ...input, creator: { login }, created_at: new Date().toISOString() }, ...(stored[statuses[3]] ?? [])]
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`)
      json(response, 201, stored[statuses[3]][0])
      return
    }
  }
  const one = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(route)
  if (one !== null && request.method === 'PATCH') {
    const prefix = `mock-github__${slug(one[1])}__${slug(one[2])}__`
    const files = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).filter((name) => name.startsWith(prefix) && !name.endsWith('statuses.json')) : []
    for (const name of files) {
      const file = path.join(storeDir, name)
      const store = mockLoad(file)
      const comment = store.comments.find((item) => item.id === Number(one[3]))
      if (comment === undefined) {
        continue
      }
      if (login !== comment.user.login) {
        json(response, 403, { message: 'Only the author can edit this comment.' })
        return
      }
      const input = await readJson(request)
      comment.body = String(input?.body ?? '')
      comment.updated_at = new Date().toISOString()
      fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
      json(response, 200, comment)
      return
    }
  }
  if (one !== null && request.method === 'DELETE') {
    /** The simulated store is searched across pull requests, as GitHub's comment ids are global */
    const prefix = `mock-github__${slug(one[1])}__${slug(one[2])}__`
    const files = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).filter((name) => name.startsWith(prefix) && !name.endsWith('statuses.json')) : []
    for (const name of files) {
      const file = path.join(storeDir, name)
      const store = mockLoad(file)
      const comment = store.comments.find((item) => item.id === Number(one[3]))
      if (comment === undefined) {
        continue
      }
      if (login === null || (login !== comment.user.login && login !== 'maintainer')) {
        json(response, 403, { message: 'Must have admin rights to Repository.' })
        return
      }
      store.comments = store.comments.filter((item) => item !== comment)
      fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
      response.writeHead(204, CORS)
      response.end()
      return
    }
  }
  json(response, 404, { message: 'Not Found' })
}

/** Keep the stored build info current, so notes record the build they were made on */
function recordMeta(info) {
  const tree = loadTree(info.review)
  const stored = getAt(tree, ['meta'])
  if (
    stored === null ||
    stored.sha !== info.sha ||
    stored.branch !== info.branch ||
    stored.repo !== info.repo
  ) {
    saveTree(info.review, setAt(tree, ['meta'], { ...info, target: target.origin }))
  }
}

function serveOwn(request, response, url) {
  const info = meta()
  if (url.pathname === `${PREFIX}/overlay.js`) {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    response.end(overlayBundle(here))
    return
  }
  if (url.pathname === `${PREFIX}/agent.md`) {
    response.writeHead(200, { ...CORS, 'content-type': 'text/markdown; charset=utf-8' })
    const repository = githubRepo(info)
    const github =
      pullRequest !== '' && repository !== ''
        ? { repo: repository, pr: pullRequest, api: mockGithub ? `${origin(request)}${MOCK}` : undefined }
        : undefined
    /** With --pr the notes are on the pull request, and the page must say so, not point at the local files */
    const db = github === undefined ? `${origin(request)}${DB}` : ''
    response.end(agentGuide({ db, review: info.review, meta: info, github }))
    return
  }
  json(response, 404, { error: 'Not found' })
}

/** Everything that is not ainotelayer's own goes to the app; HTML gets the overlay tag */
function proxy(request, response) {
  const headers = { ...request.headers, host: target.host }
  delete headers['accept-encoding']
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: targetPort,
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
        /** A function, so that a "$&" in the build info is not read as a pattern */
        const injected = html.includes('</head>')
          ? html.replace('</head>', () => `${tag}</head>`)
          : `${html}${tag}`
        const replyHeaders = { ...reply.headers }
        delete replyHeaders['content-encoding']
        delete replyHeaders['transfer-encoding']
        /**
         * The page carries the review id and the build info, which change
         * with the branch. Left to the app's own caching headers, the browser
         * would ask "still the same?", the app would say yes, and the page
         * would keep the tag of the branch it was first loaded on.
         */
        delete replyHeaders.etag
        delete replyHeaders['last-modified']
        replyHeaders['cache-control'] = 'no-store'
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
    response.end(`ainotelayer: cannot reach ${target.origin} (${error.message})`)
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
  if (mockGithub && url.pathname.startsWith(`${MOCK}/`)) {
    mockApi(request, response, url).catch((error) => {
      if (!response.headersSent) {
        json(response, 500, { message: error.message })
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
  const upstream = net.connect(targetPort, target.hostname, () => {
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
  console.log(`ainotelayer: http://localhost:${port} -> ${target.origin}`)
  if (pullRequest !== '' && githubRepo(info) !== '') {
    const where = mockGithub ? 'a simulated GitHub' : 'GitHub'
    console.log(`Notes for ${info.app}: comments on pull request #${pullRequest} in ${githubRepo(info)} (${where})`)
  } else {
    console.log(`Notes for ${info.app} @ ${info.branch} (${info.sha}): ${treeFile(info.review)}`)
  }
  console.log(`Agent handoff: http://localhost:${port}${PREFIX}/agent.md`)
})
