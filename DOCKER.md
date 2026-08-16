# Docker & EasyPanel Deployment

Dieser Fork erweitert das Original um drei Dinge:

1. **Dockerfile** – Multi-Stage-Build inkl. Claude Code CLI, Non-Root-User, Healthcheck
2. **API-Key-Authentifizierung** – OpenAI-kompatibel via `Authorization: Bearer <key>`
3. **`.env`-Unterstützung** – Konfiguration über Umgebungsvariablen oder `.env`-Datei

Damit lässt sich der Proxy direkt aus diesem Repo auf EasyPanel (oder jedem anderen Docker-Host) betreiben.

## Konfiguration

| Variable | Default | Beschreibung |
|---|---|---|
| `PROXY_API_KEY` | *(generiert)* | API-Key, den Clients als Bearer-Token mitschicken müssen. Ohne Konfiguration wird beim Start ein zufälliger Key generiert und **einmalig ins Log geschrieben**. `off` deaktiviert Auth (nur lokal!). |
| `PORT` | `3456` | Port des HTTP-Servers |
| `HOST` | `127.0.0.1` lokal / `0.0.0.0` im Docker-Image | Bind-Adresse |
| `DEBUG` | – | `1` aktiviert Request-Logging |

`/health` bleibt immer öffentlich (für Uptime-Checks und den Docker-Healthcheck).

## EasyPanel-Setup

1. **Neuer Dienst** → Typ „App" → Quelle: **GitHub-Repository** → dieses Repo auswählen. EasyPanel erkennt das Dockerfile automatisch (Build-Typ „Dockerfile").
2. **Environment-Variablen** setzen:
   - `PROXY_API_KEY` – dein geheimer Key (z. B. `openssl rand -hex 32`)
   - `HOST=0.0.0.0` und `PORT=3456` sind im Image bereits voreingestellt
3. **Volume anlegen:** Mount-Pfad `/data` – dort liegen die Claude-Credentials (`/data/.claude`). **Ohne Volume geht die Authentifizierung bei jedem Redeploy verloren.**
4. **Claude-Credentials hinterlegen:** Lokal einmal `claude auth login` ausführen, dann den Inhalt von `~/.claude` in das Volume kopieren (per `scp` auf den Server oder über das EasyPanel-Terminal in den Container).
5. **Domain** auf den Dienst zeigen, Port **3456** – SSL übernimmt EasyPanel.

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
```

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

## ⚠️ Hinweis zu Kosten & Limits

Seit Juni 2026 trennt Anthropic interaktive Nutzung (Abo-Flatrate) und programmatische Nutzung (separater **Agent-SDK-Credit**: 20 $ Pro / 100 $ Max 5x / 200 $ Max 20x pro Monat, nicht übertragbar). Dieser Proxy nutzt `claude -p` und fällt damit in den Credit-Topf. Ist der aufgebraucht, wird zu API-Preisen weiter abgerechnet – setze in der Anthropic-Konsole ein Ausgaben-Limit.
