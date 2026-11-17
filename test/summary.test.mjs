/**
 * Checks for the pull-request notes reader used in CI and the overview it
 * writes. Run with `npm test`.
 *
 * test/fixtures/pr-comments.json is the contract between this reader and the
 * one in overlay.js; test/github.html checks the overlay against the same file.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { countNotes, describeCounts, foldNotes, hiddenBlock, readHidden, summaryBody } from '../github-notes.mjs'

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pr-comments.json'), 'utf8'),
)

test('the fixture pull request folds into the expected notes', () => {
  const notes = foldNotes(fixture.comments)
  assert.deepEqual(
    notes.map(({ n, id, status, replies, author }) => ({ n, id, status, replies, author })),
    fixture.expect,
  )
})

test('comment order in the API response does not matter', () => {
  const shuffled = [...fixture.comments].reverse()
  assert.deepEqual(
    foldNotes(shuffled).map((note) => note.status),
    fixture.expect.map((note) => note.status),
  )
})

test('a note records what it is on and where it comes from', () => {
  const [first, second] = foldNotes(fixture.comments)
  assert.equal(first.element, 'button “Go to”')
  assert.equal(first.source, 'ViewerToolbar.tsx:99')
  assert.equal(second.element, 'switch “ICC profiles”')
  assert.equal(second.source, '')
  assert.equal(first.lastBy, 'igor')
})

test('a hidden block survives text that could close an HTML comment', () => {
  const data = { id: 'x', text: 'arrow --> and a <b>tag</b> and -- dashes' }
  const block = hiddenBlock('note', data)
  assert.equal(block.slice(5, -4).includes('-->'), false)
  assert.deepEqual(readHidden(`visible\n\n${block}`), { kind: 'note', data })
})

test('counts and their wording', () => {
  const counts = countNotes(foldNotes(fixture.comments))
  assert.deepEqual(counts, { open: 2, fix: 0, resolved: 1, total: 3, unresolved: 2 })
  assert.equal(describeCounts(counts), '2 open, 1 resolved')
  assert.equal(describeCounts(countNotes([])), 'No notes')
  assert.equal(describeCounts({ open: 0, fix: 0, resolved: 4, total: 4, unresolved: 0 }), 'All 4 notes are resolved')
  assert.equal(describeCounts({ open: 0, fix: 2, resolved: 1, total: 3, unresolved: 2 }), '2 fix in place, 1 resolved')
})

test('the overview lists unresolved notes first and folds resolved ones away', () => {
  const body = summaryBody(foldNotes(fixture.comments), { previewUrl: 'https://preview.example/' })
  assert.match(body, /^### Preview notes: 2 of 3 unresolved/)
  assert.match(body, /\| \[N1\]\(https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-102\) Go to lands too far out \| button “Go to” · `ViewerToolbar\.tsx:99` \| \*\*Open\*\* \| 3 \| @igor, 2026-11-17 \|/)
  assert.match(body, /<summary>1 resolved<\/summary>/)
  assert.ok(body.indexOf('[N3]') < body.indexOf('<details>'))
  assert.ok(body.indexOf('[N2]') > body.indexOf('<details>'))
  assert.match(body, /\[preview\]\(https:\/\/preview\.example\)/)
  assert.match(body, /For an agent: https:\/\/preview\.example\/__ainotelayer\/agent\.md/)
  assert.deepEqual(readHidden(body), { kind: 'summary', data: { preview: 'https://preview.example' } })
})

test('the overview is not mistaken for a note or a reply', () => {
  const notes = foldNotes(fixture.comments)
  const body = summaryBody(notes, { previewUrl: 'https://preview.example' })
  const again = foldNotes([
    ...fixture.comments,
    { id: 999, user: { login: 'github-actions[bot]' }, created_at: '2026-11-17T11:00:00Z', html_url: 'x', body },
  ])
  assert.deepEqual(
    again.map((note) => [note.status, note.replies]),
    notes.map((note) => [note.status, note.replies]),
  )
})

test('table cells cannot be broken by note text', () => {
  const body = summaryBody([
    { id: 'a', n: 1, kind: 'Change', text: 'pipes | and\nnew lines', element: 'div', source: '', author: 'x', status: 'open', replies: 0, url: 'u', lastAt: '2026-11-17T10:00:00Z', lastBy: 'x' },
  ])
  assert.match(body, /pipes \\\| and new lines/)
  assert.match(body, /^### Preview notes: 1 of 1 unresolved/)
})

test('with nothing to say the overview says so', () => {
  assert.match(summaryBody([]), /^### Preview notes: none yet/)
  assert.match(summaryBody([{ id: 'a', n: 1, text: 't', element: 'div', source: '', status: 'resolved', replies: 1, url: 'u', lastAt: '2026-11-17', lastBy: 'x' }]), /^### Preview notes: the 1 note is resolved/)
})
