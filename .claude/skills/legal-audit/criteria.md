# Legal criteria

- **last-researched:** never
- **cadence:** 90 days

Seeded 2026-07-23 from `.claude/rules/keep-legal-docs-current.md`, `docs/legal/`,
`lib/legal.js` and `test/legal.test.js` — **not** from research.

## This list holds consistency checks, not legal opinions

Every criterion below is **mechanically checkable against this repo**: does the
code contradict what the published documents promise, and do the internal records
still match the code? That is the half of a legal audit an agent can do well.

Research (phase B) produces a **reading list with sources and dates**, presented
to the user. It does **not** write criteria here. A new legal duty enters this
file only after the user explicitly says so — see L-R04. The reason is not
timidity: these documents are public statements about processing real people's
personal data, and a confidently wrong assertion about German or EU law is worse
than an acknowledged gap.

---

### L-001 — Every third party the *server* contacts is disclosed, in both languages
- **Status:** adopted · 2026-07-23
- **Source:** Art. 13, 30 GDPR · `keep-legal-docs-current.md` direction 1
- **Check:** Derive the real list from code — `package.json` runtime deps that open
  connections, `lib/mail.js`, `lib/storage/`, the `DATABASE_URL` host, `lib/providers/*`,
  the donation target. Each must appear in the policy's processor section **and** the
  recipient list in **both** DE and EN, with a `docs/legal/vvt.md` row and an AVV
  inventory entry. Currently disclosed: Railway, Cloudflare, Brevo, Heinlein/mailbox.org,
  Ko-fi (+ Stripe, PayPal), BoardGameGeek, Sony, Microsoft, Nintendo, Valve.
- **Enforced by:** `test/legal.test.js` pins markers for named processors — which catches
  *removing* one, never *adding* one in code. This direction is the manual half.

### L-002 — Every third party the *visitor's browser* is made to contact is disclosed
- **Status:** adopted · 2026-07-23
- **Source:** Art. 13 GDPR · `provider-cover-hotlinking.md`
- **Check:** Provider covers are hotlinked (#172), so the visitor's IP reaches Sony,
  Microsoft, Nintendo, Valve and BGG directly. Any new `IMAGE_HOSTS` entry, embed,
  iframe, remote font, CDN script or pixel adds a recipient. Cross-check the CSP
  `img-src`/`connect-src`/`script-src` in `lib/app.js` against the disclosed list — the
  CSP is the machine-readable inventory of who the browser may talk to.
- **Enforced by:** — (manual)

### L-003 — The on-device storage inventory matches reality
- **Status:** adopted · 2026-07-23
- **Source:** § 25 TDDDG
- **Check:** Grep `localStorage`, `sessionStorage`, `document.cookie`, `caches.open` and
  every `res.cookie` across `public/`, `lib/` and `routes/`. Each item must appear in the
  policy's § 25 inventory with its purpose and lifetime. Known: the locale preference
  (`i18n.js`), account tokens (`core.js`, `account.js`), the `sa` access cookie, the
  admin `aid` cookie, and the service-worker shell cache.
- **Enforced by:** — (manual)

### L-004 — Every stored personal-data category has a policy section and a VVT row
- **Status:** adopted · 2026-07-23
- **Source:** Art. 13, 30 GDPR
- **Check:** Walk the schema (users, members, feedback with its opt-in `context.email`,
  contact notices, the moderation log) and confirm each category, its legal basis and its
  retention appear in both the policy and `docs/legal/vvt.md`. A new column or a new
  free-text field is the usual trigger.
- **Enforced by:** — (manual)

### L-005 — The code does not breach a commitment the documents make
- **Status:** adopted · 2026-07-23
- **Source:** `keep-legal-docs-current.md` direction 2 · Art. 5(2) GDPR
- **Check:** The published text is a ceiling. Verify against code, not intent:
  no analytics or tracking storage; `trackEvent`'s field allowlist still refuses anything
  beyond `event` + `tenantId`; `requestLogger`'s `customProps` still logs no bodies, query
  strings, headers or cookies; feedback deletion works; erasure leaves an e-mail-free
  record; sharing stays limited to the named recipients.
- **Enforced by:** partially — `test/status.test.js` sweeps secrets out of the admin
  status response; the logging allowlists are manual.

### L-006 — DE/EN parity, and a test marker per named processor
- **Status:** adopted · 2026-07-23
- **Source:** `keep-legal-docs-current.md`
- **Check:** Every section exists in both languages and says the same thing — a processor
  disclosed only in German is not disclosed. Every named processor has a marker string in
  `test/legal.test.js` so renaming or dropping it fails loudly.
- **Enforced by:** `test/legal.test.js` (markers) · parity is manual

### L-007 — No trigger for a minimum-age clause has appeared
- **Status:** adopted · 2026-07-23
- **Source:** `keep-legal-docs-current.md` (operator decision 2026-07-21, #140)
- **Check:** The Nutzungsbedingungen carry no age clause on purpose. Re-evaluate — in the
  same change — if any of these appears: **consent-based processing** (tracking, ads,
  newsletter, any Art. 6(1)(a) purpose), a **paid tier** (§§ 104 ff. BGB), **public
  dissemination of user content** (public rounds/sharing moves the service toward the DSA
  platform tier and Art. 28's minors duties), or **child-directed features**.
- **Enforced by:** — (manual)

### L-008 — The internal records still describe the running system
- **Status:** adopted · 2026-07-23
- **Source:** Art. 5(2), 30, 32 GDPR · DSA
- **Check:** `retention.md` against implemented retention (the 3-year moderation-log purge
  is still manual — #311); `dsar-process.md` against the admin export/erasure routes;
  `notice-and-action.md` against the actual notice workflow and the operator inbox;
  `toms.md` against the security measures really in place; `breach-process.md` against who
  and what exists today.
- **Enforced by:** — (manual)

### L-009 — The legal surface fails closed
- **Status:** adopted · 2026-07-23
- **Source:** § 5 DDG · `.claude/rules/` (env-gating pattern)
- **Check:** `/impressum`, `/datenschutz` and `/nutzungsbedingungen` 404 until
  `IMPRESSUM_ADDRESS` **and** `IMPRESSUM_EMAIL` are both set — one alone must not produce a
  partial Impressum. A half-configured deploy must never publish an incomplete identity.
- **Enforced by:** `test/legal.test.js`

### L-010 — Citations name law that is actually in force
- **Status:** adopted · 2026-07-23
- **Source:** `test/legal.test.js`
- **Check:** The Impressum cites **§ 5 DDG**, never the repealed TMG. Any GDPR/DSA article
  reference resolves to the article it claims. A repealed or renumbered citation is a
  finding even when the substance is right.
- **Enforced by:** `test/legal.test.js` (DDG/TMG)

### L-011 — Stated processing locations match the deployment
- **Status:** adopted · 2026-07-23
- **Source:** Art. 13(1)(f), 44 ff. GDPR
- **Check:** The transfer statements must match where the services actually run. This has
  been wrong before: the Postgres service sat in a **US region under an EU app** until
  2026-07-20 (`railway-db-same-region.md`) — a performance bug *and* an undisclosed
  transfer. Re-verify the region of every Railway service and the R2 bucket, not just the
  app's.
- **Enforced by:** — (manual; check the platform, not the code)

### L-012 — Donations stay unconditional
- **Status:** adopted · 2026-07-23
- **Source:** operator decision (#173, 2026-07-22)
- **Check:** No feature, quota, tier or badge is gated behind donating. The moment one is,
  the service has a paid tier — which pulls in consumer-contract duties, Widerruf, and the
  L-007 age question at once. This is a legal-shape criterion, not a product preference.
- **Enforced by:** — (manual)

---

## Rejected — settled, do not re-litigate

### L-R01 — "Add AGB and a Widerrufsbelehrung"
- **Status:** rejected · 2026-07-23
- **Why:** Decided in #140 (2026-07-21). The service is free and donation-funded, so there
  is no paid consumer contract to withdraw from. Reopens only if L-012 falls.

### L-R02 — "Add a minimum-age clause to the Nutzungsbedingungen"
- **Status:** rejected · 2026-07-23
- **Why:** Decided in #140 with reasoning on three legs: no consent-based processing (so
  Art. 8 GDPR's 16-year consent age never triggers), a DSA *hosting* service whose tenant
  content is not disseminated to the public (so Art. 28's platform minors-duties do not
  apply), and children join as name-only members without accounts. Each leg is a trigger —
  tracked as L-007, not as an open question.

### L-R03 — "Add a cookie/consent banner"
- **Status:** rejected · 2026-07-23
- **Why:** § 25(2) TDDDG exempts storage strictly necessary for the service the user
  requested, and that is all this app stores: auth tokens, a locale preference, the PWA
  shell cache. There is no analytics, no ads, no third-party script. A banner would ask
  for consent that is neither needed nor legally meaningful. Verify the *inventory* each
  run (L-003) rather than the conclusion — the conclusion changes only if something
  non-necessary appears.

### L-R04 — "Adopt researched legal duties into this file automatically"
- **Status:** rejected · 2026-07-23 — **meta-criterion, do not remove**
- **Why:** Operator decision when this skill was built. Research output is a reading list
  with sources, for the user to judge. An agent is not a lawyer, web results on German and
  EU law are of wildly uneven reliability, and the artefacts here are public statements
  about real personal data. A wrong criterion adopted silently would generate confident,
  wrong issues against a live service.
