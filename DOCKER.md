# Docker & EasyPanel Deployment

Dieser Fork erweitert das Original um drei Dinge:

1. **Dockerfile** – Multi-Stage-Build inkl. Claude Code CLI, Non-Root-User, Healthcheck
2. **API-Key-Authentifizierung** – OpenAI-kompatibel via `Authorization: Bearer <key>`
3. **`.env`-Unterstützung** – Konfiguration über Umgebungsvariablen oder `.env`-Datei
4. **Bild-Support (Vision)** – `image_url`-Blöcke (Base64-Data-URLs wie von OpenWebUI, oder http(s)-URLs) werden als Temp-Dateien bereitgestellt; Claude liest sie über sein Read-Tool. Automatisches Aufräumen nach jedem Request, Limit 20 MB pro Bild
5. **Reasoning Effort** – `reasoning_effort` oder `effort` im Request (`low`/`medium`/`high`/`xhigh`/`max`) wird als `--effort`-Flag an die CLI durchgereicht
6. **Cache-Metriken** – Claude Code cached Prompts automatisch; der Proxy reichert `usage` um `cache_read_input_tokens`/`cache_creation_input_tokens` an, damit Einsparungen sichtbar sind

Damit lässt sich der Proxy direkt aus diesem Repo auf EasyPanel (oder jedem anderen Docker-Host) betreiben.

## Konfiguration

| Variable | Default | Beschreibung |
|---|---|---|
| `PROXY_API_KEY` | *(generiert)* | API-Key, den Clients als Bearer-Token mitschicken müssen. Ohne Konfiguration wird beim Start ein zufälliger Key generiert und **einmalig ins Log geschrieben**. `off` deaktiviert Auth (nur lokal!). |
| `PROXY_ADMIN_KEY` | *(fällt auf `PROXY_API_KEY` zurück)* | Key für die Admin-Endpunkte `/admin/*` (Re-Login-Flow). **Empfehlung: separaten, starken Key setzen**, damit normale API-Nutzer keinen Relogin auslösen können. Weder Admin- noch API-Key gesetzt → Admin-Endpunkte gesperrt (403). |
| `PORT` | `3456` | Port des HTTP-Servers |
| `HOST` | `127.0.0.1` lokal / `0.0.0.0` im Docker-Image | Bind-Adresse |
| `DEBUG` | – | `1` aktiviert Request-Logging |

`/health` bleibt immer öffentlich (für Uptime-Checks und den Docker-Healthcheck).

## EasyPanel-Setup

1. **Neuer Dienst** → Typ „App" → Quelle: **GitHub-Repository** → dieses Repo auswählen. EasyPanel erkennt das Dockerfile automatisch (Build-Typ „Dockerfile").
2. **Environment-Variablen** setzen:
   - `PROXY_API_KEY` – dein geheimer API-Key (z. B. `openssl rand -hex 32`)
   - `PROXY_ADMIN_KEY` – separater Key für `/admin/*` (Re-Login). Ebenfalls stark wählen; ohne ihn gilt `PROXY_API_KEY` auch für Admin-Endpunkte
   - `HOST=0.0.0.0` und `PORT=3456` sind im Image bereits voreingestellt
3. **Volume anlegen (Pflicht!):** Mount-Pfad **`/data`** – dort liegen die Claude-Credentials (`/data/.claude`). Das ist der **einzige** Pfad, der persistent sein muss; Tokens werden bei jeder Nutzung automatisch erneuert und dorthin zurückgeschrieben. **Ohne Volume ist die Anmeldung nach jedem Redeploy/Neustart weg.**
4. **Erst-Anmeldung:** Einfach den Dienst starten und einmal den Re-Login-Flow durchlaufen (siehe unten) – kein manuelles Kopieren von Credentials nötig.
5. **Domain** auf den Dienst zeigen, Port **3456** – SSL übernimmt EasyPanel.
6. **Einmalig einloggen:** Beim ersten Start ist das Volume leer – Chat-Requests beantwortet der Proxy dann mit einer Anleitung statt einer Fehlermeldung. Einmal den Re-Login-Flow durchlaufen (siehe nächster Abschnitt), danach funktioniert alles dauerhaft – auch über Neustarts und Redeploys hinweg.

## Testen

```bash
# Health (kein Key nötig)
curl https://deine-domain/health

# Modelle (Key nötig)
curl https://deine-domain/v1/models \
  -H "Authorization: Bearer <PROXY_API_KEY>"

# Chat Completion
curl -X POST https://deine-domain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'

# Mit Reasoning Effort + Bild
curl -X POST https://deine-domain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -d '{
    "model": "claude-opus-5",
    "reasoning_effort": "high",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Was steht in diesem Dokument?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
      ]
    }]
  }'
```

**Modelle:** `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4(-6)`, `claude-sonnet-4(-5/-6)`, `claude-haiku-4(-5)` sowie die Aliase `opus`/`sonnet`/`haiku`. Intern mappen alle auf die CLI-Familie – die konkrete Version bestimmt die installierte CLI (immer aktuell halten: `claude update`).

**Hinweis Bilder:** Der Umweg über Temp-Dateien kostet einen zusätzlichen Tool-Call (Read). Kurze Bild-Fragen funktionieren gut; bei sehr vielen Bildern pro Konversation steigt der Token-Verbrauch entsprechend.

In OpenWebUI, Continue.dev o. ä. als OpenAI-Endpoint eintragen:
- **Base URL:** `https://deine-domain/v1`
- **API Key:** dein `PROXY_API_KEY`

## Docker Compose (alternativ zu EasyPanel)

```yaml
services:
  claude-max-proxy:
    build: .
    ports:
      - "3456:3456"
    environment:
      PROXY_API_KEY: ${PROXY_API_KEY}
    volumes:
      - claude-auth:/data
    restart: unless-stopped

volumes:
  claude-auth:
```

## Re-Login ohne Container-Zugriff

Läuft die Anmeldung ab (oder beim ersten Start), bekommst du im Chat eine entsprechende Nachricht. Die Neuanmeldung läuft komplett über die Admin-API – der Login-Prozess (`claude auth login`) startet **im Container**, du klickst nur im Browser:

```bash
# 1. Login-Flow starten - Antwort enthält die OAuth-URL
curl -X POST https://deine-domain/admin/relogin/start \
  -H "Authorization: Bearer <PROXY_ADMIN_KEY>"

# 2. URL im Browser öffnen, autorisieren, Code kopieren

# 3. Code zurückschicken - CLI schreibt frische Tokens ins Volume
curl -X POST https://deine-domain/admin/relogin/complete \
  -H "Authorization: Bearer <PROXY_ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"code": "dein-code-aus-dem-browser"}'

# Zwischendurch Status prüfen
curl https://deine-domain/admin/relogin/status \
  -H "Authorization: Bearer <PROXY_ADMIN_KEY>"
```

Der Flow läuft nach 10 Minuten ab (Sicherheits-Timeout). Die Admin-Endpunkte verlangen `PROXY_ADMIN_KEY` – ist der nicht gesetzt, gilt `PROXY_API_KEY`. **Empfehlung:** einen separaten, stärkeren Admin-Key setzen, damit normale API-Nutzer keinen Relogin auslösen können.

### Mounts im Überblick

| Pfad | Typ | Zweck |
|---|---|---|
| `/data` | **Volume (Pflicht)** | Claude-Credentials (`/data/.claude`) – überlebt Neustarts/Redeploys; Tokens erneuern sich hier automatisch |
| alles andere | ephemeral | Image, Code, Temp-Dateien – darf bei jedem Deploy neu entstehen |

## ⚠️ Hinweis zu Kosten & Limits

Seit Juni 2026 trennt Anthropic interaktive Nutzung (Abo-Flatrate) und programmatische Nutzung (separater **Agent-SDK-Credit**: 20 $ Pro / 100 $ Max 5x / 200 $ Max 20x pro Monat, nicht übertragbar). Dieser Proxy nutzt `claude -p` und fällt damit in den Credit-Topf. Ist der aufgebraucht, wird zu API-Preisen weiter abgerechnet – setze in der Anthropic-Konsole ein Ausgaben-Limit.
