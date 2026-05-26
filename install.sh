#!/usr/bin/env bash
set -euo pipefail

# ── SuricathaIA — Script de instalação ──────────────────────────────────────
# Ubuntu 22.04 / 24.04  |  Python 3.12  |  Node 20  |  PostgreSQL 16
# Uso:  sudo bash install.sh

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
die()  { echo -e "${RED}[ERRO]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && die "Execute como root: sudo bash install.sh"

APP_DIR=/app
VENV=/opt/suricatha/.venv
DB_USER=suricatha
DB_PASS=suricatha_secure_2024
DB_NAME=suricatha_db

# ── 1. Dependências do sistema ───────────────────────────────────────────────
ok "Atualizando pacotes..."
apt-get update -qq

ok "Instalando dependências do sistema..."
apt-get install -y -qq \
    python3.12 python3.12-venv python3.12-dev python3-pip \
    build-essential libpq-dev libssl-dev libffi-dev \
    postgresql postgresql-client \
    nginx \
    curl git unzip ffmpeg \
    libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1

# Node 20
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    ok "Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - -qq
    apt-get install -y -qq nodejs
fi
ok "Node $(node -v) / npm $(npm -v)"

# ── 2. Diretórios ────────────────────────────────────────────────────────────
ok "Criando diretórios..."
mkdir -p /opt/suricatha/{storage,logs,models,reports}
mkdir -p /home/camera_lpr/uploads
chmod 755 /home/camera_lpr/uploads

# ── 3. PostgreSQL ────────────────────────────────────────────────────────────
ok "Configurando PostgreSQL..."
systemctl enable postgresql --quiet
systemctl start postgresql

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
    ok "Usuário PostgreSQL criado"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
    ok "Banco de dados criado"
fi

ok "Aplicando schema..."
sudo -u postgres psql "${DB_NAME}" < "${APP_DIR}/schema.sql"

ok "Aplicando migrations..."
for f in "${APP_DIR}/migrations/"*.sql; do
    [[ -f "$f" ]] || continue
    sudo -u postgres psql "${DB_NAME}" < "$f" && ok "Migration: $(basename $f)"
done

# ── 4. Ambiente Python ───────────────────────────────────────────────────────
ok "Criando virtualenv em ${VENV}..."
python3.12 -m venv "${VENV}"

ok "Instalando dependências Python (pode demorar alguns minutos)..."
"${VENV}/bin/pip" install --upgrade pip setuptools wheel -q
"${VENV}/bin/pip" install -r "${APP_DIR}/requirements.txt" -q

# ── 5. Modelos YOLO ──────────────────────────────────────────────────────────
YOLO_DST=/opt/suricatha/models/yolov8n.pt
if [[ ! -f "$YOLO_DST" ]]; then
    ok "Baixando modelo YOLOv8n..."
    curl -fsSL -o "$YOLO_DST" \
        "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt"
fi

# ── 6. Variáveis de ambiente ─────────────────────────────────────────────────
if [[ ! -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    warn "Arquivo .env criado a partir do exemplo."
    warn "EDITE ${APP_DIR}/.env antes de iniciar os serviços!"
    warn "  -> JWT_SECRET, API_KEYS, RTMP_HOST, notificações, etc."
else
    ok ".env já existe, mantendo configurações atuais"
fi

# ── 7. Frontend ──────────────────────────────────────────────────────────────
ok "Configurando frontend..."
cd "${APP_DIR}/frontend"

if [[ ! -f ".env" ]]; then
    cp ".env.example" ".env"
    warn "Edite frontend/.env e configure VITE_API_URL com o IP/domínio do servidor"
    read -rp "IP ou domínio do servidor (ex: 192.168.1.100): " SERVER_ADDR
    if [[ -n "$SERVER_ADDR" ]]; then
        sed -i "s|http://SEU_IP_OU_DOMINIO|http://${SERVER_ADDR}|g" .env
        sed -i "s|SEU_IP_OU_DOMINIO|${SERVER_ADDR}|g" .env
        sed -i "s|SEU_IP_OU_DOMINIO|${SERVER_ADDR}|g" "${APP_DIR}/.env"
    fi
fi

ok "Instalando dependências npm..."
npm install --quiet

ok "Build do frontend..."
npm run build

cd "${APP_DIR}"

# ── 8. Nginx ─────────────────────────────────────────────────────────────────
ok "Configurando Nginx..."
cp "${APP_DIR}/deploy/nginx-suricatha.conf" /etc/nginx/sites-available/suricatha
ln -sf /etc/nginx/sites-available/suricatha /etc/nginx/sites-enabled/suricatha
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable nginx --quiet && systemctl restart nginx
ok "Nginx configurado"

# ── 9. Serviços systemd ──────────────────────────────────────────────────────
ok "Instalando serviços systemd..."
cp "${APP_DIR}/deploy/suricathaia-api.service"      /etc/systemd/system/
cp "${APP_DIR}/deploy/suricathaia-watchdog.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable suricathaia-api suricathaia-watchdog --quiet

# ── 10. Iniciar ──────────────────────────────────────────────────────────────
if grep -q "TROQUE_POR" "${APP_DIR}/.env"; then
    warn "Detectadas chaves padrão no .env — serviços NÃO iniciados."
    warn "Configure ${APP_DIR}/.env e execute:"
    echo ""
    echo "  systemctl start suricathaia-api suricathaia-watchdog"
    echo ""
else
    ok "Iniciando serviços..."
    systemctl start suricathaia-api suricathaia-watchdog
    systemctl status suricathaia-api --no-pager -l || true
fi

SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         SuricathaIA — Instalação concluída!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}  Acesse:${NC}  http://${SERVER_IP}"
echo ""
echo -e "${YELLOW}┌─ Próximos passos ────────────────────────────────────────────┐${NC}"
echo -e "${YELLOW}│${NC}"
echo -e "${YELLOW}│${NC}  1. Configure as variáveis de ambiente:"
echo -e "${YELLOW}│${NC}     ${CYAN}nano /app/.env${NC}"
echo -e "${YELLOW}│${NC}     Campos obrigatórios:"
echo -e "${YELLOW}│${NC}       JWT_SECRET  →  openssl rand -hex 32"
echo -e "${YELLOW}│${NC}       API_KEYS    →  openssl rand -hex 24"
echo -e "${YELLOW}│${NC}       RTMP_HOST   →  ${SERVER_IP}"
echo -e "${YELLOW}│${NC}"
echo -e "${YELLOW}│${NC}  2. Ajuste o IP no frontend e reconstrua:"
echo -e "${YELLOW}│${NC}     ${CYAN}nano /app/frontend/.env${NC}"
echo -e "${YELLOW}│${NC}     VITE_API_URL=http://${SERVER_IP}"
echo -e "${YELLOW}│${NC}     ${CYAN}cd /app/frontend && npm run build${NC}"
echo -e "${YELLOW}│${NC}"
echo -e "${YELLOW}│${NC}  3. Inicie os serviços:"
echo -e "${YELLOW}│${NC}     ${CYAN}systemctl start suricathaia-api suricathaia-watchdog${NC}"
echo -e "${YELLOW}│${NC}"
echo -e "${YELLOW}└──────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "${CYAN}┌─ Usando Claude Code para finalizar a configuração ───────────┐${NC}"
echo -e "${CYAN}│${NC}"
echo -e "${CYAN}│${NC}  Instale: ${CYAN}npm install -g @anthropic-ai/claude-code${NC}"
echo -e "${CYAN}│${NC}  Execute: ${CYAN}cd /app && claude${NC}"
echo -e "${CYAN}│${NC}"
echo -e "${CYAN}│${NC}  Prompt sugerido:"
echo -e "${CYAN}│${NC}"
echo -e "${CYAN}│  \"${NC}Acabei de instalar o SuricathaIA neste servidor."
echo -e "${CYAN}│   ${NC}IP do servidor: ${SERVER_IP}"
echo -e "${CYAN}│   ${NC}Configure o .env com JWT_SECRET e API_KEYS seguros,"
echo -e "${CYAN}│   ${NC}ajuste o frontend/.env com o IP correto, reconstrua"
echo -e "${CYAN}│   ${NC}o frontend e inicie os serviços. Siga o procedimento"
echo -e "${CYAN}│   ${NC}de instalação do projeto SuricathaIA salvo na memória."
echo -e "${CYAN}│  \"${NC}"
echo -e "${CYAN}│${NC}"
echo -e "${CYAN}└──────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "${GREEN}  Logs em tempo real:${NC}"
echo -e "    journalctl -u suricathaia-api -f"
echo -e "    journalctl -u suricathaia-watchdog -f"
echo ""
