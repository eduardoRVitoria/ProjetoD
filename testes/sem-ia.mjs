// O portal nao chama a IA, mesmo com chave configurada, e le RDV escaneado por OCR.
//   node testes/sem-ia.mjs
// O formulario do teste e desenhado com a fonte do sistema (Arial); roda na
// maquina de desenvolvimento, nao no conteiner (que nao tem fonte instalada).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

// Tem que ficar antes de carregar o portal: e um banco proprio, e uma chave
// "configurada" para provar que ela nao e usada.
const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-sem-ia-'));
process.env.DADOS_DIR = dados;
process.env.ANTHROPIC_API_KEY = 'sk-ant-chave-de-teste';
delete process.env.USAR_IA;

const { iaDisponivel, conferirComIa } = await import('../src/ia.js');
const { extrairDoRdv } = await import('../src/extrair.js');
const { lerRdvEscaneado } = await import('../src/leitura-rdv.js');
const { assinaturaNoEscaneado } = await import('../src/caixa-assinatura.js');
const { encerrarOcr, tirarLinhasDeTabela } = await import('../src/ocr.js');
const { PASTA_ANEXOS, db } = await import('../src/banco.js');

const dias = [
  ['01/09/2026', '61.350', '61.528', '178', '160,20', 'Itapetininga/ Tatui'],
  ['02/09/2026', '61.528', '61.670', '142', '127,80', 'Capao Bonito'],
  ['03/09/2026', '61.670', '61.969', '299', '269,10', 'Indaiatuba'],
  ['04/09/2026', '61.969', '62.247', '278', '250,20', 'Indaiatuba'],
  ['08/09/2026', '62.247', '62.453', '206', '185,40', 'Tiete/ Cerquilho'],
  ['09/09/2026', '62.453', '62.671', '218', '196,20', 'Salto de Pirapora'],
];

// O formulario como chega de um aplicativo de escanear: uma imagem, com as
// linhas da tabela, a caixa de assinatura e o rotulo. 1.321 km x 0,90 = 1.188,90.
function paginaEscaneada({ assinada = false } = {}) {
  const L = 2400, A = 1700;
  const c = createCanvas(L, A);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, L, A);
  g.fillStyle = '#000';
  g.strokeStyle = '#000';
  g.lineWidth = 3;
  g.font = 'bold 30px Arial';
  const escreve = (t, x, y) => g.fillText(t, x, y);
  const linhaH = (y) => { g.beginPath(); g.moveTo(80, y); g.lineTo(L - 80, y); g.stroke(); };

  escreve('KM R$', 100, 220); escreve('R$', 1060, 220); escreve('1.188,90', 1140, 220); linhaH(236);
  escreve('PEDAGIO + ESTACIONAMENTO', 100, 270); escreve('R$', 1060, 270); escreve('249,64', 1160, 270); linhaH(286);
  escreve('Placa do veiculo: ABC1D23', 1480, 330);
  g.strokeRect(1486, 350, 800, 130);
  if (assinada) {
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(1600, 430);
    g.bezierCurveTo(1660, 340, 1720, 500, 1780, 420);
    g.bezierCurveTo(1840, 350, 1900, 480, 1960, 410);
    g.lineTo(2060, 380); g.lineTo(1990, 460);
    g.stroke();
    g.lineWidth = 3;
  }
  escreve('ASSINATURA POR EXTENSO', 1690, 520);
  linhaH(540);
  escreve('Data', 180, 580); escreve('Km Inicial', 440, 580); escreve('Km Final', 810, 580); escreve('Total KM', 1090, 580);
  escreve('R$', 1280, 580); escreve('0,90', 1440, 580); escreve('Itinerario de Trabalho', 1800, 580); linhaH(596);
  dias.forEach(([data, ki, kf, total, valor, onde], i) => {
    const y = 640 + i * 50;
    escreve(data, 110, y); escreve(ki, 460, y); escreve(kf, 830, y); escreve(total, 1120, y);
    escreve('R$', 1280, y); escreve(valor, 1420, y); escreve(onde, 1760, y);
    linhaH(y + 16);
  });
  for (const x of [80, 400, 770, 1060, 1260, 1600, L - 80]) { g.beginPath(); g.moveTo(x, 540); g.lineTo(x, 956); g.stroke(); }
  return { png: c.toBuffer('image/png'), canvas: c };
}

try {
  // ---- 1. A IA esta desligada: nada chama a API, com chave ou sem.
  assert.equal(iaDisponivel(), false);
  await assert.rejects(conferirComIa({ usuario: {}, rel: {}, linhas: [], anexos: [] }), /IA esta desligada/);

  // ---- 2. RDV escaneado, lido por OCR.
  const { png: pagina, canvas } = paginaEscaneada();
  const lido = await lerRdvEscaneado([pagina]);
  assert.ok(lido, 'o escaneado foi lido');
  assert.deepEqual(
    lido.linhas.map((l) => [l.data.slice(5), l.km_inicial, l.km_final]),
    dias.map(([d, ki, kf]) => [`${d.slice(3, 5)}-${d.slice(0, 2)}`, Number(ki.replace('.', '')), Number(kf.replace('.', ''))]),
  );
  assert.equal(lido.totais_declarados.valor_total_km, 1188.9);
  assert.equal(lido.totais_declarados.pedagio_estacionamento, 249.64);
  assert.equal(lido.confianca, 'alta', 'a conta do documento fecha: km x 0,90 = KM R$');

  // De lado, como sai de muito aplicativo de escanear: o portal gira sozinho.
  const { default: sharp } = await import('sharp');
  const deitado = await sharp(pagina).rotate(270).png().toBuffer();
  assert.equal((await lerRdvEscaneado([deitado]))?.linhas.length, 6);

  // ---- 3. A assinatura no escaneado: caixa em branco, e caixa assinada a mao.
  assert.equal((await assinaturaNoEscaneado([pagina])).caixa, 'vazia');
  const visto = await assinaturaNoEscaneado([paginaEscaneada({ assinada: true }).png]);
  assert.equal(visto.caixa, 'com_tinta', `tinta: ${visto.tinta}`);

  // ---- 4. Pelo caminho do portal: PDF que e so imagem (o "CamScanner.pdf").
  fs.mkdirSync(PASTA_ANEXOS, { recursive: true });
  const soImagem = await PDFDocument.create();
  const foto = await soImagem.embedPng(pagina);
  soImagem.addPage([canvas.width / 3, canvas.height / 3]).drawImage(foto, { x: 0, y: 0, width: canvas.width / 3, height: canvas.height / 3 });
  fs.writeFileSync(path.join(PASTA_ANEXOS, 'escaneado.pdf'), await soImagem.save());
  const saida = await extrairDoRdv([{ nome_original: 'CamScanner.pdf', arquivo: 'escaneado.pdf' }], '2026-09');
  assert.equal(saida.por, 'ocr');
  assert.equal(saida.extraido.linhas.length, 6);
  assert.equal(saida.extraido.mes_referencia, '2026-09');

  // E a foto direta do RDV.
  fs.writeFileSync(path.join(PASTA_ANEXOS, 'foto.png'), pagina);
  assert.equal((await extrairDoRdv([{ nome_original: 'IMG_0001.png', arquivo: 'foto.png' }], '2026-09')).por, 'ocr');

  // Arquivo que ninguem le: recado em portugues, sem tentar a API.
  const vazio = await PDFDocument.create();
  vazio.addPage();
  fs.writeFileSync(path.join(PASTA_ANEXOS, 'vazio.pdf'), await vazio.save());
  await assert.rejects(extrairDoRdv([{ nome_original: 'vazio.pdf', arquivo: 'vazio.pdf' }], '2026-09'), /Nao consegui ler esse arquivo/);

  // ---- 5. Tirar as linhas da tabela nao apaga letra.
  const w = 1000, h = 600, cinza = new Uint8Array(w * h).fill(255);
  for (let x = 0; x < w; x++) cinza[30 * w + x] = 0; // linha de tabela
  for (let y = 10; y < 20; y++) for (let x = 20; x < 26; x++) cinza[y * w + x] = 0; // "letra"
  tirarLinhasDeTabela(cinza, w, h);
  assert.equal(cinza[30 * w + 100], 255, 'a linha saiu');
  assert.equal(cinza[15 * w + 22], 0, 'a letra ficou');

  console.log('OK - sem IA: nada chama a API; RDV escaneado e lido por OCR (em pe ou de lado) e a assinatura e vista na imagem');
} finally {
  await encerrarOcr();
  // O Windows nao deixa apagar o banco aberto: fecha antes; se nao der, fica no temp.
  try {
    db.close();
    fs.rmSync(dados, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // pasta temporaria - o sistema limpa
  }
}
