#!/usr/bin/env bash
set -euo pipefail

# ── SuricathaIA — Publicar repositório no GitHub ─────────────────────────────
# Execute uma vez no VPS de origem para criar/atualizar o repo no GitHub.
# Uso: bash setup_github.sh

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
info() { echo -e "${CYAN}[→]${NC} $1"; }
die()  { echo -e "${RED}[ERRO]${NC} $1"; exit 1; }

APP_DIR=/app
cd "$APP_DIR"

# ── Verificar git ────────────────────────────────────────────────────────────
[[ -d .git ]] || die "Repositório git não encontrado em $APP_DIR. Execute primeiro: cd /app && git init && git add . && git commit -m 'init'"

# ── Verificar gh CLI ─────────────────────────────────────────────────────────
if ! command -v gh &>/dev/null; then
    info "Instalando GitHub CLI (gh)..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt-get update -qq && apt-get install -y -qq gh
fi

# ── Login no GitHub ──────────────────────────────────────────────────────────
if ! gh auth status &>/dev/null; then
    info "Faça login no GitHub:"
    gh auth login
fi

GH_USER=$(gh api user --jq '.login')
ok "Logado como: ${GH_USER}"

# ── Nome do repositório ──────────────────────────────────────────────────────
DEFAULT_REPO="suricathaia"
read -rp "Nome do repositório GitHub [${DEFAULT_REPO}]: " REPO_NAME
REPO_NAME="${REPO_NAME:-$DEFAULT_REPO}"

# ── Visibilidade ─────────────────────────────────────────────────────────────
read -rp "Visibilidade — [P]rivado ou [p]úblico? [P]: " VIS_INPUT
VIS_INPUT="${VIS_INPUT:-P}"
if [[ "${VIS_INPUT,,}" == "p" && "$VIS_INPUT" != "P" ]]; then
    VISIBILITY="public"
else
    VISIBILITY="private"
fi
info "Repositório será: ${VISIBILITY}"

# ── Criar ou usar repositório existente ──────────────────────────────────────
REMOTE_URL="https://github.com/${GH_USER}/${REPO_NAME}.git"

if gh repo view "${GH_USER}/${REPO_NAME}" &>/dev/null; then
    warn "Repositório ${GH_USER}/${REPO_NAME} já existe — usando o existente."
else
    info "Criando repositório ${GH_USER}/${REPO_NAME}..."
    gh repo create "${GH_USER}/${REPO_NAME}" \
        --"${VISIBILITY}" \
        --description "SuricathaIA — Sistema de segurança e controle de acesso" \
        --source=. \
        --remote=origin \
        --push
    ok "Repositório criado e código enviado!"
    echo ""
    info "URL do repositório: https://github.com/${GH_USER}/${REPO_NAME}"
    info "Para instalar em um novo VPS:"
    echo ""
    echo "  git clone https://github.com/${GH_USER}/${REPO_NAME}.git /app && sudo bash /app/install.sh"
    echo ""
    exit 0
fi

# ── Configurar remote e push ─────────────────────────────────────────────────
CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")

if [[ -z "$CURRENT_REMOTE" ]]; then
    git remote add origin "$REMOTE_URL"
elif [[ "$CURRENT_REMOTE" != "$REMOTE_URL" ]]; then
    warn "Remote atual: ${CURRENT_REMOTE}"
    read -rp "Substituir pelo novo remote? [s/N]: " CONFIRM
    [[ "${CONFIRM,,}" == "s" ]] && git remote set-url origin "$REMOTE_URL" || die "Abortado."
fi

git branch -M main
git push -u origin main

ok "Código enviado para GitHub!"
echo ""
info "URL do repositório: https://github.com/${GH_USER}/${REPO_NAME}"
info "Para instalar em um novo VPS:"
echo ""
echo "  git clone https://github.com/${GH_USER}/${REPO_NAME}.git /app && sudo bash /app/install.sh"
echo ""
