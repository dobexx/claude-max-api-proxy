/**
 * User-facing messages shared by the request handlers.
 */

/**
 * Guidance when the Claude CLI's OAuth session has expired.
 * Returned as a normal assistant message instead of a raw 500 so the user
 * sees actionable steps directly in their chat client.
 */
export const AUTH_EXPIRED_MESSAGE = [
  "Die Claude-Anmeldung auf dem Server ist abgelaufen – Anfragen sind derzeit nicht moeglich.",
  "",
  "Neuanmeldung direkt ueber die Admin-API (kein Server-Zugriff noetig):",
  "1. `POST /admin/relogin/start` (mit Admin-Key) – die Antwort enthaelt eine Login-URL.",
  "2. URL im Browser oeffnen und die Anmeldung bestaetigen.",
  "3. Den angezeigten Code per `POST /admin/relogin/complete` zurueckschicken.",
  "4. Danach funktioniert dieser Chat sofort wieder – die neuen Tokens liegen persistent im Volume.",
  "",
  "Details: siehe DOCKER.md, Abschnitt 'Re-Login ohne Container-Zugriff'.",
].join("\n");
