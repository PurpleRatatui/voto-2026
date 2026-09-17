# Relatório do piloto Câmara — 17 de setembro de 2026

O piloto é viável como uma **fonte parcial de histórico parlamentar**, mas não cobre sozinho o universo de candidaturas. A execução usou os CSVs do TSE gerados em 17 de setembro de 2026 e a [API oficial da Câmara dos Deputados](https://dadosabertos.camara.leg.br/swagger/api.html).

## Cobertura de identidade

| Medida | Resultado |
| --- | ---: |
| Candidaturas a deputado federal por SP inseridas na urna | 1.071 |
| Deputados de SP em exercício retornados pela Câmara | 70 |
| Pareamentos 1:1 por nome civil + data de nascimento | 59 |
| Chaves ambíguas | 0 |

Os 59 pareamentos representam 84,3% dos deputados de SP em exercício e 5,5% das 1.071 candidaturas. Os 11 deputados sem pareamento forte ficaram de fora automaticamente; o script não tenta adivinhar se a causa é ausência de candidatura, divergência cadastral ou outra situação.

Isso também mostra o limite da fonte: para mais de 94% das candidaturas, a Câmara atual não fornece histórico de mandato como deputado federal. A ausência de registro nesse piloto não pode ser apresentada como ausência de experiência, propostas ou atuação pública.

## Amostra de conteúdo

Para validar o caminho completo sem publicar nada, foi processado o primeiro pareamento na ordem estável de `candidateId`, limitado aos tipos `PL`, `PLP`, `PEC`, `PDL` e `PRC`, entre 2023 e 2026.

| Medida | Resultado |
| --- | ---: |
| Candidaturas processadas na amostra | 1 |
| Proposições únicas com autoria reconfirmada | 98 |
| Claims temáticos em rascunho | 110 |
| Divergências entre filtro de autor e lista de autores | 0 |

Uma proposição pode receber mais de um tema oficial da Câmara, por isso o número de claims pode superar o de proposições. A amostra também evidencia que publicar uma lista integral seria excessivo para o celular: os registros devem servir de base para revisão e síntese editorial, mantendo acesso à fonte de cada afirmação.

## Distribuição da amostra

| Tema do site | Claims em rascunho |
| --- | ---: |
| Saúde | 23 |
| Educação | 18 |
| Segurança | 18 |
| Emprego e renda | 24 |
| Meio ambiente | 18 |
| Transporte | 5 |
| Tecnologia | 4 |

`custo-de-vida`, `moradia` e `transparencia` não foram mapeados automaticamente. As categorias da Câmara potencialmente relacionadas são amplas demais para uma conversão segura sem leitura humana.

## Conclusão

O pareamento forte e a reconfirmação de autoria funcionaram sem ambiguidades na base atual. A integração é adequada para preencher a seção “Atuação e histórico registrados” de candidaturas que têm mandato na Câmara, desde que:

1. todos os arquivos permaneçam como `pending`/`draft` até revisão humana;
2. autoria seja descrita como registro institucional, sem inferir voto, apoio, prioridade ou eficácia;
3. o perfil final sintetize os registros em vez de despejar dezenas de proposições;
4. candidaturas sem mandato sejam pesquisadas em outras fontes oficiais e em declarações da própria candidatura, com o mesmo padrão de fonte e revisão.

Nenhuma data de nascimento, CPF ou outro identificador pessoal usado na desambiguação foi escrito nos relatórios ou rascunhos. Nenhum claim foi marcado como publicado.

Fontes: [Candidatos 2026 — TSE](https://dadosabertos.tse.jus.br/dataset/candidatos-2026) e [Dados Abertos da Câmara dos Deputados](https://dadosabertos.camara.leg.br/swagger/api.html).
