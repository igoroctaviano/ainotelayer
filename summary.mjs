#!/usr/bin/env node
/**
 * ainotelayer, notes overview for a pull request. This is what the `summary`
 * action runs.
 *
 * Reads the pull request's comments, works out the notes and their status,
 * keeps ONE overview comment up to date, and sets a commit status
 * (`ainotelayer/notes`) that a repository can require before merging.
 *
 * Usage (in GitHub Actions the defaults come from the environment):
 *   GITHUB_TOKEN=... node summary.mjs --repo owner/name --pr 123
 *
 * Options:
 *   --preview-url <url>   link to the deployed preview; remembered between runs
 *   --unresolved <state>  status while notes are unresolved: pending (default),
 *                         failure, or success to never hold a merge back
 *   --no-status           only keep the overview comment; set no commit status
 *                         (the workflow then needs no `statuses: write`)
 *   --trust <who>         whose notes and status changes count: collaborators
 *                         (default; a note's author may always change their own
 *                         note) or everyone
 *   --sha <sha>           commit to put the status on (default: the pull
 *                         request's head)
 *   --api <url>           GitHub API base (default: GITHUB_API_URL)
 *   --gh                  talk to GitHub through the `gh` command and its
 *                         sign-in instead of GITHUB_TOKEN, to run it from your
 *                         own machine
 *   --dry-run             print what would be written, write nothing
 */
import fs from 'node:fs'

import { createGithub } from './github-api.mjs'
import { countNotes, describeCounts, findOverview, foldNotes, readHidden, summaryBody } from './github-notes.mjs'

const CONTEXT = 'ainotelayer/notes'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const repo = arg('repo', process.env.GITHUB_REPOSITORY ?? '')
const pull = arg('pr')
const api = arg('api')
const token = process.env.GITHUB_TOKEN ?? ''
const dryRun = process.argv.includes('--dry-run')
const useGh = process.argv.includes('--gh')
const whenUnresolved = arg('unresolved', 'pending')
const trust = arg('trust', 'collaborators')
const setStatus = !process.argv.includes('--no-status')

if (repo === '' || pull === '') {
  console.error('ainotelayer: --repo and --pr are needed (this run may not be for a pull request)')
  process.exit(1)
}
if (!['pending', 'failure', 'success'].includes(whenUnresolved)) {
  console.error('ainotelayer: --unresolved must be pending, failure or success')
  process.exit(1)
}
if (!['collaborators', 'everyone'].includes(trust)) {
  console.error('ainotelayer: --trust must be collaborators or everyone')
  process.exit(1)
}

const github = createGithub({ api, token, gh: useGh })

async function allComments() {
  const comments = []
  for (let page = 1; page <= 50; page += 1) {
    const batch = await github(`/repos/${repo}/issues/${pull}/comments?per_page=100&page=${page}`)
    comments.push(...batch)
    if (batch.length < 100) {
      break
    }
  }
  return comments
}

const comments = await allComments()
const notes = foldNotes(comments, { trust })
const counts = countNotes(notes)
const existing = findOverview(comments)
const remembered = existing === undefined ? '' : (readHidden(existing.body).data?.preview ?? '')
const previewUrl = arg('preview-url') || remembered
const body = summaryBody(notes, { previewUrl })

const unresolved = counts.unresolved > 0
const status = {
  state: unresolved ? whenUnresolved : 'success',
  context: CONTEXT,
  description: describeCounts(counts).slice(0, 140),
}

if (dryRun) {
  console.log(body)
  console.log('\n--- status ---')
  console.log(JSON.stringify(status, null, 2))
  process.exit(0)
}

/** A pull request from a fork gets a read-only token: say so, do not fail the build */
function cannotWrite(error, what) {
  if (error.status === 401 || error.status === 403 || error.status === 404) {
    console.warn(`ainotelayer: could not ${what} (${error.message}). The workflow needs "pull-requests: write" and "statuses: write", and pull requests from forks cannot write at all.`)
    return
  }
  throw error
}

/** Without a preview link and without notes there is nothing worth a comment yet */
const worthSaying = notes.length > 0 || previewUrl !== ''
let overview = existing
try {
  if (existing === undefined && worthSaying) {
    overview = await github(`/repos/${repo}/issues/${pull}/comments`, { method: 'POST', body: { body } })
    console.log(`ainotelayer: posted the notes overview: ${overview.html_url}`)
  } else if (existing !== undefined && existing.body !== body) {
    overview = await github(`/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } })
    console.log(`ainotelayer: updated the notes overview: ${overview.html_url}`)
  } else {
    console.log('ainotelayer: the notes overview is already up to date')
  }
} catch (error) {
  cannotWrite(error, 'write the notes overview')
}

/** The status is set whether or not the overview could be written */
async function writeStatus() {
  const sha = arg('sha') || (await github(`/repos/${repo}/pulls/${pull}`)).head.sha
  /** Statuses pile up on a commit, so only add one when it says something new */
  const history = await github(`/repos/${repo}/commits/${sha}/statuses?per_page=100`)
  const latest = history.find((item) => item.context === CONTEXT)
  if (latest !== undefined && latest.state === status.state && latest.description === status.description) {
    console.log(`ainotelayer: status unchanged (${status.state}: ${status.description})`)
    return
  }
  await github(`/repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: { ...status, target_url: overview?.html_url },
  })
  console.log(`ainotelayer: status ${status.state}: ${status.description}`)
}

if (setStatus) {
  try {
    await writeStatus()
  } catch (error) {
    cannotWrite(error, 'set the notes status')
  }
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `total=${counts.total}\nunresolved=${counts.unresolved}\n`)
}
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body.replace(/<!-- ainotelayer:[\s\S]*?-->/g, '')}\n`)
}
