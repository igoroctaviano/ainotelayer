/**
 * ainotelayer: how notes are written to, and read back from, the comments of a
 * pull request.
 *
 * This is the only implementation of that format. The browser overlay and the
 * CI overview both use it, so they cannot disagree about a note.
 *
 * - A note is one comment: a readable summary, and the note's data in a hidden
 *   block (`<!-- ainotelayer:note {json} -->`).
 * - A reply, a status change or a re-attach is one more comment that starts
 *   with the note's number: `N3: fixed in abc123 [fix in place]`. The overlay
 *   adds a hidden block naming the note; a person or an agent just types it.
 * - Nothing is edited. The notes are rebuilt from the comments, oldest first.
 *
 * It is a plain script on purpose: the page loads it in front of overlay.js
 * (the server and the injector join the two files), and Node imports it for
 * its side effect. Either way the functions end up on
 * `globalThis.ainotelayerFormat`.
 */
;(() => {
  const STATUS = { open: 'Open', fix: 'Fix in place', resolved: 'Resolved' }
  const STATUS_TAG = { open: '[open]', fix: '[fix in place]', resolved: '[resolved]' }
  /** GitHub's own word for how a commenter relates to the repository */
  const COLLABORATORS = ['OWNER', 'MEMBER', 'COLLABORATOR']
  const HIDDEN = /<!-- ainotelayer:(note|event|summary) ([\s\S]*?) -->/
  const TAG_WORDS = 'open|fix in place|fix|fixed|resolved'

  /** JSON inside an HTML comment: it must never contain the closing `-->` */
  function hiddenBlock(kind, data) {
    const json = JSON.stringify(data).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e')
    return `<!-- ainotelayer:${kind} ${json} -->`
  }

  function readHidden(body) {
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

  /** The database-style stores hand lists back as keyed objects; accept both */
  function list(value) {
    if (Array.isArray(value)) {
      return value.filter((item) => item != null)
    }
    return value !== null && typeof value === 'object' ? Object.values(value) : []
  }

  /**
   * A note's id is used as a key and as part of a path, and it comes from a
   * comment anyone may have written. Only plain ids count, and none that
   * means something to an object.
   */
  function isId(value) {
    return typeof value === 'string' && /^[\w-]{1,64}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
  }

  /** A note's picture is drawn by the overlay: an image as a data URL, never an address to fetch */
  function isShot(value) {
    return typeof value === 'string' && value.startsWith('data:image/')
  }

  function isStatus(value) {
    return typeof value === 'string' && Object.hasOwn(STATUS, value)
  }

  function statusOf(word) {
    if (word === 'open') {
      return 'open'
    }
    return word === 'resolved' ? 'resolved' : 'fix'
  }

  /**
   * Someone with write access to the repository. Only they, and a note's own
   * author, may change a note's status or where it points; otherwise anyone
   * able to comment on a public pull request could resolve other people's
   * notes. Stores that do not say (a local test server) are taken at their word.
   */
  function isCollaborator(comment) {
    const association = comment.author_association
    return association === undefined || COLLABORATORS.includes(association)
  }

  /** What people see on GitHub for a note, with the note's data hidden below it */
  function noteBody(note, number) {
    const anchor = note.anchor ?? {}
    const name = anchor.label ? ` “${anchor.label}”` : ''
    const first = list(anchor.source)[0]
    const from = first === undefined ? '' : ` · \`${String(first.file).split('/').pop()}:${first.line}\``
    const quoted = String(note.text ?? '').split('\n').map((line) => `> ${line}`).join('\n')
    const url = String(note.url ?? '')
    const link = url === '' ? '' : `[Open in the preview](${url}${url.includes('#') ? '' : `#ainote=${note.id}`})`
    const build = note.sha ? ` · build \`${note.sha}\`` : ''
    return [
      `**Note N${number}** · ${note.kind} · ${anchor.role ?? anchor.tag ?? 'element'}${name}${from}`,
      '',
      quoted,
      '',
      `${link}${build}`,
      '',
      hiddenBlock('note', { ...note, n: number }),
    ].join('\n')
  }

  /** A reply, a status change or a re-attach: one line a person could also type by hand */
  function eventBody(number, text, data) {
    const tag = isStatus(data.status) ? ` ${STATUS_TAG[data.status]}` : ''
    return `N${number}: ${text}${tag}\n\n${hiddenBlock('event', data)}`
  }

  /**
   * Tags in a hand-typed reply. They count only at the very start
   * (`N3: [agent] [fix in place] …`) or the very end (`… [resolved]`), and
   * never as the text of a Markdown link, so a sentence that happens to
   * contain "[fixed](https://…)" changes nothing.
   */
  function readTags(text) {
    let rest = text
    let status
    let agent = false
    for (;;) {
      const lead = new RegExp(`^\\[(agent|${TAG_WORDS})\\](?!\\()\\s*`, 'i').exec(rest)
      if (lead === null) {
        break
      }
      const word = lead[1].toLowerCase()
      if (word === 'agent') {
        agent = true
      } else {
        status = statusOf(word)
      }
      rest = rest.slice(lead[0].length)
    }
    const tail = new RegExp(`\\s*\\[(${TAG_WORDS})\\]\\s*$`, 'i').exec(rest)
    if (tail !== null) {
      status = statusOf(tail[1].toLowerCase())
      rest = rest.slice(0, tail.index)
    }
    return { text: rest.trim(), status, agent }
  }

  /**
   * Give every note its number. A note keeps the number it was created with,
   * so deleting an earlier note does not shift the later ones and "N3:" keeps
   * meaning the same note. Notes from before numbers were stored take the
   * lowest free numbers in order; if two notes claim one number (created at
   * the same moment), the later one moves past the highest. A collaborator's
   * note is served first, so someone outside the repository cannot take a
   * number away from it.
   */
  function numberNotes(found) {
    const taken = new Set()
    let highest = 0
    const stored = (item) => (Number.isInteger(item.data.n) && item.data.n > 0 ? item.data.n : undefined)
    for (const item of found) {
      highest = Math.max(highest, stored(item) ?? 0)
    }
    const collaboratorsFirst = [...found].sort((a, b) => Number(b.trusted) - Number(a.trusted))
    for (const item of collaboratorsFirst) {
      const number = stored(item)
      if (number !== undefined && !taken.has(number)) {
        item.n = number
        taken.add(number)
      }
    }
    let free = 1
    for (const item of found) {
      if (item.n !== undefined) {
        continue
      }
      if (stored(item) === undefined) {
        while (taken.has(free)) {
          free += 1
        }
        item.n = free
      } else {
        highest += 1
        item.n = highest
      }
      taken.add(item.n)
      highest = Math.max(highest, item.n)
    }
  }

  /**
   * Rebuild the notes from a pull request's comments, as GitHub's API returns
   * them. Comments that are neither a note nor addressed to one are ignored.
   *
   * Returns `{ notes, shots }`, both keyed by note id. Pass
   * `{ trust: 'everyone' }` to let any commenter change any note.
   */
  function fold(comments, options = {}) {
    const everyone = options.trust === 'everyone'
    const ordered = [...comments].sort(
      (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id,
    )
    /**
     * One comment per note id. The oldest comment that claims an id has it,
     * except that a collaborator's comment wins over one from outside the
     * repository: an old comment can be edited into a note later, and that
     * must not replace a collaborator's note or take it out of the count.
     */
    const claims = new Map()
    ordered.forEach((comment, index) => {
      const hidden = readHidden(comment.body)
      const id = hidden !== null && hidden.kind === 'note' ? hidden.data?.id : undefined
      if (!isId(id)) {
        return
      }
      const claim = { comment, index, data: hidden.data, trusted: everyone || isCollaborator(comment) }
      const held = claims.get(id)
      if (held === undefined || (claim.trusted && !held.trusted)) {
        claims.set(id, claim)
      }
    })
    const found = [...claims.values()].sort((a, b) => a.index - b.index)
    numberNotes(found)

    const notes = {}
    const shots = {}
    const byNumber = new Map()
    for (const { comment, index, data, n, trusted } of found) {
      const { shot, text, by, n: unused, ...fields } = data
      const login = comment.user?.login ?? 'someone'
      if (isShot(shot)) {
        shots[fields.id] = shot
      }
      byNumber.set(n, fields.id)
      notes[fields.id] = {
        ...fields,
        n,
        status: 'open',
        createdAt: comment.created_at,
        hasShot: isShot(shot),
        commentId: comment.id,
        commentUrl: comment.html_url,
        author: login,
        /** False for a note from someone without write access to the repository */
        trusted,
        position: index,
        messages: {
          first: {
            author: by ? `${by} (via @${login})` : `@${login}`,
            login,
            text: String(text ?? ''),
            at: comment.created_at,
          },
        },
      }
    }

    ordered.forEach((comment, index) => {
      const hidden = readHidden(comment.body)
      if (hidden !== null && hidden.kind !== 'event') {
        return
      }
      const data = hidden === null ? null : (hidden.data ?? {})
      const visible = String(comment.body ?? '').replace(/<!-- ainotelayer:[\s\S]*?-->/g, '').trim()
      const addressed = /^N(\d+)\b\s*[:\-–—]?\s*/.exec(visible)
      const id = data?.note ?? (addressed === null ? undefined : byNumber.get(Number(addressed[1])))
      const note = typeof id === 'string' ? notes[id] : undefined
      /** A comment cannot answer a note that did not exist yet */
      if (note === undefined || index < note.position) {
        return
      }
      const login = comment.user?.login ?? 'someone'
      let text = addressed === null ? visible : visible.slice(addressed[0].length)
      let status
      let agent
      if (data !== null) {
        /** Written by the overlay: the hidden block says what it is, the text is only text */
        status = isStatus(data.status) ? data.status : undefined
        agent = data.agent === true
        if (status !== undefined && text.endsWith(STATUS_TAG[status])) {
          text = text.slice(0, -STATUS_TAG[status].length)
        }
        text = text.trim()
      } else {
        ;({ text, status, agent } = readTags(text))
      }
      const allowed = everyone || isCollaborator(comment) || login === note.author
      const wanted = status !== undefined || data?.anchor !== undefined || data?.resolution !== undefined
      if (allowed) {
        if (status !== undefined) {
          note.status = status
        }
        if (data?.resolution !== undefined) {
          note.resolution = String(data.resolution)
        }
        if (data?.anchor !== null && typeof data?.anchor === 'object') {
          const old = note.anchor ?? {}
          note.anchorHistory = [
            ...list(note.anchorHistory),
            { xpath: old.xpath, selector: old.selector, label: old.label, replacedAt: comment.created_at },
          ].slice(-5)
          note.anchor = data.anchor
        }
      }
      if (text === '' && status !== undefined) {
        text = `Status: ${STATUS[status]}`
      }
      if (wanted && !allowed) {
        text = `${text} (not applied: only collaborators and the note's author can change a note)`.trim()
      }
      if (text !== '') {
        note.messages[`c${comment.id}`] = {
          author: data?.by ? `${data.by} (via @${login})` : `@${login}`,
          login,
          text,
          at: comment.created_at,
          ...(agent ? { agent: true } : {}),
        }
      }
    })
    for (const note of Object.values(notes)) {
      delete note.position
    }
    return { notes, shots }
  }

  globalThis.ainotelayerFormat = { STATUS, STATUS_TAG, hiddenBlock, readHidden, isId, isShot, isStatus, noteBody, eventBody, fold }
})()
