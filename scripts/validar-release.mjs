#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CARD_FORBIDDEN_FIELDS = new Set([
  'party', 'partido', 'number', 'numero', 'status', 'electionData', 'networks',
]);
const PROFILE_PRIVATE_FIELDS = new Set([
  'cpf', 'email', 'dsEmail', 'birthDate', 'dateOfBirth', 'dataNascimento',
  'dtNascimento', 'birthday', 'nrCpfCandidato', 'cpfCandidato', 'tituloEleitoral',
  'nrTituloEleitoralCandidato', 'voterRegistration',
]);
const ALLOWED_EDITORIAL_THEMES = new Set([
  'saude', 'educacao', 'seguranca', 'emprego-e-renda', 'custo-de-vida',
  'meio-ambiente', 'moradia', 'transporte', 'transparencia', 'tecnologia',
]);
const EDITORIAL_THEME_LABELS = new Map([
  ['saude', 'Saúde'], ['educacao', 'Educação'], ['seguranca', 'Segurança'],
  ['emprego-e-renda', 'Emprego e renda'], ['custo-de-vida', 'Custo de vida'],
  ['meio-ambiente', 'Meio ambiente'], ['moradia', 'Moradia'],
  ['transporte', 'Transporte'], ['transparencia', 'Transparência'],
  ['tecnologia', 'Tecnologia'],
]);
const ALLOWED_EDITORIAL_STATUSES = new Set(['reviewed', 'partial']);
const ALLOWED_EDITORIAL_KINDS = new Set(['track-record', 'position', 'proposal']);
const ALLOWED_EDITORIAL_ATTRIBUTIONS = new Set([
  'institutional-record', 'candidate-declared', 'mixed-sources',
]);
const ALLOWED_EDITORIAL_SOURCE_TYPES = new Set([
  'institutional-record', 'candidate-declared', 'official-document', 'journalism',
]);
const MAX_PUBLISHED_EDITORIAL_CLAIMS = 30;
const V2_CARD_KEYS = new Set([
  'id', 'name', 'initials', 'profile', 'editorialStatus', 'themeIds', 'themeKinds',
  'summary', 'tags', 'photo',
]);
const V2_PROFILE_KEYS = new Set([
  'id', 'name', 'office', 'uf', 'sourceCheckedAt', 'electionData', 'photo',
  'background', 'editorial', 'proposals', 'networks', 'sources',
]);
const UNREVIEWED_CARD_SUMMARY = 'Este perfil ainda não tem conteúdo temático revisado. Isso não significa ausência de propostas.';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function findForbiddenKey(value, forbidden, trail = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if ([...forbidden].some((field) => field.toLocaleLowerCase('en-US') === key.toLocaleLowerCase('en-US'))) {
      return [...trail, key].join('.');
    }
    const nested = findForbiddenKey(child, forbidden, [...trail, key]);
    if (nested) return nested;
  }
  return null;
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, context) {
  assert(isPlainObject(value), `${context} deve ser um objeto.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  assert(unexpected.length === 0, `${context} contém campos não permitidos: ${unexpected.join(', ')}.`);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function assertValidDate(value, message) {
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const dateTime = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const datePart = typeof value === 'string' ? value.slice(0, 10) : '';
  const calendarTimestamp = Date.parse(`${datePart}T00:00:00Z`);
  const validCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
    && !Number.isNaN(calendarTimestamp)
    && new Date(calendarTimestamp).toISOString().slice(0, 10) === datePart;
  assert((dateOnly || dateTime) && !Number.isNaN(parsed) && validCalendarDate, message);
}

function isInstitutionalEditorialUrl(value) {
  const hostname = new URL(value).hostname.toLocaleLowerCase('en-US');
  return ['gov.br', 'leg.br', 'jus.br'].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function validateSourceRefs(refs, sources, context) {
  assert(Array.isArray(refs) && refs.length > 0, `${context} precisa de ao menos uma fonte.`);
  assert(new Set(refs).size === refs.length, `${context} contém fontes repetidas.`);
  refs.forEach((sourceId) => {
    assert(typeof sourceId === 'string' && Object.hasOwn(sources, sourceId), `${context} referencia fonte inexistente.`);
  });
}

function validateVersion2Editorial(card, profile) {
  assertOnlyKeys(card, V2_CARD_KEYS, `Cartão ${card.id}`);
  assertOnlyKeys(profile, V2_PROFILE_KEYS, `Perfil ${card.id}`);
  assert(['not-reviewed', 'reviewed', 'partial'].includes(card.editorialStatus), `Estado editorial inválido em ${card.id}.`);
  assert(Array.isArray(card.themeIds), `themeIds ausente em ${card.id}.`);
  assert(new Set(card.themeIds).size === card.themeIds.length, `themeIds repetidos em ${card.id}.`);
  card.themeIds.forEach((themeId) => {
    assert(ALLOWED_EDITORIAL_THEMES.has(themeId), `Tema inválido no cartão ${card.id}: ${themeId}.`);
  });
  assert(isPlainObject(card.themeKinds), `themeKinds inválido em ${card.id}.`);
  assert(sameMembers(Object.keys(card.themeKinds), card.themeIds), `themeKinds diverge de themeIds em ${card.id}.`);
  for (const [themeId, kinds] of Object.entries(card.themeKinds)) {
    assert(Array.isArray(kinds) && kinds.length > 0, `Tipos editoriais ausentes em ${card.id}/${themeId}.`);
    assert(new Set(kinds).size === kinds.length, `Tipos editoriais repetidos em ${card.id}/${themeId}.`);
    kinds.forEach((kind) => assert(ALLOWED_EDITORIAL_KINDS.has(kind), `Tipo editorial inválido em ${card.id}/${themeId}.`));
  }
  assert(typeof card.summary === 'string' && card.summary.trim() === card.summary && card.summary.length > 0, `Resumo inválido em ${card.id}.`);
  assert(Array.isArray(card.tags) && !card.tags.includes('Fontes em revisão'), `Tag editorial antiga em ${card.id}.`);

  assert(isPlainObject(profile.background), `Bloco background ausente em ${card.id}.`);
  assertOnlyKeys(profile.background, new Set(['occupation', 'education', 'ageAtTakingOffice', 'sourceRef']), `Background ${card.id}`);
  for (const field of ['occupation', 'education']) {
    assert(profile.background[field] === null || (
      typeof profile.background[field] === 'string' && profile.background[field].trim()
    ), `${field} inválido em ${card.id}.`);
  }
  assert(profile.background.ageAtTakingOffice === null || (
    Number.isSafeInteger(profile.background.ageAtTakingOffice)
    && profile.background.ageAtTakingOffice >= 16
    && profile.background.ageAtTakingOffice <= 120
  ), `Idade na data da posse inválida em ${card.id}.`);
  assert(profile.background.sourceRef === 'candidateRecord', `Fonte do background inválida em ${card.id}.`);

  if (card.editorialStatus === 'not-reviewed') {
    assert(card.themeIds.length === 0, `Cartão sem revisão expõe temas em ${card.id}.`);
    assert(Object.keys(card.themeKinds).length === 0, `Cartão sem revisão expõe tipos em ${card.id}.`);
    assert(card.summary === UNREVIEWED_CARD_SUMMARY, `Copy de perfil sem revisão divergente em ${card.id}.`);
    assert(!profile.editorial, `Perfil sem revisão publicou bloco editorial em ${card.id}.`);
    return { profiles: 0, claims: 0 };
  }

  const editorial = profile.editorial;
  assert(isPlainObject(editorial), `Bloco editorial ausente em ${card.id}.`);
  assertOnlyKeys(editorial, new Set(['candidateId', 'review', 'summary', 'claims', 'sources']), `Editorial ${card.id}`);
  assert(editorial.candidateId === profile.id, `candidateId editorial diverge do perfil ${card.id}.`);
  assert(isPlainObject(editorial.review), `Revisão editorial ausente em ${card.id}.`);
  assertOnlyKeys(editorial.review, new Set(['status', 'reviewedAt', 'methodVersion']), `Revisão editorial ${card.id}`);
  assert(editorial.review.status === card.editorialStatus && ALLOWED_EDITORIAL_STATUSES.has(editorial.review.status), `Estado editorial divergente em ${card.id}.`);
  assertValidDate(editorial.review.reviewedAt, `Data de revisão editorial inválida em ${card.id}.`);
  assert(Number.isSafeInteger(editorial.review.methodVersion) && editorial.review.methodVersion >= 1, `Versão da metodologia inválida em ${card.id}.`);
  assert(isPlainObject(editorial.summary), `Resumo editorial ausente em ${card.id}.`);
  assertOnlyKeys(editorial.summary, new Set(['text', 'sourceRefs']), `Resumo editorial ${card.id}`);
  assert(editorial.summary.text === card.summary, `Resumo do cartão diverge do perfil ${card.id}.`);
  assert(isPlainObject(editorial.sources), `Fontes editoriais ausentes em ${card.id}.`);

  for (const [sourceId, source] of Object.entries(editorial.sources)) {
    assert(/^[a-z0-9][a-z0-9._-]{0,79}$/.test(sourceId), `ID de fonte inválido em ${card.id}.`);
    assert(isPlainObject(source) && ALLOWED_EDITORIAL_SOURCE_TYPES.has(source.type), `Tipo de fonte inválido em ${card.id}/${sourceId}.`);
    assert(typeof source.publisher === 'string' && source.publisher.trim(), `Publicador ausente em ${card.id}/${sourceId}.`);
    assert(typeof source.title === 'string' && source.title.trim(), `Título de fonte ausente em ${card.id}/${sourceId}.`);
    assert(isSafeExternalUrl(source.url), `URL editorial insegura em ${card.id}/${sourceId}.`);
    assertOnlyKeys(source, new Set(['type', 'publisher', 'title', 'url', 'publishedAt', 'checkedAt', 'locator']), `Fonte editorial ${card.id}/${sourceId}`);
    if (['institutional-record', 'official-document'].includes(source.type)) {
      assert(isInstitutionalEditorialUrl(source.url), `URL institucional fora de domínio público em ${card.id}/${sourceId}.`);
    }
    assertValidDate(source.checkedAt, `Consulta da fonte inválida em ${card.id}/${sourceId}.`);
    if (source.publishedAt !== undefined) assertValidDate(source.publishedAt, `Publicação da fonte inválida em ${card.id}/${sourceId}.`);
  }
  validateSourceRefs(editorial.summary.sourceRefs, editorial.sources, `Resumo editorial ${card.id}`);

  assert(Array.isArray(editorial.claims) && editorial.claims.length > 0, `Claims editoriais ausentes em ${card.id}.`);
  assert(editorial.claims.length <= MAX_PUBLISHED_EDITORIAL_CLAIMS, `Perfil ${card.id} excede ${MAX_PUBLISHED_EDITORIAL_CLAIMS} claims publicados.`);
  const claimIds = new Set();
  const computedThemeKinds = {};
  const referencedSources = new Set(editorial.summary.sourceRefs);
  for (const claim of editorial.claims) {
    assertOnlyKeys(claim, new Set(['id', 'kind', 'themeId', 'text', 'attribution', 'sourceRefs', 'publicationState']), `Claim ${card.id}`);
    assert(typeof claim.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(claim.id), `ID de claim inválido em ${card.id}.`);
    assert(!claimIds.has(claim.id), `Claim repetido em ${card.id}: ${claim.id}.`);
    claimIds.add(claim.id);
    assert(claim.publicationState === 'published', `Claim não publicado vazou em ${card.id}.`);
    assert(ALLOWED_EDITORIAL_KINDS.has(claim.kind), `Tipo de claim inválido em ${card.id}.`);
    assert(ALLOWED_EDITORIAL_THEMES.has(claim.themeId), `Tema de claim inválido em ${card.id}.`);
    assert(ALLOWED_EDITORIAL_ATTRIBUTIONS.has(claim.attribution), `Atribuição inválida em ${card.id}.`);
    assert(typeof claim.text === 'string' && claim.text.trim() === claim.text && claim.text.length >= 10, `Texto de claim inválido em ${card.id}.`);
    validateSourceRefs(claim.sourceRefs, editorial.sources, `Claim ${card.id}/${claim.id}`);
    claim.sourceRefs.forEach((sourceId) => referencedSources.add(sourceId));
    computedThemeKinds[claim.themeId] ||= [];
    if (!computedThemeKinds[claim.themeId].includes(claim.kind)) computedThemeKinds[claim.themeId].push(claim.kind);
  }
  assert(sameMembers(Object.keys(computedThemeKinds), card.themeIds), `Temas do cartão divergem dos claims em ${card.id}.`);
  for (const themeId of card.themeIds) {
    assert(sameMembers(computedThemeKinds[themeId], card.themeKinds[themeId]), `Tipos do cartão divergem dos claims em ${card.id}/${themeId}.`);
  }
  assert(sameMembers(Object.keys(editorial.sources), [...referencedSources]), `Perfil ${card.id} inclui fonte editorial sem conteúdo publicado.`);
  assert(sameMembers(card.tags, card.themeIds.map((themeId) => EDITORIAL_THEME_LABELS.get(themeId))), `Tags divergem dos temas em ${card.id}.`);
  return { profiles: 1, claims: editorial.claims.length };
}

function isSafeLocalProposalPath(value, releaseId, candidateId) {
  const prefix = `data/releases/${releaseId}/propostas/${candidateId}/`;
  return typeof value === 'string'
    && value.startsWith(prefix)
    && !value.includes('..')
    && value.toLocaleLowerCase('en-US').endsWith('.pdf');
}

export async function validateRelease(releaseId, { projectRoot = PROJECT_ROOT } = {}) {
  if (!releaseId || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error('Uso: node scripts/validar-release.mjs ID-DA-RELEASE');
  }

  const releaseDir = resolve(projectRoot, 'data', 'releases', releaseId);
  const manifest = await readJson(join(releaseDir, 'manifest.json'));
  assert(manifest.releaseId === releaseId, 'O ID do manifesto não corresponde à pasta.');
  assert(manifest.electionYear === 2026, 'Ano eleitoral inesperado.');
  assert([1, 2].includes(manifest.schemaVersion), 'Versão de schema não suportada.');
  assert(!Number.isNaN(Date.parse(manifest.generatedAt)), 'Data de geração inválida.');

  const profileIds = new Set();
  let cardCount = 0;
  let cardsWithPhotos = 0;
  let profilesWithPublishedEditorial = 0;
  let publishedEditorialClaims = 0;

  for (const [uf, offices] of Object.entries(manifest.coverage || {})) {
    for (const [office, collection] of Object.entries(offices || {})) {
      const catalogPath = resolve(projectRoot, collection.cards);
      const catalog = await readJson(catalogPath);
      assert(catalog.releaseId === releaseId, `Release incorreta em ${uf}/${office}.`);
      assert(catalog.uf === uf && catalog.office === office, `Escopo incorreto em ${uf}/${office}.`);
      assert(Array.isArray(catalog.cards), `Catálogo inválido em ${uf}/${office}.`);
      assert(catalog.cards.length === collection.count, `Contagem divergente em ${uf}/${office}.`);

      for (const card of catalog.cards) {
        const forbidden = findForbiddenKey(card, CARD_FORBIDDEN_FIELDS);
        assert(!forbidden, `Cartão ${card.id} revela o campo reservado ${forbidden}.`);
        assert(/^\d+$/.test(card.id), `ID inválido no cartão ${card.id}.`);
        assert(typeof card.name === 'string' && card.name.trim(), `Nome ausente no cartão ${card.id}.`);
        assert(!profileIds.has(card.id), `Candidatura duplicada nos catálogos: ${card.id}.`);
        profileIds.add(card.id);
        cardCount += 1;

        const profilePath = resolve(projectRoot, card.profile);
        assert(await exists(profilePath), `Perfil ausente para ${card.id}.`);
        const profile = await readJson(profilePath);
        assert(profile.id === card.id, `Perfil incorreto para ${card.id}.`);
        assert(profile.uf === uf && profile.office === office, `Cargo ou UF divergente no perfil ${card.id}.`);
        assert(!findForbiddenKey(profile, PROFILE_PRIVATE_FIELDS), `Perfil ${card.id} contém dado privado não permitido.`);
        assert(profile.electionData && typeof profile.electionData === 'object', `Dados eleitorais ausentes em ${card.id}.`);
        assert(profile.electionData.party && profile.electionData.number && profile.electionData.status, `Dados eleitorais incompletos em ${card.id}.`);
        assert(!/^#/.test(profile.electionData.status), `Status bruto inválido em ${card.id}.`);
        assert(isSafeExternalUrl(profile.sources?.candidateRecord), `Ficha oficial inválida em ${card.id}.`);
        assert(profile.sources.candidateRecord.includes('/20322002026/'), `ID da eleição incorreto em ${card.id}.`);

        if (manifest.schemaVersion >= 2) {
          const editorialCounts = validateVersion2Editorial(card, profile);
          profilesWithPublishedEditorial += editorialCounts.profiles;
          publishedEditorialClaims += editorialCounts.claims;
        }

        for (const proposal of profile.proposals || []) {
          if (!proposal.sourceUrl) continue;
          const localProposal = isSafeLocalProposalPath(proposal.sourceUrl, releaseId, card.id);
          assert(localProposal || isSafeExternalUrl(proposal.sourceUrl), `Fonte de proposta inválida em ${card.id}.`);
          if (localProposal) {
            assert(await exists(resolve(projectRoot, proposal.sourceUrl)), `PDF de proposta ausente em ${card.id}.`);
          }
        }
        for (const network of profile.networks?.items || []) {
          assert(isSafeExternalUrl(network.url), `Rede social inválida em ${card.id}.`);
        }

        if (card.photo?.src) {
          assert(profile.photo?.src === card.photo.src, `Foto divergente em ${card.id}.`);
          assert(await exists(resolve(projectRoot, card.photo.src)), `Foto ausente para ${card.id}.`);
          cardsWithPhotos += 1;
        }
      }
    }
  }

  const profileFiles = (await readdir(join(releaseDir, 'perfis'))).filter((name) => name.endsWith('.json'));
  assert(profileFiles.length === cardCount, 'Há perfis sem cartão ou cartões sem perfil.');
  assert(manifest.importSummary?.candidateProfiles === cardCount, 'Total de perfis diverge do manifesto.');
  assert(manifest.importSummary?.localPhotos === cardsWithPhotos, 'Total de fotos diverge do manifesto.');
  if (manifest.schemaVersion >= 2) {
    assert(
      manifest.importSummary?.profilesWithPublishedEditorial === profilesWithPublishedEditorial,
      'Total de perfis com editorial publicado diverge do manifesto.',
    );
    assert(
      manifest.importSummary?.publishedEditorialClaims === publishedEditorialClaims,
      'Total de claims editoriais publicados diverge do manifesto.',
    );
  }

  return { cardCount, cardsWithPhotos };
}

async function main() {
  try {
    const releaseId = process.argv[2];
    const { cardCount, cardsWithPhotos } = await validateRelease(releaseId);
    process.stdout.write(`Release ${releaseId} validada: ${cardCount} perfis e ${cardsWithPhotos} fotos locais.\n`);
  } catch (error) {
    process.stderr.write(`Erro de validação: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
