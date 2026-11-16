/**
 * ainotelayer source stamping.
 *
 * A pass over a .jsx/.tsx/.js file that runs before the app's own compiler and
 * tags every JSX element with where it is written, so a note pinned to an
 * element can say which file and line to open.
 *
 *   <button>            ->  <button data-anl-src="Toolbar@src/Toolbar.tsx:12:5">
 *   <Switch checked />  ->  <Switch data-anl-use="Panel@src/Panel.tsx:40:9" checked />
 *
 * data-anl-src goes on DOM elements and says where the element is written.
 * data-anl-use goes on components and says where the component is used; React
 * keeps it as a prop, and components that pass their props down put it on the
 * DOM too. The value is `<enclosing component>@<file>:<line>:<column>`.
 *
 * It does not depend on the bundler or on the app's compiler (Babel, SWC, oxc).
 * vite.mjs and webpack.cjs wrap it for each bundler family.
 */
import path from 'node:path'

import { parse } from '@babel/parser'
import MagicString from 'magic-string'

export const SRC = 'data-anl-src'
export const USE = 'data-anl-use'

/** React built-ins that accept no extra props, or warn about them */
const BUILT_IN = new Set([
  'Fragment',
  'React.Fragment',
  'StrictMode',
  'React.StrictMode',
  'Suspense',
  'React.Suspense',
  'Profiler',
  'React.Profiler',
])
const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'errors',
  'comments',
  'tokens',
])

/** Files worth looking at: JSX can live in .jsx, .tsx and, in older code, .js */
export function isStampable(file) {
  return /\.(jsx|tsx|js|mjs)$/.test(file) && !/[\\/]node_modules[\\/]/.test(file)
}

/** Path shown in notes: relative to the repo root, with forward slashes */
export function labelFor(file, root) {
  return path.relative(root, file).split(path.sep).join('/')
}

function elementName(node) {
  if (node.type === 'JSXIdentifier') {
    return node.name
  }
  if (node.type === 'JSXMemberExpression') {
    return `${elementName(node.object)}.${elementName(node.property)}`
  }
  if (node.type === 'JSXNamespacedName') {
    return `${node.namespace.name}:${node.name.name}`
  }
  return ''
}

/** A DOM element (`div`, `svg:rect`, `my-widget`), as opposed to a component */
function isDomElement(node) {
  if (node.type === 'JSXNamespacedName') {
    return true
  }
  return node.type === 'JSXIdentifier' && /^[a-z]/.test(node.name)
}

/** The name a function or class is known by, when the node introduces one */
function ownerName(node) {
  if (
    (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
    node.id != null
  ) {
    return node.id.name
  }
  if (
    node.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    node.init != null &&
    ['ArrowFunctionExpression', 'FunctionExpression', 'CallExpression', 'ClassExpression'].includes(
      node.init.type,
    )
  ) {
    return node.id.name
  }
  return null
}

/**
 * Returns `{ code, map, count }`, or null when the file has no JSX to stamp or
 * cannot be parsed (the app's own compiler will report real syntax errors).
 *
 * `options.label` is the path written into the stamps; it defaults to `file`.
 */
export function stamp(code, file, options = {}) {
  if (!code.includes('<')) {
    return null
  }
  if (/\.(js|mjs)$/.test(file) && !code.includes('</') && !code.includes('/>')) {
    return null
  }
  const plugins = ['jsx', 'decorators-legacy', 'importAttributes']
  if (/\.tsx$/.test(file)) {
    plugins.push('typescript')
  }
  let ast
  try {
    ast = parse(code, { sourceType: 'unambiguous', sourceFilename: file, plugins })
  } catch {
    return null
  }

  const label = options.label ?? file
  const fallbackOwner = path.basename(file).replace(/\.[^.]+$/, '')
  const output = new MagicString(code)
  let count = 0

  function tagElement(opening, owners) {
    const name = elementName(opening.name)
    if (name === '' || BUILT_IN.has(name) || /\.(Provider|Consumer)$/.test(name)) {
      return
    }
    const attribute = isDomElement(opening.name) ? SRC : USE
    const has = opening.attributes.some(
      (item) => item.type === 'JSXAttribute' && item.name.name === attribute,
    )
    if (has) {
      return
    }
    /** Prefer the nearest name that looks like a component */
    const owner =
      owners.findLast((item) => /^[A-Z]/.test(item)) ?? owners[owners.length - 1] ?? fallbackOwner
    const { line, column } = opening.loc.start
    const generics = opening.typeParameters ?? opening.typeArguments
    const position = generics != null ? generics.end : opening.name.end
    output.appendLeft(position, ` ${attribute}="${owner}@${label}:${line}:${column + 1}"`)
    count += 1
  }

  function walk(node, owners) {
    if (node === null || typeof node !== 'object') {
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, owners)
      }
      return
    }
    if (typeof node.type !== 'string') {
      return
    }
    const name = ownerName(node)
    const inner = name === null ? owners : [...owners, name]
    if (node.type === 'JSXOpeningElement') {
      tagElement(node, inner)
    }
    for (const key of Object.keys(node)) {
      if (!SKIP_KEYS.has(key)) {
        walk(node[key], inner)
      }
    }
  }

  walk(ast.program, [])
  if (count === 0) {
    return null
  }
  return {
    code: output.toString(),
    map: output.generateMap({ source: file, hires: 'boundary', includeContent: false }),
    count,
  }
}
