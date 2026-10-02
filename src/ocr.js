// OCR e QR code: ler foto por CODIGO, sem IA.
//
// O Tesseract roda aqui mesmo no servidor (WebAssembly, num worker), de graca.
// Le bem texto impresso - cupom, nota, print de aplicativo - e mal o painel do
// carro. Por isso quem usa nunca reprova ninguem pelo que o OCR leu: ele so
// CONFIRMA quando acha o que procura; quando nao acha, vira aviso para alguem
// olhar.
//
// Uma leitura por vez: o worker e um so, e duas fotos ao mesmo tempo dobrariam
// a memoria sem ganhar tempo.

import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Lado maior da foto antes do OCR. Foto de celular vem com 4000px; o Tesseract
// nao le melhor com isso, so demora mais.
const LADO = 2000;
const TEMPO_POR_FOTO = 90_000;

let worker = null;
let fila = Promise.resolve();

async function pegarWorker() {
  if (worker) return worker;
  const { createWorker } = await import('tesseract.js');
  // O dicionario de portugues vem do pacote, nao da internet: o servidor nao
  // pode depender de um CDN para conferir relatorio.
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/por/package.json')), '4.0.0_best_int');
  worker = await createWorker('por', 1, { langPath, cachePath: os.tmpdir(), gzip: true });
  return worker;
}

/** A foto pronta para leitura: em pe, cinza, contraste esticado. */
async function preparar(caminho, { lado = LADO } = {}) {
  const { default: sharp } = await import('sharp');
  return sharp(caminho, { failOn: 'none' })
    .rotate() // respeita a orientacao que o celular gravou
    .resize({ width: lado, height: lado, fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();
}

/**
 * As paginas de um PDF como imagens (PNG), para o OCR. E o caminho do PDF
 * escaneado - CamScanner, foto salva como PDF - que nao tem texto nenhum.
 * Devolve [] se nao der para desenhar.
 */
export async function paginasDoPdfComoImagem(caminho, maxPaginas = 6) {
  const fs = await import('node:fs');
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(caminho)),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    const imagens = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPaginas); p++) {
      const pagina = await doc.getPage(p);
      const base = pagina.getViewport({ scale: 1 });
      const escala = Math.min(3, LADO / Math.max(base.width, base.height));
      const viewport = pagina.getViewport({ scale: escala });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await pagina.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      imagens.push(canvas.toBuffer('image/png'));
    }
    await doc.destroy();
    return imagens;
  } catch {
    return [];
  }
}

/**
 * O texto que da para ler na imagem (caminho do arquivo ou os bytes dela).
 * String vazia quando nao leu nada ou a imagem nao abre - quem chama trata
 * "nao li" como "nao confirmei".
 */
export function textoDaImagem(caminho) {
  const tarefa = fila.then(async () => {
    let relogio;
    try {
      // Teto por foto. Sem ele, um OCR pendurado deixaria o relatorio preso em
      // "Conferindo" para sempre e travaria a fila atras dele.
      const estourou = new Promise((_, recusar) => {
        relogio = setTimeout(() => recusar(new Error('ocr passou do tempo')), TEMPO_POR_FOTO);
      });
      const leitura = (async () => {
        const w = await pegarWorker();
        const { data } = await w.recognize(await preparar(caminho));
        return String(data.text || '');
      })();
      return await Promise.race([leitura, estourou]);
    } catch (e) {
      if (/passou do tempo/.test(String(e?.message))) {
        // O worker ficou num estado desconhecido: joga fora, o proximo cria outro.
        const velho = worker;
        worker = null;
        velho?.terminate().catch(() => {});
      }
      return '';
    } finally {
      clearTimeout(relogio);
    }
  });
  fila = tarefa.catch(() => {});
  return tarefa;
}

// Lado maior da pagina de formulario antes do OCR: a tabela do RDV tem letra
// pequena, e com 2000 px os numeros saem trocados.
const LADO_DA_TABELA = 2600;
// Abaixo disto o pixel e traco preto (linha de tabela, letra). O azul do
// cabecalho do formulario fica acima, de proposito: e fundo, nao linha.
const TRACO = 100;

/**
 * Apaga as linhas de tabela de uma imagem em tons de cinza (um byte por pixel).
 *
 * E o que faz o OCR ler formulario: com as linhas, o Tesseract junta numero com
 * borda e devolve lixo ("gg ag" no lugar de "248.695 248.779"); sem elas, le a
 * tabela do RDV escaneado linha por linha. Linha e um traco escuro comprido -
 * letra nenhuma tem 3% da largura da folha.
 */
export function tirarLinhasDeTabela(data, largura, altura) {
  const minHorizontal = Math.round(largura * 0.03);
  const minVertical = Math.round(altura * 0.03);
  const apagar = new Uint8Array(largura * altura);
  for (let y = 0; y < altura; y++) {
    let inicio = -1;
    for (let x = 0; x <= largura; x++) {
      const escuro = x < largura && data[y * largura + x] < TRACO;
      if (escuro && inicio < 0) inicio = x;
      if (!escuro && inicio >= 0) {
        if (x - inicio >= minHorizontal) for (let k = inicio; k < x; k++) apagar[y * largura + k] = 1;
        inicio = -1;
      }
    }
  }
  for (let x = 0; x < largura; x++) {
    let inicio = -1;
    for (let y = 0; y <= altura; y++) {
      const escuro = y < altura && data[y * largura + x] < TRACO;
      if (escuro && inicio < 0) inicio = y;
      if (!escuro && inicio >= 0) {
        if (y - inicio >= minVertical) for (let k = inicio; k < y; k++) apagar[k * largura + x] = 1;
        inicio = -1;
      }
    }
  }
  for (let i = 0; i < largura * altura; i++) if (apagar[i]) data[i] = 255;
}

/**
 * Le uma pagina de FORMULARIO (o RDV escaneado ou fotografado): tira as linhas
 * da tabela e le a pagina como uma coluna de linhas, guardando a posicao de
 * cada palavra.
 *
 * giro vira a imagem antes de ler: escaneado deitado sai ilegivel de primeira.
 * Devolve { texto, linhas: [{ y, palavras: [{ s, x0, y0, x1, y1 }] }], cinza:
 * { data, largura, altura } } - a imagem ja sem as linhas, para quem quiser
 * medir tinta nela - ou null quando nao leu.
 */
export function lerFormulario(origem, giro = 0) {
  const tarefa = fila.then(async () => {
    let relogio;
    let w = null;
    try {
      const estourou = new Promise((_, recusar) => {
        relogio = setTimeout(() => recusar(new Error('ocr passou do tempo')), TEMPO_POR_FOTO);
      });
      const leitura = (async () => {
        const { default: sharp } = await import('sharp');
        // Primeiro respeita a orientacao gravada pelo celular; so depois gira.
        const emPe = await sharp(origem, { failOn: 'none' }).rotate().toBuffer();
        const { data, info } = await sharp(emPe)
          .rotate(giro)
          .resize({ width: LADO_DA_TABELA, height: LADO_DA_TABELA, fit: 'inside', withoutEnlargement: false })
          .grayscale()
          .normalize()
          .raw()
          .toBuffer({ resolveWithObject: true });
        tirarLinhasDeTabela(data, info.width, info.height);
        const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();

        w = await pegarWorker();
        // 4 = "uma coluna de texto de tamanhos variados": le linha a linha, que
        // e o formato da tabela. O padrao (bloco unico) embaralha as colunas.
        await w.setParameters({ tessedit_pageseg_mode: '4' });
        const { data: lido } = await w.recognize(png);
        const linhas = (lido.lines || [])
          .map((l) => ({
            y: l.bbox.y0,
            palavras: (l.words || [])
              .filter((p) => String(p.text || '').trim())
              .map((p) => ({ s: p.text.trim(), x0: p.bbox.x0, y0: p.bbox.y0, x1: p.bbox.x1, y1: p.bbox.y1 })),
          }))
          .filter((l) => l.palavras.length);
        return { texto: String(lido.text || ''), linhas, cinza: { data, largura: info.width, altura: info.height } };
      })();
      return await Promise.race([leitura, estourou]);
    } catch (e) {
      if (/passou do tempo/.test(String(e?.message))) {
        const velho = worker;
        worker = null;
        w = null;
        velho?.terminate().catch(() => {});
      }
      return null;
    } finally {
      clearTimeout(relogio);
      // As fotos de comprovante continuam sendo lidas no modo de sempre.
      if (w && worker === w) await w.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
    }
  });
  fila = tarefa.catch(() => {});
  return tarefa;
}

/** O conteudo do QR code da imagem, ou '' se nao houver (ou nao der para ler). */
export async function qrDaImagem(caminho) {
  try {
    const { default: sharp } = await import('sharp');
    const { default: jsQR } = await import('jsqr');
    // O QR da nota e pequeno dentro da foto: tenta em dois tamanhos.
    for (const lado of [1600, 2600]) {
      const { data, info } = await sharp(caminho, { failOn: 'none' })
        .rotate()
        .resize({ width: lado, height: lado, fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const qr = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
      if (qr?.data) return qr.data;
    }
  } catch {
    // imagem que nao abre: sem QR
  }
  return '';
}

/** Desliga o worker (testes e encerramento do servidor). */
export async function encerrarOcr() {
  await fila;
  if (worker) await worker.terminate();
  worker = null;
}
