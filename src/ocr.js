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
    try {
      const w = await pegarWorker();
      const { data } = await w.recognize(await preparar(caminho));
      return String(data.text || '');
    } catch {
      return '';
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
