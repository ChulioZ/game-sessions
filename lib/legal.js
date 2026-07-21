'use strict';

/*
 * Legal pages (issue #134): the DDG Impressum and the DSGVO privacy policy,
 * server-rendered so the operator's postal address and contact e-mail come from
 * env at REQUEST time (IMPRESSUM_ADDRESS / IMPRESSUM_EMAIL — see the runtime
 * gate in /api/config, lib/app.js). No placeholder identity ever lives in the
 * repo: while either var is unset the routes 404 and the footer links stay
 * hidden, so a half-configured instance publishes nothing.
 *
 * Content rules (issue #134's completion bar — keep them when editing):
 *  - Every processing purpose described here must be traceable to a real data
 *    flow in this repo. Nothing described that the app does not do; when a
 *    data flow changes, this text changes in the same PR. The 2026-07-21
 *    adversarial pass caught real drift (feedback tenant-id, product events,
 *    Wikidata search, SWR cache) — that bar is what keeps this text honest.
 *  - German is the authoritative text; the English section is a courtesy
 *    translation and says so.
 *  - NO link to the EU ODR platform — it was shut down 2025-07-20 (Reg. (EU)
 *    2024/3228); linking it today is itself misleading (§ 5 UWG risk).
 *  - Cite § 5 DDG (in force 2024-05-14, replacing § 5 TMG) and § 25 TDDDG —
 *    never the old TMG/TTDSG names.
 *
 * The operator's NAME is hardcoded (it is public in LICENSE, #171); only the
 * address and e-mail are env-driven, because they don't exist until the rented
 * service address / mailbox (#307) are in place.
 */

const OPERATOR_NAME = 'Julian Zenker';

// The date shown as "Stand" on both documents. Bump when the content changes.
const REVISION = '2026-07-21';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Both vars must be non-blank for the pages (and the site footer, which also
// requires working mail — lib/app.js) to exist at all.
function impressumAddress() { return (process.env.IMPRESSUM_ADDRESS || '').trim(); }
function impressumEmail() { return (process.env.IMPRESSUM_EMAIL || '').trim(); }
function legalConfigured() { return impressumAddress() !== '' && impressumEmail() !== ''; }

// The address env var may carry real newlines (Railway supports multi-line
// values) or literal "\n" sequences (a plain .env line) — render both as line
// breaks, after escaping.
function renderAddress(raw) {
  return esc(raw).replace(/\\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('<br>');
}

// Shared document shell: a plain, readable, script-free page. Inline styles are
// allowed by the CSP (style-src 'unsafe-inline'); scripts are deliberately
// absent — a legal page must render with nothing but HTML. The English half is
// wrapped in lang="en" so assistive tech switches pronunciation.
function layout(title, deHtml, enHtml) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)} · Spielwirbel</title>
  <link rel="icon" href="/icons/icon-192.png" sizes="192x192" type="image/png" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0 auto;
      max-width: 760px;
      padding: 2.5rem 1.5rem 4rem;
      background: #faf8f5;
      color: #26221c;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
    }
    h1 { font-size: 1.7rem; margin: 0 0 0.3rem; }
    h2 { font-size: 1.2rem; margin: 2rem 0 0.5rem; }
    p, li { font-size: 0.97rem; }
    a { color: #c2410c; }
    .meta { color: #6b6257; font-size: 0.88rem; margin-bottom: 2rem; }
    .lang-note { background: #f1ede6; border-radius: 10px; padding: 0.7rem 1rem; font-size: 0.9rem; }
    .highlight { border: 1px solid #d9d1c3; border-left: 4px solid #c2410c; border-radius: 8px; padding: 0.7rem 1rem; }
    hr.split { margin: 3rem 0; border: 0; border-top: 2px solid #e4ded4; }
    .foot { margin-top: 3rem; font-size: 0.9rem; color: #6b6257; }
  </style>
</head>
<body>
${deHtml}
<hr class="split" id="en">
<div lang="en">
${enHtml}
</div>
<p class="foot"><a href="/">← Spielwirbel</a> · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/kontakt.html">Kontakt</a></p>
</body>
</html>`;
}

/* ------------------------------------------------------------------------- *
 * Impressum (§ 5 DDG)
 * ------------------------------------------------------------------------- */

function renderImpressum() {
  const addr = renderAddress(impressumAddress());
  const mail = esc(impressumEmail());
  const de = `
<h1>Impressum</h1>
<p class="meta">Stand: ${REVISION} · <a href="#en">English version below</a></p>

<h2>Angaben gemäß § 5 DDG</h2>
<p>${esc(OPERATOR_NAME)}<br>${addr}</p>

<h2>Kontakt</h2>
<p>E-Mail: <a href="mailto:${mail}">${mail}</a><br>
Für eine schnelle elektronische Kontaktaufnahme steht außerdem das
<a href="/kontakt.html">Kontaktformular</a> zur Verfügung.</p>

<h2>Hinweise</h2>
<p>Spielwirbel ist ein privat betriebener, unentgeltlicher Dienst. Eine
Umsatzsteuer-Identifikationsnummer besteht nicht; ein Handelsregistereintrag
besteht nicht.</p>
<p>Meldungen zu rechtswidrigen Inhalten (Notice-and-Action) können über das
<a href="/kontakt.html">Kontaktformular</a> oder per E-Mail an die oben genannte
Adresse gerichtet werden.</p>`;

  const en = `
<h1>Legal notice (Impressum)</h1>
<p class="lang-note">Courtesy translation — the German version above is
authoritative.</p>

<h2>Information pursuant to § 5 DDG (German Digital Services Act)</h2>
<p>${esc(OPERATOR_NAME)}<br>${addr}</p>

<h2>Contact</h2>
<p>E-mail: <a href="mailto:${mail}">${mail}</a><br>
For fast electronic contact you can also use the
<a href="/kontakt.html">contact form</a>.</p>

<h2>Notes</h2>
<p>Spielwirbel is a privately operated, free service. There is no VAT
identification number and no commercial-register entry.</p>
<p>Reports of allegedly illegal content (notice and action) can be submitted via
the <a href="/kontakt.html">contact form</a> or by e-mail to the address
above.</p>`;

  return layout('Impressum', de, en);
}

/* ------------------------------------------------------------------------- *
 * Datenschutzerklärung (DSGVO) — derived from the app's actual data flows.
 * ------------------------------------------------------------------------- */

function renderDatenschutz() {
  const addr = renderAddress(impressumAddress());
  const mail = esc(impressumEmail());
  const de = `
<h1>Datenschutzerklärung</h1>
<p class="meta">Stand: ${REVISION} · <a href="#en">English version below</a></p>

<h2>1. Verantwortlicher</h2>
<p>${esc(OPERATOR_NAME)}<br>${addr}<br>
E-Mail: <a href="mailto:${mail}">${mail}</a></p>
<p>Post an die genannte Anschrift wird durch einen Empfangsdienstleister
entgegengenommen und an den Verantwortlichen weitergeleitet. Ein
Datenschutzbeauftragter ist nicht benannt (keine gesetzliche Pflicht).</p>

<h2>2. Das Wichtigste in Kürze</h2>
<ul>
  <li>Spielwirbel setzt <strong>kein Tracking, keine Analyse-Tools und keine
  Werbung</strong> ein.</li>
  <li>Es werden nur Cookies und lokale Speicherung verwendet, die für den
  Betrieb <strong>unbedingt erforderlich</strong> sind (Anmeldung,
  Spracheinstellung, lokaler Daten-Cache) — deshalb gibt es keinen
  Cookie-Banner (§ 25 Abs. 2 TDDDG).</li>
  <li>Schriftarten und alle Skripte werden <strong>selbst gehostet</strong>;
  beim normalen Aufruf der Seite werden keine Inhalte von Dritten geladen. Die
  eine Ausnahme sind von dir verknüpfte Spiele-Cover externer Anbieter
  (Abschnitt 7).</li>
  <li>Alle Daten werden über <strong>TLS (HTTPS)</strong> übertragen; Anwendung
  und Datenbank laufen in einem <strong>EU-Rechenzentrum</strong>, hochgeladene
  Bilder liegen bei Cloudflare (Abschnitt 6).</li>
</ul>

<h2>3. Hosting, Server-Logs und Datenbank</h2>
<p>Die Anwendung läuft bei <strong>Railway Corp.</strong> (USA) in einer
Rechenzentrums-Region in der EU; dort werden auch die Datenbank (PostgreSQL)
und die Anwendungs-Logs betrieben. Mit Railway besteht ein
Auftragsverarbeitungsvertrag (Art. 28 DSGVO) einschließlich
EU-Standardvertragsklauseln für den Fall eines Zugriffs aus einem Drittland
(Art. 46 Abs. 2 lit. c DSGVO).</p>
<p>Beim Aufruf des Dienstes verarbeitet der Server pro Anfrage technisch:
<strong>IP-Adresse, HTTP-Methode, Pfad, Statuscode und Bearbeitungsdauer</strong>.
Anfrageinhalte (Formulardaten, Suchbegriffe, Cookies) werden bewusst
<strong>nicht</strong> protokolliert. Zusätzlich protokollieren wir
<strong>pseudonyme Nutzungsereignisse</strong> — die Art einer Aktion (z. B.
„Runde angelegt“) zusammen mit der Konto-/Mandanten-Kennung, nie Inhalte — um
die Nutzung des Dienstes in Grundzügen zu verstehen. Bei schweren Fehlern kann,
sofern konfiguriert, eine Benachrichtigung (Zeitpunkt, Pfad, Fehlermeldung —
keine Inhalte, keine IP-Adresse) an einen Messaging-Dienst des Betreibers
gesendet werden. Zweck ist der sichere und stabile Betrieb (Fehlersuche,
Missbrauchs- und Angriffserkennung, Ratenbegrenzung); Rechtsgrundlage ist unser
berechtigtes Interesse an einem sicheren Betrieb (Art. 6 Abs. 1 lit. f DSGVO).
Die Logs unterliegen der automatischen Aufbewahrungsgrenze der
Hosting-Plattform und werden nicht mit anderen Daten zusammengeführt.</p>

<h2>4. Konto und Registrierung</h2>
<p>Wenn du ein Konto anlegst, verarbeiten wir deine
<strong>E-Mail-Adresse</strong> und ein <strong>Passwort</strong>, das
ausschließlich als moderner Hash (Argon2id) gespeichert wird — im Klartext wird
es zu keinem Zeitpunkt gespeichert. Zur Bestätigung der E-Mail-Adresse und für
das Zurücksetzen des Passworts werden kurzlebige Token erzeugt (ebenfalls nur
gehasht gespeichert) und dir per E-Mail zugesandt. Rechtsgrundlage ist die
Durchführung des Nutzungsverhältnisses (Art. 6 Abs. 1 lit. b DSGVO).</p>
<p>Kontodaten werden gespeichert, bis das Konto gelöscht wird. Die Löschung
kannst du formlos über die oben genannten Kontaktwege verlangen; sie umfasst
sämtliche Daten des Kontos einschließlich aller Runden und hochgeladenen
Bilder. Bestehen bleibt nur ein minimaler Nachweis des Löschvorgangs ohne
E-Mail-Adresse (Abschnitt 12).</p>

<h2>5. Runden- und Spieldaten</h2>
<p>Der Zweck des Dienstes ist die Verwaltung von Spielrunden. Dazu speichern
wir die eingegebenen Inhalte: <strong>Rundennamen, Spieltitel, Mitgliedsnamen,
Bewertungen/Stimmen, Schlagworte (Tags), eine Aktivitäten-Chronik sowie
hochgeladene Cover-Bilder</strong>. Mitgliedsnamen sind frei wählbar — wer
echte Namen dritter Personen einträgt, sollte deren Einverständnis haben.
Rechtsgrundlage ist die Bereitstellung des Dienstes (Art. 6 Abs. 1 lit. b
DSGVO). Diese Daten sind nur innerhalb des jeweiligen Kontos (Mandanten)
sichtbar und bleiben gespeichert, bis sie von dir oder mit dem Konto gelöscht
werden.</p>

<h2>6. Hochgeladene Bilder</h2>
<p>Selbst hochgeladene Cover-Bilder werden in einem S3-kompatiblen
Objektspeicher bei <strong>Cloudflare, Inc.</strong> (USA) abgelegt und
ausschließlich über unseren Server ausgeliefert (kein öffentlicher
Bucket-Zugriff). Rechtsgrundlage ist die Bereitstellung des Dienstes
(Art. 6 Abs. 1 lit. b DSGVO). Mit Cloudflare besteht ein
Auftragsverarbeitungsvertrag; Cloudflare ist unter dem <strong>EU-US Data
Privacy Framework</strong> zertifiziert (Art. 45 DSGVO), ergänzend gelten
Standardvertragsklauseln.</p>

<h2>7. Spiele-Cover externer Anbieter (Hotlinking)</h2>
<p>Beim Anlegen eines Spiels kannst du ein offizielles Cover eines
Spiele-Anbieters verknüpfen. Solche Cover werden <strong>nicht von uns
kopiert</strong>, sondern von deinem Browser direkt beim jeweiligen Anbieter
geladen. Dabei erhält der Anbieter deine <strong>IP-Adresse</strong> und die
üblichen Browser-Angaben — so, als hättest du dessen Website selbst
aufgerufen. Mögliche Anbieter (abhängig davon, welche Cover in deiner Runde
verknüpft sind):</p>
<ul>
  <li>Sony Interactive Entertainment — <code>image.api.playstation.com</code> / <code>playstation.net</code></li>
  <li>Valve Corporation (Steam) — <code>steamstatic.com</code></li>
  <li>Nintendo — <code>nintendo.com</code></li>
  <li>Microsoft (Xbox) — <code>s-microsoft.com</code></li>
  <li>BoardGameGeek — <code>geekdo-images.com</code></li>
</ul>
<p>Diese Anbieter sitzen teilweise in Drittländern (insbesondere USA und
Japan); auf deren Verarbeitung haben wir keinen Einfluss. Rechtsgrundlage ist
unser berechtigtes Interesse, verknüpfte Cover anzuzeigen, ohne urheberrechtlich
geschützte Bilder selbst zu vervielfältigen (Art. 6 Abs. 1 lit. f DSGVO). Wer
das nicht möchte, kann Spiele ohne Anbieter-Cover anlegen oder eigene Bilder
hochladen.</p>

<h2>8. Suchanfragen an Spiele-Anbieter (Titel-Suche)</h2>
<p>Die Titel-Suche beim Anlegen eines Spiels fragt die Kataloge der oben
genannten Anbieter ab; für Brettspiele wird zusätzlich der offene Wissensdienst
<strong>Wikidata</strong> (Wikimedia Foundation, Inc., USA) abgefragt. Alle
diese Anfragen stellt <strong>unser Server</strong> — übermittelt wird nur der
eingegebene Suchbegriff, nie deine IP-Adresse oder andere Daten über dich.</p>

<h2>9. E-Mail-Versand (Brevo)</h2>
<p>System-E-Mails (Bestätigung der E-Mail-Adresse, Passwort-Zurücksetzen,
Kontaktformular-Zustellung) versenden wir über <strong>Brevo (Sendinblue SAS),
Paris, Frankreich</strong> — einen EU-Anbieter, mit dem ein
Auftragsverarbeitungsvertrag besteht. Verarbeitet werden dabei
Empfänger-Adresse, Betreff und Inhalt der jeweiligen E-Mail (Art. 6 Abs. 1
lit. b DSGVO).</p>

<h2>10. Kontaktformular und Kontakt per E-Mail</h2>
<p>Nutzt du das <a href="/kontakt.html">Kontaktformular</a>, verarbeiten wir
deine Angaben (E-Mail-Adresse, Nachricht, optional Name und Betreff), um die
Anfrage zu beantworten (Art. 6 Abs. 1 lit. b bzw. f DSGVO). Die Nachricht wird
uns per E-Mail über Brevo zugestellt und im Postfach des Betreibers gespeichert,
solange es für die Bearbeitung erforderlich ist. Dasselbe gilt für direkte
E-Mails an die oben genannte Adresse.</p>

<h2>11. Feedback in der App</h2>
<p>Über den Feedback-Knopf in der App kannst du uns eine Nachricht senden.
Gespeichert werden die Nachricht, der App-Bereich, aus dem sie gesendet wurde,
die Sprache und die interne Kennung deines Kontos (Mandanten-Kennung) — dein
Name und deine E-Mail-Adresse werden nur angehängt, wenn du das beim Absenden
ausdrücklich auswählst, damit wir dir antworten können. Rechtsgrundlage ist
unser berechtigtes Interesse, den Dienst zu verbessern (Art. 6 Abs. 1 lit. f
DSGVO). Feedback wird gelöscht, sobald es nicht mehr benötigt wird.</p>

<h2>12. Moderation und Missbrauchsbekämpfung</h2>
<p>Zur Bearbeitung von Meldungen (Notice-and-Action), zur Durchsetzung
rechtlicher Pflichten und zur Missbrauchsbekämpfung kann der Betreiber
gemeldete Inhalte einsehen, entfernen, Konten sperren oder auf Verlangen
löschen. Diese Maßnahmen werden in einem <strong>Aktionsprotokoll</strong>
festgehalten (Zeitpunkt, Maßnahme, betroffenes Konto, bei Text-Entfernungen der
entfernte Text als Nachweis). Rechtsgrundlagen sind rechtliche Verpflichtungen
(Art. 6 Abs. 1 lit. c DSGVO) und unser berechtigtes Interesse an einem
missbrauchsfreien Dienst (lit. f). Der Nachweis einer Kontolöschung wird ohne
E-Mail-Adresse geführt und bleibt zur Dokumentation der Löschpflicht bestehen
(Art. 17 Abs. 3 lit. b und e DSGVO).</p>

<h2>13. Cookies und lokale Speicherung (§ 25 TDDDG)</h2>
<p>Der Dienst verwendet nur unbedingt erforderliche Speicherung auf deinem
Gerät (§ 25 Abs. 2 Nr. 2 TDDDG), daher ist keine Einwilligung (Cookie-Banner)
erforderlich. Im Einzelnen:</p>
<ul>
  <li><strong>Anmelde-Cookies</strong>: bei geöffneter Registrierung ein
  Cookie („sa“, httpOnly, 15 Minuten), damit hochgeladene Cover-Bilder nur für
  angemeldete Nutzer abrufbar sind; Instanzen mit Gruppen-Passwort — auch diese
  Instanz, solange die Registrierung noch nicht geöffnet ist — verwenden
  stattdessen ein Sitzungs-Cookie („sid“, 30 Tage).</li>
  <li><strong>localStorage</strong>: deine Spracheinstellung, deine
  Anmelde-Token (damit du angemeldet bleibst) sowie ein lokaler
  Zwischenspeicher deiner Rundendaten für schnellere Anzeigen — er wird beim
  Ab- und Anmelden geleert.</li>
  <li><strong>Offline-Cache</strong>: die App ist als PWA installierbar; der
  Browser legt dafür die App-Dateien (Code, Schriften, Icons — nie deine Runden-
  oder Bilddaten) im Cache ab.</li>
</ul>
<p>Analyse-, Tracking- oder Werbe-Speicherung findet nicht statt.</p>

<h2>14. Weitergabe von Daten</h2>
<p>Eine Weitergabe personenbezogener Daten erfolgt nur an die in dieser
Erklärung genannten Empfänger (Railway, Cloudflare, Brevo, Wikimedia — jeweils
in dem beschriebenen Umfang) und im Fall der Anbieter-Cover direkt durch deinen
Browser (Abschnitt 7). Ein Verkauf oder eine werbliche Nutzung der Daten findet
nicht statt.</p>

<h2>15. Deine Rechte</h2>
<p>Du hast nach der DSGVO das Recht auf <strong>Auskunft</strong> (Art. 15),
<strong>Berichtigung</strong> (Art. 16), <strong>Löschung</strong> (Art. 17),
<strong>Einschränkung der Verarbeitung</strong> (Art. 18) und
<strong>Datenübertragbarkeit</strong> (Art. 20). Wende dich dazu formlos an die
oben genannte E-Mail-Adresse oder das <a href="/kontakt.html">Kontaktformular</a>.</p>
<p class="highlight"><strong>Widerspruchsrecht (Art. 21 DSGVO):</strong> Du
hast das Recht, aus Gründen, die sich aus deiner besonderen Situation ergeben,
jederzeit gegen Verarbeitungen zu widersprechen, die auf Art. 6 Abs. 1 lit. f
DSGVO (berechtigtes Interesse) beruhen.</p>
<p>Außerdem kannst du dich bei einer <strong>Datenschutz-Aufsichtsbehörde
beschweren</strong> (Art. 77 DSGVO), etwa bei der Behörde deines Wohnorts
(eine Übersicht führt der Bundesbeauftragte für den Datenschutz und die
Informationsfreiheit). Die Bereitstellung deiner Daten ist weder gesetzlich
noch vertraglich vorgeschrieben; ohne E-Mail-Adresse kann allerdings kein Konto
angelegt werden. Eine <strong>automatisierte Entscheidungsfindung
einschließlich Profiling</strong> (Art. 22 DSGVO) findet nicht statt.</p>

<h2>16. Änderungen</h2>
<p>Wir passen diese Erklärung an, wenn sich der Dienst oder die Rechtslage
ändert; es gilt die jeweils hier veröffentlichte Fassung.</p>`;

  const en = `
<h1>Privacy policy</h1>
<p class="lang-note">Courtesy translation — the German version above is
authoritative.</p>

<h2>1. Controller</h2>
<p>${esc(OPERATOR_NAME)}<br>${addr}<br>
E-mail: <a href="mailto:${mail}">${mail}</a></p>
<p>Mail sent to this address is received by a receiving-service provider and
forwarded to the controller. No data protection officer is designated (not
legally required).</p>

<h2>2. The short version</h2>
<ul>
  <li>Spielwirbel uses <strong>no tracking, no analytics and no ads</strong>.</li>
  <li>Only strictly necessary cookies and local storage are used (login,
  language, a local data cache) — hence no cookie banner (§ 25(2) TDDDG).</li>
  <li>Fonts and scripts are <strong>self-hosted</strong>; a normal visit loads
  nothing from third parties. The one exception are game covers you link from
  external providers (section 7).</li>
  <li>All traffic is encrypted (TLS/HTTPS); the application and database run in
  an <strong>EU data centre</strong>, uploaded images are stored with
  Cloudflare (section 6).</li>
</ul>

<h2>3. Hosting, server logs and database</h2>
<p>The application runs at <strong>Railway Corp.</strong> (USA) in an EU data
region, which also hosts the PostgreSQL database and the application logs. A
data-processing agreement (Art. 28 GDPR) including EU standard contractual
clauses (Art. 46(2)(c) GDPR) is in place.</p>
<p>Each request is technically logged with <strong>IP address, HTTP method,
path, status code and duration</strong> — request contents (form data, search
terms, cookies) are deliberately <strong>not</strong> logged. In addition we
log <strong>pseudonymous usage events</strong> — the kind of action (e.g.
"round created") together with the account/tenant identifier, never content —
to understand how the service is used in broad strokes. On severe errors a
notification (time, path, error message — no content, no IP address) may, if
configured, be sent to a messaging service used by the operator. Purpose:
secure, stable operation (debugging, abuse and attack detection, rate
limiting); legal basis: legitimate interest (Art. 6(1)(f) GDPR). Logs are
subject to the hosting platform's automatic retention limit and are not
combined with other data.</p>

<h2>4. Account and registration</h2>
<p>When you create an account we process your <strong>e-mail address</strong>
and a <strong>password</strong>, stored exclusively as a modern hash (Argon2id)
— never in plain text. Short-lived tokens for e-mail verification and password
reset are stored hashed and sent to you by e-mail. Legal basis: performance of
the user relationship (Art. 6(1)(b) GDPR). Account data is kept until the
account is deleted; you can request deletion informally via the contact
channels above. Deletion removes all of the account's data including all rounds
and uploaded images — only a minimal record of the deletion itself, without
your e-mail address, is retained (section 12).</p>

<h2>5. Round and game data</h2>
<p>The service exists to manage game rounds, so we store what is entered:
<strong>round names, game titles, member names, ratings/votes, tags, an
activity feed and uploaded cover images</strong>. Member names are free-form —
if you enter real names of other people, make sure they are fine with it.
Legal basis: providing the service (Art. 6(1)(b) GDPR). This data is visible
only within your own account (tenant) and is kept until you delete it or the
account.</p>

<h2>6. Uploaded images</h2>
<p>Cover images you upload are stored in S3-compatible object storage at
<strong>Cloudflare, Inc.</strong> (USA) and served exclusively through our
server (no public bucket access). Legal basis: providing the service
(Art. 6(1)(b) GDPR). A data-processing agreement is in place; Cloudflare is
certified under the <strong>EU-US Data Privacy Framework</strong> (Art. 45
GDPR), with standard contractual clauses as a fallback.</p>

<h2>7. Game covers from external providers (hotlinking)</h2>
<p>When adding a game you can link an official provider cover. Such covers are
<strong>not copied by us</strong> — your browser loads them directly from the
provider, which therefore receives your <strong>IP address</strong> and the
usual browser headers, as if you had visited their site. Possible providers
(depending on which covers your round links):</p>
<ul>
  <li>Sony Interactive Entertainment — <code>image.api.playstation.com</code> / <code>playstation.net</code></li>
  <li>Valve Corporation (Steam) — <code>steamstatic.com</code></li>
  <li>Nintendo — <code>nintendo.com</code></li>
  <li>Microsoft (Xbox) — <code>s-microsoft.com</code></li>
  <li>BoardGameGeek — <code>geekdo-images.com</code></li>
</ul>
<p>Some of these providers are located in third countries (notably the USA and
Japan); we have no influence on their processing. Legal basis: our legitimate
interest in displaying linked covers without reproducing copyrighted images
ourselves (Art. 6(1)(f) GDPR). If you prefer not to, add games without a
provider cover or upload your own image.</p>

<h2>8. Title search against game providers</h2>
<p>The title search when adding a game queries the catalogues of the providers
above; for board games it additionally queries the open knowledge service
<strong>Wikidata</strong> (Wikimedia Foundation, Inc., USA). All of these
requests are made by <strong>our server</strong> — only the typed search term
is transmitted, never your IP address or any data about you.</p>

<h2>9. E-mail delivery (Brevo)</h2>
<p>System e-mails (address verification, password reset, contact-form
delivery) are sent via <strong>Brevo (Sendinblue SAS), Paris, France</strong> —
an EU provider under a data-processing agreement. Recipient address, subject
and message content are processed for delivery (Art. 6(1)(b) GDPR).</p>

<h2>10. Contact form and e-mail contact</h2>
<p>If you use the <a href="/kontakt.html">contact form</a> we process what you
submit (e-mail address, message, optionally name and subject) to answer your
request (Art. 6(1)(b)/(f) GDPR). The message is delivered to us by e-mail via
Brevo and kept in the operator's mailbox as long as handling requires. The same
applies to direct e-mails.</p>

<h2>11. In-app feedback</h2>
<p>The feedback button lets you send us a message. We store the message, the
app area you sent it from, your language and your account's internal (tenant)
identifier — your name and e-mail address are attached only if you explicitly
choose that when sending, so we can reply. Legal basis: legitimate interest in
improving the service (Art. 6(1)(f) GDPR). Feedback is deleted once it is no
longer needed.</p>

<h2>12. Moderation and abuse prevention</h2>
<p>To handle reports (notice and action), meet legal obligations and prevent
abuse, the operator can review reported content, remove it, suspend accounts or
delete them on request. These actions are recorded in an <strong>action
log</strong> (time, action, affected account, and for text removals the removed
text as evidence). Legal bases: legal obligations (Art. 6(1)(c) GDPR) and our
legitimate interest in an abuse-free service ((f)). The record of an account
deletion is kept without the e-mail address and is retained as evidence of the
erasure obligation (Art. 17(3)(b) and (e) GDPR).</p>

<h2>13. Cookies and local storage (§ 25 TDDDG)</h2>
<p>Only strictly necessary storage on your device is used (§ 25(2) no. 2
TDDDG), so no consent banner is required. In detail:</p>
<ul>
  <li><strong>Login cookies</strong>: with registration open, a cookie ("sa",
  httpOnly, 15 minutes) so uploaded cover images are only served to logged-in
  users; instances using a shared group password — including this instance
  while registration is not yet open — use a session cookie ("sid", 30 days)
  instead.</li>
  <li><strong>localStorage</strong>: your language preference, your login
  tokens (so you stay signed in) and a local cache of your round data for
  faster rendering — cleared on login and logout.</li>
  <li><strong>Offline cache</strong>: the app is installable as a PWA; the
  browser caches the app files for that (code, fonts, icons — never your round
  data or images).</li>
</ul>
<p>No analytics, tracking or advertising storage takes place.</p>

<h2>14. Data sharing</h2>
<p>Personal data is shared only with the recipients named in this policy
(Railway, Cloudflare, Brevo, Wikimedia — each to the extent described) and, for
provider covers, directly by your browser (section 7). Data is never sold or
used for advertising.</p>

<h2>15. Your rights</h2>
<p>Under the GDPR you have the right of <strong>access</strong> (Art. 15),
<strong>rectification</strong> (Art. 16), <strong>erasure</strong> (Art. 17),
<strong>restriction</strong> (Art. 18) and <strong>data portability</strong>
(Art. 20). Just write to the e-mail address above or use the
<a href="/kontakt.html">contact form</a>.</p>
<p class="highlight"><strong>Right to object (Art. 21 GDPR):</strong> you have
the right to object at any time, on grounds relating to your particular
situation, to processing based on Art. 6(1)(f) GDPR (legitimate interest).</p>
<p>You also have the right to <strong>lodge a complaint with a data-protection
supervisory authority</strong> (Art. 77 GDPR), for instance the authority of
your place of residence (the German Federal Commissioner for Data Protection,
BfDI, maintains an overview). Providing your data is neither legally nor
contractually required; without an e-mail address, however, no account can be
created. <strong>No automated decision-making including profiling</strong>
(Art. 22 GDPR) takes place.</p>

<h2>16. Changes</h2>
<p>We update this policy when the service or the legal situation changes; the
version published here applies.</p>`;

  return layout('Datenschutz', de, en);
}

module.exports = {
  renderImpressum, renderDatenschutz, legalConfigured, renderAddress,
  OPERATOR_NAME, REVISION,
};
