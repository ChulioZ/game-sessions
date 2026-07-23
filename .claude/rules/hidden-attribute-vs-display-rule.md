# A `hidden` attribute loses to any author `display` rule — gate visibility with `[hidden]`

The `hidden` HTML attribute hides an element only via the **UA stylesheet's**
`[hidden] { display: none }`. Author rules beat the UA stylesheet, so the moment
a selector gives that element its own `display`, the attribute stops hiding it —
with **no error and no lint warning**.

Found on #322 (logged-out landing): the operator-gated "EU-Hosting" trust chip
shipped as `<li class="landing-chip" data-operator-only hidden>` and was revealed
by JS (`el.hidden = false`) only on the configured operator instance. But
`.landing-chip { display: inline-flex }` overrode the attribute, so the chip
rendered on **every** instance — i.e. it published "Hosted in the EU" on a
self-hoster's non-EU deployment, the exact false claim the gate existed to
prevent (`.claude/rules/keep-legal-docs-current.md`).

## The rule

Any element you hide with the `hidden` attribute **and** also give a `display`
rule needs an explicit `selector[hidden] { display: none }` to restore the
attribute's effect. This codebase's BEM-ish components almost always set
`display`, so the attribute alone is rarely enough — prefer the paired rule, or
toggle a class instead of the attribute.

## The verification trap that hid it

The DOM probe lied. `el.hidden` is the **IDL attribute** — it returned `true`
(the attribute *was* present) while the element was fully visible, because CSS,
not the attribute, decides painting. **Probe `getComputedStyle(el).display`, not
`el.hidden`,** when checking whether something is actually hidden. Only the
on-screen screenshot caught it here — which is why a substantial UI change gets a
real browser pass, not just green DOM assertions
(`.claude/rules/preview-pane-paint-artifacts.md` is the sibling "the probe is
lying to you" family).
