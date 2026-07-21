# Aufbewahrungs- und Löschkonzept (Art. 5 Abs. 1 lit. e DSGVO)

Internal record (German). Konsolidiert die Löschfristen aus `vvt.md` und legt
den Prüf-Rhythmus fest; die veröffentlichte Datenschutzerklärung
(`lib/legal.js`) nennt dieselben Fristen. **Beide zusammen ändern** — eine
Frist, die hier steht, aber nicht gelebt oder nicht veröffentlicht wird, ist
schlimmer als keine.

**Stand:** 2026-07-21

## Grundsatz

Gespeichert wird nur, was eine aktive Funktion des Dienstes trägt oder einem
Nachweis dient; die Löschung ist der Normalfall (Konto-/Runden-Löschung wirkt
sofort und vollständig, `eraseAccount`/`deleteRound` räumen auch die
Bild-Objekte ab — `.claude/rules/deletion-paths-must-free-cover-objects.md`).

## Fristen

| Datenbestand | Frist | Mechanismus |
|---|---|---|
| Runden-/Spiel-/Mitgliedsdaten, Cover | bis Löschung durch Nutzer bzw. Kontolöschung | Nutzeraktion / `eraseAccount` (#273) |
| Konten | bis Kontolöschung (formlose Anfrage) | `eraseAccount` (#273) |
| Server-Request-Logs, Produkt-Ereignisse | Logrotation der Plattform (Railway) | automatisch |
| In-App-Feedback | nach Bearbeitung löschen | manuell im Panel (#260) |
| Kontakt-/Support-Korrespondenz (Postfach) | bis Abschluss der Bearbeitung, danach löschen — spätestens bei der Jahresprüfung | manuell (Postfach) |
| Transaktions-E-Mails (Versandprotokolle bei Brevo) | Aufbewahrungsfenster des Anbieters; keine eigene Speicherung | automatisch (Brevo) |
| Briefpost an die Empfangsanschrift (weitergeleitet) | nach Bearbeitung vernichten — spätestens bei der Jahresprüfung | manuell |
| DSA-Meldungen + Bescheide (Postfach-Ordner `Meldungen`) | **3 Jahre** ab Jahresende der Entscheidung (wie Moderations-Log) | manuell, Jahresprüfung |
| **Moderations-Log-Einträge mit personenbezogenen Daten** (E-Mail-Adressen, redigierte Texte als `previous`-Nachweis) | **3 Jahre ab Ende des Jahres der Maßnahme** | Jahresprüfung (unten) |
| Löschnachweise (`eraseAccount`-Einträge — ohne E-Mail-Adresse by design) | dauerhaft (Art. 17 Abs. 3 lit. b/e DSGVO) | — |
| Backups | Backup-Zyklus der Plattform (Railway Managed Postgres) | automatisch |

**Warum 3 Jahre:** die regelmäßige Verjährungsfrist (§ 195 BGB) beginnt mit
dem Schluss des Jahres, in dem der Anspruch entstand (§ 199 Abs. 1 BGB) —
solange kann der Betreiber eine Maßnahme belegen müssen (Entscheidung #140,
Betreiber-Interview 2026-07-21; die Entscheidung, auf die #275 §6 verwiesen
hat).

**Bewusst akzeptiertes Restrisiko:** § 199 Abs. 1 BGB knüpft den Fristbeginn
zusätzlich an die Kenntnis des Gläubigers; ohne Kenntnis gelten die längeren
Grenzen des § 199 Abs. 3 BGB (bis 10 Jahre). Die 3-Jahres-Löschung kann also
Nachweise vernichten, die für spät bekannt gewordene Ansprüche noch nützlich
wären. Das ist als datenschutzfreundlicher Kompromiss entschieden
(Speicherbegrenzung, Art. 5 Abs. 1 lit. e DSGVO) — bei der Jahresprüfung
nicht stillschweigend auf 10 Jahre „korrigieren".

## Jahresprüfung (jeweils Januar)

1. Moderations-Log im Panel nach Datum filtern (`/admin.html`, #275): Einträge
   mit Maßnahme-Datum vor dem 1. Januar vor drei Jahren (Beispiel: Prüfung
   Januar 2030 → Einträge bis 31.12.2026) exportieren (CSV, falls ein
   Aufbewahrungsgrund im Einzelfall fortbesteht — z. B. laufender Streit —
   sonst nicht) und anschließend löschen bzw. die personenbezogenen Felder
   anonymisieren. Löschnachweise (`erase`-Einträge) bleiben.
   *Tooling-Hinweis:* ein Lösch-/Anonymisier-Endpunkt für alte Log-Einträge
   existiert noch nicht (#275 §6 lieferte Filter/Export); bis dahin per
   direktem DB-Zugriff löschen und den Vorgang im Log der Prüfung vermerken.
2. Postfach: Ordner `Meldungen` nach demselben Stichtag aufräumen; erledigte
   Support-Korrespondenz löschen.
3. Feedback-Karte im Panel leeren (bearbeitete Einträge löschen).
4. Prüfung mit Datum in diesem Dokument unter „Durchgeführte Prüfungen"
   vermerken.

## Durchgeführte Prüfungen

- *(noch keine — erste Prüfung: Januar 2027)*
