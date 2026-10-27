#!/usr/bin/env bash
# Prepara o ambiente do projeto: baixa o submódulo rea (com seus submódulos),
# instala o Node.js/npm exigidos pelo rea e instala/compila suas dependências.
# Idempotente: pode ser executado várias vezes; só refaz o que estiver faltando.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REA="$ROOT/rea"
NODE_HOME="${REA_NODE_HOME:-$HOME/.local/rea-node}"

log() { printf '[setup] %s\n' "$*" >&2; }

# 1. Submódulos (rea e os de rea/third_party)
log "atualizando submódulos"
GIT_LFS_SKIP_SMUDGE=1 git -C "$ROOT" submodule update --init --recursive --depth 1

# 2. Node.js na versão de rea/.nvmrc e npm na de package.json#packageManager
NODE_VERSION="$(tr -d '[:space:]v' < "$REA/.nvmrc")"
NPM_VERSION="$(node -p "require('$REA/package.json').packageManager.split('@')[1]" 2>/dev/null \
  || sed -n 's/.*"packageManager": *"npm@\([^"]*\)".*/\1/p' "$REA/package.json")"

if [ "$("$NODE_HOME/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) log "arquitetura não suportada: $(uname -m)"; exit 1 ;;
  esac
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) log "sistema não suportado: $(uname -s)"; exit 1 ;;
  esac
  DIST="node-v$NODE_VERSION-$OS-$ARCH"
  BASE="https://nodejs.org/dist/v$NODE_VERSION"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  log "instalando Node.js v$NODE_VERSION em $NODE_HOME"
  curl -fsSL "$BASE/$DIST.tar.xz" -o "$TMP/$DIST.tar.xz"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " $DIST.tar.xz\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  tar -xJf "$TMP/$DIST.tar.xz" -C "$TMP"
  rm -rf "$NODE_HOME"
  mkdir -p "$(dirname "$NODE_HOME")"
  mv "$TMP/$DIST" "$NODE_HOME"
fi
export PATH="$NODE_HOME/bin:$PATH"

if [ "$(npm -v)" != "$NPM_VERSION" ]; then
  log "instalando npm $NPM_VERSION"
  npm install -g "npm@$NPM_VERSION" --no-fund --no-audit >/dev/null
fi

# 3. Dependências e build do rea (só quando o lockfile ou o commit mudam)
STAMP="$REA/node_modules/.fig-setup-stamp"
WANT="$(git -C "$REA" rev-parse HEAD) $(sha256sum "$REA/package-lock.json" | cut -d' ' -f1) $NODE_VERSION"
if [ "$(cat "$STAMP" 2>/dev/null)" != "$WANT" ]; then
  log "instalando dependências do rea (npm ci)"
  (cd "$REA" && npm ci --no-fund --no-audit)
  log "compilando o rea (npm run build:cached)"
  (cd "$REA" && npm run build:cached)
  echo "$WANT" > "$STAMP"
fi

# Disponibiliza o Node correto para os comandos seguintes da sessão do Claude Code
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_HOME/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

log "pronto: node $(node -v), npm $(npm -v)"
