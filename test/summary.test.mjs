/**
 * Checks for reading notes from pull-request comments in CI and for the
 * overview it writes. Run with `npm test`.
 *
 * test/fixtures/pr-comments.json holds the scenarios both readers must agree
 * on; test/github.html checks the browser overlay against the same file.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import {
  countNotes,
  describeCounts,
  findOverview,
  foldNotes,
  hiddenBlock,
  readHidden,
  summaryBody,
} from '../github-notes.mjs'
import { describePullRequest, pickPullRequest } from '../pr-info.mjs'

test('a pull request is described by its head commit and branch, and forks are told apart', () => {
  const own = {
    number: 7,
    state: 'open',
    body: 'dmv-branch: x',
    head: { sha: 'abc', ref: 'feat/x', repo: { full_name: 'o/r' } },
    base: { repo: { full_name: 'o/r' } },
  }
  assert.deepEqual(describePullRequest(own), { number: 7, sha: 'abc', ref: 'feat/x', fork: false, state: 'open', body: 'dmv-branch: x' })
  const forked = { ...own, body: null, head: { ...own.head, repo: { full_name: 'someone/r' } } }
  assert.equal(describePullRequest(forked).fork, true)
  assert.equal(describePullRequest(forked).body, '')
  /** A fork that was deleted leaves no repository behind: still not ours */
  assert.equal(describePullRequest({ ...own, head: { ...own.head, repo: null } }).fork, true)
})

test('a branch stands for its one open pull request, or says why it cannot', () => {
  const first = { number: 7 }
  assert.equal(pickPullRequest([first], 'feat/x'), first)
  assert.throws(() => pickPullRequest([], 'master'), /No open pull request found for branch "master"/)
  assert.throws(() => pickPullRequest([first, { number: 9 }], 'feat/x'), /more than one open pull request \(#7, #9\)/)
})

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pr-comments.json'), 'utf8'),
)
const scenario = (name) => fixture.scenarios.find((item) => item.name.startsWith(name))
const typical = scenario('a typical review')
const strangers = scenario('people outside')

function shape(notes) {
  return notes.map((note) => ({
    n: note.n,
    id: note.id,
    status: note.status,
    replies: note.replies,
    author: note.author,
    ...(note.trusted === false ? { outside: true } : {}),
  }))
}

for (const item of fixture.scenarios) {
  test(`fixture: ${item.name}`, () => {
    assert.deepEqual(shape(foldNotes(item.comments)), item.expect)
  })
}

test('comment order in the API response does not matter', () => {
  const reversed = [...typical.comments].reverse()
  assert.deepEqual(shape(foldNotes(reversed)), typical.expect)
})

test('a note records what it is on and where it comes from', () => {
  const [first, second] = foldNotes(typical.comments)
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

test('with trust: everyone, a stranger can change any note', () => {
  const notes = foldNotes(strangers.comments, { trust: 'everyone' })
  assert.equal(notes[0].status, 'resolved')
  assert.equal(notes[0].element, 'button “Delete”')
  assert.equal(notes[1].trusted, true)
})

test('a stranger cannot move a maintainer\'s note, and is told why', () => {
  const [first] = foldNotes(strangers.comments)
  assert.equal(first.element, 'button “Go to”')
  const again = globalThis.ainotelayerFormat.fold(strangers.comments).notes.aaaa1111
  const said = Object.values(again.messages).map((message) => message.text)
  assert.match(said[1], /^Status: Resolved \(not applied: only collaborators/)
})

test('counts leave strangers\' notes out, and their wording', () => {
  assert.deepEqual(countNotes(foldNotes(typical.comments)), { open: 2, fix: 0, resolved: 1, outside: 0, total: 3, unresolved: 2 })
  assert.deepEqual(countNotes(foldNotes(strangers.comments)), { open: 1, fix: 0, resolved: 0, outside: 1, total: 1, unresolved: 1 })
  assert.equal(describeCounts(countNotes(foldNotes(typical.comments))), '2 open, 1 resolved')
  assert.equal(describeCounts(countNotes([])), 'No notes')
  assert.equal(describeCounts({ open: 0, fix: 0, resolved: 4, total: 4, unresolved: 0 }), 'All 4 notes are resolved')
  assert.equal(describeCounts({ open: 0, fix: 2, resolved: 1, total: 3, unresolved: 2 }), '2 fix in place, 1 resolved')
})

test('the overview lists unresolved notes first and folds resolved ones away', () => {
  const body = summaryBody(foldNotes(typical.comments), { previewUrl: 'https://preview.example/' })
  assert.match(body, /^### Preview notes: 2 of 3 unresolved/)
  assert.ok(body.includes('| [N1](https://github.com/o/r/pull/7#issuecomment-102) Go to lands too far out | button “Go to” · ViewerToolbar.tsx:99 | **Open** | 3 | igor, 2026-11-17 |'), body)
  assert.match(body, /<summary>1 resolved<\/summary>/)
  assert.ok(body.indexOf('[N3]') < body.indexOf('<details>'))
  assert.ok(body.indexOf('[N2]') > body.indexOf('<details>'))
  assert.match(body, /\[preview\]\(https:\/\/preview\.example\)/)
  assert.match(body, /For an agent: https:\/\/preview\.example\/__ainotelayer\/agent\.md/)
  assert.deepEqual(readHidden(body), { kind: 'summary', data: { preview: 'https://preview.example' } })
})

test('the overview lists strangers\' notes apart', () => {
  const body = summaryBody(foldNotes(strangers.comments))
  assert.match(body, /^### Preview notes: 1 of 1 unresolved/)
  assert.match(body, /<summary>1 from people outside the repository/)
  assert.ok(body.indexOf('[N2]') > body.indexOf('outside the repository'))
})

test('the overview is not mistaken for a note or a reply', () => {
  const notes = foldNotes(typical.comments)
  const body = summaryBody(notes, { previewUrl: 'https://preview.example' })
  const again = foldNotes([
    ...typical.comments,
    { id: 999, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-11-17T11:00:00Z', html_url: 'x', body },
  ])
  assert.deepEqual(shape(again), shape(notes))
})

test('only a bot\'s or a collaborator\'s overview comment is ours', () => {
  const planted = strangers.comments.find((comment) => comment.body.includes('evil.example'))
  assert.ok(planted !== undefined)
  assert.equal(findOverview(strangers.comments), undefined)
  const real = typical.comments.find((comment) => comment.user.login === 'github-actions[bot]')
  assert.equal(findOverview([planted, ...typical.comments]), real)
  const byMaintainer = { ...planted, author_association: 'OWNER' }
  assert.equal(findOverview([byMaintainer]), byMaintainer)
})

test('note text cannot break the overview or smuggle in links, mentions or HTML', () => {
  const nasty = '</details> <!-- [Open](https://evil.example) ![x](y) @org/everyone | `code` *bold*\nnew line'
  const body = summaryBody([
    { id: 'a', n: 1, kind: 'Change', text: nasty, element: 'div <b>', source: 'a`b.tsx:1', author: 'x', trusted: true, status: 'open', replies: 0, url: 'u', lastAt: '2026-11-17T10:00:00Z', lastBy: 'x' },
  ])
  const row = body.split('\n').find((line) => line.startsWith('| [N1]'))
  assert.equal(row.includes('</details>'), false)
  assert.equal(row.includes('<!--'), false)
  assert.equal(row.includes('<b>'), false)
  assert.equal(/(?<!\\)\[Open\]\(/.test(row), false)
  assert.equal(row.includes('://evil'), false)
  assert.equal(row.includes('@org'), false)
  assert.equal(/(?<!\\)\|/.test(row.slice(1, -1).replace(/ \| /g, '')), false)
  assert.equal(row.includes('\n'), false)
  /** Seven cell borders: nothing in the text added or removed a column */
  assert.equal(row.split(/(?<!\\)\|/).length, 7)
})

test('with nothing to say the overview says so', () => {
  assert.match(summaryBody([]), /^### Preview notes: none yet/)
  assert.match(
    summaryBody([{ id: 'a', n: 1, text: 't', element: 'div', source: '', trusted: true, status: 'resolved', replies: 1, url: 'u', lastAt: '2026-11-17', lastBy: 'x' }]),
    /^### Preview notes: the 1 note is resolved/,
  )
})
