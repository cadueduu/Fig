# Fig

## Dependências

- [`rea/`](rea) — [morluto/rea](https://github.com/morluto/rea) (REA: Reverse Engineer Anything), incluído como submódulo git.
  Ele tem seus próprios submódulos em `rea/third_party/` (binwalk, unblob, wakaru, ghidra-nativeaot, jadx-headless-mcp).

## Configuração

Após clonar este repositório:

```bash
scripts/setup.sh
```

O script é idempotente e:

1. baixa `rea` e todos os seus submódulos (`git submodule update --init --recursive --depth 1`);
2. instala o Node.js de `rea/.nvmrc` em `~/.local/rea-node` (com verificação de SHA-256) e o npm de `rea/package.json#packageManager`;
3. roda `npm ci` e `npm run build:cached` dentro de `rea/` (só quando o commit ou o lockfile mudam).

Para usar o Node correto no terminal: `export PATH="$HOME/.local/rea-node/bin:$PATH"`.

Só os submódulos:

```bash
git submodule update --init --recursive --depth 1
```

Nas sessões do Claude Code, o hook `SessionStart` em `.claude/settings.json` baixa os submódulos automaticamente.

## Atualizar o rea

```bash
git submodule update --remote --depth 1 rea
git submodule update --init --recursive --depth 1
git add rea && git commit -m "Atualiza rea"
```

## Figurinhas para WhatsApp

`scripts/figurinhas.py` converte pacotes `.wastickers`, imagens (png, jpg, webp, gif) e vídeos (mp4, webm, mov)
em figurinhas válidas para o WhatsApp: 512×512 WebP com fundo transparente, estáticas até 100 KB,
animadas até 500 KB e 10 s. Também gera um novo `.wastickers` com ícone 96×96.

```bash
python3 scripts/figurinhas.py pacote.wastickers outra-imagem.gif video.mp4 -o figurinhas/meu-pacote --titulo "Meu pacote"
```

O WhatsApp só importa pacotes com 3 a 30 figurinhas. A pasta `figurinhas/` fica fora do git.
