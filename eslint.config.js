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
  applyStaticTexts: 'readonly', setupLangPicker: 'readonly', gamesSort: 'writable',
  randomOrderCache: 'readonly', randomOrderedGames: 'readonly',
  gameStatsForSession: 'readonly', gameStats: 'readonly',
  retireRecommendations: 'readonly', minimizedRecs: 'readonly',
  STANDARD_ACCENT: 'readonly', STANDARD_PATTERN: 'readonly', TEXTURES: 'readonly',
  textureImage: 'readonly', applyBackground: 'readonly', avgColor: 'readonly',
  MEMBER_COLORS: 'readonly', memberColor: 'readonly', initials: 'readonly',
  themeAccent: 'readonly',
  activePopover: 'writable', closePopover: 'readonly', openPopover: 'readonly',
  readClipboardImage: 'readonly', shuffled: 'readonly', typeTag: 'readonly',
  durationTag: 'readonly', playersTag: 'readonly', typeBadge: 'readonly',
  durationBadge: 'readonly',
  // views-home.js
  showHome: 'readonly', showNewRound: 'readonly',
  // views-round.js
  showRound: 'readonly', showRetired: 'readonly', THEMES: 'readonly',
  showBackground: 'readonly', showGameDetail: 'readonly', showAddGame: 'readonly',
  HUB_TABS: 'readonly', renderHubDock: 'readonly', renderStartTab: 'readonly',
  renderRegalTab: 'readonly', renderChronikTab: 'readonly',
  // views-session.js
  showStartSession: 'readonly', startVoting: 'readonly', showResults: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
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
];
