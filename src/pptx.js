// Fotos que chegam dentro de um PowerPoint.
//
// Tem gente que cola as fotos do painel (e os cupons) num .pptx e manda o
// arquivo. Um .pptx e um ZIP: as fotos ficam em ppt/media/. Aqui elas saem de
// la como imagens comuns, para serem lidas do mesmo jeito que uma foto solta -
// pela IA ou pelo OCR.

import unzipper from 'unzipper';

// So o que e foto de verdade. Icone, forma e video ficam de fora.
const FOTO = /^ppt\/media\/[^/]+\.(jpe?g|jfif|png|gif|webp|bmp|tiff?)$/i;
// Abaixo disto e icone ou enfeite do modelo do slide, nao foto de celular.
const MENOR_FOTO = 8 * 1024;

const numeroDoNome = (nome) => Number((nome.match(/(\d+)\.[^.]+$/) || [])[1] || 0);

/**
 * As fotos de um .pptx, na ordem em que foram coladas: `[{ nome, dados }]`.
 * Devolve [] quando o arquivo nao abre ou nao tem foto.
 */
export async function fotosDoPptx(caminho, max = 200) {
  try {
    const zip = await unzipper.Open.file(caminho);
    const arquivos = zip.files
      .filter((f) => f.type === 'File' && FOTO.test(f.path) && (f.uncompressedSize ?? MENOR_FOTO) >= MENOR_FOTO)
      .sort((a, b) => numeroDoNome(a.path) - numeroDoNome(b.path));
    const fotos = [];
    for (const f of arquivos.slice(0, max)) {
      fotos.push({ nome: f.path.split('/').pop(), dados: await f.buffer() });
    }
    return fotos;
  } catch {
    return [];
  }
}
