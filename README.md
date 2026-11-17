# ainotelayer

Pin notes to any element of a running web app, discuss them in threads, and hand
them to an AI agent that can find the element in the code and answer.

It is meant for reviewing a branch or a pull-request preview: instead of a
shared document full of screenshots and "the button on the right", reviewers
right-click the real app and leave the note on the thing itself.

> Early software. See [Status](#status) for what has and has not been tried.

## What a note holds

- The thread: who said what, a kind (Change, Bug, Question, Research) and a
  status (Open, Fix in place, Resolved).
- Where the element is: XPath, selector, visible name, React component chain.
- What it sat inside at the time (dialog, menu, tab, collapsed section) and the
  control that opened each one.
- The reviewer's steps before the note: clicks, value changes, zooms, shortcuts.
- With the build plugin: the source file and line, linked to the build's commit.
- For canvas viewers: a picture of the viewport with the spot marked.

## Using it

- **Right-click** anything to add a note. Shift+right-click keeps the browser's
  own menu.
- Pins sit dimmed on their elements. Click one to open its thread; the element
  is outlined.
- The **Notes** pill lists every note in the app. Drag it anywhere. Clicking a
  note goes to its page, opens whatever the element sits inside, and shows it.
- **Re-attach** on a note points it at a different element.
- **Download** and **Import** move notes as a JSON file.

## Run it on a dev server

No change to the app is needed. A small proxy adds the layer to whatever is
running:

```bash
node server.mjs --target http://localhost:3000 --port 3200 --repo /path/to/app
```

Open `http://localhost:3200`. Notes are stored in `notes/`, one JSON file per
repository and branch.

Add `--pr 123` to use the notes of that pull request instead (see below), so a
local run and the deployed preview show the same notes.

## Add it to a built app

Any static build output works. Run this after the build and before the deploy:

```bash
node inject.mjs --dir build --app myapp --key pr-123
```

Or as a GitHub Action:

```yaml
- uses: igoroctaviano/ainotelayer@main
  with:
    dir: build
```

In a pull-request workflow that is all: notes are kept on the pull request.

[examples/firebase-preview.yml](examples/firebase-preview.yml) is a full
pull-request preview workflow.

## Where notes are stored

| Setup | Notes live in | Shared between reviewers |
|---|---|---|
| A pull request (`--github owner/name --pr 123`; automatic in the action) | Comments on that pull request | Yes |
| Nothing configured | Each reviewer's browser (`localStorage`) | By Download and Import |
| `--db` / `database-url` | A Firebase Realtime Database | Yes, live |
| `server.mjs` | Files in `notes/` | Everyone using that server |

### On the pull request

Each note is a comment on the pull request: a readable summary, with the
note's data in a hidden block. A reply or a status change is one more comment
that starts with the note's number, so people and agents can answer from GitHub
itself:

```
N3: fixed in abc1234 [fix in place]
```

- A status tag (`[open]`, `[fix in place]`, `[resolved]`) counts only at the
  very start or the very end of a comment, so a sentence or a link that
  happens to contain one changes nothing.
- A note keeps its number for good, also when other notes are deleted.
- Only collaborators on the repository, and a note's own author, can change a
  note's status or where it points. From anyone else the reply is kept and the
  change is ignored.
- Reading needs no sign-in on a public repository. Without sign-in the list
  refreshes every few minutes (GitHub allows 60 requests an hour).
- To add notes or reply from the preview, a reviewer pastes a GitHub token once
  ("Connect GitHub"). Notes are then posted under their own account. Use a
  token limited to the repository: the preview page can read it.
- Notes belong to the pull request, not to a build, so they survive new pushes
  and expired preview links.
- Nothing needs to be enabled on the repository and there is no database.

### Overview and merge status

```yaml
- uses: igoroctaviano/ainotelayer/summary@main
  with:
    preview-url: ${{ steps.deploy.outputs.details_url }}
```

keeps one overview comment on the pull request up to date ("2 of 5
unresolved", each note with its status and a link) and sets a commit status,
`ainotelayer/notes`: pending while notes are open or have a fix in place,
success once all are resolved. Require that status in the branch protection
rules to hold merges back until the notes are dealt with.

Run it after the deploy, and from a second workflow on `issue_comment` so the
status follows the conversation:
[examples/preview-notes.yml](examples/preview-notes.yml). The workflow needs
`pull-requests: write` and `statuses: write`. With `status: false` it only
keeps the overview comment and needs no `statuses: write`.

Notes from people without write access to the repository are shown in the
preview and listed apart in the overview, but they do not count toward the
status, so a stranger cannot hold a merge back or wave one through. Set
`trust: everyone` to count every commenter.

### In a database

For the shared database, deploy [database.rules.json](database.rules.json) to a
Firebase project and pass its URL. Builds with the same `key` share their
notes, so a pull request keeps its notes across pushes. Pass a `salt` so the
review id cannot be guessed.

**Anyone who has the preview link can read and write those notes.** Do not use
the shared database with private data.

Do not add the layer to production builds.

## Notes that name the source file

Add the build plugin to the app once. It does nothing unless the build runs
with `AINOTELAYER=1`.

```bash
npm install --save-dev github:igoroctaviano/ainotelayer
```

Vite, Rollup, Rolldown:

```js
import ainotelayer from 'ainotelayer/vite'

export default { plugins: [ainotelayer(), react()] }
```

webpack, Rspack:

```js
const { ainotelayerRule } = require('ainotelayer/webpack')

module.exports = { module: { rules: [ainotelayerRule() /* , ...your rules */] } }
```

Then build with `AINOTELAYER=1`. Each JSX element is tagged with where it is
written (`data-anl-src`) and each component with where it is used
(`data-anl-use`).

For a Vite app this also works without touching the app: in CI, the `stamp`
action wraps the app's own Vite config from outside.

```yaml
- id: stamp
  uses: igoroctaviano/ainotelayer/stamp@main
- run: npm run build -- --config "${{ steps.stamp.outputs.config }}" --configLoader native
```

It needs Node 22.18 or newer when the app's Vite config is TypeScript.

## Only when asked: a manually run preview

To keep ordinary previews as they are, add a manual trigger with the pull
request number as an input, and run the notes steps only then:

```yaml
on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request to build a preview with notes for
        required: true
        type: number

# ...
steps:
  # Finds the commit to check out; refuses pull requests from forks.
  - id: pr
    uses: igoroctaviano/ainotelayer/pull-request@main
    with:
      pr: ${{ inputs.pr }}
  - uses: actions/checkout@v4
    with:
      ref: ${{ steps.pr.outputs.sha }}

  # ... your own setup and install ...

  - id: stamp
    uses: igoroctaviano/ainotelayer/stamp@main
  - run: npm run build -- ${{ steps.stamp.outputs.args }}

  - uses: igoroctaviano/ainotelayer@main
    with:
      dir: build
      pr: ${{ inputs.pr }}

  # ... deploy `build` to a channel of its own ...

  - uses: igoroctaviano/ainotelayer/summary@main
    with:
      pr: ${{ inputs.pr }}
      preview-url: <the deployed URL>
```

These can also be steps in an existing preview workflow, guarded with
`if: github.event_name == 'workflow_dispatch'`, so the build is not copied.
Notes belong to the pull request, so running it again after new pushes gives
a fresh preview with the same notes. GitHub only offers manually run workflows
that exist on the default branch.

## Handing notes to an agent

Every build that has the layer serves `/__ainotelayer/agent.md`. Give that URL
to an agent: it says where the notes are, what each field means, and how to
reply and change a note's status. On a pull request that is `gh`; with a shared
database it is plain HTTP; with neither, the agent works from the downloaded
file and the reviewer imports its answers.

Note text is written by whoever has the link or can comment. The agent page
tells agents to treat it as untrusted input, and the layer treats it the same
way: going to a note only ever presses show/hide controls (never a button a
note happens to name), and a link to a note never changes page by itself.

## When the UI changes

A note is matched to its element by score across everything it recorded, so it
survives reordering, new wrappers and small renames. A note that is recognised
somewhere else, or renamed in place, is shown with a dashed pin for the
reviewer to confirm. A note whose element cannot be found is flagged "needs
re-check" in the list.

## Tests

```bash
npm test
```

runs the source-stamping tests. Set `STAMP_SWEEP=/path/to/app/src` to also run
the pass over a real codebase.

`test/anchors.html` checks note matching against simulated UI changes, and
`test/github.html` checks how notes are rebuilt from pull-request comments:
serve the repository folder with any static server and open the pages.

How notes are written to and read from comments lives in one file,
`github-format.js`, used by the overlay and by CI.
`test/fixtures/pr-comments.json` holds the scenarios both are checked against.

`node server.mjs --pr 1 --mock-github ...` runs against a simulated GitHub
(tokens are `mock-<login>`), to try the pull-request store without touching a
real one.

`test/rules-test.py` checks the database rules against the Firebase emulator
(`firebase emulators:start --only database`, which needs Java 21 or newer).

## Status

Tried:

- The proxy, the injector, browser storage and the shared store, on a real
  React app (Vite, React 19).
- The pull-request store against a simulated GitHub, and reading a real pull
  request without sign-in.
- The database rules, on the Firebase emulator.
- Source stamping on a Vite dev server; the stamping pass on about 800
  component files from two apps without a parse failure.

Not tried yet:

- A real Firebase project.
- Writing to a real pull request from the preview with a pasted token.
- The comment-triggered refresh of the overview (it only runs once the
  workflow is on the default branch).
- The GitHub Action in a workflow.
- The webpack/Rspack loader inside a real build.
- Production builds with source stamping on.

Known limits:

- Notes on a canvas stick to a screen position, not to the content under it.
- Component names are minified in production builds; the build plugin is what
  keeps notes useful to an agent there.
- Without source stamps, an element fully renamed in place is reported missing,
  because it cannot be told apart from a different element in its spot.
