// A assinatura esta em cima da placa? Respondido por geometria, sem IA.
//
// Quem julgava isso era a IA olhando a imagem, e ela errava: no RDV do
// coordenador dos PROMOTORES de setembro o selo do gov.br ficou na caixa de
// assinatura, logo ABAIXO da linha "Placa do veiculo: TMC5G71", com a placa
// inteira visivel - e saiu "assinatura em cima da placa". Encostado nao e em
// cima.
//
// O PDF assinado no gov.br diz onde o selo esta (o retangulo do campo de
// assinatura) e onde o numero da placa esta (o texto, com posicao). Se os dois
// retangulos nao se cruzam, a placa esta visivel. E conta, nao opiniao.
//
// So responde quando tem os dois dados. RDV escaneado, foto, assinatura a mao
// ou placa que nao esta escrita em texto devolvem null - "nao sei".

import fs from 'node:fs';

// Placa antiga (ABC-1234) e Mercosul (ABC1D23).
const PLACA = /[A-Z]{3}[-\s]?\d[A-Z0-9]\d{2}/i;

/**
 * O retangulo do NUMERO da placa numa pagina, ou null.
 *
 * `itens` sao os textos da pagina: `{ s, x, y, l, a }` (texto, canto esquerdo,
 * linha de base, largura, altura), em pontos do PDF. O formulario escreve
 * "Placa do veiculo: ABC1D23" num item so ou picado em varios na mesma linha.
 */
export function retanguloDaPlaca(itens) {
  for (const rotulo of itens.filter((i) => /placa/i.test(i.s))) {
    const linha = itens
      .filter((i) => Math.abs(i.y - rotulo.y) <= 3 && i.x >= rotulo.x - 1 && i.x <= rotulo.x + 320)
      .sort((a, b) => a.x - b.x);

    // A posicao de cada letra, repartindo a largura do item por igual.
    let texto = '';
    const xDaLetra = [];
    for (const i of linha) {
      const passo = i.s.length ? i.l / i.s.length : 0;
      for (let c = 0; c < i.s.length; c++) xDaLetra.push([i.x + passo * c, i.x + passo * (c + 1)]);
      texto += i.s;
    }
    // Procura depois da palavra "placa", para o rotulo nao casar com nada.
    const inicio = texto.search(/placa/i) + 5;
    const m = PLACA.exec(texto.slice(inicio));
    if (!m) continue;
    const de = inicio + m.index;
    const ate = de + m[0].length - 1;
    const altura = Math.max(...linha.map((i) => i.a || 0)) || 7;
    return {
      placa: m[0].toUpperCase(),
      x1: xDaLetra[de][0],
      x2: xDaLetra[ate][1],
      // Letra maiuscula e numero nao descem da linha de base.
      y1: rotulo.y,
      y2: rotulo.y + altura * 0.75,
    };
  }
  return null;
}

/**
 * O selo cobre a placa? `selos` sao retangulos `[x1, y1, x2, y2]`.
 *
 * Encostar nao conta: o selo precisa entrar pelo menos um quarto da altura da
 * letra, e um pouco na largura, para esconder alguma coisa.
 */
export function seloCobre(placa, selos) {
  const altura = placa.y2 - placa.y1;
  return selos.some(([x1, y1, x2, y2]) => {
    const naLargura = Math.min(x2, placa.x2) - Math.max(x1, placa.x1);
    const naAltura = Math.min(y2, placa.y2) - Math.max(y1, placa.y1);
    return naLargura > 1 && naAltura > altura * 0.25;
  });
}

/**
 * Confere um PDF de RDV. Devolve `{ situacao: 'sim' | 'nao', placa }`, ou null
 * quando nao da para saber por codigo.
 */
export async function assinaturaSobrePlaca(caminho) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(caminho)),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;

    let resposta = null;
    let temSelo = false;
    for (let p = 1; p <= Math.min(doc.numPages, 10) && resposta?.situacao !== 'sim'; p++) {
      const pagina = await doc.getPage(p);
      const selos = (await pagina.getAnnotations())
        .filter((a) => a.subtype === 'Widget' && a.fieldType === 'Sig' && Array.isArray(a.rect))
        .map((a) => a.rect)
        // Assinatura invisivel tem retangulo vazio: nao cobre nada.
        .filter(([x1, y1, x2, y2]) => x2 - x1 > 1 && y2 - y1 > 1);
      if (selos.length) temSelo = true;

      const itens = (await pagina.getTextContent()).items
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], l: i.width || 0, a: i.height || 0 }));
      const placa = retanguloDaPlaca(itens);
      if (!placa) continue;

      resposta = { situacao: seloCobre(placa, selos) ? 'sim' : 'nao', placa: placa.placa };
    }
    await doc.destroy();

    // Placa em texto mas nenhum selo no arquivo: assinado a mao ou escaneado
    // depois de assinar. O codigo nao enxerga caneta - fica "nao sei".
    return resposta && temSelo ? resposta : null;
  } catch {
    return null;
  }
}
