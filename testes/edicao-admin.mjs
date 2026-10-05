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

  // O caderno de impressao sai mesmo com nome de arquivo que a fonte do PDF nao
  // escreve: acento separado da letra (iPhone), marca invisivel e emoji do
  // WhatsApp. Um nome assim derrubava a impressao do mes inteiro.
  db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, enviado_em)
     VALUES (?, 'pedagio', ?, 'nao-existe-2.pdf', 'application/pdf', 10, ?)`,
  ).run(rel, 'Pedágio à vista ‎\u{1F697}.pdf', agora);
  for (const rota of ['/api/admin/impressao?mes=2026-09', `/api/admin/impressao?mes=2026-09&usuario_id=${vendedor}`]) {
    const caderno = await fetch(base + rota, { headers: { cookie: `sid=${token}` } });
    assert.equal(caderno.status, 200, `${rota}: ${caderno.status}`);
    assert.equal(caderno.headers.get('content-type'), 'application/pdf');
    assert.ok((await caderno.arrayBuffer()).byteLength > 500);
  }

  // Marcar como impresso: e por relatorio, aparece no painel e pode ser desfeito.
  const marca = await chamar('/api/admin/impresso', { relatorio_id: rel, impresso: true });
  assert.equal(marca.status, 200, JSON.stringify(marca.dados));
  assert.ok(marca.dados.impresso_em);
  const noPainel = async () => (await chamar('/api/admin/painel?mes=2026-09')).dados.relatorios.find((r) => r.id === rel);
  assert.ok((await noPainel()).impresso_em, 'o painel mostra a marca');
  assert.equal((await ver()).relatorio.status, 'ERRADA', 'marcar nao muda o status');
  assert.equal((await chamar('/api/admin/impresso', { relatorio_id: rel, impresso: false })).status, 200);
  assert.equal((await noPainel()).impresso_em, null);
  assert.equal((await chamar('/api/admin/impresso', { relatorio_id: 999999, impresso: true })).status, 404);

  // ---- Totais do admin e decisao na mao (o caso do RDV escaneado lido com
  // 0 km por dia: o admin acerta o total, aprova, e a conferencia nao desfaz).
  db.prepare('UPDATE linhas SET km_inicial = 1000, km_final = 1000 WHERE relatorio_id = ?').run(rel);
  assert.equal((await editar({ valores: { total_km: 110, valor_km: 99 } })).status, 200);
  d = await ver();
  assert.equal(d.relatorio.totais_do_admin, 1);
  const agoraCodigos = d.pendencias_agora.achados.map((a) => a.codigo);
  assert.ok(!agoraCodigos.includes('soma_km') && !agoraCodigos.includes('valor_km'), agoraCodigos.join(','));
  assert.ok(agoraCodigos.includes('totais_do_admin'));
  assert.equal(d.pendencias_agora.totalKm, 110);
  assert.equal(d.pendencias_agora.valorKm, 99);

  // Aprovado na mao; conferir de novo acha erro (um sabado lancado) e mesmo
  // assim o relatorio continua aprovado.
  db.prepare(
    "INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, ordem) VALUES (?, '2026-09-05', 1110, 1160, 'SABADO', 9)",
  ).run(rel);
  assert.equal((await chamar('/api/admin/decidir', { relatorio_id: rel, status: 'CERTA', o_que_fazer: '' })).status, 200);
  const reconferido = await chamar('/api/admin/conferir', { relatorio_id: rel });
  assert.equal(reconferido.status, 200, JSON.stringify(reconferido.dados));
  assert.equal(reconferido.dados.status, 'CERTA', 'a decisao do conferente se mantem');
  d = await ver();
  assert.equal(d.relatorio.status, 'CERTA');
  assert.equal(d.relatorio.decisao_manual, 'CERTA');
  assert.ok(d.relatorio.achados.some((a) => a.gravidade === 'erro'), 'os achados continuam aparecendo');
  assert.equal(d.relatorio.achados[0].codigo, 'decisao_manual');

  // KM de foto digitado com virgula de milhar volta a ser inteiro.
  assert.equal((await editar({ anexos: [{ id: foto, km: 113.436 }] })).status, 200);
  assert.equal((await ver()).anexos.find((a) => a.id === foto).km, 113436);

  // Reprovar na mao tambem se mantem; e a edicao so dos dias devolve a conta
  // para a soma deles.
  assert.equal((await chamar('/api/admin/decidir', { relatorio_id: rel, status: 'ERRADA', o_que_fazer: 'x' })).status, 200);
  assert.equal((await editar({ linhas: [{ id: linha, km_inicial: 1000, km_final: 1110, itinerario: 'A - B', pedagio: 0, estacionamento: 0, combustivel: 0 }] })).status, 200);
  assert.equal((await ver()).relatorio.totais_do_admin, 0);

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

  // Erro nao impede o envio: rascunho com km invertido e dia sem itinerario
  // (o que antes travava) e enviado, e a conferencia aponta depois.
  db.prepare("INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, ordem) VALUES (?, '2026-09-02', 500, 400, 1)").run(rascunho);
  entrarComo(comecou);
  const envio = await chamar('/api/relatorio/enviar', { mes: '2026-09' });
  assert.equal(envio.status, 200, JSON.stringify(envio.dados));
  assert.notEqual(db.prepare('SELECT status FROM relatorios WHERE id = ?').get(rascunho).status, 'RASCUNHO');
  // So nao envia quem nao tem nada: nem dia lancado, nem o arquivo do RDV.
  entrarComo(semNada);
  await chamar('/api/relatorio?mes=2026-09');
  assert.equal((await chamar('/api/relatorio/enviar', { mes: '2026-09' })).status, 400);

  // PDF com varias fotos do odometro: uma leitura (dia + KM) por foto vira um
  // anexo por foto - antes era uma foto so, datada no dia do envio.
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const leituras = [{ data: '2026-09-01', km: 1000 }, { data: '2026-09-02', km: 1080 }];
  const subida = await fetch(
    `${base}/api/anexo?mes=2026-09&tipo=odometro&nome=fotos.pdf&leituras=${encodeURIComponent(JSON.stringify(leituras))}`,
    { method: 'POST', headers: { cookie: `sid=${token}`, 'content-type': 'application/pdf', origin: base }, body: await pdf.save() },
  );
  const subiu = await subida.json();
  assert.equal(subida.status, 200, JSON.stringify(subiu));
  const fotosDoPdf = subiu.anexos.filter((a) => a.tipo === 'odometro');
  assert.deepEqual(fotosDoPdf.map((a) => [a.data_leitura, a.km]), [['2026-09-01', 1000], ['2026-09-02', 1080]]);
  const arquivos = db.prepare("SELECT arquivo FROM anexos WHERE nome_original LIKE 'fotos (foto%' ORDER BY id").all().map((a) => a.arquivo);
  assert.equal(new Set(arquivos).size, 2, 'cada foto com seu arquivo');

  // Colaborador nao chega na rota.
  entrarComo(vendedor);
  assert.equal((await editar({ valores: { valor_km: 1 } })).status, 403);

  db.close();
  console.log('OK - admin edita totais, dias e comprovantes; o declarado acompanha e o resto e recusado');
} catch (e) {
  console.error(saida.slice(-2000));
  console.error(e);
  process.exitCode = 1;
} finally {
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
  // Com o teste falhando o banco fica aberto, e o Windows nao deixa apagar: a
  // limpeza nao pode esconder o erro de verdade.
  try {
    fs.rmSync(dados, { recursive: true, force: true });
  } catch {
    // pasta temporaria - o sistema limpa
  }
}
