# Analysis: "which games should this round buy next?"

> Status: **analysis + decision** (issue #42). This document produces a
> recommendation and a follow-up implementation issue — **no feature code ships
> from #42 itself.** Everything below is grounded in the code as it stands on
> `main` (post-#41).

## 1. The question

Each gaming round already tells the app a lot about its own taste: per-game
average ratings, how often a game is picked vs. flagged for retirement, and the
shape of what it owns (analog/digital, duration, player counts). None of that
currently feeds back into **"what should we get next?"**. This is a natural,
high-value step that turns the app from a bookkeeping tool into one that actively
helps a group grow its collection well.

The goal here is to weigh **all** viable ways to produce buy-next
recommendations, against the app's hard constraints (local-only, no auth, no
build step, no framework, no database, small single-group data — simple and
readable over clever), and land on one concrete approach to implement.

## 2. Signals the app already has

No new data collection is needed to get value. Everything below is already in the
store and read by existing code.

### 2.1 Per-game rating & play signals — `gameStats`

`gameStats(round, gameId)` in [`public/js/core.js`](../public/js/core.js) (≈L129)
computes, **on demand from sessions**, for one game:

```js
{ avg, count, sortCount, sessions, votesCast }
```

- `avg` — mean of the numeric 1–5 ratings cast for this game (or `null`).
- `count` — number of numeric ratings.
- `sortCount` — number of "retire" (Aussortieren) votes.
- `sessions` — number of sessions this game appeared in.
- `votesCast` — total votes cast (a rating and/or a retire flag).

Votes are the single source of truth. The vote shape (see
[`routes/sessions.js`](../routes/sessions.js)) is:

```js
session.votes[memberId][gameId] = { rating: 1..5 | null, retire: boolean }
```

Because stats are derived on demand, deleting a session automatically removes its
effect — **there is nothing to denormalize and nothing to migrate.** This yields,
per game, "what this group loves / tolerates / wants gone".

### 2.2 Collection shape — game fields

Each game (created in [`routes/games.js`](../routes/games.js) ≈L87) has:

```js
{
  id, title,
  type: 'analog' | 'digital',
  duration: 'short' | 'medium' | 'long',
  minPlayers, maxPlayers,          // integers, min >= 1, max >= min
  image, retired, retiredAt,
  source?: { provider, externalId, url }   // optional, from #41
}
```

Aggregating these over a round's **active** (non-retired) games gives a **taste
profile**: analog-vs-digital lean, favoured duration buckets, and the player
counts the group actually plays at.

### 2.3 External identity — `source` (from #41, now merged)

#41 shipped an optional `source: { provider, externalId, url }` on games. A game
added or linked via the lookup carries the provider it came from
(`bgg`, `psstore`, `steam`, `nintendo`, `xbox` — see
[`lib/providers/index.js`](../lib/providers/index.js)) and a stable external id.
This is the key that unlocks *content-based external* recommendations
("games similar to the ones you rated highly"). It is **optional and sparse**:
older games and hand-typed games have no `source`, so any external path must
degrade gracefully for games that lack one.

### 2.4 Activity feed

`pushActivity` / `round.activities` (see [`lib/store.js`](../lib/store.js))
records `game_added`, `game_retired`, chosen-game history, etc. Useful if we ever
want "recently played" weighting, but **not required** for a first version.

### 2.5 Precedent already in the code — `retireRecommendations`

The app **already has an on-demand, local, heuristic recommender**:
`retireRecommendations(activeGames, statsByGame, minVotes)` in
[`public/js/core.js`](../public/js/core.js) (≈L152) surfaces games worth
*retiring* (high retire-share and/or very low average, gated behind a minimum
vote count so nothing fires on thin data). It renders as a dismissible banner in
`renderRegalTab` ([`public/js/views-round.js`](../public/js/views-round.js)
≈L172), with i18n keys under `rec.*`.

This is the single most important fact for scoping #42: **the "recommend what to
get rid of" half already exists, purely client-side, with zero privacy/cost/deps
cost.** A "recommend what to get next" feature is its natural mirror image, and
the cheapest version of it can follow the exact same pattern.

## 3. Approaches evaluated

Criteria (from the issue): recommendation **quality**, **privacy** (what leaves
the machine), **cost**, **offline/failure** behaviour, **implementation
effort**, **new deps/env vars**, and **fit** with the app's constraints.

### Approach 1 — External game-database / recommendation API

Reuse #41's provider layer: map the round's top-rated games → their `source`
external ids → an external "similar games" list → filter out titles already owned
or retired → present.

What the real endpoints actually offer:

- **BoardGameGeek.** There is **no usable key-free BGG *recommendation*
  endpoint.** The XML API2 is token-gated since 2025-07-02 (see
  [`.claude/rules/add-game-lookup-provider.md`](../.claude/rules/add-game-lookup-provider.md))
  and, even when reachable, exposes item/stats data, **not** a "similar games"
  command. The public JSON we already use
  (`api.geekdo.com/api/geekitems`) returns item detail (players, playtime, image,
  canonical link) — again **no** recommendation field. BGG's on-site
  "recommendations" / "fans also own" are not exposed as a key-free API. So the
  strongest board-game path (BGG-native content recs) is **not available** to us
  without an approved app token; don't plan around it.
- **RAWG** (video games) *does* expose similar titles:
  `GET https://api.rawg.io/api/games/{id}/suggested?key=…`. But it **requires an
  API key** (free tier, personal use) and — critically — **only covers digital
  games.** RAWG ids are also **not** the ids we store (`psstore` / `steam` /
  `nintendo` / `xbox` product ids), so we'd need an extra RAWG *search* hop to
  resolve each owned digital title to a RAWG id before asking for suggestions.

| Criterion | Assessment |
|---|---|
| Quality | Potentially good for **digital** via RAWG; **no** key-free path for **board games** (the app's core). Asymmetric and incomplete. |
| Privacy | Titles/ids of highly-rated games leave the machine (to RAWG). |
| Cost | RAWG free tier; but an API key env var + rate limits + a resolve-to-RAWG-id hop. |
| Offline/failure | Must degrade to nothing/baseline; provider layer already models 502s + `Promise.allSettled`. |
| Effort | **High**: new provider(s), id-resolution hop, per-type routing, filtering, UI — for a payoff that skips board games entirely. |
| New deps/env vars | `RAWG_API_KEY`. |
| Fit | Poor: leaves the analog half (the app's heart) uncovered; most work for least coverage. |

**Verdict:** not a good primary. RAWG could be a *later, optional* enrichment for
digital collections, but it cannot be the main engine because it can't recommend
board games at all.

### Approach 2 — AI / LLM recommendations from the backend

Send a compact **taste profile** (top- and bottom-rated titles, preferred
duration / player-count / type, and the current collection so it isn't
re-suggested) to an external LLM (Claude) from the backend, and get back a ranked
list of buy-next titles **with a one-line reason each**.

The user has **explicitly OK'd this path** with an API key via env var, accepting
per-request cost. This intentionally relaxes CLAUDE.md's "no cloud services
unless asked" — **the user has asked; that is recorded here.** The trade-offs
still have to be stated plainly:

| Criterion | Assessment |
|---|---|
| Quality | **Highest and symmetric** — works equally for board and digital games, understands "we love short 2-player fillers but rate long 5-player games low", and can name real titles with reasons. Best UX by far. |
| Privacy | **Titles + ratings leave the machine** to Anthropic's API. Minimise: send an aggregated profile + a short title list, never member names/ids. Make it **opt-in / on-demand** (a button), not automatic. |
| Cost | Per-request LLM cost. Bound it: **generate on demand** (button press), **cache** the result, small model, capped output. Not continuous. |
| Offline/failure | If `ANTHROPIC_API_KEY` is absent or the call fails/times out → **feature simply doesn't appear / shows a soft error**; the app is otherwise untouched. Local baseline (Approach 3) can fill the gap. |
| Non-determinism | Same profile → different lists across runs. Fine for "suggestions"; caching makes a given result stable until regenerated. |
| Effort | **Moderate**: one backend route that builds the profile and calls the API, one on-demand UI section, i18n, tests with a mocked client. No id-resolution, no per-provider plumbing. |
| New deps/env vars | `ANTHROPIC_API_KEY` (or a base-URL override). Either the official SDK **or** plain `fetch` to the Messages API — prefer **`fetch`-only**, consistent with how providers already avoid SDKs and keep the "no build step / few deps" posture. |
| Fit | Good, *given the explicit opt-in*: no schema change required (cache can be an optional field or on-demand), fits the existing server-side-fetch + host-allowlist patterns. |

**Hallucination risk** (LLM invents a non-existent or wrong-name game) is the
main quality caveat — mitigated by grounding (Approach 4) or simply by accepting
that a "suggestion to look into" tolerates the occasional miss, and by asking the
model to prefer well-known titles.

**Verdict:** the strongest single approach for **quality across both game types**
with **moderate effort**, now that the user has authorised the key.

### Approach 3 — Local heuristics (no external calls)

Purely from owned data — the mirror of `retireRecommendations`. Two flavours:

1. **"Play the ones you love" (rediscovery, not buying).** Surface highly-rated,
   **rarely-played** owned games. Zero external anything. Genuinely useful, but
   it recommends *playing*, not *buying* — a slightly different (still valuable)
   feature.
2. **Taste-profile shopping list (no titles).** From the collection + ratings,
   describe *what to look for* rather than *which title*: e.g. "you rate short
   2-player analog games highest and own few — look for more of those." Honest,
   private, offline — but **doesn't name games**, so it's guidance, not a
   shopping list.

| Criterion | Assessment |
|---|---|
| Quality | Limited to what's already known; **cannot name unowned titles** (no external catalog). |
| Privacy | **Zero** — nothing leaves the machine. |
| Cost | Zero. |
| Offline/failure | Always works; no failure surface. |
| Effort | **Low** — reuses `gameStats`, same banner/section pattern as retire recs. |
| New deps/env vars | **None.** |
| Fit | **Perfect** with every constraint. |

**Verdict:** the correct **baseline and fallback**. It should exist regardless of
what richer path is chosen, because it is free, private, always-on, and the app
already has the exact pattern for it.

### Approach 4 — Hybrids

- **Grounded LLM (LLM + candidate lists).** Fetch candidate titles from a game-DB
  API, then have the LLM *rank/justify* from that grounded list (reduces
  hallucination). Best quality — but re-introduces Approach 1's problem: there's
  **no key-free board-game candidate source**, so grounding only works for
  digital. High effort for partial coverage.
- **Local profile + LLM expansion.** Build the taste profile locally (Approach 3)
  and let the LLM turn it into named titles (Approach 2). This is essentially
  Approach 2 with a well-structured, minimal prompt — **and it's what Approach 2
  should do anyway.** Low marginal cost, keeps the data sent small and
  aggregated (privacy win).

**Verdict:** the *local-profile → LLM-expansion* hybrid is just the disciplined
form of Approach 2 and is the recommended shape. Full API-grounding is not worth
it while board games have no key-free candidate source.

## 4. Cross-cutting concerns

- **Privacy.** Only Approach 2/4 send anything out. Minimise: an **aggregated
  profile + a short list of top/bottom titles**, never member names or ids, and
  make it **opt-in and on-demand** (button press), never a background call. Local
  baseline sends nothing.
- **Cost & etiquette.** LLM: on-demand generation + **cache the result** so a
  round doesn't pay per view; small model; capped tokens. External APIs (if RAWG
  is ever added): respect rate limits, a descriptive `User-Agent`, and the
  short-TTL cache the lookup route already uses.
- **Offline / failure.** Recommendations must **never break the app.** Every path
  degrades to "section absent / soft empty state" on missing key, timeout, or
  upstream error — mirroring the provider layer's 502 + `Promise.allSettled`
  handling. The local baseline is the ultimate fallback.
- **Caching / data shape.** Two clean options, both honouring "no migration
  code":
  - **On demand** (like `gameStats`) — for the local baseline, compute every
    render; nothing stored.
  - **Optional cached field** for the LLM result — store the last generated list
    under an **optional** `round.recommendations` (e.g.
    `{ generatedAt, model, items: [...] }`), added the same way `source` was:
    written when present, absent otherwise, read defensively. No one-time
    migration, consistent with CLAUDE.md and #41.
  - **Recommendation:** local baseline = on-demand; LLM result = optional cached
    field (so cost is paid on "generate", not on every view, and the list stays
    stable until regenerated).
- **UX placement.** The local baseline fits the **`start` hub tab** as a section
  (or a banner mirroring the retire banner). The LLM path fits an **on-demand
  "Vorschläge generieren" button** with a loading state — the async/costly nature
  argues against auto-generating on every open. A dedicated hub tab is possible
  but heavier than warranted for a first version; prefer a section on `start`.
  Note `HUB_TABS = ['start','regal','chronik','pokale']` in
  [`public/js/views-round.js`](../public/js/views-round.js) if a tab is ever
  wanted.
- **i18n.** Every new string needs a key in **both**
  [`public/js/lang/en.js`](../public/js/lang/en.js) and
  [`de.js`](../public/js/lang/de.js) (parity is tested). German UI.
- **New deps / env vars.** Prefer **none** beyond `ANTHROPIC_API_KEY` for the LLM
  path, and **`fetch`-only** to the Messages API rather than an SDK, to keep the
  dependency surface and "no build step" posture intact. README must document any
  new env var when the feature ships.
- **Dependency on #41.** #41 is **merged**, so `source` exists. But the
  recommended approach (local baseline + LLM) **does not require** `source` at
  all — it works from titles, ratings, and collection shape. `source` only
  matters for the *external-API* path (Approach 1/4-grounded), which we are **not**
  making primary. So the feature is robust even for rounds whose games have no
  `source`.

## 5. Recommendation

**Ship a two-layer recommender, on the `start` hub tab:**

1. **Layer A — local baseline (always on, no deps, no network).** The mirror of
   `retireRecommendations`: from `gameStats` + collection shape, surface a small
   "you might enjoy playing / look for more like these" section — highly-rated
   under-played owned games, plus a short taste-profile line describing the
   under-served niche (short 2-player analog, etc.). Zero privacy/cost, always
   available, low effort, reuses an existing pattern. **This is the floor and the
   fallback.**

2. **Layer B — opt-in LLM buy-next list (the user-authorised path).** A
   **"Vorschläge generieren"** button that calls a new backend route; the route
   builds a **minimal, aggregated, name-free-of-members** taste profile
   (top/bottom titles, favoured duration/player-count/type, current collection to
   exclude) and calls the Claude Messages API via **plain `fetch`** using
   `ANTHROPIC_API_KEY`. It returns a ranked list of real titles with one-line
   reasons, **caches** the result in an optional `round.recommendations` field,
   and **degrades to Layer A** when the key is absent or the call fails.

**Why this over the alternatives.** It gives the **best quality across both board
and digital games** (Layer B), because the one genuinely strong external path
(BGG-native recommendations) doesn't exist key-free and RAWG covers only digital
— so an LLM is the only option that recommends *board games* well. It keeps the
app **safe by default**: nothing leaves the machine unless a user presses a
button, and the whole thing still works (Layer A) with **no key, no network, no
new deps**. Effort is moderate and matches existing patterns (server-side fetch,
short-TTL cache, on-demand stats, i18n parity, the retire-banner UI). It touches
**no existing data** and needs **no migration** (optional cache field, added like
`source`).

**Main risks / trade-offs (carry into implementation):**

- **LLM hallucination** — may name a wrong or non-existent game. Mitigate by
  prompting for well-known titles and framing results as "suggestions to look
  into"; full API-grounding is not worth it while board games lack a key-free
  candidate source.
- **Privacy** — Layer B sends titles + aggregated ratings to Anthropic. Mitigate
  by opt-in only, aggregated/minimal payload, no member identifiers, and a clear
  in-UI note that generating suggestions contacts an external service.
- **Cost / non-determinism** — bounded by on-demand generation + caching + a
  small model + capped output.
- **Thin data** — a brand-new round with few sessions has weak signal; gate Layer
  A behind a minimum vote/session count (as `retireRecommendations` already does)
  and let Layer B note low confidence.

## 6. Follow-up implementation issue

Tracked as **#101** — the concrete implementation issue spun off from this
analysis, with routes, data shape, UI placement, i18n, tests, and README impact
so implementation can start without re-deciding.
