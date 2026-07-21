'use strict';

/*
 * Legal pages (issue #134): GET /impressum and GET /datenschutz, mounted ahead
 * of the auth gate in createApp() — a legal notice must be reachable without a
 * login (§ 5 DDG: "leicht erkennbar, unmittelbar erreichbar, ständig
 * verfügbar").
 *
 * Both routes answer 404 while the operator identity is not configured
 * (IMPRESSUM_ADDRESS + IMPRESSUM_EMAIL — checked per request, like every other
 * env read). Deliberately a hard 404, not a fall-through to the SPA shell: an
 * unconfigured instance must not publish a partial Impressum, and a crawler
 * must not index an app shell at these URLs. The site footer hides its links
 * through the same condition via GET /api/config (lib/app.js).
 */

const express = require('express');
const legal = require('../lib/legal');

const router = express.Router();

function page(render) {
  return (req, res) => {
    if (!legal.legalConfigured()) return res.status(404).type('text/plain').send('Not Found');
    res.type('html').send(render());
  };
}

router.get('/impressum', page(legal.renderImpressum));
router.get('/datenschutz', page(legal.renderDatenschutz));

module.exports = router;
