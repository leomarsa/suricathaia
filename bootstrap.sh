#!/usr/bin/env bash
set -euo pipefail

# ── SuricathaIA — Bootstrap ──────────────────────────────────────────────────
# Uso em servidor limpo (Ubuntu 22.04 / 24.04):
#
#   GH_TOKEN=seu_token bash <(curl -fsSL -H "Authorization: token seu_token" \
#     https://raw.githubusercontent.com/leomarsa/suricathaia/master/bootstrap.sh)
#
# Gere seu token em: https://github.com/settings/tokens (escopo: repo)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${CYAN}[→]${NC} $1"; }
die()  { echo -e "${RED}[ERRO]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && die "Execute como root"
[[ -z "${GH_TOKEN:-}" ]] && die "GH_TOKEN não definido. Use: GH_TOKEN=seu_token bash <(curl ...)"

SERVER_IP=$(hostname -I | awk '{print $1}')
REPO="https://${GH_TOKEN}@github.com/leomarsa/suricathaia.git"
APP_DIR=/app

clear
echo -e "${CYAN}"
echo "  ███████╗██╗   ██╗██████╗ ██╗ ██████╗ █████╗ ████████╗██╗  ██╗ █████╗ "
echo "  ██╔════╝██║   ██║██╔══██╗██║██╔════╝██╔══██╗╚══██╔══╝██║  ██║██╔══██╗"
echo "  ███████╗██║   ██║██████╔╝██║██║     ███████║   ██║   ███████║███████║"
echo "  ╚════██║██║   ██║██╔══██╗██║██║     ██╔══██║   ██║   ██╔══██║██╔══██║"
echo "  ███████║╚██████╔╝██║  ██║██║╚██████╗██║  ██║   ██║   ██║  ██║██║  ██║"
echo "  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝"
echo -e "${NC}"
echo -e "  ${YELLOW}Plataforma Inteligente de Segurança LPR${NC}"
echo -e "  ${CYAN}Bootstrap — instalação do zero${NC}"
echo ""
echo -e "  Servidor: ${SERVER_IP}"
echo ""

# ── 1. Git ───────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
    info "Instalando git..."
    apt-get update -qq && apt-get install -y -qq git
fi
ok "git $(git --version | awk '{print $3}')"

# ── 2. Clonar repositório ────────────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
    info "Repositório já existe — atualizando..."
    git -C "$APP_DIR" pull --quiet
else
    info "Clonando repositório..."
    git clone --quiet "$REPO" "$APP_DIR"
fi
ok "Código em $APP_DIR"

# ── 3. Node.js (necessário para Claude Code) ─────────────────────────────────
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    info "Instalando Node.js 20..."
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs
fi
ok "Node $(node -v)"

# ── 4. Claude Code ───────────────────────────────────────────────────────────
if ! command -v claude &>/dev/null; then
    info "Instalando Claude Code..."
    npm install -g @anthropic-ai/claude-code --quiet
fi
ok "Claude Code $(claude --version 2>/dev/null || echo 'instalado')"

# ── 5. Instruções finais ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Bootstrap concluído — pronto para instalar!        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Próximo passo — abrir o Claude Code e pedir a instalação:${NC}"
echo ""
echo -e "  ${YELLOW}cd /app && claude${NC}"
echo ""
echo -e "  ${CYAN}Depois cole este prompt:${NC}"
echo ""
echo -e "  ${GREEN}\"Instale e configure o SuricathaIA completo neste servidor."
echo -e "   IP do servidor: ${SERVER_IP}"
echo -e "   Siga o procedimento do CLAUDE.md e entregue o sistema"
echo -e "   pronto para acessar no navegador.\"${NC}"
echo ""
echo -e "  ${YELLOW}Abrindo Claude Code em 5 segundos...${NC}"
echo -e "  ${YELLOW}(Ctrl+C para cancelar)${NC}"
echo ""

sleep 5
cd "$APP_DIR" && claude
