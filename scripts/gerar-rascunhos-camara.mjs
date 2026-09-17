#!/usr/bin/env node

/**
 * Piloto de enriquecimento editorial para candidaturas a deputado federal por SP.
 *
 * A data de nascimento existe somente em memória para desambiguar identidades. Ela
 * nunca é gravada nos rascunhos nem nos relatórios. Os registros gerados ficam em
 * review.status=pending e todos os claims ficam como draft: nada é publicável sem
 * revisão humana.
 */

import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_API_BASE = 'https://dadosabertos.camara.leg.br/api/v2/';
const DEFAULT_FROM_YEAR = 2023;
const DEFAULT_TO_YEAR = 2026;
const DEFAULT_UF = 'SP';
const DEFAULT_OFFICE_CODE = '6';
const MAX_API_PAGES = 1000;
const MAX_CLAIM_TEXT = 1200;

/**
 * Mapeamento deliberadamente conservador. Só entram categorias da Câmara cuja
 * correspondência com uma prioridade do site é direta. Categorias amplas como
 * Economia, Administração Pública e Cidades não são convertidas automaticamente.
 */
export const THEME_MAPPING = Object.freeze([
  { siteThemeId: 'saude', siteLabel: 'Saúde', chamberCodes: ['56'], chamberLabels: ['Saúde'] },
  { siteThemeId: 'educacao', siteLabel: 'Educação', chamberCodes: ['46'], chamberLabels: ['Educação'] },
  { siteThemeId: 'seguranca', siteLabel: 'Segurança', chamberCodes: ['57'], chamberLabels: ['Defesa e Segurança'] },
  { siteThemeId: 'emprego-e-renda', siteLabel: 'Emprego e renda', chamberCodes: ['58'], chamberLabels: ['Trabalho e Emprego'] },
  { siteThemeId: 'meio-ambiente', siteLabel: 'Meio ambiente', chamberCodes: ['48'], chamberLabels: ['Meio Ambiente e Desenvolvimento Sustentável'] },
  { siteThemeId: 'transporte', siteLabel: 'Transporte', chamberCodes: ['61'], chamberLabels: ['Viação, Transporte e Mobilidade'] },
  { siteThemeId: 'tecnologia', siteLabel: 'Tecnologia', chamberCodes: ['62'], chamberLabels: ['Ciência, Tecnologia e Inovação'] },
]);

const HELP = `
Gera rascunhos editoriais a partir de registros oficiais da Câmara dos Deputados.

Uso:
  node scripts/gerar-rascunhos-camara.mjs \\
    --candidates /caminho/consulta_cand_2026_SP.csv \\
    --complement /caminho/consulta_cand_complementar_2026_SP.csv \\
    --output /caminho/novo/piloto-camara \\
    [--checked-at 2026-09-17T12:00:00-03:00] \\
    [--from-year 2023] [--to-year 2026] \\
    [--types PL,PLP,PEC,PDL,PRC] \\
    [--max-matches 5] \\
    [--identity-only] \\
    [--encoding windows-1252]

Saída:
  drafts/*.json   Rascunhos compatíveis com --editorial-dir do importador.
  coverage.json   Relatório estruturado, sem data de nascimento ou CPF.
  COVERAGE.md     Resumo legível da cobertura e das limitações.

Regras de segurança:
  - o pareamento exige nome civil e data de nascimento iguais após normalização;
  - chaves duplicadas ou ambíguas nunca são pareadas;
  - a autoria é reconfirmada no endpoint /proposicoes/{id}/autores;
  - todos os claims são draft e review.status é pending;
  - a pasta de saída deve ser nova: o script não sobrescreve dados.
`;

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeCode(value) {
  const normalized = clean(value).replace(/^0+/, '');
  return normalized || '0';
}

export function normalizeIdentityName(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleUpperCase('pt-BR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeBirthDate(value) {
  const raw = clean(value);
  let year;
  let month;
  let day;
  let match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    [, day, month, year] = match;
  } else {
    match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    [, year, month, day] = match;
  }
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)
  ) return null;
  return iso;
}

export function parseSemicolonCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const finishField = () => {
    row.push(field);
    field = '';
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ';' && !quoted) {
      finishField();
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV inválido: campo entre aspas sem fechamento.');
  if (field !== '' || row.length) finishRow();
  if (!rows.length) return [];

  const headers = rows.shift().map((header, index) => clean(header).replace(index === 0 ? /^\uFEFF/ : /$^/, ''));
  if (headers.some((header) => !header)) throw new Error('CSV inválido: cabeçalho vazio.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV inválido: cabeçalhos repetidos.');
  return rows.map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw new Error(`CSV inválido: linha ${rowIndex + 2} tem colunas extras.`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']));
  });
}

function decodeCsv(buffer, encoding) {
  const aliases = new Map([
    ['windows-1252', 'windows-1252'],
    ['cp1252', 'windows-1252'],
    ['latin1', 'windows-1252'],
    ['utf-8', 'utf-8'],
    ['utf8', 'utf-8'],
  ]);
  const decoderName = aliases.get(clean(encoding).toLocaleLowerCase('en-US'));
  if (!decoderName) throw new Error(`Codificação não suportada: ${encoding}.`);
  return new TextDecoder(decoderName).decode(buffer).replace(/^\uFEFF/, '');
}

function requireHeaders(rows, headers, label) {
  if (!rows.length) throw new Error(`${label} está vazio.`);
  const available = new Set(Object.keys(rows[0]));
  const missing = headers.filter((header) => !available.has(header));
  if (missing.length) throw new Error(`${label} não contém: ${missing.join(', ')}.`);
}

export function selectTseCandidates(candidateRows, complementRows) {
  requireHeaders(candidateRows, [
    'ANO_ELEICAO', 'NR_TURNO', 'SG_UF', 'CD_CARGO', 'SQ_CANDIDATO',
    'NM_CANDIDATO', 'NM_URNA_CANDIDATO', 'DT_NASCIMENTO',
  ], 'CSV de candidaturas');
  requireHeaders(complementRows, ['SQ_CANDIDATO', 'ST_CANDIDATO_INSERIDO_URNA'], 'CSV complementar');

  const insertedIds = new Set(complementRows
    .filter((row) => ['SIM', 'S'].includes(clean(row.ST_CANDIDATO_INSERIDO_URNA).toLocaleUpperCase('pt-BR')))
    .map((row) => clean(row.SQ_CANDIDATO))
    .filter(Boolean));
  const selected = new Map();

  for (const row of candidateRows) {
    if (
      clean(row.ANO_ELEICAO) !== '2026'
      || normalizeCode(row.NR_TURNO) !== '1'
      || clean(row.SG_UF).toLocaleUpperCase('pt-BR') !== DEFAULT_UF
      || normalizeCode(row.CD_CARGO) !== DEFAULT_OFFICE_CODE
    ) continue;
    const candidateId = clean(row.SQ_CANDIDATO);
    if (!candidateId || !insertedIds.has(candidateId)) continue;
    const normalizedCivilName = normalizeIdentityName(row.NM_CANDIDATO);
    const normalizedBirthDate = normalizeBirthDate(row.DT_NASCIMENTO);
    if (!normalizedCivilName || !normalizedBirthDate) continue;
    const candidate = {
      candidateId,
      displayName: clean(row.NM_URNA_CANDIDATO) || clean(row.NM_CANDIDATO),
      normalizedCivilName,
      normalizedBirthDate,
    };
    const previous = selected.get(candidateId);
    if (previous && (
      previous.normalizedCivilName !== candidate.normalizedCivilName
      || previous.normalizedBirthDate !== candidate.normalizedBirthDate
    )) throw new Error(`Dados de identidade conflitantes para SQ_CANDIDATO ${candidateId}.`);
    selected.set(candidateId, candidate);
  }
  return [...selected.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function identityKey(normalizedCivilName, normalizedBirthDate) {
  return `${normalizedCivilName}\u0000${normalizedBirthDate}`;
}

function groupByIdentity(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!record.normalizedCivilName || !record.normalizedBirthDate) continue;
    const key = identityKey(record.normalizedCivilName, record.normalizedBirthDate);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  return grouped;
}

export function matchCandidatesToDeputies(candidates, deputyDetails) {
  const normalizedDeputies = deputyDetails.map((deputy) => ({
    chamberId: String(deputy.id ?? ''),
    chamberName: clean(deputy.ultimoStatus?.nome || deputy.nomeCivil),
    normalizedCivilName: normalizeIdentityName(deputy.nomeCivil),
    normalizedBirthDate: normalizeBirthDate(deputy.dataNascimento),
  })).filter((deputy) => deputy.chamberId);
  const candidatesByKey = groupByIdentity(candidates);
  const deputiesByKey = groupByIdentity(normalizedDeputies);
  const matches = [];
  const ambiguousCandidateIds = new Set();
  const ambiguousDeputyIds = new Set();

  for (const [key, candidateGroup] of candidatesByKey) {
    const deputyGroup = deputiesByKey.get(key) || [];
    if (candidateGroup.length === 1 && deputyGroup.length === 1) {
      matches.push({
        candidateId: candidateGroup[0].candidateId,
        displayName: candidateGroup[0].displayName,
        chamberId: deputyGroup[0].chamberId,
        chamberName: deputyGroup[0].chamberName,
      });
      continue;
    }
    if (deputyGroup.length || candidateGroup.length > 1) {
      candidateGroup.forEach(({ candidateId }) => ambiguousCandidateIds.add(candidateId));
      deputyGroup.forEach(({ chamberId }) => ambiguousDeputyIds.add(chamberId));
    }
  }

  return {
    matches: matches.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    ambiguousCandidateIds: [...ambiguousCandidateIds].sort(),
    ambiguousDeputyIds: [...ambiguousDeputyIds].sort((left, right) => Number(left) - Number(right)),
    deputiesWithUsableIdentity: normalizedDeputies.filter(
      (deputy) => deputy.normalizedCivilName && deputy.normalizedBirthDate,
    ).length,
  };
}

function validatedApiBase(value) {
  const url = new URL(value || DEFAULT_API_BASE);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('A base da API deve ser HTTP(S), sem credenciais.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function safeNextUrl(candidate, apiBase) {
  const url = new URL(candidate, apiBase);
  if (url.origin !== apiBase.origin || !url.pathname.startsWith(apiBase.pathname)) {
    throw new Error('A API retornou paginação para uma origem inesperada.');
  }
  return url;
}

function retryDelay(attempt) {
  return 250 * (2 ** attempt);
}

async function sleep(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function fetchApiJson(url, { fetchImpl = globalThis.fetch, attempts = 3 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Este Node.js não oferece fetch. Use Node 18 ou superior.');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Voto-2026-piloto-editorial/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === attempts - 1) {
          throw new Error(`API da Câmara respondeu HTTP ${response.status}.`);
        }
        lastError = new Error(`API da Câmara respondeu HTTP ${response.status}.`);
      } else {
        const payload = await response.json();
        if (!payload || !Object.hasOwn(payload, 'dados')) throw new Error('Resposta da API sem o campo dados.');
        return payload;
      }
    } catch (error) {
      if (attempt === attempts - 1 || /respondeu HTTP 4\d\d/.test(error.message)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelay(attempt));
  }
  throw lastError || new Error('Falha ao consultar a API da Câmara.');
}

export async function fetchAllPages(initialUrl, { apiBase, fetchImpl = globalThis.fetch } = {}) {
  const base = validatedApiBase(apiBase || DEFAULT_API_BASE);
  let currentUrl = safeNextUrl(initialUrl, base);
  const items = [];
  const visited = new Set();
  for (let page = 0; currentUrl; page += 1) {
    if (page >= MAX_API_PAGES) throw new Error('A paginação da API ultrapassou o limite de segurança.');
    if (visited.has(currentUrl.href)) throw new Error('A API retornou um ciclo de paginação.');
    visited.add(currentUrl.href);
    const payload = await fetchApiJson(currentUrl, { fetchImpl });
    if (!Array.isArray(payload.dados)) throw new Error('Resposta paginada da API não contém uma lista em dados.');
    items.push(...payload.dados);
    const next = Array.isArray(payload.links)
      ? payload.links.find(({ rel }) => rel === 'next')?.href
      : null;
    currentUrl = next ? safeNextUrl(next, base) : null;
  }
  return items;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchCurrentDeputies({ apiBase = DEFAULT_API_BASE, fetchImpl = globalThis.fetch } = {}) {
  const base = validatedApiBase(apiBase);
  const listUrl = new URL('deputados', base);
  listUrl.search = new URLSearchParams({
    siglaUf: DEFAULT_UF,
    itens: '100',
    ordem: 'ASC',
    ordenarPor: 'id',
  });
  const deputies = await fetchAllPages(listUrl, { apiBase: base, fetchImpl });
  return mapLimit(deputies, 6, async (deputy) => {
    const detailUrl = new URL(`deputados/${encodeURIComponent(deputy.id)}`, base);
    const payload = await fetchApiJson(detailUrl, { fetchImpl });
    return payload.dados;
  });
}

function propositionLabel(proposition) {
  return `${clean(proposition.siglaTipo)} ${proposition.numero}/${proposition.ano}`;
}

function propositionPublicUrl(propositionId) {
  return `https://www.camara.leg.br/propostas-legislativas/${encodeURIComponent(propositionId)}`;
}

function formatDatePtBr(value) {
  const iso = clean(value).slice(0, 10);
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : 'data não informada';
}

function truncateClaim(text) {
  if (text.length <= MAX_CLAIM_TEXT) return text;
  return `${text.slice(0, MAX_CLAIM_TEXT - 1).trimEnd()}…`;
}

function validateProposition(proposition) {
  const id = String(proposition.id ?? '');
  if (!/^\d+$/.test(id)) throw new Error('A API retornou proposição sem ID numérico.');
  if (!clean(proposition.siglaTipo) || !Number.isSafeInteger(Number(proposition.numero)) || !Number.isSafeInteger(Number(proposition.ano))) {
    throw new Error(`A proposição ${id} não tem identificação oficial completa.`);
  }
  if (!clean(proposition.ementa) || !normalizeBirthDate(clean(proposition.dataApresentacao).slice(0, 10))) {
    throw new Error(`A proposição ${id} não tem ementa ou data válida.`);
  }
  return id;
}

export function aggregateThemeResults(resultsByTheme) {
  const propositions = new Map();
  for (const { mapping, items } of resultsByTheme) {
    for (const proposition of items) {
      const id = validateProposition(proposition);
      if (!propositions.has(id)) {
        propositions.set(id, {
          ...proposition,
          siteThemes: new Map(),
        });
      }
      propositions.get(id).siteThemes.set(mapping.siteThemeId, mapping);
    }
  }
  return [...propositions.values()].sort((left, right) => {
    const dateOrder = clean(left.dataApresentacao).localeCompare(clean(right.dataApresentacao));
    return dateOrder || Number(left.id) - Number(right.id);
  });
}

async function fetchCandidatePropositions(match, options) {
  const base = validatedApiBase(options.apiBase);
  const years = [];
  for (let year = options.fromYear; year <= options.toYear; year += 1) years.push(String(year));
  const resultsByTheme = await mapLimit(THEME_MAPPING, 4, async (mapping) => {
    const url = new URL('proposicoes', base);
    const params = new URLSearchParams({
      idDeputadoAutor: match.chamberId,
      ano: years.join(','),
      codTema: mapping.chamberCodes.join(','),
      itens: '100',
      ordem: 'ASC',
      ordenarPor: 'id',
    });
    if (options.types.length) params.set('siglaTipo', options.types.join(','));
    url.search = params;
    return {
      mapping,
      items: await fetchAllPages(url, { apiBase: base, fetchImpl: options.fetchImpl }),
    };
  });
  const propositions = aggregateThemeResults(resultsByTheme);
  const verified = await mapLimit(propositions, 6, async (proposition) => {
    const authorsUrl = new URL(`proposicoes/${encodeURIComponent(proposition.id)}/autores`, base);
    const payload = await fetchApiJson(authorsUrl, { fetchImpl: options.fetchImpl });
    if (!Array.isArray(payload.dados)) throw new Error(`Autores da proposição ${proposition.id} não vieram em lista.`);
    const expectedUriSuffix = `/deputados/${match.chamberId}`;
    const author = payload.dados.find(({ uri }) => {
      try {
        return new URL(uri).pathname.endsWith(expectedUriSuffix);
      } catch {
        return false;
      }
    });
    return author ? { proposition, author } : null;
  });
  return {
    verified: verified.filter(Boolean),
    authorshipDiscrepancies: verified.filter((item) => !item).length,
  };
}

export function createEditorialDraft(match, verifiedPropositions, checkedAt) {
  const sources = {};
  const claims = [];
  for (const { proposition, author } of verifiedPropositions) {
    const propositionId = String(proposition.id);
    const sourceId = `camara-proposicao-${propositionId}`;
    const label = propositionLabel(proposition);
    const mappings = [...proposition.siteThemes.values()]
      .sort((left, right) => left.siteThemeId.localeCompare(right.siteThemeId));
    sources[sourceId] = {
      type: 'institutional-record',
      publisher: 'Câmara dos Deputados',
      title: `${label} — ficha da proposição`,
      url: propositionPublicUrl(propositionId),
      publishedAt: clean(proposition.dataApresentacao).slice(0, 10),
      checkedAt,
    };
    for (const mapping of mappings) {
      const authorWording = Number(author.proponente) === 1
        ? 'como proponente'
        : 'entre os autores';
      claims.push({
        id: `camara-${propositionId}-${mapping.siteThemeId}`,
        kind: 'track-record',
        themeId: mapping.siteThemeId,
        text: truncateClaim(
          `A Câmara dos Deputados registra ${match.chamberName} ${authorWording} de ${label}, apresentada em ${formatDatePtBr(proposition.dataApresentacao)}: ${clean(proposition.ementa)}`,
        ),
        attribution: 'institutional-record',
        sourceRefs: [sourceId],
        publicationState: 'draft',
      });
    }
  }
  return {
    candidateId: match.candidateId,
    review: { status: 'pending', methodVersion: 1 },
    claims,
    sources,
  };
}

function assertNoIdentitySecrets(output, candidates) {
  const serialized = JSON.stringify(output);
  const forbiddenKeys = /"(?:cpf|dataNascimento|birthDate|normalizedBirthDate)"\s*:/i;
  if (forbiddenKeys.test(serialized)) throw new Error('A saída contém um campo de identidade proibido.');
  for (const candidate of candidates) {
    if (serialized.includes(candidate.normalizedBirthDate)) {
      throw new Error(`A saída exporia data usada no pareamento de SQ_CANDIDATO ${candidate.candidateId}.`);
    }
  }
}

function themeCounts(drafts) {
  const counts = Object.fromEntries(THEME_MAPPING.map(({ siteThemeId }) => [siteThemeId, 0]));
  for (const draft of drafts) {
    for (const claim of draft.claims) counts[claim.themeId] += 1;
  }
  return counts;
}

function markdownCoverage(report) {
  const typeDescription = report.scope.types.length ? report.scope.types.join(', ') : 'todos os tipos';
  const lines = [
    '# Cobertura do piloto Câmara',
    '',
    `Consulta à API oficial: ${report.checkedAt}`,
    '',
    '## Identidade',
    '',
    `- Candidaturas de deputado federal por SP inseridas na urna: ${report.identity.tseCandidates}.`,
    `- Deputados de SP em exercício retornados pela Câmara: ${report.identity.currentDeputies}.`,
    `- Pareamentos fortes por nome civil + data de nascimento: ${report.identity.strongMatches}.`,
    `- Chaves ambíguas rejeitadas: ${report.identity.ambiguousCandidateIds.length} candidatura(s), ${report.identity.ambiguousDeputyIds.length} deputado(s).`,
    '',
    '## Conteúdo temático',
    '',
    `- Pareamentos processados nesta execução: ${report.content.processedMatches}.`,
    `- Tipos de proposição: ${typeDescription}.`,
    `- Proposições únicas com autoria reconfirmada: ${report.content.verifiedUniquePropositions}.`,
    `- Claims de rascunho: ${report.content.draftClaims}.`,
    `- Divergências no filtro de autoria: ${report.content.authorshipDiscrepancies}.`,
    '',
    '## Limitações',
    '',
    '- A classificação temática vem da Câmara; o vínculo com os temas do site usa apenas correspondências diretas e documentadas.',
    '- Autoria não equivale a voto, aprovação, prioridade, eficácia ou apoio a todo o conteúdo da proposição.',
    '- Coautoria é descrita como “entre os autores”; “proponente” só aparece quando o registro oficial traz esse indicador.',
    '- Estes arquivos são rascunhos. O importador não publica claims enquanto review.status for pending.',
    '- Datas de nascimento são usadas apenas em memória para desambiguação e não aparecem na saída.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function runPilot(options) {
  const candidatePath = resolve(options.candidatePath);
  const complementPath = resolve(options.complementPath);
  const outputDir = resolve(options.outputDir);
  const checkedAt = options.checkedAt || new Date().toISOString();
  if (Number.isNaN(Date.parse(checkedAt))) throw new Error('--checked-at precisa ser uma data ISO válida.');
  if (await pathExists(outputDir)) throw new Error(`A pasta de saída já existe: ${outputDir}`);
  if (!Number.isSafeInteger(options.fromYear) || !Number.isSafeInteger(options.toYear) || options.fromYear > options.toYear) {
    throw new Error('Intervalo de anos inválido.');
  }

  const [candidateBuffer, complementBuffer] = await Promise.all([
    readFile(candidatePath),
    readFile(complementPath),
  ]);
  const candidates = selectTseCandidates(
    parseSemicolonCsv(decodeCsv(candidateBuffer, options.encoding)),
    parseSemicolonCsv(decodeCsv(complementBuffer, options.encoding)),
  );
  const deputyDetails = await fetchCurrentDeputies({
    apiBase: options.apiBase,
    fetchImpl: options.fetchImpl,
  });
  const identity = matchCandidatesToDeputies(candidates, deputyDetails);
  const limit = options.maxMatches == null
    ? identity.matches.length
    : Math.min(options.maxMatches, identity.matches.length);
  const matchesToProcess = options.identityOnly ? [] : identity.matches.slice(0, limit);
  const contentResults = await mapLimit(matchesToProcess, 2, async (match) => {
    const result = await fetchCandidatePropositions(match, options);
    return {
      match,
      ...result,
      draft: createEditorialDraft(match, result.verified, checkedAt),
    };
  });
  const drafts = contentResults.map(({ draft }) => draft);
  const report = {
    schemaVersion: 1,
    checkedAt,
    sources: {
      tse: 'https://dadosabertos.tse.jus.br/dataset/candidatos-2026',
      camaraApi: new URL('', validatedApiBase(options.apiBase)).href,
      camaraApiDocumentation: 'https://dadosabertos.camara.leg.br/swagger/api.html',
    },
    scope: {
      electionYear: 2026,
      uf: DEFAULT_UF,
      office: 'deputado-federal',
      propositionYears: [options.fromYear, options.toYear],
      types: options.types,
      identityOnly: options.identityOnly,
      maxMatches: options.maxMatches,
    },
    method: {
      identity: 'Nome civil e data de nascimento iguais após normalização Unicode e de pontuação; relação obrigatoriamente 1:1.',
      authorship: 'Filtro idDeputadoAutor e confirmação no endpoint /proposicoes/{id}/autores.',
      publication: 'review.status=pending e publicationState=draft; revisão humana obrigatória.',
      sensitiveDataWritten: false,
    },
    identity: {
      tseCandidates: candidates.length,
      currentDeputies: deputyDetails.length,
      deputiesWithUsableIdentity: identity.deputiesWithUsableIdentity,
      strongMatches: identity.matches.length,
      ambiguousCandidateIds: identity.ambiguousCandidateIds,
      ambiguousDeputyIds: identity.ambiguousDeputyIds,
      matchedCandidates: identity.matches.map(({ candidateId, displayName, chamberId, chamberName }) => ({
        candidateId, displayName, chamberId, chamberName,
      })),
    },
    content: {
      processedMatches: matchesToProcess.length,
      candidatesWithAtLeastOneClaim: drafts.filter(({ claims }) => claims.length).length,
      verifiedUniquePropositions: drafts.reduce((total, draft) => total + Object.keys(draft.sources).length, 0),
      draftClaims: drafts.reduce((total, draft) => total + draft.claims.length, 0),
      authorshipDiscrepancies: contentResults.reduce((total, result) => total + result.authorshipDiscrepancies, 0),
      claimsByTheme: themeCounts(drafts),
      generatedDrafts: drafts.map((draft) => ({
        candidateId: draft.candidateId,
        claims: draft.claims.length,
        sources: Object.keys(draft.sources).length,
      })),
    },
    unmappedSiteThemes: ['custo-de-vida', 'moradia', 'transparencia'],
  };
  assertNoIdentitySecrets({ drafts, report }, candidates);

  const temporaryDir = `${outputDir}.tmp-${process.pid}`;
  if (await pathExists(temporaryDir)) throw new Error(`A pasta temporária já existe: ${temporaryDir}`);
  try {
    await mkdir(join(temporaryDir, 'drafts'), { recursive: true });
    for (const draft of drafts) {
      await writeJson(join(temporaryDir, 'drafts', `${draft.candidateId}.json`), draft);
    }
    await writeJson(join(temporaryDir, 'coverage.json'), report);
    await writeFile(join(temporaryDir, 'COVERAGE.md'), markdownCoverage(report), 'utf8');
    await rename(temporaryDir, outputDir);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
  return { outputDir, drafts, report };
}

export function parseArguments(argv) {
  const options = {
    candidatePath: null,
    complementPath: null,
    outputDir: null,
    checkedAt: null,
    fromYear: DEFAULT_FROM_YEAR,
    toYear: DEFAULT_TO_YEAR,
    types: [],
    maxMatches: null,
    identityOnly: false,
    encoding: 'windows-1252',
    apiBase: DEFAULT_API_BASE,
  };
  const takeValue = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} precisa de um valor.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--candidates') {
      options.candidatePath = takeValue(argument, index);
      index += 1;
    } else if (argument === '--complement') {
      options.complementPath = takeValue(argument, index);
      index += 1;
    } else if (argument === '--output') {
      options.outputDir = takeValue(argument, index);
      index += 1;
    } else if (argument === '--checked-at') {
      options.checkedAt = takeValue(argument, index);
      index += 1;
    } else if (argument === '--from-year') {
      options.fromYear = Number(takeValue(argument, index));
      index += 1;
    } else if (argument === '--to-year') {
      options.toYear = Number(takeValue(argument, index));
      index += 1;
    } else if (argument === '--types') {
      const raw = takeValue(argument, index);
      options.types = raw.toLocaleLowerCase('pt-BR') === 'all'
        ? []
        : raw.split(',').map((type) => clean(type).toLocaleUpperCase('pt-BR')).filter(Boolean);
      index += 1;
    } else if (argument === '--max-matches') {
      options.maxMatches = Number(takeValue(argument, index));
      index += 1;
    } else if (argument === '--identity-only') options.identityOnly = true;
    else if (argument === '--encoding') {
      options.encoding = takeValue(argument, index);
      index += 1;
    } else if (argument === '--api-base') {
      options.apiBase = takeValue(argument, index);
      index += 1;
    } else throw new Error(`Opção desconhecida: ${argument}`);
  }
  if (!options.help) {
    if (!options.candidatePath) throw new Error('Informe --candidates.');
    if (!options.complementPath) throw new Error('Informe --complement.');
    if (!options.outputDir) throw new Error('Informe uma pasta nova em --output.');
    if (options.maxMatches !== null && (!Number.isSafeInteger(options.maxMatches) || options.maxMatches < 1)) {
      throw new Error('--max-matches deve ser um inteiro positivo.');
    }
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    const { outputDir, report } = await runPilot(options);
    process.stdout.write([
      `Piloto criado: ${outputDir}`,
      `Pareamentos fortes: ${report.identity.strongMatches}`,
      `Pareamentos processados: ${report.content.processedMatches}`,
      `Claims em rascunho: ${report.content.draftClaims}`,
      'Nenhum claim foi marcado para publicação.',
      '',
    ].join('\n'));
  } catch (error) {
    process.stderr.write(`Erro: ${error.message}\n\nUse --help para ver os parâmetros.\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
