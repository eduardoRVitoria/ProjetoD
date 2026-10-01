// Edicao do relatorio pelo admin, de ponta a ponta, num banco vazio e proprio.
//   node testes/edicao-admin.mjs
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-edicao-'));
const PORTA = 3987;
const base = `http://localhost:${PORTA}`;

const srv = spawn(process.execPath, ['servidor.js'], {
  cwd: raiz,
  env: { ...process.env, DADOS_DIR: dados, PORT: String(PORTA) },
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
    `INSERT INTO usuarios (login, nome, papel, senha_hash, senha_salt, criado_em, empresa, funcao)
     VALUES (?, ?, ?, 'x', 'x', ?, 'DSO', 'Vendedor')`,
  ).run(login, login.toUpperCase(), papel, agora).lastInsertRowid);
  const chefe = novoUsuario('chefe', 'super');
  const vendedor = novoUsuario('vendedor', 'colaborador');

  const extraido = { linhas: [], totais_declarados: { total_km: 100, valor_total_km: 90, hotel: 0, outros: 0 } };
  const rel = Number(db.prepare(
    `INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em, total_km, valor_km, extraido)
     VALUES (?, '2026-09', 'ERRADA', ?, 100, 90, ?)`,
  ).run(vendedor, agora, JSON.stringify(extraido)).lastInsertRowid);
  const linha = Number(db.prepare(
    `INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, ordem)
     VALUES (?, '2026-09-01', 1000, 1100, 'CASA - CLIENTE', 0)`,
  ).run(rel).lastInsertRowid);
  const anexo = Number(db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, enviado_em, valor)
     VALUES (?, 'hotel', 'hotel.pdf', 'nao-existe.pdf', 'application/pdf', 10, ?, 300)`,
  ).run(rel, agora).lastInsertRowid);

  const token = 'teste'.padEnd(64, '0');
  const entrarComo = (id) => db.prepare(
    'INSERT OR REPLACE INTO sessoes (token, usuario_id, expira_em, criado_em) VALUES (?, ?, ?, ?)',
  ).run(token, id, new Date(Date.now() + 3600e3).toISOString(), agora);
  const chamar = async (rota, corpo) => {
    const r = await fetch(base + rota, {
      method: corpo ? 'POST' : 'GET',
      headers: { cookie: `sid=${token}`, 'content-type': 'application/json', origin: base },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, dados: await r.json() };
  };
  const editar = (corpo) => chamar('/api/admin/relatorio-editar', { relatorio_id: rel, ...corpo });
  const ver = async () => (await chamar(`/api/admin/relatorio?id=${rel}`)).dados;

  entrarComo(chefe);

  // Grava totais, um dia e o valor de um comprovante de uma vez.
  const r1 = await editar({
    valores: { total_km: 110, valor_km: 99, hotel_declarado: 350, pedagio_declarado: 20, pedagio_comprovado: 20 },
    linhas: [{ id: linha, km_inicial: 1000, km_final: 1110, itinerario: 'CASA - CLIENTE - CASA', pedagio: 0, estacionamento: 0, combustivel: 0 }],
    anexos: [{ id: anexo, valor: 350 }],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.dados));

  let d = await ver();
  assert.equal(d.relatorio.total_km, 110);
  assert.equal(d.relatorio.valor_km, 99);
  assert.equal(d.relatorio.hotel_declarado, 350);
  assert.equal(d.relatorio.pedagio_comprovado, 20);
  assert.equal(d.relatorio.pedagio_comprovado_admin, 20, 'fica marcado como digitado pelo admin');
  assert.equal(d.linhas[0].km_final, 1110);
  assert.equal(d.linhas[0].itinerario, 'CASA - CLIENTE - CASA');
  assert.equal(d.anexos[0].valor, 350);
  // O total digitado vira o declarado: a conferencia para de cobrar o numero do PDF.
  assert.deepEqual(
    { km: d.relatorio.extraido.totais_declarados.total_km, valor: d.relatorio.extraido.totais_declarados.valor_total_km,
      hotel: d.relatorio.extraido.totais_declarados.hotel, pedagio: d.relatorio.extraido.totais_declarados.pedagio_estacionamento },
    { km: 110, valor: 99, hotel: 350, pedagio: 20 },
  );
  const codigos = d.pendencias_agora.achados.map((a) => a.codigo);
  for (const c of ['soma_km', 'valor_km', 'hotel_nao_bate', 'pedagio_diferenca']) {
    assert.ok(!codigos.includes(c), `nao devia sobrar ${c}: ${codigos.join(', ')}`);
  }
  // O parecer gravado e a decisao nao mudam sozinhos.
  assert.equal(d.relatorio.status, 'ERRADA');

  // O painel mostra o total a receber, e o subtotal declarado acompanha o admin.
  const doPainel = (await chamar('/api/admin/painel?mes=2026-09')).dados.relatorios.find((r) => r.id === rel);
  assert.equal(doPainel.total_a_receber, 469, 'km 99 + pedagio 20 + hotel 350');
  assert.equal(doPainel.subtotal_rdv, 469);

  // A aba "Nao enviaram": quem nao mandou o mes, com a empresa e se ja comecou.
  const semNada = novoUsuario('semnada', 'colaborador');
  const comecou = novoUsuario('comecou', 'colaborador');
  const rascunho = Number(db.prepare(
    "INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em) VALUES (?, '2026-09', 'RASCUNHO', ?)",
  ).run(comecou, agora).lastInsertRowid);
  db.prepare("INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, ordem) VALUES (?, '2026-09-01', 10, 20, 0)").run(rascunho);
  const faltam = (await chamar('/api/admin/painel?mes=2026-09')).dados.nao_enviaram;
  assert.deepEqual(
    faltam.map((u) => [u.login, u.empresa, u.cracha, u.comecou]),
    [['comecou', 'DSO', 'DSO (V)', true], ['semnada', 'DSO', 'DSO (V)', false]],
    'quem enviou (vendedor) fica de fora',
  );
  assert.ok(semNada > 0);
  assert.ok(!codigos.includes('subtotal_nao_bate'));
  const planilha = await fetch(`${base}/api/admin/exportar?mes=2026-09`, { headers: { cookie: `sid=${token}` } });
  assert.equal(planilha.status, 200, 'a planilha do mes continua sendo gerada');

  // A foto do odometro chega na janela com o dia e o KM, e o admin corrige os dois.
  const foto = Number(db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, enviado_em, km, data_leitura)
     VALUES (?, 'odometro', 'painel.jpg', 'nao-existe.jpg', 'image/jpeg', 10, ?, 1000, '2026-09-01')`,
  ).run(rel, agora).lastInsertRowid);
  d = await ver();
  assert.deepEqual(
    d.anexos.filter((a) => a.tipo === 'odometro').map((a) => [a.km, a.data_leitura]),
    [[1000, '2026-09-01']],
  );
  assert.equal((await editar({ anexos: [{ id: foto, km: 1110, data_leitura: '2026-09-02' }] })).status, 200);
  d = await ver();
  assert.deepEqual(d.anexos.find((a) => a.id === foto).data_leitura, '2026-09-02');
  assert.equal(d.anexos.find((a) => a.id === foto).km, 1110);
  assert.equal((await editar({ anexos: [{ id: foto, data_leitura: '2026-13-45' }] })).status, 400, 'dia que nao existe');

  // Comprovado em branco apaga a correcao do admin.
  assert.equal((await editar({ valores: { pedagio_comprovado: '' } })).status, 200);
  d = await ver();
  assert.equal(d.relatorio.pedagio_comprovado, null);
  assert.equal(d.relatorio.pedagio_comprovado_admin, null);

  // Recusas.
  assert.equal((await editar({ valores: { valor_km: 'abc' } })).status, 400);
  assert.equal((await editar({ valores: { valor_km: -5 } })).status, 400);
  assert.equal((await editar({ linhas: [{ id: 999999 }] })).status, 400);
  assert.equal((await editar({ anexos: [{ id: 999999, valor: 1 }] })).status, 400);
  assert.equal((await editar({})).status, 400);
  d = await ver();
  assert.equal(d.relatorio.valor_km, 99, 'pedido recusado nao grava nada');

  // Colaborador nao chega na rota.
  entrarComo(vendedor);
  assert.equal((await editar({ valores: { valor_km: 1 } })).status, 403);

  db.close();
  console.log('OK - admin edita totais, dias e comprovantes; o declarado acompanha e o resto e recusado');
} catch (e) {
  console.error(saida.slice(-2000));
  throw e;
} finally {
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
  fs.rmSync(dados, { recursive: true, force: true });
}
