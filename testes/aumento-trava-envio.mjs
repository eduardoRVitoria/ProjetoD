// Aumento acima da margem sem justificativa trava o envio (05/11/2026).
//   node testes/aumento-trava-envio.mjs
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-aumento-'));
const PORTA = 3988;
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
  const vendedor = Number(db.prepare(
    `INSERT INTO usuarios (login, nome, papel, senha_hash, senha_salt, criado_em, empresa, funcao)
     VALUES ('vendedor', 'VENDEDOR', 'colaborador', 'x', 'x', ?, 'DSO', 'Vendedor')`,
  ).run(agora).lastInsertRowid);

  // Setembro enviado: R$ 90. Outubro em rascunho, bem mais caro.
  db.prepare(
    `INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em, total_km, valor_km)
     VALUES (?, '2026-09', 'CERTA', ?, 100, 90)`,
  ).run(vendedor, agora);
  db.prepare(
    `INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em)
     VALUES (?, '2026-10', 'RASCUNHO', ?)`,
  ).run(vendedor, agora);

  const token = 'teste'.padEnd(64, '0');
  db.prepare(
    'INSERT OR REPLACE INTO sessoes (token, usuario_id, expira_em, criado_em) VALUES (?, ?, ?, ?)',
  ).run(token, vendedor, new Date(Date.now() + 3600e3).toISOString(), agora);
  const chamar = async (metodo, rota, corpo) => {
    const r = await fetch(base + rota, {
      method: metodo,
      headers: { cookie: `sid=${token}`, 'content-type': 'application/json', origin: base },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, dados: await r.json() };
  };

  const linhas = [{ data: '2026-10-01', km_inicial: 1000, km_final: 2000, itinerario: 'CASA - CLIENTE - CASA', pedagio: 0, estacionamento: 0, combustivel: 0 }];
  const s1 = await chamar('PUT', '/api/relatorio', { mes: '2026-10', linhas, observacao: '', justificativa: '' });
  assert.equal(s1.status, 200, JSON.stringify(s1.dados));
  assert.ok(s1.dados.previa.comparacao?.precisa_justificar, `devia pedir justificativa: ${JSON.stringify(s1.dados.previa.comparacao)}`);

  // Sem justificativa: recusado, com o bloqueio e a conta para a janela.
  const e1 = await chamar('POST', '/api/relatorio/enviar', { mes: '2026-10' });
  assert.equal(e1.status, 400, JSON.stringify(e1.dados));
  assert.equal(e1.dados.bloqueios?.[0]?.codigo, 'aumento_sem_justificativa');
  assert.ok(e1.dados.comparacao?.diferenca > 100);

  // Com justificativa: vai.
  const s2 = await chamar('PUT', '/api/relatorio', {
    mes: '2026-10', linhas, observacao: '', justificativa: 'Cobri a rota do litoral no lugar de um colega.',
  });
  assert.equal(s2.status, 200, JSON.stringify(s2.dados));
  const e2 = await chamar('POST', '/api/relatorio/enviar', { mes: '2026-10' });
  assert.equal(e2.status, 200, JSON.stringify(e2.dados));

  // A lista da aba Notificacoes: aparece antes e depois de justificar.
  const chefe = Number(db.prepare(
    `INSERT INTO usuarios (login, nome, papel, senha_hash, senha_salt, criado_em, empresa, funcao)
     VALUES ('chefe', 'CHEFE', 'super', 'x', 'x', ?, 'DSO', 'Vendedor')`,
  ).run(agora).lastInsertRowid);
  db.prepare('UPDATE sessoes SET usuario_id = ? WHERE token = ?').run(chefe, token);
  const l1 = await chamar('GET', '/api/admin/aumentos?mes=2026-10');
  assert.equal(l1.status, 200, JSON.stringify(l1.dados));
  assert.equal(l1.dados.lista.length, 1);
  assert.equal(l1.dados.lista[0].nome, 'VENDEDOR');
  assert.equal(l1.dados.lista[0].justificada, true);
  assert.equal(l1.dados.lista[0].total_anterior, 90);
  db.prepare("UPDATE relatorios SET justificativa = NULL WHERE mes_ref = '2026-10'").run();
  const l2 = await chamar('GET', '/api/admin/aumentos?mes=2026-10');
  assert.equal(l2.dados.lista[0].justificada, false);
  const l3 = await chamar('GET', '/api/admin/aumentos?mes=2026-09');
  assert.equal(l3.dados.lista.length, 0, 'setembro nao tem mes anterior');

  console.log('aumento-trava-envio: ok');
} catch (e) {
  console.error(saida);
  throw e;
} finally {
  srv.kill();
}
