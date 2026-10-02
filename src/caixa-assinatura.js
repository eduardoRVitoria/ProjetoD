// O RDV esta assinado? O que o codigo consegue ver, sem IA.
//
// "Sem assinatura do gov.br ou a mao = erro." O selo do gov.br o arquivo
// declara; assinatura a mao o codigo nao le - mas consegue ver se a CAIXA DE
// ASSINATURA do formulario esta em branco. A caixa fica logo acima do rotulo
// "ASSINATURA POR EXTENSO", ao lado da placa. A pagina e desenhada e conta-se
// a tinta dentro da caixa, descontando as linhas da propria tabela.
//
// A primeira versao procurava "qualquer imagem, anotacao ou risco curvo no
// arquivo" e deixava passar RDV em branco: a moldura da caixa tem canto
// arredondado (um risco curvo), e a marca d'agua de aplicativo e uma imagem.

const ESCALA = 3; // pixels por ponto do PDF
const ESCURO = 150; // luminosidade abaixo disto e tinta
const TINTA_MINIMA = 400; // pixels de tinta para dizer que ha algo na caixa

/**
 * Onde fica a caixa de assinatura na pagina, em pontos do PDF, ou null.
 * `itens` sao os textos da pagina: { s, x, y, l, a } (texto, canto esquerdo,
 * linha de base, largura, altura).
 */
export function regiaoDaCaixa(itens, larguraDaPagina) {
  const rotulo = itens.find((i) => /^\s*assinatura/i.test(i.s));
  if (!rotulo) return null;
  // O rotulo pode vir picado ("ASSINATURA" "POR" "EXTENSO"): junta a linha.
  const linha = itens.filter((i) => Math.abs(i.y - rotulo.y) <= 3 && i.x >= rotulo.x - 1 && i.x <= rotulo.x + 220);
  const centro = (rotulo.x + Math.max(...linha.map((i) => i.x + i.l))) / 2;
  const altura = rotulo.a || 7;

  // A linha da placa fica logo acima da caixa e comeca na borda esquerda dela.
  const placa = itens
    .filter((i) => /placa/i.test(i.s) && i.y > rotulo.y && i.y - rotulo.y < 120)
    .sort((a, b) => a.y - b.y)[0];
  const esquerda = placa ? placa.x : centro - 150;
  const direita = Math.min(larguraDaPagina - 4, centro + (centro - esquerda));
  const topo = placa ? placa.y - 3 : rotulo.y + 55;
  const base = rotulo.y + altura * 1.3;
  if (direita - esquerda < 60 || topo - base < 15) return null;
  // Um pouco para dentro, para a moldura ficar de fora.
  return { x1: esquerda + 6, x2: direita - 6, y1: base + 3, y2: topo - 3 };
}

/**
 * Quanta tinta ha num recorte { data, width, height } (RGBA), fora as linhas
 * da tabela. Linha de tabela e fina: so conta o pixel escuro que tem outro
 * escuro alguns pixels acima ou abaixo - letra, selo e caneta tem corpo. Coluna
 * quase toda escura e divisoria vertical, e tambem sai.
 */
export function tintaNoRecorte({ data, width, height }) {
  const escuro = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    escuro[i] = data[i * 4 + 3] > 40 && lum < ESCURO ? 1 : 0;
  }
  const PASSO = 5;
  let tinta = 0;
  for (let x = 0; x < width; x++) {
    let naColuna = 0;
    let comCorpo = 0;
    for (let y = 0; y < height; y++) {
      if (!escuro[y * width + x]) continue;
      naColuna++;
      const acima = y >= PASSO && escuro[(y - PASSO) * width + x];
      const abaixo = y + PASSO < height && escuro[(y + PASSO) * width + x];
      if (acima || abaixo) comCorpo++;
    }
    if (naColuna > height * 0.6) continue; // divisoria vertical
    tinta += comCorpo;
  }
  return tinta;
}

/**
 * O que o codigo ve da assinatura num PDF de RDV:
 *   selo  - tem campo de assinatura digital visivel (o selo do gov.br)
 *   caixa - 'vazia' | 'com_tinta' | null (nao achou a caixa: escaneado, foto
 *           salva como PDF, ou outro formulario)
 *   tinta - quantos pixels de tinta ha na caixa, quando ela foi achada
 */
export async function assinaturaNoPdf(pdf) {
  const saida = { selo: false, caixa: null, tinta: null };
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;

    for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
      const pagina = await doc.getPage(p);
      const anotacoes = await pagina.getAnnotations();
      if (anotacoes.some((a) => a.subtype === 'Widget' && a.fieldType === 'Sig'
          && Array.isArray(a.rect) && a.rect[2] - a.rect[0] > 1 && a.rect[3] - a.rect[1] > 1)) {
        saida.selo = true;
      }
      if (saida.caixa) continue;

      const itens = (await pagina.getTextContent()).items
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], l: i.width || 0, a: i.height || 0 }));
      const [vx, , vx2, vy2] = pagina.view;
      const regiao = pagina.rotate === 0 ? regiaoDaCaixa(itens, vx2 - vx) : null;
      if (!regiao) continue;

      const viewport = pagina.getViewport({ scale: ESCALA });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pagina.render({ canvasContext: ctx, viewport }).promise;

      const x = Math.max(0, Math.floor((regiao.x1 - vx) * ESCALA));
      const y = Math.max(0, Math.floor((vy2 - regiao.y2) * ESCALA));
      const largura = Math.min(canvas.width - x, Math.ceil((regiao.x2 - regiao.x1) * ESCALA));
      const alturaPx = Math.min(canvas.height - y, Math.ceil((regiao.y2 - regiao.y1) * ESCALA));
      if (largura < 30 || alturaPx < 15) continue;
      saida.tinta = tintaNoRecorte(ctx.getImageData(x, y, largura, alturaPx));
      saida.caixa = saida.tinta >= TINTA_MINIMA ? 'com_tinta' : 'vazia';
    }
    await doc.destroy();
  } catch {
    // PDF que nao abre ou nao desenha: fica o que ja se sabia.
  }
  return saida;
}

/**
 * O RDV esta assinado - no gov.br ou a mao?
 *
 * `arquivos` e o que o codigo viu em cada arquivo de RDV:
 *   digital - assinatura digital no arquivo, ou o selo do gov.br na pagina
 *   caixa   - 'vazia' | 'com_tinta' | null (ver assinaturaNoPdf)
 * `daIa` e a resposta de quem olhou a imagem: 'sim', 'nao', ou nada.
 *
 * Devolve 'sim', 'nao', ou null quando ninguem conseguiu ver. Sem arquivo de
 * RDV devolve 'sem_rdv' - a falta do arquivo e outra cobranca.
 */
export function rdvEstaAssinado(arquivos, daIa) {
  if (!arquivos.length) return 'sem_rdv';
  if (arquivos.some((a) => a.digital)) return 'sim';
  // A conta ganha da IA: caixa em branco nao tem assinatura para ver.
  if (arquivos.every((a) => a.caixa === 'vazia')) return 'nao';
  if (daIa === 'sim' || daIa === 'nao') return daIa;
  // Sem a IA: tinta dentro da caixa de assinatura e alguem ter assinado.
  if (arquivos.some((a) => a.caixa === 'com_tinta')) return 'sim';
  return null;
}

// ------------------------------------------------- RDV escaneado ou em foto
//
// Sem texto no arquivo, a pagina e lida por OCR so para achar duas coisas: o
// carimbo impresso do gov.br ("Documento assinado digitalmente") e o rotulo
// "ASSINATURA POR EXTENSO". Achado o rotulo, mede-se a tinta na caixa acima
// dele, na propria imagem. A tabela de km o OCR nao le direito - mas rotulo e
// carimbo sao texto grande e limpo, e isso ele acerta.

const TINTA_MINIMA_NA_FOTO = 260; // a foto e lida a ~2,4 px por ponto, nao 3
const CARIMBO_DO_GOV = /ASSINADO\s+DIGITALMENTE|VALIDAR\.?\s*ITI\.?\s*GOV|ITI\.GOV\.BR/;
const semAcentos = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/**
 * Onde fica a caixa de assinatura numa pagina lida por OCR, em pixels (y para
 * baixo), ou null. `palavras` sao `{ s, x0, y0, x1, y1 }`.
 */
export function regiaoDaCaixaNaFoto(palavras, largura, altura) {
  const rotulo = palavras.find((p) => /^ASSINATURA/.test(semAcentos(p.s)));
  if (!rotulo) return null;
  const h = Math.max(8, rotulo.y1 - rotulo.y0);
  // "ASSINATURA POR EXTENSO": o que vem na mesma linha, logo a direita.
  const daLinha = palavras.filter((p) => Math.abs(p.y0 - rotulo.y0) < h * 0.8 && p.x0 >= rotulo.x0 - 2 && p.x0 <= rotulo.x1 + h * 9);
  const direitaDoRotulo = Math.max(...daLinha.map((p) => p.x1));
  const larguraDoRotulo = Math.max(direitaDoRotulo - rotulo.x0, h * 6);
  const centro = rotulo.x0 + larguraDoRotulo / 2;

  // A linha da placa fica logo acima da caixa.
  const placa = palavras
    .filter((p) => /PLACA|VEICULO/.test(semAcentos(p.s)) && p.y1 < rotulo.y0 && rotulo.y0 - p.y1 < h * 12)
    .sort((a, b) => b.y1 - a.y1)[0];

  const regiao = {
    x1: Math.max(0, Math.round(centro - larguraDoRotulo * 1.25)),
    x2: Math.min(largura, Math.round(centro + larguraDoRotulo * 1.25)),
    y1: Math.max(0, Math.round(placa ? placa.y1 + h * 0.5 : rotulo.y0 - h * 6.5)),
    y2: Math.round(rotulo.y0 - h * 0.5),
  };
  if (regiao.x2 - regiao.x1 < 60 || regiao.y2 - regiao.y1 < 20 || regiao.y2 > altura) return null;
  return regiao;
}

/**
 * O que o codigo ve da assinatura num RDV sem texto: `imagens` sao as paginas
 * (bytes ou caminho da foto). Devolve `{ selo, caixa, tinta }` como
 * `assinaturaNoPdf`: selo quando ha o carimbo impresso do gov.br; caixa
 * 'vazia' | 'com_tinta' quando achou o rotulo; null quando nao achou nada.
 */
export async function assinaturaNoEscaneado(imagens) {
  const { lerFormulario } = await import('./ocr.js');
  const saida = { selo: false, caixa: null, tinta: null };

  for (const imagem of imagens.slice(0, 3)) {
    // Escaneado deitado e comum: tenta em pe e virado para os dois lados.
    for (const giro of [0, 90, 270]) {
      const lido = await lerFormulario(imagem, giro);
      if (!lido) break;
      const texto = semAcentos(lido.texto);
      if (CARIMBO_DO_GOV.test(texto)) {
        saida.selo = true;
        return saida;
      }
      const { data, largura, altura } = lido.cinza;
      const regiao = regiaoDaCaixaNaFoto(lido.linhas.flatMap((l) => l.palavras), largura, altura);
      if (regiao) {
        // A imagem vem em tons de cinza e ja sem as linhas da tabela: o que
        // sobra dentro da caixa e so o que alguem escreveu ou carimbou.
        const l = regiao.x2 - regiao.x1;
        const a = regiao.y2 - regiao.y1;
        const recorte = new Uint8ClampedArray(l * a * 4).fill(255);
        for (let y = 0; y < a; y++) {
          for (let x = 0; x < l; x++) {
            const v = data[(regiao.y1 + y) * largura + regiao.x1 + x];
            const i = (y * l + x) * 4;
            recorte[i] = v;
            recorte[i + 1] = v;
            recorte[i + 2] = v;
          }
        }
        saida.tinta = tintaNoRecorte({ data: recorte, width: l, height: a });
        saida.caixa = saida.tinta >= TINTA_MINIMA_NA_FOTO ? 'com_tinta' : 'vazia';
        return saida;
      }
      // Leu o formulario em pe e nao ha rotulo: girar nao vai ajudar.
      if (/INICIAL|ITINERARIO|DESPESAS/.test(texto)) break;
    }
  }
  return saida;
}
