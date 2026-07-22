# Two unique indexes, one 23505: the constraint name is NOT the one you check first

`users` carries two unique indexes — `users_email_idx` and, since #320,
`users_username_idx` on `lower(data->>'username')`. `createUser`
(`lib/repo/postgres.js`) has to say *which* handle was taken, because the two
answers have opposite disclosure rules:

- `username_taken` is returned **openly** (409) — a username is a public
  identifier by design.
- `email_taken` is deliberately **hidden** behind `{ ok: true }`
  (`routes/account.js` anti-enumeration).

So mapping a violation to the wrong one is not cosmetic: answering
`email_taken` for a taken username turns the open error into a probe for the
hidden one ("register with a username you know is taken; a 409 means the
address is free, `{ ok: true }` means it exists").

## The trap

A failed INSERT reports **exactly one** `e.constraint`, and when the row
violates **both** indexes, which one it names is not the order your code checks.
Measured against Postgres 16 on this schema:

| Colliding on | `e.code` | `e.constraint` |
|---|---|---|
| username only | 23505 | `users_username_idx` |
| e-mail only | 23505 | `users_email_idx` |
| **both** | 23505 | **`users_email_idx`** |

The obvious shape —
`return e.constraint === 'users_username_idx' ? 'username_taken' : 'email_taken'`
— is therefore correct for two rows out of three and silently wrong for the
third. Nothing throws; registration just answers `{ ok: true }` where it owed a
409.

## The rule

Never let a single constraint name be the *only* evidence when several unique
indexes can fire at once and the answers are not interchangeable. Two layers:

1. **Check the sensitive one explicitly, before the INSERT.** `createUser`
   resolves `getUserByUsername(...)` first, so the ordinary (non-racing) path
   never depends on error parsing at all. Both backends order it the same way —
   the JSON backend's two `some(...)` checks exist in that order for this
   reason, not by accident.
2. **On 23505, re-read rather than guess.** `users_username_idx` is trusted when
   named; otherwise the username is looked up again and decides. This runs only
   on the error path, so it costs nothing in the normal case, and it makes the
   ordering guarantee hold *in the race window the catch block exists for* —
   which is the only window that reaches it at all.

`test/support/repo-contract.js` pins the guarantee in both backends
("a taken username outranks a taken e-mail…"), and `test/account.test.js` pins
the HTTP shape. Neither reaches the catch branch (the pre-check short-circuits
first), so if you change that branch, verify it the way it was verified
originally: insert straight through knex to bypass the pre-check and observe
what the mapping resolves to.

**Related:** `.claude/rules/user-accounts.md` (the anti-enumeration invariants
this protects), `.claude/rules/postgres-backend.md` (the backend's other
error-mapping and parity gotchas).
