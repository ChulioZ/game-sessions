# Add-game lookup providers (PS Store, Steam, Nintendo, Xbox, BoardGameGeek) — how they work

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

### Title language follows the UI locale (`lang` param, issue #114)

BGG titles are **localized to the app's active language**. `/api/lookup/search`
and `/api/lookup/game` accept a `lang` query param (allowlist `de`/`en`, default
`en` when absent — see `lookupLang` in `routes/lookup.js`), which the frontend
sends as `getLocale()` and which is **part of the cache key** (so a de/en switch
isn't served a stale-language hit). The route passes it as the trailing arg to
`provider.search(q, limit, lang)` / `provider.detail(id, lang)`; the other
providers ignore it (they localize via their own env locale — `PSSTORE_LOCALE`
etc. — turning them per-request is a deliberate follow-up).

BGG honors it at **both** layers, both via Wikidata's language-tagged labels:
- **search label** — `buildSparql` emits `wikibase:label ... wikibase:language
  "<lang>,<other>"` (preferred first, the other as fallback), so the dropdown row
  shows the localized name.
- **saved title** — on pick, `detail(id, lang)` runs a **second, key-free
  Wikidata query** (`buildLabelSparql` → the label of the `wdt:P2339 = id`
  entity) and uses it as the title, **falling back to BGG's English canonical
  `item.name`** when there's no localized label or the query fails. This is why
  the provider owns the language (route/frontend stay generic). The extra hop is
  cached and only runs on pick. `labelLanguages()` guards the language literal
  against injection (non-2-letter → `en`).

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
- **detail:** `GET .../product/{id}` → same blob for the title, **plus a regex
  over the rendered HTML** for the player count, which appears only as markup
  like `compatText">1 - 4 players</span>` (not in the JSON). **No cover** — see
  the next section.

**PS Store `detail` returns `imageUrl: null` — the cover lives on the SEARCH
hit** (#281). `parseProduct` does call `pickImage(product.media)`, so this reads
like it should work; it doesn't, because a *product* page's `__NEXT_DATA__`
carries only a bare `Product` stub (id + name, **no `media` array**). Only the
*search* page's Apollo entries have `media`. PS Store is the **only** provider
like this — BGG, Steam, Nintendo and Xbox all populate `imageUrl` from `detail`.

So **any flow that offers a provider cover must fall back to the search hit's
`thumbnail`**, not read `detail.imageUrl` alone. Both come from the same
`pickImage()` helper and therefore the same `IMAGE_HOSTS`, so the server's
`providerCoverUrl()` allowlist accepts either — the fallback needs no server
change. `providerMatchCover(r, d)` in `public/js/lookup-cover.js` is that one
chokepoint for the link-provider sheet; the add-game flow does the same inline
(`showProviderImage(r.thumbnail)` before the detail call resolves).

**Forgetting that fallback fails silently and asymmetrically:** the cover toggle
simply never renders for PS Store while every other provider works, which reads
as "linking is broken for Sony" rather than as a missing fallback. Guarded by
`test/provider-match-cover.test.js`, which asserts the asymmetry against the
real parsers — so a future Sony page change that *starts* shipping `media` is
noticed rather than silently making the test vacuous.

(`providerMatchCover` lives in its own small module rather than as an export
from `views-round-lookup.js` for a reason unrelated to providers — see
`.claude/rules/frontend-helper-modules-and-coverage.md`.)

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

## How the Steam provider works (`lib/providers/steam.js`)

Unlike every other provider here, Steam exposes **near-official, key-free JSON**
behind the storefront, so this one doesn't need scraping or a two-source split:

- **search:** `store.steampowered.com/api/storesearch` → `{ items: [{ type,
  id (appid), name, tiny_image }] }`; keep only `type === 'app'` (drops
  `sub`/`bundle` packages).
- **detail:** `store.steampowered.com/api/appdetails?appids=<id>` → `{ <id>:
  { success, data: { name, header_image, categories, … } } }`.

**Known limits:**
- **No numeric player count** — Steam exposes only category *flags*, not
  counts. `parsePlayers` maps category ids (stable across languages; the
  descriptions are localized, the ids are not) to a best-effort range: any
  multiplayer-ish category (`1, 9, 27, 36–39, 47, 48, 49`) → `{ min: 1, max:
  null }` (upper bound never invented); single-player-only category `2` →
  `{ min: 1, max: 1 }`; neither → both `null`.
- **No play-time field** → `duration` defaults to `'long'`, matching the other
  digital stores.
- Locale (`cc`/`l` query params) defaults to the German store — `STEAM_CC` /
  `STEAM_LOCALE` override. Cover images live on `steamstatic.com`.

## How the Nintendo eShop provider works (`lib/providers/nintendo.js`)

Nintendo has no official API, but Nintendo of Europe powers its store search
with a **public, key-free Solr endpoint**
(`searching.nintendo-europe.com/{locale}/select`). Unlike BGG/PS Store/Xbox,
**one query answers both search and detail** — a search hit already carries
title, cover, player counts and the store path, so `detail(id)` just re-queries
the same endpoint filtered to that one `fs_id`.

- Search is filtered to `fq=type:GAME&fq=system_type:nintendoswitch` — the
  Switch-family filter is what keeps results to current eShop titles instead
  of retro/Virtual-Console re-releases sharing the same name.
- Player counts come straight from `players_from`/`players_to` Solr fields
  (coerced to a positive int, else `null`) — no scraping needed, unlike PS
  Store's HTML-regex player count.

**Known limits:** no play-time field → `duration` defaults to `'long'`; locale
defaults to the German store (`de`), override `NINTENDO_LOCALE`; cover images
live on `nintendo.com`. Undocumented storefront endpoint, degrades to
null/empty rather than throwing, like every other provider here.

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

**Cover URLs are host-allowlisted:** `POST …/games` only accepts an `imageUrl`
whose host a provider vouches for
(`imageHostAllowed` / `isAllowedImageUrl`, aggregated in
`lib/providers/index.js` from each provider's own `IMAGE_HOSTS` — Sony's
`playstation.net`, Steam's `steamstatic.com`, Nintendo's `nintendo.com`,
Xbox's `s-microsoft.com`, BGG's `geekdo-images.com`). Keep that guard when
adding providers. The same `IMAGE_HOSTS` list feeds the CSP `img-src` allowlist
— see `.claude/rules/security-middleware.md`.

**Since #172 the server no longer downloads cover bytes at all:** a provider
cover is **hotlinked** (the allowlisted URL is stored in `game.image` and the
browser loads it from the provider), because re-hosting third-party box art on a
public service needs a licence we don't hold. So the allowlist now gates what may
be *stored and rendered* rather than what may be *fetched*, and `img-src` is what
makes saved covers display at all. Adding a provider means its `IMAGE_HOSTS` must
be right, or its games' covers are CSP-blocked with no error but a console
violation. See `.claude/rules/provider-cover-hotlinking.md`.
