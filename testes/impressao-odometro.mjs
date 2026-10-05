// A ALPHA imprime as fotos do odometro junto dos comprovantes; as outras
// empresas, nao. PDF de varias fotos (um anexo por foto) sai uma vez so.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-impressao-'));
process.env.DADOS_DIR = dados;
const { db, PASTA_ANEXOS } = await import('../src/banco.js');
const { montarImpressao } = await import('../src/impressao.js');
const { PDFDocument } = await import('pdf-lib');
const { default: sharp } = await import('sharp');

try {
  fs.mkdirSync(PASTA_ANEXOS, { recursive: true });
  const jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(PASTA_ANEXOS, 'foto.jpg'), jpg);
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  fs.writeFileSync(path.join(PASTA_ANEXOS, 'fotos.pdf'), await doc.save());

  const agora = new Date().toISOString();
  const usuario = (login, empresa) => Number(db.prepare(
    `INSERT INTO usuarios (login, nome, papel, senha_hash, senha_salt, criado_em, empresa, funcao)
     VALUES (?, ?, 'colaborador', 'x', 'x', ?, ?, 'Vendedor')`,
  ).run(login, login, agora, empresa).lastInsertRowid);
  const relatorio = (u) => Number(db.prepare(
    "INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em) VALUES (?, '2026-09', 'ENVIADO', ?)",
  ).run(u, agora).lastInsertRowid);
  const anexo = (rel, nome, arquivo) => db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, km, data_leitura, enviado_em)
     VALUES (?, 'odometro', ?, ?, 'x', 1, 1000, '2026-09-01', ?)`,
  ).run(rel, nome, arquivo, agora);

  const alpha = usuario('alpha', 'ALPHA');
  const ra = relatorio(alpha);
  anexo(ra, 'painel.jpg', 'foto.jpg');
  anexo(ra, 'fotos (foto 1 de 2).pdf', 'fotos.pdf');
  anexo(ra, 'fotos (foto 2 de 2).pdf', 'fotos.pdf');

  const dso = usuario('dso', 'DSO');
  anexo(relatorio(dso), 'painel.jpg', 'foto.jpg');

  const cadernoAlpha = await montarImpressao('2026-09', alpha);
  assert.equal(cadernoAlpha.total, 2, 'a foto solta e o PDF uma vez so');
  assert.equal((await PDFDocument.load(cadernoAlpha.bytes)).getPageCount(), 3, '1 pagina da foto + 2 do PDF');

  assert.equal(await montarImpressao('2026-09', dso), null, 'DSO nao imprime odometro');
  console.log('impressao-odometro OK');
} finally {
  db.close();
  try {
    fs.rmSync(dados, { recursive: true, force: true });
  } catch {
    // Windows segura o arquivo do banco por um instante
  }
}
