# Add-game lookup providers (PlayStation Store + BoardGameGeek) — how they work

The add-game title field is a search-as-you-type lookup (`lib/providers/`,
`routes/lookup.js`, `showAddGame` in `views-round.js`). All provider calls are
cross-origin (no CORS headers), so **all provider calls run server-side**
through `/api/lookup/*`; the browser never calls the provider. The frontend
queries **every** provider in parallel and merges the hits (round-robin
interleave) into one dropdown, each result tagged with its own provider; one
provider failing (502) must not blank out the other's results (`Promise.allSettled`).

## Why the BGG XML API2 is NOT usable (and how we got BGG anyway)

The first BGG attempt used BGG's XML API2. **As of 2025-07-02 BGG closed it**:
every request needs a registered application and an `Authorization: Bearer <token>`
header (see https://boardgamegeek.com/using_the_xml_api). Without a token every
call returns `401 Unauthorized` — confirmed in a real browser. **BGG's website
search is also blocked** to scripts: `/search/boardgame` and `geeksearch.php`
return `403` even with a browser User-Agent. So there is no key-free BGG *search*
endpoint. Don't re-add the XML API2 or scrape the search page expecting either to
"just work".

BGG is nonetheless supported (issue #69) via a **two-stage, no-key** split — see
`lib/providers/bgg.js` and the section below.

## How the BoardGameGeek provider works (`lib/providers/bgg.js`)

Because BGG's own *search* is gated but its *item data* is not, the provider
splits the job across two public, key-free endpoints:

- **search = Wikidata Query Service (SPARQL).** Run Wikidata's full-text search
  (CirrusSearch via `wikibase:mwapi`, `api "Search"` + `mwapi:srsearch`),
  restricted to entities carrying a **BoardGameGeek ID (property P2339)**.
  Wikidata is only the search *index*: it maps the typed name → a BGG object id
  + a label. (Prefer CirrusSearch over `EntitySearch`/`wbsearchentities`: the
  latter is prefix/alias-only and has poor recall — e.g. "catan" misses "Catan:
  Cities & Knights".) A descriptive `User-Agent` is required by Wikimedia policy.
- **detail = BGG's public JSON,** `api.geekdo.com/api/geekitems?objectid=<id>&
  objecttype=thing&nosession=1` (the API behind the public site, no auth). It
  returns the real fields: `name`, `minplayers`/`maxplayers` (strings, "0" =
  unknown → treat as null), `minplaytime`/`maxplaytime`, `imageurl`
  (on `cf.geekdo-images.com`), and `canonical_link`. So the saved game's data,
  cover, and "View on BoardGameGeek" link are genuinely BGG, not Wikidata.

**Known limits — don't treat these as bugs:**
- **No play *time* from Wikidata; from BGG it's minutes**, bucketed to the app's
  short/medium/long via the **average** of min/max play time (matches the
  add-game hint: <30 short · 30–60 medium · >60 long).
- Search results carry `thumbnail: null` (Wikidata isn't asked for an image); the
  BGG cover is fetched with the detail on pick. That's why BGG rows show the
  placeholder thumb in the dropdown — expected, not a bug.
- Both hops are undocumented; every parser degrades to null/empty, never throws.

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
- **No play duration** — the PS Store has no such concept, so nothing is scraped;
  `duration` defaults to `'long'` (digital titles almost always run long, matching
  the Nintendo/Steam default), pre-selecting that bucket in the add-game sheet.
- **Player count is best-effort** (scraped from rendered HTML); often just "1".
- Locale defaults to `de-de`, override with `PSSTORE_LOCALE`. Use
  `boardgamegeek`-style bare host `store.playstation.com` (Sony notes the `www.`
  host can interfere).

## How the Xbox / Microsoft Store provider works (`lib/providers/xbox.js`)

Microsoft has **no simple key-free "search games" API**, but two public,
key-free endpoints together cover it, so (like BGG) the provider splits the job:

- **search = storefront autosuggest,** `www.microsoft.com/msstoreapiprod/api/
  autosuggest?market=<locale>&sources=DCatAll-Products&query=<q>` (no auth, no
  `clientId` needed). Returns `{ ResultSets: [{ Suggests: [...] }] }`; keep
  `Source === 'Game'` (drops apps/DLC) and read the store product id from each
  suggest's `Metas` (`BigCatalogId`). Image URLs here are protocol-relative
  (`//store-images.s-microsoft.com/...`) → prefix `https:`.
- **detail = the public catalog service,** `displaycatalog.mp.microsoft.com/
  v7.0/products/<id>?market=<COUNTRY>&languages=<locale>&fieldsTemplate=Details`
  (no auth). Gives the real `ProductTitle`, the `Images` array (prefer
  `BoxArt`), and player counts from Xbox Live capability `Attributes`
  (`SinglePlayer` floors min at 1; `*Multiplayer`/`*Coop` carry numeric
  `Minimum`/`Maximum`, and the widest `Maximum` is the max player count).

**Known limits — don't treat these as bugs:**
- Both endpoints are undocumented/store-facing; every parser degrades to
  null/empty, never throws.
- **Digital games only.** **No play-time** → `duration` defaults to `'long'`.
- The "View on Xbox" link is built from the id alone as
  `www.xbox.com/<locale>/games/store/_/<id>` (the `_` slug placeholder resolves).
- Covers download only because `store-images.s-microsoft.com` is allowlisted
  (`s-microsoft.com`); locale defaults to `de-de`, override `XBOX_LOCALE`.

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
`isAllowedImageUrl` — Sony's `image.api.playstation.com` / `playstation.net`, and
BGG's `cf.geekdo-images.com` / `geekdo-images.com`). Keep that guard when adding
providers; never fetch arbitrary client-supplied URLs.
