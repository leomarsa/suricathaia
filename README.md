<div align="center">

# SuricathaIA

### Plataforma Inteligente de Segurança LPR

**Monitoramento 24/7 · Missão Crítica**

*LPR, EPI e contagem de pessoas convergindo em uma arquitetura de borda robusta, autossuficiente e de alta disponibilidade.*

---

![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.136-009688?style=flat-square&logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=flat-square&logo=postgresql&logoColor=white)
![YOLOv8](https://img.shields.io/badge/YOLOv8-Ultralytics-00DBDE?style=flat-square)
![License](https://img.shields.io/badge/Licença-Proprietária-red?style=flat-square)

</div>

---

## Visão Geral

O **SuricathaIA** é uma plataforma de segurança perimetral baseada em inteligência artificial, projetada para ambientes de missão crítica. Toda a computação é realizada na borda (*edge computing*), sem dependência de nuvem, garantindo latência mínima e operação contínua mesmo sem conectividade externa.

---

## Funcionalidades

| Módulo | Descrição |
|--------|-----------|
| **LPR — Reconhecimento de Placas** | OCR double-check com confiabilidade acima de 98% em qualquer condição de iluminação |
| **Portaria / Controle de Acesso** | Cadastro de visitantes com wizard, QR Code, listas de autorização e bloqueio |
| **Detecção de EPI / PPE** | IA embarcada para verificação de capacete e colete em áreas de risco |
| **Contagem de Pessoas** | Monitoramento de fluxo, detecção de lotação e gestão de perímetros críticos |
| **Alertas em Tempo Real** | Notificações via Telegram e WhatsApp com resposta em milissegundos |
| **Telemetria de Câmeras** | Monitoramento RTSP/RTMP com snapshots automáticos e vídeo ao vivo |
| **CCTV / Alarme** | Integração com centrais de alarme e câmeras IP |
| **Relatórios** | Geração automática de relatórios diários com envio agendado |

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                     Câmeras / DVRs                       │
│           (RTSP · RTMP · SFTP · API Intelbras)          │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                  SuricathaIA Edge                        │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  LPR Engine  │  │  YOLO Analytics│  │  Watchdog     │  │
│  │  PaddleOCR   │  │  Pessoas/EPI  │  │  Pipeline     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │
│         └────────────────┬┘                 │           │
│                    ┌─────▼──────┐           │           │
│                    │ PostgreSQL │◄──────────┘           │
│                    └─────┬──────┘                       │
│                    ┌─────▼──────┐                       │
│                    │  FastAPI   │                       │
│                    └─────┬──────┘                       │
└──────────────────────────┼──────────────────────────────┘
                           │
              ┌────────────▼───────────┐
              │   React + Vite (SPA)   │
              │   Nginx · Porta 80     │
              └────────────────────────┘
```

---

## Stack Técnico

**Backend**
- Python 3.12 + FastAPI
- PostgreSQL 16 com psycopg2
- PaddleOCR (OCR double-check de placas)
- YOLOv8 (detecção de pessoas e EPI)
- Filas assíncronas com workers dedicados

**Frontend**
- React 19 + TypeScript + Vite
- UI própria dark-themed (sem framework CSS)
- SSE para atualizações em tempo real

**Infraestrutura**
- Nginx (proxy reverso + static files)
- systemd (gerenciamento de serviços)
- RTMP/RTSP para streams de câmeras

---

## Instalação Rápida

> **Requisitos:** Ubuntu 22.04 / 24.04 · root · 2 vCPU · 4 GB RAM

```bash
git clone https://github.com/leomarsa/suricathaia.git /app
sudo bash /app/install.sh
```

O script instala e configura automaticamente todas as dependências, banco de dados, serviços e frontend.

Após a instalação, siga as instruções exibidas no terminal ou use o **Claude Code** para finalizar a configuração:

```bash
npm install -g @anthropic-ai/claude-code
cd /app && claude
```

> O `CLAUDE.md` deste repositório contém o procedimento completo de pós-instalação para guiar o Claude Code automaticamente.

---

## Configuração

Copie e edite o arquivo de variáveis de ambiente:

```bash
cp .env.example .env
nano .env
```

Campos obrigatórios:

| Variável | Como gerar |
|----------|-----------|
| `JWT_SECRET` | `openssl rand -hex 32` |
| `API_KEYS` | `openssl rand -hex 24` |
| `RTMP_HOST` | IP ou domínio do servidor |
| `POSTGRES_DSN` | Confirmar senha do banco |

---

## Estrutura do Projeto

```
/app
├── api.py                  # Entrypoint FastAPI
├── schema.sql              # Schema PostgreSQL
├── migrations/             # Migrations incrementais
├── routers/                # Endpoints REST
│   ├── portaria.py
│   ├── cameras.py
│   ├── analytics.py
│   └── telemetria.py
├── services/               # Lógica de negócio e workers
│   ├── watchdog_service.py
│   ├── database.py
│   ├── alerts.py
│   └── ...
├── core/                   # Motor de IA
│   ├── engine.py
│   └── analytics/
├── frontend/               # React + Vite
│   └── src/
│       ├── pages/
│       └── components/
├── deploy/                 # Configs de infraestrutura
│   ├── nginx-suricatha.conf
│   ├── suricathaia-api.service
│   └── suricathaia-watchdog.service
├── install.sh              # Instalação automatizada
└── setup_github.sh         # Publicação no GitHub
```

---

## Comandos Úteis

```bash
# Logs em tempo real
journalctl -u suricathaia-api -f
journalctl -u suricathaia-watchdog -f

# Reiniciar serviços
systemctl restart suricathaia-api suricathaia-watchdog

# Rebuild do frontend
cd /app/frontend && npm run build

# Atualizar de uma nova versão
cd /app && git pull && cd frontend && npm run build && cd ..
systemctl restart suricathaia-api suricathaia-watchdog
```

---

<div align="center">

**Desenvolvido por [Vission](https://vission.com.br)**

(65) 4042-0466 · vission.com.br

*SuricathaIA © 2025 · Todos os direitos reservados*

</div>
