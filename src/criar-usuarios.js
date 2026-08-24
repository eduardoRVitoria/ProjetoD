// Cadastra os colaboradores em lote a partir das pastas da conferencia de julho
// (CERTAS / FALTA DANFE / ERRADAS), que ja tem o nome de cada um.
//
// Uso:
//   node src/criar-usuarios.js            -> so mostra o que faria
//   node src/criar-usuarios.js --gravar   -> cadastra de verdade
//
// Imprime no fim a lista de login + senha provisoria para voce distribuir.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db } from './banco.js';
import { criarUsuario } from './auth.js';

const RAIZ_RDV =
  process.env.PASTA_RDV ||
  'C:\\Users\\sav.brk5\\OneDrive - DISO - COMERCIO DE ALIMENTOS EIRELI\\Área de Trabalho\\DUS E CLAUDIO\\RDV';

const PASTAS = ['CERTAS', 'FALTA DANFE', 'ERRADAS'];
const gravar = process.argv.includes('--gravar');

// "Anderson Suzuki Calumby" -> "anderson.calumby"
function loginDe(nome) {
  const partes = nome
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && !['de', 'da', 'do', 'dos', 'das'].includes(p));

  if (partes.length === 0) return null;
  if (partes.length === 1) return partes[0];
  return `${partes[0]}.${partes[partes.length - 1]}`;
}

function senhaProvisoria() {
  // Legivel ao telefone: sem 0/O nem 1/l.
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const numeros = '23456789';
  const sorteia = (fonte, n) =>
    Array.from({ length: n }, () => fonte[crypto.randomInt(fonte.length)]).join('');
  return `${sorteia(letras, 4)}${sorteia(numeros, 3)}`;
}

// ------------------------------------------------------------------ coleta

const nomes = new Set();

for (const pasta of PASTAS) {
  const caminho = path.join(RAIZ_RDV, pasta);
  if (!fs.existsSync(caminho)) {
    console.log(`  (pasta nao encontrada: ${pasta})`);
    continue;
  }
  for (const item of fs.readdirSync(caminho, { withFileTypes: true })) {
    if (item.isDirectory()) nomes.add(item.name.trim());
  }
}

if (nomes.size === 0) {
  console.log('\nNenhum nome encontrado. Confira o caminho da pasta RDV:');
  console.log(`  ${RAIZ_RDV}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- cadastro

const jaExistem = new Set(
  db.prepare('SELECT login FROM usuarios').all().map((u) => u.login),
);

const criados = [];
const pulados = [];
const usados = new Set(jaExistem);

for (const nome of [...nomes].sort()) {
  let login = loginDe(nome);
  if (!login) {
    pulados.push([nome, 'nao consegui montar um login']);
    continue;
  }

  if (usados.has(login)) {
    // Desempata com o nome do meio.
    const meio = nome.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().split(/\s+/)[1];
    const alternativo = meio ? `${login.split('.')[0]}.${meio}` : `${login}2`;
    if (usados.has(alternativo)) {
      pulados.push([nome, `login "${login}" ja existe`]);
      continue;
    }
    login = alternativo;
  }

  const senha = senhaProvisoria();
  usados.add(login);

  if (gravar) {
    try {
      criarUsuario({ login, nome, papel: 'colaborador', senha });
    } catch (e) {
      pulados.push([nome, e.message]);
      continue;
    }
  }
  criados.push([nome, login, senha]);
}

// ------------------------------------------------------------------ saida

console.log('');
console.log(gravar ? '  CADASTRADOS' : '  PREVIA (nada foi gravado - use --gravar)');
console.log('  ' + '-'.repeat(70));
console.log(`  ${'NOME'.padEnd(38)} ${'LOGIN'.padEnd(22)} SENHA`);
console.log('  ' + '-'.repeat(70));
for (const [nome, login, senha] of criados) {
  console.log(`  ${nome.slice(0, 37).padEnd(38)} ${login.padEnd(22)} ${senha}`);
}
console.log('  ' + '-'.repeat(70));
console.log(`  ${criados.length} colaborador(es).`);

if (pulados.length) {
  console.log('\n  NAO CADASTRADOS:');
  for (const [nome, motivo] of pulados) console.log(`    ${nome} - ${motivo}`);
}

if (gravar) {
  // fileURLToPath, nao new URL().pathname: o segundo devolve o caminho com os
  // espacos e acentos escapados em %20 / %C3%81 e o writeFileSync quebra.
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const destino = path.join(aqui, '..', 'dados', 'senhas-iniciais.csv');
  const csv = ['NOME;LOGIN;SENHA', ...criados.map((l) => l.join(';'))].join('\r\n');
  fs.writeFileSync(destino, '\ufeff' + csv, 'utf8');
  console.log(`\n  Lista salva em dados/senhas-iniciais.csv`);
  console.log('  Cada pessoa troca a senha no primeiro acesso.');
} else {
  console.log('\n  Rode de novo com --gravar para cadastrar de verdade.');
}
console.log('');
