/**
 * ainotelayer overlay.
 *
 * Injected by server.mjs into the app under review. Right-click anything to pin
 * a note to it. Each note stores where the element lives (XPath, selector, React
 * component chain), what it sits inside at runtime (dialog, menu, tab panel and
 * the control that opened it) and the user's steps leading up to the note, so a
 * person or an agent can find the element and get the app back into that state.
 *
 * Shift+right-click keeps the browser's own context menu.
 */
;(() => {
  if (window.ainotelayer !== undefined) {
    return
  }

  /**
   * Where notes live is set on the script tag. With data-db they are shared:
   * a Firebase Realtime Database, or the local server, which speaks the same
   * REST dialect. Without it they stay in this browser's localStorage, so the
   * layer works with nothing set up; download and import move them around.
   * data-review names the review; data-meta carries the build info.
   *
   * With data-github ("owner/name") and data-pr the notes are comments on that
   * pull request instead: no database, readable without sign-in on a public
   * repository, written with the reviewer's own GitHub account.
   */
  const tag = document.currentScript
  const SHARED = Boolean(tag?.dataset.db)
  const GH_REPO = tag?.dataset.github ?? ''
  const GH_PR = tag?.dataset.pr ?? ''
  const GH_API = (tag?.dataset.githubApi ?? 'https://api.github.com').replace(/\/$/, '')
  /** How notes are written to and read from comments: github-format.js, loaded in front of this file */
  const FORMAT = globalThis.ainotelayerFormat
  const GITHUB = !SHARED && GH_REPO !== '' && GH_PR !== '' && FORMAT !== undefined
  const GH_TOKEN = 'ainotelayer-gh-token'
  const GH_LOGIN = 'ainotelayer-gh-login'
  const [DB, DB_QUERY] = (tag?.dataset.db ?? '').split('?')
  const REVIEW = tag?.dataset.review ?? 'default'
  const LOCAL_KEY = `ainotelayer:${REVIEW}`
  let tagMeta = {}
  try {
    tagMeta = JSON.parse(tag?.dataset.meta ?? '{}') ?? {}
  } catch {
    tagMeta = {}
  }

  /** The database URL may carry a query; the Firebase emulator needs `?ns=<name>` */
  function urlOf(pathname) {
    const suffix = DB_QUERY ? `?${DB_QUERY}` : ''
    return `${DB.replace(/\/$/, '')}/reviews/${encodeURIComponent(REVIEW)}/${pathname}.json${suffix}`
  }
  const WHO = 'ainotelayer-author'
  const OPEN = 'ainotelayer-open'
  const FLOAT = 'ainotelayer-float'
  const STATUS = {
    open: ['Open', '#6ea8fe'],
    fix: ['Fix in place', '#f2c94c'],
    resolved: ['Resolved', '#4cc38a'],
  }
  const KINDS = ['Change', 'Bug', 'Question', 'Research']
  /** Attributes written by the build plugin (stamp.mjs) */
  const SRC = 'data-anl-src'
  const USE = 'data-anl-use'
  const MEANINGFUL =
    'button,a,input,select,textarea,label,summary,canvas,[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="switch"],[role="checkbox"],[role="option"],[role="slider"]'
  const CONTAINER =
    '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tabpanel"],[role="tooltip"],[data-radix-popper-content-wrapper],[data-state="open"],details[open]'
  const PLUMBING =
    /^(_|Primitive|Slot|Presence|Portal|FocusScope|DismissableLayer|Popper|Router|Routes|Route|Outlet|Render|Collection|Roving|Anonymous)|(Provider|Context|Impl|Boundary)$/

  const state = {
    notes: [],
    meta: tagMeta,
    trail: [],
    filter: 'all',
    panelOpen: false,
  }
  window.ainotelayer = state

  let card = null
  let composer = null
  let panel = null
  let picking = null
  let lastSlow = 0
  const pins = new Map()

  /** DOM helper: attributes, `on…` listeners and children in one call */
  function h(tag, props = {}, ...kids) {
    const element = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') {
        element.className = value
      } else if (key === 'style') {
        element.style.cssText = value
      } else if (key.startsWith('on')) {
        element.addEventListener(key.slice(2), value)
      } else if (value === true) {
        element.setAttribute(key, '')
      } else if (value !== false && value != null) {
        element.setAttribute(key, value)
      }
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) {
        element.append(kid)
      }
    }
    return element
  }

  const host = document.createElement('div')
  host.setAttribute('data-ainotelayer', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none'
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .pins, .ui { position: fixed; inset: 0; pointer-events: none; }
    .pin { position: absolute; left: 0; top: 0; width: 22px; height: 22px; margin-top: -22px; border-radius: 50% 50% 50% 3px;
      background: var(--c); color: #0b0d10; font-size: 11px; font-weight: 700; line-height: 22px; text-align: center;
      opacity: .3; cursor: pointer; pointer-events: auto; user-select: none;
      box-shadow: 0 0 0 2px #0b0d10, 0 2px 8px rgba(0,0,0,.5); transition: opacity .15s, scale .15s; transform-origin: 0 100%; }
    .pin:hover { opacity: .9; }
    .pin.active { opacity: 1; scale: 1.2; }
    .hl { position: fixed; display: none; pointer-events: none; border: 2px solid var(--c); border-radius: 6px;
      background: color-mix(in srgb, var(--c) 16%, transparent); }
    .hl.big { background: none; }
    .lead { position: fixed; display: none; height: 2px; border-radius: 1px; pointer-events: none;
      background: var(--c); box-shadow: 0 0 0 1px #0b0d10; transform-origin: 0 50%; }
    .spot { position: fixed; display: none; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
      pointer-events: none; border: 2px solid var(--c); box-shadow: 0 0 0 1px #0b0d10, inset 0 0 0 1px #0b0d10; }
    .spot::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px;
      border-radius: 50%; background: var(--c); box-shadow: 0 0 0 1px #0b0d10; }
    .card { position: fixed; width: 330px; max-height: min(72vh, 580px); overflow: auto; pointer-events: auto;
      background: #14171c; color: #e8eaed; border: 1px solid #2c313a; border-top: 3px solid var(--c, #6ea8fe);
      border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,.6); font-size: 13px; line-height: 1.45; padding: 10px 12px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .head b { font-size: 13px; }
    .tag { font-size: 11px; color: #9aa4b2; border: 1px solid #2c313a; border-radius: 999px; padding: 1px 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .grow { flex: 1; }
    .where { color: #9aa4b2; font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
    .where strong { color: #c9d1dc; font-weight: 600; }
    .msg { padding: 6px 0; border-top: 1px solid #22262d; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg .by { font-weight: 700; margin-right: 6px; }
    .msg.agent .by { color: #c4a7ff; }
    .msg time { float: right; color: #6b7480; font-size: 11px; }
    textarea, input[type="text"], input[type="password"], select { width: 100%; background: #0d0f13; color: #e8eaed; border: 1px solid #2c313a; border-radius: 6px;
      padding: 6px 8px; font-size: 13px; }
    textarea { resize: vertical; min-height: 54px; }
    textarea:focus, input:focus, select:focus, button:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 1px; }
    select { width: auto; padding: 2px 6px; font-size: 12px; }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    button { background: #22262d; color: #e8eaed; border: 1px solid #2c313a; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
    button:hover { background: #2b3038; }
    button.primary { background: #6ea8fe; border-color: #6ea8fe; color: #0b0d10; font-weight: 700; }
    button.x { border: 0; background: none; font-size: 18px; line-height: 1; padding: 0 4px; color: #9aa4b2; }
    button.link { border: 0; background: none; padding: 0; color: #9aa4b2; text-decoration: underline; }
    .chips { display: flex; gap: 6px; margin-bottom: 8px; }
    .chip { border-radius: 999px; padding: 2px 10px; }
    .chip.on { background: #e8eaed; color: #0b0d10; border-color: #e8eaed; font-weight: 700; }
    .who { width: 84px !important; }
    .check { display: flex; align-items: center; gap: 6px; color: #9aa4b2; font-size: 12px; margin-top: 8px; }
    details { margin-top: 8px; color: #9aa4b2; font-size: 12px; }
    summary { cursor: pointer; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d1dc;
      background: #0d0f13; border: 1px solid #22262d; border-radius: 6px; padding: 8px; margin: 6px 0 0; }
    .foot { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; }
    .shot { display: none; width: 100%; max-height: 130px; object-fit: cover; border-radius: 6px; border: 1px solid #22262d; margin-bottom: 6px; cursor: zoom-in; }
    .shot.on { display: block; }
    .shot.full { max-height: none; cursor: zoom-out; }
    .float { position: fixed; pointer-events: auto; }
    .dock { border-radius: 999px; padding: 6px 12px; background: #14171c; box-shadow: 0 6px 18px rgba(0,0,0,.5);
      opacity: .55; transition: opacity .15s; cursor: grab; touch-action: none; white-space: nowrap; }
    .float:hover .dock, .float.open .dock { opacity: 1; }
    .panel { position: absolute; left: 0; bottom: calc(100% + 8px); width: 360px; display: flex; flex-direction: column; overflow: hidden; }
    .float.below .panel { bottom: auto; top: calc(100% + 8px); }
    .float.leftward .panel { left: auto; right: 0; }
    .panel .head { cursor: grab; touch-action: none; }
    .panel .chips { flex-wrap: wrap; margin-bottom: 2px; }
    .list { overflow: auto; min-height: 0; }
    .group { margin-top: 10px; color: #9aa4b2; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .group.path { text-transform: none; letter-spacing: 0; font-weight: 600; }
    .item.on { border-color: #6ea8fe; }
    .connect { left: 50%; top: 14%; translate: -50% 0; width: 400px; }
    .foot a { color: #9aa4b2; }
    .pin.moved { outline: 2px dashed #f2c94c; outline-offset: 2px; }
    .where a { color: #9ecbff; }
    .warn { color: #f2c94c !important; }
    .banner { position: fixed; top: 12px; left: 50%; translate: -50% 0; pointer-events: none; background: #f2c94c; color: #0b0d10;
      font-size: 13px; font-weight: 700; padding: 8px 14px; border-radius: 999px; box-shadow: 0 6px 18px rgba(0,0,0,.5); }
    .hint { color: #f2c94c; font-size: 12px; margin-bottom: 8px; }
    .banner.quiet { background: #14171c; color: #e8eaed; border: 1px solid #2c313a; font-weight: 600; }
    .hl.pulse, .pin.pulse, .card.pulse { animation: pulse .8s ease-out 3; }
    @keyframes pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 75%, transparent); } to { box-shadow: 0 0 0 20px transparent; } }
    .item { display: grid; grid-template-columns: 10px 1fr; gap: 2px 8px; width: 100%; text-align: left; margin-top: 6px; padding: 7px 8px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; }
    .item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item .m { grid-column: 2; color: #9aa4b2; font-size: 11px; }
    .empty { color: #9aa4b2; padding: 8px 0; }
  `
  const highlight = h('div', { class: 'hl' })
  const lead = h('div', { class: 'lead' })
  const spot = h('div', { class: 'spot' })
  const pinLayer = h('div', { class: 'pins' })
  const ui = h('div', { class: 'ui' })
  /** The floating notes list: a pill that opens the list; drag either to move it */
  let floatAt = null
  let dragged = false
  let pulseUntil = 0
  /** The note whose element is being waited for, so its card can say so */
  let seeking = null
  const dock = h(
    'button',
    {
      class: 'dock',
      title: 'All notes for this app. Drag to move.',
      onclick: () => {
        if (!dragged) {
          togglePanel()
        }
      },
    },
    'Notes',
  )
  const floater = h('div', { class: 'float' }, dock)
  const banner = h(
    'div',
    { class: 'banner', style: 'display:none' },
    'Click the element this note belongs to. Esc cancels.',
  )
  /** A short message about a note that was asked for, such as one a link names */
  const notice = h('div', { class: 'banner quiet', style: 'display:none' })
  let noticeTimer = 0
  function say(text, forMs = 0) {
    clearTimeout(noticeTimer)
    notice.textContent = text
    notice.style.display = text === '' ? 'none' : ''
    if (text !== '' && forMs > 0) {
      noticeTimer = setTimeout(() => say(''), forMs)
    }
  }
  ui.append(floater, banner, notice)
  root.append(style, highlight, lead, spot, pinLayer, ui)

  /**
   * Keep the overlay's own events away from the app: its shortcuts, and the
   * "clicked or focused outside" handlers that would close the very menu or
   * dialog a note is being written about.
   */
  for (const type of [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
    'keydown', 'keyup', 'keypress', 'wheel', 'input', 'change',
  ]) {
    host.addEventListener(type, (event) => event.stopPropagation())
  }

  /**
   * A modal dialog in the app usually keeps the keyboard inside itself: the
   * moment focus leaves for anything else it takes it back, and nothing could
   * be typed in a note written over the dialog. So the app is not told when
   * focus moves into the overlay or around inside it. The listeners are on
   * the window, ahead of any the app has on the document. Whatever had focus
   * gets it back when the note or composer closes.
   */
  let focusBefore = null
  for (const type of ['focusin', 'focusout']) {
    window.addEventListener(type, (event) => {
      if (isOurs(event)) {
        event.stopImmediatePropagation()
      } else if (type === 'focusout' && event.relatedTarget === host) {
        focusBefore = event.target
        event.stopImmediatePropagation()
      } else if (type === 'focusin') {
        focusBefore = null
      }
    }, true)
  }

  function handFocusBack(node) {
    const active = root.activeElement
    if (active !== null && node.contains(active) && focusBefore instanceof HTMLElement && focusBefore.isConnected) {
      focusBefore.focus({ preventScroll: true })
    }
  }
  document.documentElement.append(host)

  function isOurs(event) {
    return event.composedPath().includes(host)
  }

  function storage(key, value) {
    try {
      if (value === undefined) {
        return localStorage.getItem(key) ?? ''
      }
      localStorage.setItem(key, value)
    } catch {
      /** Storage can be blocked; the overlay works without it */
    }
    return value ?? ''
  }

  /** No content-type header: that keeps cross-origin writes free of a preflight */
  async function rest(pathname, method = 'GET', body) {
    if (GITHUB) {
      return githubRest(pathname, method, body)
    }
    if (!SHARED) {
      return localRest(pathname, method, body)
    }
    const response = await fetch(urlOf(pathname), {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`${method} ${pathname}: ${response.status}`)
    }
    return response.json()
  }

  /** --- Notes kept in a GitHub pull request ------------------------------- */

  /**
   * In GitHub mode every note is a comment on the pull request. Nothing is
   * ever edited: a reply, a status change or a re-attach is one more comment,
   * and the notes are rebuilt from the comments in order. That needs no
   * database, works with GitHub's rule that people only edit their own
   * comments, and lets people and agents answer from GitHub itself by starting
   * a comment with the note's number: `N3: fixed in abc123 [fix in place]`.
   */
  const gh = {
    comments: new Map(),
    loaded: false,
    polledAt: 0,
    polls: 0,
    since: '',
    problem: '',
    /** Something the reviewer should know that is not a failed load, such as a rejected token */
    notice: '',
    login: '',
    health: {},
    version: 0,
    folded: null,
  }

  function ghToken() {
    try {
      return sessionStorage.getItem(GH_TOKEN) || localStorage.getItem(GH_TOKEN) || ''
    } catch {
      return ''
    }
  }

  function ghForget() {
    try {
      sessionStorage.removeItem(GH_TOKEN)
      localStorage.removeItem(GH_TOKEN)
      localStorage.removeItem(GH_LOGIN)
    } catch {
      /** Nothing was stored */
    }
    gh.login = ''
  }

  async function ghFetch(pathname, options = {}) {
    const token = ghToken()
    const headers = { Accept: 'application/vnd.github+json' }
    if (token !== '') {
      headers.Authorization = `Bearer ${token}`
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${GH_API}${pathname}`, {
      method: options.method ?? 'GET',
      headers,
      /**
       * GitHub lets browsers reuse an answer for 60 seconds. A page opened
       * right after a note was added would then get the list from before it,
       * so always ask GitHub (it answers "unchanged" cheaply when nothing is new).
       */
      cache: 'no-cache',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    if (response.status === 401 && token !== '') {
      /**
       * The saved token was rejected, most likely expired. Drop it: reading
       * goes on without sign-in, and writing asks to connect again.
       */
      ghForget()
      gh.notice = 'GitHub no longer accepts the saved token (it may have expired). Connect again to add notes.'
      if ((options.method ?? 'GET') === 'GET') {
        return ghFetch(pathname, options)
      }
      openConnect()
      const error = new Error(gh.notice)
      error.connect = true
      throw error
    }
    if (!response.ok) {
      const spent = response.headers.get('x-ratelimit-remaining') === '0'
      let problem = `GitHub answered ${response.status}.`
      if (spent) {
        problem = token === ''
          ? "GitHub's hourly allowance for reading without sign-in is used up. Connect GitHub to keep going."
          : "GitHub's hourly allowance is used up. Try again later."
      } else if (response.status === 404) {
        problem = token === ''
          ? 'This pull request was not found. If the repository is private, connect GitHub.'
          : 'This pull request was not found, or the token cannot see it.'
      } else if (response.status === 403) {
        problem = 'GitHub refused: the token is not allowed to do this here.'
      }
      const error = new Error(problem)
      error.status = response.status
      throw error
    }
    return response.status === 204 ? null : response.json()
  }

  /** Something about the comments changed: the notes need rebuilding */
  function ghChanged() {
    gh.version += 1
  }

  /**
   * The notes as the pull request's comments describe them. Rebuilding parses
   * every comment, so the result is kept until the comments change.
   */
  function ghFold() {
    if (gh.folded === null || gh.folded.version !== gh.version) {
      const value = FORMAT.fold([...gh.comments.values()])
      for (const [id, health] of Object.entries(gh.health)) {
        if (value.notes[id] !== undefined) {
          value.notes[id].health = health
        }
      }
      gh.folded = { version: gh.version, value }
    }
    return gh.folded.value
  }

  /** Bring the comment list up to date: everything once, then only what changed */
  async function ghLoad(force) {
    const now = Date.now()
    if (!force && gh.loaded && now - gh.polledAt < 2000) {
      return
    }
    gh.polledAt = now
    gh.polls += 1
    /** A full reload now and then also notices deleted comments */
    const full = force || !gh.loaded || gh.polls % 10 === 0
    const base = `/repos/${GH_REPO}/issues/${GH_PR}/comments?per_page=100`
    try {
      const fresh = []
      for (let page = 1; page <= 20; page += 1) {
        const since = full || gh.since === '' ? '' : `&since=${encodeURIComponent(gh.since)}`
        const batch = await ghFetch(`${base}&page=${page}${since}`)
        fresh.push(...batch)
        if (batch.length < 100) {
          break
        }
      }
      if (full) {
        gh.comments.clear()
      }
      for (const comment of fresh) {
        gh.comments.set(comment.id, comment)
        if (String(comment.updated_at) > gh.since) {
          gh.since = comment.updated_at
        }
      }
      if (full || fresh.length > 0) {
        ghChanged()
      }
      gh.loaded = true
      gh.problem = ''
    } catch (error) {
      gh.problem = error.message
      throw error
    }
  }

  /** Writing needs a GitHub account: ask for one instead of failing silently */
  function ghRequireToken() {
    if (ghToken() !== '') {
      return
    }
    openConnect()
    const error = new Error('Connect GitHub to add or change notes.')
    error.connect = true
    throw error
  }

  async function ghPost(body) {
    ghRequireToken()
    const comment = await ghFetch(`/repos/${GH_REPO}/issues/${GH_PR}/comments`, { method: 'POST', body: { body } })
    gh.comments.set(comment.id, comment)
    ghChanged()
    return comment
  }

  /** A smaller copy of the slide picture, so it fits inside a comment */
  async function shrinkShot(dataUrl) {
    try {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      for (const [width, quality] of [[420, 0.5], [300, 0.4]]) {
        const scale = Math.min(1, width / image.naturalWidth)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(image.naturalWidth * scale)
        canvas.height = Math.round(image.naturalHeight * scale)
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
        const small = canvas.toDataURL('image/webp', quality)
        if (small.length <= 24_000) {
          return small
        }
      }
    } catch {
      /** No picture is better than no note */
    }
    return undefined
  }

  /** The storage calls the rest of the overlay makes, answered from the pull request */
  async function githubRest(pathname, method, body) {
    const [area, id, sub] = pathname.split('/')
    if (method === 'GET') {
      if (area === 'meta') {
        return null
      }
      if (area === 'notes') {
        await ghLoad(false)
      }
      const folded = ghFold()
      const tree = area === 'shots' ? folded.shots : folded.notes
      return id === undefined ? tree : (tree[id] ?? null)
    }
    if (area === 'shots') {
      /** The picture travels inside the note's own comment */
      return null
    }
    const current = ghFold().notes[id]
    if (method === 'PUT' && sub === undefined) {
      const { messages, n, status, hasShot, createdAt, health, shot, ...fields } = body
      const first = messages?.first ?? {}
      const data = { ...fields, id, text: first.text ?? '' }
      if (first.author && first.author !== `@${gh.login}`) {
        data.by = first.author
      }
      if (typeof shot === 'string') {
        data.shot = await shrinkShot(shot)
      }
      /** One past the highest number in use; the note keeps it even if earlier notes are deleted */
      const number = Object.values(ghFold().notes).reduce((highest, item) => Math.max(highest, item.n), 0) + 1
      let text = FORMAT.noteBody(data, number)
      if (text.length > 60_000) {
        /** Drop the picture, then the steps, before giving up on the note */
        delete data.shot
        text = FORMAT.noteBody(data, number)
      }
      if (text.length > 60_000) {
        data.trail = list(data.trail).slice(-5)
        text = FORMAT.noteBody(data, number)
      }
      await ghPost(text)
      return body
    }
    if (current === undefined) {
      throw new Error('This note is no longer on the pull request.')
    }
    if (method === 'DELETE') {
      ghRequireToken()
      try {
        await ghFetch(`/repos/${GH_REPO}/issues/comments/${current.commentId}`, { method: 'DELETE' })
      } catch (error) {
        if (error.status === 403 || error.status === 404) {
          throw new Error('Only its author or a maintainer can delete this note on GitHub.')
        }
        throw error
      }
      gh.comments.delete(current.commentId)
      ghChanged()
      return null
    }
    if (sub === 'messages') {
      /** A reply; an imported one keeps its original author's name */
      const data = { note: id }
      if (method === 'PUT' && body.author) {
        data.by = body.author
      }
      if (body.agent === true) {
        data.agent = true
      }
      await ghPost(FORMAT.eventBody(current.n, body.text ?? '', data))
      return body
    }
    if (method === 'PATCH') {
      if ('health' in body && Object.keys(body).length === 1) {
        /** Whether this browser found the element is not worth a comment on the pull request */
        if (body.health === null) {
          delete gh.health[id]
        } else {
          gh.health[id] = body.health
        }
        ghChanged()
        return body
      }
      delete gh.health[id]
      const data = { note: id }
      let text = ''
      if (body.status !== undefined) {
        data.status = body.status
      }
      if (body.resolution !== undefined) {
        data.resolution = body.resolution
        text = String(body.resolution)
      }
      if (body.anchor !== undefined) {
        data.anchor = body.anchor
        const label = body.anchor.label ? ` “${body.anchor.label}”` : ''
        text = `re-attached to ${body.anchor.role ?? body.anchor.tag}${label}.`
      }
      await ghPost(FORMAT.eventBody(current.n, text, data))
      return body
    }
    throw new Error(`Not supported on a pull request: ${method} ${pathname}`)
  }

  /** --- Connect GitHub: a token the reviewer pastes once ------------------- */

  let connectCard = null

  function closeConnect() {
    if (connectCard !== null) {
      connectCard.remove()
      connectCard = null
    }
  }

  function ghDisconnect() {
    ghForget()
    gh.notice = ''
    renderPins()
  }

  function openConnect() {
    closeConnect()
    const input = h('input', { type: 'password', placeholder: 'Paste a GitHub token', autocomplete: 'off' })
    const forget = h('input', { type: 'checkbox' })
    const problem = h('div', { class: 'hint', style: 'display:none' })
    const connect = async () => {
      const token = input.value.trim()
      if (token === '') {
        input.focus()
        return
      }
      problem.style.display = 'none'
      try {
        const response = await fetch(`${GH_API}/user`, {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          throw new Error(`GitHub did not accept this token (${response.status}).`)
        }
        const user = await response.json()
        gh.login = user.login ?? ''
        if (forget.checked) {
          sessionStorage.setItem(GH_TOKEN, token)
        } else {
          localStorage.setItem(GH_TOKEN, token)
        }
        localStorage.setItem(GH_LOGIN, gh.login)
        gh.notice = ''
        closeConnect()
        await ghLoad(true).catch(() => {})
        refresh()
      } catch (error) {
        problem.textContent = error.message
        problem.style.display = ''
      }
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        connect()
      }
    })
    const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener' }, text)
    connectCard = h(
      'div',
      { class: 'card connect' },
      h('div', { class: 'head' }, h('b', {}, 'Connect GitHub'), h('span', { class: 'grow' }), h('button', { class: 'x', title: 'Cancel', onclick: closeConnect }, '×')),
      h(
        'div',
        { class: 'where' },
        `Notes for this preview are comments on pull request #${GH_PR} in ${GH_REPO}. Reading them needs no sign-in. To add a note or reply, paste a GitHub token: your notes are then posted under your own account.`,
      ),
      h(
        'div',
        { class: 'where' },
        link('Create a token for this repository only', 'https://github.com/settings/personal-access-tokens/new'),
        `: choose “Only select repositories”, pick ${GH_REPO}, and give “Pull requests” read and write access. A short expiry is safer. Or `,
        link('a classic token', 'https://github.com/settings/tokens/new?scopes=public_repo&description=ainotelayer'),
        ' with the public_repo scope.',
      ),
      input,
      h('label', { class: 'check' }, forget, 'Forget it when I close this tab'),
      h(
        'div',
        { class: 'where', style: 'margin-top:8px' },
        'The token is kept in this browser and sent only to GitHub. This preview page can read it, so use one limited to this repository.',
      ),
      problem,
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'grow' }),
        h('button', { onclick: closeConnect }, 'Cancel'),
        h('button', { class: 'primary', onclick: connect }, 'Connect'),
      ),
    )
    ui.append(connectCard)
    input.focus()
  }

  /** What the notes list says about where notes live and who you are */
  function githubLine() {
    const pull = h(
      'a',
      { href: `https://github.com/${GH_REPO}/pull/${GH_PR}`, target: '_blank', rel: 'noopener' },
      `pull request #${GH_PR}`,
    )
    const line = h('div', { class: 'where' }, 'Notes are comments on ', pull, '. ')
    if (ghToken() === '') {
      line.append('Reading without sign-in. ', h('button', { class: 'link', onclick: openConnect }, 'Connect GitHub'), ' to add notes.')
    } else {
      line.append(`Signed in as @${gh.login || '…'}. `, h('button', { class: 'link', onclick: ghDisconnect }, 'Disconnect'))
    }
    for (const message of [gh.notice, gh.problem]) {
      if (message !== '') {
        line.append(h('div', { class: 'hint', style: 'margin:6px 0 0' }, message))
      }
    }
    return line
  }

  /** --- The same reads and writes against this browser's localStorage ------ */

  function readLocal() {
    try {
      const stored = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}')
      return stored !== null && typeof stored === 'object' ? stored : {}
    } catch {
      return {}
    }
  }

  function putLocal(all, segments, value) {
    let node = all
    for (const segment of segments.slice(0, -1)) {
      if (node[segment] === null || typeof node[segment] !== 'object') {
        node[segment] = {}
      }
      node = node[segment]
    }
    const last = segments[segments.length - 1]
    if (value === null || value === undefined) {
      delete node[last]
    } else {
      node[last] = value
    }
  }

  function localRest(pathname, method, body) {
    const all = readLocal()
    const segments = pathname.split('/').filter(Boolean)
    if (method === 'GET') {
      let node = all
      for (const segment of segments) {
        node = node !== null && typeof node === 'object' ? (node[segment] ?? null) : null
      }
      return node ?? null
    }
    let result = body ?? null
    if (method === 'PATCH') {
      for (const [key, value] of Object.entries(body ?? {})) {
        putLocal(all, [...segments, ...key.split('/').filter(Boolean)], value)
      }
    } else if (method === 'POST') {
      const name = `-${Date.now().toString(36).padStart(9, '0')}${Math.random().toString(36).slice(2, 10)}`
      putLocal(all, [...segments, name], body)
      result = { name }
    } else {
      putLocal(all, segments, method === 'DELETE' ? null : body)
    }
    /** Throws when the browser's storage is full or blocked; callers report it */
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all))
    return result
  }

  /** The database drops empty lists and may return lists as keyed objects */
  function list(value) {
    if (Array.isArray(value)) {
      return value.filter((item) => item != null)
    }
    return value !== null && typeof value === 'object' ? Object.values(value) : []
  }

  function normalize(id, raw) {
    const anchor = raw.anchor ?? {}
    return {
      ...raw,
      id,
      status: Object.hasOwn(STATUS, raw.status ?? '') ? raw.status : 'open',
      kind: raw.kind ?? KINDS[0],
      anchor: {
        ...anchor,
        tag: anchor.tag ?? 'element',
        label: anchor.label ?? '',
        offset: anchor.offset ?? { x: 0.5, y: 0.5 },
        components: list(anchor.components),
        containers: list(anchor.containers),
        source: list(anchor.source),
      },
      trail: list(raw.trail),
      messages: list(raw.messages).sort((a, b) => String(a.at).localeCompare(String(b.at))),
    }
  }

  /** The notes subtree as the database holds it, kept current by the event stream */
  let tree = {}

  function setIn(segments, value) {
    if (segments.length === 0) {
      tree = value !== null && typeof value === 'object' ? value : {}
      return
    }
    let node = tree
    for (const segment of segments.slice(0, -1)) {
      if (node[segment] === null || typeof node[segment] !== 'object') {
        node[segment] = {}
      }
      node = node[segment]
    }
    const last = segments[segments.length - 1]
    if (value === null) {
      delete node[last]
    } else {
      node[last] = value
    }
  }

  function applyChange(pathname, data, merge) {
    const segments = pathname.split('/').filter(Boolean)
    if (merge) {
      for (const [key, value] of Object.entries(data ?? {})) {
        setIn([...segments, ...key.split('/').filter(Boolean)], value)
      }
    } else {
      setIn(segments, data)
    }
    state.notes = Object.entries(tree)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && raw.createdAt)
      .map(([id, raw]) => normalize(id, raw))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    if (card !== null) {
      const current = state.notes.find((note) => note.id === card.id)
      if (current === undefined) {
        closeCard()
      } else {
        card.update(current)
      }
    }
    renderPins()
  }

  /** --- Describing an element so it can be found again ------------------- */

  /** Ids that React or Radix generate change between renders and page loads */
  function isStableId(id) {
    return id !== '' && !/^radix-|_r_[0-9a-z]+_|[:«»]|\d{4,}/.test(id)
  }

  function tidy(text) {
    return (text ?? '').trim().replace(/\s+/g, ' ').slice(0, 70)
  }

  /** The name a person would use for the element: its own text, or its label's */
  function labelOf(element) {
    const own = tidy(
      element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.innerText ||
        element.getAttribute('placeholder') ||
        element.getAttribute('alt'),
    )
    if (own !== '') {
      return own
    }
    const labelledBy = element.getAttribute('aria-labelledby')
    const named = labelledBy ? document.getElementById(labelledBy.split(' ')[0]) : null
    if (named !== null && tidy(named.innerText) !== '') {
      return tidy(named.innerText)
    }
    if (element.labels?.length > 0) {
      return tidy(element.labels[0].innerText)
    }
    if (element.localName === 'canvas') {
      return ''
    }
    let node = element.parentElement
    for (let depth = 0; node !== null && depth < 3; depth += 1, node = node.parentElement) {
      if (tidy(node.innerText) !== '') {
        return tidy(node.innerText)
      }
    }
    return ''
  }

  /** Climb from an icon or text node's element to the control it belongs to */
  function meaningful(element) {
    const control = element.closest(MEANINGFUL)
    if (control !== null) {
      return control
    }
    const svg = element.closest('svg')
    return svg !== null && svg.parentElement !== null ? svg.parentElement : element
  }

  function xpathOf(element) {
    const parts = []
    for (let node = element; node !== null && node.nodeType === 1; node = node.parentElement) {
      if (isStableId(node.id)) {
        parts.unshift(`//*[@id="${node.id}"]`)
        return parts.join('/')
      }
      const same = node.parentElement
        ? [...node.parentElement.children].filter((kid) => kid.localName === node.localName)
        : [node]
      const html = node.namespaceURI === 'http://www.w3.org/1999/xhtml'
      const name = html ? node.localName : `*[name()="${node.localName}"]`
      parts.unshift(same.length > 1 ? `${name}[${same.indexOf(node) + 1}]` : name)
    }
    return `/${parts.join('/')}`
  }

  function cssOf(element) {
    const parts = []
    for (let node = element; node !== null && node !== document.body; node = node.parentElement) {
      let part = node.localName
      const testId = node.getAttribute('data-testid')
      const aria = node.getAttribute('aria-label')
      if (testId) {
        part = `[data-testid=${JSON.stringify(testId)}]`
      } else if (isStableId(node.id)) {
        part = `#${CSS.escape(node.id)}`
      } else if (aria) {
        part = `${node.localName}[aria-label=${JSON.stringify(aria)}]`
      } else if (node.parentElement !== null) {
        const same = [...node.parentElement.children].filter(
          (kid) => kid.localName === node.localName,
        )
        if (same.length > 1) {
          part += `:nth-of-type(${same.indexOf(node) + 1})`
        }
      }
      parts.unshift(part)
      try {
        if (document.querySelectorAll(parts.join(' > ')).length === 1) {
          break
        }
      } catch {
        /** An odd attribute value made the selector invalid; keep climbing */
      }
    }
    return parts.join(' > ')
  }

  /** React's record for the element, or for the nearest ancestor React renders */
  function fiberOf(element) {
    for (let node = element; node !== null; node = node.parentElement) {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'))
      if (key !== undefined) {
        return node[key]
      }
    }
    return null
  }

  /** `Component@path/to/File.tsx:12:5`, as written by the build plugin (stamp.mjs) */
  function parseStamp(value) {
    const found = /^([^@]*)@(.+):(\d+):(\d+)$/.exec(value ?? '')
    if (found === null) {
      return null
    }
    return { in: found[1] || undefined, file: found[2], line: Number(found[3]), column: Number(found[4]) }
  }

  /**
   * Where the element comes from in the source, nearest first: where the DOM
   * element is written, then where each component around it is used. Empty
   * unless the app was built with the ainotelayer build plugin.
   */
  function sourceOf(element) {
    const chain = []
    const add = (kind, value) => {
      const parsed = typeof value === 'string' ? parseStamp(value) : null
      const seen =
        parsed !== null &&
        chain.some((item) => item.file === parsed.file && item.line === parsed.line && item.column === parsed.column)
      if (parsed !== null && !seen) {
        chain.push({ kind, ...parsed })
      }
    }
    let fiber = fiberOf(element)
    if (fiber !== null) {
      for (; fiber != null && chain.length < 6; fiber = fiber.return) {
        const props = fiber.memoizedProps
        if (props !== null && typeof props === 'object') {
          add('element', props[SRC])
          add('use', props[USE])
        }
      }
    } else {
      for (let node = element; node !== null && chain.length < 6; node = node.parentElement) {
        add('element', node.getAttribute(SRC))
        add('use', node.getAttribute(USE))
      }
    }
    return chain.length > 0 ? chain : undefined
  }

  /** Text written directly in the element, not in its children */
  function ownText(element) {
    let text = ''
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += ` ${node.textContent}`
      }
    }
    return tidy(text)
  }

  /** Text around the element: its row, card or field, whichever is closest */
  function nearText(element) {
    const own = tidy(element.textContent)
    let node = element.parentElement
    for (let depth = 0; node !== null && node !== document.body && depth < 3; depth += 1) {
      const text = tidy(node.textContent)
      if (text !== '' && text !== own) {
        return text
      }
      node = node.parentElement
    }
    return ''
  }

  /** The heading or labelled region the element sits under */
  function landmarkOf(element) {
    let node = element.parentElement
    for (let depth = 0; node !== null && node !== document.body && depth < 8; depth += 1) {
      const named = node.getAttribute('aria-label')
      if (named) {
        return tidy(named)
      }
      const heading = node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],legend')
      const before =
        heading !== null &&
        !heading.contains(element) &&
        (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      if (before && tidy(heading.innerText) !== '') {
        return tidy(heading.innerText)
      }
      node = node.parentElement
    }
    return ''
  }

  function hrefPath(element) {
    const href = element.getAttribute('href')
    if (!href) {
      return null
    }
    try {
      return new URL(href, location.href).pathname
    } catch {
      return null
    }
  }

  /** Attributes that tend to stay the same while the layout around them changes */
  function attrsOf(element) {
    const picked = {
      testid: element.getAttribute('data-testid'),
      id: isStableId(element.id) ? element.id : null,
      name: element.getAttribute('name'),
      type: element.getAttribute('type'),
      placeholder: element.getAttribute('placeholder'),
      href: hrefPath(element),
    }
    const kept = Object.fromEntries(Object.entries(picked).filter(([, value]) => value))
    return Object.keys(kept).length > 0 ? kept : undefined
  }

  /** React component names from the element outwards, without library plumbing */
  function componentsOf(element) {
    let fiber = fiberOf(element)
    const names = []
    while (fiber != null && names.length < 8) {
      const type = fiber.type
      let name = null
      if (typeof type === 'function') {
        name = type.displayName || type.name
      } else if (type !== null && typeof type === 'object') {
        name =
          type.displayName ||
          type.render?.displayName ||
          type.render?.name ||
          type.type?.displayName ||
          type.type?.name
      }
      if (name && name.length > 2 && !PLUMBING.test(name) && names[names.length - 1] !== name) {
        names.push(name)
      }
      fiber = fiber.return
    }
    return names
  }

  /**
   * What the reviewer pressed to bring up each dialog or menu. A dialog opened
   * from a menu item leaves nothing in the page that says so once the menu
   * has closed, so the press is remembered as it happens.
   */
  const LAYER = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'
  const openedWith = new WeakMap()

  function describeOpener(control) {
    /** Whatever the control itself sits inside has to be opened first, outermost first */
    const via = containersOf(control)
      .reverse()
      .map((container) => container.openedBy)
      .filter(Boolean)
      .flatMap((opener) => [...list(opener.via), { ...opener, via: undefined }])
      .slice(-6)
    return {
      label: labelOf(control),
      selector: cssOf(control),
      xpath: xpathOf(control),
      /** Not a control that only shows or hides something: going to a note asks before pressing it */
      ask: control.matches(TOGGLER) ? undefined : true,
      via: via.length > 0 ? via : undefined,
    }
  }

  /** Call before a press. The function it returns credits that press with every layer that appeared since. */
  function watchLayers(opener) {
    const before = new Set(document.querySelectorAll(LAYER))
    return () => {
      for (const layer of document.querySelectorAll(LAYER)) {
        if (!before.has(layer) && !openedWith.has(layer)) {
          openedWith.set(layer, opener)
        }
      }
    }
  }

  function layerLabel(node) {
    const labelledBy = node.getAttribute('aria-labelledby')
    const labelElement = labelledBy ? document.getElementById(labelledBy.split(' ')[0]) : null
    return node.getAttribute('aria-label') || (labelElement ? labelOf(labelElement) : '')
  }

  /** The steps that open a container, outermost first */
  function openerChain(opener) {
    return [...list(opener.via), opener]
  }

  function openerPath(opener) {
    return openerChain(opener).map((step) => step.label).join(' → ')
  }

  /** The outermost dialog a note is inside that is not open right now */
  function closedDialog(note) {
    const open = [...document.querySelectorAll(LAYER)]
    return (
      [...note.anchor.containers]
        .reverse()
        .find(
          (container) =>
            ['dialog', 'alertdialog'].includes(container.role) &&
            !open.some(
              (node) => node.getAttribute('role') === container.role && layerLabel(node) === (container.label ?? ''),
            ),
        ) ?? null
    )
  }

  /**
   * What the element sits inside at runtime: dialogs, menus, tab panels, open
   * collapsibles. For each one, the control that opens it, so the state can be
   * reached again after it has closed.
   */
  function containersOf(element) {
    const found = []
    for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) {
      /** A hand-made disclosure: the expanded toggle sits right before its content */
      const before = node.previousElementSibling
      let expander = null
      if (before !== null && before.matches('[aria-expanded="true"]')) {
        expander = before
      } else if (before !== null && tidy(before.innerText).length < 70) {
        /** Or the toggle is wrapped in a heading-sized element */
        expander = before.querySelector(':scope > [aria-expanded="true"]')
      }
      /** A toggle that names what it controls only counts for that element */
      const controls = expander === null ? null : expander.getAttribute('aria-controls')
      if (controls !== null && controls !== node.id) {
        expander = null
      }
      if (!node.matches(CONTAINER) && expander === null) {
        continue
      }
      const labelledBy = node.getAttribute('aria-labelledby')
      const labelElement = labelledBy ? document.getElementById(labelledBy.split(' ')[0]) : null
      let opener = node.id
        ? document.querySelector(`[aria-controls=${JSON.stringify(node.id)}]`)
        : null
      if (opener === null && labelElement !== null && labelElement.matches('button,[role="tab"]')) {
        opener = labelElement
      }
      if (opener === null) {
        opener = expander
      }
      const ownRole = node.getAttribute('role')
      const role = ownRole || (opener !== null ? 'section' : node.localName)
      const label = node.getAttribute('aria-label') || (labelElement ? labelOf(labelElement) : '')
      if (ownRole === null && label === '' && opener === null) {
        continue
      }
      found.push({
        role,
        label: label || undefined,
        state: node.getAttribute('data-state') || undefined,
        portal: node.closest('[data-radix-portal],[data-radix-popper-content-wrapper]') !== null || undefined,
        selector: cssOf(node),
        openedBy:
          opener === null
            ? openedWith.get(node)
            : { label: labelOf(opener), selector: cssOf(opener), xpath: xpathOf(opener) },
      })
    }
    return found
  }

  function brief(element) {
    return {
      what: element.getAttribute('role') || element.localName,
      label: labelOf(element),
      selector: cssOf(element),
      component: componentsOf(element)[0],
    }
  }

  function clamp(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
  }

  function describeAnchor(hit, x, y) {
    const element = meaningful(hit)
    const rect = element.getBoundingClientRect()
    return {
      xpath: xpathOf(element),
      selector: cssOf(element),
      hitXpath: hit === element ? undefined : xpathOf(hit),
      tag: element.localName,
      role: element.getAttribute('role') || undefined,
      label: labelOf(element),
      offset: {
        x: clamp((x - rect.left) / rect.width),
        y: clamp((y - rect.top) / rect.height),
      },
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      components: componentsOf(element),
      containers: containersOf(element),
      html: element.outerHTML.replace(/\s+/g, ' ').slice(0, 400),
      text: ownText(element) || undefined,
      attrs: attrsOf(element),
      landmark: landmarkOf(element) || undefined,
      near: nearText(element) || undefined,
      stamp:
        element.hasAttribute(SRC) || element.hasAttribute(USE)
          ? { src: element.getAttribute(SRC) ?? undefined, use: element.getAttribute(USE) ?? undefined }
          : undefined,
      source: sourceOf(element),
    }
  }

  function resolve(anchor) {
    try {
      const matches = document.querySelectorAll(anchor.selector)
      if (matches.length === 1 && matches[0].localName === anchor.tag) {
        return matches[0]
      }
    } catch {
      /** Fall through to the XPath */
    }
    try {
      const node = document.evaluate(
        anchor.xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue
      if (node !== null && node.localName === anchor.tag) {
        return node
      }
    } catch {
      /** The page no longer has this structure */
    }
    return null
  }

  /**
   * How well an element fits what the note recorded. `possible` is the most
   * this anchor could score, so anchors with few signals are judged fairly.
   */
  function match(anchor, element) {
    let score = 0
    let possible = 0
    /** How the name compares: same, partial, different, or none recorded */
    let name = 'none'
    let exactStamp = false
    const same = (weight, wanted, got) => {
      if (wanted === undefined || wanted === null || wanted === '') {
        return
      }
      possible += weight
      if (wanted === got) {
        score += weight
      }
    }
    /** A source stamp: same component and file is strong, the same line stronger */
    const stamped = (weight, wanted, got) => {
      const a = parseStamp(wanted)
      if (a === null) {
        return
      }
      possible += weight + 2
      const b = parseStamp(got)
      if (b !== null && a.file === b.file && a.in === b.in) {
        const near = Math.abs(a.line - b.line) <= 5 ? 1 : 0
        score += weight + (a.line === b.line ? 2 : near)
        exactStamp = exactStamp || a.line === b.line
      }
    }
    stamped(5, anchor.stamp?.src, element.getAttribute(SRC))
    stamped(3, anchor.stamp?.use, element.getAttribute(USE))
    /**
     * Where the component around it is used: this tells apart elements that
     * one shared component renders, such as the buttons of a toolbar.
     */
    const usedAt = list(anchor.source).find((entry) => entry.kind === 'use')
    if (usedAt !== undefined) {
      possible += 3
      const mine = (sourceOf(element) ?? []).find((entry) => entry.kind === 'use')
      if (mine !== undefined && mine.file === usedAt.file && mine.in === usedAt.in) {
        score += 2 + (Math.abs(mine.line - usedAt.line) <= 2 ? 1 : 0)
      }
    }
    const attrs = anchor.attrs ?? {}
    same(6, attrs.testid, element.getAttribute('data-testid'))
    same(5, attrs.id, element.id)
    same(2, attrs.name, element.getAttribute('name'))
    same(2, attrs.placeholder, element.getAttribute('placeholder'))
    same(2, attrs.href, hrefPath(element))
    same(1, attrs.type, element.getAttribute('type'))
    same(1, anchor.role, element.getAttribute('role') || undefined)
    if (anchor.label) {
      possible += 4
      const got = labelOf(element)
      const firstWord = (text) => text.toLowerCase().split(' ')[0]
      if (got === anchor.label) {
        score += 4
        name = 'same'
      } else if (nameKey(got) === nameKey(anchor.label) || firstWord(got) === firstWord(anchor.label)) {
        /** Renamed a little, or the name carries live state */
        score += 2
        name = 'partial'
      } else {
        /** A different name counts against it */
        score -= got === '' ? 0 : 2
        name = 'different'
      }
    }
    same(2, anchor.text, ownText(element) || undefined)
    /** What surrounds it tells identical controls apart, such as "Delete" in each row */
    same(3, anchor.near, nearText(element) || undefined)
    const components = componentsOf(element)
    same(2, list(anchor.components)[0], components[0])
    same(1, list(anchor.components)[1], components[1])
    same(2, anchor.landmark, landmarkOf(element) || undefined)
    return { score, possible, name, exactStamp }
  }

  function candidatesFor(anchor) {
    const attribute = anchor.stamp?.src ? SRC : USE
    const stampOf = parseStamp(anchor.stamp?.src ?? anchor.stamp?.use)
    if (stampOf !== null) {
      /** Elements written in the same file first: few, and the likeliest */
      const near = document.querySelectorAll(
        `${anchor.tag}[${attribute}*=${JSON.stringify(`@${stampOf.file}:`)}]`,
      )
      if (near.length > 0) {
        return [...near]
      }
    }
    return [...document.getElementsByTagName(anchor.tag)].slice(0, 800)
  }

  /** The one element that clearly fits the description, or null */
  function search(anchor) {
    let best = null
    let bestScore = -Infinity
    let second = -Infinity
    let possible = 0
    for (const element of candidatesFor(anchor)) {
      if (host.contains(element)) {
        continue
      }
      const result = match(anchor, element)
      possible = result.possible
      if (result.score > bestScore) {
        second = bestScore
        bestScore = result.score
        best = element
      } else if (result.score > second) {
        second = result.score
      }
    }
    if (best === null || possible === 0) {
      return null
    }
    return bestScore / possible >= 0.6 && bestScore - second >= 2 ? { element: best, score: bestScore } : null
  }

  /** Counts changes to the page, so the wider search only reruns when something changed */
  let domVersion = 0
  new MutationObserver(() => {
    domVersion += 1
  }).observe(document.documentElement, { childList: true, subtree: true })

  /** Being where the note says counts as evidence too, about as much as its name */
  const PATH_CREDIT = 4

  /**
   * Find a note's element on the current page.
   *   found:   where the note says it is, and it still fits the description
   *   changed: where the note says, at the same source line, but renamed
   *   moved:   recognised by its description somewhere else
   * `changed` and `moved` are shown for the reviewer to confirm. `memo` (one
   * per note) keeps the wider search from running on every tick.
   */
  function locate(anchor, memo = {}) {
    const direct = resolve(anchor)
    if (direct !== null) {
      /** Re-check the fit only when the element or the page changed */
      if (memo.direct !== direct || memo.directVersion !== domVersion) {
        memo.direct = direct
        memo.directVersion = domVersion
        memo.fit = match(anchor, direct)
      }
      if (memo.fit.score >= memo.fit.possible) {
        return { element: direct, how: 'found' }
      }
    }
    /**
     * The path leads nowhere, or to something that only partly fits: look
     * wider, but not on every tick.
     */
    const now = performance.now()
    const fresh = memo.version === domVersion || now - (memo.at ?? -Infinity) < 1500
    if (!fresh || memo.at === undefined) {
      memo.version = domVersion
      memo.at = now
      memo.wider = search(anchor)
    }
    const wider = memo.wider != null && memo.wider.element.isConnected ? memo.wider : null
    const fit = direct === null ? null : memo.fit
    let fits = fit !== null && (fit.score + PATH_CREDIT) / (fit.possible + PATH_CREDIT) >= 0.4
    /**
     * Same place but a different name is either a rename or another element
     * that slid into a removed one's spot. Only the same source line tells
     * them apart, so without it the note is treated as not found.
     */
    if (fits && fit.name === 'different' && !fit.exactStamp) {
      fits = false
    }
    if (fits) {
      /** The path still fits; only a clearly better match elsewhere overrides it */
      if (wider !== null && wider.element !== direct && wider.score - fit.score >= 2) {
        return { element: wider.element, how: 'moved' }
      }
      return { element: direct, how: fit.name === 'different' ? 'changed' : 'found' }
    }
    return wider === null ? null : { element: wider.element, how: 'moved' }
  }

  /** A picture of the slide viewport with a ring where the note was placed */
  function shotOf(hit, x, y) {
    const viewport = hit.closest('.ol-viewport')
    const canvases =
      viewport !== null ? [...viewport.querySelectorAll('canvas')] : hit.localName === 'canvas' ? [hit] : []
    const first = canvases.find((canvas) => canvas.width > 0 && canvas.height > 0)
    if (first === undefined) {
      return undefined
    }
    try {
      const scale = Math.min(1, 900 / first.width)
      const copy = document.createElement('canvas')
      copy.width = Math.round(first.width * scale)
      copy.height = Math.round(first.height * scale)
      const context = copy.getContext('2d')
      for (const canvas of canvases) {
        if (canvas.width > 0 && canvas.height > 0) {
          context.drawImage(canvas, 0, 0, copy.width, copy.height)
        }
      }
      const rect = first.getBoundingClientRect()
      context.lineWidth = 3
      context.strokeStyle = '#ff2d55'
      context.beginPath()
      context.arc(
        ((x - rect.left) / rect.width) * copy.width,
        ((y - rect.top) / rect.height) * copy.height,
        14,
        0,
        Math.PI * 2,
      )
      context.stroke()
      return copy.toDataURL('image/webp', 0.7)
    } catch {
      return undefined
    }
  }

  /** --- The trail of steps leading up to a note --------------------------- */

  function pushTrail(entry) {
    const last = state.trail[state.trail.length - 1]
    const repeatable = entry.type === 'wheel' || entry.type === 'key'
    if (
      repeatable &&
      last !== undefined &&
      last.type === entry.type &&
      last.selector === entry.selector &&
      last.key === entry.key
    ) {
      last.count = (last.count ?? 1) + 1
      last.t = entry.t
      return
    }
    state.trail.push(entry)
    if (state.trail.length > 60) {
      state.trail.shift()
    }
  }

  function step(type, element, extra = {}) {
    return { t: Date.now(), type, path: location.pathname, ...brief(element), ...extra }
  }

  function isTyping(element) {
    return element instanceof Element && element.matches('input,textarea,[contenteditable="true"]')
  }

  /** Not part of the reviewer's steps: the overlay's own UI, and presses it makes itself */
  function skipped(event) {
    return !event.isTrusted || picking !== null || isOurs(event)
  }

  let pressed = null
  let lastHref = location.href

  /** Remember which press brings up a dialog or menu; checked again as the app reacts */
  let settleLayers = null
  function watchPress(event) {
    if (skipped(event) || !(event.target instanceof Element)) {
      return
    }
    const settle = watchLayers(describeOpener(meaningful(event.target)))
    settleLayers = settle
    setTimeout(settle, 150)
    setTimeout(settle, 600)
  }

  document.addEventListener('pointerdown', (event) => {
    pressed = skipped(event) ? null : { x: event.clientX, y: event.clientY, target: event.target }
    if (event.button === 0) {
      watchPress(event)
    }
  }, true)
  document.addEventListener('pointerup', (event) => {
    if (pressed === null || skipped(event) || !(pressed.target instanceof Element)) {
      return
    }
    const dx = Math.round(event.clientX - pressed.x)
    const dy = Math.round(event.clientY - pressed.y)
    if (Math.hypot(dx, dy) > 6) {
      pushTrail(step('drag', meaningful(pressed.target), { dx, dy }))
    }
    pressed = null
  }, true)
  document.addEventListener('click', (event) => {
    if (!skipped(event) && event.target instanceof Element) {
      pushTrail(step('click', meaningful(event.target)))
      if (settleLayers !== null) {
        setTimeout(settleLayers, 0)
        setTimeout(settleLayers, 150)
        setTimeout(settleLayers, 600)
      }
    }
  }, true)
  document.addEventListener('change', (event) => {
    const element = event.target
    if (skipped(event) || !(element instanceof Element)) {
      return
    }
    let value
    if (element.type === 'checkbox' || element.type === 'radio') {
      value = String(element.checked)
    } else if (element.type !== 'password') {
      value = String(element.value ?? '').slice(0, 40)
    }
    pushTrail(step('change', element, { value }))
  }, true)
  document.addEventListener('wheel', (event) => {
    if (!skipped(event) && event.target instanceof Element && event.target.closest('.ol-viewport,canvas')) {
      pushTrail(step('wheel', meaningful(event.target), { direction: event.deltaY < 0 ? 'in' : 'out' }))
    }
  }, { capture: true, passive: true })
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (picking !== null || card !== null || composer !== null)) {
      /**
       * Escape closes what the overlay has open and stops there. Passed on,
       * it would also close the app's dialog underneath, and with it the
       * element the note is about. On the window, so the app's own Escape
       * handlers come after this one.
       */
      if (picking !== null) {
        stopPicking()
      }
      closeCard()
      closeComposer()
      event.stopImmediatePropagation()
      return
    }
    if (skipped(event) || ['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) {
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      watchPress(event)
    }
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey
    if (plain && event.key.length === 1 && isTyping(event.target)) {
      return
    }
    const combo = [
      event.ctrlKey && 'Ctrl', event.metaKey && 'Cmd', event.altKey && 'Alt', event.shiftKey && 'Shift', event.key,
    ].filter(Boolean).join('+')
    pushTrail({ t: Date.now(), type: 'key', key: combo, path: location.pathname })
  }, true)
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      pushTrail({ t: Date.now(), type: 'navigate', to: location.pathname + location.search })
    }
  }, 400)

  function stepText(entry) {
    const count = entry.count > 1 ? ` ×${entry.count}` : ''
    if (entry.type === 'navigate') {
      return `navigate to ${entry.to}`
    }
    if (entry.type === 'key') {
      return `press ${entry.key}${count}`
    }
    const value = entry.value === undefined ? '' : ` = ${entry.value}`
    const inside = entry.component ? ` (${entry.component})` : ''
    return `${entry.type} ${entry.what} "${entry.label}"${value}${inside}${count}`
  }

  /** --- Pins, highlight and placement ------------------------------------- */

  function onThisPage(note) {
    return note.scope === 'app' || note.path === location.pathname
  }

  function visibleAt(element, offset) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return false
    }
    const x = rect.left + rect.width * offset.x
    const y = rect.top + rect.height * offset.y
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return false
    }
    const top = document.elementsFromPoint(x, y).find((node) => node !== host)
    return top === undefined || element.contains(top) || top.contains(element)
  }

  /** Next to the point: right and below when it fits, flipped when it does not */
  function place(node, x, y) {
    const width = node.offsetWidth
    const height = node.offsetHeight
    const fitsRight = x + 30 + width <= window.innerWidth - 8
    const fitsBelow = y + 10 + height <= window.innerHeight - 8
    const left = fitsRight ? x + 30 : x - 16 - width
    const top = fitsBelow ? y + 10 : y - 34 - height
    node.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`
    node.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`
  }

  /**
   * A line from the open note to the exact point it is pinned on. The note
   * sits a little away from the point and the highlight frames the whole
   * element, so neither says where on the element it was. A saved note has a
   * pin whose tip is on the point, so the line ends there, behind the pin. A
   * new note has no pin yet: `ring` draws a small ring on the point instead.
   */
  function pointAt(node, point, color, ring) {
    if (node === null || point === null) {
      lead.style.display = 'none'
      spot.style.display = 'none'
      return
    }
    const box = node.getBoundingClientRect()
    /** Start inside the note's rounded corner: the note covers that end of the line */
    const inset = 10
    const startX = Math.max(box.left + inset, Math.min(point.x, box.right - inset))
    const startY = Math.max(box.top + inset, Math.min(point.y, box.bottom - inset))
    /** Stop at the ring, so the point itself stays uncovered */
    const length = Math.hypot(point.x - startX, point.y - startY) - (ring ? 7 : 0)
    const angle = Math.atan2(point.y - startY, point.x - startX)
    spot.style.cssText = ring ? `display:block;left:${point.x}px;top:${point.y}px;--c:${color}` : 'display:none'
    lead.style.cssText =
      length < 4
        ? 'display:none'
        : `display:block;left:${startX}px;top:${startY - 1}px;width:${length}px;rotate:${angle}rad;--c:${color}`
  }

  function renderPins() {
    const keep = new Set()
    for (const note of state.notes) {
      if (!matchesFilter(note)) {
        continue
      }
      keep.add(note.id)
      let pin = pins.get(note.id)
      if (pin === undefined) {
        const node = h('div', {
          class: 'pin',
          style: 'display:none',
          onclick: () => (card !== null && card.id === note.id ? closeCard() : openCard(note.id)),
        })
        pinLayer.append(node)
        pin = { node, element: null, visible: false, how: null, memo: {} }
        pins.set(note.id, pin)
      }
      pin.node.textContent = String(note.n)
      pin.node.title = note.messages[0]?.text ?? ''
      pin.node.style.setProperty('--c', STATUS[note.status][1])
      pin.node.classList.toggle('active', card !== null && card.id === note.id)
    }
    for (const [id, pin] of pins) {
      if (!keep.has(id)) {
        pin.node.remove()
        pins.delete(id)
      }
    }
    const open = state.notes.filter((note) => note.status !== 'resolved').length
    dock.textContent = `Notes · ${open} unresolved`
    renderPanel()
    applyFloat()
  }

  function frame(now) {
    const slow = now - lastSlow > 300
    if (slow) {
      lastSlow = now
    }
    if (location.pathname !== lastPath) {
      const from = lastPath
      lastPath = location.pathname
      leftPage(from)
    }
    let target = composer !== null ? composer.element : null
    let color = STATUS.open[1]
    let cardPinned = false
    let point = null
    if (composer !== null && composer.element.isConnected) {
      const rect = composer.element.getBoundingClientRect()
      point = { x: rect.left + rect.width * composer.at.x, y: rect.top + rect.height * composer.at.y }
    }
    for (const note of state.notes) {
      const pin = pins.get(note.id)
      if (pin === undefined) {
        continue
      }
      if (slow || (pin.element !== null && !pin.element.isConnected)) {
        const hit = onThisPage(note) ? locate(note.anchor, pin.memo) : null
        pin.element = hit === null ? null : hit.element
        pin.how = hit === null ? null : hit.how
        pin.visible = pin.element !== null && visibleAt(pin.element, note.anchor.offset)
        pin.node.classList.toggle('moved', pin.how === 'moved' || pin.how === 'changed')
      }
      /** The note someone was just taken to stands out among the others for a moment */
      pin.node.classList.toggle('pulse', now < pulseUntil && card !== null && card.id === note.id)
      if (!pin.visible) {
        pin.node.style.display = 'none'
        continue
      }
      const rect = pin.element.getBoundingClientRect()
      const x = rect.left + rect.width * note.anchor.offset.x
      const y = rect.top + rect.height * note.anchor.offset.y
      pin.node.style.display = ''
      pin.node.style.translate = `${x}px ${y}px`
      if (card !== null && card.id === note.id) {
        target = pin.element
        color = STATUS[note.status][1]
        cardPinned = true
        point = { x, y }
        place(card.node, x, y)
      }
    }
    if (card !== null) {
      const away = seeking === card.id ? 'seeking' : 'away'
      const mode = cardPinned ? (pins.get(card.id)?.how ?? 'found') : away
      if (card.mode !== mode) {
        card.setMode(mode)
      }
      card.node.classList.toggle('pulse', now < pulseUntil)
    }
    if (card !== null && !cardPinned) {
      card.node.style.left = `${window.innerWidth - card.node.offsetWidth - 12}px`
      card.node.style.top = '64px'
    }
    pointAt(cardPinned ? card.node : (composer?.node ?? null), point, color, !cardPinned)
    if (target !== null && target.isConnected) {
      const rect = target.getBoundingClientRect()
      const big = rect.width * rect.height > 0.2 * window.innerWidth * window.innerHeight
      highlight.className = `${big ? 'hl big' : 'hl'}${now < pulseUntil ? ' pulse' : ''}`
      highlight.style.cssText = `display:block;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;--c:${color}`
    } else {
      highlight.style.display = 'none'
    }
    requestAnimationFrame(frame)
  }

  /** --- Note card, composer and list -------------------------------------- */

  function whereLine(anchor) {
    const line = h('div', { class: 'where' })
    const name = anchor.label ? ` “${anchor.label}”` : ''
    line.append(h('strong', {}, `${anchor.role ?? anchor.tag}${name}`))
    if (anchor.components.length > 0) {
      line.append(` in ${anchor.components[0]}`)
    }
    for (const container of anchor.containers) {
      const label = container.label ? ` “${container.label}”` : ''
      const opener = container.openedBy ? `, opened by “${openerPath(container.openedBy)}”` : ''
      line.append(` · inside ${container.role}${label}${opener}`)
    }
    return line
  }

  /** Link to the file and line on GitHub, at the build the note was made on */
  function sourceUrl(entry, note) {
    const repo = state.meta.repo
    const sha = note?.sha ?? state.meta.sha
    return repo && sha ? `https://github.com/${repo}/blob/${sha}/${entry.file}#L${entry.line}` : null
  }

  function sourceText(entry) {
    return `${entry.file.split('/').pop()}:${entry.line}`
  }

  /** "Switch.tsx:12 ← DisplayOptionRow.tsx:40": where it is written, then where that is used */
  function sourceLine(anchor, note) {
    const chain = list(anchor.source).slice(0, 2)
    if (chain.length === 0) {
      return null
    }
    const line = h('div', { class: 'where' })
    chain.forEach((entry, index) => {
      if (index > 0) {
        line.append(' ← ')
      }
      const url = sourceUrl(entry, note)
      const title = `${entry.kind === 'element' ? 'Written' : 'Used'} in ${entry.in ?? '?'}: ${entry.file}:${entry.line}`
      line.append(
        url === null
          ? h('span', { title }, sourceText(entry))
          : h('a', { href: url, target: '_blank', rel: 'noopener', title }, sourceText(entry)),
      )
    })
    return line
  }

  function needsRecheck(note) {
    return note.health?.state === 'missing' && (note.health.sha ?? null) === (state.meta.sha ?? null)
  }

  function detailText(note) {
    const anchor = note.anchor
    const lines = [
      `build: ${note.branch}@${note.sha}`,
      `url: ${note.url}`,
      `xpath: ${anchor.xpath}`,
      `selector: ${anchor.selector}`,
    ]
    for (const entry of list(anchor.source)) {
      const verb = entry.kind === 'element' ? 'written' : 'used'
      lines.push(`source: ${entry.file}:${entry.line}:${entry.column} (${verb} in ${entry.in ?? '?'})`)
    }
    if (list(note.anchorHistory).length > 0) {
      lines.push(`re-anchored: ${list(note.anchorHistory).length} time(s)`)
    }
    if (anchor.components.length > 0) {
      lines.push(`components: ${anchor.components.join(' < ')}`)
    }
    for (const container of anchor.containers) {
      const opener = container.openedBy ? ` (opened by "${openerPath(container.openedBy)}")` : ''
      lines.push(`inside: ${container.role} "${container.label ?? ''}"${opener}`)
    }
    if (note.hasShot) {
      lines.push(`screenshot: ${shotRef(note)}`)
    }
    if (note.trail.length > 0) {
      lines.push('steps before the note:')
      note.trail.forEach((entry, index) => lines.push(` ${index + 1}. ${stepText(entry)}`))
    }
    return lines.join('\n')
  }

  /** A failed write: say why, unless the sign-in dialog is already asking */
  function explain(error, what) {
    if (error?.connect !== true) {
      window.alert(`${what}: ${error?.message ?? error}`)
    }
  }

  function author() {
    if (GITHUB) {
      ghRequireToken()
      return `@${gh.login}`
    }
    let name = storage(WHO)
    if (name === '') {
      name = (window.prompt('Your initials, shown next to your notes') ?? '').trim()
      if (name !== '') {
        storage(WHO, name)
      }
    }
    return name || 'anon'
  }

  function closeCard() {
    if (card !== null) {
      handFocusBack(card.node)
      card.node.remove()
      card = null
      renderPins()
    }
  }

  function closeComposer() {
    if (composer !== null) {
      handFocusBack(composer.node)
      composer.node.remove()
      composer = null
    }
  }

  /**
   * The app went to another page without a reload. A note that belonged to
   * the page just left has nothing to point at any more, so it closes, and so
   * does a new note nothing was typed in. Typed text is never thrown away.
   */
  let lastPath = location.pathname
  function leftPage(from) {
    if (composer !== null && composer.text.value.trim() === '') {
      closeComposer()
    }
    const note = card === null ? undefined : state.notes.find((item) => item.id === card.id)
    if (note !== undefined && note.path === from && !onThisPage(note) && card.reply.value.trim() === '') {
      closeCard()
    }
  }

  function openCard(id) {
    const note = state.notes.find((item) => item.id === id)
    if (note === undefined) {
      return
    }
    closeComposer()
    closeCard()
    const messages = h('div', {})
    const reply = h('textarea', { rows: 2, placeholder: 'Reply, ask or decide… ⌘/Ctrl+Enter sends' })
    const status = h(
      'select',
      {
        title: 'Status',
        onchange: async () => {
          try {
            await rest(`notes/${id}`, 'PATCH', { status: status.value })
          } catch (error) {
            explain(error, 'The status could not be changed')
          }
          refresh()
        },
      },
      Object.entries(STATUS).map(([value, [label]]) => h('option', { value }, label)),
    )
    const send = async () => {
      const text = reply.value.trim()
      if (text === '') {
        return
      }
      reply.value = ''
      try {
        await rest(`notes/${id}/messages`, 'POST', {
          author: author(),
          text,
          at: new Date().toISOString(),
        })
      } catch (error) {
        /** Put the text back so it is not lost */
        reply.value = text
        explain(error, 'The reply could not be sent')
      }
      refresh()
    }
    reply.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        send()
      }
    })
    const kind = h('span', { class: 'tag' })
    const older = h('span', { class: 'tag', title: 'This note was made on an earlier build' })
    const where = h('div', {})
    const hintText = h('span', {})
    const hintAction = h('button', { class: 'link' })
    const hint = h('div', { class: 'hint', style: 'display:none' }, hintText, ' ', hintAction)
    const details = h('pre', {})
    const shot = h('img', {
      class: 'shot',
      alt: 'The slide when the note was added',
      title: 'Click to enlarge',
      onclick: () => shot.classList.toggle('full'),
    })
    if (note.hasShot) {
      rest(`shots/${id}`).then((dataUrl) => {
        if (typeof dataUrl === 'string') {
          shot.src = dataUrl
          shot.classList.add('on')
        }
      }).catch(() => {})
    }
    const foot = h(
      'div',
      { class: 'foot' },
      !onThisPage(note) &&
        h('button', { class: 'link', onclick: () => reveal(note) }, 'Go to its page'),
      h(
        'button',
        { class: 'link', title: 'Point this note at a different element', onclick: () => startPicking(id) },
        'Re-attach',
      ),
      note.commentUrl && h('a', { href: note.commentUrl, target: '_blank', rel: 'noopener' }, 'On GitHub'),
      h('span', { class: 'grow' }),
      h(
        'button',
        {
          class: 'link',
          onclick: async () => {
            if (window.confirm(`Delete note N${note.n} and its thread?`)) {
              try {
                await rest(`notes/${id}`, 'DELETE')
                if (note.hasShot) {
                  await rest(`shots/${id}`, 'DELETE')
                }
                closeCard()
              } catch (error) {
                explain(error, 'The note could not be deleted')
              }
              refresh()
            }
          },
        },
        'Delete',
      ),
    )
    const node = h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'head' },
        h('b', {}, `N${note.n}`),
        kind,
        older,
        h('span', { class: 'grow' }),
        status,
        h('button', { class: 'x', title: 'Close', onclick: closeCard }, '×'),
      ),
      where,
      hint,
      shot,
      messages,
      h('div', { class: 'row' }, reply, h('button', { class: 'primary', onclick: send }, 'Send')),
      h('details', {}, h('summary', {}, 'What an agent gets with this note'), details),
      foot,
    )
    card = {
      id,
      node,
      reply,
      mode: null,
      /**
       * found: nothing to say; moved: offer to update the note; away: offer to
       * re-attach it; seeking: still waiting for the app to show the element
       */
      setMode(mode) {
        this.mode = mode
        const current = state.notes.find((item) => item.id === id)
        hint.style.display = mode === 'found' ? 'none' : ''
        if (mode === 'seeking') {
          hintText.textContent = 'Looking for this element on the page…'
          hintAction.textContent = ''
          hintAction.onclick = null
        } else if (mode === 'moved' || mode === 'changed') {
          hintText.textContent =
            mode === 'moved'
              ? 'Recognised by its description: it is not where it was when the note was made.'
              : 'This element was renamed since the note was made. Check it is still the right one.'
          hintAction.textContent = 'Update the note'
          hintAction.onclick = () => keepWhereFound(id)
        } else if (mode === 'away') {
          const dialog = current !== undefined && onThisPage(current) ? closedDialog(current) : null
          const name = dialog?.label ? `the “${dialog.label}” dialog` : 'a dialog'
          if (dialog?.openedBy) {
            hintText.textContent = `This note is in ${name}, opened with ${openerPath(dialog.openedBy)}.`
            hintAction.textContent = 'Open it'
            hintAction.onclick = () => reveal(current, 1500, true, true)
            return
          }
          if (dialog !== null) {
            hintText.textContent = `This note is in ${name}. Open the dialog and the note will show there.`
          } else {
            hintText.textContent =
              current !== undefined && needsRecheck(current)
                ? 'This element could not be found on this build. It may have changed or been removed.'
                : 'This element is not on the screen right now.'
          }
          hintAction.textContent = 'Re-attach'
          hintAction.onclick = () => startPicking(id)
        }
      },
      update(next) {
        node.style.setProperty('--c', STATUS[next.status][1])
        status.value = next.status
        kind.textContent = next.kind
        const stale = Boolean(next.sha && state.meta.sha && next.sha !== state.meta.sha)
        older.textContent = stale ? `build ${next.sha}` : ''
        older.style.display = stale ? '' : 'none'
        where.replaceChildren(...[whereLine(next.anchor), sourceLine(next.anchor, next)].filter(Boolean))
        if (this.mode !== null) {
          this.setMode(this.mode)
        }
        details.textContent = detailText(next)
        messages.replaceChildren(
          ...next.messages.map((message) =>
            h(
              'div',
              { class: message.agent ? 'msg agent' : 'msg' },
              h('time', {}, new Date(message.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
              h('span', { class: 'by' }, `${message.author}:`),
              message.text,
            ),
          ),
        )
      },
    }
    card.update(note)
    ui.append(node)
    renderPins()
  }

  function openComposer(event) {
    const hit = event.target
    const draft = {
      anchor: describeAnchor(hit, event.clientX, event.clientY),
      trail: state.trail.slice(-25),
      shot: shotOf(hit, event.clientX, event.clientY),
      url: location.href,
      path: location.pathname,
    }
    closeCard()
    closeComposer()
    let kind = KINDS[0]
    const chips = KINDS.map((name) =>
      h(
        'button',
        {
          class: name === kind ? 'chip on' : 'chip',
          onclick: () => {
            kind = name
            for (const chip of chips) {
              chip.classList.toggle('on', chip.textContent === name)
            }
          },
        },
        name,
      ),
    )
    const text = h('textarea', {
      rows: 3,
      placeholder: 'What should change here, or what do we need to figure out?',
    })
    const initials = h('input', { type: 'text', class: 'who', placeholder: 'Initials', maxlength: 12 })
    initials.value = storage(WHO)
    const everywhere = h('input', { type: 'checkbox' })
    const save = async () => {
      if (text.value.trim() === '') {
        text.focus()
        return
      }
      storage(WHO, initials.value.trim())
      const id = crypto.randomUUID().slice(0, 8)
      const now = new Date().toISOString()
      const { shot, ...fields } = draft
      try {
        const by = GITHUB ? author() : initials.value.trim() || 'anon'
        await rest(`notes/${id}`, 'PUT', {
          ...fields,
          /** On a pull request the picture travels inside the note's comment */
          ...(GITHUB && shot !== undefined ? { shot } : {}),
          n: state.notes.reduce((max, note) => Math.max(max, note.n ?? 0), 0) + 1,
          status: 'open',
          kind,
          scope: everywhere.checked ? 'app' : 'page',
          createdAt: now,
          branch: state.meta.branch ?? null,
          sha: state.meta.sha ?? null,
          hasShot: shot !== undefined,
          messages: { first: { author: by, text: text.value.trim(), at: now } },
        })
      } catch (error) {
        /** Keep the composer open so the text is not lost */
        explain(error, 'The note could not be saved')
        return
      }
      if (shot !== undefined) {
        await rest(`shots/${id}`, 'PUT', shot).catch(() => {})
      }
      closeComposer()
      await refresh()
      openCard(id)
    }
    text.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Enter' && (keyEvent.metaKey || keyEvent.ctrlKey)) {
        save()
      }
    })
    const node = h(
      'div',
      { class: 'card' },
      h('div', { class: 'head' }, h('b', {}, 'New note'), h('span', { class: 'grow' }), h('button', { class: 'x', title: 'Cancel', onclick: closeComposer }, '×')),
      whereLine(draft.anchor),
      sourceLine(draft.anchor, null),
      h('div', { class: 'chips' }, chips),
      text,
      h('label', { class: 'check' }, everywhere, 'Show on every page, not only this URL'),
      h(
        'div',
        { class: 'row' },
        GITHUB ? h('span', { class: 'tag' }, gh.login ? `@${gh.login}` : 'not signed in') : initials,
        h('span', { class: 'grow' }),
        h('button', { onclick: closeComposer }, 'Cancel'),
        h('button', { class: 'primary', onclick: save }, 'Add note'),
      ),
    )
    const element = meaningful(hit)
    const box = element.getBoundingClientRect()
    /** Where on the element the click was, so the pointer follows it when the page scrolls */
    const at = {
      x: (event.clientX - box.left) / (box.width || 1),
      y: (event.clientY - box.top) / (box.height || 1),
    }
    composer = { node, text, element, at }
    ui.append(node)
    place(node, event.clientX, event.clientY)
    text.focus()
  }

  /** --- Going to a note: open what it sits inside, then show it ------------ */

  function sleep(ms) {
    return new Promise((done) => setTimeout(done, ms))
  }

  async function waitFor(probe, timeout) {
    const end = Date.now() + timeout
    for (;;) {
      const value = probe()
      if (value) {
        return value
      }
      if (Date.now() > end) {
        return null
      }
      await sleep(80)
    }
  }

  function isShown(element) {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  /** Labels carry live state ("Display options ICC on"), so compare their first words */
  function nameKey(label) {
    return String(label ?? '').toLowerCase().split(' ').slice(0, 2).join(' ')
  }

  /**
   * Controls whose job is to show or hide something: the only kind going to a
   * note is allowed to press. What a note says about its opener comes from
   * whoever wrote the note, so it must never be able to name an arbitrary
   * button (Delete, Save, Sign out) and have it clicked.
   */
  const TOGGLER = '[aria-expanded],[aria-haspopup],[role="tab"],summary'

  /** The control that opens a container: by selector, then XPath, then by name */
  function findOpener(opener) {
    const wanted = nameKey(opener.label)
    const fits = (element) =>
      element instanceof Element &&
      element.matches(TOGGLER) &&
      (wanted === '' || nameKey(labelOf(element)) === wanted)
    try {
      const matches = document.querySelectorAll(opener.selector)
      if (matches.length === 1 && fits(matches[0])) {
        return matches[0]
      }
    } catch {
      /** Fall through to the XPath */
    }
    if (opener.xpath) {
      try {
        const node = document.evaluate(
          opener.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue
        if (fits(node)) {
          return node
        }
      } catch {
        /** Fall through to the name */
      }
    }
    if (wanted !== '') {
      const togglers = document.querySelectorAll(TOGGLER)
      for (const element of togglers) {
        if (nameKey(labelOf(element)) === wanted) {
          return element
        }
      }
    }
    return null
  }

  /**
   * With the reviewer's say-so (they pressed "Open it", next to the names),
   * a plain button or menu item may be pressed as well, but only one that
   * carries the name they were shown.
   */
  const PRESSABLE = 'button,[role="button"],[role="menuitem"]'
  function findControl(opener) {
    const wanted = nameKey(opener.label)
    if (wanted === '') {
      return null
    }
    const fits = (element) =>
      element instanceof Element && element.matches(PRESSABLE) && nameKey(labelOf(element)) === wanted
    try {
      const matches = document.querySelectorAll(opener.selector)
      if (matches.length === 1 && fits(matches[0])) {
        return matches[0]
      }
    } catch {
      /** Fall through to the name */
    }
    for (const element of document.querySelectorAll(PRESSABLE)) {
      if (fits(element) && isShown(element)) {
        return element
      }
    }
    return null
  }

  function isOpen(opener) {
    return (
      opener.getAttribute('aria-expanded') === 'true' ||
      opener.getAttribute('aria-selected') === 'true' ||
      ['open', 'active'].includes(opener.getAttribute('data-state')) ||
      (opener.localName === 'summary' && opener.parentElement?.open === true)
    )
  }

  /** A full press: some menus open on pointer-down, most things on click */
  function press(element) {
    const rect = element.getBoundingClientRect()
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }
    const pointer = { ...init, pointerType: 'mouse', isPrimary: true }
    element.dispatchEvent(new PointerEvent('pointerdown', pointer))
    element.dispatchEvent(new MouseEvent('mousedown', init))
    element.dispatchEvent(new PointerEvent('pointerup', pointer))
    element.dispatchEvent(new MouseEvent('mouseup', init))
    element.click()
  }

  /**
   * Take the reviewer to a note: go to its page, open every section, tab or
   * menu it sits inside (outermost first), scroll it into view, then expand
   * the note on it. `patience` is how long to wait for the app to show things.
   */
  async function reveal(note, patience = 1500, navigate = true, consent = false) {
    if (!onThisPage(note) && !navigate) {
      /** Opened from a link or after a page change: show it, let the reviewer choose to go */
      openCard(note.id)
      return
    }
    if (!onThisPage(note)) {
      try {
        sessionStorage.setItem(OPEN, note.id)
      } catch {
        /** Without session storage the page still opens, just not the note */
      }
      const there = new URL(note.url, location.href)
      location.assign(there.pathname + there.search + there.hash)
      return
    }
    closeComposer()
    const found = () => {
      const element = locate(note.anchor)?.element ?? null
      return element !== null && isShown(element) ? element : null
    }
    let element = found()
    if (element === null) {
      /**
       * The element is not there yet, or not at all on a screen this size.
       * Show the note now and say it is being looked for: waiting first would
       * leave the reviewer looking at nothing for the whole wait.
       */
      seeking = note.id
      openCard(note.id)
      pulseUntil = performance.now() + 2500
      const steps = []
      for (const container of [...note.anchor.containers].reverse()) {
        if (!container.openedBy) {
          continue
        }
        const chain = openerChain(container.openedBy)
        if (chain.some((step) => step.ask)) {
          /**
           * Opening this takes a press on something that is not a plain
           * show-or-hide control. Leave it, and what is inside it, until the
           * reviewer asks: the note says how it opens and offers to do it.
           */
          if (closedDialog(note) === null) {
            continue
          }
          if (!consent) {
            break
          }
        }
        for (const step of chain) {
          if (!steps.some((done) => done.selector === step.selector && done.label === step.label)) {
            steps.push(step)
          }
        }
      }
      for (const wanted of steps) {
        if (found() !== null || card?.id !== note.id) {
          break
        }
        const opener = await waitFor(
          () => findOpener(wanted) ?? (consent && wanted.ask ? findControl(wanted) : null),
          patience,
        )
        if (opener === null || isOpen(opener)) {
          continue
        }
        /** A layer this press brings up is remembered too, for a note added inside it next */
        const settle = watchLayers(wanted)
        opener.scrollIntoView({ block: 'nearest' })
        press(opener)
        await waitFor(() => isOpen(opener) || !opener.isConnected || found() !== null, 1200)
        settle()
        setTimeout(settle, 400)
      }
      element = await waitFor(() => (seeking === note.id && card?.id === note.id ? found() : 'stop'), patience)
      const stopped = element === 'stop'
      if (seeking === note.id) {
        seeking = null
      }
      if (stopped) {
        /** The reviewer closed the note or went to another one meanwhile */
        return
      }
    }
    if (element !== null && !visibleAt(element, note.anchor.offset)) {
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      await sleep(120)
    }
    /** Remember, per build, that the element could not be found, so the list can say so */
    const build = state.meta.sha ?? null
    const known = note.health?.state === 'missing' && (note.health.sha ?? null) === build
    /** Inside a dialog that is closed is not the same as gone from this build */
    const shut = element === null && closedDialog(note) !== null
    if (element === null && !shut && document.readyState === 'complete' && !known) {
      const health = { state: 'missing', sha: build, at: new Date().toISOString() }
      rest(`notes/${note.id}`, 'PATCH', { health }).then(refresh).catch(() => {})
    } else if (element !== null && note.health != null) {
      rest(`notes/${note.id}`, 'PATCH', { health: null }).then(refresh).catch(() => {})
    }
    if (card?.id !== note.id) {
      openCard(note.id)
    }
    lastSlow = 0
    /** Not found: the note was already shown, and pulsed, when the wait began */
    if (element !== null) {
      pulseUntil = performance.now() + 2500
    }
    /** Once the note is placed, get the list out of the way if it covers it */
    await sleep(60)
    if (panel !== null && card !== null) {
      const covers = (rect) => {
        const mine = panel.getBoundingClientRect()
        return rect.left < mine.right && rect.right > mine.left && rect.top < mine.bottom && rect.bottom > mine.top
      }
      if (covers(card.node.getBoundingClientRect()) || (element !== null && covers(element.getBoundingClientRect()))) {
        togglePanel()
      }
    }
  }

  /** --- Updating where a note points ---------------------------------------- */

  async function saveAnchor(note, element, x, y) {
    const old = note.anchor
    const previous = {
      xpath: old.xpath,
      selector: old.selector,
      label: old.label || undefined,
      stamp: old.stamp,
      sha: note.sha ?? undefined,
      replacedAt: new Date().toISOString(),
    }
    try {
      await rest(`notes/${note.id}`, 'PATCH', {
        anchor: describeAnchor(element, x, y),
        anchorHistory: [...list(note.anchorHistory), previous].slice(-5),
        health: null,
      })
    } catch (error) {
      explain(error, 'The note could not be moved')
    }
    await refresh()
  }

  /** The note was recognised somewhere else: make that its new home */
  function keepWhereFound(id) {
    const note = state.notes.find((item) => item.id === id)
    const pin = pins.get(id)
    if (note === undefined || pin === undefined || pin.element === null) {
      return
    }
    const rect = pin.element.getBoundingClientRect()
    saveAnchor(
      note,
      pin.element,
      rect.left + rect.width * note.anchor.offset.x,
      rect.top + rect.height * note.anchor.offset.y,
    )
  }

  /** Re-attach: the next click on the app picks the note's new element */
  function startPicking(id) {
    picking = id
    closeCard()
    banner.style.display = ''
    document.documentElement.style.cursor = 'crosshair'
  }

  function stopPicking() {
    picking = null
    banner.style.display = 'none'
    document.documentElement.style.cursor = ''
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    document.addEventListener(type, (event) => {
      if (picking === null || isOurs(event)) {
        return
      }
      /** The app must not react to the click that picks an element */
      event.preventDefault()
      event.stopPropagation()
      if (type !== 'click' || !(event.target instanceof Element)) {
        return
      }
      const note = state.notes.find((item) => item.id === picking)
      stopPicking()
      if (note !== undefined) {
        saveAnchor(note, event.target, event.clientX, event.clientY).then(() => openCard(note.id))
      }
    }, true)
  }

  /** --- The floating list of every note in the app ------------------------- */

  function matchesFilter(note) {
    return state.filter === 'all' || note.status === state.filter
  }

  function shortPath(pathname) {
    const text = String(pathname ?? '')
    return text.length > 46 ? `${text.slice(0, 20)}…${text.slice(-24)}` : text
  }

  function applyFloat() {
    const width = dock.offsetWidth
    const height = dock.offsetHeight
    const left = Math.max(8, Math.min(floatAt?.left ?? window.innerWidth, window.innerWidth - width - 12))
    const top = Math.max(8, Math.min(floatAt?.top ?? window.innerHeight, window.innerHeight - height - 12))
    floater.style.left = `${left}px`
    floater.style.top = `${top}px`
    const below = top < window.innerHeight / 2
    floater.classList.toggle('below', below)
    floater.classList.toggle('leftward', left > window.innerWidth / 2)
    if (panel !== null) {
      const room = (below ? window.innerHeight - top - height : top) - 20
      panel.style.maxHeight = `${Math.max(180, room)}px`
    }
  }

  function makeDraggable(handle) {
    let start = null
    handle.addEventListener('pointerdown', (event) => {
      const button = event.target.closest('button')
      if (event.button !== 0 || (button !== null && button !== handle)) {
        return
      }
      const rect = floater.getBoundingClientRect()
      start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false }
      handle.setPointerCapture(event.pointerId)
    })
    handle.addEventListener('pointermove', (event) => {
      if (start === null) {
        return
      }
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (!start.moved && Math.hypot(dx, dy) < 5) {
        return
      }
      start.moved = true
      floatAt = { left: start.left + dx, top: start.top + dy }
      applyFloat()
    })
    const end = () => {
      if (start !== null && start.moved) {
        dragged = true
        storage(FLOAT, JSON.stringify(floatAt))
        setTimeout(() => {
          dragged = false
        }, 0)
      }
      start = null
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  function noteRow(note) {
    const pin = pins.get(note.id)
    const replies = note.messages.length - 1
    let where = ''
    if (onThisPage(note) && (pin === undefined || !pin.visible)) {
      /** A closed dialog is the thing to name; otherwise whatever opens the nearest section */
      const dialog = closedDialog(note)?.label
      const opener = note.anchor.containers.find((container) => container.openedBy)?.openedBy
      const name = dialog || String(opener?.label ?? '').split(' ').slice(0, 2).join(' ')
      where = name ? ` · inside “${name}”` : ' · not on screen'
    }
    if (needsRecheck(note)) {
      where = ' · needs re-check'
    }
    return h(
      'button',
      {
        class: card !== null && card.id === note.id ? 'item on' : 'item',
        title: 'Go to this note',
        onclick: () => reveal(note),
      },
      h('span', { class: 'dot', style: `background:${STATUS[note.status][1]}` }),
      h('span', { class: 't' }, `N${note.n} ${note.messages[0]?.text ?? ''}`),
      h(
        'span',
        { class: needsRecheck(note) ? 'm warn' : 'm' },
        `${note.kind} · ${note.messages[0]?.author ?? ''} · ${replies} ${replies === 1 ? 'reply' : 'replies'}${where}`,
      ),
    )
  }

  function renderPanel() {
    const scrolled = panel === null ? 0 : (panel.querySelector('.list')?.scrollTop ?? 0)
    if (panel !== null) {
      panel.remove()
      panel = null
    }
    floater.classList.toggle('open', state.panelOpen)
    if (!state.panelOpen) {
      return
    }
    const count = (status) => state.notes.filter((note) => note.status === status).length
    const filters = [['all', 'All', state.notes.length]]
    for (const [status, [label]] of Object.entries(STATUS)) {
      filters.push([status, label, count(status)])
    }
    const chips = filters.map(([key, label, total]) =>
      h(
        'button',
        {
          class: state.filter === key ? 'chip on' : 'chip',
          onclick: () => {
            state.filter = key
            renderPins()
          },
        },
        `${label} ${total}`,
      ),
    )
    const shown = state.notes.filter(matchesFilter)
    const here = shown.filter(onThisPage)
    const elsewhere = new Map()
    for (const note of shown) {
      if (!onThisPage(note)) {
        elsewhere.set(note.path, [...(elsewhere.get(note.path) ?? []), note])
      }
    }
    const body = h('div', { class: 'list' })
    if (here.length > 0) {
      body.append(h('div', { class: 'group' }, 'On this page'), ...here.map(noteRow))
    }
    for (const [pathname, notes] of elsewhere) {
      body.append(h('div', { class: 'group path', title: pathname }, shortPath(pathname)), ...notes.map(noteRow))
    }
    if (shown.length === 0) {
      const empty = state.notes.length === 0
        ? 'Right-click anything to add a note. Shift+right-click keeps the browser menu.'
        : 'No notes with this status.'
      body.append(h('div', { class: 'empty' }, empty))
    }
    const copy = h(
      'button',
      {
        class: 'link',
        onclick: async () => {
          await navigator.clipboard.writeText(exportMarkdown())
          copy.textContent = 'Copied'
        },
      },
      'Copy all as Markdown',
    )
    const picker = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      style: 'display:none',
      onchange: async () => {
        const file = picker.files?.[0]
        if (file === undefined) {
          return
        }
        try {
          const counts = await importData(JSON.parse(await file.text()))
          window.alert(`Imported: ${counts.added} new, ${counts.updated} updated.`)
        } catch (error) {
          window.alert(`Could not import this file: ${error.message}`)
        }
      },
    })
    const build = [state.meta.branch, state.meta.sha].filter(Boolean).join('@')
    const head = h(
      'div',
      { class: 'head', title: 'Drag to move' },
      h('b', {}, 'Notes'),
      build !== '' && h('span', { class: 'tag' }, build),
      h('span', { class: 'grow' }),
      h('button', { class: 'x', title: 'Close', onclick: () => togglePanel() }, '×'),
    )
    panel = h(
      'div',
      { class: 'card panel' },
      head,
      h('div', { class: 'chips' }, chips),
      body,
      picker,
      GITHUB && githubLine(),
      !GITHUB &&
        !SHARED &&
        h('div', { class: 'where' }, 'Kept in this browser only. Download to share them or hand them to an agent.'),
      h(
        'div',
        { class: 'foot' },
        GITHUB && h('button', { class: 'link', onclick: () => ghLoad(true).then(refresh, refresh) }, 'Refresh'),
        h('button', { class: 'link', onclick: () => downloadNotes() }, 'Download'),
        h('button', { class: 'link', onclick: () => picker.click() }, 'Import'),
        h('span', { class: 'grow' }),
        copy,
      ),
    )
    floater.append(panel)
    makeDraggable(head)
    applyFloat()
    body.scrollTop = scrolled
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen
    renderPanel()
  }

  function shotRef(note) {
    if (GITHUB) {
      return `inside the note's comment on the pull request (${note.commentUrl ?? ''})`
    }
    return SHARED ? urlOf(`shots/${note.id}`) : `shots.${note.id} in the downloaded notes file`
  }

  /** Everything about this review as one object: what a download or an agent gets */
  async function exportData() {
    return {
      format: 'ainotelayer/1',
      review: REVIEW,
      meta: state.meta,
      page: location.href,
      exportedAt: new Date().toISOString(),
      notes: (await rest('notes')) ?? {},
      shots: (await rest('shots')) ?? {},
    }
  }
  state.export = exportData

  async function downloadNotes() {
    const blob = new Blob([JSON.stringify(await exportData(), null, 2)], { type: 'application/json' })
    const link = h('a', { href: URL.createObjectURL(blob), download: `ainotelayer-notes-${REVIEW}.json` })
    ui.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
  }

  /**
   * Merge a notes file into this review: new notes are added; for notes already
   * here only new replies, the status and the resolution are taken, so an
   * agent's answers come back without overwriting anything.
   */
  async function importData(data) {
    const incoming = data?.notes
    if (incoming === null || typeof incoming !== 'object') {
      throw new Error('This file has no notes in it.')
    }
    const current = (await rest('notes')) ?? {}
    const counts = { added: 0, updated: 0 }
    for (const [id, note] of Object.entries(incoming)) {
      if (note === null || typeof note !== 'object' || !note.createdAt) {
        continue
      }
      const mine = current[id]
      if (mine === undefined) {
        const shot = data.shots?.[id]
        await rest(`notes/${id}`, 'PUT', GITHUB && typeof shot === 'string' ? { ...note, shot } : note)
        if (typeof shot === 'string') {
          await rest(`shots/${id}`, 'PUT', shot).catch(() => {})
        }
        if (GITHUB) {
          /** A pull request holds one comment per message, so the rest of the thread follows */
          for (const [messageId, message] of Object.entries(note.messages ?? {})) {
            if (messageId !== 'first') {
              await rest(`notes/${id}/messages/${messageId}`, 'PUT', message)
            }
          }
          if (note.status !== undefined && note.status !== 'open') {
            await rest(`notes/${id}`, 'PATCH', { status: note.status })
          }
        }
        counts.added += 1
        continue
      }
      let changed = false
      const patch = {}
      for (const key of ['status', 'resolution']) {
        if (note[key] !== undefined && note[key] !== mine[key]) {
          patch[key] = note[key]
        }
      }
      if (Object.keys(patch).length > 0) {
        await rest(`notes/${id}`, 'PATCH', patch)
        changed = true
      }
      for (const [messageId, message] of Object.entries(note.messages ?? {})) {
        if (mine.messages?.[messageId] === undefined) {
          await rest(`notes/${id}/messages/${messageId}`, 'PUT', message)
          changed = true
        }
      }
      counts.updated += changed ? 1 : 0
    }
    await refresh()
    return counts
  }
  state.import = importData
  /** For tests and for agents driving a browser: describe an element, find it again */
  state.describe = (element) => {
    const rect = element.getBoundingClientRect()
    return describeAnchor(element, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }
  state.locate = (anchor) => locate({ ...anchor, label: anchor.label ?? '' })
  /** The pull-request format, for tests and for tools that write notes */
  state.github = FORMAT
  state.opener = findOpener

  /** The notes in the shape of a review doc: one section per observation */
  function exportMarkdown() {
    const build = [state.meta.branch, state.meta.sha].filter(Boolean).join('@')
    const lines = [`# Review notes: ${state.meta.app ?? REVIEW}${build ? ` (${build})` : ''}`, '']
    for (const note of state.notes) {
      const anchor = note.anchor
      const resolution = note.resolution ? ` · ${note.resolution}` : ''
      lines.push(`## N${note.n} · ${note.kind} · ${STATUS[note.status][0]}${resolution}`)
      lines.push(`- Where: ${note.url} (build ${note.sha ?? 'unknown'})`)
      const inside = anchor.components.length > 0 ? `, in ${anchor.components.slice(0, 5).join(' < ')}` : ''
      lines.push(`- Element: ${anchor.role ?? anchor.tag} "${anchor.label}"${inside}`)
      lines.push(`- XPath: \`${anchor.xpath}\``, `- Selector: \`${anchor.selector}\``)
      for (const entry of anchor.source) {
        const verb = entry.kind === 'element' ? 'written' : 'used'
        const url = sourceUrl(entry, note)
        lines.push(`- Source: \`${entry.file}:${entry.line}\` (${verb} in ${entry.in ?? '?'})${url ? ` ${url}` : ''}`)
      }
      if (needsRecheck(note)) {
        lines.push('- Needs re-check: the element was not found on this build')
      }
      for (const container of anchor.containers) {
        const label = container.label ? ` "${container.label}"` : ''
        const opener = container.openedBy ? `, opened by "${openerPath(container.openedBy)}"` : ''
        lines.push(`- Inside: ${container.role}${label}${opener}`)
      }
      if (note.trail.length > 0) {
        lines.push('- Steps before the note:')
        note.trail.forEach((entry, index) => lines.push(`  ${index + 1}. ${stepText(entry)}`))
      }
      if (note.hasShot) {
        lines.push(`- Screenshot (data URL): ${shotRef(note)}`)
      }
      lines.push('- Thread:')
      for (const message of note.messages) {
        lines.push(`  - ${message.author}: ${String(message.text).replace(/\n/g, ' ')}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  async function refresh() {
    try {
      applyChange('/', await rest('notes'), false)
    } catch {
      /** The store may be unreachable for a moment; the next refresh catches up */
      if (GITHUB) {
        /** Show why in the notes list */
        renderPins()
      }
    }
  }

  /** Live updates: other reviewers' notes and agents' replies appear as they land */
  function subscribe() {
    if (GITHUB) {
      /** GitHub does not push changes: ask again, sparingly without sign-in (60 requests an hour) */
      setInterval(() => {
        const every = ghToken() === '' ? 180_000 : 20_000
        if (!document.hidden && Date.now() - gh.polledAt >= every) {
          refresh()
        }
      }, 5000)
      return
    }
    if (!SHARED) {
      /** Another tab of this browser changed the notes */
      window.addEventListener('storage', (event) => {
        if (event.key === LOCAL_KEY) {
          refresh()
        }
      })
      return
    }
    if (typeof EventSource === 'undefined') {
      setInterval(() => {
        if (!document.hidden) {
          refresh()
        }
      }, 5000)
      return
    }
    const source = new EventSource(urlOf('notes'))
    source.addEventListener('put', (event) => {
      const change = JSON.parse(event.data)
      applyChange(change.path, change.data, false)
    })
    source.addEventListener('patch', (event) => {
      const change = JSON.parse(event.data)
      applyChange(change.path, change.data, true)
    })
  }

  document.addEventListener('contextmenu', (event) => {
    if (isOurs(event) || event.shiftKey || !(event.target instanceof Element)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openComposer(event)
  }, true)

  rest('meta').then((meta) => {
    state.meta = { ...tagMeta, ...(meta ?? {}) }
    renderPins()
  }).catch(() => {})
  /** A link from the pull request names the note to open: …#ainote=<id> */
  function linkedNote() {
    return /[#&]ainote=([\w-]+)/.exec(location.hash)?.[1] ?? null
  }

  /**
   * Open the note a link or a page change asked for. A note added moments ago
   * can be missing from the list GitHub returns, so when it is not there ask
   * again a few times, and say what is going on instead of showing nothing.
   */
  let awaited = null
  async function openWanted(id) {
    awaited = id
    for (const wait of [0, 2500, 5000, 10_000]) {
      if (wait > 0) {
        await sleep(wait)
        if (awaited !== id) {
          return
        }
        await refresh()
      }
      const note = state.notes.find((item) => item.id === id)
      if (awaited !== id) {
        return
      }
      if (note !== undefined) {
        awaited = null
        say('')
        /**
         * The app may still be starting, so wait longer for it. No page change
         * from here: a link must not be able to send the reviewer somewhere
         * else, and a redirect must not cause a loop.
         */
        reveal(note, 10_000, false)
        return
      }
      say('Looking for the note…')
    }
    awaited = null
    say('That note was not found. It may have been deleted.', 8000)
  }

  /** Read now: the app's router may rewrite the address while the notes load */
  const linkedAtStart = linkedNote()
  refresh().then(() => {
    subscribe()
    let pending = null
    try {
      pending = sessionStorage.getItem(OPEN)
      sessionStorage.removeItem(OPEN)
    } catch {
      /** Nothing to reopen */
    }
    pending ??= linkedAtStart
    if (pending !== null) {
      openWanted(pending)
    }
  })
  /** A second link opened in the same tab only changes the part after the # */
  window.addEventListener('hashchange', () => {
    const id = linkedNote()
    if (id !== null) {
      openWanted(id)
    }
  })
  if (GITHUB && ghToken() !== '') {
    gh.login = storage(GH_LOGIN)
  }
  try {
    floatAt = JSON.parse(storage(FLOAT) || 'null')
  } catch {
    floatAt = null
  }
  makeDraggable(dock)
  window.addEventListener('resize', applyFloat)
  requestAnimationFrame(frame)
})()
