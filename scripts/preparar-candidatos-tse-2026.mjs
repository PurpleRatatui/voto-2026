#!/usr/bin/env node

import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, 'data', 'releases');
const DEFAULT_SOURCE_URL = 'https://dadosabertos.tse.jus.br/dataset/candidatos-2026';
const GENERAL_ELECTION_ID_2026 = '20322002026';
const ALLOWED_UFS = new Set([
  'BR', 'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT',
  'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR',
  'SC', 'SP', 'SE', 'TO',
]);
const OFFICE_BY_CODE = new Map([
  ['1', { slug: 'presidencia', label: 'Presidência' }],
  ['3', { slug: 'governador', label: 'Governo do estado' }],
  ['5', { slug: 'senador', label: 'Senado' }],
  ['6', { slug: 'deputado-federal', label: 'Câmara dos Deputados' }],
  ['7', { slug: 'deputado-estadual', label: 'Assembleia Legislativa' }],
  ['8', { slug: 'deputado-distrital', label: 'Câmara Legislativa do Distrito Federal' }],
]);
const OFFICE_ORDER = [...OFFICE_BY_CODE.values()].map(({ slug }) => slug);
const PHOTO_EXTENSIONS = new Set(['.avif', '.jpg', '.jpeg', '.png', '.webp']);
const CARD_FORBIDDEN_FIELDS = new Set([
  'party', 'partido', 'number', 'numero', 'status', 'electionData', 'networks',
]);
const ALLOWED_EDITORIAL_THEMES = new Set([
  'saude',
  'educacao',
  'seguranca',
  'emprego-e-renda',
  'custo-de-vida',
  'meio-ambiente',
  'moradia',
  'transporte',
  'transparencia',
  'tecnologia',
]);
const EDITORIAL_THEME_LABELS = new Map([
  ['saude', 'Saúde'],
  ['educacao', 'Educação'],
  ['seguranca', 'Segurança'],
  ['emprego-e-renda', 'Emprego e renda'],
  ['custo-de-vida', 'Custo de vida'],
  ['meio-ambiente', 'Meio ambiente'],
  ['moradia', 'Moradia'],
  ['transporte', 'Transporte'],
  ['transparencia', 'Transparência'],
  ['tecnologia', 'Tecnologia'],
]);
const ALLOWED_EDITORIAL_REVIEW_STATUSES = new Set(['reviewed', 'partial', 'pending']);
const ALLOWED_EDITORIAL_CLAIM_KINDS = new Set(['track-record', 'position', 'proposal']);
const ALLOWED_EDITORIAL_ATTRIBUTIONS = new Set([
  'institutional-record', 'candidate-declared', 'mixed-sources',
]);
const ALLOWED_EDITORIAL_SOURCE_TYPES = new Set([
  'institutional-record', 'candidate-declared', 'official-document', 'journalism',
]);
const ALLOWED_EDITORIAL_PUBLICATION_STATES = new Set(['draft', 'published']);
const MAX_PUBLISHED_EDITORIAL_CLAIMS = 30;
const UNREVIEWED_CARD_SUMMARY = 'Este perfil ainda não tem conteúdo temático revisado. Isso não significa ausência de propostas.';

const HELP = `
Prepara uma release estática a partir dos CSVs oficiais de candidaturas do TSE.

Uso:
  node scripts/preparar-candidatos-tse-2026.mjs \\
    --release 2026-09-17T1200-0300 \\
    --input /caminho/consulta_cand_2026_BR.csv \\
    --input /caminho/consulta_cand_2026_SP.csv \\
    --complement /caminho/consulta_cand_complementar_2026_BR.csv \\
    --complement /caminho/consulta_cand_complementar_2026_SP.csv \\
    [--social /caminho/rede_social_candidato_2026_BR.csv] \\
    [--social /caminho/rede_social_candidato_2026_SP.csv] \\
    [--proposals-dir /caminho/propostas/BR] \\
    [--proposals-dir /caminho/propostas/SP] \\
    [--editorial-dir /caminho/conteudo-editorial] \\
    [--photos-dir /caminho/fotos] \\
    [--output data/releases] \\
    [--generated-at 2026-09-17T12:00:00-03:00] \\
    [--encoding windows-1252]

Opções:
  --release ID        Identificador novo e imutável da release (obrigatório).
  --input ARQUIVO     CSV oficial do TSE. Pode ser repetido; posicionais também valem.
  --complement ARQ.   CSV oficial complementar. Pode ser repetido (obrigatório).
  --social ARQUIVO    CSV oficial de redes. Pode ser repetido (opcional).
  --proposals-dir DIR Pasta plana com PDFs oficiais. Pode ser repetido (opcional).
  --editorial-dir DIR Pasta plana com um JSON editorial por candidatura (opcional).
  --photos-dir PASTA  Pasta opcional com fotos SQ_CANDIDATO.ext ou FUF{SQ}_div.ext.
  --output PASTA      Pasta de releases. Padrão: data/releases deste projeto.
  --generated-at ISO  Data da importação. Padrão: instante atual em UTC.
  --encoding NOME     windows-1252 (padrão), latin1 ou utf-8.
  --source-url URL    URL pública da base de origem no manifesto.
  --help              Mostra esta ajuda.

A release existente nunca é substituída. O arquivo data/current.json não é alterado;
publique e revise a release antes de apontar current.json para ela.
`;

function clean(value) {
  return String(value ?? '').trim();
}

function cleanPublicText(value) {
  const normalized = clean(value).replace(/\s+/g, ' ');
  if (!normalized || /^#?(?:NE|NULO|N[AÃ]O INFORMADO)#?$/i.test(normalized)) return null;
  return toDisplayName(normalized);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowedKeys, context) {
  if (!isPlainObject(value)) throw new Error(`${context} deve ser um objeto.`);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) {
    throw new Error(`${context} contém campos não permitidos: ${unexpected.join(', ')}.`);
  }
}

function assertEditorialText(value, context, { min = 1, max = 1200 } = {}) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) {
    throw new Error(`${context} deve ter entre ${min} e ${max} caracteres, sem espaços nas pontas.`);
  }
}

function safeEditorialUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isInstitutionalEditorialUrl(value) {
  const hostname = new URL(value).hostname.toLocaleLowerCase('en-US');
  return ['gov.br', 'leg.br', 'jus.br'].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function normalizeCode(value) {
  const normalized = clean(value).replace(/^0+/, '');
  return normalized || '0';
}

function assertReleaseId(releaseId) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error('O ID da release deve usar apenas letras, números, ponto, hífen ou sublinhado.');
  }
}

function assertIsoDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`Data inválida em --generated-at: ${value || '(vazia)'}`);
  }
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

function decodeCsv(buffer, encoding) {
  const aliases = {
    'windows-1252': 'windows-1252',
    cp1252: 'windows-1252',
    latin1: 'windows-1252',
    'iso-8859-1': 'windows-1252',
    'utf-8': 'utf-8',
    utf8: 'utf-8',
  };
  const decoderName = aliases[String(encoding).toLowerCase()];
  if (!decoderName) {
    throw new Error(`Codificação não suportada: ${encoding}. Use windows-1252, latin1 ou utf-8.`);
  }
  return new TextDecoder(decoderName).decode(buffer).replace(/^\uFEFF/, '');
}

/**
 * Parser de CSV que aceita ponto e vírgula, aspas duplicadas e quebras de linha
 * dentro de campos entre aspas. Retorna objetos indexados pelo cabeçalho.
 */
export function parseTseCsv(text) {
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

  if (quoted) throw new Error('CSV inválido: há um campo entre aspas sem fechamento.');
  if (field !== '' || row.length > 0) finishRow();
  if (rows.length === 0) return [];

  const headers = rows.shift().map((header, index) => {
    const value = clean(header).replace(index === 0 ? /^\uFEFF/ : /$^/, '');
    if (!value) throw new Error(`CSV inválido: cabeçalho vazio na coluna ${index + 1}.`);
    return value;
  });
  if (new Set(headers).size !== headers.length) {
    throw new Error('CSV inválido: há nomes de colunas repetidos no cabeçalho.');
  }

  return rows.map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw new Error(`CSV inválido: a linha ${rowIndex + 2} tem colunas além do cabeçalho.`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']));
  });
}

function validateHeaders(rows, inputPath) {
  if (!rows.length) throw new Error(`O CSV está vazio: ${inputPath}`);
  const headers = new Set(Object.keys(rows[0]));
  const required = [
    'NR_TURNO', 'CD_CARGO', 'SG_UF', 'SQ_CANDIDATO', 'NM_URNA_CANDIDATO',
    'NR_CANDIDATO', 'SG_PARTIDO', 'DS_OCUPACAO', 'DS_GRAU_INSTRUCAO',
  ];
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) {
    throw new Error(`Faltam colunas obrigatórias em ${inputPath}: ${missing.join(', ')}`);
  }
}

function validateComplementHeaders(rows, inputPath) {
  if (!rows.length) throw new Error(`O CSV complementar está vazio: ${inputPath}`);
  const headers = new Set(Object.keys(rows[0]));
  const required = [
    'SQ_CANDIDATO', 'ST_CANDIDATO_INSERIDO_URNA', 'DS_SITUACAO_JULGAMENTO',
    'NR_IDADE_DATA_POSSE',
  ];
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) {
    throw new Error(`Faltam colunas obrigatórias em ${inputPath}: ${missing.join(', ')}`);
  }
}

function validateSocialHeaders(rows, inputPath) {
  if (!rows.length) throw new Error(`O CSV de redes sociais está vazio: ${inputPath}`);
  const headers = new Set(Object.keys(rows[0]));
  const required = ['SQ_CANDIDATO', 'NR_ORDEM_REDE_SOCIAL', 'DS_URL'];
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) {
    throw new Error(`Faltam colunas obrigatórias em ${inputPath}: ${missing.join(', ')}`);
  }
}

function toDisplayName(rawName) {
  const name = clean(rawName).replace(/\s+/g, ' ');
  if (!name) return '';
  const hasLowercase = /\p{Ll}/u.test(name);
  if (hasLowercase) return name;

  const lowerWords = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
  return name.toLocaleLowerCase('pt-BR').split(' ').map((word, index) => {
    if (index > 0 && lowerWords.has(word)) return word;
    return word.replace(/(^|[-'])\p{L}/gu, (letter) => letter.toLocaleUpperCase('pt-BR'));
  }).join(' ');
}

function initialsFor(name) {
  const words = clean(name).split(/\s+/).filter(Boolean);
  if (!words.length) return '—';
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toLocaleUpperCase('pt-BR');
  return `${[...words[0]][0]}${[...words.at(-1)][0]}`.toLocaleUpperCase('pt-BR');
}

function candidateRecordUrl(row, sourceUrl) {
  const election = GENERAL_ELECTION_ID_2026;
  const year = clean(row.ANO_ELEICAO || row.NR_ANO_ELEICAO);
  const uf = clean(row.SG_UF).toLocaleUpperCase('pt-BR');
  const electoralUnit = clean(row.SG_UE || uf).toLocaleUpperCase('pt-BR');
  const id = clean(row.SQ_CANDIDATO);
  if (!election || !year || !electoralUnit || !id) return sourceUrl;
  const segments = [electoralUnit, uf, election, id, year, electoralUnit]
    .map((segment) => encodeURIComponent(segment));
  return `https://divulgacandcontas.tse.jus.br/divulga/#/candidato/${segments.join('/')}`;
}

function publicStatus(value) {
  const status = clean(value);
  return !status || /^#?(?:NE|NULO)#?$/i.test(status)
    ? 'Ainda não informado no arquivo aberto do TSE'
    : status;
}

function publicAgeAtTakingOffice(value, candidateId) {
  const raw = clean(value);
  if (!raw || /^#?(?:NE|NULO)#?$/i.test(raw)) return null;
  if (!/^\d{1,3}$/.test(raw)) {
    throw new Error(`Idade na data da posse inválida para SQ_CANDIDATO ${candidateId}: ${raw}.`);
  }
  const age = Number(raw);
  if (!Number.isSafeInteger(age) || age < 16 || age > 120) {
    throw new Error(`Idade na data da posse fora do intervalo esperado para SQ_CANDIDATO ${candidateId}: ${raw}.`);
  }
  return age;
}

function normalizeCandidate(row, sourceUrl) {
  const cargoCode = normalizeCode(row.CD_CARGO);
  const office = OFFICE_BY_CODE.get(cargoCode);
  if (!office || normalizeCode(row.NR_TURNO) !== '1') return null;

  const id = clean(row.SQ_CANDIDATO);
  const uf = clean(row.SG_UF).toLocaleUpperCase('pt-BR');
  const name = toDisplayName(row.NM_URNA_CANDIDATO || row.NM_CANDIDATO);
  if (!/^\d+$/.test(id)) throw new Error(`SQ_CANDIDATO inválido: ${id || '(vazio)'}`);
  if (!ALLOWED_UFS.has(uf)) throw new Error(`SG_UF inválida para ${id}: ${uf || '(vazia)'}`);
  if (cargoCode === '1' && uf !== 'BR') {
    throw new Error(`Candidatura à Presidência com SG_UF diferente de BR: ${id} (${uf}).`);
  }
  if (cargoCode !== '1' && uf === 'BR') {
    throw new Error(`Cargo estadual com SG_UF igual a BR: ${id} (${office.slug}).`);
  }
  if (!name) throw new Error(`Nome de urna vazio para SQ_CANDIDATO ${id}.`);

  return {
    id,
    name,
    officialName: clean(row.NM_CANDIDATO),
    office: office.slug,
    officeLabel: office.label,
    uf,
    party: clean(row.SG_PARTIDO),
    number: clean(row.NR_CANDIDATO),
    occupation: cleanPublicText(row.DS_OCUPACAO),
    education: cleanPublicText(row.DS_GRAU_INSTRUCAO),
    candidateRecord: candidateRecordUrl(row, sourceUrl),
  };
}

function sameCandidate(left, right) {
  return [
    'id', 'name', 'officialName', 'office', 'uf', 'party', 'number', 'status',
    'occupation', 'education', 'ageAtTakingOffice', 'candidateRecord',
  ]
    .every((field) => left[field] === right[field]);
}

async function loadComplements(complementPaths, encoding) {
  const complements = new Map();
  let complementRows = 0;

  for (const complementPath of complementPaths) {
    const resolvedInput = resolve(complementPath);
    const rows = parseTseCsv(decodeCsv(await readFile(resolvedInput), encoding));
    validateComplementHeaders(rows, resolvedInput);
    complementRows += rows.length;
    for (const row of rows) {
      const id = clean(row.SQ_CANDIDATO);
      if (!/^\d+$/.test(id)) {
        throw new Error(`SQ_CANDIDATO inválido no CSV complementar: ${id || '(vazio)'}`);
      }
      const complement = {
        insertedOnBallot: clean(row.ST_CANDIDATO_INSERIDO_URNA).toLocaleUpperCase('pt-BR'),
        judgmentStatus: publicStatus(row.DS_SITUACAO_JULGAMENTO),
        ageAtTakingOffice: publicAgeAtTakingOffice(row.NR_IDADE_DATA_POSSE, id),
      };
      const previous = complements.get(id);
      if (previous && (
        previous.insertedOnBallot !== complement.insertedOnBallot
        || previous.judgmentStatus !== complement.judgmentStatus
        || previous.ageAtTakingOffice !== complement.ageAtTakingOffice
      )) {
        throw new Error(`SQ_CANDIDATO ${id} aparece com dados conflitantes nos CSVs complementares.`);
      }
      complements.set(id, complement);
    }
  }

  return { complements, complementRows };
}

function normalizeDeclaredSocialUrl(rawValue) {
  try {
    const url = new URL(clean(rawValue));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function socialLabel(urlValue) {
  const hostname = new URL(urlValue).hostname.toLocaleLowerCase('en-US').replace(/^www\./, '');
  const isHost = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);
  const platforms = [
    [['instagram.com'], 'Instagram'],
    [['facebook.com', 'facebook.com.br'], 'Facebook'],
    [['x.com', 'twitter.com'], 'X'],
    [['youtube.com', 'youtu.be'], 'YouTube'],
    [['tiktok.com'], 'TikTok'],
    [['linkedin.com'], 'LinkedIn'],
    [['threads.net', 'threads.com'], 'Threads'],
    [['bsky.app', 'bsky.social'], 'Bluesky'],
    [['whatsapp.com', 'wa.me'], 'WhatsApp'],
    [['kwai.com', 'kwai-video.com'], 'Kwai'],
    [['telegram.me', 't.me'], 'Telegram'],
  ];
  const match = platforms.find(([domains]) => domains.some(isHost));
  return match ? match[1] : `Site em ${hostname}`;
}

async function loadSocialIndex(socialPaths, encoding) {
  const rowsByCandidate = new Map();
  let socialRows = 0;
  let sequence = 0;

  for (const socialPath of socialPaths) {
    const resolvedInput = resolve(socialPath);
    const rows = parseTseCsv(decodeCsv(await readFile(resolvedInput), encoding));
    validateSocialHeaders(rows, resolvedInput);
    socialRows += rows.length;
    for (const row of rows) {
      const id = clean(row.SQ_CANDIDATO);
      if (!/^\d+$/.test(id)) {
        throw new Error(`SQ_CANDIDATO inválido no CSV de redes sociais: ${id || '(vazio)'}`);
      }
      const rawOrder = clean(row.NR_ORDEM_REDE_SOCIAL);
      const numericOrder = Number(rawOrder);
      const order = Number.isSafeInteger(numericOrder) && numericOrder >= 0
        ? numericOrder
        : Number.MAX_SAFE_INTEGER;
      if (!rowsByCandidate.has(id)) rowsByCandidate.set(id, []);
      rowsByCandidate.get(id).push({ order, sequence, rawUrl: row.DS_URL });
      sequence += 1;
    }
  }

  for (const rows of rowsByCandidate.values()) {
    rows.sort((left, right) => left.order - right.order || left.sequence - right.sequence);
  }
  return { rowsByCandidate, socialRows };
}

function networksForCandidate(candidateId, socialIndex, socialImported) {
  if (!socialImported) {
    return { networks: { state: 'not-imported', items: [] }, accepted: 0, rejected: 0, matched: 0 };
  }

  const rows = socialIndex.get(candidateId) || [];
  const seen = new Set();
  const items = [];
  let rejected = 0;
  for (const row of rows) {
    const url = normalizeDeclaredSocialUrl(row.rawUrl);
    if (!url || seen.has(url)) {
      rejected += 1;
      continue;
    }
    seen.add(url);
    items.push({ label: socialLabel(url), url });
  }
  return {
    networks: { state: 'available', items },
    accepted: items.length,
    rejected,
    matched: rows.length,
  };
}

async function loadCandidates(inputPaths, complements, encoding, sourceUrl) {
  const candidates = new Map();
  let inputRows = 0;
  let ignoredRows = 0;
  let excludedWithoutComplement = 0;
  let excludedNotOnBallot = 0;

  for (const inputPath of inputPaths) {
    const resolvedInput = resolve(inputPath);
    const rows = parseTseCsv(decodeCsv(await readFile(resolvedInput), encoding));
    validateHeaders(rows, resolvedInput);
    inputRows += rows.length;
    for (const row of rows) {
      const candidate = normalizeCandidate(row, sourceUrl);
      if (!candidate) {
        ignoredRows += 1;
        continue;
      }
      const complement = complements.get(candidate.id);
      if (!complement) {
        excludedWithoutComplement += 1;
        continue;
      }
      if (complement.insertedOnBallot !== 'SIM') {
        excludedNotOnBallot += 1;
        continue;
      }
      candidate.status = complement.judgmentStatus;
      candidate.ageAtTakingOffice = complement.ageAtTakingOffice;
      const previous = candidates.get(candidate.id);
      if (previous && !sameCandidate(previous, candidate)) {
        throw new Error(`SQ_CANDIDATO ${candidate.id} aparece com dados conflitantes nos CSVs.`);
      }
      candidates.set(candidate.id, candidate);
    }
  }

  if (candidates.size === 0) {
    throw new Error('Nenhuma candidatura confirmada para a urna foi encontrada nos cargos aceitos.');
  }
  return {
    candidates: [...candidates.values()],
    inputRows,
    ignoredRows,
    excludedWithoutComplement,
    excludedNotOnBallot,
  };
}

async function loadPhotoIndex(photosDir) {
  if (!photosDir) return new Map();
  const resolvedDir = resolve(photosDir);
  const directoryEntries = await readdir(resolvedDir, { withFileTypes: true });
  const photos = new Map();
  for (const entry of directoryEntries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLocaleLowerCase('en-US');
    const stem = basename(entry.name, extname(entry.name));
    const officialPhotoMatch = stem.match(/^F[A-Z]{2}(\d+)_div$/i);
    const id = officialPhotoMatch?.[1] || stem;
    if (!/^\d+$/.test(id) || !PHOTO_EXTENSIONS.has(extension)) continue;
    if (photos.has(id)) {
      throw new Error(`Há mais de uma foto para SQ_CANDIDATO ${id} em ${resolvedDir}.`);
    }
    const sourcePath = join(resolvedDir, entry.name);
    const metadata = await stat(sourcePath);
    if (metadata.size === 0) throw new Error(`A foto de SQ_CANDIDATO ${id} está vazia.`);
    photos.set(id, { sourcePath, extension });
  }
  return photos;
}

async function loadProposalIndex(proposalDirectories) {
  const documentsByCandidate = new Map();
  const documentsByKey = new Map();
  const seenSourcePaths = new Set();
  let proposalFilesFound = 0;
  let proposalFilesSkippedEmpty = 0;

  for (const proposalDirectory of proposalDirectories) {
    const resolvedDir = resolve(proposalDirectory);
    const directoryEntries = await readdir(resolvedDir, { withFileTypes: true });
    for (const entry of directoryEntries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^2026([A-Z]{2})(\d+)_(\d+)\.pdf$/i);
      if (!match) continue;
      const sourcePath = join(resolvedDir, entry.name);
      if (seenSourcePaths.has(sourcePath)) continue;
      seenSourcePaths.add(sourcePath);
      proposalFilesFound += 1;

      const [, rawUf, id, rawOrder] = match;
      const uf = rawUf.toLocaleUpperCase('pt-BR');
      const order = Number(rawOrder);
      if (!ALLOWED_UFS.has(uf)) {
        throw new Error(`UF inválida no documento de proposta: ${entry.name}`);
      }
      if (!Number.isSafeInteger(order) || order < 0) {
        throw new Error(`Ordem inválida no documento de proposta: ${entry.name}`);
      }
      const metadata = await stat(sourcePath);
      if (metadata.size === 0) {
        proposalFilesSkippedEmpty += 1;
        continue;
      }

      const documentKey = `${uf}/${id}/${order}`;
      if (documentsByKey.has(documentKey)) {
        throw new Error(`Há mais de um documento para ${uf}/${id}, ordem ${order}.`);
      }
      const document = { sourcePath, filename: entry.name, uf, id, order };
      documentsByKey.set(documentKey, document);
      const candidateKey = `${uf}/${id}`;
      if (!documentsByCandidate.has(candidateKey)) documentsByCandidate.set(candidateKey, []);
      documentsByCandidate.get(candidateKey).push(document);
    }
  }

  for (const documents of documentsByCandidate.values()) {
    documents.sort((left, right) => left.order - right.order || left.filename.localeCompare(right.filename));
  }
  return {
    documentsByCandidate,
    proposalFilesFound,
    proposalFilesSkippedEmpty,
    proposalDocumentsAvailable: documentsByKey.size,
  };
}

function proposalDocumentItem(publicPath, position, total) {
  return {
    state: 'document-found',
    title: total === 1 ? 'Proposta apresentada à Justiça Eleitoral' : `Documento oficial ${position + 1} de ${total}`,
    text: 'Este documento foi apresentado à Justiça Eleitoral e pode ser consultado na íntegra. Ainda não publicamos uma síntese temática dele.',
    sourceLabel: 'Documento apresentado à Justiça Eleitoral (PDF)',
    sourceUrl: publicPath,
  };
}

function proposalPlaceholder(office) {
  if (office === 'presidencia' || office === 'governador') {
    return {
      state: 'not-indexed',
      title: 'Documento de propostas não localizado',
      text: 'Não localizamos um documento de propostas no pacote oficial importado. Isso não permite concluir que a candidatura não tenha apresentado propostas.',
      sourceLabel: 'Ficha oficial da candidatura',
    };
  }
  return {
    state: 'not-indexed',
    title: 'Conteúdo programático ainda não publicado',
    text: 'Este perfil ainda não tem propostas verificadas e publicadas. Para cargos legislativos, não há plano de governo obrigatório no TSE.',
    sourceLabel: 'Ficha oficial da candidatura',
  };
}

function assertEditorialDate(value, context) {
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const dateTime = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const datePart = typeof value === 'string' ? value.slice(0, 10) : '';
  const calendarTimestamp = Date.parse(`${datePart}T00:00:00Z`);
  const validCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
    && !Number.isNaN(calendarTimestamp)
    && new Date(calendarTimestamp).toISOString().slice(0, 10) === datePart;
  if ((!dateOnly && !dateTime) || Number.isNaN(parsed) || !validCalendarDate) {
    throw new Error(`${context} deve ser uma data ISO válida.`);
  }
}

function validateEditorialSourceRefs(value, sources, context, { required = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${context} deve ser uma lista.`);
  if (required && value.length === 0) throw new Error(`${context} precisa indicar ao menos uma fonte.`);
  if (new Set(value).size !== value.length) throw new Error(`${context} contém fontes repetidas.`);
  for (const sourceId of value) {
    if (typeof sourceId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(sourceId)) {
      throw new Error(`${context} contém um identificador de fonte inválido.`);
    }
    if (!Object.hasOwn(sources, sourceId)) {
      throw new Error(`${context} referencia a fonte inexistente ${sourceId}.`);
    }
  }
  return [...value];
}

function normalizeEditorialDocument(rawDocument, filePath) {
  const context = `Editorial ${basename(filePath)}`;
  assertOnlyKeys(rawDocument, new Set(['candidateId', 'review', 'summary', 'claims', 'sources']), context);

  const candidateId = rawDocument.candidateId;
  if (typeof candidateId !== 'string' || !/^\d+$/.test(candidateId)) {
    throw new Error(`${context}: candidateId deve conter somente números.`);
  }
  if (basename(filePath) !== `${candidateId}.json`) {
    throw new Error(`${context}: o nome do arquivo deve ser ${candidateId}.json.`);
  }

  const reviewContext = `${context}, review`;
  assertOnlyKeys(rawDocument.review, new Set(['status', 'reviewedAt', 'methodVersion']), reviewContext);
  const { status, reviewedAt, methodVersion } = rawDocument.review;
  if (!ALLOWED_EDITORIAL_REVIEW_STATUSES.has(status)) {
    throw new Error(`${reviewContext}.status inválido: ${status || '(vazio)'}.`);
  }
  if (!Number.isSafeInteger(methodVersion) || methodVersion < 1) {
    throw new Error(`${reviewContext}.methodVersion deve ser um inteiro positivo.`);
  }
  if (status === 'pending') {
    if (reviewedAt !== undefined && reviewedAt !== null) {
      throw new Error(`${reviewContext}.reviewedAt deve ficar ausente enquanto o status for pending.`);
    }
  } else {
    assertEditorialDate(reviewedAt, `${reviewContext}.reviewedAt`);
  }

  const sourcesContext = `${context}, sources`;
  if (!isPlainObject(rawDocument.sources)) throw new Error(`${sourcesContext} deve ser um objeto.`);
  const sources = {};
  for (const [sourceId, source] of Object.entries(rawDocument.sources)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(sourceId)) {
      throw new Error(`${sourcesContext} contém o identificador inválido ${sourceId}.`);
    }
    const sourceContext = `${sourcesContext}.${sourceId}`;
    assertOnlyKeys(
      source,
      new Set(['type', 'publisher', 'title', 'url', 'publishedAt', 'checkedAt', 'locator']),
      sourceContext,
    );
    if (!ALLOWED_EDITORIAL_SOURCE_TYPES.has(source.type)) {
      throw new Error(`${sourceContext}.type inválido: ${source.type || '(vazio)'}.`);
    }
    assertEditorialText(source.publisher, `${sourceContext}.publisher`, { max: 160 });
    assertEditorialText(source.title, `${sourceContext}.title`, { max: 240 });
    const safeUrl = safeEditorialUrl(source.url);
    if (!safeUrl) throw new Error(`${sourceContext}.url deve ser HTTP ou HTTPS, sem credenciais.`);
    if (['institutional-record', 'official-document'].includes(source.type) && !isInstitutionalEditorialUrl(safeUrl)) {
      throw new Error(`${sourceContext}.url institucional deve usar domínio .gov.br, .leg.br ou .jus.br.`);
    }
    assertEditorialDate(source.checkedAt, `${sourceContext}.checkedAt`);
    if (source.publishedAt !== undefined) assertEditorialDate(source.publishedAt, `${sourceContext}.publishedAt`);
    if (source.locator !== undefined) {
      assertEditorialText(source.locator, `${sourceContext}.locator`, { max: 160 });
    }
    sources[sourceId] = { ...source, url: safeUrl };
  }

  if (!Array.isArray(rawDocument.claims)) throw new Error(`${context}.claims deve ser uma lista.`);
  const claimIds = new Set();
  const claims = rawDocument.claims.map((claim, index) => {
    const claimContext = `${context}, claims[${index}]`;
    assertOnlyKeys(
      claim,
      new Set(['id', 'kind', 'themeId', 'text', 'attribution', 'sourceRefs', 'publicationState']),
      claimContext,
    );
    if (typeof claim.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(claim.id)) {
      throw new Error(`${claimContext}.id inválido.`);
    }
    if (claimIds.has(claim.id)) throw new Error(`${context} repete o claim ${claim.id}.`);
    claimIds.add(claim.id);
    if (!ALLOWED_EDITORIAL_CLAIM_KINDS.has(claim.kind)) {
      throw new Error(`${claimContext}.kind inválido: ${claim.kind || '(vazio)'}.`);
    }
    if (!ALLOWED_EDITORIAL_THEMES.has(claim.themeId)) {
      throw new Error(`${claimContext}.themeId inválido: ${claim.themeId || '(vazio)'}.`);
    }
    assertEditorialText(claim.text, `${claimContext}.text`, { min: 10 });
    if (!ALLOWED_EDITORIAL_ATTRIBUTIONS.has(claim.attribution)) {
      throw new Error(`${claimContext}.attribution inválido: ${claim.attribution || '(vazio)'}.`);
    }
    if (!ALLOWED_EDITORIAL_PUBLICATION_STATES.has(claim.publicationState)) {
      throw new Error(`${claimContext}.publicationState inválido: ${claim.publicationState || '(vazio)'}.`);
    }
    const sourceRefs = validateEditorialSourceRefs(
      claim.sourceRefs,
      sources,
      `${claimContext}.sourceRefs`,
      { required: claim.publicationState === 'published' },
    );
    return { ...claim, sourceRefs };
  });

  const publishedClaims = claims.filter(({ publicationState }) => publicationState === 'published');
  if (status === 'pending' && publishedClaims.length) {
    throw new Error(`${context}: review.status pending não pode conter claims publicados.`);
  }
  if (status !== 'pending' && publishedClaims.length === 0) {
    throw new Error(`${context}: review.status ${status} precisa de ao menos um claim publicado.`);
  }
  if (publishedClaims.length > MAX_PUBLISHED_EDITORIAL_CLAIMS) {
    throw new Error(`${context}: no máximo ${MAX_PUBLISHED_EDITORIAL_CLAIMS} claims podem ser publicados por perfil.`);
  }
  if (status === 'reviewed' && claims.some(({ publicationState }) => publicationState === 'draft')) {
    throw new Error(`${context}: review.status reviewed não pode manter claims em rascunho; use partial.`);
  }

  let summary = null;
  if (rawDocument.summary !== undefined && rawDocument.summary !== null) {
    const summaryContext = `${context}, summary`;
    assertOnlyKeys(rawDocument.summary, new Set(['text', 'sourceRefs']), summaryContext);
    assertEditorialText(rawDocument.summary.text, `${summaryContext}.text`, { min: 20, max: 500 });
    summary = {
      text: rawDocument.summary.text,
      sourceRefs: validateEditorialSourceRefs(
        rawDocument.summary.sourceRefs,
        sources,
        `${summaryContext}.sourceRefs`,
        { required: true },
      ),
    };
  }
  if (status === 'pending' && summary) {
    throw new Error(`${context}: summary não pode ser publicado enquanto review.status for pending.`);
  }
  if (status !== 'pending' && !summary) {
    throw new Error(`${context}: perfis reviewed ou partial precisam de summary com fontes.`);
  }

  const referencedSourceIds = new Set(summary?.sourceRefs || []);
  publishedClaims.forEach(({ sourceRefs }) => sourceRefs.forEach((sourceId) => referencedSourceIds.add(sourceId)));
  const publishedSources = Object.fromEntries(
    [...referencedSourceIds].map((sourceId) => [sourceId, sources[sourceId]]),
  );
  return {
    candidateId,
    review: { status, ...(reviewedAt ? { reviewedAt } : {}), methodVersion },
    ...(summary ? { summary } : {}),
    claims: publishedClaims,
    sources: publishedSources,
  };
}

async function loadEditorialIndex(editorialDir) {
  if (!editorialDir) return { editorials: new Map(), editorialFiles: 0 };
  const resolvedDir = resolve(editorialDir);
  const directoryEntries = await readdir(resolvedDir, { withFileTypes: true });
  const editorials = new Map();
  let editorialFiles = 0;
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || extname(entry.name).toLocaleLowerCase('en-US') !== '.json') continue;
    editorialFiles += 1;
    const filePath = join(resolvedDir, entry.name);
    let rawDocument;
    try {
      rawDocument = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`JSON editorial inválido em ${entry.name}: ${error.message}`);
    }
    const editorial = normalizeEditorialDocument(rawDocument, filePath);
    if (editorials.has(editorial.candidateId)) {
      throw new Error(`Há mais de um JSON editorial para SQ_CANDIDATO ${editorial.candidateId}.`);
    }
    editorials.set(editorial.candidateId, editorial);
  }
  return { editorials, editorialFiles };
}

function cardEditorialMetadata(editorial) {
  if (!editorial || editorial.review.status === 'pending' || editorial.claims.length === 0) {
    return {
      editorialStatus: 'not-reviewed',
      themeIds: [],
      themeKinds: {},
      summary: UNREVIEWED_CARD_SUMMARY,
      tags: ['Conteúdo temático ainda não publicado'],
    };
  }
  const themeKinds = {};
  for (const claim of editorial.claims) {
    themeKinds[claim.themeId] ||= [];
    if (!themeKinds[claim.themeId].includes(claim.kind)) themeKinds[claim.themeId].push(claim.kind);
  }
  const themeIds = [...ALLOWED_EDITORIAL_THEMES].filter((themeId) => themeKinds[themeId]);
  return {
    editorialStatus: editorial.review.status,
    themeIds,
    themeKinds: Object.fromEntries(themeIds.map((themeId) => [themeId, themeKinds[themeId]])),
    summary: editorial.summary.text,
    tags: themeIds.map((themeId) => EDITORIAL_THEME_LABELS.get(themeId)),
  };
}

function assertCardPrivacy(card) {
  for (const field of Object.keys(card)) {
    if (CARD_FORBIDDEN_FIELDS.has(field)) {
      throw new Error(`Campo eleitoral antecipado no cartão ${card.id}: ${field}`);
    }
  }
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.uf}/${candidate.office}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  }
  return groups;
}

export async function prepareRelease(options) {
  const releaseId = clean(options.releaseId);
  const inputPaths = options.inputPaths?.map(String) ?? [];
  const complementPaths = options.complementPaths?.map(String) ?? [];
  const socialPaths = options.socialPaths?.map(String) ?? [];
  const proposalDirectories = options.proposalDirectories?.map(String) ?? [];
  const editorialDir = options.editorialDir ? String(options.editorialDir) : null;
  const outputDir = resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const encoding = options.encoding || 'windows-1252';
  const sourceUrl = options.sourceUrl || DEFAULT_SOURCE_URL;

  assertReleaseId(releaseId);
  assertIsoDate(generatedAt);
  if (!inputPaths.length) throw new Error('Informe ao menos um CSV com --input.');
  if (!complementPaths.length) throw new Error('Informe ao menos um CSV complementar com --complement.');
  try {
    new URL(sourceUrl);
  } catch {
    throw new Error(`URL inválida em --source-url: ${sourceUrl}`);
  }

  const releaseDir = join(outputDir, releaseId);
  if (await exists(releaseDir)) {
    throw new Error(`A release ${releaseId} já existe e não será substituída: ${releaseDir}`);
  }

  await mkdir(outputDir, { recursive: true });
  const temporaryDir = join(outputDir, `.${releaseId}.tmp-${process.pid}-${Date.now()}`);
  await mkdir(temporaryDir, { recursive: false });

  try {
    const [
      { complements, complementRows },
      photos,
      { rowsByCandidate: socialIndex, socialRows },
      {
        documentsByCandidate: proposalIndex,
        proposalFilesFound,
        proposalFilesSkippedEmpty,
        proposalDocumentsAvailable,
      },
      { editorials: editorialIndex, editorialFiles },
    ] = await Promise.all([
      loadComplements(complementPaths, encoding),
      loadPhotoIndex(options.photosDir),
      loadSocialIndex(socialPaths, encoding),
      loadProposalIndex(proposalDirectories),
      loadEditorialIndex(editorialDir),
    ]);
    const {
      candidates,
      inputRows,
      ignoredRows,
      excludedWithoutComplement,
      excludedNotOnBallot,
    } = await loadCandidates(inputPaths, complements, encoding, sourceUrl);
    const groups = groupCandidates(candidates);
    const coverage = {};
    const candidateIds = new Set(candidates.map(({ id }) => id));
    const socialRowsOutsideRelease = [...socialIndex.entries()]
      .filter(([id]) => !candidateIds.has(id))
      .reduce((total, [, rows]) => total + rows.length, 0);
    const candidateKeys = new Set(candidates.map(({ id, uf }) => `${uf}/${id}`));
    const proposalFilesOutsideRelease = [...proposalIndex.entries()]
      .filter(([key]) => !candidateKeys.has(key))
      .reduce((total, [, documents]) => total + documents.length, 0);
    const editorialProfilesOutsideRelease = [...editorialIndex.keys()]
      .filter((id) => !candidateIds.has(id)).length;
    let copiedPhotos = 0;
    let socialMatchedRows = 0;
    let profilesWithSocialLinks = 0;
    let socialLinksAccepted = 0;
    let socialLinksRejected = 0;
    let proposalDocumentsCopied = 0;
    let profilesWithProposalDocuments = 0;
    let profilesWithPublishedEditorial = 0;
    let publishedEditorialClaims = 0;

    for (const candidate of candidates) {
      const publicPhotoPath = photos.has(candidate.id)
        ? `data/releases/${releaseId}/fotos/${candidate.id}${photos.get(candidate.id).extension}`
        : null;
      if (publicPhotoPath) {
        const destination = join(temporaryDir, 'fotos', `${candidate.id}${photos.get(candidate.id).extension}`);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(photos.get(candidate.id).sourcePath, destination, fsConstants.COPYFILE_EXCL);
        copiedPhotos += 1;
      }

      const proposalDocuments = proposalIndex.get(`${candidate.uf}/${candidate.id}`) || [];
      const proposals = [];
      if (proposalDocuments.length) {
        profilesWithProposalDocuments += 1;
        for (let position = 0; position < proposalDocuments.length; position += 1) {
          const document = proposalDocuments[position];
          const destination = join(temporaryDir, 'propostas', candidate.id, document.filename);
          const publicPath = `data/releases/${releaseId}/propostas/${candidate.id}/${document.filename}`;
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(document.sourcePath, destination, fsConstants.COPYFILE_EXCL);
          proposalDocumentsCopied += 1;
          proposals.push(proposalDocumentItem(publicPath, position, proposalDocuments.length));
        }
      } else {
        const placeholder = proposalPlaceholder(candidate.office);
        placeholder.sourceUrl = candidate.candidateRecord;
        proposals.push(placeholder);
      }
      const social = networksForCandidate(candidate.id, socialIndex, socialPaths.length > 0);
      socialMatchedRows += social.matched;
      socialLinksAccepted += social.accepted;
      socialLinksRejected += social.rejected;
      if (social.accepted > 0) profilesWithSocialLinks += 1;
      const editorial = editorialIndex.get(candidate.id);
      const publishedEditorial = editorial
        && editorial.review.status !== 'pending'
        && editorial.claims.length > 0
        ? editorial
        : null;
      if (publishedEditorial) {
        profilesWithPublishedEditorial += 1;
        publishedEditorialClaims += publishedEditorial.claims.length;
      }
      const profile = {
        id: candidate.id,
        name: candidate.name,
        office: candidate.office,
        uf: candidate.uf,
        sourceCheckedAt: generatedAt,
        electionData: {
          party: candidate.party,
          number: candidate.number,
          status: candidate.status,
        },
        photo: publicPhotoPath
          ? { state: 'available', src: publicPhotoPath, alt: `Foto oficial de ${candidate.name}` }
          : { state: 'not-imported' },
        background: {
          occupation: candidate.occupation,
          education: candidate.education,
          ageAtTakingOffice: candidate.ageAtTakingOffice,
          sourceRef: 'candidateRecord',
        },
        ...(publishedEditorial ? { editorial: publishedEditorial } : {}),
        proposals,
        networks: social.networks,
        sources: { candidateRecord: candidate.candidateRecord },
      };
      await writeJson(join(temporaryDir, 'perfis', `${candidate.id}.json`), profile);
    }

    const sortedGroups = [...groups.entries()].sort(([left], [right]) => {
      const [leftUf, leftOffice] = left.split('/');
      const [rightUf, rightOffice] = right.split('/');
      return leftUf.localeCompare(rightUf) || OFFICE_ORDER.indexOf(leftOffice) - OFFICE_ORDER.indexOf(rightOffice);
    });

    for (const [key, group] of sortedGroups) {
      const [uf, office] = key.split('/');
      const cards = group.map((candidate) => {
        const photo = photos.get(candidate.id);
        const editorial = editorialIndex.get(candidate.id);
        const card = {
          id: candidate.id,
          name: candidate.name,
          initials: initialsFor(candidate.name),
          profile: `data/releases/${releaseId}/perfis/${candidate.id}.json`,
          ...cardEditorialMetadata(editorial),
          ...(photo ? {
            photo: {
              src: `data/releases/${releaseId}/fotos/${candidate.id}${photo.extension}`,
              alt: `Foto oficial de ${candidate.name}`,
            },
          } : {}),
        };
        assertCardPrivacy(card);
        return card;
      });
      const cardsRelativePath = `${uf}/${office}.cards.json`;
      await writeJson(join(temporaryDir, cardsRelativePath), {
        releaseId,
        office,
        uf,
        sourceCheckedAt: generatedAt,
        cards,
      });
      coverage[uf] ||= {};
      coverage[uf][office] = {
        label: group[0].officeLabel,
        cards: `data/releases/${releaseId}/${cardsRelativePath}`,
        count: cards.length,
        status: 'available',
      };
    }

    const manifest = {
      schemaVersion: 2,
      electionYear: 2026,
      releaseId,
      generatedAt,
      source: {
        name: 'TSE — Dados Abertos e DivulgaCandContas',
        datasetUrl: sourceUrl,
        candidateSource: 'CAND, Candex e DivulgaCand',
        inputFiles: inputPaths.map((inputPath) => basename(inputPath)),
        complementFiles: complementPaths.map((inputPath) => basename(inputPath)),
        socialFiles: socialPaths.map((inputPath) => basename(inputPath)),
        proposalDirectories: proposalDirectories.map((directory) => basename(resolve(directory))),
        editorialDirectory: editorialDir ? basename(resolve(editorialDir)) : null,
      },
      coverage,
      importSummary: {
        inputRows,
        complementRows,
        ignoredRows,
        excludedWithoutComplement,
        excludedNotOnBallot,
        candidateProfiles: candidates.length,
        localPhotos: copiedPhotos,
        socialRows,
        socialMatchedRows,
        socialRowsOutsideRelease,
        profilesWithSocialLinks,
        socialLinksAccepted,
        socialLinksRejected,
        proposalFilesFound,
        proposalFilesSkippedEmpty,
        proposalDocumentsAvailable,
        proposalFilesOutsideRelease,
        proposalDocumentsCopied,
        profilesWithProposalDocuments,
        editorialFiles,
        editorialProfilesOutsideRelease,
        profilesWithPublishedEditorial,
        publishedEditorialClaims,
      },
    };
    await writeJson(join(temporaryDir, 'manifest.json'), manifest);

    if (await exists(releaseDir)) {
      throw new Error(`A release ${releaseId} surgiu durante a importação e não será substituída.`);
    }
    await rename(temporaryDir, releaseDir);
    return { releaseDir, manifest };
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

export function parseArguments(argv) {
  const options = {
    inputPaths: [],
    complementPaths: [],
    socialPaths: [],
    proposalDirectories: [],
  };
  const takeValue = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`A opção ${name} precisa de um valor.`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--input' || argument === '-i') {
      options.inputPaths.push(takeValue(argument, index));
      index += 1;
    } else if (argument === '--complement' || argument === '-c') {
      options.complementPaths.push(takeValue(argument, index));
      index += 1;
    } else if (argument === '--social' || argument === '-s') {
      options.socialPaths.push(takeValue(argument, index));
      index += 1;
    } else if (argument === '--proposals-dir') {
      options.proposalDirectories.push(takeValue(argument, index));
      index += 1;
    } else if (argument === '--editorial-dir') {
      options.editorialDir = takeValue(argument, index);
      index += 1;
    } else if (argument === '--release') {
      options.releaseId = takeValue(argument, index);
      index += 1;
    } else if (argument === '--output') {
      options.outputDir = takeValue(argument, index);
      index += 1;
    } else if (argument === '--photos-dir') {
      options.photosDir = takeValue(argument, index);
      index += 1;
    } else if (argument === '--generated-at') {
      options.generatedAt = takeValue(argument, index);
      index += 1;
    } else if (argument === '--encoding') {
      options.encoding = takeValue(argument, index);
      index += 1;
    } else if (argument === '--source-url') {
      options.sourceUrl = takeValue(argument, index);
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`Opção desconhecida: ${argument}`);
    } else {
      options.inputPaths.push(argument);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    if (!options.releaseId) throw new Error('Informe um ID novo com --release.');
    const result = await prepareRelease(options);
    const summary = result.manifest.importSummary;
    process.stdout.write([
      `Release criada: ${result.releaseDir}`,
      `Perfis: ${summary.candidateProfiles}`,
      `Fotos locais: ${summary.localPhotos}`,
      'data/current.json não foi alterado.',
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
