# transcript_backend — Backend para llamadas IUL

Backend Node.js/Fastify para el proyecto de llamadas IUL. Se encarga de autenticar agentes con Discord, abrir sesiones de llamada, recibir audio en vivo, transcribirlo con Deepgram, mantener el transcript reciente en Redis, persistirlo en Postgres al cerrar la sesión, responder preguntas del agente con OpenClaw/GPT y generar sugerencias de Copilot durante la llamada.

También incluye módulos auxiliares para clock-in/clock-out de agentes, sincronización con Google Sheets y dashboard administrativo.

## Resumen rápido

- **Runtime:** Node.js + TypeScript + Fastify.
- **Base de datos:** PostgreSQL.
- **Cache/estado en vivo:** Redis.
- **Transcripción:** Deepgram Live STT, audio PCM 16 kHz, 2 canales.
- **LLM principal para `/ask`:** OpenClaw Gateway vía `/v1/chat/completions`.
- **Copilot:** puede usar OpenAI directo, OpenClaw o fallback playbook-only.
- **Auth agentes:** OAuth Discord + JWT propio.
- **Auth interna:** `X-Internal-Secret` para bot/servicios internos.
- **Dashboard:** login propio con JWT separado.

## Arquitectura general

```text
Frontend agente / transcript_app
        │
        │ Discord OAuth + JWT
        ▼
transcript_backend ───────────────► Discord API
        │
        ├── WebSocket /audio ─────► Deepgram Live STT
        │         │
        │         └── transcript turns en Redis
        │
        ├── /ask ─────────────────► OpenClaw Gateway / LLM
        │
        ├── Copilot ──────────────► OpenAI API u OpenClaw
        │
        ├── clock-in/out ─────────► Postgres + Google Sheets
        │
        └── Postgres ◄──────────── sesiones, usuarios, transcripts,
                                     preguntas, clock events, sugerencias
```

## Flujo principal de llamada

### 1. Login del agente con Discord

1. El frontend obtiene un `code` de Discord OAuth.
2. Envía el code a:

```http
POST /auth/discord
```

3. El backend intercambia el code por token contra Discord.
4. Consulta:
   - usuario Discord (`/users/@me`)
   - guilds del usuario (`/users/@me/guilds`)
5. Valida que el usuario pertenezca al `DISCORD_GUILD_ID` configurado.
6. Inserta/actualiza el usuario en `users`.
7. Devuelve un JWT propio del backend con duración aproximada de 14 horas.

Ese JWT se usa después como `Authorization: Bearer <jwt>` para rutas de sesión, audio y Copilot.

### 2. Crear sesión de llamada

```http
POST /sessions
Authorization: Bearer <jwt>
```

El backend:

1. Cierra cualquier sesión activa previa del mismo agente.
2. Crea una nueva fila en `sessions` con estado `active`.
3. Guarda en Redis la sesión activa:

```text
agent:<discordUserId>:active_session = <sessionId>
```

4. Inicializa el estado del Copilot:

```text
session:<sessionId>:copilot_state = { stage: "opening", updatedAt: ... }
```

5. Devuelve `sessionId`.

### 3. Enviar audio en vivo

El frontend abre un WebSocket:

```text
GET /audio?sessionId=<sessionId>&token=<jwt>
```

Validaciones:

- Debe venir `sessionId`.
- Debe venir `token` JWT válido.
- La sesión debe ser la sesión activa en Redis para ese usuario.

Formato esperado del audio:

- PCM lineal (`linear16`).
- 16 kHz.
- 2 canales.
- Canal 0 = agente.
- Canal 1 = cliente.

El backend envía los frames binarios a Deepgram Live.

### 4. Deepgram genera turnos de transcript

Deepgram está configurado con:

- `model: nova-3`
- `language: es`
- `multichannel: true`
- `channels: 2`
- `sample_rate: 16000`
- `encoding: linear16`
- `interim_results: false`
- keywords/keyterms relacionadas con IUL.

Cuando Deepgram devuelve texto final:

1. El backend determina speaker por canal:
   - canal `0` → `agente`
   - canal `1` → `cliente`
2. Crea un `TranscriptTurn`:

```ts
{
  speaker: 'agente' | 'cliente',
  text: string,
  timestamp: number,
  channel: 0 | 1
}
```

3. Lo agrega a Redis:

```text
session:<sessionId>:transcript
```

4. Actualiza la etapa de llamada del Copilot según keywords.
5. Si cambia la etapa, envía al frontend:

```json
{ "type": "call_stage", "stage": "discovery" }
```

### 5. Estado en vivo en Redis

Durante la llamada, el transcript vive principalmente en Redis para baja latencia.

Claves principales:

```text
agent:<discordUserId>:active_session
session:<sessionId>:transcript
session:<sessionId>:copilot_state
```

El transcript en Redis tiene TTL de 1 hora. Al cerrar sesión se persiste en Postgres y se limpia Redis.

### 6. Preguntas del agente durante la llamada

Una integración interna, normalmente el bot de Discord, puede preguntar al backend:

```http
POST /ask
X-Internal-Secret: <INTERNAL_SECRET>
Content-Type: application/json

{
  "discordUserId": "...",
  "question": "¿Cómo respondo a esta objeción?"
}
```

El backend:

1. Busca la sesión activa del agente en Redis.
2. Toma los turnos recientes de los últimos 5 minutos.
3. Construye un prompt con:
   - transcript reciente
   - pregunta del agente
   - reglas de respuesta para ventas IUL
4. Llama a OpenClaw Gateway en:

```text
<OPENCLAW_URL>/v1/chat/completions
```

5. Usa headers de OpenClaw:

```text
Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
x-openclaw-agent-id: <OPENCLAW_AGENT_ID>
x-openclaw-message-channel: discord
x-openclaw-session-key: agent:<OPENCLAW_AGENT_ID>:explicit:<discordUserId>
```

6. Devuelve una respuesta breve que el agente pueda usar.
7. Si hay sesión activa, guarda la pregunta y respuesta en `questions`.

Si no hay transcript activo, `/ask` funciona como consulta general interna sobre IUL y responde en máximo 3 oraciones.

### 7. Cerrar sesión

```http
POST /sessions/:id/end
Authorization: Bearer <jwt>
```

El backend:

1. Valida que la sesión exista, esté activa y pertenezca al usuario.
2. Marca la sesión como `ended`.
3. Lee todos los turnos desde Redis.
4. Inserta cada turno en `transcript_turns`.
5. Borra:
   - transcript temporal
   - estado del Copilot
   - sesión activa del usuario

También existe cierre automático por silencio: si no llega audio binario por 60 segundos, el backend finaliza la sesión y cierra el WebSocket.

## Flujo de Copilot

El Copilot ayuda al agente con frases sugeridas durante la llamada.

### Etapas de llamada

Se detectan por keywords en el transcript:

- `idle`
- `opening`
- `discovery`
- `presentation`
- `objection_handling`
- `closing`
- `follow_up`
- `ended`

La detección vive en `src/copilot/stageDetector.ts` y usa grupos de keywords de `src/copilot/keywords.ts`.

Regla importante: normalmente no retrocede de etapa, salvo `objection_handling`, que puede aparecer desde cualquier etapa.

### Estado de Copilot

Consultar etapa actual:

```http
GET /sessions/:id/copilot/state
Authorization: Bearer <jwt>
```

Respuesta:

```json
{ "stage": "presentation" }
```

### Generar sugerencia manual

```http
POST /sessions/:id/copilot/suggest
Authorization: Bearer <jwt>
```

El backend:

1. Valida ownership de la sesión.
2. Crea una señal `manual_request`.
3. Construye contexto con:
   - etapa actual
   - transcript reciente
   - guion IUL relevante
   - FAQ de producto
   - reglas de compliance
4. Genera una frase breve con el proveedor configurado.
5. Guarda la sugerencia en `copilot_suggestions`.
6. Guarda log completo de prompt/respuesta/error/latencia en `copilot_gpt_request_logs`.

### Proveedores del Copilot

Configurable con `COPILOT_PROVIDER`:

- `gpt_api`: usa OpenAI directo con `OPENAI_API_KEY` y `GPT_MODEL`.
- `openclaw`: usa OpenClaw Gateway.
- `playbook_only`: devuelve una frase fija/fallback sin llamar a LLM.

### Aceptar o descartar sugerencias

```http
POST /copilot/suggestions/:id/feedback
Authorization: Bearer <jwt>
Content-Type: application/json

{ "accepted": true }
```

- `accepted: true` marca la sugerencia como aceptada.
- `accepted: false` la marca como descartada.

Actualmente esto actualiza el campo `accepted` en Postgres. Sirve para auditoría, métricas y aprendizaje futuro; la acción visible en frontend puede además retirar la tarjeta de sugerencia.

## Clock-in / Clock-out

Estas rutas están pensadas para consumo interno, por ejemplo desde el bot de Discord. Todas usan:

```text
X-Internal-Secret: <INTERNAL_SECRET>
```

### Clock-in

```http
POST /clock/in

{
  "discordUserId": "...",
  "displayName": "Nombre Agente"
}
```

### Clock-out

```http
POST /clock/out

{
  "discordUserId": "...",
  "displayName": "Nombre Agente"
}
```

### Clock-out masivo

```http
POST /clock/out-all
```

Cierra todos los agentes que tengan último evento `CLOCKIN`.

### Estado actual

```http
GET /clock/status/:discordUserId
```

### Historial

```http
GET /clock/history/:discordUserId?limit=50
```

### Cómo funciona internamente

- Los eventos se guardan en `clock_events`.
- Se usa `pg_advisory_xact_lock(hashtext(discordUserId))` para evitar condiciones de carrera por agente.
- No permite doble `CLOCKIN` seguido.
- No permite `CLOCKOUT` si el agente no está clocked-in.
- Cada evento intenta sincronizarse con Google Sheets.
- Si falla Sheets, el evento queda guardado en Postgres con `sheets_synced = false` y `sheets_error`.

Google Sheets crea una pestaña por agente con nombre sanitizado:

```text
<displayName>_<últimos 6 caracteres del discordUserId>
```

Columnas:

```text
Fecha | Hora | Acción
```

## Dashboard administrativo

Auth separada de Discord.

### Login

```http
POST /dashboard/login

{
  "username": "admin",
  "password": "..."
}
```

Devuelve JWT de dashboard firmado con `DASHBOARD_JWT_SECRET`.

### Refresh token

```http
POST /dashboard/refresh
Authorization: Bearer <dashboard_jwt>
```

### Resumen de horas

```http
GET /dashboard/clock/summary?from=<iso>&to=<iso>
Authorization: Bearer <dashboard_jwt>
```

- Rango máximo: 90 días.
- Devuelve total de minutos, shifts, estado actual y detalle por agente.

### Eventos paginados

```http
GET /dashboard/clock/events?from=<iso>&to=<iso>&limit=100&offset=0
Authorization: Bearer <dashboard_jwt>
```

Opcional:

```text
discordUserId=<id>
```

## Modelo de datos

Migraciones en `src/db/migrations`.

### `users`

Usuarios autenticados por Discord.

Campos clave:

- `discord_user_id`
- `username`
- `avatar`
- timestamps

### `sessions`

Sesiones de llamada.

Campos clave:

- `id`
- `discord_user_id`
- `agent_name`
- `status`: `active` o `ended`
- `started_at`
- `ended_at`

### `transcript_turns`

Transcript persistido al cerrar sesión.

Campos clave:

- `session_id`
- `speaker`: `agente` o `cliente`
- `channel`: `0` o `1`
- `text`
- `ts`

### `questions`

Preguntas hechas por el agente y respuestas generadas por LLM.

### `clock_events`

Eventos de entrada/salida laboral.

### `dashboard_users`

Usuarios administrativos del dashboard.

> Nota: la tabla existe, pero el alta/seed de usuarios depende de operación manual o script externo; revisar `dashboardAuth.ts` antes de crear usuarios para respetar el hash esperado.

### `copilot_suggestions`

Sugerencias mostradas al agente.

Campos clave:

- `session_id`
- `trigger_type`
- `stage`
- `matched_keywords`
- `transcript_excerpt`
- `suggestion`
- `source`
- `accepted`
- `shown_at`

### `copilot_gpt_request_logs`

Logs de requests del Copilot a GPT/OpenClaw/playbook.

Guarda prompt, respuesta, error, modelo y latencia para auditoría y debugging.

### `objection_playbook`

Playbook inicial de objeciones comunes.

## Estructura del proyecto

```text
src/
  index.ts                    # bootstrap Fastify, CORS, rutas, WebSocket
  config.ts                   # validación de variables de entorno con zod
  types.ts                    # tipos compartidos y extensión Fastify

  db/
    client.ts                 # pool Postgres
    migrate.ts                # runner de migraciones SQL
    migrations/               # schema SQL

  redis/
    client.ts                 # cliente Redis

  middleware/
    auth.ts                   # JWT agente, secret interno, JWT dashboard

  routes/
    auth.ts                   # Discord OAuth
    sessions.ts               # crear/cerrar sesiones
    ask.ts                    # preguntas al LLM usando transcript reciente
    copilot.ts                # estado/sugerencias/feedback Copilot
    clock.ts                  # clock-in/out interno
    dashboard.ts              # login y reportes dashboard

  services/
    deepgram.ts               # conexión live STT
    openclaw.ts               # cliente OpenClaw chat completions
    gpt.ts                    # cliente OpenAI directo para Copilot
    discord.ts                # OAuth y guild check
    jwt.ts                    # JWT agente
    sessions.ts               # estado sesión + transcript Redis/Postgres
    clock.ts                  # lógica clock-in/out + resumen dashboard
    sheets.ts                 # Google Sheets append
    dashboardAuth.ts          # auth dashboard

  copilot/
    analyzer.ts               # analiza turns y señales
    stageDetector.ts          # etapa de llamada
    contextBuilder.ts         # prompt/contexto Copilot
    recommendationService.ts  # genera y persiste sugerencias
    keywords.ts               # keywords por etapa/señal
    playbooks/                # guion, FAQ y compliance

  ws/
    audioHandler.ts           # endpoint WebSocket /audio
```

## Variables de entorno

Copiar `.env.example` y completar valores reales.

```bash
cp .env.example .env
```

Variables obligatorias principales:

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://iul:CHANGE_ME@localhost:5432/iul_assistant
REDIS_URL=redis://localhost:6379

DEEPGRAM_API_KEY=

OPENCLAW_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_AGENT_ID=discord-bot
OPENCLAW_MODEL=openclaw/discord-bot
OPENCLAW_REQUEST_TIMEOUT_MS=120000

OPENAI_API_KEY=
GPT_MODEL=gpt-4.1-mini
GPT_REQUEST_TIMEOUT_MS=30000
COPILOT_ENABLED=true
COPILOT_PROVIDER=gpt_api
COPILOT_MIN_SECONDS_BETWEEN_SUGGESTIONS=20
COPILOT_RECENT_WINDOW_MS=180000

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_GUILD_ID=
DISCORD_REDIRECT_URI=

JWT_SECRET=
INTERNAL_SECRET=

FRONTEND_ORIGIN=
FRONTEND_EXTRA_ORIGINS=
DASHBOARD_ORIGIN=

GOOGLE_SERVICE_ACCOUNT_JSON=/etc/iul/google-service-account.json
GOOGLE_SHEETS_SPREADSHEET_ID=
CLOCK_TIMEZONE=America/Los_Angeles

DASHBOARD_JWT_SECRET=
DASHBOARD_JWT_TTL_HOURS=8
```

Generar secretos:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # INTERNAL_SECRET
openssl rand -base64 48   # DASHBOARD_JWT_SECRET
```

## Instalación local/desarrollo

### 1. Requisitos

- Node.js 20+.
- PostgreSQL 16 recomendado.
- Redis 7 recomendado.
- Cuenta/API key de Deepgram.
- OpenClaw Gateway accesible si se usará `/ask` o Copilot vía OpenClaw.
- API key de OpenAI si `COPILOT_PROVIDER=gpt_api`.
- Credenciales OAuth de Discord.
- Service account de Google si se usará Sheets.

### 2. Instalar dependencias

```bash
cd /root/.openclaw/workspace/iul/transcript_backend
npm install
```

### 3. Configurar Postgres

Ejemplo:

```bash
sudo -u postgres psql <<SQL
CREATE USER iul WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE iul_assistant OWNER iul;
GRANT ALL PRIVILEGES ON DATABASE iul_assistant TO iul;
SQL

sudo -u postgres psql -d iul_assistant -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

Actualizar `DATABASE_URL` en `.env`.

### 4. Levantar Redis

Ubuntu:

```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping
```

Debe responder:

```text
PONG
```

### 5. Configurar `.env`

```bash
cp .env.example .env
nano .env
```

Asegurarse de completar como mínimo:

- `DATABASE_URL`
- `REDIS_URL`
- `DEEPGRAM_API_KEY`
- `OPENCLAW_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_GUILD_ID`
- `DISCORD_REDIRECT_URI`
- `JWT_SECRET`
- `INTERNAL_SECRET`
- `FRONTEND_ORIGIN`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `DASHBOARD_JWT_SECRET`

Si no se quiere usar Copilot con OpenAI directo, configurar:

```env
COPILOT_PROVIDER=openclaw
```

o:

```env
COPILOT_PROVIDER=playbook_only
```

### 6. Ejecutar migraciones

```bash
npm run db:migrate
```

### 7. Ejecutar en desarrollo

```bash
npm run dev
```

Servidor por defecto:

```text
http://localhost:3000
```

### 8. Build y ejecución productiva local

```bash
npm run build
npm start
```

## Instalación en Ubuntu/DigitalOcean

Hay una guía específica en:

```text
deploy/README.md
```

Resumen:

```bash
# Node 20
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Postgres + Redis
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16 redis-server
sudo systemctl enable --now redis-server

# DB
sudo -u postgres psql <<SQL
CREATE USER iul WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE iul_assistant OWNER iul;
GRANT ALL PRIVILEGES ON DATABASE iul_assistant TO iul;
SQL
sudo -u postgres psql -d iul_assistant -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# Usuario sistema
sudo useradd --system --shell /bin/bash --create-home iul

# Proyecto
cd /root/.openclaw/workspace/iul/transcript_backend
npm ci
npm run build

# Env productivo
sudo cp .env.example /etc/iul-backend.env
sudo chmod 600 /etc/iul-backend.env
sudo nano /etc/iul-backend.env

# Migraciones
sudo -u iul bash -c 'cd /root/.openclaw/workspace/iul/transcript_backend && set -a && source /etc/iul-backend.env && set +a && npm run db:migrate'

# systemd
sudo cp deploy/iul-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable iul-backend
sudo systemctl start iul-backend
sudo journalctl -u iul-backend -f
```

> Si el servicio corre como usuario `iul` y el proyecto vive bajo `/root`, revisar permisos de traversal como indica `deploy/README.md`.

## Scripts disponibles

```bash
npm run dev          # desarrollo con tsx watch
npm run build        # compila TypeScript a dist/
npm start            # ejecuta dist/index.js
npm run db:migrate   # aplica migraciones SQL pendientes
npm run lint         # eslint sobre src/
```

## Endpoints principales

### Públicos / frontend agente

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/auth/discord` | none | Intercambia code OAuth Discord por JWT interno |
| POST | `/sessions` | JWT agente | Crea sesión activa |
| POST | `/sessions/:id/end` | JWT agente | Cierra sesión y persiste transcript |
| WS | `/audio?sessionId=&token=` | JWT agente en query | Audio en vivo hacia Deepgram |
| GET | `/sessions/:id/copilot/state` | JWT agente | Estado/etapa actual |
| POST | `/sessions/:id/copilot/suggest` | JWT agente | Genera sugerencia manual |
| POST | `/copilot/suggestions/:id/feedback` | JWT agente | Marca sugerencia aceptada/descartada |

### Internos / bot

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/status/:discordUserId` | `X-Internal-Secret` | Indica si hay sesión activa |
| POST | `/ask` | `X-Internal-Secret` | Pregunta al LLM con transcript reciente |
| POST | `/clock/in` | `X-Internal-Secret` | Registra entrada |
| POST | `/clock/out` | `X-Internal-Secret` | Registra salida |
| POST | `/clock/out-all` | `X-Internal-Secret` | Cierra todas las entradas abiertas |
| GET | `/clock/status/:discordUserId` | `X-Internal-Secret` | Estado clock-in actual |
| GET | `/clock/history/:discordUserId` | `X-Internal-Secret` | Historial reciente |

### Dashboard

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/dashboard/login` | none | Login dashboard |
| POST | `/dashboard/refresh` | JWT dashboard | Renueva token |
| GET | `/dashboard/clock/summary` | JWT dashboard | Resumen por agente |
| GET | `/dashboard/clock/events` | JWT dashboard | Eventos paginados |

## Seguridad y controles

- CORS restringido a `FRONTEND_ORIGIN`, localhost dev, `FRONTEND_EXTRA_ORIGINS` y opcional `DASHBOARD_ORIGIN`.
- Rate limit activo en login Discord y login dashboard.
- JWT de agentes separado del JWT dashboard.
- Secret interno para rutas consumidas por bot/servicios.
- Logs del request serializan URL sin query params para evitar filtrar token de `/audio`.
- No se guardan transcripts definitivos hasta cerrar sesión; mientras tanto viven en Redis con TTL.
- OpenClaw se llama con `tool_choice: 'none'` para `/ask`, evitando que el modelo use herramientas externas en esas respuestas.
- Reglas de compliance en prompts: no prometer rendimientos garantizados, no presentar IUL como inversión sin riesgo.

## Verificación rápida

### Build

```bash
npm run build
```

### Migraciones

```bash
npm run db:migrate
```

### Redis

```bash
redis-cli ping
```

### Servicio systemd

```bash
sudo systemctl status iul-backend
sudo journalctl -u iul-backend -f
```

### Probar auth interna

```bash
curl -H "X-Internal-Secret: $INTERNAL_SECRET" \
  http://localhost:3000/status/<discordUserId>
```

## Troubleshooting

### `Missing or invalid environment variables`

`src/config.ts` valida todo al arrancar. Revisar `.env` o `/etc/iul-backend.env`. Una variable vacía en producción puede impedir que el servidor inicie.

### WebSocket cierra con `Unauthorized`

Revisar:

- `sessionId` presente.
- `token` JWT válido y no expirado.
- La sesión activa en Redis corresponde al mismo usuario.

### WebSocket cierra con `Session not found`

La sesión no coincide con:

```text
agent:<discordUserId>:active_session
```

Crear una sesión nueva con `POST /sessions`.

### No hay transcript

Revisar:

- Formato de audio: PCM linear16, 16 kHz, 2 canales.
- `DEEPGRAM_API_KEY` válido.
- Logs de `Deepgram connection opened`.
- Que lleguen frames binarios, no solo mensajes JSON/ping.

### `/ask` responde `llm_unavailable`

Revisar:

- `OPENCLAW_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_AGENT_ID`
- que OpenClaw Gateway esté levantado
- logs del backend para status HTTP o timeout

### Copilot responde `invalid_openai_api_key`

Si `COPILOT_PROVIDER=gpt_api`, revisar `OPENAI_API_KEY`.

Alternativas:

```env
COPILOT_PROVIDER=openclaw
```

o:

```env
COPILOT_PROVIDER=playbook_only
```

### Clock-in/out no aparece en Google Sheets

El evento puede estar guardado aunque falle Sheets. Revisar en Postgres:

```sql
SELECT id, discord_user_id, action, sheets_synced, sheets_error
FROM clock_events
ORDER BY event_at DESC
LIMIT 20;
```

Revisar:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- permisos del archivo JSON
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- que el spreadsheet esté compartido con el email de la service account

## Notas de mantenimiento

- Mantener `.env` y `/etc/iul-backend.env` fuera de git.
- No commitear credenciales de Google.
- Si se agregan columnas/tablas, crear nueva migración incremental en `src/db/migrations`.
- Si se cambia el contrato con frontend o bot, actualizar esta documentación y el cliente correspondiente.
- Para despliegues manuales: `git pull`, `npm ci`, `npm run build`, migraciones si aplica y restart de systemd.
