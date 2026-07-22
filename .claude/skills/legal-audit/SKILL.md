---
name: legal-audit
description: >-
  Audit the app's legal surface — privacy policy, Impressum, Nutzungsbedingungen
  and the internal records in docs/legal/ — against what the code actually does,
  and surface recent legal developments as a sourced reading list. Use when asked
  for a legal/privacy/GDPR/DSGVO/compliance audit, to check whether the policy
  still matches the app, or before opening public registration. Produces a ranked
  report; files issues only with your approval, and never adopts a legal duty on
  its own.
---

# Legal audit

The job is **consistency**: the published documents are promises about how a live
service handles real people's personal data, and nothing in CI diffs them against
the code. This skill finds where they have drifted apart, in both directions.

**Read `.claude/skills/audit/audit-loop.md` first** — it owns the loop. This file
owns the domain.

Pass `--research` to force a research pass; otherwise the cadence in `criteria.md`
decides.

## The boundary that defines this skill

**Research produces a reading list. It never writes a legal criterion.**

An agent is not a lawyer; search results on German and EU law range from statute
text to SEO filler; and the output here is a public statement about processing
personal data. So phase B collects, with source URL and date, and phase C
critiques — but findings land in the **report** under "for your judgement", not in
`criteria.md`. A new legal duty enters the criteria only when the user says so
explicitly (`L-R04`, which is a meta-criterion — do not remove it).

Write each research finding as: what changed · who it binds · why it might or
might not bind this app · the primary source · the date. Then say plainly which
ones you think deserve the user's attention and which look like noise.

Prefer primary sources: EUR-Lex, gesetze-im-internet.de, the EDPB, the responsible
Landesdatenschutzbehörde, official DSA guidance. A law-firm blog is a pointer to a
source, not a source.

## The mechanical audit (phase E) — derive from code, compare to documents

The method that makes this worth running: **never read the documents and ask "does
this look complete?"** Build the true list from the code, then diff.

### 1. Recipients — who gets data

Derive, don't recall:

```bash
# server-side network egress
grep -rnE "fetch\(|https?://" lib/ routes/ --include=*.js | grep -v "^.*test" | head -40
grep -nE '"[a-z0-9@/-]+":' package.json          # runtime deps that talk to a network
# browser-side egress: the CSP is the machine-readable inventory
grep -nE "img-src|connect-src|script-src|frame-src|font-src" lib/app.js
grep -rn "IMAGE_HOSTS" lib/providers/
```

Then diff that set against the processor section, the recipient list (**both
languages**), `docs/legal/vvt.md`, and the AVV inventory. Remember the browser is a
data-discloser too: hotlinked covers send the visitor's IP to five providers
(`provider-cover-hotlinking.md`), and a donation link, an embed or a remote font
would each add a recipient. → **L-001, L-002**

### 2. On-device storage — the § 25 TDDDG inventory

```bash
grep -rnE "localStorage|sessionStorage|document\.cookie|caches\.open|res\.cookie" \
  public/js lib routes --include=*.js
```

Every hit needs an inventory entry with purpose and lifetime. A new one that is
*not* strictly necessary also reopens L-R03 (the no-banner decision). → **L-003**

### 3. Data categories and retention

Walk the schema in `lib/repo/migrations/` and `lib/store.js`, not the docs. New
columns and new free-text fields are the usual drift. Confirm each category, legal
basis and retention appear in the policy *and* `vvt.md`, and that
`docs/legal/retention.md` matches what the code actually deletes — note where
retention is still manual (the 3-year moderation-log purge, #311). → **L-004, L-008**

### 4. The reverse direction — does the code breach a promise?

This is the half that is easy to skip and the half that produces real findings.
Check the published commitments against implementations: the `trackEvent` field
allowlist and `requestLogger`'s `customProps` (`product-event-logging.md`), the
"no analytics/tracking" claim, feedback deletion, the e-mail-free erasure record,
the named-recipients-only sharing claim. → **L-005**

### 5. Structural checks

DE/EN parity of every section; a `test/legal.test.js` marker per named processor;
the env-gated 404 behaviour; § 5 DDG rather than the repealed TMG; and the
deployment regions behind the transfer statements — verify the *platform*, not the
code, since a service can be moved without a commit (`railway-db-same-region.md`).
→ **L-006, L-009, L-010, L-011**

### 6. Trigger sweep

Run the L-007 trigger list against everything that shipped since the last audit:
consent-based processing, a paid tier, public dissemination of user content,
child-directed features. Any one of them reopens the age-clause question *and*
usually more. Open issues matter here too — #322 (public landing page), #325/#338
(friendships, cross-round voting) and #207 (round sharing) move toward
dissemination, so flag them as *forthcoming* triggers, not current violations.

## Two hard limits on what you may read

- **Never read the production `data/` directory** — not to "check what personal
  data we actually store". The schema is fully described by code, migrations and
  tests (`no-reading-production-data.md`). Same for `.env`
  (`no-reading-env-files.md`): the variable names and meanings are in
  `.env.example` and the code.
- **Stored feedback is readable only on an explicit request in that turn**, and
  only the feedback rows (`reading-feedback-data.md`). A legal audit is *not* such
  a request. If a finding needs feedback content, ask first.

## Output

Two sections, kept apart:

1. **Findings** — drift between code and documents, ranked, each with the file and
   the evidence. These follow the normal remedy ladder in `audit-loop.md` §F.
2. **For your judgement** — the research reading list. Sourced, dated, with your
   read on relevance. Nothing here becomes an issue or a criterion without the
   user choosing it.

When a finding means a document must change, remember the document change **ships
with** the code change that caused it (`keep-legal-docs-current.md`) — so the
remedy is usually "amend the policy in the same PR as X", not a standalone ticket.
