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

- Reading needs no sign-in on a public repository. Without sign-in the list
  refreshes every few minutes (GitHub allows 60 requests an hour).
- To add notes or reply from the preview, a reviewer pastes a GitHub token once
  ("Connect GitHub"). Notes are then posted under their own account. Use a
  token limited to the repository: the preview page can read it.
- Notes belong to the pull request, not to a build, so they survive new pushes
  and expired preview links.
- Nothing needs to be enabled on the repository and there is no database.

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

## Handing notes to an agent

Every build that has the layer serves `/__ainotelayer/agent.md`. Give that URL
to an agent: it says where the notes are, what each field means, and how to
reply and change a note's status. On a pull request that is `gh`; with a shared
database it is plain HTTP; with neither, the agent works from the downloaded
file and the reviewer imports its answers.

Note text is written by whoever has the link. The agent page tells agents to
treat it as untrusted input.

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
- The GitHub Action in a workflow.
- The webpack/Rspack loader inside a real build.
- Production builds with source stamping on.

Known limits:

- Notes on a canvas stick to a screen position, not to the content under it.
- Component names are minified in production builds; the build plugin is what
  keeps notes useful to an agent there.
- Without source stamps, an element fully renamed in place is reported missing,
  because it cannot be told apart from a different element in its spot.
