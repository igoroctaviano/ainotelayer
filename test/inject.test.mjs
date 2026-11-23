/**
 * Checks for the build injector (inject.mjs): the script tag it writes into a
 * built page. Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const inject = path.join(import.meta.dirname, '..', 'inject.mjs')

function build(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainotelayer-build-'))
  fs.writeFileSync(path.join(dir, 'index.html'), html)
  return dir
}

function run(dir, ...extra) {
  execFileSync(process.execPath, [inject, '--dir', dir, '--app', 'app', '--key', 'pr-1', ...extra], {
    env: { ...process.env, GITHUB_OUTPUT: '' },
    stdio: 'pipe',
  })
  return fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
}

/** The build info as the page's script tag carries it */
function metaOf(html) {
  const found = /data-meta="([^"]*)"/.exec(html)
  const text = found[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return JSON.parse(text)
}

test('build info is written as given, whatever characters it holds', () => {
  const dir = build('<html><head><title>t</title></head><body></body></html>')
  try {
    const branch = 'feat/$&-$\'-<b>-"q"'
    const html = run(dir, '--branch', branch, '--github', 'o/r', '--pr', '1')
    assert.equal(metaOf(html).branch, branch)
    assert.equal(html.split('</head>').length, 2)
    assert.match(html, /data-github="o\/r" data-pr="1"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('running it again replaces the tag instead of adding a second one', () => {
  const dir = build('<html><head></head><body></body></html>')
  try {
    run(dir, '--branch', 'a>b')
    const html = run(dir, '--branch', 'second')
    assert.equal(html.split('__ainotelayer/overlay.js').length, 2)
    assert.equal(metaOf(html).branch, 'second')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
