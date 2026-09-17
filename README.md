# Voto 2026 — site estático

Esta pasta é publicada inteira pelo GitHub Pages. O arquivo de entrada é `index.html` e o site não exige servidor, conta de usuário ou banco de dados.

## Cobertura atual

- Presidência: base nacional.
- São Paulo: Governo do estado, Senado, Câmara dos Deputados e Assembleia Legislativa.
- As listas públicas incluem somente registros marcados pelo TSE como inseridos na urna.
- Os perfis trazem somente endereços de redes declarados ao TSE que passaram por validação conservadora de URL.
- Os planos de governo oficiais de Presidência e Governo de São Paulo ficam disponíveis em PDF quando constam no pacote do TSE.
- Partido, número e situação não aparecem na descoberta; são mostrados apenas quando a pessoa pede para ver os dados eleitorais no perfil.
- Prioridades, salvos e pulados ficam somente no navegador da pessoa.

Propostas e redes sociais só devem ser publicadas quando houver uma fonte oficial verificável. A ausência de conteúdo indexado nunca deve ser tratada como ausência de proposta ou posição política.

## Como os dados funcionam

- `data/current.json` aponta para a versão pública mais recente.
- Cada pasta em `data/releases/` é uma versão imutável, identificada por data e hora.
- Cada estado e cargo tem um catálogo separado, para o celular baixar apenas a lista escolhida.
- Cada perfil é carregado somente quando a pessoa o abre.
- As fotos oficiais são copiadas para a própria release; o site não busca imagens diretamente no TSE.

## Gerar uma nova release

Use os arquivos nacionais e estaduais de candidaturas, os respectivos arquivos complementares e a pasta oficial de fotos já extraída:

```sh
node scripts/preparar-candidatos-tse-2026.mjs \
  --release 2026-09-17T1200-0300 \
  --input /caminho/consulta_cand_2026_BR.csv \
  --input /caminho/consulta_cand_2026_SP.csv \
  --complement /caminho/consulta_cand_complementar_2026_BR.csv \
  --complement /caminho/consulta_cand_complementar_2026_SP.csv \
  --social /caminho/rede_social_candidato_2026_BR.csv \
  --social /caminho/rede_social_candidato_2026_SP.csv \
  --proposals-dir /caminho/propostas/BR \
  --proposals-dir /caminho/propostas/SP \
  --photos-dir /caminho/fotos-oficiais \
  --generated-at 2026-09-17T12:00:00-03:00
```

O importador não altera `data/current.json` nem substitui uma release existente.

Valide a saída antes de publicá-la:

```sh
node scripts/validar-release.mjs 2026-09-17T1200-0300
```

## Regras de publicação

1. Baixe e valide os arquivos oficiais do TSE.
2. Gere uma pasta de release nova e completa.
3. Confira contagens, privacidade dos cartões, fotos, links e situação das candidaturas.
4. Atualize `data/current.json` somente depois da validação.
5. Publique a pasta inteira.

Assim, ninguém recebe cartões de uma versão e perfis de outra. Como os registros eleitorais podem mudar, cada atualização deve preservar a data da consulta e gerar uma nova release.

## Fontes

- [Candidatos 2026 — Dados Abertos do TSE](https://dadosabertos.tse.jus.br/dataset/candidatos-2026)
- [DivulgaCandContas](https://divulgacandcontas.tse.jus.br/divulga/)
