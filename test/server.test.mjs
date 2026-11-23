/**
 * Checks for the local server (server.mjs): its notes store and the page it
 * hands to an agent. Each test starts the server on a free port with a store
 * folder of its own. Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const root = path.join(import.meta.dirname, '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, 'localhost', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Starts server.mjs and resolves once it listens; `stop` ends it and removes its store */
async function start(...extra) {
  const port = await freePort()
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ainotelayer-test-'))
  const child = spawn(
    process.execPath,
    [path.join(root, 'server.mjs'), '--port', String(port), '--target', 'http://localhost:9', '--repo', root, '--store', store, ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  await new Promise((resolve, reject) => {
    let said = ''
    child.stdout.on('data', (chunk) => {
      said += chunk
      if (said.includes('Agent handoff')) {
        resolve()
      }
    })
    child.once('exit', (code) => reject(new Error(`server.mjs stopped early (${code}): ${said}`)))
  })
  return {
    url: `http://localhost:${port}/__ainotelayer`,
    port,
    stop() {
      child.kill()
      fs.rmSync(store, { recursive: true, force: true })
    },
  }
}

/** A write whose body arrives in two parts, the second one `delay` ms later */
function slowPut(port, pathname, value, delay) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(value)
    const request = http.request({ host: 'localhost', port, path: pathname, method: 'PUT' }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.write(text.slice(0, 1))
    setTimeout(() => request.end(text.slice(1)), delay)
  })
}

test('two writes at the same moment are both kept', async () => {
  const server = await start()
  try {
    const at = (name) => `/__ainotelayer/db/reviews/r1/notes/${name}.json`
    const done = await Promise.all([
      slowPut(server.port, at('first'), { text: 'one' }, 120),
      slowPut(server.port, at('second'), { text: 'two' }, 60),
    ])
    assert.deepEqual(done, [200, 200])
    const notes = await (await fetch(`${server.url}/db/reviews/r1/notes.json`)).json()
    assert.deepEqual(notes, { first: { text: 'one' }, second: { text: 'two' } })
  } finally {
    server.stop()
  }
})

test('a path or a body cannot reach an object\'s prototype', async () => {
  const server = await start()
  try {
    const put = (pathname, body) => fetch(`${server.url}/db/reviews/r1/${pathname}.json`, { method: 'PUT', body })
    assert.equal((await put('notes/__proto__/planted', '"yes"')).status, 400)
    assert.equal((await put('notes/constructor/prototype/planted', '"yes"')).status, 400)
    const patch = await fetch(`${server.url}/db/reviews/r1/notes.json`, { method: 'PATCH', body: '{"__proto__/planted":"yes"}' })
    assert.equal(patch.status, 400)
    assert.equal((await put('notes/a', '{"text":"kept","__proto__":{"planted":"yes"}}')).status, 200)
    /** Another review would see a planted value if it had reached every object */
    assert.equal(await (await fetch(`${server.url}/db/reviews/r2/planted.json`)).json(), null)
    assert.deepEqual(await (await fetch(`${server.url}/db/reviews/r1/notes/a.json`)).json(), { text: 'kept' })
  } finally {
    server.stop()
  }
})

test('the agent page describes the store the notes are in', async () => {
  const local = await start()
  try {
    const page = await (await fetch(`${local.url}/agent.md`)).text()
    assert.match(page, /over plain HTTP/)
    assert.match(page, /\/__ainotelayer\/db\/reviews\//)
  } finally {
    local.stop()
  }
  const onPullRequest = await start('--pr', '7', '--github', 'o/r')
  try {
    const page = await (await fetch(`${onPullRequest.url}/agent.md`)).text()
    assert.match(page, /comments on pull request #7 in o\/r/)
    assert.match(page, /gh api repos\/o\/r\/issues\/7\/comments/)
    assert.equal(page.includes('/__ainotelayer/db/'), false)
  } finally {
    onPullRequest.stop()
  }
})
