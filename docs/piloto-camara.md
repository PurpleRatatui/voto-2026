# Piloto de conteúdo temático da Câmara

Este piloto cria rascunhos factuais para candidaturas de deputado federal por São Paulo que também sejam deputados federais em exercício. Ele combina os CSVs oficiais do TSE com a [API de Dados Abertos da Câmara](https://dadosabertos.camara.leg.br/swagger/api.html).

## O que o script faz

1. Seleciona, no arquivo do TSE, as candidaturas de 2026 a deputado federal por SP marcadas como inseridas na urna.
2. Consulta a relação atual de deputados de SP na Câmara.
3. Compara **nome civil e data de nascimento**. A correspondência só é aceita quando há exatamente uma candidatura e um deputado com a mesma chave normalizada.
4. Busca proposições de 2023 a 2026 por autor e pelas categorias temáticas oficiais da Câmara.
5. Confirma a presença do deputado no endpoint oficial de autores de cada proposição.
6. Gera um JSON por candidatura no schema editorial do projeto.

A data de nascimento existe apenas em memória durante o pareamento. Ela, CPF e outros identificadores pessoais não são escritos nos rascunhos nem no relatório.

## Estado editorial

O resultado é sempre um rascunho:

- `review.status` fica como `pending`;
- cada claim fica com `publicationState: "draft"`;
- não há resumo automático;
- o importador não leva esses claims para o site até que uma pessoa revise o texto, confira a fonte e mude explicitamente o estado de publicação.

Autoria também não é tratada como sinônimo de voto, aprovação, eficácia ou apoio integral. Quando o registro de autores marca a pessoa como proponente, o texto usa “como proponente”; nos demais casos, usa “entre os autores”.

## Mapeamento temático conservador

| Tema oficial da Câmara | Tema do site |
| --- | --- |
| Saúde | `saude` |
| Educação | `educacao` |
| Defesa e Segurança | `seguranca` |
| Trabalho e Emprego | `emprego-e-renda` |
| Meio Ambiente e Desenvolvimento Sustentável | `meio-ambiente` |
| Viação, Transporte e Mobilidade | `transporte` |
| Ciência, Tecnologia e Inovação | `tecnologia` |

`custo-de-vida`, `moradia` e `transparencia` ficam sem mapeamento automático. As categorias oficiais potencialmente relacionadas são mais amplas e poderiam classificar uma proposição no tema errado. Esse conteúdo precisa de revisão editorial individual.

## Como executar

Use uma pasta de saída que ainda não exista:

```sh
node scripts/gerar-rascunhos-camara.mjs \
  --candidates /caminho/consulta_cand_2026_SP.csv \
  --complement /caminho/consulta_cand_complementar_2026_SP.csv \
  --output /tmp/piloto-camara-2026 \
  --checked-at 2026-09-17T12:00:00-03:00 \
  --max-matches 5
```

Sem `--max-matches`, todos os pareamentos fortes são processados. `--types PL,PLP,PEC,PDL,PRC` limita os tipos; por padrão, entram todos os tipos de proposição retornados pela API. `--identity-only` mede apenas a cobertura de identidade, sem consultar proposições.

A saída contém:

- `drafts/*.json`: arquivos que podem ser entregues ao importador via `--editorial-dir` depois da revisão humana;
- `coverage.json`: métricas estruturadas;
- `COVERAGE.md`: leitura rápida da cobertura e das limitações.

## Revisão antes de publicar

Para cada claim, a pessoa revisora deve abrir a ficha oficial, conferir autoria, data, ementa e pertinência temática. Só então pode mudar `publicationState` para `published`, escrever um resumo estritamente apoiado nas fontes e alterar `review.status` para `partial` ou `reviewed`, conforme a cobertura alcançada.

Fontes oficiais: [Candidatos 2026 — TSE](https://dadosabertos.tse.jus.br/dataset/candidatos-2026) e [API da Câmara dos Deputados](https://dadosabertos.camara.leg.br/swagger/api.html).
