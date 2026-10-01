// Fotos coladas num PowerPoint (.pptx): o portal tira as fotos de dentro e le.
//   node testes/pptx.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import sharp from 'sharp';
import { fotosDoPptx } from '../src/pptx.js';
import { motivoDeNaoConseguirLer } from '../src/extrair.js';
import { lerArquivoSolto } from '../src/leitura-comprovantes.js';
import { encerrarOcr } from '../src/ocr.js';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-pptx-'));

// Uma "foto": ruido colorido, para o jpeg nao sair minusculo.
async function foto(largura, altura, semente) {
  const pixels = Buffer.alloc(largura * altura * 3);
  let s = semente;
  for (let i = 0; i < pixels.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = s % 256;
  }
  return sharp(pixels, { raw: { width: largura, height: altura, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
}

function montarPptx(nome, arquivos) {
  const destino = path.join(pasta, nome);
  return new Promise((ok, falhou) => {
    const saida = fs.createWriteStream(destino);
    const zip = archiver('zip');
    saida.on('close', () => ok(destino));
    zip.on('error', falhou);
    zip.pipe(saida);
    for (const [caminho, dados] of arquivos) zip.append(dados, { name: caminho });
    zip.finalize();
  });
}

try {
  const comFotos = await montarPptx('painel.pptx', [
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/slides/slide1.xml', '<sld/>'],
    // Fora de ordem no arquivo: a ordem que vale e a do numero (a de colagem).
    ['ppt/media/image10.jpeg', await foto(320, 240, 3)],
    ['ppt/media/image2.jpeg', await foto(320, 240, 2)],
    ['ppt/media/image1.png', await sharp(await foto(320, 240, 1)).png().toBuffer()],
    ['ppt/media/icone.png', Buffer.from('pequeno demais para ser foto')],
    ['ppt/media/video1.mp4', Buffer.alloc(20000)],
  ]);

  const fotos = await fotosDoPptx(comFotos);
  assert.deepEqual(fotos.map((f) => f.nome), ['image1.png', 'image2.jpeg', 'image10.jpeg']);
  assert.ok(fotos.every((f) => f.dados.length > 8000));
  assert.equal((await fotosDoPptx(comFotos, 2)).length, 2, 'respeita o limite');

  // No envio: PowerPoint com foto passa; sem foto, ou que nao e zip, e recusado.
  assert.equal(await motivoDeNaoConseguirLer(comFotos, '.pptx'), null);
  const semFotos = await montarPptx('vazio.pptx', [['ppt/slides/slide1.xml', '<sld/>']]);
  assert.match(await motivoDeNaoConseguirLer(semFotos, '.pptx'), /nao tem nenhuma foto/);
  const quebrado = path.join(pasta, 'quebrado.pptx');
  fs.writeFileSync(quebrado, 'isto nao e um zip');
  assert.match(await motivoDeNaoConseguirLer(quebrado, '.pptx'), /nao tem nenhuma foto/);
  assert.deepEqual(await fotosDoPptx(quebrado), []);

  // A leitura por codigo passa o OCR nas fotos de dentro.
  const lido = await lerArquivoSolto(comFotos, 'odometro', 'painel.pptx');
  assert.equal(lido.metodo, 'pptx-ocr');

  console.log('OK - PowerPoint: as fotos saem de dentro em ordem, o envio recusa o que nao tem foto e o OCR le as fotos');
} finally {
  await encerrarOcr();
  fs.rmSync(pasta, { recursive: true, force: true });
}
