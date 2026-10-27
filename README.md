# Fig

## Dependências

- [`rea/`](rea) — [morluto/rea](https://github.com/morluto/rea) (REA: Reverse Engineer Anything), incluído como submódulo git.

Após clonar este repositório, baixe o submódulo com:

```bash
git submodule update --init --depth 1 rea
```

Para atualizar o `rea` para a versão mais recente:

```bash
git submodule update --remote --depth 1 rea
git add rea && git commit -m "Atualiza rea"
```
