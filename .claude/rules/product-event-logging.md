# Product-usage events (trackEvent, issue #261) — the allowlist is the point

`lib/observability.js` exports **`trackEvent(name, { tenantId })`**: a handful of
"a user did X" events written as ordinary structured log lines through the
existing pino logger (#212), which already goes to stdout and therefore to
Railway's log search. There is **no analytics service, no database table, no
client-side script, no cookie, no beacon** — deliberately (see #261's options
analysis). Don't turn this into one without revisiting that decision.

## The events

`round_created` · `session_created` · `session_finished` · `game_added` ·
`tag_created` — the set is the `EVENTS` allowlist in `lib/observability.js`. An
unknown name is **dropped** and logged as `unknown_product_event`, so a typo
can't silently create a new event stream. Adding an event means adding it to
`EVENTS` *and* to this list.

(#261 also specified a `recommendation_run` event. It was **not** implemented:
buy-next and all AI surface were removed in #264, so it has no call site.)

## The two rules, and why they're enforced in code

- **Fields are `event` + `tenantId`, and nothing else.** `trackEvent` ignores
  any other property passed to it rather than logging it. That's not
  over-engineering — it makes "just one more field" impossible to add by
  accident at a call site, so a game title, member name, e-mail, rating comment
  or any other free text can never reach the logs. This is GDPR data
  minimisation, and the same allowlist discipline `requestLogger`'s
  `customProps` already enforces for HTTP lines (method/path/status/duration/ip
  only, never bodies, query strings, headers or cookies). Widening it means
  editing `trackEvent` and this file, on purpose.
- **Call it AFTER the repo mutation resolves, never before**, so a failed or
  rejected mutation can't log an event that didn't happen.

Two call sites have a condition that is easy to get wrong when editing them:

- **`tag_created` fires only for a genuinely new name.** `POST …/tags` dedupes
  by trimmed, case-insensitive name and returns the *existing* tag for a
  duplicate — still a `201`. Logging on every `201` would inflate the count with
  re-picks of an existing tag. The route already computes `exists` for the quota
  check; reuse it.
- **`session_finished` fires only when `finished === true`.** `POST …/:sid/finish`
  is also the **un**-finish route (`finished: false`), which must not count.
- `session_created` has **two** exit points (direct-pick and draw) — both are one
  created session, so both log.

## Privacy / legal position

This is pure server-side logging of requests the server already handles, so it
does **not** touch the TDDDG §25 consent question (`docs/production-readiness.md`
§9.3): nothing is stored on the visitor's device. It falls under the *existing*
server-log disclosure already scoped into #140 §9.2 — no new privacy-policy
category, just more lines of the same kind.

## Reading them as the operator

There is no query tool and none is planned at this size. On Railway, use the
service's **log search** (or `railway logs`) and filter on the JSON field, e.g.
search `"event":"round_created"`. Each line is
`{ ts, level:'info', event:'<name>', tenantId:'<id>' }`. Only events from #261
forward exist — there is **no historical backfill**.

`LOG_LEVEL` gates these like every other line (they log at `info`), so
`LOG_LEVEL=warn` or `silent` turns them off — which is exactly what the test
suite does.
