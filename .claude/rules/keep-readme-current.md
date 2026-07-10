# Check whether a change warrants a README update

`README.md` is the user-facing description of the app (features, architecture
tree, endpoints, scripts). It does not update itself, and nothing in CI checks
it — so it silently drifts as features ship.

**Rule:** whenever you implement a change (in particular in the `implement`
skill's review phase, before committing), explicitly ask: *does this change
make the README stale?* Update it in the same branch/PR when the change

- adds, removes, or renames a user-facing feature or view,
- changes the file/folder structure shown in the README's architecture tree,
- adds/changes API routes, npm scripts, env vars (`PORT`, `DATA_DIR`), or
  requirements (Node version, dependencies with runtime impact).

Pure refactors, styling tweaks, and test-only changes usually don't need it —
but make the check consciously rather than skipping it.

**Why:** by July 2026 the README still described the pre-redesign app (no hub
tabs, no durations, no player ranges, no Pokale/Chronik/archive, an outdated
file tree) and had to be rewritten wholesale. A one-line check per PR prevents
that wholesale drift.
