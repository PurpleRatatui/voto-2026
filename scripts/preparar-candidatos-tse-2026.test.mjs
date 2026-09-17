#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArguments, parseTseCsv, prepareRelease } from './preparar-candidatos-tse-2026.mjs';
import { validateRelease } from './validar-release.mjs';

const HEADER = [
  'DT_GERACAO', 'HH_GERACAO', 'ANO_ELEICAO', 'NR_TURNO', 'CD_ELEICAO',
  'SG_UF', 'SG_UE', 'CD_CARGO', 'SQ_CANDIDATO', 'NM_CANDIDATO',
  'NM_URNA_CANDIDATO', 'NR_CANDIDATO', 'SG_PARTIDO',
  'DS_SITUACAO_CANDIDATURA', 'DS_OCUPACAO', 'DS_GRAU_INSTRUCAO',
  'OBSERVACAO_TESTE',
].join(';');
const COMPLEMENT_HEADER = [
  'SQ_CANDIDATO', 'ST_CANDIDATO_INSERIDO_URNA', 'DS_SITUACAO_JULGAMENTO',
  'NR_IDADE_DATA_POSSE',
].join(';');
const SOCIAL_HEADER = [
  'SQ_CANDIDATO', 'NR_ORDEM_REDE_SOCIAL', 'DS_URL',
].join(';');

function csvRow(values) {
  return values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';');
}

function containsForbiddenCardField(value) {
  const forbidden = new Set(['party', 'partido', 'number', 'numero', 'status', 'electionData', 'networks']);
  if (!value || typeof value !== 'object') return false;
  if (Object.keys(value).some((key) => forbidden.has(key))) return true;
  return Object.values(value).some(containsForbiddenCardField);
}

const workspace = await mkdtemp(join(tmpdir(), 'voto-2026-import-test-'));
try {
  const inputDir = join(workspace, 'entrada');
  const outputDir = join(workspace, 'site', 'data', 'releases');
  const photosDir = join(workspace, 'fotos');
  const proposalsDir = join(workspace, 'propostas');
  const editorialDir = join(workspace, 'editorial');
  await Promise.all([
    mkdir(inputDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
    mkdir(photosDir, { recursive: true }),
    mkdir(proposalsDir, { recursive: true }),
    mkdir(editorialDir, { recursive: true }),
  ]);

  const rows = [
    HEADER,
    csvRow(['17/09/2026', '10:00:00', '2026', '1', '999', 'SP', 'SP', '3', '1001', 'JOÃO DA SILVA', 'JOÃO DA SILVA', '40', 'PSB', 'APTO', 'PROFESSOR DE ENSINO SUPERIOR', 'SUPERIOR COMPLETO', 'texto; com separador']),
    csvRow(['17/09/2026', '10:00:00', '2026', '1', '999', 'SP', 'SP', '6', '1002', 'MARIA D\'ÁVILA', 'MARIA D\'ÁVILA', '4010', 'PSB', 'APTO', 'ADVOGADO', '#NULO#', 'linha 1\nlinha "2"']),
    csvRow(['17/09/2026', '10:00:00', '2026', '2', '999', 'SP', 'SP', '3', '1003', 'SEGUNDO TURNO', 'SEGUNDO TURNO', '40', 'PSB', 'APTO', 'OUTROS', 'ENSINO MÉDIO COMPLETO', 'ignorar']),
    csvRow(['17/09/2026', '10:00:00', '2026', '1', '999', 'SP', 'SP', '2', '1004', 'VICE TESTE', 'VICE TESTE', '40', 'PSB', 'APTO', 'OUTROS', 'ENSINO MÉDIO COMPLETO', 'ignorar']),
    csvRow(['17/09/2026', '10:00:00', '2026', '1', '999', 'SP', 'SP', '5', '1005', 'FORA DA URNA', 'FORA DA URNA', '400', 'PSB', 'APTO', '#NULO#', '#NE#', 'excluir pelo complementar']),
  ].join('\r\n');
  const complementRows = [
    COMPLEMENT_HEADER,
    csvRow(['1001', 'SIM', 'DEFERIDO', '45']),
    csvRow(['1002', 'SIM', 'INDEFERIDO COM RECURSO', '#NULO#']),
    csvRow(['1005', 'NÃO', 'DEFERIDO', '#NULO#']),
  ].join('\r\n');
  const socialRows = [
    SOCIAL_HEADER,
    csvRow(['1001', '3', 'HTTPS://WWW.INSTAGRAM.COM/joao']),
    csvRow(['1001', '1', 'https://x.com/joao']),
    csvRow(['1001', '2', 'javascript:alert(1)']),
    csvRow(['1001', '4', 'https://www.instagram.com/joao']),
    csvRow(['1001', '5', 'https://usuario:segredo@example.com/perfil']),
  ].join('\r\n');
  const inputPath = join(inputDir, 'consulta_cand_2026_SP.csv');
  const complementPath = join(inputDir, 'consulta_cand_complementar_2026_SP.csv');
  const socialPath = join(inputDir, 'rede_social_candidato_2026_SP.csv');
  await writeFile(inputPath, Buffer.from(rows, 'latin1'));
  await writeFile(complementPath, Buffer.from(complementRows, 'latin1'));
  await writeFile(socialPath, Buffer.from(socialRows, 'latin1'));
  await writeFile(join(photosDir, 'FSP1001_div.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const minimalPdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  await writeFile(join(proposalsDir, '2026SP1001_01.pdf'), minimalPdf);
  await writeFile(join(proposalsDir, '2026SP1002_01.pdf'), Buffer.alloc(0));
  await writeFile(join(editorialDir, '1001.json'), JSON.stringify({
    candidateId: '1001',
    review: {
      status: 'partial',
      reviewedAt: '2026-09-17T10:20:00-03:00',
      methodVersion: 1,
    },
    summary: {
      text: 'Professor; sua proposta publicada prioriza a ampliação da atenção básica de saúde.',
      sourceRefs: ['plano-oficial'],
    },
    claims: [
      {
        id: 'saude-atencao-basica',
        kind: 'proposal',
        themeId: 'saude',
        text: 'Propõe ampliar a cobertura da atenção básica de saúde.',
        attribution: 'candidate-declared',
        sourceRefs: ['plano-oficial'],
        publicationState: 'published',
      },
      {
        id: 'educacao-rascunho',
        kind: 'position',
        themeId: 'educacao',
        text: 'Rascunho ainda não aprovado para publicação editorial.',
        attribution: 'candidate-declared',
        sourceRefs: ['entrevista-rascunho'],
        publicationState: 'draft',
      },
    ],
    sources: {
      'plano-oficial': {
        type: 'official-document',
        publisher: 'Justiça Eleitoral',
        title: 'Plano apresentado pela candidatura',
        url: 'https://divulgacandcontas.tse.jus.br/plano-1001.pdf',
        publishedAt: '2026-08-20',
        checkedAt: '2026-09-17T10:15:00-03:00',
        locator: 'p. 12',
      },
      'entrevista-rascunho': {
        type: 'journalism',
        publisher: 'Veículo de teste',
        title: 'Entrevista de teste',
        url: 'https://example.org/entrevista-1001',
        checkedAt: '2026-09-17T10:16:00-03:00',
      },
    },
  }, null, 2));
  await writeFile(join(editorialDir, '1002.json'), JSON.stringify({
    candidateId: '1002',
    review: { status: 'pending', methodVersion: 1 },
    claims: [{
      id: 'transporte-rascunho',
      kind: 'proposal',
      themeId: 'transporte',
      text: 'Rascunho de proposta ainda não aprovado para publicação.',
      attribution: 'candidate-declared',
      sourceRefs: [],
      publicationState: 'draft',
    }],
    sources: {},
  }, null, 2));

  const parsed = parseTseCsv(rows);
  assert.equal(parsed.length, 5);
  assert.equal(parsed[0].OBSERVACAO_TESTE, 'texto; com separador');
  assert.equal(parsed[1].OBSERVACAO_TESTE, 'linha 1\nlinha "2"');
  const parsedArguments = parseArguments([
    '--release', 'teste-cli', '--input', inputPath,
    '--complement', complementPath, '--complement', complementPath,
    '--social', socialPath, '--social', socialPath,
    '--proposals-dir', proposalsDir, '--proposals-dir', proposalsDir,
    '--editorial-dir', editorialDir,
  ]);
  assert.deepEqual(parsedArguments.complementPaths, [complementPath, complementPath]);
  assert.deepEqual(parsedArguments.socialPaths, [socialPath, socialPath]);
  assert.deepEqual(parsedArguments.proposalDirectories, [proposalsDir, proposalsDir]);
  assert.equal(parsedArguments.editorialDir, editorialDir);

  const currentPath = join(workspace, 'site', 'data', 'current.json');
  await writeFile(currentPath, '{"sentinela":true}\n');
  const result = await prepareRelease({
    releaseId: 'teste-sp',
    inputPaths: [inputPath],
    complementPaths: [complementPath],
    socialPaths: [socialPath],
    proposalDirectories: [proposalsDir],
    editorialDir,
    outputDir,
    photosDir,
    generatedAt: '2026-09-17T10:30:00-03:00',
    encoding: 'windows-1252',
  });

  assert.equal(result.manifest.importSummary.inputRows, 5);
  assert.equal(result.manifest.importSummary.complementRows, 3);
  assert.equal(result.manifest.importSummary.ignoredRows, 2);
  assert.equal(result.manifest.importSummary.excludedWithoutComplement, 0);
  assert.equal(result.manifest.importSummary.excludedNotOnBallot, 1);
  assert.equal(result.manifest.importSummary.candidateProfiles, 2);
  assert.equal(result.manifest.importSummary.localPhotos, 1);
  assert.equal(result.manifest.importSummary.socialRows, 5);
  assert.equal(result.manifest.importSummary.socialMatchedRows, 5);
  assert.equal(result.manifest.importSummary.socialRowsOutsideRelease, 0);
  assert.equal(result.manifest.importSummary.profilesWithSocialLinks, 1);
  assert.equal(result.manifest.importSummary.socialLinksAccepted, 2);
  assert.equal(result.manifest.importSummary.socialLinksRejected, 3);
  assert.equal(result.manifest.importSummary.proposalFilesFound, 2);
  assert.equal(result.manifest.importSummary.proposalFilesSkippedEmpty, 1);
  assert.equal(result.manifest.importSummary.proposalDocumentsAvailable, 1);
  assert.equal(result.manifest.importSummary.proposalFilesOutsideRelease, 0);
  assert.equal(result.manifest.importSummary.proposalDocumentsCopied, 1);
  assert.equal(result.manifest.importSummary.profilesWithProposalDocuments, 1);
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.manifest.importSummary.editorialFiles, 2);
  assert.equal(result.manifest.importSummary.editorialProfilesOutsideRelease, 0);
  assert.equal(result.manifest.importSummary.profilesWithPublishedEditorial, 1);
  assert.equal(result.manifest.importSummary.publishedEditorialClaims, 1);
  assert.deepEqual(result.manifest.source.socialFiles, ['rede_social_candidato_2026_SP.csv']);
  assert.deepEqual(result.manifest.source.proposalDirectories, ['propostas']);
  assert.equal(result.manifest.source.editorialDirectory, 'editorial');
  assert.equal(result.manifest.coverage.SP.governador.count, 1);
  assert.equal(result.manifest.coverage.SP['deputado-federal'].count, 1);
  assert.deepEqual(
    await validateRelease('teste-sp', { projectRoot: join(workspace, 'site') }),
    { cardCount: 2, cardsWithPhotos: 1 },
  );

  const cards = JSON.parse(await readFile(join(outputDir, 'teste-sp', 'SP', 'governador.cards.json'), 'utf8'));
  assert.equal(cards.cards[0].name, 'João da Silva');
  assert.equal(cards.cards[0].photo.src, 'data/releases/teste-sp/fotos/1001.jpg');
  assert.equal(cards.cards[0].editorialStatus, 'partial');
  assert.deepEqual(cards.cards[0].themeIds, ['saude']);
  assert.deepEqual(cards.cards[0].themeKinds, { saude: ['proposal'] });
  assert.equal(cards.cards[0].summary, 'Professor; sua proposta publicada prioriza a ampliação da atenção básica de saúde.');
  assert.deepEqual(cards.cards[0].tags, ['Saúde']);
  assert.equal(containsForbiddenCardField(cards.cards[0]), false, 'cartão revelou dado reservado');

  const profile = JSON.parse(await readFile(join(outputDir, 'teste-sp', 'perfis', '1001.json'), 'utf8'));
  assert.deepEqual(profile.electionData, { party: 'PSB', number: '40', status: 'DEFERIDO' });
  assert.equal(profile.photo.state, 'available');
  assert.deepEqual(profile.background, {
    occupation: 'Professor de Ensino Superior',
    education: 'Superior Completo',
    ageAtTakingOffice: 45,
    sourceRef: 'candidateRecord',
  });
  assert.equal('birthDate' in profile, false);
  assert.equal('cpf' in profile, false);
  assert.equal(profile.editorial.review.status, 'partial');
  assert.deepEqual(profile.editorial.claims.map(({ id }) => id), ['saude-atencao-basica']);
  assert.deepEqual(Object.keys(profile.editorial.sources), ['plano-oficial']);
  assert.deepEqual(profile.networks, {
    state: 'available',
    items: [
      { label: 'X', url: 'https://x.com/joao' },
      { label: 'Instagram', url: 'https://www.instagram.com/joao' },
    ],
  });
  assert.deepEqual(profile.proposals, [{
    state: 'document-found',
    title: 'Proposta apresentada à Justiça Eleitoral',
    text: 'Este documento foi apresentado à Justiça Eleitoral e pode ser consultado na íntegra. Ainda não publicamos uma síntese temática dele.',
    sourceLabel: 'Documento apresentado à Justiça Eleitoral (PDF)',
    sourceUrl: 'data/releases/teste-sp/propostas/1001/2026SP1001_01.pdf',
  }]);
  assert.deepEqual(
    await readFile(join(outputDir, 'teste-sp', 'propostas', '1001', '2026SP1001_01.pdf')),
    minimalPdf,
  );
  const profileWithoutLinks = JSON.parse(
    await readFile(join(outputDir, 'teste-sp', 'perfis', '1002.json'), 'utf8'),
  );
  assert.deepEqual(profileWithoutLinks.networks, { state: 'available', items: [] });
  assert.deepEqual(profileWithoutLinks.background, {
    occupation: 'Advogado',
    education: null,
    ageAtTakingOffice: null,
    sourceRef: 'candidateRecord',
  });
  assert.equal('editorial' in profileWithoutLinks, false, 'rascunho editorial foi publicado');
  const federalCards = JSON.parse(
    await readFile(join(outputDir, 'teste-sp', 'SP', 'deputado-federal.cards.json'), 'utf8'),
  );
  assert.equal(federalCards.cards[0].editorialStatus, 'not-reviewed');
  assert.deepEqual(federalCards.cards[0].themeIds, []);
  assert.deepEqual(federalCards.cards[0].themeKinds, {});
  assert.match(federalCards.cards[0].summary, /ainda não tem conteúdo temático revisado/i);
  assert.doesNotMatch(federalCards.cards[0].summary, /fontes em revisão/i);
  await assert.rejects(readFile(join(outputDir, 'teste-sp', 'perfis', '1005.json')), /ENOENT/);
  assert.equal(await readFile(currentPath, 'utf8'), '{"sentinela":true}\n');

  await prepareRelease({
    releaseId: 'teste-sem-social',
    inputPaths: [inputPath],
    complementPaths: [complementPath],
    outputDir,
    generatedAt: '2026-09-17T10:30:00-03:00',
  });
  const profileWithoutImport = JSON.parse(
    await readFile(join(outputDir, 'teste-sem-social', 'perfis', '1001.json'), 'utf8'),
  );
  assert.deepEqual(profileWithoutImport.networks, { state: 'not-imported', items: [] });

  const validEditorial = JSON.parse(await readFile(join(editorialDir, '1001.json'), 'utf8'));
  const reviewedWithDraftDir = join(workspace, 'editorial-reviewed-com-rascunho');
  await mkdir(reviewedWithDraftDir);
  const reviewedWithDraft = structuredClone(validEditorial);
  reviewedWithDraft.review.status = 'reviewed';
  await writeFile(join(reviewedWithDraftDir, '1001.json'), JSON.stringify(reviewedWithDraft));
  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-editorial-reviewed-com-rascunho',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      editorialDir: reviewedWithDraftDir,
      outputDir,
      generatedAt: '2026-09-17T10:30:00-03:00',
    }),
    /review.status reviewed não pode manter claims em rascunho/,
  );
  const invalidDateDir = join(workspace, 'editorial-data-invalida');
  await mkdir(invalidDateDir);
  const invalidDateEditorial = structuredClone(validEditorial);
  invalidDateEditorial.review.reviewedAt = '2026-02-30T10:20:00-03:00';
  await writeFile(join(invalidDateDir, '1001.json'), JSON.stringify(invalidDateEditorial));
  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-editorial-data-invalida',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      editorialDir: invalidDateDir,
      outputDir,
      generatedAt: '2026-09-17T10:30:00-03:00',
    }),
    /data ISO válida/,
  );
  const invalidThemeDir = join(workspace, 'editorial-tema-invalido');
  await mkdir(invalidThemeDir);
  const invalidThemeEditorial = structuredClone(validEditorial);
  invalidThemeEditorial.claims[0].themeId = 'saude-publica';
  await writeFile(join(invalidThemeDir, '1001.json'), JSON.stringify(invalidThemeEditorial));
  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-editorial-tema-invalido',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      editorialDir: invalidThemeDir,
      outputDir,
      generatedAt: '2026-09-17T10:30:00-03:00',
    }),
    /themeId inválido/,
  );

  const unsafeSourceDir = join(workspace, 'editorial-fonte-insegura');
  await mkdir(unsafeSourceDir);
  const unsafeSourceEditorial = structuredClone(validEditorial);
  unsafeSourceEditorial.sources['plano-oficial'].url = 'javascript:alert(1)';
  await writeFile(join(unsafeSourceDir, '1001.json'), JSON.stringify(unsafeSourceEditorial));
  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-editorial-fonte-insegura',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      editorialDir: unsafeSourceDir,
      outputDir,
      generatedAt: '2026-09-17T10:30:00-03:00',
    }),
    /url deve ser HTTP ou HTTPS, sem credenciais/,
  );

  const fakeInstitutionalDir = join(workspace, 'editorial-fonte-institucional-falsa');
  await mkdir(fakeInstitutionalDir);
  const fakeInstitutionalEditorial = structuredClone(validEditorial);
  fakeInstitutionalEditorial.sources['plano-oficial'].url = 'https://example.org/plano-1001.pdf';
  await writeFile(join(fakeInstitutionalDir, '1001.json'), JSON.stringify(fakeInstitutionalEditorial));
  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-editorial-fonte-institucional-falsa',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      editorialDir: fakeInstitutionalDir,
      outputDir,
      generatedAt: '2026-09-17T10:30:00-03:00',
    }),
    /url institucional deve usar domínio/,
  );

  const missingSourceDir = join(workspace, 'editorial-fonte-ausente');
  await mkdir(missingSourceDir);
  const missingSourceEditorial = structuredClone(validEditorial);
  delete missingSourceEditorial.sources['plano-oficial'];
  await writeFile(join(missingSourceDir, '1001.json'), JSON.stringify(missingSourceEditorial));
  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-editorial-fonte-ausente',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      editorialDir: missingSourceDir,
      outputDir,
      generatedAt: '2026-09-17T10:30:00-03:00',
    }),
    /fonte inexistente plano-oficial/,
  );

  await assert.rejects(
    prepareRelease({
      releaseId: 'teste-sp',
      inputPaths: [inputPath],
      complementPaths: [complementPath],
      outputDir,
    }),
    /já existe e não será substituída/,
  );

  process.stdout.write('Teste sintético concluído: background público, editorial, fontes, redes, PDFs, privacidade, fotos e imutabilidade validados.\n');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
