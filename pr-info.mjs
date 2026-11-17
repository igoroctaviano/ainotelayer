#!/usr/bin/env node
/**
 * ainotelayer, facts about a pull request for a workflow that was not started
 * by one (a manually run workflow only has the number). This is what the
 * `pull-request` action runs, and what the main action uses to find the branch
 * and commit that were built.
 *
 * Usage:
 *   GITHUB_TOKEN=... node pr-info.mjs --repo owner/name --pr 123
 *
 * It refuses a pull request from a fork, because a workflow that builds one
 * runs that fork's code next to the repository's secrets. Pass --allow-forks
 * when nothing secret is in reach.
 *
 * Prints `sha=`, `ref=` and `fork=` lines. In GitHub Actions it also writes
 * them, and the pull request's description as `body`, to the step's outputs.
 *
 * Options:
 *   --allow-forks   do not refuse a pull request from a fork
 *   --api <url>     GitHub API base (default: GITHUB_API_URL)
 *   --gh            go through the `gh` command instead of GITHUB_TOKEN
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createGithub } from './github-api.mjs'

/** The parts of a pull request a build needs, from GitHub's own description of it */
export function describePullRequest(pull) {
  return {
    sha: pull.head.sha,
    ref: pull.head.ref,
    /** A fork's branch lives in another repository than the one it targets */
    fork: pull.head.repo?.full_name !== pull.base.repo?.full_name,
    state: pull.state,
    body: pull.body ?? '',
  }
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

async function main() {
  const repo = arg('repo', process.env.GITHUB_REPOSITORY ?? '')
  const number = arg('pr')
  if (repo === '' || !/^\d+$/.test(number)) {
    console.error('ainotelayer: --repo and a numeric --pr are needed')
    process.exit(1)
  }
  const github = createGithub({
    api: arg('api'),
    token: process.env.GITHUB_TOKEN ?? '',
    gh: process.argv.includes('--gh'),
  })
  const info = describePullRequest(await github(`/repos/${repo}/pulls/${number}`))
  if (info.fork && !process.argv.includes('--allow-forks')) {
    console.error(`::error::Pull request #${number} comes from a fork. It is not built here, because the build would run its code next to this repository's secrets.`)
    process.exit(1)
  }
  console.log(`sha=${info.sha}\nref=${info.ref}\nfork=${info.fork}`)
  if (process.env.GITHUB_OUTPUT) {
    /** A description can hold anything, so it goes between markers nobody can guess */
    const marker = `ainotelayer-${randomUUID()}`
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `sha=${info.sha}\nref=${info.ref}\nfork=${info.fork}\nbody<<${marker}\n${info.body}\n${marker}\n`,
    )
  }
}

/** Run only as a script, not when a test imports describePullRequest */
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
