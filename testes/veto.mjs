// Veto de erro pelo conferente, de ponta a ponta, num banco vazio e proprio.
//   node testes/veto.mjs
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-veto-'));
const PORTA = 3989;
const base = `http://localhost:${PORTA}`;

const srv = spawn(process.execPath, ['servidor.js'], {
  cwd: raiz,
  env: { ...process.env, DADOS_DIR: dados, PORT: String(PORTA), USAR_IA: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saida = '';
srv.stdout.on('data', (d) => (saida += d));
srv.stderr.on('data', (d) => (saida += d));

try {
  let noAr = false;
  for (let i = 0; i < 80 && !noAr; i++) {
    try {
      await fetch(`${base}/api/saude`);
      noAr = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert.ok(noAr, 'o servidor nao subiu');

  const db = new DatabaseSync(path.join(dados, 'portal-rdv.db'));
  const agora = new Date().toISOString();
  const novoUsuario = (login, papel) => Number(db.prepare(
    `INSERT INTO usuarios (login, nome, papel, senha_hash, senha_salt, criado_em, empresa, funcao, carro)
     VALUES (?, ?, ?, 'x', 'x', ?, 'DSO', 'Vendedor', 'empresa')`,
  ).run(login, login.toUpperCase(), papel, agora).lastInsertRowid);
  const chefe = novoUsuario('chefe', 'super');
  const vendedor = novoUsuario('vendedor', 'colaborador');

  // Um sabado e um domingo com km: dois erros do mesmo tipo, mais um de outro.
  const achados = [
    { gravidade: 'erro', codigo: 'data_fim_de_semana', mensagem: '05/09/2026 caiu num sabado e tem lancamento.', data: '2026-09-05' },
    { gravidade: 'erro', codigo: 'data_fim_de_semana', mensagem: '06/09/2026 caiu num domingo e tem lancamento.', data: '2026-09-06' },
    { gravidade: 'erro', codigo: 'sem_danfe', mensagem: 'Falta a nota de abastecimento.', data: null },
    { gravidade: 'aviso', codigo: 'leitura_parcial', mensagem: 'A leitura teve pontos duvidosos.', data: null },
  ];
  const rel = Number(db.prepare(
    `INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em, enviado_em, conferido_em, envios, achados, o_que_fazer)
     VALUES (?, '2026-09', 'ERRADA', ?, ?, ?, 1, ?, 'corrija')`,
  ).run(vendedor, agora, agora, agora, JSON.stringify(achados)).lastInsertRowid);
  const dia = db.prepare(
    `INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, ordem) VALUES (?, ?, ?, ?, 'CASA - CLIENTE - CASA', ?)`,
  );
  dia.run(rel, '2026-09-04', 1000, 1100, 0);
  dia.run(rel, '2026-09-05', 1100, 1200, 1);
  dia.run(rel, '2026-09-06', 1200, 1300, 2);

  const token = 'teste'.padEnd(64, '0');
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em, criado_em) VALUES (?, ?, ?, ?)')
    .run(token, chefe, new Date(Date.now() + 3600e3).toISOString(), agora);
  const chamar = async (rota, corpo) => {
    const r = await fetch(base + rota, {
      method: corpo ? 'POST' : 'GET',
      headers: { cookie: `sid=${token}`, 'content-type': 'application/json', origin: base },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, dados: await r.json() };
  };
  const ver = async () => (await chamar(`/api/admin/relatorio?id=${rel}`)).dados;
  const vetar = (chave, sim = true) => chamar('/api/admin/vetar', { relatorio_id: rel, chave, vetar: sim });
  const codigos = (lista) => lista.map((a) => a.codigo);

  // Vetar o fim de semana tira os dois dias; sobra so a nota -> so falta DANFE.
  let r = await vetar('data_fim_de_semana');
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  // assert.equal(r.dados.status, 'SO_FALTA_DANFE');
  assert.equal(r.dados.status, 'ENVIADO', 'veto nao aprova nem reprova sozinho');
  let d = await ver();
  assert.deepEqual(codigos(d.relatorio.achados), ['sem_danfe', 'leitura_parcial']);
  assert.equal(d.relatorio.vetos.length, 1);
  assert.equal(d.relatorio.vetos[0].itens.length, 2, 'os dois dias ficam guardados no veto');
  assert.equal(d.relatorio.vetos[0].por, 'CHEFE');
  assert.equal(d.relatorio.o_que_fazer, 'Falta a nota de abastecimento.');
  // O que roda na hora (tela do colaborador, pendencias) tambem para de cobrar.
  assert.ok(!codigos(d.pendencias_agora.achados).includes('data_fim_de_semana'));

  // Vetar o que sobrou aprova; vetar duas vezes ou o que nao existe e recusado.
  // assert.equal((await vetar('sem_danfe')).dados.status, 'CERTA');
  assert.equal((await vetar('sem_danfe')).dados.status, 'ENVIADO');
  assert.equal((await vetar('sem_danfe')).status, 400);
  assert.equal((await vetar('km_invertido')).status, 400);
  // Aviso nao e erro: nao se veta.
  assert.equal((await vetar('leitura_parcial')).status, 400);

  // Desfazer devolve o erro e o status.
  r = await vetar('sem_danfe', false);
  // assert.equal(r.dados.status, 'SO_FALTA_DANFE');
  assert.equal(r.dados.status, 'ENVIADO');
  d = await ver();
  assert.ok(codigos(d.relatorio.achados).includes('sem_danfe'));

  // Conferir de novo nao traz de volta o que foi vetado.
  r = await chamar('/api/admin/conferir', { relatorio_id: rel, usar_ia: false });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  d = await ver();
  assert.ok(!codigos(d.relatorio.achados).includes('data_fim_de_semana'), 'continua vetado depois de conferir de novo');
  assert.equal(d.relatorio.vetos[0].itens.length, 2, 'o veto guarda o que a conferencia de hoje apitou');

  // Decisao na mao manda no status: o veto nao desfaz uma reprovacao manual.
  await chamar('/api/admin/decidir', { relatorio_id: rel, status: 'ERRADA', o_que_fazer: 'refaca' });
  for (const a of (await ver()).relatorio.achados.filter((x) => x.gravidade === 'erro')) {
    r = await vetar(a.codigo === 'ia' ? `ia|${a.mensagem}` : a.codigo);
    assert.equal(r.dados.status, 'ERRADA');
  }
  assert.equal((await ver()).relatorio.o_que_fazer, 'refaca');

  console.log('OK - veto tira o erro do parecer, refaz o status, sobrevive a reconferencia e respeita a decisao manual');
} catch (e) {
  console.error(saida.slice(-3000));
  throw e;
} finally {
  srv.kill();
}
