# Provider cover art is HOTLINKED, never re-hosted (#172)

Adding a game from the lookup used to **download** the provider's cover image and
re-host it under `/uploads/<key>`. Since #172 it does not: `game.image` stores the
provider's own `https://…` URL and the browser fetches it from them.

**Why — this is a legal constraint, not a performance one.** Cover art is
copyrighted artwork. Re-hosting it on a public multi-tenant service is
reproduction + making available (§§ 16, 19a UrhG) without a licence, and the
private-copy exception does not cover the *operator* of a service. Given
Germany's image-Abmahnung practice this was the app's most realistic
legal-trouble scenario after a missing Impressum. Hotlinking removes the
reproduction act entirely — embedding a freely accessible image is broadly
tolerated under CJEU linking case law. **Do not "optimise" this back into a
download-and-cache**, however tempting the reliability argument is.

## Consequences you must not undo

- **`game.image` now has two shapes.** A member's own upload is still
  `/uploads/<key>` (hosted by us, auth-gated, deleted when the game goes). A
  provider cover is an absolute `https://` URL that we never fetch, never store
  bytes for, and must never try to delete. Anything reading `image` must tolerate
  both — see `.claude/rules/cover-image-storage-backend.md`.

- **`storage.remove()` ignores anything that isn't a `/uploads/` path, and that
  guard is load-bearing.** Both backends take `path.basename()` of what they are
  handed, so `remove('https://cf.geekdo-images.com/x/pic123.jpg')` would compute
  the key `pic123.jpg` and **delete OUR object of that name** — someone else's
  cover, silently. The guard lives in `lib/storage/index.js` (one chokepoint) so
  every deletion path — games PATCH/DELETE, admin takedown, account erasure — is
  safe by construction rather than by each call site remembering.
  `test/provider-covers.test.js` pins it down with a deliberately colliding
  basename.

- **The CSP `img-src` allowlist is now what makes covers render at all.** It was
  already there for the lookup previews (`imageCspSources()`, see
  `.claude/rules/security-middleware.md`), but a hotlinked cover is a
  cross-origin image on every screen — drop a host from a provider's
  `IMAGE_HOSTS` and its saved games' covers go blank with only a CSP violation in
  the console. `test/provider-covers.test.js` asserts the coupling from the
  provider side.

- **`providerCoverUrl()` is the trust boundary, and it rejects more than the host
  allowlist does.** On top of `isAllowedImageUrl`:
  - **https only.** A stored `http://` URL is blocked as mixed content on the
    live HTTPS origin and renders nothing, with no server-side error to notice.
  - **No `'`, `"`, `(`, `)`, backslash or whitespace.** The frontend interpolates
    `game.image` straight into `background-image:url('<image>')`; a quote or
    paren in a stored URL is a CSS-injection vector. Rejecting once at the
    boundary keeps every render site safe without escaping at each one. Don't
    relax this to "just escape it later" — the render sites are spread across
    six view files.

## What was NOT done, and why

- **BGG covers are hotlinked like the rest, for now.** BGG is the one provider
  that *does* grant an image licence: its
  [XML API Terms of Use](https://boardgamegeek.com/wiki/page/XML_API_Terms_of_Use)
  grant "a worldwide, non-exclusive, royalty-free license to reproduce and
  display the data available through the BGG XML API … solely for strictly
  non-commercial purposes". Two catches, both blocking today:
  1. That licence attaches to **the XML API**, and we don't use it — our BGG
     provider reads the private `api.geekdo.com/api/geekitems` endpoint, about
     which the same docs say "we are granting no license for use of those
     endpoints". Moving onto the licensed API needs a registered application +
     token → **#117**, blocked on the maintainer registering.
  2. Using it publicly requires crediting BGG by name **and** displaying a
     linked "Powered by BGG" logo. That ships with #117, not before — the
     obligation starts when the licence does.
- **"Non-commercial" is narrower than it sounds.** Per BGG's *Using the XML API*
  page, an app monetised **solely through voluntary donations** is already
  commercial and needs a commercial licence (which they say is "most likely
  free"). Spielwirbel's stated direction is donations eventually, so the free
  non-commercial grant will **not** be the applicable one — see #173.
- **The digital storefronts have no path at all.** Sony, Microsoft, Nintendo and
  Valve offer no cover-art licence at any price, so hotlinking is the end state
  for them, not a stopgap.

## Privacy follow-through

Hotlinking means the **visitor's browser contacts Sony/Microsoft/Nintendo/Valve/
BGG directly**, so their IP address reaches those third parties. That is a
disclosure obligation in the privacy policy (**#134**) — it was recorded there
when #172 shipped. It is also the one real argument *against* hotlinking; it was
accepted deliberately, because an unlicensed reproduction is the larger exposure.
