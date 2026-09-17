# Metodologia editorial

O filtro temático serve para reduzir o volume de leitura, não para calcular afinidade ou recomendar voto. Uma candidatura entra em “Nos meus temas” somente quando há ao menos uma afirmação publicada, classificada em um tema escolhido pela pessoa e ligada a uma fonte verificável.

## Tipos de conteúdo

- `track-record`: atuação ou histórico registrado por uma instituição. Autoria de uma proposição não significa aprovação, eficácia, voto favorável ou apoio integral.
- `position`: posição expressa pela candidatura em material público.
- `proposal`: compromisso ou medida que a candidatura declara pretender adotar se eleita.

Partido, profissão, religião, nome e silêncio não são usados para inferir posição política.

## Estados de revisão

- `pending`: somente rascunhos; nada aparece no site.
- `partial`: há conteúdo publicado, mas a pesquisa ou a revisão ainda não foi encerrada.
- `reviewed`: todos os claims do arquivo foram decididos; não pode haver rascunhos restantes.

Cada perfil pode publicar no máximo 30 claims. O objetivo é sintetizar o que ajuda a comparar, mantendo o link para a fonte original.

## Fontes

- `institutional-record`: registros de órgãos públicos, com domínio `.gov.br`, `.leg.br` ou `.jus.br`.
- `official-document`: documento oficial hospedado nesses mesmos domínios.
- `candidate-declared`: site, rede ou documento divulgado pela própria candidatura.
- `journalism`: reportagem identificada, usada com atribuição e sem transformar interpretação em fato.

Cada claim tem sua própria lista de fontes. Declarações de campanha aparecem como declarações da candidatura; registros institucionais aparecem como registros, sem misturar os dois tipos.

## Checklist antes de publicar

1. Confirmar que o `candidateId` corresponde à pessoa certa.
2. Abrir todas as fontes e conferir título, data, autoria e trecho relevante.
3. Escrever uma frase factual, curta e sem elogio, ataque ou conclusão sobre intenção.
4. Escolher um único tipo de claim e um tema compatível com o conteúdo da fonte.
5. Informar se a atribuição é institucional, declarada pela candidatura ou uma síntese explícita de fontes.
6. Marcar o claim como `published` somente depois dessa conferência.
7. Escrever o resumo por último, apoiado apenas nos claims e fontes publicados.
8. Verificar a cobertura do conjunto antes de usar o filtro como porta de entrada, para não favorecer apenas incumbentes ou campanhas com maior presença digital.

## Estrutura mínima

```json
{
  "candidateId": "250000000000",
  "review": {
    "status": "partial",
    "reviewedAt": "2026-09-17T12:00:00-03:00",
    "methodVersion": 1
  },
  "summary": {
    "text": "Síntese apoiada somente nas fontes abaixo.",
    "sourceRefs": ["fonte-1"]
  },
  "claims": [
    {
      "id": "proposta-saude-1",
      "kind": "proposal",
      "themeId": "saude",
      "text": "A candidatura declara que pretende ampliar uma política específica.",
      "attribution": "candidate-declared",
      "sourceRefs": ["fonte-1"],
      "publicationState": "published"
    }
  ],
  "sources": {
    "fonte-1": {
      "type": "candidate-declared",
      "publisher": "Nome da candidatura",
      "title": "Título do material",
      "url": "https://exemplo.invalid/material",
      "publishedAt": "2026-09-10",
      "checkedAt": "2026-09-17T12:00:00-03:00"
    }
  }
}
```

O domínio do exemplo é propositalmente inválido. Um arquivo real precisa usar a URL original consultada.
