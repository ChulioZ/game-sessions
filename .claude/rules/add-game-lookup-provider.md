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

## The cross-provider merge ranking must FOLD before it tokenizes (#317)

`scoreHit` (`public/js/lookup-score.js`) tiers each hit by how well its title
answers the query; `groupLookupHits` then breaks **ties** by `LOOKUP_PROVIDERS`
position. So provider priority is only ever meant to order *equally relevant*
hits — which makes any bug that collapses distinct relevance to a shared `0`
present itself as **"the wrong provider wins"**, and hides the real cause.

That is exactly what happened: the word-boundary and loose tiers split on
whitespace, so a query carrying punctuation the title spells differently
("… Quedlinburg **-** Megabox" vs "… Quedlinburg**:** Die Megabox") produced a
dead `"-"` token that can prefix no real word. The loose tier's `every()` then
failed and the correct game scored `0` — identical to an unrelated title — so
six PS Store results outranked the one BGG hit the user was searching for.

**Rule:** normalize both strings *once*, before any tier check, and never
tokenize raw input. `foldTitle()` does it (ß→ss, diacritics stripped,
non-alphanumeric runs collapsed to a space), mirroring `norm()` in
`lib/providers/bgg.js` — BGG had folded punctuation for its **in-provider**
ranking since #117, and the cross-provider merge ranking simply never got the
same treatment. Two things worth keeping:

- **A query that folds to `''` must score 0.** The loose tier is an `every()`
  over the query's tokens, and `[].every(...)` is `true` — so an all-punctuation
  query would otherwise match *everything* at tier 1. The `!query` guard is what
  prevents that; `test/lookup-score.test.js` pins it.
- **`groupLookupHits`' key is deliberately NOT folded.** It uses plain
  trim+lowercase, because it answers a different question ("are these two
  providers offering the same game?") — folding punctuation there would merge
  rows that differ only by it. Don't "unify" the two normalizations.
- The helper lives in its own file for the coverage reason in
  `.claude/rules/frontend-helper-modules-and-coverage.md` — exporting it from
  the ~730-line view file would drag that file into the coverage report and red
  the gate with every test still passing.

## BGG (`lib/providers/bgg.js`) — the XML API2, under a token (#117)

Both hops run on BGG's official **XML API2** with a registered application
token (`BGG_API_TOKEN`, approved as a **commercial** licence — donations count
as commercial, see #173):

- **search:** `boardgamegeek.com/xmlapi2/search?query=<q>&type=boardgame,boardgameexpansion`
- **detail:** `boardgamegeek.com/xmlapi2/thing?id=<id>` — `<name type="primary">`,
  `<minplayers>`/`<maxplayers>` (attribute strings, "0" = unknown → null),
  `<thumbnail>`, and the item `type` the canonical link is built from.

Four things about it bite:

- **No `www.`, ever.** BGG's docs are explicit that `www.boardgamegeek.com`
  interferes with request authorization — a perfectly valid token then `401`s.
- **`Authorization: Bearer <token>`**, and the token is read **per call** from
  env (like the rate-limit ceilings in `lib/app.js`), so a test can drive it.
- **No token ⇒ `search()` returns `[]` and `detail()` returns the null-shaped
  product** — never a throw. The frontend merges providers with
  `Promise.allSettled`, so a 502 here would render as "couldn't reach provider"
  across the whole dropdown; an empty list leaves the other four clean. The
  silence is why `lib/status.js` reports `lookup.bggTokenSet` — otherwise a
  missing token is invisible to the operator.
- **Throttling is a status code, not a queue.** BGG answers `500`/`503` when
  too busy (`202` on some endpoints, `429` generically). `fetchXml` retries
  exactly those, twice, inside one 8 s budget; every other status (notably
  `401`) is final. Don't turn this into an unbounded retry — the route's
  `cached()` (10 min) plus the UI debounce are what actually keep the request
  count down, which is what BGG's terms ask for.

**Search results must be RANKED before truncating.** BGG's search is a plain
name match with **no relevance order of its own** — "catan" matches well over a
hundred items — so slicing the first 8 as they arrive routinely drops the game
the user meant. `parseSearch` scores each name (exact > prefix > substring,
diacritics/ß/punctuation folded) and prefers the shorter title on a tie, which
is what keeps a base game ahead of its editions and expansions.

**Localized titles come from the MATCHED name (#117 replaced #114's mechanism).**
BGG answers a search with the name that matched, so a German query yields the
German alternate name — while `/thing` always reports the primary (usually
original-language) name. `pickedTitle()` (`public/js/lookup-title.js`)
therefore keeps the search hit's title for `bgg` and lets detail win for every
other provider. There is **no `lang` parameter anywhere any more**: no provider
takes one, so the route, the cache key and the client query string dropped it.

**XML is parsed by a small scanner, not a dependency.** Two details are
load-bearing: an attribute value may legally contain a raw `>` (game titles do,
and a naive `/<[^>]*>/` cuts the tag in half), and titles arrive
entity-encoded, so every attribute and text node is decoded.

**Known limits, not bugs:** no play-time bucketing (the field is read but the
app no longer stores durations). Search hits carry `thumbnail: null` — the
search endpoint returns no images at all, so BGG rows show the placeholder
thumb in the dropdown and the cover arrives with the detail on pick.

**Attribution is a licence condition, not decoration.** A public-facing app
must display the "Powered by BGG" logo linked back to BoardGameGeek, at a size
where its text stays legible — it lives in the always-visible half of the site
footer (`public/index.html`, `.site-footer__bgg`) and is **self-hosted**, so
rendering it contacts nobody. Don't gate it behind the legal-links config flag
and don't shrink or fade it. BGG also forbids modifying the retrieved data:
choosing which of BGG's own names to show is fine, rewriting one is not.

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
