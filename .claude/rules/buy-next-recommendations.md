# Buy-next recommendations (routes/recommendations.js) — why it's shaped this way

Issue #101 implemented the "what should this round buy next?" feature analyzed
in issue #42. The design decisions aren't obvious from the code alone:

- **Two layers, not one.** Layer A (`public/js/buynext.js`) is a local,
  always-on heuristic: it resurfaces highly-rated, rarely-played *owned* games
  — no network, no key, zero privacy/cost. Layer B (`routes/recommendations.js`)
  is an opt-in LLM call that names real *unowned* titles to consider buying.
  Layer A is the floor and fallback; Layer B only fires on a button press and
  degrades silently (no key → `503 not_configured`; upstream failure/timeout →
  `502 provider_unreachable`) so a missing/broken LLM call never breaks the app.

- **Why an LLM and not a game-database API.** This was evaluated and rejected:
  there is **no key-free BoardGameGeek "similar games" endpoint** — BGG's XML
  API2 is token-gated since 2025-07-02 (see
  `.claude/rules/add-game-lookup-provider.md`) and its public JSON
  (`api.geekdo.com/api/geekitems`) returns item detail, not recommendations.
  **RAWG** exposes a real "suggested" endpoint but requires an API key, covers
  **digital games only**, and uses ids unrelated to the ones this app already
  stores (`psstore`/`steam`/`nintendo`/`xbox`), needing an extra id-resolution
  hop. Since the app's core is board games, any API-grounded approach leaves
  the analog half uncovered — an LLM given a taste profile is the only path
  that recommends both game types with one mechanism.

- **The payload is a taste profile, not raw data.** The route aggregates
  top/bottom-rated titles, the typical player-count range, and the current
  collection (so it isn't re-suggested) — **never member names or ids**. (Since
  #242 the profile no longer carries a platform/duration/type dimension — those
  fields were retired from the game model, so the buy-next call is a generic
  board-or-digital recommender with no per-platform targeting or store links.)
  This is a deliberate, user-authorised exception to the "no cloud services
  unless asked" default; keep the anonymization when touching this route, it's a
  privacy feature, not a nicety.

- **Results are a history, not a single cache slot.** Runs are appended to
  `round.recommendationRuns` (newest first, issue #115) rather than
  overwriting the last, so a group can page back through past generations and
  delete ones they don't want. A pre-#115 single `round.recommendations`
  object (if present in old data) is folded into this array on first write
  (`ensureRuns`) — there is no standalone migration script, consistent with
  `CLAUDE.md`'s "no permanent migration code" stance.

- **Hallucination is an accepted risk, not solved.** The model may name a
  wrong or non-existent title. Mitigated by prompting for well-known titles
  and framing results as "suggestions to look into," not by grounding against
  a candidate list — full grounding was evaluated (Approach 4 in the original
  analysis) and rejected for the same reason as Approach 1: no key-free
  board-game candidate source exists.

- **Testing must never hit the real API** — see
  `.claude/rules/no-real-llm-calls-in-tests.md`.

**Why this file replaced `docs/recommendations-analysis.md`:** that document
was the full issue #42 evaluation (~320 lines scoring four approaches);
useful once, while the decision was being made, but it grew stale the moment
#101 shipped and issue #115 changed the caching shape it had recommended.
This file keeps only the reasoning that still matters for someone touching
the code today. The full historical analysis is preserved in git history
(see the commit that removed `docs/recommendations-analysis.md`) if the
original approach comparison is ever needed again.
