# Notice-and-Action-Verfahren (Art. 16/17 DSA)

Internal record (German). Dokumentierter Ablauf für Meldungen rechtswidriger
Inhalte nach der Verordnung (EU) 2022/2065 („DSA") — Spielwirbel ist ein
**Hosting-Dienst** (Art. 3 lit. g iii), kein Online-Plattform-Dienst: die
Inhalte eines Mandanten werden nicht öffentlich verbreitet, sondern nur
innerhalb des Kontos angezeigt. Es gelten daher die Basispflichten der
Art. 11–18 DSA, **nicht** die Plattform-Pflichten aus Kapitel III Abschnitt 3
(Art. 19 ff.; von diesen wären Kleinstunternehmen ohnehin ausgenommen).
Insbesondere besteht **keine Pflicht zu einem internen
Beschwerdemanagement-System nach Art. 20** (nur Plattformen) — der formlose
Widerspruch über die Kontaktwege genügt.

Die veröffentlichte Gegenstück-Seite ist `/nutzungsbedingungen`
(`lib/legal.js`): Abschnitt 5 (Verbotsliste), Abschnitt 6 (Meldeweg),
Abschnitt 7 (Maßnahmen + Begründung), Abschnitt 10 (Kontaktstellen
Art. 11/12). **Jede Entfernung stützt sich auf eine dort benannte Regel** —
die Begründung (unten) zeigt auf die konkrete Ziffer.

**Stand:** 2026-07-21

## Kanäle (Art. 16 Abs. 1)

- Kontaktformular `/kontakt.html` → `CONTACT_TO`-Postfach (Heinlein/mailbox.org).
- E-Mail an `IMPRESSUM_EMAIL` (Alias `abuse@` läuft auf dasselbe Postfach, #307).
- Beides ist ohne Login erreichbar; die Nutzungsbedingungen §6 nennen die
  Bestandteile einer guten Meldung (Art. 16 Abs. 2: Begründung, exakte URL —
  oder, da Mandanten-Inhalte keine öffentliche URL haben, eine andere
  eindeutige Bezeichnung wie Konto/Runde/Spieltitel (Art. 16 Abs. 2 lit. b:
  „an die Art des Hosting-Dienstes angepasst") —, Name + E-Mail außer bei
  CSAM-Bezug, Richtigkeitserklärung).
- Die strukturierte Intake-Erfassung (**#272, umgesetzt**): das Formular
  erhebt Kategorie, gemeldete URL und die Richtigkeitserklärung
  (Art. 16 Abs. 2); **jede Formular-Einsendung wird zusätzlich in der
  Datenbank gespeichert** (`contact_notices`) und erscheint als Karte
  „Meldungen" im Betreiber-Panel (`/admin.html`). Das Postfach bleibt der
  Nachweis für Meldungen, die per E-Mail eingehen (Ordner `Meldungen`,
  Aufbewahrung s. `retention.md`); bei CSAM-Bezug ist die Meldung im Formular
  ohne E-Mail-Adresse möglich (Art. 16 Abs. 3).

## Ablauf

1. **Eingang bestätigen** (Art. 16 Abs. 4) — unverzüglich, formlos. Für
   Formular-Meldungen **automatisch** (#272: Bestätigungs-Mail beim Absenden);
   für Meldungen per E-Mail weiterhin manuell (Vorlage unten). Gilt nur,
   soweit die Meldung Kontaktdaten enthält (eine anonyme Meldung — bei
   CSAM-Bezug zulässig — wird ohne Bestätigung geprüft).
2. **Prüfen** — zeitnah, sorgfältig, objektiv, frei von Willkür (Art. 16
   Abs. 6); keine automatisierten Entscheidungsverfahren (das steht so in den
   Nutzungsbedingungen — bei Einführung dort UND hier ändern). Grundlage:
   die gemeldete URL im Betreiber-Panel (`/admin.html`, #268) zuordnen
   (`Bild zuordnen` für `/uploads/…`-Pfade, sonst Konto-/Runden-Lookup #275).
   Nennt die Meldung einen **Nutzernamen** (#320), führt `Konto suchen` auf
   der Meldungs-Karte direkt zum Lookup — für eine meldende Person von außen
   ist das oft der einzige Bezeichner, den sie kennen kann.
   **Art. 18 DSA — Sonderweg bei Gefahr für Leben oder Sicherheit:** ergibt
   die Prüfung den Verdacht einer Straftat, die eine Gefahr für das Leben
   oder die Sicherheit einer Person bedeutet (begangen, im Gange oder
   bevorstehend), sind **unverzüglich** die Strafverfolgungs- oder
   Justizbehörden des betroffenen Mitgliedstaats zu informieren (Deutschland:
   Onlinewache der Landespolizei / BKA; bei Unklarheit Europol oder die
   deutschen Behörden). Alle vorliegenden Informationen übermitteln, den
   Vorgang dokumentieren. Diese Pflicht gilt ohne
   Kleinstunternehmen-Ausnahme.
3. **Entscheiden & handeln** — Entfernen/Redigieren/Sperren über das Panel
   (`takedownImage`, `redactText`, Konto-Sperre; ist der **Nutzername selbst**
   der Verstoß, `Name neutralisieren` — ersetzt ihn durch eine aus der Konto-Id
   abgeleitete neutrale Bezeichnung und hält den vorherigen Namen als Nachweis
   auf dem Log-Eintrag fest, #320); jede Maßnahme schreibt einen
   Moderations-Log-Eintrag (`logModeration`) mit Zeitpunkt, Maßnahme, Grund.
   Im Grund-Feld die verletzte Ziffer der Nutzungsbedingungen (z. B. „NB §5:
   fremdes Cover ohne Rechte") und ggf. das Meldungs-Datum referenzieren.
4. **Betroffene Person begründen** (Art. 17) — nach einem Takedown erzeugt
   das Panel den Begründungstext aus dem Log-Eintrag (#272: kopierbar oder
   direkt per E-Mail; der Versand wird auf dem Eintrag vermerkt,
   `statementSentAt`). Für andere Maßnahmen Vorlage unten, per E-Mail an die
   Konto-Adresse, sobald eine Maßnahme Inhalte oder das Konto betrifft.
   Nicht nötig bei irreführenden kommerziellen Massen-Inhalten (Art. 17
   Abs. 2) — hier praktisch nie einschlägig.
5. **Meldende Person bescheiden** (Art. 16 Abs. 5) — für gespeicherte
   Formular-Meldungen über die Panel-Karte „Meldungen" (#272: Status
   erledigt/abgelehnt + optionale Begründung, Versand an die angegebene
   Adresse); für E-Mail-Meldungen manuell (Vorlage unten).
6. **Dokumentieren** — der Moderations-Log-Eintrag ist der Nachweis;
   Schriftwechsel bleibt im Postfach (Aufbewahrung: `retention.md`).

## Vorlage: Eingangsbestätigung (Art. 16 Abs. 4)

> Betreff: Eingangsbestätigung Ihrer Meldung — Spielwirbel
>
> Ihre Meldung vom [DATUM] zu [URL/KURZBESCHREIBUNG] ist bei uns eingegangen.
> Wir prüfen sie zeitnah und teilen Ihnen unsere Entscheidung mit.
> [BETREIBER-NAME], Spielwirbel — Kontakt: [IMPRESSUM_EMAIL]

## Vorlage: Begründung gegenüber der betroffenen Person (Art. 17 DSA)

Pflichtinhalte nach Art. 17 Abs. 3 lit. a–f; seit #272 generiert das Panel
diesen Text aus dem Moderations-Log-Eintrag (`GET /api/admin/statement`) —
die Vorlage hier bleibt die Referenz für manuell verfasste Begründungen.
Struktur:

> Betreff: Entscheidung zu Inhalten in deinem Spielwirbel-Konto
>
> **Maßnahme** (lit. a): Am [DATUM] haben wir [ENTFERNT: das Cover-Bild des
> Spiels „[TITEL]" / den Text „[FELD]" redigiert / dein Konto vorübergehend
> gesperrt bis [DATUM] / dein Konto geschlossen]. Die Maßnahme gilt für den
> gesamten Dienst [Dauer: dauerhaft / bis TT.MM.JJJJ].
>
> **Sachverhalt** (lit. b): [Tatsachen: was wurde wo eingestellt; Anlass:
> eigene Feststellung ODER Meldung nach Art. 16 DSA vom [DATUM] — die
> Identität meldender Personen geben wir nicht weiter].
>
> **Automatisierung** (lit. c): Diese Entscheidung wurde ohne automatisierte
> Verfahren von einem Menschen getroffen und geprüft.
>
> **Grund** (lit. d und/oder e — je nach Grundlage; beide zusammen sind
> möglich, z. B. § 86a StGB **und** NB §5):
> [Bei Rechtswidrigkeit: Der Inhalt verstößt gegen (RECHTSGRUNDLAGE, z. B.
> § 86a StGB / § 22 KunstUrhG / §§ 15 ff. UrhG), weil (ERLÄUTERUNG).]
> [Bei Verstoß gegen die Nutzungsbedingungen: Der Inhalt verstößt gegen
> Abschnitt [5, Spiegelstrich N] unserer Nutzungsbedingungen
> (spielwirbel.app/nutzungsbedingungen), weil (ERLÄUTERUNG).]
>
> **Rechtsbehelfe** (lit. f): Du kannst dieser Entscheidung formlos
> widersprechen — per Antwort auf diese E-Mail oder über das Kontaktformular.
> Wir prüfen den Widerspruch durch einen Menschen. Unabhängig davon steht dir
> der ordentliche Rechtsweg offen.

## Vorlage: Bescheid an die meldende Person (Art. 16 Abs. 5)

> Betreff: Entscheidung zu Ihrer Meldung — Spielwirbel
>
> zu Ihrer Meldung vom [DATUM] ([URL]): Wir haben [den gemeldeten Inhalt am
> [DATUM] entfernt / den Inhalt geprüft und nicht entfernt, weil (KURZE
> BEGRÜNDUNG)]. Wenn Sie mit dieser Entscheidung nicht einverstanden sind,
> können Sie uns formlos antworten (erneute menschliche Prüfung); unabhängig
> davon steht Ihnen der Rechtsweg offen.

## Behördliche Anordnungen (Art. 9/10 DSA)

Selten, aber dieser Ablauf ist das Dokument, in dem danach gesucht würde:
eine behördliche **Anordnung zum Vorgehen gegen rechtswidrige Inhalte**
(Art. 9) oder zur **Auskunft über einen Nutzer** (Art. 10) wird unverzüglich
umgesetzt bzw. beantwortet; der anordnenden Behörde wird die Umsetzung
bestätigt (Art. 9 Abs. 1 / 10 Abs. 1). Die betroffene Person wird über die
Anordnung und ihre Umsetzung informiert (Art. 9 Abs. 5 / 10 Abs. 5), sofern
die Anordnung oder das anwendbare Recht das nicht aufschiebt oder untersagt.
Vorgang im Postfach-Ordner `Meldungen` dokumentieren; Aufbewahrung wie
DSA-Meldungen (`retention.md`).

## Kontaktstellen (Art. 11/12 DSA)

Einheitliche elektronische Kontaktstelle für Behörden, Kommission und Gremium
**und** für Nutzer: `IMPRESSUM_EMAIL` (+ Kontaktformular). Sprachen: Deutsch,
Englisch. Veröffentlicht in Nutzungsbedingungen §10 und im Impressum. Ein
gesetzlicher Vertreter (Art. 13) ist nicht erforderlich — der Betreiber ist in
der EU niedergelassen. Transparenzbericht (Art. 15): als Kleinstunternehmen
ausgenommen (Art. 15 Abs. 2).
