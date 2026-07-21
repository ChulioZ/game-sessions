# Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

Internal record (German — it addresses a German supervisory authority). Every
item is implemented in this repository or the hosting setup; keep it truthful —
list nothing that is not actually in place.

**Stand:** 2026-07-21

## Verschlüsselung & Transport

- TLS für alle Verbindungen; Terminierung an der Railway-Edge (#156). HSTS
  gesetzt (`helmet`, `lib/app.js`); die kanonische Domain `.app` ist
  HSTS-preloaded.
- Datenbank- und Objektspeicher-Zugriff über die verschlüsselten Kanäle der
  Anbieter (Railway-internes Netz, R2 über HTTPS).

## Zugangskontrolle & Authentifizierung

- Passwörter nur als **Argon2id-Hash**; Verifikations-, Reset- und
  Refresh-Token nur als SHA-256-Hash (`lib/accounts.js`).
- Access-Token: kurzlebige (15 min) signierte JWTs; Refresh-Token rotieren.
- Anti-Enumeration: Registrierung/Passwort-vergessen antworten für bekannte und
  unbekannte Adressen identisch; Login verbrennt konstante Argon2-Arbeit.
- Betreiber-Panel hinter eigenem `ADMIN_PASSWORD` (nie gleich dem App-Passwort,
  domain-separierte Token — `lib/admin.js`); Statuskarte prüft die Trennung.
- Uploads sind zugriffsgeschützt (Cookie/Bearer-Gate auf `/uploads`); kein
  öffentlicher Bucket-Zugriff (Read-through-Proxy, #128).

## Mandantentrennung

- Jede Zeile trägt `tenant_id`; jede Abfrage filtert darauf; zusätzlich
  **Row-Level Security (FORCE)** in PostgreSQL als Backstop (#136,
  `.claude/rules/tenancy-rls.md`).
- Betreiber-Lesezugriff für Moderation ist eine separate, **nur-lesende**
  RLS-Policy; Schreibzugriffe bleiben mandantengebunden (#268/#275).

## Härtung & Missbrauchsabwehr

- Security-Header + strikte CSP (`helmet`); Skripte nur self-hosted.
- Ratenbegrenzung global + strengere Limits für Login/Kontakt/Feedback.
- Eingabevalidierung (zod) auf Mutationsrouten; Honeypot im Kontaktformular.
- Per-Tenant-Quoten (Runden/Spiele/Tags, #139) begrenzen Missbrauch.
- Abhängigkeits-Updates via Dependabot; CI (Tests, Lint, CodeQL, gitleaks).

## Datenminimierung & Protokollierung

- Request-Logs enthalten nur Methode/Pfad/Status/Dauer/IP — nie Bodies, Query-
  Strings, Header oder Cookies (`lib/observability.js`).
- Produkt-Ereignisse: nur Ereignisname + Tenant-Id (Allowlist, #261).
- Mail-Log: nur Empfänger/Betreff, nie Inhalte (`lib/mail.js`).

## Verfügbarkeit & Wiederherstellung

- Managed PostgreSQL (Railway) mit Plattform-Backups; Deployment reproduzierbar
  aus dem Repo (Dockerfile); Objektspeicher repliziert bei Cloudflare.
- Health-Check (`/healthz`) + Deploy-Status je Commit.

## Löschkonzept

- Löschungen wirken durchgängig: Spiel-/Runden-/Konto-Löschung entfernt
  abhängige Daten und Cover-Objekte (`.claude/rules/deletion-paths-must-free-cover-objects.md`).
- Betreiber-Werkzeuge für Art.-17-Fälle: Takedown, Kontolöschung mit Export,
  Text-Redaktion mit Nachweis-Log (#268/#273/#275).

## Organisatorisch

- Einzelbetreiber; Zugriff auf Produktionssysteme nur der Verantwortliche.
- Secrets nur in der Hosting-Umgebung, nie im Repo (`.claude/rules/no-reading-env-files.md`,
  gitleaks-CI).
- Agenten-Arbeitsregeln verbieten das Lesen von Produktionsdaten
  (`.claude/rules/no-reading-production-data.md`).
