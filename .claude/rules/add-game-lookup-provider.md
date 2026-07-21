# Add-game lookup providers (PS Store, Steam, Nintendo, Xbox, BGG) — how they work

The add-game title field is a search-as-you-type lookup (`lib/providers/`,
`routes/lookup.js`, `showAddGame`/`attachLookup` in
`public/js/views-round-lookup.js`). Provider endpoints have no CORS headers, so
**all provider calls run server-side** through `/api/rounds/:rid/lookup/*`; the
browser never calls a provider. The frontend queries every provider **the round
has enabled** in parallel (absent config = all five, #294 — see
`.claude/rules/round-provider-config.md`) and merges the hits (round-robin
interleave) into one dropdown; one provider failing (502) must not blank the
others' results (`Promise.allSettled`).

## BGG (`lib/providers/bgg.js`) — and why the XML API2 is NOT usable

**BGG closed its XML API2 (2025-07-02):** every request now needs a registered
app + Bearer token — keyless calls get `401`. Its website search
(`/search/boardgame`, `geeksearch.php`) `403`s scripts even with a browser
User-Agent. Don't re-add the XML API2 or scrape the search page. Instead BGG
(#69) splits the job across two public, key-free endpoints:

- **search = Wikidata Query Service (SPARQL):** CirrusSearch full-text via
  `wikibase:mwapi` (`api "Search"` + `mwapi:srsearch`), restricted to entities
  with a BGG ID (property **P2339**). Wikidata is only the search *index*
  (name → BGG object id + label). Prefer CirrusSearch over
  `EntitySearch`/`wbsearchentities` — the latter is prefix/alias-only ("catan"
  misses "Catan: Cities & Knights"). Wikimedia policy requires a descriptive
  `User-Agent`.
- **detail = BGG's public JSON:** `api.geekdo.com/api/geekitems?objectid=<id>&
  objecttype=thing&nosession=1` (the site's own API, no auth) — real `name`,
  `minplayers`/`maxplayers` (strings, "0" = unknown → null),
  `minplaytime`/`maxplaytime`, `imageurl` (on `cf.geekdo-images.com`),
  `canonical_link`.

**Titles follow the UI locale (#114):** the `search`/`game` routes accept
`lang` (allowlist `de`/`en`, default `en` — `lookupLang` in
`routes/lookup.js`), which is **part of the cache key**. BGG honours it at both
layers via Wikidata's language-tagged labels: `buildSparql` emits the preferred
language first with the other as fallback (dropdown label), and on pick
`detail(id, lang)` runs a second key-free Wikidata label query
(`buildLabelSparql`), falling back to BGG's English `item.name`. The other
providers ignore `lang` (they localize via their own env locale).
`labelLanguages()` guards the language literal against injection (non-2-letter
→ `en`).

**Known limits, not bugs:** play time comes from BGG in minutes, bucketed to
short/medium/long via the **average** of min/max (<30 / 30–60 / >60). Search
hits carry `thumbnail: null` (Wikidata isn't asked for an image) — BGG rows
show the placeholder thumb in the dropdown; the cover arrives with the detail
on pick.

## PS Store (`lib/providers/psstore.js`)

No official API; the provider fetches the store's server-rendered pages and
reads the embedded `__NEXT_DATA__` JSON (Next.js/Apollo cache), no auth:

- **search:** `store.playstation.com/{locale}/search/{q}` → Apollo `Product`
  objects with `storeDisplayClassification === 'FULL_GAME'` (drops
  DLC/bundles) → `{ providerId, title, thumbnail }`.
- **detail:** `…/product/{id}` → same blob for the title, **plus a regex over
  the rendered HTML** for the player count (`compatText">1 - 4 players`) — it
  isn't in the JSON.

**PS Store `detail` returns `imageUrl: null` — the cover lives on the SEARCH
hit** (#281). A product page's `__NEXT_DATA__` carries only a bare `Product`
stub (no `media` array); only the search page's entries have it. PS Store is
the **only** provider like this, so any flow offering a provider cover must
fall back to the search hit's `thumbnail` — `providerMatchCover(r, d)` in
`public/js/lookup-cover.js` is that chokepoint for the link-provider sheet;
the add-game flow shows `r.thumbnail` inline. Both URLs come from the same
`pickImage()`/`IMAGE_HOSTS`, so the server allowlist accepts either.
Forgetting the fallback fails silently and asymmetrically (covers just never
render for Sony). Guarded by `test/provider-match-cover.test.js` against the
real parsers, so a Sony page change that *starts* shipping `media` is noticed.

**Known limits:** undocumented storefront scraping (parsers degrade to
null/empty, never throw); digital games only; no play duration → `'long'`
default; player count best-effort; locale `de-de` (`PSSTORE_LOCALE`), bare
host `store.playstation.com` (no `www.`).

## Steam (`lib/providers/steam.js`)

Near-official key-free JSON — no scraping, no split:

- **search:** `store.steampowered.com/api/storesearch` → keep only
  `type === 'app'` (drops `sub`/`bundle`).
- **detail:** `…/api/appdetails?appids=<id>` → `{ <id>: { success, data } }`.

**Limits:** no numeric player count — only category flags. `parsePlayers` maps
category **ids** (stable across languages): multiplayer-ish ids
(`1, 9, 27, 36–39, 47–49`) → `{ min: 1, max: null }` (never invent an upper
bound); single-player-only id `2` → `{ min: 1, max: 1 }`; neither → nulls. No
play-time field → `'long'`. Locale via `STEAM_CC`/`STEAM_LOCALE` (defaults:
German store). Covers on `steamstatic.com`.

## Nintendo eShop (`lib/providers/nintendo.js`)

Nintendo of Europe's public key-free Solr endpoint
(`searching.nintendo-europe.com/{locale}/select`). **One query answers both**
— a search hit already carries title, cover, player counts and store path;
`detail(id)` re-queries filtered to that `fs_id`. Search is filtered
`fq=type:GAME&fq=system_type:nintendoswitch` (keeps out retro re-releases).
Player counts come from `players_from`/`players_to` (coerced positive int,
else null). **Limits:** no play time → `'long'`; locale `de`
(`NINTENDO_LOCALE`); covers on `nintendo.com`; undocumented, degrades to
null/empty.

## Xbox / Microsoft Store (`lib/providers/xbox.js`)

Two public key-free endpoints, split like BGG:

- **search = storefront autosuggest:**
  `www.microsoft.com/msstoreapiprod/api/autosuggest?market=<locale>&
  sources=DCatAll-Products&query=<q>` — keep `Source === 'Game'`, product id
  from the suggest's `Metas` (`BigCatalogId`). Image URLs are
  protocol-relative → prefix `https:`.
- **detail = catalog service:** `displaycatalog.mp.microsoft.com/v7.0/
  products/<id>?market=<COUNTRY>&languages=<locale>&fieldsTemplate=Details` —
  `ProductTitle`, `Images` (prefer `BoxArt`), players from Xbox Live
  capability `Attributes` (`SinglePlayer` floors min at 1;
  `*Multiplayer`/`*Coop` carry numeric `Minimum`/`Maximum`; widest `Maximum`
  wins).

**Limits:** undocumented, degrades to null/empty; digital only; no play time →
`'long'`; "View on Xbox" link is built from the id
(`www.xbox.com/<locale>/games/store/_/<id>`); covers on
`store-images.s-microsoft.com` (allowlisted as `s-microsoft.com`); locale
`de-de` (`XBOX_LOCALE`).

## Testing — never hit the network

Unit-test the pure parsers (`parseSearch`/`parseProduct`/`parsePlayers`/
`pickImage`/`imageHostAllowed`, exported per provider) against sample
HTML/JSON. For route tests, override global `fetch`
(`global.fetch = async () => ({ ok:true, text: async () => HTML })`) and
restore in `afterEach`. See `test/providers-psstore.test.js`,
`test/lookup.test.js`, `test/games.test.js`.

## The cover-host allowlist is the trust boundary

`POST …/games` only accepts an `imageUrl` whose host a provider vouches for
(`isAllowedImageUrl`, aggregated in `lib/providers/index.js` from each
provider's `IMAGE_HOSTS`). The same lists feed the CSP `img-src` allowlist
(`.claude/rules/security-middleware.md`). **Since #172 the server never
downloads cover bytes** — a provider cover is **hotlinked** (the URL is stored
in `game.image`), so the allowlist gates what may be *stored and rendered*; a
wrong `IMAGE_HOSTS` means that provider's covers are CSP-blocked with no error
beyond a console violation. See `.claude/rules/provider-cover-hotlinking.md`.
