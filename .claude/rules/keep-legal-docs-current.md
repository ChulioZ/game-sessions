# Check every change against the legal documents — in BOTH directions

The repo ships real legal commitments: the Impressum + privacy policy +
Nutzungsbedingungen rendered by `lib/legal.js` (DE **and** EN, env-gated —
#134/PR #308, #140) and the internal records under `docs/legal/` (`vvt.md`,
`toms.md`, `dsar-process.md`, `breach-process.md`, `retention.md`,
`notice-and-action.md`). Nothing in CI diffs them against the code, so they
drift silently — and a drifted privacy policy is not a stale README: it is a
wrong public statement about personal-data processing (Art. 13 information
duties, Art. 5 Abs. 2 accountability).

**Rule:** when implementing a change (like the README check in
`keep-readme-current.md`, consciously, before committing), make TWO checks:

1. **Does the change make the legal documents stale?** Update them in the same
   branch/PR when the change
   - adds, swaps or removes a **processor/recipient** — hosting, database,
     object storage, mail, any third party the server *or the visitor's
     browser* is made to contact (hotlinked covers are the precedent, see
     `provider-cover-hotlinking.md`). Touch the policy's processor section,
     the "Weitergabe/Data sharing" recipient list (**both languages**), the
     affected `vvt.md` row **and** its AVV inventory;
   - stores a **new category of personal data** or changes a retention →
     policy section + `vvt.md` row;
   - adds **on-device storage** (cookie, localStorage, cache) → the § 25
     TDDDG inventory in the policy;
   - moves processing (provider, region) → the transfer statements;
   - **could make an age clause necessary.** The Nutzungsbedingungen carry
     **no minimum-age clause on purpose** (#140, operator decision
     2026-07-21): the app has no consent-based processing (so Art. 8 DSGVO's
     16-year consent age never triggers), it is a DSA *hosting service* whose
     tenant content is not disseminated to the public (so the Art. 28 DSA
     platform minors-duties don't apply), and children join rounds as
     name-only members without accounts. Each leg of that reasoning is a
     trigger: re-evaluate the age question — in the same PR — when a change
     introduces **consent-based processing** (tracking, ads, newsletter,
     any Art. 6(1)(a) purpose), a **paid tier** (minors' limited contractual
     capacity, §§ 104 ff. BGB — see #173), **public dissemination of user
     content** (public rounds/sharing would move the service toward the DSA
     platform tier and its minors duties, incl. Art. 14(3) child-intelligible
     terms), or **child-directed features**. If any leg falls, add a
     minimum-age or parental-consent clause to the Nutzungsbedingungen
     (both languages) as part of that change.
2. **Is the change VALID against what the documents promise?** The published
   text is a ceiling. Check the change doesn't breach a stated commitment —
   "no analytics/tracking storage", "logs carry no message content"
   (`product-event-logging.md`), the named-recipients-only sharing claim,
   feedback deletion, the e-mail-free erasure record. If a feature needs more
   than the documents allow, the document change is *part of the feature* and
   ships with it — never silently after.

`test/legal.test.js` pins marker strings for every named processor (Railway,
Cloudflare, Brevo, Heinlein) — so *removing/renaming* one in the policy fails
loudly, but *adding* a processor in code without disclosing it fails no test.
Direction 1 is on you; when you add a processor, also add its marker there.

**Why:** added after #307 — the operator mailbox moved to Heinlein Hosting
(mailbox.org) with a concluded AVV, and nothing in the workflow prompted the
policy/VVT update; it surfaced only because the operator happened to ask.
`vvt.md`'s own header ("update both together when a data flow changes") said
it, but no rule enforced it at implementation time.
