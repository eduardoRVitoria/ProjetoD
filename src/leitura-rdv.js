// Le o RDV por CODIGO, sem IA.
//
// O formulario da empresa e sempre a mesma planilha salva em PDF: um quadro de
// resumo (KM R$, PEDAGIO + ESTACIONAMENTO, HOTEL, OUTROS, placa) e uma tabela
// com uma linha por dia (data, km inicial, km final, total, R$, itinerario).
// PDF gerado assim tem texto de verdade, com posicao - da para ler sem modelo
// nenhum, na hora e de graca.
//
// Nasceu em 01/10/2026: a conta da API ficou sem credito no dia do fechamento e
// ninguem conseguia enviar o mes, porque a leitura do RDV so existia pela IA.
// Agora a IA so entra no que o codigo nao alcanca: foto e PDF escaneado.
//
// Devolve o mesmo formato que a ferramenta `transcrever_rdv` do extrair.js.
//
// As variacoes que os PDFs de julho e agosto mostraram, e que estao tratadas:
//   - Excel em ingles: data em mes/dia e numero como "1,793.70";
//   - planilha larga demais, impressa em duas metades: a esquerda (data e km)
//     numa pagina e a direita (R$ e itinerario) em outra, na mesma altura;
//   - formato contabil, com o valor entre parenteses.

import fs from 'node:fs';

const DATA = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
const INTEIRO = /^\d{1,3}(?:\.\d{3})+$|^\d+$/;
const DINHEIRO = /^-?\d{1,3}(?:\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/;
const DINHEIRO_EUA = /^-?\d{1,3}(?:,\d{3})*\.\d{2}$/;

/** "1.234,56" -> 1234.56; "134.029" -> 134029. */
function numeroBr(s) {
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * As linhas do PDF, de cima para baixo: `{ pagina, y, tokens: [{ s, x }] }`.
 * Devolve [] quando o PDF nao tem texto (escaneado, foto salva como PDF) ou
 * nao abre.
 */
export async function linhasDoPdf(caminho) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(caminho)),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;

    const todas = [];
    for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
      const pagina = await doc.getPage(p);
      const conteudo = await pagina.getTextContent();
      const itens = conteudo.items
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ x: i.transform[4], y: i.transform[5], l: i.width || 0, s: i.str }));

      // Agrupa por altura: itens da mesma linha da tabela tem o mesmo y.
      const porY = [];
      for (const i of itens) {
        let linha = porY.find((g) => Math.abs(g.y - i.y) <= 3);
        if (!linha) porY.push((linha = { y: i.y, itens: [] }));
        linha.itens.push(i);
      }
      porY.sort((a, b) => b.y - a.y);

      for (const g of porY) {
        g.itens.sort((a, b) => a.x - b.x);
        // Palavra acentuada chega picada ("Itiner" "a" "rio"): pedaco colado no
        // anterior, sem espaco entre eles, e a mesma palavra.
        const pedacos = [];
        let fim = null;
        for (const i of g.itens) {
          const ultimo = pedacos[pedacos.length - 1];
          if (ultimo && i.x - fim < 1.5 && !/\s$/.test(ultimo.s) && !/^\s/.test(i.s)) ultimo.s += i.s;
          else pedacos.push({ s: i.s, x: i.x });
          fim = i.x + i.l;
        }
        // Um item pode trazer varias palavras ("R$ 2.750,40"): quebra em tokens.
        // Os tokens do mesmo item ficam com o x do item - basta para saber a coluna.
        const tokens = pedacos.flatMap((p) => p.s.trim().split(/\s+/).filter(Boolean).map((s) => ({ s, x: p.x })));
        todas.push({ pagina: p, y: g.y, tokens });
      }
    }
    await doc.destroy();
    return todas;
  } catch {
    return [];
  }
}

/** O primeiro valor em reais da linha; "R$ -" e zero. */
function valorDaLinha(palavras) {
  for (let i = 0; i < palavras.length; i++) {
    if (DINHEIRO.test(palavras[i])) return numeroBr(palavras[i]);
    if (palavras[i] === '-' && i > 0 && /R\$$/.test(palavras[i - 1])) return 0;
  }
  return null;
}

/** Tira "R$", o valor do dia e o que sobrar e o itinerario. */
function itinerarioDe(palavras) {
  const resto = [...palavras];
  if (resto[0] === 'R$') resto.shift();
  if (resto.length && (DINHEIRO.test(resto[0]) || resto[0] === '-')) resto.shift();
  return resto.join(' ').trim();
}

/**
 * Transforma as linhas de texto no RDV estruturado. Funcao pura: recebe o que
 * `linhasDoPdf` devolve, e o que os testes exercitam.
 */
export function interpretarRdv(linhasDoDocumento) {
  // ---- limpeza: parenteses do formato contabil e numero em formato americano
  let br = 0;
  let eua = 0;
  for (const l of linhasDoDocumento) {
    for (const t of l.tokens) {
      t.s = t.s.replace(/^\((?=R\$|\d|$)/, '').replace(/(?<=\d|^)\)$/, '');
      if (DINHEIRO.test(t.s)) br++;
      else if (DINHEIRO_EUA.test(t.s)) eua++;
    }
  }
  const americano = eua > br;
  const linhasLimpas = linhasDoDocumento
    .map((l) => ({
      ...l,
      tokens: l.tokens
        .filter((t) => t.s)
        .map((t) => (americano && /^-?[\d.,]+$/.test(t.s)
          ? { ...t, s: t.s.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.')) }
          : t)),
    }))
    .filter((l) => l.tokens.length);

  const totais = {
    total_km: null,
    taxa_por_km: null,
    valor_total_km: null,
    pedagio_estacionamento: null,
    hotel: null,
    outros: null,
    outros_descricao: null,
  };
  let nome = '';
  let esperandoNome = false;
  let placas = '';
  let ehFormulario = false;
  let colunas = null; // x de "Km Inicial", "Km Final" e "Total" no cabecalho
  const dias = [];
  const soltas = []; // linhas "R$ 83,70 Tatui" da metade direita, em outra pagina
  const candidatosATotal = [];

  for (const linha of linhasLimpas) {
    const palavras = linha.tokens.map((t) => t.s);
    const texto = palavras.join(' ');
    const chapado = semAcento(texto).toUpperCase();
    const primeiro = semAcento(palavras[0]).toUpperCase();

    // ---- cabecalho
    if (esperandoNome) {
      if (!texto.includes(':') && /[A-Za-z]{3}/.test(texto)) nome = texto.slice(0, 120);
      esperandoNome = false;
    }
    const mNome = texto.match(/Nome\s+Completo\s*:?\s*(.*)$/i);
    if (mNome && !nome) {
      nome = mNome[1].trim().slice(0, 120);
      esperandoNome = !nome; // o nome caiu na linha de baixo
    }

    const mPlaca = chapado.match(/PLACA\s+DO\s+VEICULO\s*:?\s*(.*)$/);
    if (mPlaca && !placas) placas = mPlaca[1].trim().slice(0, 40);

    // ---- quadro de resumo
    const iPlaca = palavras.findIndex((t) => /^placa$/i.test(t));
    const resumo = iPlaca >= 0 ? palavras.slice(0, iPlaca) : palavras;
    if (/^KM\s+R\$/.test(chapado)) {
      ehFormulario = true;
      totais.valor_total_km ??= valorDaLinha(resumo.slice(2));
    } else if (primeiro.startsWith('PEDAGIO')) {
      totais.pedagio_estacionamento ??= valorDaLinha(resumo);
    } else if (primeiro === 'HOTEL') {
      totais.hotel ??= valorDaLinha(resumo);
    } else if (primeiro === 'OUTROS') {
      totais.outros ??= valorDaLinha(resumo);
    }

    // ---- cabecalho da tabela: "Data | Km Inicial | Km Final | Total KM | R$ 0,90 | Itinerario"
    if (/KM\s+INICIAL/.test(chapado)) {
      ehFormulario = true;
      const t = linha.tokens;
      const iInicial = t.findIndex((k) => /^inicial$/i.test(k.s));
      const iFinal = t.findIndex((k) => /^final$/i.test(k.s));
      const iTotal = t.findIndex((k) => /^total$/i.test(k.s));
      if (iInicial > 0 && iFinal > 0) {
        colunas = {
          inicial: t[iInicial - 1].x,
          final: t[iFinal - 1].x,
          total: iTotal >= 0 ? t[iTotal].x : null,
        };
      }
    }
    // A taxa por km mora no cabecalho ("R$ 0,90"), que pode estar noutra pagina.
    if (totais.taxa_por_km == null && /ITINERARIO/.test(chapado)) {
      const taxa = palavras.find((p) => DINHEIRO.test(p));
      if (taxa) totais.taxa_por_km = numeroBr(taxa);
      continue;
    }

    // ---- um dia da tabela
    const mData = palavras[0].match(DATA);
    if (mData) {
      const resto = linha.tokens.slice(1);
      const inteiros = [];
      while (resto.length && INTEIRO.test(resto[0].s) && inteiros.length < 3) inteiros.push(resto.shift());

      let ki = 0;
      let kf = 0;
      if (colunas) {
        // Cada numero vai para a coluna mais proxima: e o que acerta o dia em
        // que so o km inicial foi preenchido, ou so o total.
        for (const n of inteiros) {
          const alvos = [['ki', colunas.inicial], ['kf', colunas.final], ['total', colunas.total]]
            .filter(([, x]) => x != null)
            .sort((a, b) => Math.abs(a[1] - n.x) - Math.abs(b[1] - n.x));
          if (alvos[0][0] === 'ki') ki = numeroBr(n.s);
          else if (alvos[0][0] === 'kf') kf = numeroBr(n.s);
        }
      } else if (inteiros.length >= 2) {
        ki = numeroBr(inteiros[0].s);
        kf = numeroBr(inteiros[1].s);
      }

      dias.push({
        a: Number(mData[1]),
        b: Number(mData[2]),
        ano: mData[3] ? Number(mData[3]) : null,
        pagina: linha.pagina,
        y: linha.y,
        km_inicial: ki,
        km_final: kf,
        itinerario: itinerarioDe(resto.map((t) => t.s)),
      });
      continue;
    }

    // ---- metade direita da tabela, sem a data: "R$ 83,70 Tatui-Boituva"
    if (palavras[0] === 'R$' && palavras.length >= 2 && (DINHEIRO.test(palavras[1]) || palavras[1] === '-')) {
      soltas.push({ pagina: linha.pagina, y: linha.y, palavras });
    }

    // ---- a linha de total, abaixo dos dias: "3.056 R$ 2.750,40" ou so "2.478"
    const naColunaDoTotal = colunas?.total == null || Math.abs(linha.tokens[0].x - colunas.total) < 60;
    if (dias.length && INTEIRO.test(palavras[0]) && naColunaDoTotal) {
      candidatosATotal.push({ km: numeroBr(palavras[0]), valor: valorDaLinha(palavras.slice(1)) });
    }
  }

  if (!ehFormulario || !dias.length) return vazio();

  // Linhas em branco do rodape tambem somam "0": o total e o maior.
  const total = candidatosATotal.sort((a, b) => b.km - a.km)[0];
  if (total) {
    totais.total_km = total.km;
    totais.valor_total_km ??= total.valor;
  }

  // ---- planilha partida em duas paginas: casa cada dia com a linha da mesma
  // altura na pagina da direita. A n-esima pagina de dias casa com a n-esima
  // pagina so de "R$ ...".
  if (dias.every((d) => !d.itinerario) && soltas.length) {
    const paginasDeDias = [...new Set(dias.map((d) => d.pagina))];
    const paginasSoltas = [...new Set(soltas.map((s) => s.pagina))].filter((p) => !paginasDeDias.includes(p));
    for (const d of dias) {
      const par = paginasSoltas[paginasDeDias.indexOf(d.pagina)];
      const s = soltas.find((k) => k.pagina === par && Math.abs(k.y - d.y) <= 3);
      if (s) d.itinerario = itinerarioDe(s.palavras);
    }
  }

  // ---- dia/mes ou mes/dia? O relatorio e de um mes so: a parte que quase nao
  // muda e o mes. Empate (um dia so, ou dia = mes) cai no jeito do documento.
  const distintos = (campo) => new Set(dias.map((d) => d[campo])).size;
  let mesPrimeiro = americano;
  if (dias.some((d) => d.a > 12)) mesPrimeiro = false;
  else if (dias.some((d) => d.b > 12)) mesPrimeiro = true;
  else if (distintos('a') !== distintos('b')) mesPrimeiro = distintos('a') < distintos('b');

  const anoPadrao = dias.find((d) => d.ano)?.ano ?? null;
  const linhas = [];
  for (const d of dias) {
    let ano = d.ano ?? anoPadrao;
    if (ano == null) continue;
    if (ano < 100) ano += 2000;
    const dia = mesPrimeiro ? d.b : d.a;
    const mes = mesPrimeiro ? d.a : d.b;
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    linhas.push({
      data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
      km_inicial: d.km_inicial,
      km_final: d.km_final,
      itinerario: d.itinerario,
      pedagio: 0,
      estacionamento: 0,
      combustivel: 0,
    });
  }

  // O mes do relatorio e o mes em que cai a maioria dos dias.
  const contagem = new Map();
  for (const l of linhas) contagem.set(l.data.slice(0, 7), (contagem.get(l.data.slice(0, 7)) || 0) + 1);
  const mesRef = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  return {
    nome_no_relatorio: nome,
    mes_referencia: mesRef,
    placas,
    linhas,
    totais_declarados: totais,
    confianca: totais.valor_total_km != null && totais.total_km != null ? 'alta' : 'media',
    problemas_de_leitura: [],
  };
}

const vazio = () => ({
  nome_no_relatorio: '',
  mes_referencia: '',
  placas: '',
  linhas: [],
  totais_declarados: {
    total_km: null, taxa_por_km: null, valor_total_km: null, pedagio_estacionamento: null,
    hotel: null, outros: null, outros_descricao: null,
  },
  confianca: 'baixa',
  problemas_de_leitura: [],
});

/**
 * Le um RDV em PDF por codigo. Devolve null quando nao da - PDF sem texto, ou
 * que nao e o formulario, ou o de gerente (tem coluna de combustivel por dia,
 * que este leitor ainda nao conhece) - e ai quem chamou decide o que fazer.
 */
export async function lerRdvPorCodigo(caminho) {
  const linhas = await linhasDoPdf(caminho);
  const temCombustivel = linhas.some((l) => /COMBUST/i.test(semAcento(l.tokens.map((t) => t.s).join(' '))));
  if (temCombustivel) return null;
  const dados = interpretarRdv(linhas);
  return dados.linhas.length ? dados : null;
}
