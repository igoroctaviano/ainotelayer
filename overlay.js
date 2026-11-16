/**
 * Review layer overlay.
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
  if (window.__reviewLayer !== undefined) {
    return
  }

  /**
   * Notes live in a Firebase Realtime Database (or the local server, which
   * speaks the same REST dialect). The script tag says which one and which
   * review: data-db and data-review.
   */
  const tag = document.currentScript
  const [DB, DB_QUERY] = (tag?.dataset.db ?? '/__review/db').split('?')
  const REVIEW = tag?.dataset.review ?? 'default'

  /** The database URL may carry a query; the Firebase emulator needs `?ns=<name>` */
  function urlOf(pathname) {
    const suffix = DB_QUERY ? `?${DB_QUERY}` : ''
    return `${DB.replace(/\/$/, '')}/reviews/${encodeURIComponent(REVIEW)}/${pathname}.json${suffix}`
  }
  const WHO = 'review-layer-author'
  const OPEN = 'review-layer-open'
  const FLOAT = 'review-layer-float'
  const STATUS = {
    open: ['Open', '#6ea8fe'],
    fix: ['Fix in place', '#f2c94c'],
    resolved: ['Resolved', '#4cc38a'],
  }
  const KINDS = ['Change', 'Bug', 'Question', 'Research']
  const MEANINGFUL =
    'button,a,input,select,textarea,label,summary,canvas,[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="switch"],[role="checkbox"],[role="option"],[role="slider"]'
  const CONTAINER =
    '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tabpanel"],[role="tooltip"],[data-radix-popper-content-wrapper],[data-state="open"],details[open]'
  const PLUMBING =
    /^(_|Primitive|Slot|Presence|Portal|FocusScope|DismissableLayer|Popper|Router|Routes|Route|Outlet|Render|Collection|Roving|Anonymous)|(Provider|Context|Impl|Boundary)$/

  const state = {
    notes: [],
    meta: {},
    trail: [],
    filter: 'all',
    panelOpen: false,
  }
  window.__reviewLayer = state

  let card = null
  let composer = null
  let panel = null
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
  host.setAttribute('data-review-layer', '')
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
    textarea, input[type="text"], select { width: 100%; background: #0d0f13; color: #e8eaed; border: 1px solid #2c313a; border-radius: 6px;
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
    .hint { color: #f2c94c; font-size: 12px; margin-bottom: 8px; }
    .hl.pulse { animation: pulse .8s ease-out 2; }
    @keyframes pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 75%, transparent); } to { box-shadow: 0 0 0 20px transparent; } }
    .item { display: grid; grid-template-columns: 10px 1fr; gap: 2px 8px; width: 100%; text-align: left; margin-top: 6px; padding: 7px 8px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; }
    .item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item .m { grid-column: 2; color: #9aa4b2; font-size: 11px; }
    .empty { color: #9aa4b2; padding: 8px 0; }
  `
  const highlight = h('div', { class: 'hl' })
  const pinLayer = h('div', { class: 'pins' })
  const ui = h('div', { class: 'ui' })
  /** The floating notes list: a pill that opens the list; drag either to move it */
  let floatAt = null
  let dragged = false
  let pulseUntil = 0
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
  ui.append(floater)
  root.append(style, highlight, pinLayer, ui)

  /**
   * Keep the overlay's own events away from the app: its shortcuts, and the
   * "clicked or focused outside" handlers that would close the very menu or
   * dialog a note is being written about.
   */
  for (const type of [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
    'focusin', 'focusout', 'keydown', 'keyup', 'keypress', 'wheel', 'input', 'change',
  ]) {
    host.addEventListener(type, (event) => event.stopPropagation())
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
    const response = await fetch(urlOf(pathname), {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`${method} ${pathname}: ${response.status}`)
    }
    return response.json()
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
      status: raw.status in STATUS ? raw.status : 'open',
      kind: raw.kind ?? KINDS[0],
      anchor: {
        ...anchor,
        tag: anchor.tag ?? 'element',
        label: anchor.label ?? '',
        offset: anchor.offset ?? { x: 0.5, y: 0.5 },
        components: list(anchor.components),
        containers: list(anchor.containers),
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

  /** React component names from the element outwards, without library plumbing */
  function componentsOf(element) {
    let fiber = null
    for (let node = element; node !== null && fiber === null; node = node.parentElement) {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'))
      fiber = key === undefined ? null : node[key]
    }
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
            ? undefined
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
    return !event.isTrusted || isOurs(event)
  }

  let pressed = null
  let lastHref = location.href

  document.addEventListener('pointerdown', (event) => {
    pressed = skipped(event) ? null : { x: event.clientX, y: event.clientY, target: event.target }
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (card !== null || composer !== null)) {
      closeCard()
      closeComposer()
    }
    if (skipped(event) || ['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) {
      return
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
        pin = { node, element: null, visible: false }
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
    dock.textContent = `Notes · ${open} open`
    renderPanel()
    applyFloat()
  }

  function frame(now) {
    const slow = now - lastSlow > 300
    if (slow) {
      lastSlow = now
    }
    let target = composer !== null ? composer.element : null
    let color = STATUS.open[1]
    let cardPinned = false
    for (const note of state.notes) {
      const pin = pins.get(note.id)
      if (pin === undefined) {
        continue
      }
      if (slow || (pin.element !== null && !pin.element.isConnected)) {
        pin.element = onThisPage(note) ? resolve(note.anchor) : null
        pin.visible = pin.element !== null && visibleAt(pin.element, note.anchor.offset)
      }
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
        place(card.node, x, y)
      }
    }
    if (card !== null) {
      card.hint.style.display = cardPinned ? 'none' : ''
    }
    if (card !== null && !cardPinned) {
      card.node.style.left = `${window.innerWidth - card.node.offsetWidth - 12}px`
      card.node.style.top = '64px'
    }
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
      const opener = container.openedBy ? `, opened by “${container.openedBy.label}”` : ''
      line.append(` · inside ${container.role}${label}${opener}`)
    }
    return line
  }

  function detailText(note) {
    const anchor = note.anchor
    const lines = [
      `build: ${note.branch}@${note.sha}`,
      `url: ${note.url}`,
      `xpath: ${anchor.xpath}`,
      `selector: ${anchor.selector}`,
    ]
    if (anchor.components.length > 0) {
      lines.push(`components: ${anchor.components.join(' < ')}`)
    }
    for (const container of anchor.containers) {
      const opener = container.openedBy ? ` (opened by "${container.openedBy.label}")` : ''
      lines.push(`inside: ${container.role} "${container.label ?? ''}"${opener}`)
    }
    if (note.hasShot) {
      lines.push(`screenshot: ${urlOf(`shots/${note.id}`)}`)
    }
    if (note.trail.length > 0) {
      lines.push('steps before the note:')
      note.trail.forEach((entry, index) => lines.push(` ${index + 1}. ${stepText(entry)}`))
    }
    return lines.join('\n')
  }

  function author() {
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
      card.node.remove()
      card = null
      renderPins()
    }
  }

  function closeComposer() {
    if (composer !== null) {
      composer.node.remove()
      composer = null
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
          await rest(`notes/${id}`, 'PATCH', { status: status.value })
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
      await rest(`notes/${id}/messages`, 'POST', {
        author: author(),
        text,
        at: new Date().toISOString(),
      })
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
    const hint = h('div', { class: 'hint', style: 'display:none' }, 'This element is not on the screen right now.')
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
      h('span', { class: 'grow' }),
      h(
        'button',
        {
          class: 'link',
          onclick: async () => {
            if (window.confirm(`Delete note N${note.n} and its thread?`)) {
              await rest(`notes/${id}`, 'DELETE')
              if (note.hasShot) {
                await rest(`shots/${id}`, 'DELETE')
              }
              closeCard()
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
      hint,
      update(next) {
        node.style.setProperty('--c', STATUS[next.status][1])
        status.value = next.status
        kind.textContent = next.kind
        const stale = Boolean(next.sha && state.meta.sha && next.sha !== state.meta.sha)
        older.textContent = stale ? `build ${next.sha}` : ''
        older.style.display = stale ? '' : 'none'
        where.replaceChildren(whereLine(next.anchor))
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
      await rest(`notes/${id}`, 'PUT', {
        ...fields,
        n: state.notes.reduce((max, note) => Math.max(max, note.n ?? 0), 0) + 1,
        status: 'open',
        kind,
        scope: everywhere.checked ? 'app' : 'page',
        createdAt: now,
        branch: state.meta.branch ?? null,
        sha: state.meta.sha ?? null,
        hasShot: shot !== undefined,
        messages: { first: { author: initials.value.trim() || 'anon', text: text.value.trim(), at: now } },
      })
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
      h('div', { class: 'chips' }, chips),
      text,
      h('label', { class: 'check' }, everywhere, 'Show on every page, not only this URL'),
      h(
        'div',
        { class: 'row' },
        initials,
        h('span', { class: 'grow' }),
        h('button', { onclick: closeComposer }, 'Cancel'),
        h('button', { class: 'primary', onclick: save }, 'Add note'),
      ),
    )
    composer = { node, element: meaningful(hit) }
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

  /** The control that opens a container: by selector, then XPath, then by name */
  function findOpener(opener) {
    const wanted = nameKey(opener.label)
    const fits = (element) =>
      element instanceof Element && (wanted === '' || nameKey(labelOf(element)) === wanted)
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
      const togglers = document.querySelectorAll(
        '[aria-expanded],[aria-controls],[aria-haspopup],[role="tab"],summary',
      )
      for (const element of togglers) {
        if (nameKey(labelOf(element)) === wanted) {
          return element
        }
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
  async function reveal(note, patience = 1500) {
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
      const element = resolve(note.anchor)
      return element !== null && isShown(element) ? element : null
    }
    let element = found()
    if (element === null) {
      const openers = [...note.anchor.containers]
        .reverse()
        .map((container) => container.openedBy)
        .filter(Boolean)
      for (const wanted of openers) {
        if (found() !== null) {
          break
        }
        const opener = await waitFor(() => findOpener(wanted), patience)
        if (opener === null || isOpen(opener)) {
          continue
        }
        opener.scrollIntoView({ block: 'nearest' })
        press(opener)
        await waitFor(() => isOpen(opener) || found() !== null, 1200)
      }
      element = await waitFor(found, patience)
    }
    if (element !== null && !visibleAt(element, note.anchor.offset)) {
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      await sleep(120)
    }
    openCard(note.id)
    lastSlow = 0
    pulseUntil = element === null ? 0 : performance.now() + 1700
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
      const opener = note.anchor.containers.find((container) => container.openedBy)?.openedBy
      const name = String(opener?.label ?? '').split(' ').slice(0, 2).join(' ')
      where = opener ? ` · inside “${name}”` : ' · not on screen'
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
        { class: 'm' },
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
      h('div', { class: 'foot' }, h('span', { class: 'grow' }), copy),
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
      for (const container of anchor.containers) {
        const label = container.label ? ` "${container.label}"` : ''
        const opener = container.openedBy ? `, opened by "${container.openedBy.label}"` : ''
        lines.push(`- Inside: ${container.role}${label}${opener}`)
      }
      if (note.trail.length > 0) {
        lines.push('- Steps before the note:')
        note.trail.forEach((entry, index) => lines.push(`  ${index + 1}. ${stepText(entry)}`))
      }
      if (note.hasShot) {
        lines.push(`- Screenshot (data URL): ${urlOf(`shots/${note.id}`)}`)
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
      /** The database may be unreachable for a moment; the stream catches up */
    }
  }

  /** Live updates: other reviewers' notes and agents' replies appear as they land */
  function subscribe() {
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
    state.meta = meta ?? {}
    renderPins()
  }).catch(() => {})
  refresh().then(() => {
    subscribe()
    let pending = null
    try {
      pending = sessionStorage.getItem(OPEN)
      sessionStorage.removeItem(OPEN)
    } catch {
      /** Nothing to reopen */
    }
    const waiting = state.notes.find((note) => note.id === pending)
    if (waiting !== undefined) {
      /** The app is still starting after the page change, so wait longer for it */
      reveal(waiting, 10_000)
    }
  })
  try {
    floatAt = JSON.parse(storage(FLOAT) || 'null')
  } catch {
    floatAt = null
  }
  makeDraggable(dock)
  window.addEventListener('resize', applyFloat)
  requestAnimationFrame(frame)
})()
