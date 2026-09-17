import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateThemeResults,
  createEditorialDraft,
  matchCandidatesToDeputies,
  normalizeBirthDate,
  normalizeIdentityName,
  parseArguments,
  parseSemicolonCsv,
  selectTseCandidates,
  THEME_MAPPING,
} from './gerar-rascunhos-camara.mjs';

test('normaliza nome e data sem fazer pareamento aproximado', () => {
  assert.equal(normalizeIdentityName("  João  D'Ávila-Neto "), 'JOAO D AVILA NETO');
  assert.equal(normalizeBirthDate('02/03/1980'), '1980-03-02');
  assert.equal(normalizeBirthDate('1980-03-02'), '1980-03-02');
  assert.equal(normalizeBirthDate('31/02/1980'), null);
  assert.notEqual(normalizeIdentityName('Maria Silva'), normalizeIdentityName('Maria da Silva'));
});

test('parser de CSV preserva ponto e vírgula e quebra de linha dentro de aspas', () => {
  const rows = parseSemicolonCsv('A;B\r\n1;"dois;\nlinhas"\r\n');
  assert.deepEqual(rows, [{ A: '1', B: 'dois;\nlinhas' }]);
});

test('seleciona somente deputado federal de SP inserido na urna', () => {
  const rows = [{
    ANO_ELEICAO: '2026', NR_TURNO: '1', SG_UF: 'SP', CD_CARGO: '6',
    SQ_CANDIDATO: '123', NM_CANDIDATO: 'JOÃO D ÁVILA', NM_URNA_CANDIDATO: 'João',
    DT_NASCIMENTO: '02/03/1980',
  }, {
    ANO_ELEICAO: '2026', NR_TURNO: '1', SG_UF: 'SP', CD_CARGO: '7',
    SQ_CANDIDATO: '456', NM_CANDIDATO: 'OUTRA PESSOA', NM_URNA_CANDIDATO: 'Outra',
    DT_NASCIMENTO: '02/03/1980',
  }];
  const selected = selectTseCandidates(rows, [
    { SQ_CANDIDATO: '123', ST_CANDIDATO_INSERIDO_URNA: 'SIM' },
    { SQ_CANDIDATO: '456', ST_CANDIDATO_INSERIDO_URNA: 'SIM' },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].candidateId, '123');
});

test('pareia somente relações 1:1 por nome civil e data', () => {
  const candidates = [{
    candidateId: '1', displayName: 'João', normalizedCivilName: 'JOAO SILVA', normalizedBirthDate: '1980-01-02',
  }, {
    candidateId: '2', displayName: 'Maria', normalizedCivilName: 'MARIA SOUZA', normalizedBirthDate: '1975-05-06',
  }, {
    candidateId: '3', displayName: 'Outra Maria', normalizedCivilName: 'MARIA SOUZA', normalizedBirthDate: '1975-05-06',
  }];
  const deputies = [{
    id: 10, nomeCivil: 'João Silva', dataNascimento: '1980-01-02', ultimoStatus: { nome: 'João' },
  }, {
    id: 20, nomeCivil: 'Maria Souza', dataNascimento: '1975-05-06', ultimoStatus: { nome: 'Maria' },
  }, {
    id: 30, nomeCivil: 'João Silva', dataNascimento: '1981-01-02', ultimoStatus: { nome: 'Outro João' },
  }];
  const result = matchCandidatesToDeputies(candidates, deputies);
  assert.deepEqual(result.matches, [{ candidateId: '1', displayName: 'João', chamberId: '10', chamberName: 'João' }]);
  assert.deepEqual(result.ambiguousCandidateIds, ['2', '3']);
  assert.deepEqual(result.ambiguousDeputyIds, ['20']);
});

test('gera apenas claims factuais e não publica o rascunho', () => {
  const proposition = {
    id: 999,
    siglaTipo: 'PL',
    numero: 42,
    ano: 2025,
    ementa: 'Cria uma medida pública de teste.',
    dataApresentacao: '2025-04-03T10:00',
  };
  const mapping = THEME_MAPPING.find(({ siteThemeId }) => siteThemeId === 'saude');
  const [aggregated] = aggregateThemeResults([{ mapping, items: [proposition] }]);
  const draft = createEditorialDraft(
    { candidateId: '123', chamberId: '456', chamberName: 'Pessoa Teste' },
    [{ proposition: aggregated, author: { proponente: 1 } }],
    '2026-09-17T12:00:00-03:00',
  );
  assert.equal(draft.review.status, 'pending');
  assert.equal(draft.claims[0].publicationState, 'draft');
  assert.equal(draft.claims[0].kind, 'track-record');
  assert.match(draft.claims[0].text, /registra Pessoa Teste como proponente/);
  assert.doesNotMatch(draft.claims[0].text, /defende|apoia|votou/i);
  assert.equal(draft.sources['camara-proposicao-999'].url, 'https://www.camara.leg.br/propostas-legislativas/999');
  assert.equal('locator' in draft.sources['camara-proposicao-999'], false);
  const serialized = JSON.stringify(draft);
  assert.doesNotMatch(serialized, /dataNascimento|birthDate|cpf/i);
});

test('argumentos exigem pasta nova e aceitam limite explícito', () => {
  const options = parseArguments([
    '--candidates', 'cand.csv', '--complement', 'comp.csv', '--output', 'saida',
    '--max-matches', '3', '--types', 'PL,PEC',
  ]);
  assert.equal(options.maxMatches, 3);
  assert.deepEqual(options.types, ['PL', 'PEC']);
  assert.throws(() => parseArguments(['--candidates', 'cand.csv']), /--complement/);
});
