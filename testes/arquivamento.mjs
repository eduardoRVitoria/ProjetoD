// Teste do arquivamento em blocos, num servidor isolado (DADOS_DIR descartavel).
//   node testes/arquivamento.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-arq-'));
const PORTA = 3998;
const BASE = `http://localhost:${PORTA}`;
process.env.DADOS_DIR = DADOS;

const { db } = await import('../src/banco.js');
const { criarUsuario } = await import('../src/auth.js');
const anexos = path.join(DADOS, 'anexos');

const u = (login, papel, empresa, funcao) => criarUsuario({ login, nome: login.toUpperCase(), papel, senha: 'senha123', empresa, funcao });
u('donoteste', 'super', 'DISO', 'Adm DISO');
u('admdiso', 'admin', 'DISO', 'Adm DISO');
const ana = u('anateste', 'colaborador', 'DISO', 'Vendedor');
const bia = u('biateste', 'colaborador', 'DISO', 'Vendedor');
db.exec('UPDATE usuarios SET trocar_senha = 0');

const rel = (uid, mes, status) => Number(db.prepare(
  "INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em) VALUES (?, ?, ?, '2026-09-01')",
).run(uid, mes, status).lastInsertRowid);
const anexo = (relId, nome, bytes) => {
  const arquivo = `${relId}-${nome}`;
  fs.writeFileSync(path.join(anexos, arquivo), Buffer.alloc(bytes, 7));
  return Number(db.prepare(
    "INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, enviado_em) VALUES (?, 'pedagio', ?, ?, 'image/jpeg', ?, '2026-09-01')",
  ).run(relId, nome, arquivo, bytes).lastInsertRowid);
};
const r1 = rel(ana, '2026-08', 'CERTA');
const a1 = anexo(r1, 'foto1.jpg', 5000);
const a2 = anexo(r1, 'nota.pdf', 3000);
const r2 = rel(bia, '2026-09', 'ENVIADO');
const a3 = anexo(r2, 'pendente.jpg', 4000);
db.close();

const srv = spawn(process.execPath, ['servidor.js'], { env: { ...process.env, PORT: String(PORTA) }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const entrar = async (login) => {
    const r = await fetch(`${BASE}/api/entrar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, senha: 'senha123' }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const dono = await entrar('donoteste');
  const adm = await entrar('admdiso');
  const get = (url, c) => fetch(BASE + url, { headers: { cookie: c } });
  const post = (url, c, corpo, tipo = 'application/json') => fetch(BASE + url, {
    method: 'POST', headers: { cookie: c, 'Content-Type': tipo }, body: tipo === 'application/json' ? JSON.stringify(corpo) : corpo,
  });

  // Admin comum nao entra.
  assert.equal((await get('/api/admin/armazenamento', adm)).status, 403);

  // So o aprovado aparece.
  const resumo = await (await get('/api/admin/armazenamento', dono)).json();
  assert.equal(resumo.empresas.length, 1);
  assert.equal(resumo.empresas[0].anexos, 2);
  assert.equal(resumo.empresas[0].pessoas[0].nome, 'ANATESTE');

  // Baixa o bloco da empresa.
  const zipResp = await get('/api/admin/bloco?empresa=DISO', dono);
  assert.equal(zipResp.status, 200);
  const zip = Buffer.from(await zipResp.arrayBuffer());
  await new Promise((r) => setTimeout(r, 300));
  const lista = await (await get('/api/admin/armazenamento', dono)).json();
  const bloco = lista.blocos[0];
  assert.equal(bloco.status, 'BAIXADO');
  assert.equal(bloco.bytes_zip, zip.length);

  // Tamanho errado: nada apagado.
  let r = await post('/api/admin/bloco-liberar', dono, { id: bloco.id, tamanho: zip.length - 1 });
  assert.equal(r.status, 400);
  assert.ok(fs.existsSync(path.join(anexos, `${r1}-foto1.jpg`)));

  // Tamanho certo: sai do servidor.
  r = await (await post('/api/admin/bloco-liberar', dono, { id: bloco.id, tamanho: zip.length })).json();
  assert.equal(r.apagados, 2);
  assert.ok(!fs.existsSync(path.join(anexos, `${r1}-foto1.jpg`)));
  assert.ok(fs.existsSync(path.join(anexos, `${r2}-pendente.jpg`)), 'pendente nao pode sair');

  // Abrir o arquivo arquivado explica onde ele esta.
  r = await get(`/api/anexo/${a1}`, dono);
  assert.equal(r.status, 410);
  console.log('  anexo arquivado:', (await r.json()).erro);

  // Conferir de novo e recusado.
  r = await post('/api/admin/conferir', dono, { relatorio_id: r1, usar_ia: false });
  assert.equal(r.status, 409);

  // Nada mais para arquivar.
  assert.equal((await get('/api/admin/bloco?empresa=DISO', dono)).status, 404);

  // Devolve.
  r = await (await post('/api/admin/bloco-devolver', dono, zip, 'application/zip')).json();
  assert.equal(r.voltaram, 2);
  assert.equal(fs.readFileSync(path.join(anexos, `${r1}-nota.pdf`)).length, 3000);
  assert.equal((await get(`/api/anexo/${a2}`, dono)).status, 200);

  // Zip qualquer e recusado.
  r = await post('/api/admin/bloco-devolver', dono, Buffer.from('nao e zip'), 'application/zip');
  assert.equal(r.status, 400);

  console.log('OK - arquivamento: baixar, liberar, recusar, devolver');
} finally {
  srv.kill();
  void a3;
}
