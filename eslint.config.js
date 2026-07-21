'use strict';

// Flat ESLint config. No build step in this project, so this only lints.
// Two worlds: the Node.js backend (CommonJS) and the frontend classic
// `<script>`s under public/js, which share ONE global scope in a fixed load
// order (see public/index.html and .claude/rules/frontend-script-load-order.md).

const js = require('@eslint/js');
const globals = require('globals');

// Names the frontend scripts define at top level and reference across files.
// Declaring them here lets `no-undef` catch typos and load-order mistakes
// (referencing something not yet defined) without flagging the legitimate
// cross-file calls. 'writable' = reassigned somewhere; 'readonly' = not.
const frontendGlobals = {
  // i18n.js
  I18N: 'writable', SUPPORTED_LOCALES: 'readonly', LOCALE_LABELS: 'readonly',
  locale: 'writable', detectLocale: 'readonly', initLocale: 'readonly',
  getLocale: 'readonly', setLocale: 'readonly', t: 'readonly', tn: 'readonly',
  fmtDateTime: 'readonly', fmtMonth: 'readonly',
  // core.js
  app: 'readonly', crumbs: 'readonly', toastEl: 'readonly',
  currentView: 'writable', h: 'readonly', esc: 'readonly', toastTimer: 'writable',
  toast: 'readonly', api: 'readonly', setCrumbs: 'readonly', joinNames: 'readonly',
  fetchRound: 'readonly', invalidateRoundCache: 'readonly',
  fetchActivities: 'readonly', fetchRoundList: 'readonly', fetchRoundFresh: 'readonly',
  swrStore: 'readonly', swrRenderToken: 'writable', uiBusy: 'readonly',
  // swr.js
  createSwrStore: 'readonly',
  // focus-trap.js
  trapFocus: 'readonly', focusables: 'readonly', FOCUSABLE: 'readonly',
  applyStaticTexts: 'readonly', setupLangPicker: 'readonly', gamesSort: 'writable',
  regalFilters: 'writable', regalFiltersRid: 'writable',
  TAG_STATES: 'readonly', cycleTagState: 'readonly',
  paintTagChip: 'readonly', matchesTagFilter: 'readonly',
  tagIconPicker: 'readonly',
  randomOrderCache: 'readonly', randomOrderedGames: 'readonly',
  gameStatsForSession: 'readonly', gameStats: 'readonly',
  retireRecommendations: 'readonly', minimizedRecs: 'readonly',
  STANDARD_ACCENT: 'readonly',
  applyBackground: 'readonly', avgColor: 'readonly',
  MEMBER_COLORS: 'readonly', memberColor: 'readonly', initials: 'readonly',
  renderSeatPicker: 'readonly',
  themeAccent: 'readonly', resolveAccent: 'readonly',
  activePopover: 'writable', closePopover: 'readonly', openPopover: 'readonly',
  readClipboardImage: 'readonly', shuffled: 'readonly', iconText: 'readonly',
  createCoverLoader: 'readonly',
  makeGameLink: 'readonly', makeMemberLink: 'readonly',
  GAME_ICON: 'readonly', playersTag: 'readonly', playersText: 'readonly',
  // account.js (issue #138): onboarding + token wiring, shared with core.js api()
  accountsMode: 'writable', accountUser: 'writable',
  SA_ACCESS: 'readonly', SA_REFRESH: 'readonly', saStore: 'readonly',
  getAccessToken: 'readonly', getRefreshToken: 'readonly',
  setTokens: 'readonly', clearTokens: 'readonly',
  accountsActive: 'readonly', isLoggedIn: 'readonly', authFetch: 'readonly',
  probeMe: 'readonly', refreshAccessToken: 'readonly', onSessionLost: 'readonly',
  logout: 'readonly', isAuthPath: 'readonly', bootApp: 'readonly',
  initAccounts: 'readonly', enterApp: 'readonly', authScreen: 'readonly',
  openAuth: 'readonly', authError: 'readonly', setError: 'readonly',
  showLogin: 'readonly', showRegister: 'readonly', showForgot: 'readonly',
  showAuthDone: 'readonly', renderVerifyLanding: 'readonly',
  renderResetLanding: 'readonly', setupAccountUi: 'readonly',
  // feedback.js (issue #260)
  FEEDBACK_MESSAGE_MAX: 'readonly', showFeedback: 'readonly',
  setupFeedbackUi: 'readonly',
  // ranking.js + lookup-group.js + lookup-cover.js + cover.js + tag-icons.js
  // (also CommonJS modules for tests — hence `module`)
  computePlaces: 'readonly', groupLookupHits: 'readonly', module: 'readonly',
  gameHue: 'readonly', coverPlaceholder: 'readonly',
  coverUrl: 'readonly', COVER_THUMB: 'readonly', COVER_CARD: 'readonly',
  COVER_HERO: 'readonly', COVER_RESIZERS: 'readonly',
  providerMatchCover: 'readonly',
  TAG_ICONS: 'readonly', tagIconClass: 'readonly',
  // views-home.js
  showHome: 'readonly', showNewRound: 'readonly',
  // views-round.js (hub + Start tab) and its siblings loaded right after it:
  // views-round-tabs.js, views-round-detail.js, views-round-lookup.js. They
  // share one global scope, so all their top-level names are listed together.
  showRound: 'readonly', showRetired: 'readonly', showCompleted: 'readonly',
  showArchive: 'readonly', ARCHIVES: 'readonly', THEMES: 'readonly',
  showBackground: 'readonly', showGameDetail: 'readonly', showAddGame: 'readonly',
  showTags: 'readonly', showMoveGames: 'readonly', showProviders: 'readonly',
  HUB_TABS: 'readonly', renderHubDock: 'readonly', renderStartTab: 'readonly',
  renderRegalTab: 'readonly', renderChronikTab: 'readonly', renderPokaleTab: 'readonly',
  activeSheet: 'writable', closeSheet: 'readonly', openSheet: 'readonly',
  startDirectSession: 'readonly',
  showLinkProvider: 'readonly', attachLookup: 'readonly', searchProvider: 'readonly',
  enabledProviders: 'readonly', lookupDetail: 'readonly',
  scoreHit: 'readonly', providerLabel: 'readonly',
  providerLogo: 'readonly', PROVIDER_LOGOS: 'readonly',
  PROVIDER_LABELS: 'readonly', LOOKUP_PROVIDERS: 'readonly', MAX_SUGGESTIONS: 'readonly',
  // views-member.js
  showMember: 'readonly', memberStats: 'readonly',
  // views-session.js
  showStartSession: 'readonly', startVoting: 'readonly', showResults: 'readonly',
  showFinale: 'readonly',
  // router.js
  routing: 'writable', navIndex: 'writable', roundPath: 'readonly',
  syncUrl: 'readonly', navBack: 'readonly', resolveRoute: 'readonly',
  routeTo: 'readonly', showResultsById: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'dist/**'] },
  js.configs.recommended,
  {
    // Empty `catch {}` is a deliberate "swallow and keep the default" idiom here.
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // Node.js backend + tests (CommonJS).
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // Frontend classic scripts: shared global scope, browser environment.
    // These files hand-roll a "module system" over one global scope, so three
    // recommended rules fight the pattern and are relaxed here:
    //  - no-redeclare: each shared name is BOTH declared in its home file and
    //    listed in `frontendGlobals` so consumers don't trip no-undef.
    //  - no-unused-vars is scoped to `vars: 'local'` so top-level functions
    //    used only from *other* files aren't flagged (ESLint lints per file and
    //    can't see cross-file use); unused *locals* inside functions still are.
    // Everything else recommended (no-dupe-keys on the lang tables, no-undef for
    // real typos, no-unreachable, valid-typeof, …) stays on.
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...frontendGlobals },
    },
    rules: {
      'no-redeclare': 'off',
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'all' }],
    },
  },
  {
    // The service worker (public/sw.js) runs in the ServiceWorkerGlobalScope,
    // not a window: its own globals (self, caches, clients, skipWaiting, …).
    // It's outside public/js/**, so it needs its own block rather than the
    // frontend one above.
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
];
