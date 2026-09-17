#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CARD_FORBIDDEN_FIELDS = new Set([
  'party', 'partido', 'number', 'numero', 'status', 'electionData', 'networks',
]);
const PROFILE_PRIVATE_FIELDS = new Set([
  'cpf', 'email', 'dsEmail', 'birthDate', 'dateOfBirth', 'dataNascimento',
  'tituloEleitoral', 'voterRegistration',
]);

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
    if (forbidden.has(key)) return [...trail, key].join('.');
    const nested = findForbiddenKey(child, forbidden, [...trail, key]);
    if (nested) return nested;
  }
  return null;
}

function isSafeExternalUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isSafeLocalProposalPath(value, releaseId, candidateId) {
  const prefix = `data/releases/${releaseId}/propostas/${candidateId}/`;
  return typeof value === 'string'
    && value.startsWith(prefix)
    && !value.includes('..')
    && value.toLocaleLowerCase('en-US').endsWith('.pdf');
}

async function main() {
  const releaseId = process.argv[2];
  if (!releaseId || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error('Uso: node scripts/validar-release.mjs ID-DA-RELEASE');
  }

  const releaseDir = resolve(PROJECT_ROOT, 'data', 'releases', releaseId);
  const manifest = await readJson(join(releaseDir, 'manifest.json'));
  assert(manifest.releaseId === releaseId, 'O ID do manifesto não corresponde à pasta.');
  assert(manifest.electionYear === 2026, 'Ano eleitoral inesperado.');
  assert(!Number.isNaN(Date.parse(manifest.generatedAt)), 'Data de geração inválida.');

  const profileIds = new Set();
  let cardCount = 0;
  let cardsWithPhotos = 0;

  for (const [uf, offices] of Object.entries(manifest.coverage || {})) {
    for (const [office, collection] of Object.entries(offices || {})) {
      const catalogPath = resolve(PROJECT_ROOT, collection.cards);
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

        const profilePath = resolve(PROJECT_ROOT, card.profile);
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

        for (const proposal of profile.proposals || []) {
          if (!proposal.sourceUrl) continue;
          const localProposal = isSafeLocalProposalPath(proposal.sourceUrl, releaseId, card.id);
          assert(localProposal || isSafeExternalUrl(proposal.sourceUrl), `Fonte de proposta inválida em ${card.id}.`);
          if (localProposal) {
            assert(await exists(resolve(PROJECT_ROOT, proposal.sourceUrl)), `PDF de proposta ausente em ${card.id}.`);
          }
        }
        for (const network of profile.networks?.items || []) {
          assert(isSafeExternalUrl(network.url), `Rede social inválida em ${card.id}.`);
        }

        if (card.photo?.src) {
          assert(profile.photo?.src === card.photo.src, `Foto divergente em ${card.id}.`);
          assert(await exists(resolve(PROJECT_ROOT, card.photo.src)), `Foto ausente para ${card.id}.`);
          cardsWithPhotos += 1;
        }
      }
    }
  }

  const profileFiles = (await readdir(join(releaseDir, 'perfis'))).filter((name) => name.endsWith('.json'));
  assert(profileFiles.length === cardCount, 'Há perfis sem cartão ou cartões sem perfil.');
  assert(manifest.importSummary?.candidateProfiles === cardCount, 'Total de perfis diverge do manifesto.');
  assert(manifest.importSummary?.localPhotos === cardsWithPhotos, 'Total de fotos diverge do manifesto.');

  process.stdout.write(`Release ${releaseId} validada: ${cardCount} perfis e ${cardsWithPhotos} fotos locais.\n`);
}

main().catch((error) => {
  process.stderr.write(`Erro de validação: ${error.message}\n`);
  process.exitCode = 1;
});
