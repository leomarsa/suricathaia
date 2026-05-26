# SuricathaIA — Guia para Claude Code

## O que é este projeto

Sistema de segurança e controle de acesso com reconhecimento de placas (LPR), portaria, detecção de EPI, contagem de pessoas e CCTV.

- **Backend**: FastAPI + PostgreSQL 16 (`/app/api.py`, `/app/routers/`, `/app/services/`)
- **Frontend**: React + TypeScript + Vite (`/app/frontend/src/`)
- **Runtime**: Python 3.12, Node 20, Nginx, systemd
- **Venv**: `/opt/suricatha/.venv`
- **Modelos YOLO**: `/opt/suricatha/models/`

---

## Instalação em novo VPS (Ubuntu 22.04 / 24.04)

Se este repositório foi clonado em um servidor novo, siga os passos abaixo **integralmente e sem pedir confirmação a cada etapa**.

### Pré-requisitos
- Ubuntu 22.04 ou 24.04
- Acesso root
- Mínimo 2 vCPU / 4 GB RAM

### Passo 1 — Rodar o script de instalação

```bash
sudo bash /app/install.sh
```

O script faz automaticamente:
1. Instala Python 3.12, Node 20, PostgreSQL 16, Nginx, ffmpeg e dependências de sistema
2. Cria diretórios `/opt/suricatha/{storage,logs,models,reports}` e `/home/camera_lpr/uploads`
3. Cria banco PostgreSQL `suricatha_db` com usuário `suricatha`
4. Aplica `schema.sql` + todas as migrations em `migrations/*.sql`
5. Cria venv `/opt/suricatha/.venv` e instala `requirements.txt`
6. Baixa modelo YOLOv8n de `github.com/ultralytics/assets`
7. Copia `.env.example` → `.env` e pede o IP/domínio do servidor
8. Build do frontend (`npm install && npm run build`)
9. Configura Nginx com `deploy/nginx-suricatha.conf`
10. Instala e habilita serviços systemd `suricathaia-api` e `suricathaia-watchdog`
11. Inicia os serviços se `.env` não tiver chaves padrão

### Passo 2 — Gerar e aplicar chaves seguras

Pergunte ao usuário o IP ou domínio do servidor, depois execute:

```bash
SERVER_IP="IP_INFORMADO_PELO_USUARIO"

JWT=$(openssl rand -hex 32)
APIKEY=$(openssl rand -hex 24)

sed -i "s|TROQUE_POR_TOKEN_SEGURO|${JWT}|g"    /app/.env
sed -i "s|TROQUE_POR_APIKEY_SEGURA|${APIKEY}|g" /app/.env
sed -i "s|SEU_IP_OU_DOMINIO|${SERVER_IP}|g"    /app/.env
sed -i "s|SEU_IP_OU_DOMINIO|${SERVER_IP}|g"    /app/frontend/.env
```

Outros campos opcionais que o usuário pode querer configurar em `/app/.env`:
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — alertas via Telegram
- `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` / `EVOLUTION_INSTANCE` / `EVOLUTION_PHONE` — WhatsApp via Evolution API
- `ZAPI_INSTANCE_ID` / `ZAPI_TOKEN` / `ZAPI_PHONE` — WhatsApp via Z-API

### Passo 3 — Build do frontend com IP correto

```bash
cd /app/frontend && npm run build
```

### Passo 4 — Iniciar e verificar serviços

```bash
systemctl restart nginx
systemctl start suricathaia-api suricathaia-watchdog
systemctl enable suricathaia-api suricathaia-watchdog
```

Verificar se tudo está rodando:

```bash
systemctl status suricathaia-api suricathaia-watchdog --no-pager
curl -s http://localhost:8000/health
```

---

## Atualizar um VPS já instalado

```bash
cd /app && git pull
cd frontend && npm run build && cd ..
systemctl restart suricathaia-api suricathaia-watchdog
```

## Publicar alterações para o GitHub

```bash
cd /app && bash setup_github.sh
```

---

## Serviços e comandos do dia-a-dia

| Ação | Comando |
|------|---------|
| Logs da API | `journalctl -u suricathaia-api -f` |
| Logs do watchdog | `journalctl -u suricathaia-watchdog -f` |
| Reiniciar API | `systemctl restart suricathaia-api` |
| Rebuild frontend | `cd /app/frontend && npm run build` |
| Status geral | `systemctl status suricathaia-api suricathaia-watchdog nginx` |

---

## Arquivos principais

| Arquivo | Responsabilidade |
|---------|-----------------|
| `/app/api.py` | Entrypoint FastAPI |
| `/app/routers/portaria.py` | Endpoints de portaria/visitas |
| `/app/routers/cameras.py` | Gestão de câmeras |
| `/app/routers/analytics.py` | Contagem de pessoas / EPI |
| `/app/routers/telemetria.py` | Telemetria de câmeras |
| `/app/services/database.py` | Pool de conexões PostgreSQL |
| `/app/services/watchdog_service.py` | Pipeline LPR principal |
| `/app/core/engine.py` | Motor de processamento OCR/YOLO |
| `/app/schema.sql` | Schema completo do banco |
| `/app/migrations/` | Migrations SQL adicionais |
| `/app/frontend/src/App.tsx` | Rotas e auth guard |
| `/app/frontend/src/api.ts` | Cliente HTTP centralizado |
| `/app/frontend/src/pages/Portaria.tsx` | Portaria — wizard, QR, cards, tabs |
| `/app/frontend/src/pages/Deteccoes.tsx` | Detecções — live feed + grid |
| `/app/frontend/src/pages/PreCadastro.tsx` | Pré-cadastro público (3 etapas) |
| `/app/frontend/src/components/Sidebar.tsx` | Nav config com todas as rotas |

---

## Convenções do projeto

- **Auth**: API key no localStorage `api_key`, roles: `admin` / `operador` / `viewer`
- **Rota pública**: `/pre-cadastro` está fora do auth guard em `App.tsx`
- **SSE**: eventos `nova_leitura` disparam reload em `Deteccoes.tsx`
- **Imagens de placas**: servidas pelo Nginx em `/storage/` → `/opt/suricatha/storage/`
- **Idioma**: respostas da API e UI sempre em português
- **PostgreSQL**: conexões via `psycopg2` com `RealDictCursor`
