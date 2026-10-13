// RDV anexado e enviado sem tocar em "Ler meu relatorio": a conferencia le o
// arquivo sozinha em vez de cobrar os lancamentos dia a dia. E o "o que falta
// chegar" do painel nao cobra foto do odometro de quem tem carro da empresa.
//   node testes/enviado-sem-leitura.mjs "caminho\do\RDV.pdf" [AAAA-MM]
// Precisa de um RDV de verdade em PDF com texto; sem o caminho, o teste e pulado.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [pdf, mes = '2026-08'] = process.argv.slice(2);
if (!pdf || !fs.existsSync(pdf)) {
  console.log('PULADO - informe o caminho de um RDV em PDF');
  process.exit(0);
}

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-sem-leitura-'));
const PORTA = 3988;
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
  const novoUsuario = (login, papel, funcao, carro) => Number(db.prepare(
    `INSERT INTO usuarios (login, nome, papel, senha_hash, senha_salt, criado_em, empresa, funcao, carro)
     VALUES (?, ?, ?, 'x', 'x', ?, 'DSO', ?, ?)`,
  ).run(login, login.toUpperCase(), papel, agora, funcao, carro).lastInsertRowid);
  const chefe = novoUsuario('chefe', 'super', 'Vendedor', 'pessoal');
  const gerente = novoUsuario('gerente', 'colaborador', 'Gerente', 'empresa');
  const vendedor = novoUsuario('vendedor', 'colaborador', 'Vendedor', 'pessoal');

  fs.copyFileSync(pdf, path.join(dados, 'anexos', 'rdv-teste.pdf'));
  const enviadoSemLer = (usuario) => {
    const rel = Number(db.prepare(
      "INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em, enviado_em, envios) VALUES (?, ?, 'ENVIADO', ?, ?, 1)",
    ).run(usuario, mes, agora, agora).lastInsertRowid);
    db.prepare(
      `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, enviado_em)
       VALUES (?, 'rdv', 'RDV.pdf', 'rdv-teste.pdf', 'application/pdf', ?, ?)`,
    ).run(rel, fs.statSync(pdf).size, agora);
    return rel;
  };
  const doGerente = enviadoSemLer(gerente);
  const doVendedor = enviadoSemLer(vendedor);

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
  const ver = async (id) => (await chamar(`/api/admin/relatorio?id=${id}`)).dados;

  // Antes de conferir: carro da empresa nao e cobrado de foto; carro pessoal e.
  assert.equal((await ver(doGerente)).cobra_odometro, false, 'gerente com carro da empresa');
  assert.equal((await ver(doVendedor)).cobra_odometro, true, 'vendedor com carro pessoal');
  assert.equal((await ver(doVendedor)).linhas.length, 0);

  // Conferir le o arquivo em vez de devolver "nao tem os lancamentos dia a dia".
  const r = await chamar('/api/admin/conferir', { relatorio_id: doVendedor, usar_ia: false });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const d = await ver(doVendedor);
  assert.ok(d.linhas.length > 0, 'os dias do RDV foram lidos na conferencia');
  assert.ok(d.relatorio.extraido, 'o que o documento declarava ficou gravado');
  assert.ok(d.relatorio.total_km > 0, 'o total de km foi gravado');
  assert.notEqual(d.relatorio.status, 'ENVIADO', 'saiu com parecer');

  console.log(`OK - enviado sem leitura: ${d.linhas.length} dia(s) lidos na conferencia, ${d.relatorio.total_km} km, ${d.relatorio.rotulo_status}`);
} catch (e) {
  console.error(saida.slice(-3000));
  throw e;
} finally {
  srv.kill();
}
