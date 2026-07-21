/* Spielwirbel – bootstrap (loads last). */

'use strict';

initLocale();
applyStaticTexts();
setupLangPicker();
initFooter();
// Resolve the account state (#138) first, then render: in accounts mode this may
// show the auth UI instead of routing into the app; in legacy mode bootApp just
// routes the current URL (deep link / reload), not always Home.
bootApp();
