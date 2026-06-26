# Discord Bot

Der Bot automatisiert den Jellyfin-Discord mit Slash-Commands, FAQ-Antworten,
Jellyfin/API-Status, User-Checks, einfachen Moderationsbefehlen und
serverinternem Activity-Logging.

Er ueberwacht nur Ereignisse im eigenen Discord-Server und speichert standardmaessig
nur Zaehler wie Nachrichtenanzahl, Join/Leave und Verwarnungen. Inhalte werden
nicht dauerhaft gespeichert.

## Setup

1. Im Discord Developer Portal eine Application mit Bot erstellen.
2. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN` eintragen.
3. Bot mit diesen Rechten einladen:
   - Manage Roles
   - Moderate Members
   - Manage Channels
   - Manage Messages
   - Send Messages
   - Use Slash Commands
   - Read Message History
4. Fuer Join/Leave, Auto-Rollen, User-Monitoring und Account-Alter-Pruefungen
   im Developer Portal `Server Members Intent` aktivieren.
   `ENABLE_MEMBER_MONITORING=true` ist nur fuer klassische Join/Leave-Stats noetig;
   `ENABLE_NEW_ACCOUNT_PROTECTION=true` nutzt den Intent fuer Sicherheitschecks.
5. Optional `Message Content Intent` aktivieren und `ENABLE_MESSAGE_QA=true` setzen,
   wenn der Bot auch auf Erwaehnungen oder `jellybot ...` im normalen Chat antworten soll.
   Fuer den OpenAI-Assistenten per Erwaehnung gilt das ebenfalls.
6. Optional `Message Content Intent` aktivieren und
   `ENABLE_SUPPORT_MESSAGE_CONTENT=true` setzen, wenn normale Nachrichten im
   Support-Eingang als Ticket-Beschreibung uebernommen werden sollen.
7. Optional `Message Content Intent` aktivieren und
   `ENABLE_MODERATION_CONTENT=true` setzen, wenn Anti-Spam Inhalte wie Links,
   Caps und wiederholte Nachrichten erkennen soll.

## Commands

- `/setup` erstellt Standard-Rollen und Kanaele.
- `/status` prueft Portal API, Jellyfin und aktive Sessions.
- `/usercheck username:<name>` prueft Jellyfin-Benutzer ueber die bestehende API.
- `/faq frage:<text>` beantwortet typische Supportfragen.
- `/ask frage:<text>` fragt den OpenAI-gestuetzten Jellyfin-Assistenten.
- `/payment-link` sendet den Link zur Zahlungsseite.
- Ticket-Button im Support-Panel oder `/ticket create` erstellt ein privates Support-Ticket.
- `/ticket close`, `/ticket add`, `/ticket remove`, `/ticket list`, `/ticket summary`
  und `/ticket suggest` verwalten Tickets.
- `/support-status view` zeigt die aktuelle Support-Verfuegbarkeit.
- `/support-status set` setzt die Support-Verfuegbarkeit fuer das Team.
- `/stats` zeigt einfache Aktivitaetsdaten.
- `/warn`, `/warnings`, `/unwarn`, `/timeout`, `/announce` helfen bei Moderation.

## Tickets

Das Ticket-System zeigt im Support-Eingang ein Panel mit dem Button
`Ticket oeffnen`. Der Button oeffnet ein kurzes Formular und erstellt danach
automatisch einen privaten Kanal unter der Kategorie `TICKETS`. Sichtbar sind
der Ticket-Ersteller, der Bot und die Rollen `Support`, `Moderator` und `Admin`,
sofern diese Rollen existieren.

`/ticket create` bleibt als Backup bewusst nur im Support-Eingang `#support`
erlaubt. Wenn User dort stattdessen normalen Text schreiben, erstellt der Bot
daraus automatisch ein Ticket und loescht die urspruengliche Nachricht aus dem
Support-Eingang.

Ohne `ENABLE_SUPPORT_MESSAGE_CONTENT=true` kann Discord den Nachrichtentext
verbergen; der Bot erstellt dann trotzdem ein Ticket, aber mit Standardtext.

Ticket-Kategorien:

- Login / Zugang
- Zahlung
- Stream-Probleme
- App-Hilfe
- Medienwunsch
- Sonstiges

Beim Schliessen erstellt der Bot ein Transcript als Textdatei unter
`data/transcripts` und haengt es im Ticket-Log an, sofern der Bot dort
schreiben darf.

Optionale Werte in `.env`:

```env
DISCORD_TICKET_CATEGORY_ID=
DISCORD_TICKET_ENTRY_CHANNEL_ID=
DISCORD_TICKET_LOG_CHANNEL_ID=
MAX_OPEN_TICKETS_PER_USER=1
ENABLE_SUPPORT_MESSAGE_TICKETS=true
ENABLE_SUPPORT_MESSAGE_CONTENT=false
```

Tickets werden in `data/tickets.json` gespeichert. Geschlossene Tickets
bleiben als Kanal erhalten, werden umbenannt und fuer den Ersteller gesperrt.

Wenn `ENABLE_TICKET_FOLLOWUPS=true` gesetzt ist, prueft der Bot regelmaessig
offene Tickets. Sobald ein User seit `TICKET_FOLLOWUP_HOURS` Stunden auf eine
Team-Antwort wartet, pingt der Bot das Team im Ticket und schreibt es ins Log.

## FAQ und Support-Status

`/faq` nutzt Autocomplete fuer bekannte Themen. `/support-status view` zeigt den
aktuellen Teamstatus und die Anzahl offener Tickets. Teammitglieder koennen mit
`/support-status set` zwischen `Online`, `Beschaeftigt` und `Offline` wechseln.

## OpenAI-Assistent

Der Bot kann optional OpenAI nutzen, um natuerlichere Supportantworten zu geben.
Er sammelt vorher Fakten aus Portal, Jellyfin, Ticketstatus, Supportstatus und
FAQ-Themen und gibt nur diese Fakten an das Modell weiter. Der Bot antwortet per
`/ask frage:<text>` oder im Chat, wenn er erwaehnt wird bzw. die Nachricht mit
`jellybot ...` beginnt.

Bei neuen Tickets bewertet der AI-Assistent automatisch Prioritaet und, bei
Button- oder Nachrichtentickets, auch die Kategorie. Wenn wichtige Infos fehlen,
fragt der Bot im Ticket gezielt nach, zum Beispiel nach App, Geraet,
Jellyfin-Benutzername oder Fehlermeldung.

Teamfunktionen:

- `/ticket summary` erstellt eine kompakte Zusammenfassung langer Tickets.
- `/ticket suggest` erstellt einen Antwortvorschlag. Dieser wird erst gesendet,
  wenn ein Teammitglied auf `Antwort senden` klickt.
- Beim Schliessen eines Tickets erstellt der Bot optional einen FAQ-Entwurf im
  Log-Kanal. Erst nach Klick auf `FAQ uebernehmen` wird er in
  `data/faq.json` gespeichert und von `/faq` sowie dem Chat-Fallback genutzt.

Aktivierung in `.env`:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_REASONING_EFFORT=low
OPENAI_MAX_OUTPUT_TOKENS=450
ENABLE_AI_ASSISTANT=true
```

Fuer Chat-Antworten auf Erwaehnungen braucht Discord den `Message Content
Intent`. `/ask` funktioniert auch ohne normale Nachrichten mitzulesen. Wenn eine
Medienfrage erkannt wird und Jellyfin API-Zugang vorhanden ist, zeigt der Bot
einen Button `Bibliothek scannen`. Diesen Button koennen nur Teamrollen nutzen.

## Moderation

Der Bot loescht fremde Discord-Invites automatisch, wenn
`ENABLE_INVITE_LINK_PROTECTION=true` gesetzt ist. Einladungen zum eigenen Server
bleiben erlaubt, sofern Discord sie eindeutig zuordnen kann.

`ENABLE_ADVANCED_ANTI_SPAM=true` erkennt Nachrichtenfluten, wiederholte
Nachrichten, viele Links, Caps-Spam und Mention-Spam. Fuer Regeln, die den
Nachrichtentext brauchen, muss `ENABLE_MODERATION_CONTENT=true` gesetzt und im
Discord Developer Portal der `Message Content Intent` aktiv sein.

`ENABLE_SCAM_PHRASE_PROTECTION=true` loescht typische Scam-/Phishing-Nachrichten
wie Free-Nitro, Steam-Gift, Wallet-/Airdrop- und Account-Verifizierungsmaschen.
Sehr neue Accounts werden bei Links und mehreren Mentions strenger bewertet.

`ENABLE_NEW_ACCOUNT_PROTECTION=true` loggt neue Accounts mit Account-Alter. Unter
`NEW_ACCOUNT_WARN_DAYS` werden sie als beobachtenswert markiert, unter
`NEW_ACCOUNT_STRICT_DAYS` gelten strengere Anti-Spam-Regeln. Optional kann mit
`DISCORD_NEW_ACCOUNT_REVIEW_ROLE_ID` eine Review-Rolle vergeben oder mit
`NEW_ACCOUNT_STRICT_TIMEOUT_MINUTES` ein kurzer automatischer Timeout gesetzt
werden.

Warnungen haben einen Verlauf mit ID. `/warnings user:<user>` zeigt aktive
Warnungen, `/unwarn user:<user> id:<id>` entfernt eine bestimmte Warnung und
`/unwarn user:<user>` entfernt die letzte aktive Warnung. Ab
`WARNINGS_BEFORE_TIMEOUT` setzt der Bot automatisch Timeouts; weitere Warnungen
erhoehen die Dauer schrittweise.

## Lokal starten

```bash
npm install
npm run dev
```

Fuer den produktiven Start zuerst bauen:

```bash
npm run build
npm run start
```

Auf Windows kannst du auch im Projektordner ein PowerShell-Fenster
oeffnen und den lokalen Starter ausfuehren:

```powershell
.\start-bot.ps1
```

Das Fenster muss offen bleiben, solange der Bot online sein soll.

## Docker

Der Bot kann als einzelnes Docker-Image gebaut werden:

```bash
docker build -t jellyfin-discord-bot .
docker run --env-file .env -e BOT_DATA_DIR=/app/data -v ${PWD}/data:/app/data jellyfin-discord-bot
```

`BOT_DATA_DIR` muss auf den gemounteten Pfad zeigen, damit `tickets.json`,
`faq.json` & Co. einen Neustart ueberleben (Default ist `./data`).
