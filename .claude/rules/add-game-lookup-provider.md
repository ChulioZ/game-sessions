# Add-game lookup provider (PlayStation Store) — how it works and its limits

The add-game title field is a search-as-you-type lookup (`lib/providers/`,
`routes/lookup.js`, `showAddGame` in `views-round.js`). BGG sends no CORS
headers and the PS Store call is likewise cross-origin, so **all provider calls
run server-side** through `/api/lookup/*`; the browser never calls the provider.

## Why not BoardGameGeek

The first attempt used BGG's XML API2. **As of 2025-07-02 BGG closed it**: every
request now needs a registered application and an `Authorization: Bearer <token>`
header (see https://boardgamegeek.com/using_the_xml_api). Without a token every
call returns `401 Unauthorized` — for everyone, from any network, confirmed in a
real browser. There is no free unauthenticated BGG endpoint anymore. Don't
re-add BGG expecting it to "just work"; it needs a manually-approved app token
(approval takes a week+). That's why we switched to the PlayStation Store.

## How the PlayStation Store provider works

There is **no official PS Store API**. `lib/providers/psstore.js` instead fetches
the store's normal server-rendered pages and reads the `__NEXT_DATA__` JSON blob
(a Next.js/Apollo cache) embedded in the HTML — no auth, no key:

- **search:** `GET store.playstation.com/{locale}/search/{q}` → parse
  `__NEXT_DATA__` → collect Apollo `Product` objects with
  `storeDisplayClassification === 'FULL_GAME'` (filters out DLC/bundles) →
  `{ providerId, title, thumbnail }`.
- **detail:** `GET .../product/{id}` → same blob for title + cover image, **plus
  a regex over the rendered HTML** for the player count, which appears only as
  markup like `compatText">1 - 4 players</span>` (not in the JSON).

**Known limits — don't treat these as bugs:**
- It's **undocumented storefront scraping**. Sony can change the page shape any
  time and break parsing, so every parser returns null/empty instead of throwing.
- **Digital games only** — it can't help for board games.
- **No play duration** — the PS Store has no such concept; `duration` is always
  null and left to manual entry.
- **Player count is best-effort** (scraped from rendered HTML); often just "1".
- Locale defaults to `de-de`, override with `PSSTORE_LOCALE`. Use
  `boardgamegeek`-style bare host `store.playstation.com` (Sony notes the `www.`
  host can interfere).

## Testing the lookup — never hit the network

Unit-test the pure parsers (`parseSearch`/`parseProduct`/`parsePlayers`/
`pickImage`/`imageHostAllowed`, exported from the provider) against sample HTML.
For route/integration tests, override the global `fetch`
(`global.fetch = async () => ({ ok:true, text: async () => HTML })`) and restore
it in `afterEach` — the provider calls the global `fetch`, so this fully isolates
it. See `test/providers-psstore.test.js`, `test/lookup.test.js`, and the
cover-download tests in `test/games.test.js`.

**Cover downloads are host-allowlisted (SSRF guard):** `POST …/games` only
downloads an `imageUrl` whose host a provider vouches for (`imageHostAllowed` /
`isAllowedImageUrl` — Sony's `image.api.playstation.com` / `playstation.net`).
Keep that guard when adding providers; never fetch arbitrary client-supplied URLs.
