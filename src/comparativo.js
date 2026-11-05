// Comparativo de despesas da DSO: acrescenta o mes novo na planilha que o admin
// ja mantem (abas COMP PARA O DP, DSO 2026 e JUSTIFICATIVAS).
//
// Mexe direto no XML de dentro do .xlsx, e nao pelo exceljs, de proposito: a
// planilha tem vinculo com outro arquivo do SharePoint e regras de cor que o
// exceljs descarta ou reescreve ao salvar. Assim, o que nao e do mes novo sai
// byte a byte como entrou (fora as formulas compartilhadas, que viram normais).
//
// jszip ja veio junto com o exceljs, como o archiver/unzipper do backup.

import JSZip from 'jszip';

const ABA_COMP = 'COMP PARA O DP';
const ABA_DSO = 'DSO 2026';
const ABA_JUST = 'JUSTIFICATIVAS';

const MESES = [
  'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO',
];

// So o aprovado entra sozinho. O resto aparece na previa para o admin decidir.
const STATUS_APROVADO = 'CERTA';

// A mesma folga das regras de cor da planilha: acima disso, ficou verde.
const AUMENTO_MINIMO = 0.1;

// ------------------------------------------------------------------ ajudantes

const colNum = (letras) => [...letras].reduce((n, l) => n * 26 + l.charCodeAt(0) - 64, 0);

function colLetra(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const escaparXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const desescaparXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const REF = /(?<![\w!\]'.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?(?![\w(!])/g;

// Formula pode ter texto entre aspas, que nao e referencia.
const foraDasAspas = (f, fn) =>
  f.split('"').map((pedaco, i) => (i % 2 ? pedaco : fn(pedaco))).join('"');

/** Mesma conta de copiar e colar a formula: anda o que nao tem $. */
export function traduzir(f, dCol, dLin) {
  const anda = (ac, c, al, l) =>
    `${ac}${ac ? c : colLetra(colNum(c) + dCol)}${al}${al ? l : Number(l) + dLin}`;
  return foraDasAspas(f, (t) =>
    t.replace(REF, (_, ac, c, al, l, bc, c2, bl, l2) =>
      anda(ac, c, al, l) + (c2 ? `:${anda(bc, c2, bl, l2)}` : '')));
}

/** O que o Excel faz com as referencias ao inserir uma linha antes da `n`. */
export function ajustarAoInserir(f, n) {
  return foraDasAspas(f, (t) =>
    t.replace(REF, (_, ac, c, al, l, bc, c2, bl, l2) => {
      const ini = Number(l);
      if (!c2) return `${ac}${c}${al}${ini >= n ? ini + 1 : ini}`;
      const fim = Number(l2);
      // Terminar logo acima da linha nova e o SUM do grupo: ela entra na soma.
      const novoFim = fim >= n || fim === n - 1 ? fim + 1 : fim;
      return `${ac}${c}${al}${ini >= n ? ini + 1 : ini}:${bc}${c2}${bl}${novoFim}`;
    }));
}

export const normalizarNome = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

const PEQUENAS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
const pedacos = (s) => normalizarNome(s).split(' ').filter((p) => p.length > 1 && !PEQUENAS.has(p));

/** "Denis Cesar" e "Denis Cesar Assumpcao" sao a mesma: um contem o outro. */
function mesmoNome(a, b) {
  const [menor, maior] = a.length <= b.length ? [a, b] : [b, a];
  return menor.length >= 2 && menor.every((p) => maior.includes(p));
}

const serialDoMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return Date.UTC(a, m - 1, 1) / 86_400_000 + 25569;
};

function mesDoSerial(n) {
  const d = new Date((n - 25569) * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function mesAntes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

const centavos = (v) => Math.round(Number(v) * 100) / 100;

// ------------------------------------------------------------- ler a planilha

function lerAtributos(texto) {
  const a = {};
  for (const m of texto.matchAll(/([\w:]+)="([^"]*)"/g)) a[m[1]] = m[2];
  return a;
}

const escreverAtributos = (a) =>
  Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('');

function lerAba(xml) {
  const ini = xml.indexOf('<sheetData>');
  const fim = xml.indexOf('</sheetData>');
  if (ini < 0 || fim < 0) throw new Error('Uma das abas da planilha esta vazia.');

  const aba = { cabeca: xml.slice(0, ini), pe: xml.slice(fim + '</sheetData>'.length), linhas: new Map() };
  const mestres = new Map();

  for (const r of xml.slice(ini + '<sheetData>'.length, fim).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const attrs = lerAtributos(r[1]);
    const n = Number(attrs.r);
    delete attrs.r;
    delete attrs.spans; // opcional, e fica errado quando a linha ganha coluna
    const celulas = new Map();

    for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = lerAtributos(c[1]);
      const col = colNum(a.r.replace(/\d+/, ''));
      delete a.r;
      const dentro = c[2] || '';
      const cel = { attrs: a, f: null, fAttrs: {}, v: null, resto: '' };

      const f = dentro.match(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/);
      if (f) {
        const fa = lerAtributos(f[1]);
        if (fa.t === 'shared') {
          if (f[2]) mestres.set(fa.si, { f: f[2], col, n });
          const m = mestres.get(fa.si);
          cel.f = m.n === n && m.col === col ? m.f : traduzir(m.f, col - m.col, n - m.n);
        } else {
          cel.f = f[2] ?? '';
          cel.fAttrs = fa;
        }
      }
      const v = dentro.match(/<v>([\s\S]*?)<\/v>/);
      if (v) cel.v = v[1];
      const is = dentro.match(/<is>[\s\S]*?<\/is>/);
      if (is) cel.resto = is[0];
      celulas.set(col, cel);
    }
    aba.linhas.set(n, { attrs, celulas });
  }
  return aba;
}

function escreverAba(aba) {
  let maxCol = 1;
  let maxLin = 1;
  const linhas = [...aba.linhas.keys()].sort((a, b) => a - b).map((n) => {
    const { attrs, celulas } = aba.linhas.get(n);
    maxLin = Math.max(maxLin, n);
    const cs = [...celulas.keys()].sort((a, b) => a - b).map((col) => {
      maxCol = Math.max(maxCol, col);
      const c = celulas.get(col);
      const f = c.f !== null ? `<f${escreverAtributos(c.fAttrs)}>${c.f}</f>` : '';
      const v = c.v !== null ? `<v>${c.v}</v>` : '';
      const dentro = f + v + c.resto;
      const a = `r="${colLetra(col)}${n}"${escreverAtributos(c.attrs)}`;
      return dentro ? `<c ${a}>${dentro}</c>` : `<c ${a}/>`;
    });
    return `<row r="${n}"${escreverAtributos(attrs)}>${cs.join('')}</row>`;
  });
  const cabeca = aba.cabeca.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${colLetra(maxCol)}${maxLin}"/>`);
  return `${cabeca}<sheetData>${linhas.join('')}</sheetData>${aba.pe}`;
}

async function abrirPlanilha(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('Esse arquivo nao e um .xlsx valido.');
  }
  const ler = (nome) => zip.file(nome)?.async('string');

  const wb = await ler('xl/workbook.xml');
  const rels = await ler('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('Esse arquivo nao e um .xlsx valido.');

  const alvos = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = lerAtributos(m[0]);
    alvos[a.Id] = a.Target;
  }
  const caminhos = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const a = lerAtributos(m[0]);
    const alvo = alvos[a['r:id']] || '';
    caminhos[desescaparXml(a.name)] = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`;
  }
  for (const nome of [ABA_COMP, ABA_DSO, ABA_JUST]) {
    if (!caminhos[nome]) {
      throw new Error(`Esta nao parece ser a planilha do comparativo: falta a aba "${nome}".`);
    }
  }

  const textos = [];
  const ss = await ler('xl/sharedStrings.xml');
  for (const si of (ss || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    textos.push(desescaparXml([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }

  const abas = {};
  for (const nome of [ABA_COMP, ABA_DSO, ABA_JUST]) abas[nome] = lerAba(await ler(caminhos[nome]));
  return { zip, wb, rels, caminhos, textos, abas };
}

function valorDaCelula(cel, textos) {
  if (!cel) return null;
  if (cel.attrs.t === 's') return textos[Number(cel.v)] ?? null;
  if (cel.attrs.t === 'inlineStr') {
    return desescaparXml([...cel.resto.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
  }
  if (cel.attrs.t === 'str') return cel.v === null ? null : desescaparXml(cel.v);
  if (cel.attrs.t === 'e' || cel.v === null) return null;
  const n = Number(cel.v);
  return Number.isNaN(n) ? null : n;
}

/** Colunas de mes do cabecalho: { '2026-09': 20, ... } */
function colunasDeMes(aba) {
  const cols = {};
  for (const [col, cel] of aba.linhas.get(1)?.celulas ?? []) {
    if (cel.attrs.t || cel.v === null) continue;
    const n = Number(cel.v);
    if (n > 40000 && n < 60000) cols[mesDoSerial(n)] = col;
  }
  return cols;
}

/** Separa pessoas, totais e subtitulos (BEBIDAS, NESPRESSO...) de uma aba. */
function pessoasDaAba(aba, textos, colRef) {
  const out = [];
  for (const n of [...aba.linhas.keys()].sort((a, b) => a - b)) {
    if (n === 1) continue;
    const nome = valorDaCelula(aba.linhas.get(n).celulas.get(1), textos);
    if (typeof nome !== 'string' || !nome.trim() || /^TOTAL/i.test(nome.trim())) continue;
    const ref = aba.linhas.get(n).celulas.get(colRef);
    if (ref?.f?.includes('$1')) continue; // subtitulo repete o mes do cabecalho
    out.push({ n, nome });
  }
  return out;
}

/** Grupos da aba DSO: o TOTAL de cada um soma um intervalo so. */
function gruposDaAba(aba, textos, colRef) {
  const out = [];
  for (const [n, l] of aba.linhas) {
    const nome = valorDaCelula(l.celulas.get(1), textos);
    const f = l.celulas.get(colRef)?.f || '';
    if (typeof nome === 'string' && /^TOTAL/i.test(nome.trim()) && /^SUM\([A-Z]+\d+:[A-Z]+\d+\)$/.test(f)) {
      out.push({ nome: nome.trim(), n });
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

// -------------------------------------------------------------------- a previa

function montar(planilha, mes, pessoas, decisoes = {}) {
  const { abas, textos } = planilha;
  const nomesDecididos = decisoes.nomes || {};
  const valoresDigitados = decisoes.valores || {};

  const cols = colunasDeMes(abas[ABA_DSO]);
  const colsComp = colunasDeMes(abas[ABA_COMP]);
  const ultimo = Object.keys(cols).sort().pop();
  if (!ultimo) throw new Error('Nao achei as colunas de mes na aba DSO 2026.');
  if (Object.keys(colsComp).sort().pop() !== ultimo) {
    throw new Error(`As abas ${ABA_COMP} e ${ABA_DSO} estao em meses diferentes. Acerte a planilha antes.`);
  }
  const existe = Boolean(cols[mes]);
  if (!existe && mesAntes(mes) !== ultimo) {
    throw new Error(`A planilha vai ate ${ultimo}. O proximo mes que da para gerar e o seguinte a ele.`);
  }

  const dso = pessoas.filter((p) => p.empresa === 'DSO');
  const porId = new Map(pessoas.map((p) => [p.id, p]));

  const resolver = (nome) => {
    const salvo = nomesDecididos[normalizarNome(nome)];
    if (salvo && porId.has(Number(salvo))) return { pessoa: porId.get(Number(salvo)) };
    const t = pedacos(nome);
    const naDso = dso.filter((p) => mesmoNome(t, pedacos(p.nome)));
    if (naDso.length === 1) return { pessoa: naDso[0] };
    if (naDso.length > 1) return { candidatos: naDso.map((p) => p.id) };
    const fora = pessoas.filter((p) => p.empresa !== 'DSO' && mesmoNome(t, pedacos(p.nome)));
    if (fora.length === 1) return { candidatos: [], fora: fora[0] };
    return { candidatos: [] };
  };

  // A mesma pessoa aparece nas duas abas, as vezes com o nome escrito diferente.
  const itens = new Map();
  const linhasPorAba = { [ABA_COMP]: [], [ABA_DSO]: [] };
  for (const nomeAba of [ABA_COMP, ABA_DSO]) {
    const aba = abas[nomeAba];
    const c = colunasDeMes(aba);
    const colAnt = existe ? c[mesAntes(mes)] : c[ultimo];
    const colAtual = existe ? c[mes] : null;
    const refCol = colAtual || colAnt;

    for (const { n, nome } of pessoasDaAba(aba, textos, refCol)) {
      const r = resolver(nome);
      const chave = r.pessoa ? `u:${r.pessoa.id}` : `n:${normalizarNome(nome)}`;
      let item = itens.get(chave);
      if (!item) {
        const digitado = valoresDigitados[chave];
        const p = r.pessoa;
        const aprovado = p?.status === STATUS_APROVADO;
        const temRdv = p?.status && p.status !== 'RASCUNHO';
        let situacao = 'sem_nome';
        if (p) situacao = aprovado ? 'ok' : temRdv ? 'pendente' : 'sem_rdv';
        item = {
          chave,
          nome: p?.nome || nome.trim(),
          nome_planilha: nome.trim(),
          usuario_id: p?.id ?? null,
          status: p?.status ?? null,
          situacao,
          valor_portal: p?.status && p.status !== 'RASCUNHO' ? centavos(p.total) : null,
          valor: digitado != null && digitado !== '' && Number.isFinite(Number(digitado))
            ? centavos(digitado)
            : aprovado ? centavos(p.total) : null,
          candidatos: r.candidatos ?? null,
          aviso: r.fora ? `Está como ${r.fora.empresa} no portal: ${r.fora.nome}` : (p && p.empresa !== 'DSO' ? `Está como ${p.empresa} no portal` : null),
          atual: {},
          anterior: {},
        };
        itens.set(chave, item);
      }
      const l = aba.linhas.get(n).celulas;
      item.anterior[nomeAba] = valorDaCelula(l.get(colAnt), textos);
      if (colAtual) item.atual[nomeAba] = valorDaCelula(l.get(colAtual), textos);
      linhasPorAba[nomeAba].push({ n, nome, item });
    }
  }

  const naPlanilha = new Set([...itens.values()].map((i) => i.usuario_id).filter(Boolean));
  const novos = dso
    .filter((p) => p.ativo && !/^Adm/i.test(p.funcao || '') && p.status && p.status !== 'RASCUNHO' && !naPlanilha.has(p.id))
    .map((p) => ({
      usuario_id: p.id,
      nome: p.nome,
      status: p.status,
      valor_portal: centavos(p.total),
      valor: valoresDigitados[`u:${p.id}`] != null && valoresDigitados[`u:${p.id}`] !== ''
        ? centavos(valoresDigitados[`u:${p.id}`])
        : p.status === STATUS_APROVADO ? centavos(p.total) : null,
    }));

  return {
    existe,
    ultimo,
    itens: [...itens.values()],
    novos,
    linhasPorAba,
    grupos: gruposDaAba(abas[ABA_DSO], textos, existe ? cols[mes] : cols[ultimo]),
  };
}

export async function previaDoComparativo(buffer, mes, pessoas, decisoes) {
  const planilha = await abrirPlanilha(buffer);
  const m = montar(planilha, mes, pessoas, decisoes);
  return {
    mes,
    ultimo_mes_da_planilha: m.ultimo,
    coluna_ja_existe: m.existe,
    itens: m.itens,
    novos: m.novos,
    grupos: m.grupos.map((g) => g.nome),
    pessoas_dso: pessoas
      .filter((p) => p.empresa === 'DSO')
      .map((p) => ({ id: p.id, nome: p.nome }))
      .sort((a, b) => normalizarNome(a.nome).localeCompare(normalizarNome(b.nome))),
  };
}

// ------------------------------------------------------------ gravar o mes novo

const celulaDeNumero = (s, v) => ({ attrs: s ? { s } : {}, f: null, fAttrs: {}, v: String(v), resto: '' });
const celulaDeFormula = (s, f) => ({ attrs: s ? { s } : {}, f, fAttrs: {}, v: null, resto: '' });
const celulaVazia = (s) => ({ attrs: s ? { s } : {}, f: null, fAttrs: {}, v: null, resto: '' });
const celulaDeTexto = (s, texto) => ({
  attrs: { ...(s ? { s } : {}), t: 'inlineStr' },
  f: null,
  fAttrs: {},
  v: null,
  resto: `<is><t xml:space="preserve">${escaparXml(texto)}</t></is>`,
});

/** Cria as colunas "X x Y" e do mes, copiando o estilo das duas anteriores. */
function criarColunas(aba, textos, mes, colValorAnt) {
  const colDifAnt = colValorAnt - 1;
  const colDif = colValorAnt + 1;
  const colValor = colValorAnt + 2;
  const pessoas = new Set(pessoasDaAba(aba, textos, colValorAnt).map((p) => p.n));

  for (const [n, { celulas }] of aba.linhas) {
    const dif = celulas.get(colDifAnt);
    const val = celulas.get(colValorAnt);
    if (n === 1) {
      const [, m] = mes.split('-').map(Number);
      celulas.set(colDif, celulaDeTexto(dif?.attrs.s, `${MESES[(m + 10) % 12]} X ${MESES[m - 1]}`));
      celulas.set(colValor, celulaDeNumero(val?.attrs.s, serialDoMes(mes)));
    } else if (pessoas.has(n)) {
      const a = (c) => `${colLetra(c)}${n}`;
      celulas.set(colDif, celulaDeFormula(dif?.attrs.s, `${a(colValor)}-${a(colValorAnt)}`));
      celulas.set(colValor, celulaVazia(val?.attrs.s));
    } else {
      if (dif) celulas.set(colDif, dif.f !== null ? celulaDeFormula(dif.attrs.s, traduzir(dif.f, 2, 0)) : celulaVazia(dif.attrs.s));
      if (val) celulas.set(colValor, val.f !== null ? celulaDeFormula(val.attrs.s, traduzir(val.f, 2, 0)) : celulaVazia(val.attrs.s));
    }
  }

  // Largura: as duas seguem a coluna de valor. Com o mes ainda incompleto, a
  // diferenca dos totais fica grande e numa coluna estreita viraria ####.
  aba.cabeca = aba.cabeca.replace(/<cols>([\s\S]*?)<\/cols>/, (tudo, dentro) => {
    const defs = [...dentro.matchAll(/<col\b[^>]*\/>/g)].map((m) => lerAtributos(m[0]));
    const de = (c) => defs.find((d) => Number(d.min) <= c && Number(d.max) >= c);
    const novas = [[colDif, de(colValorAnt)], [colValor, de(colValorAnt)]]
      .filter(([c, d]) => d && !de(c))
      .map(([c, d]) => ({ ...d, min: String(c), max: String(c) }));
    return `<cols>${[...defs, ...novas].sort((a, b) => a.min - b.min).map((d) => `<col${escreverAtributos(d)}/>`).join('')}</cols>`;
  });

  // Regra de cor: onde a coluna de diferenca anterior pinta, a nova pinta igual.
  const letraAnt = colLetra(colDifAnt);
  const letraNova = colLetra(colDif);
  aba.pe = aba.pe.replace(/(<conditionalFormatting\b[^>]*sqref=")([^"]+)(")/g, (_, a, sq, z) => {
    const extras = sq.split(' ')
      .filter((r) => new RegExp(`^${letraAnt}\\d+(:${letraAnt}\\d+)?$`).test(r))
      .map((r) => r.replaceAll(letraAnt, letraNova));
    return a + [sq, ...extras].join(' ') + z;
  });
  return { colDif, colValor };
}

/** Insere uma linha vazia antes da `n`, com o estilo da linha `modelo`. */
function inserirLinha(aba, n, modelo) {
  const novas = new Map();
  for (const [k, l] of aba.linhas) {
    for (const c of l.celulas.values()) if (c.f !== null) c.f = ajustarAoInserir(c.f, n);
    novas.set(k >= n ? k + 1 : k, l);
  }
  const base = aba.linhas.get(modelo);
  const celulas = new Map();
  for (const [col, c] of base?.celulas ?? []) celulas.set(col, celulaVazia(c.attrs.s));
  const attrs = { ...(base?.attrs ?? {}) };
  novas.set(n, { attrs, celulas });
  aba.linhas = novas;
  aba.pe = aba.pe.replace(/(<conditionalFormatting\b[^>]*sqref=")([^"]+)(")/g, (_, a, sq, z) => a + ajustarAoInserir(sq, n) + z);
}

/** A COMP PARA O DP e em ordem alfabetica: reordena as linhas de pessoa. */
function ordenarComp(aba, textos, colRef) {
  const pessoas = pessoasDaAba(aba, textos, colRef);
  if (!pessoas.length) return;
  const posicoes = pessoas.map((p) => p.n);
  const ordem = [...pessoas].sort((a, b) => normalizarNome(a.nome).localeCompare(normalizarNome(b.nome), 'pt-BR'));
  const originais = new Map(pessoas.map((p) => [p.n, aba.linhas.get(p.n)]));
  ordem.forEach((p, i) => {
    const destino = posicoes[i];
    const linha = originais.get(p.n);
    if (destino !== p.n) {
      for (const c of linha.celulas.values()) if (c.f !== null) c.f = traduzir(c.f, 0, destino - p.n);
    }
    aba.linhas.set(destino, linha);
  });
}

function acrescentarJustificativas(aba, textos, mes, lista) {
  if (!lista.length) return 0;
  const serial = serialDoMes(mes);
  const numeros = [...aba.linhas.keys()].sort((a, b) => a - b);
  const jaTem = new Set();
  for (const n of numeros) {
    const c = aba.linhas.get(n).celulas;
    if (valorDaCelula(c.get(1), textos) === serial) {
      const nome = valorDaCelula(c.get(4), textos);
      if (nome) jaTem.add(normalizarNome(nome));
    }
  }
  const modelo = aba.linhas.get(numeros.find((n) => n > 1) ?? 1);
  let proxima = numeros[numeros.length - 1];
  let n = 0;
  for (const nome of lista) {
    if (jaTem.has(normalizarNome(nome))) continue;
    proxima += 1;
    const s = (col) => modelo?.celulas.get(col)?.attrs.s;
    aba.linhas.set(proxima, {
      attrs: {},
      celulas: new Map([
        [1, celulaDeNumero(s(1), serial)],
        [2, celulaVazia(s(2))],
        [3, celulaVazia(s(3))],
        [4, celulaDeTexto(s(4), nome.trim())],
        [5, celulaVazia(s(5))],
      ]),
    });
    n += 1;
  }
  return n;
}

function preencher(celulas, col, valor) {
  const c = celulas.get(col) ?? celulaVazia();
  celulas.set(col, { ...c, attrs: { ...(c.attrs.s ? { s: c.attrs.s } : {}) }, f: null, fAttrs: {}, v: String(valor), resto: '' });
}

/**
 * Grava o mes na planilha e devolve o arquivo novo. Coluna que ja existe so tem
 * as celulas VAZIAS preenchidas: valor digitado na mao nunca e sobrescrito.
 */
export async function gerarComparativo(buffer, mes, pessoas, decisoes = {}) {
  const planilha = await abrirPlanilha(buffer);
  const m = montar(planilha, mes, pessoas, decisoes);
  const { abas, textos } = planilha;

  const resumo = { lancados: 0, ja_preenchidos: 0, justificativas: 0, novos: 0, sem_valor: [] };
  const aumentaram = [];

  const novosEscolhidos = m.novos
    .map((p) => ({ ...p, grupo: decisoes.novos?.[p.usuario_id]?.grupo }))
    .filter((p) => p.grupo && p.valor != null);

  for (const nomeAba of [ABA_COMP, ABA_DSO]) {
    const aba = abas[nomeAba];
    const c = colunasDeMes(aba);
    let colValor;
    let colAnt;
    if (c[mes]) {
      colValor = c[mes];
      colAnt = c[mesAntes(mes)];
    } else {
      colAnt = c[m.ultimo];
      ({ colValor } = criarColunas(aba, textos, mes, colAnt));
    }

    for (const { n, item } of m.linhasPorAba[nomeAba]) {
      const celulas = aba.linhas.get(n).celulas;
      if (item.valor == null) {
        if (nomeAba === ABA_DSO) resumo.sem_valor.push(item.nome);
        continue;
      }
      if (valorDaCelula(celulas.get(colValor), textos) !== null) {
        if (nomeAba === ABA_DSO) resumo.ja_preenchidos += 1;
        continue;
      }
      preencher(celulas, colValor, item.valor);
      if (nomeAba === ABA_DSO) {
        resumo.lancados += 1;
        const antes = valorDaCelula(celulas.get(colAnt), textos);
        if (item.valor - (typeof antes === 'number' ? antes : 0) > AUMENTO_MINIMO) {
          aumentaram.push(valorDaCelula(celulas.get(1), textos));
        }
      }
    }

    for (const p of novosEscolhidos) {
      let linha;
      if (nomeAba === ABA_COMP) {
        linha = [...aba.linhas.keys()].find((n) => /^TOTAL/i.test(String(valorDaCelula(aba.linhas.get(n).celulas.get(1), textos) ?? '').trim()));
      } else {
        const grupo = gruposDaAba(aba, textos, colValor).find((g) => g.nome === p.grupo);
        if (!grupo) throw new Error(`Grupo "${p.grupo}" nao existe na aba DSO 2026.`);
        linha = grupo.n;
      }
      inserirLinha(aba, linha, linha - 1);
      const celulas = aba.linhas.get(linha).celulas;
      celulas.set(1, celulaDeTexto(celulas.get(1)?.attrs.s, p.nome));
      preencher(celulas, colValor, p.valor);
      celulas.set(colValor - 1, celulaDeFormula(
        celulas.get(colValor - 1)?.attrs.s,
        `${colLetra(colValor)}${linha}-${colLetra(colAnt)}${linha}`,
      ));
      if (nomeAba === ABA_DSO) {
        resumo.novos += 1;
        if (p.valor > AUMENTO_MINIMO) aumentaram.push(p.nome);
      }
    }

    if (nomeAba === ABA_COMP) ordenarComp(aba, textos, colValor);
  }

  resumo.justificativas = acrescentarJustificativas(abas[ABA_JUST], textos, mes, aumentaram);

  for (const nome of [ABA_COMP, ABA_DSO, ABA_JUST]) {
    planilha.zip.file(planilha.caminhos[nome], escreverAba(abas[nome]));
  }

  // O Excel recalcula tudo ao abrir. A lista de calculo antiga nao vale mais:
  // deixa-la no arquivo com celulas novas faz o Excel pedir "reparo".
  const zip = planilha.zip;
  zip.file('xl/workbook.xml', planilha.wb.replace(/<calcPr\b([^>]*?)\/>/, (t, a) =>
    (a.includes('fullCalcOnLoad') ? t : `<calcPr${a} fullCalcOnLoad="1"/>`)));
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    zip.file('xl/_rels/workbook.xml.rels', planilha.rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, ''));
    const tipos = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', tipos.replace(/<Override\b[^>]*calcChain[^>]*\/>/, ''));
  }

  const arquivo = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { arquivo, resumo };
}

// O comparativo da DISO (comparativo-diso.js) le e grava a planilha do mesmo
// jeito, entao usa os mesmos ajudantes.
export {
  colNum, colLetra, escaparXml, desescaparXml, lerAtributos, escreverAtributos,
  lerAba, escreverAba, valorDaCelula, pedacos, mesmoNome, serialDoMes, mesDoSerial,
  mesAntes, centavos, celulaDeNumero, celulaDeFormula, celulaVazia, celulaDeTexto,
  STATUS_APROVADO, MESES,
};
