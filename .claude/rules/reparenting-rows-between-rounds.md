# Moving games between rounds (#253) — three things that fail silently

`moveGames(tenant, rid, targetRid, limits)` reparents every game of one round
into another and merges the two rounds' tags by name. Three parts of it are
non-obvious, and each fails *quietly* — wrong order, wrong count, or a deadlock
under concurrency, none of which throws.

## 1. Postgres must take a FRESH `seq` per reparented row, or the backends diverge

Reads order children by `seq` (a `bigserial`), and the JSON backend appends the
moved games to the end of the target's `games` array. So a plain
`UPDATE games SET round_id = <target>` is **not** equivalent: the moved rows
keep their original `seq`, which was minted when they were first inserted. If
the source round is older than the target, they sort *before* the target's own
games instead of after them, and the two backends assemble a different round.

The fix is to update one row at a time, in the source's `seq` order, taking
`nextval(pg_get_serial_sequence('games', 'seq'))` for each. Note a bulk
`UPDATE … SET seq = nextval(…)` is *not* enough even though nextval is volatile
and evaluated per row: the row update order is unspecified, so the moved games
would land at the end in an arbitrary order among themselves.

`test/support/repo-contract.js` pins this down by asserting the exact title
order (`['Keeper', 'Tagged', 'Plain', 'Archived']`) after a move — that
assertion is the only thing standing between here and a silent ordering split
that `npm test` alone (JSON backend only) would never show.

## 2. Lock BOTH round rows in one id-ordered statement

The move writes the target round's `tags` and reads the source's, so both rows
are locked `FOR UPDATE`. Locking them in two statements — or in argument order —
lets two concurrent moves between the same pair of rounds in opposite directions
each hold the row the other wants, i.e. a deadlock. One
`whereIn('id', [rid, targetRid]).orderBy('id').forUpdate()` acquires them in a
deterministic global order, so the two transactions serialize instead.

## 3. The quota check lives in the REPO, not the route

Every other quota (`.claude/rules/per-tenant-quotas.md`) is checked in the route
before calling the data layer. This one cannot be, because the number of tags the
move would *create* in the target is only known after building the tag remap —
computing it in the route would mean duplicating the whole find-or-create-by-name
reconciliation. So the route passes `limits` (`{ maxGames, maxTags }`, or `null`
when `quota.enforced()` is false) down and the repo returns the marker
`'quota_games'` / `'quota_tags'`, which the route maps to the same
`403 { error, limit }` contract the other caps use.

The check runs **before any write**, inside the transaction, so a refusal is
genuinely atomic. That matters more here than for the other caps: a half-moved
shelf has no undo.

## Smaller things worth keeping

- **The source round's session history does not survive.** Every game moves, so
  every session's `gameIds` empties, and an empty session is dropped — the exact
  rule `deleteGame` already applies. This is inherent to "move *all* games", not
  a bug; the confirm dialog says so before the user commits.
- **A reused tag keeps the TARGET's spelling and icon.** Matching is trimmed and
  case-insensitive, but the target round is never renamed or restyled by a move —
  same reasoning as `addTag` refusing to restyle on a duplicate name (#255).
- **Unused source tags are not copied, and tags left behind are not cleaned up.**
  A tag no moved game carries has nothing to remap; a source tag whose every game
  just left is simply left in place, since nothing treats an unused round tag as
  invalid.
- **Absent-key parity survives a refusal.** The target's `tags` array is only
  written back when tags are actually created, so a quota-refused move cannot
  leave `tags: []` on a round that had no tags (the Postgres column would still
  be NULL — see `.claude/rules/postgres-backend.md`).
- **The Regal entry point is gated on `round.games.length`, not `activeGames`** —
  archived games move too, so a round holding nothing but retired games must
  still offer the action.
