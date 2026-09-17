# Voto 2026 — site estático

Esta pasta é publicada inteira. O arquivo de entrada é `index.html`.

## Como os dados funcionam

- `data/current.json` aponta para a versão pública mais recente.
- Cada pasta em `data/releases/` é uma versão imutável, com data e hora.
- O catálogo de um cargo traz somente dados leves para a descoberta.
- Cada perfil é carregado quando a pessoa abre a candidatura.
- Imagens oficiais ficam em `assets/fotos/` e devem ser arquivos locais, não imagens carregadas diretamente do TSE.

## Regras de publicação

1. Baixe e valide os arquivos oficiais do TSE.
2. Gere uma nova pasta de release completa, incluindo fontes e fotos processadas.
3. Confira os arquivos da nova release.
4. Atualize `data/current.json` somente depois que toda a nova release estiver no ar.

Assim, ninguém recebe cartões de uma versão e perfis de outra.

## Fontes

- [Candidatos 2026 — Dados Abertos do TSE](https://dadosabertos.tse.jus.br/dataset/candidatos-2026)
- [DivulgaCandContas](https://divulgacandcontas.tse.jus.br/divulga/)
