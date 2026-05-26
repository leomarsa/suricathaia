# SuricathaIA — Guia para Claude Code

## O que é este projeto

Sistema de segurança e controle de acesso com reconhecimento de placas (LPR), portaria, detecção de EPI, contagem de pessoas e CCTV.

- **Backend**: FastAPI + PostgreSQL 16 (`/app/api.py`, `/app/routers/`, `/app/services/`)
- **Frontend**: React + TypeScript + Vite (`/app/frontend/src/`)
- **Runtime**: Python 3.12, Node 20, Nginx, systemd
- **Venv**: `/opt/suricatha/.venv`
- **Modelos YOLO**: `/opt/suricatha/models/`

---

## Instalação em novo VPS

Se este repositório foi clonado em um servidor novo e o sistema ainda não está instalado, execute o procedimento completo abaixo **sem pedir confirmação a cada passo**.

### Passo 1 — Rodar o script de instalação

```bash
sudo bash /app/install.sh
```

O script instala todas as dependências, cria o banco, aplica migrations, configura Nginx e systemd.

### Passo 2 — Configurar `.env`

Após o script terminar, gere e aplique as chaves seguras:

```bash
JWT=$(openssl rand -hex 32)
APIKEY=$(openssl rand -hex 24)
sed -i "s|TROQUE_POR_TOKEN_SEGURO|${JWT}|g" /app/.env
sed -i "s|TROQUE_POR_APIKEY_SEGURA|${APIKEY}|g" /app/.env
```

Pergunte ao usuário o IP ou domínio do servidor e substitua em ambos os arquivos:

```bash
sed -i "s|SEU_IP_OU_DOMINIO|IP_INFORMADO|g" /app/.env
sed -i "s|SEU_IP_OU_DOMINIO|IP_INFORMADO|g" /app/frontend/.env
```

### Passo 3 — Build do frontend

```bash
cd /app/frontend && npm run build
```

### Passo 4 — Iniciar serviços

```bash
systemctl restart nginx
systemctl start suricathaia-api suricathaia-watchdog
systemctl enable suricathaia-api suricathaia-watchdog
```

### Passo 5 — Verificar

```bash
systemctl status suricathaia-api suricathaia-watchdog --no-pager
curl -s http://localhost:8000/health
```

---

## Serviços e comandos do dia-a-dia

| Ação | Comando |
|------|---------|
| Logs da API | `journalctl -u suricathaia-api -f` |
| Logs do watchdog | `journalctl -u suricathaia-watchdog -f` |
| Reiniciar API | `systemctl restart suricathaia-api` |
| Rebuild frontend | `cd /app/frontend && npm run build` |
| Pull + reiniciar | `cd /app && git pull && cd frontend && npm run build && cd .. && systemctl restart suricathaia-api suricathaia-watchdog` |

## Arquivos principais

| Arquivo | Responsabilidade |
|---------|-----------------|
| `/app/api.py` | Entrypoint FastAPI |
| `/app/routers/portaria.py` | Endpoints de portaria/visitas |
| `/app/routers/cameras.py` | Gestão de câmeras |
| `/app/routers/analytics.py` | Contagem de pessoas / EPI |
| `/app/services/database.py` | Pool de conexões PostgreSQL |
| `/app/services/watchdog_service.py` | Pipeline LPR principal |
| `/app/core/engine.py` | Motor de processamento OCR/YOLO |
| `/app/schema.sql` | Schema completo do banco |
| `/app/migrations/` | Migrations SQL adicionais |
| `/app/frontend/src/App.tsx` | Rotas e auth guard |
| `/app/frontend/src/api.ts` | Cliente HTTP centralizado |

## Convenções do projeto

- Auth: API key no localStorage `api_key`, roles: `admin` / `operador` / `viewer`
- Rota pública: `/pre-cadastro` (fora do auth guard em `App.tsx`)
- SSE: eventos `nova_leitura` disparam reload em `Deteccoes.tsx`
- Imagens de placas: servidas pelo Nginx em `/storage/` → `/opt/suricatha/storage/`
- Respostas da API sempre em português
