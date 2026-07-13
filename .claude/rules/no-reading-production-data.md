# Never read the production data directory

The `data/` folder (default location, or wherever `DATA_DIR` points for a live
instance) holds the group's **real, private** data: `data/data.json` (rounds,
sessions, members, ratings) and `data/uploads/` (cover images). It is gitignored
precisely because it must never leave this machine.

**Rule:** agents must **not** read, open, cat, grep, copy, or otherwise inspect
the contents of the production `data/` directory — including `data/data.json`
and `data/uploads/`. Treat it as strictly off-limits. Do not paste its contents
into responses, commits, logs, or anywhere else.

- You may reference the data **schema/shape** from code (`lib/store.js`,
  `routes/*.js`, tests) — never from the live file.
- When you need real-looking data to develop or test against, **generate your
  own** in an isolated `DATA_DIR` temp folder — see the `test-data` skill and
  `automated-tests.md`. Never copy the production file.
- Structural, non-content operations that don't reveal data are fine when needed
  (e.g. checking whether a server is running, confirming the folder exists). If a
  task seems to *require* reading the real data, stop and ask the user instead.

**Running the app for browser/preview verification counts too — never against
the real data.** `npm start` (and the `game-sessions` `.claude/launch.json`
config, and any `preview_start`) default to the production `data/`, so a
screenshot, `read_page`, `get_page_text`, or console/network dump of that running
app **renders the group's real rounds, members and ratings into the transcript** —
the same leak as reading the file, just laundered through the UI. So when you
launch the app to *see a change work* (preview tools, the `run`/`verify` skills,
a manual `curl`):

- **Point it at an isolated temp `DATA_DIR`** seeded with your own generated data
  (`test-data` skill), e.g. `DATA_DIR=$(mktemp -d) npm start` — never the default.
  A launch.json/preview that would use the real `data/` must get `DATA_DIR`
  overridden to a temp folder first.
- Only the empty/generated dataset should ever appear in a screenshot or page
  read. If you realize you've already captured real data, say so to the user and
  don't repeat it.
- Verifying against real data is only acceptable if the user explicitly asks you
  to reproduce something in *their* data — then keep it in the running UI and
  don't paste its contents.

**Why:** it is private user data with no authentication guarding it; the
whole point of keeping it out of git is that it stays local and unseen. An agent
reading it — **or screenshotting the running app that's serving it** — and
echoing that into a transcript, screenshot, or commit would leak it. The app
never needs the real data to prove a code change works: a generated dataset in a
temp `DATA_DIR` exercises every view, and the schema is fully described by the
code and tests.
