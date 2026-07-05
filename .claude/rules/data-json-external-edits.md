# Stop all servers before editing data/data.json externally

The server loads `data.json` into memory once at startup and rewrites the
whole file on every mutation (`saveData()`). Any external edit to the file
(migration script, manual fix) is silently lost the next time a running
server saves — its in-memory copy wins.

**Rule:** before running a script that modifies `data/data.json`, make sure
*no* server instance is running — including dev servers started from other
Claude Code sessions (check `lsof -nP -iTCP:3000 -sTCP:LISTEN`, and preview
servers on random ports). Back up the file first (`data/` is gitignored, so
git won't save you). Restart the server afterwards so it loads the new data.

**Why:** discovered while migrating game durations; another session's dev
server held the pre-migration data in memory and would have overwritten the
migrated file on its next save.
