/**
 * Checks for the source-stamping pass. Run with `npm test`.
 *
 * Set STAMP_SWEEP to one or more folders (separated by `:`) to also run the
 * pass over every source file in real apps and report what it could not read.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { isStampable, labelFor, stamp } from '../stamp.mjs'

function run(code, file = '/repo/src/Panel.tsx') {
  return stamp(code, file, { label: labelFor(file, '/repo') })
}

test('a DOM element says where it is written, and in which component', () => {
  const out = run('export function Panel() {\n  return <div className="a">hi</div>\n}\n')
  assert.match(out.code, /<div data-anl-src="Panel@src\/Panel\.tsx:2:10" className="a">/)
  assert.equal(out.count, 1)
})

test('a component says where it is used', () => {
  const out = run('const Panel = () => <Switch checked />\n')
  assert.match(out.code, /<Switch data-anl-use="Panel@src\/Panel\.tsx:1:21" checked \/>/)
})

test('member components and motion-style elements count as components', () => {
  const out = run('function A() { return <Dialog.Root><motion.div /></Dialog.Root> }')
  assert.match(out.code, /<Dialog\.Root data-anl-use=/)
  assert.match(out.code, /<motion\.div data-anl-use=/)
})

test('fragments, providers and other built-ins are left alone', () => {
  const out = run(
    'function A() { return <><React.Fragment><Ctx.Provider value={1}><Suspense><p /></Suspense></Ctx.Provider></React.Fragment></> }',
  )
  assert.equal(out.count, 1)
  assert.match(out.code, /<p data-anl-src=/)
  assert.doesNotMatch(out.code, /Fragment data-anl|Provider data-anl|Suspense data-anl/)
})

test('the stamp goes after TypeScript type arguments', () => {
  const out = run('function A() { return <Select<string> value="a" /> }')
  assert.match(out.code, /<Select<string> data-anl-use="A@src\/Panel\.tsx:1:23" value="a" \/>/)
})

test('the nearest component-looking name wins over helpers inside it', () => {
  const out = run('function Table() {\n  const rows = items.map((item) => <tr key={item} />)\n  return rows\n}')
  assert.match(out.code, /data-anl-src="Table@/)
})

test('a file without a named owner falls back to the file name', () => {
  const out = run('export default () => <main />', '/repo/src/pages/Home.tsx')
  assert.match(out.code, /data-anl-src="Home@src\/pages\/Home\.tsx:1:22"/)
})

test('an element that already carries a stamp is not stamped twice', () => {
  const once = run('function A() { return <div><span /></div> }')
  assert.equal(run(once.code), null)
})

test('files with no JSX, and files that do not parse, are passed through', () => {
  assert.equal(run('export const a = 1 < 2', '/repo/src/a.js'), null)
  assert.equal(run('const a = <T,>(x: T) => x', '/repo/src/a.tsx'), null)
  assert.equal(run('function A() { return <div> }', '/repo/src/broken.tsx'), null)
})

test('JSX in plain .js files is stamped', () => {
  const out = run('export function Old() { return <div/> }', '/repo/src/Old.js')
  assert.match(out.code, /<div data-anl-src="Old@src\/Old\.js:1:32"\/>/)
})

test('a source map comes with the result', () => {
  const out = run('function A() { return <div /> }')
  assert.equal(typeof out.map.mappings, 'string')
  assert.ok(out.map.mappings.length > 0)
})

test('node_modules and non-script files are not considered', () => {
  assert.equal(isStampable('/repo/node_modules/x/index.jsx'), false)
  assert.equal(isStampable('/repo/src/a.ts'), false)
  assert.equal(isStampable('/repo/src/a.tsx'), true)
})

function sourceFiles(folder) {
  const found = []
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'build', '.git', 'coverage'].includes(entry.name)) {
        found.push(...sourceFiles(full))
      }
    } else if (/\.(jsx|tsx)$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

for (const folder of (process.env.STAMP_SWEEP ?? '').split(':').filter(Boolean)) {
  test(`sweep: every .jsx/.tsx file under ${folder}`, () => {
    const files = sourceFiles(folder)
    let stamped = 0
    let stamps = 0
    const unread = []
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8')
      const out = stamp(code, file, { label: labelFor(file, folder) })
      if (out !== null) {
        stamped += 1
        stamps += out.count
      } else if (/<[A-Za-z][^>]*>/.test(code) && /<\/|\/>/.test(code)) {
        unread.push(labelFor(file, folder))
      }
    }
    console.log(
      `  ${folder}: ${files.length} files, ${stamped} stamped, ${stamps} stamps, ${unread.length} with JSX-looking code left unstamped`,
    )
    for (const file of unread.slice(0, 15)) {
      console.log(`    unstamped: ${file}`)
    }
  })
}
