/**
 * ainotelayer notes on a pull request, for CI: which notes exist, their
 * status, how active they are, and the overview comment that says so.
 *
 * Reading the comments is done by github-format.js, the same code the browser
 * overlay uses; this module only shapes the result for an overview.
 */
import './github-format.js'

const format = globalThis.ainotelayerFormat

export const { STATUS, hiddenBlock, readHidden } = format

/**
 * The notes of a pull request in number order, from its comments as GitHub's
 * API returns them. `options.trust: 'everyone'` lets any commenter change any
 * note; by default only collaborators and a note's author can.
 */
export function foldNotes(comments, options = {}) {
  const { notes } = format.fold(comments, options)
  return Object.values(notes)
    .sort((a, b) => a.n - b.n)
    .map((note) => {
      const anchor = note.anchor ?? {}
      const source = Array.isArray(anchor.source) ? anchor.source[0] : undefined
      const thread = Object.values(note.messages)
      const last = thread[thread.length - 1]
      return {
        id: note.id,
        n: note.n,
        kind: note.kind ?? 'Change',
        text: thread[0].text,
        element: `${anchor.role ?? anchor.tag ?? 'element'}${anchor.label ? ` “${anchor.label}”` : ''}`,
        source: source === undefined ? '' : `${String(source.file).split('/').pop()}:${source.line}`,
        author: note.author,
        /** False for a note from someone without write access to the repository */
        trusted: note.trusted,
        status: note.status,
        replies: thread.length - 1,
        url: note.commentUrl,
        createdAt: note.createdAt,
        lastAt: last.at,
        lastBy: last.login,
      }
    })
}

/**
 * The overview comment to update, if there is one. Anyone can paste the
 * overview's marker into a comment, so only a bot's or a collaborator's
 * counts: otherwise a stranger could plant the "preview" and "agent" links
 * the overview repeats.
 */
export function findOverview(comments) {
  return comments.find((comment) => {
    if (readHidden(comment.body)?.kind !== 'summary') {
      return false
    }
    const association = comment.author_association
    return (
      comment.user?.type === 'Bot' ||
      association === undefined ||
      ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association)
    )
  })
}

/**
 * Note text is written by whoever can comment, and the overview is posted by
 * a bot people trust. Make the text inert: no HTML, links, images, mentions
 * or table breaks survive.
 */
function inert(text, limit = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const cut = flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
  return cut
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_~[\]()#!|])/g, '\\$1')
    .replace(/@/g, '@​')
    .replace(/:\/\//g, ':​//')
    /** GitHub also links a bare "www." address */
    .replace(/\bwww\./gi, 'www​.')
}

function day(iso) {
  return String(iso ?? '').slice(0, 10)
}

/**
 * How many notes are in each state. Notes from people outside the repository
 * are counted apart (`outside`) and never hold a merge back.
 */
export function countNotes(notes) {
  const counts = { open: 0, fix: 0, resolved: 0, outside: 0 }
  for (const note of notes) {
    if (note.trusted === false) {
      counts.outside += 1
    } else {
      counts[note.status] += 1
    }
  }
  const total = counts.open + counts.fix + counts.resolved
  return { ...counts, total, unresolved: counts.open + counts.fix }
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
    const file = inert(note.source, 60)
    const where = file === '' ? inert(note.element, 60) : `${inert(note.element, 60)} · ${file}`
    const status = note.status === 'resolved' ? STATUS[note.status] : `**${STATUS[note.status]}**`
    return `| [N${note.n}](${note.url}) ${inert(note.text)} | ${where} | ${status} | ${note.replies} | ${inert(note.lastBy, 40)}, ${day(note.lastAt)} |`
  }
  const head = ['| Note | On | Status | Replies | Last activity |', '|---|---|---|---|---|']
  const folded = (title_, rows) => ['<details>', `<summary>${title_}</summary>`, '', ...head, ...rows, '', '</details>', '']
  const counted = notes.filter((note) => note.trusted !== false)
  const unresolved = counted.filter((note) => note.status !== 'resolved')
  const resolved = counted.filter((note) => note.status === 'resolved')
  const outside = notes.filter((note) => note.trusted === false)
  if (unresolved.length > 0) {
    lines.push(...head, ...unresolved.map(row), '')
  }
  if (resolved.length > 0) {
    lines.push(...folded(`${resolved.length} resolved`, resolved.map(row)))
  }
  if (outside.length > 0) {
    lines.push(
      ...folded(
        `${outside.length} from people outside the repository (shown in the preview, not counted here)`,
        outside.map(row),
      ),
    )
  }
  if (preview !== '') {
    lines.push(
      `Right-click anything in the [preview](${preview}) to add a note. To answer one from here, start a comment with its number, for example \`N3: fixed in abc123 [fix in place]\`.`,
      '',
      `For an agent: ${preview}${agentPath}`,
      '',
    )
  } else if (notes.length > 0) {
    lines.push('To answer a note from here, start a comment with its number, for example `N3: fixed in abc123 [fix in place]`.', '')
  }
  lines.push(hiddenBlock('summary', preview === '' ? {} : { preview }))
  return lines.join('\n')
}
