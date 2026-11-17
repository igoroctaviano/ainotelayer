/**
 * ainotelayer notes on a pull request, read outside the browser.
 *
 * In GitHub mode every note is a comment on the pull request, and a reply, a
 * status change or a re-attach is one more comment that starts with the note's
 * number (`N3: fixed in abc123 [fix in place]`). overlay.js rebuilds the notes
 * from those comments in the browser; this module does the same for CI, where
 * only the overview matters: which notes exist, their status, and how active
 * they are.
 *
 * The two must agree. test/fixtures/pr-comments.json is checked against both
 * (test/summary.test.mjs here, test/github.html for the overlay).
 */

export const STATUS = { open: 'Open', fix: 'Fix in place', resolved: 'Resolved' }

const HIDDEN = /<!-- ainotelayer:(note|event|summary) ([\s\S]*?) -->/

/** JSON inside an HTML comment: it must never contain the closing `-->` */
export function hiddenBlock(kind, data) {
  const json = JSON.stringify(data).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e')
  return `<!-- ainotelayer:${kind} ${json} -->`
}

export function readHidden(body) {
  const found = HIDDEN.exec(body ?? '')
  if (found === null) {
    return null
  }
  try {
    return { kind: found[1], data: JSON.parse(found[2]) }
  } catch {
    return null
  }
}

/**
 * The notes of a pull request, oldest first, from its comments as GitHub's
 * API returns them. Comments that are neither a note nor addressed to one are
 * ignored.
 */
export function foldNotes(comments) {
  const ordered = [...comments].sort(
    (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id,
  )
  const notes = []
  const byId = new Map()
  for (const comment of ordered) {
    const hidden = readHidden(comment.body)
    const login = comment.user?.login ?? 'someone'
    if (hidden !== null && hidden.kind === 'summary') {
      continue
    }
    if (hidden !== null && hidden.kind === 'note' && hidden.data?.id) {
      const data = hidden.data
      const anchor = data.anchor ?? {}
      const source = Array.isArray(anchor.source) ? anchor.source[0] : undefined
      const note = {
        id: data.id,
        n: notes.length + 1,
        kind: data.kind ?? 'Change',
        text: String(data.text ?? ''),
        element: `${anchor.role ?? anchor.tag ?? 'element'}${anchor.label ? ` “${anchor.label}”` : ''}`,
        source: source === undefined ? '' : `${String(source.file).split('/').pop()}:${source.line}`,
        author: login,
        status: 'open',
        replies: 0,
        url: comment.html_url,
        createdAt: comment.created_at,
        lastAt: comment.created_at,
        lastBy: login,
      }
      notes.push(note)
      byId.set(note.id, note)
      continue
    }
    const visible = String(comment.body ?? '').replace(/<!-- ainotelayer:[\s\S]*?-->/g, '').trim()
    const addressed = /^N(\d+)\b\s*[:\-–—]?\s*/.exec(visible)
    const data = hidden !== null && hidden.kind === 'event' ? hidden.data : {}
    const id = data.note ?? (addressed === null ? undefined : notes[Number(addressed[1]) - 1]?.id)
    const note = id === undefined ? undefined : byId.get(id)
    if (note === undefined) {
      continue
    }
    let text = addressed === null ? visible : visible.slice(addressed[0].length)
    let status = data.status
    const tagged = /\[(open|fix in place|fix|fixed|resolved)\]/i.exec(text)
    if (tagged !== null) {
      const word = tagged[1].toLowerCase()
      status = status ?? (word === 'open' ? 'open' : word === 'resolved' ? 'resolved' : 'fix')
      text = text.replace(tagged[0], '').trim()
    }
    text = text.replace(/\[agent\]/gi, '').trim()
    const valid = typeof status === 'string' && Object.hasOwn(STATUS, status)
    if (valid) {
      note.status = status
    }
    if (text !== '' || valid) {
      note.replies += 1
      note.lastAt = comment.created_at
      note.lastBy = login
    }
  }
  return notes
}

function cell(text, limit = 90) {
  const flat = String(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function day(iso) {
  return String(iso ?? '').slice(0, 10)
}

export function countNotes(notes) {
  const counts = { open: 0, fix: 0, resolved: 0 }
  for (const note of notes) {
    counts[note.status] += 1
  }
  return { ...counts, total: notes.length, unresolved: counts.open + counts.fix }
}

/** "2 open, 1 fix in place, 4 resolved", leaving out what there is none of */
export function describeCounts(counts) {
  if (counts.total === 0) {
    return 'No notes'
  }
  if (counts.unresolved === 0) {
    return counts.total === 1 ? 'The 1 note is resolved' : `All ${counts.total} notes are resolved`
  }
  const parts = []
  if (counts.open > 0) {
    parts.push(`${counts.open} open`)
  }
  if (counts.fix > 0) {
    parts.push(`${counts.fix} fix in place`)
  }
  if (counts.resolved > 0) {
    parts.push(`${counts.resolved} resolved`)
  }
  return parts.join(', ')
}

/**
 * The one comment that gives the overview of a pull request's notes. It is
 * updated in place; its hidden block remembers the preview link between runs
 * that do not know it.
 */
export function summaryBody(notes, options = {}) {
  const counts = countNotes(notes)
  const preview = String(options.previewUrl ?? '').replace(/\/$/, '')
  const agentPath = options.agentPath ?? '/__ainotelayer/agent.md'
  let title = 'none yet'
  if (counts.total > 0) {
    title = counts.unresolved === 0 ? describeCounts(counts).toLowerCase() : `${counts.unresolved} of ${counts.total} unresolved`
  }
  const lines = [`### Preview notes: ${title}`, '']
  const row = (note) => {
    const where = note.source === '' ? note.element : `${note.element} · \`${note.source}\``
    const status = note.status === 'resolved' ? STATUS[note.status] : `**${STATUS[note.status]}**`
    return `| [N${note.n}](${note.url}) ${cell(note.text)} | ${cell(where, 60)} | ${status} | ${note.replies} | @${note.lastBy}, ${day(note.lastAt)} |`
  }
  const head = ['| Note | On | Status | Replies | Last activity |', '|---|---|---|---|---|']
  const unresolved = notes.filter((note) => note.status !== 'resolved')
  const resolved = notes.filter((note) => note.status === 'resolved')
  if (unresolved.length > 0) {
    lines.push(...head, ...unresolved.map(row), '')
  }
  if (resolved.length > 0) {
    lines.push('<details>', `<summary>${resolved.length} resolved</summary>`, '', ...head, ...resolved.map(row), '', '</details>', '')
  }
  if (preview !== '') {
    lines.push(
      `Right-click anything in the [preview](${preview}) to add a note. To answer one from here, start a comment with its number, for example \`N3: fixed in abc123 [fix in place]\`.`,
      '',
      `For an agent: ${preview}${agentPath}`,
      '',
    )
  } else if (counts.total > 0) {
    lines.push('To answer a note from here, start a comment with its number, for example `N3: fixed in abc123 [fix in place]`.', '')
  }
  lines.push(hiddenBlock('summary', preview === '' ? {} : { preview }))
  return lines.join('\n')
}
