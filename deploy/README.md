# Deploy en Ubuntu (DigitalOcean Droplet)

## 1. Prerequisitos del sistema

```bash
# Node.js 20 LTS (con nvm es más limpio)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Postgres 16
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16

# Redis 7
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

## 2. Configurar Postgres

```bash
sudo -u postgres psql <<SQL
CREATE USER iul WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE iul_assistant OWNER iul;
GRANT ALL PRIVILEGES ON DATABASE iul_assistant TO iul;
SQL

# Habilitar pgcrypto (necesario para gen_random_uuid)
sudo -u postgres psql -d iul_assistant -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

## 3. Usuario del sistema

```bash
sudo useradd --system --shell /bin/bash --create-home iul
```

## 4. Desplegar el código

```bash
# Clonar en /opt/iul-backend (o la ruta que prefieras)
sudo mkdir -p /opt/iul-backend
sudo chown iul:iul /opt/iul-backend

# Como usuario iul (o clona con tu usuario y ajusta permisos)
git clone <repo-url> /opt/iul-backend
cd /opt/iul-backend

npm ci --omit=dev
npm run build
```

## 5. Variables de entorno

```bash
# Copiar la plantilla y rellenar los valores reales
sudo cp .env.example /etc/iul-backend.env
sudo chmod 600 /etc/iul-backend.env
sudo nano /etc/iul-backend.env
```

Valores que debes rellenar:
- `DATABASE_URL` — usar la contraseña real de Postgres
- `DEEPGRAM_API_KEY` — desde console.deepgram.com
- `OPENCLAW_URL` — puerto real de OpenClaw
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_REDIRECT_URI` — desde Discord Developer Portal
- `JWT_SECRET` — generar con `openssl rand -base64 48`
- `INTERNAL_SECRET` — generar con `openssl rand -base64 32`
- `FRONTEND_ORIGIN` — URL exacta del frontend en producción

## 6. Ejecutar migraciones

```bash
cd /opt/iul-backend

# Cargar las variables de entorno y correr el migrate
sudo -u iul bash -c 'set -a && source /etc/iul-backend.env && set +a && npm run db:migrate'
```

> **Nota local (desarrollo):** Si estás en tu máquina con un `.env` en la raíz del proyecto, simplemente:
> ```bash
> npm run db:migrate
> ```

## 7. Instalar y habilitar servicio systemd

```bash
sudo cp /opt/iul-backend/deploy/iul-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable iul-backend
sudo systemctl start iul-backend

# Verificar
sudo systemctl status iul-backend
sudo journalctl -u iul-backend -f
```

## 8. Exponer con Tailscale Funnel

```bash
# Asegúrate de que Tailscale está instalado y autenticado en el Droplet
sudo tailscale funnel --bg 3000

# Para ver el estado
tailscale funnel status
```

La URL pública será algo como `https://tu-droplet.tu-tailnet.ts.net`. Configura un CNAME en tu dominio hacia esa URL si quieres un dominio propio.

## 9. Verificación rápida

```bash
# El servidor responde
curl https://tu-dominio.com/health  # no existe aún, pero el 404 confirma que responde

# Verificar tablas en Postgres
sudo -u postgres psql -d iul_assistant -c "\dt"

# Verificar Redis
redis-cli ping  # debe devolver PONG
```

## Comandos útiles

```bash
# Reiniciar el backend
sudo systemctl restart iul-backend

# Ver logs en tiempo real
sudo journalctl -u iul-backend -f

# Actualizar código (deploy manual)
cd /opt/iul-backend
git pull
npm ci --omit=dev
npm run build
sudo systemctl restart iul-backend
```
