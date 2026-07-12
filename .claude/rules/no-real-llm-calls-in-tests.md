# Never call a real LLM model in tests or AI-session verification

The only outbound LLM call in the app is the buy-next recommendations layer
(`routes/recommendations.js` → the Claude Messages API, `POST
/api/rounds/:rid/recommendations`). Every such call is **billed** against the
real `ANTHROPIC_API_KEY` (see `.claude/rules/no-reading-env-files.md`). Nothing
about verifying the code needs a genuine model reply.

**Rule:** do **not** let a real model call happen — neither in automated tests
nor while testing by hand in an AI session (a real browser, a `curl`, a preview
tab). This holds even if a key is configured on the machine.

- **Automated tests** must stub the network, never hit the provider. The route
  calls the global `fetch`, so override it and restore it afterwards, exactly
  like the lookup-provider tests:

  ```js
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  // in a test:
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: JSON.stringify([{ title: 'Splendor', reason: 'x' }]) }],
  }) });
  ```

  Also set/clear `process.env.ANTHROPIC_API_KEY` yourself and restore it in
  `afterEach` (a stubbed `fetch` never reads the value, so a dummy `'test-key'`
  is enough). Unit-test the pure helpers (`buildProfile`, `buildPrompt`,
  `parseItems`, `platformSearchUrl`) directly — they need no network at all. See
  `test/recommendations.test.js` for the full pattern, and the sibling
  "never hit the network" note in `.claude/rules/add-game-lookup-provider.md`.

- **Manual / browser verification in an AI session** must not click "Vorschläge
  generieren" (or otherwise trigger the POST) against the real API to "see it
  work". Verify the surrounding behavior instead — the loading/empty/error
  states, the run history UI, the parsing — by pointing the client at a stubbed
  or `not_configured`/`provider_unreachable` response, not a live generation.

**The one exception — ask first.** If a real model call would be *genuinely
valuable* to prove a new feature actually works end-to-end (something a stub
can't establish), **stop and ask the user for explicit, one-time permission
before making it.** Do not decide on your own that "just one real call" is fine
— each one costs money, and the user gates that per occurrence. Get a clear yes
in chat first; permission for one call does not carry over to the next.

**Why:** these calls spend real money on every invocation, and the entire app
(and its test suite) is designed to degrade without the key — so a real reply
proves nothing a stub can't. An agent that fires the live API "to check"
silently runs up the bill for no verification value. This mirrors the network
isolation the provider tests already follow; the recommendations layer is the
same idea plus a direct cost.
