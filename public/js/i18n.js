/* Familien-Spielesammlung – internationalization (i18n).
   Loads before all other scripts. Translations live in js/lang/<locale>.js,
   each registering into the global I18N object (one "properties file" per
   language). The active locale follows the system language by default and can
   be overridden via the picker in the top bar (stored in localStorage). */

const I18N = {};
const SUPPORTED_LOCALES = ['en', 'de'];
const LOCALE_LABELS = { en: 'English', de: 'Deutsch' };

let locale = 'en';

// Pick the active locale: saved choice -> system language -> English.
function detectLocale() {
  const saved = localStorage.getItem('locale');
  if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  const sys = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED_LOCALES.includes(sys) ? sys : 'en';
}

function initLocale() {
  locale = detectLocale();
  document.documentElement.lang = locale;
}

function getLocale() {
  return locale;
}

function setLocale(loc) {
  if (!SUPPORTED_LOCALES.includes(loc)) return;
  locale = loc;
  localStorage.setItem('locale', loc);
  document.documentElement.lang = loc;
}

// Translate a key; falls back to English, then to the key itself. Replaces
// {placeholders} from params.
function t(key, params) {
  const dict = I18N[locale] || {};
  let s = key in dict ? dict[key] : I18N.en && key in I18N.en ? I18N.en[key] : key;
  if (params) {
    for (const k in params) s = s.split('{' + k + '}').join(params[k]);
  }
  return s;
}

// Plural helper: choose the "one" or "other" key based on n.
function tn(n, keyOne, keyOther, params) {
  return t(n === 1 ? keyOne : keyOther, Object.assign({ n }, params || {}));
}

// Locale-aware date/time formatting (uses the matching BCP-47 tag).
function fmtDateTime(iso) {
  const tag = locale === 'de' ? 'de-DE' : 'en-US';
  return new Date(iso).toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' });
}

// Month + year, for timeline group labels ("Juli 2026").
function fmtMonth(iso) {
  const tag = locale === 'de' ? 'de-DE' : 'en-US';
  return new Date(iso).toLocaleString(tag, { month: 'long', year: 'numeric' });
}
