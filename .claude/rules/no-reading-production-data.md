# Never read the production data directory

The `data/` folder (default location, or wherever `DATA_DIR` points for a live
instance) holds the family's **real, private** data: `data/data.json` (rounds,
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

**Why:** it is private household data with no authentication guarding it; the
whole point of keeping it out of git is that it stays local and unseen. An agent
reading it (and possibly echoing it into a transcript, screenshot, or commit)
would leak it. The app never needs an agent to look inside the file to work on
the code — the schema is fully described by the code and tests.
