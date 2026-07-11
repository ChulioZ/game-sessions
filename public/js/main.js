/* Spieleabend – bootstrap (loads last). */

'use strict';

initLocale();
applyStaticTexts();
setupLangPicker();
// Render the view for the current URL (deep link / reload), not always Home.
routeTo(location.pathname);
