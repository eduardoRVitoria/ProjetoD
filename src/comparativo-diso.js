// Comparativo de despesas da DISO, no modelo da planilha que a DISO ja usa
// ("9-Setembro- Relatorio de Despesas 26.xlsx"):
//
//   - uma aba de lancamentos (MÊS | DIST | SUPERVISORES | KM | PEDAGIO |
//     PROVEDOR | CARTUCHO | OUTROS | TOTAL), uma linha por supervisor por mes;
//   - uma aba com a tabela dinamica "Soma de TOTAL" dos ultimos 4 meses e, ao
//     lado dela, MEDIA 4M, Diferenca (mes - mes anterior) e JUSTIFICATIVA.
//
// O mes novo entra assim: as linhas do mes vao para o fim dos lancamentos, o
// filtro passa a mostrar o mes novo, e a tabela dinamica anda um mes (sai o mais
// antigo, entra o novo). A tabela e redesenhada aqui mesmo, para o arquivo ja
// sair certo, e marcada para o Excel atualizar sozinho ao abrir.
//
// Como no da DSO, mexe direto no XML (ver comparativo.js): o resto do arquivo
// sai como entrou.

import JSZip from 'jszip';
import {
  colLetra, escaparXml, desescaparXml, lerAtributos, lerAba, escreverAba, valorDaCelula,
  normalizarNome, pedacos, mesmoNome, serialDoMes, mesDoSerial, mesAntes, centavos,
  celulaDeNumero, celulaDeFormula, celulaVazia, celulaDeTexto, STATUS_APROVADO, MESES,
} from './comparativo.js';

const GRUPOS = ['DISO', 'DISO-SP'];
const MESES_NA_TABELA = 4;
const CABECALHO = ['MÊS', 'DIST', 'SUPERVISORES', 'KM', 'PEDAGIO', 'PROVEDOR', 'CARTUCHO', 'OUTROS', 'TOTAL'];

// ------------------------------------------------------------------ ajudantes

const caminhoDe = (base, alvo) => {
  if (alvo.startsWith('/')) return alvo.slice(1);
  const partes = base.split('/').slice(0, -1);
  for (const p of alvo.split('/')) {
    if (p === '..') partes.pop();
    else if (p !== '.') partes.push(p);
  }
  return partes.join('/');
};

const relsDe = (caminho) => {
  const partes = caminho.split('/');
  const arq = partes.pop();
  return [...partes, '_rels', `${arq}.rels`].join('/');
};

function lerRels(xml) {
  const out = [];
  for (const m of (xml || '').matchAll(/<Relationship\b[^>]*>/g)) out.push(lerAtributos(m[0]));
  return out;
}

const mesDaData = (v) => v.slice(0, 7); // "2026-09-01T00:00:00" -> "2026-09"

function mesDepois(mes) {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
}

/** Itens de um <sharedItems>: [{ tipo: 's'|'d'|'n'|'m', v, attrs }] */
function lerItensCompartilhados(xml) {
  return [...xml.matchAll(/<(s|d|n|m|b|e)\b([^>]*?)\/>/g)].map((m) => {
    const a = lerAtributos(m[2]);
    return { tipo: m[1], v: a.v != null ? desescaparXml(a.v) : null, attrs: a };
  });
}

/** Itens de um <pivotField>: [{ x, h, m, n, resto }] na ordem em que aparecem. */
function lerItensDoCampo(xml) {
  return [...xml.matchAll(/<item\b([^>]*?)\/>/g)].map((m) => {
    const a = lerAtributos(m[1]);
    return { x: a.x != null ? Number(a.x) : null, h: a.h === '1', m: a.m === '1', n: a.n ?? null, t: a.t ?? null };
  });
}

const escreverItemDoCampo = (i) =>
  `<item${i.n != null ? ` n="${i.n}"` : ''}${i.m ? ' m="1"' : ''}${i.h ? ' h="1"' : ''}${i.t ? ` t="${i.t}"` : ''}${i.x != null ? ` x="${i.x}"` : ''}/>`;

// ------------------------------------------------------------- ler a planilha

async function abrirPlanilha(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('Esse arquivo nao e um .xlsx valido.');
  }
  const ler = (nome) => zip.file(nome)?.async('string');

  const wb = await ler('xl/workbook.xml');
  const relsWb = await ler('xl/_rels/workbook.xml.rels');
  if (!wb || !relsWb) throw new Error('Esse arquivo nao e um .xlsx valido.');

  const alvos = Object.fromEntries(lerRels(relsWb).map((r) => [r.Id, r.Target]));
  const abas = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const a = lerAtributos(m[0]);
    abas.push({ nome: desescaparXml(a.name), caminho: caminhoDe('xl/workbook.xml', alvos[a['r:id']] || '') });
  }

  const textos = [];
  const ss = await ler('xl/sharedStrings.xml');
  for (const si of (ss || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    textos.push(desescaparXml([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }

  // A aba de lancamentos e achada pelo cabecalho, a da tabela pela tabela
  // dinamica: o nome das abas (Planilha1, Planilha2) nao quer dizer nada.
  let dados = null;
  let tabela = null;
  for (const aba of abas) {
    const xml = await ler(aba.caminho);
    if (!xml) continue;
    const rels = lerRels(await ler(relsDe(aba.caminho)));
    const piv = rels.find((r) => /\/pivotTable$/.test(r.Type));
    if (piv && !tabela) {
      tabela = { ...aba, xml, ptCaminho: caminhoDe(aba.caminho, piv.Target) };
      continue;
    }
    if (!dados && xml.includes('<sheetData>')) {
      const lida = lerAba(xml);
      const cab = [...Array(CABECALHO.length)].map((_, i) =>
        normalizarNome(valorDaCelula(lida.linhas.get(1)?.celulas.get(i + 1), textos)));
      if (cab.every((c, i) => c === normalizarNome(CABECALHO[i]))) dados = { ...aba, aba: lida };
    }
  }
  if (!dados) {
    throw new Error('Nao achei a aba de lancamentos (MÊS, DIST, SUPERVISORES, KM, PEDAGIO, PROVEDOR, CARTUCHO, OUTROS, TOTAL).');
  }
  if (!tabela) throw new Error('Nao achei a tabela dinamica do comparativo na planilha.');

  tabela.aba = lerAba(tabela.xml);
  tabela.ptXml = await ler(tabela.ptCaminho);
  const relPt = lerRels(await ler(relsDe(tabela.ptCaminho))).find((r) => /\/pivotCacheDefinition$/.test(r.Type));
  if (!tabela.ptXml || !relPt) throw new Error('A tabela dinamica da planilha esta incompleta.');
  tabela.cdCaminho = caminhoDe(tabela.ptCaminho, relPt.Target);
  tabela.cdXml = await ler(tabela.cdCaminho);
  if (!tabela.cdXml) throw new Error('A tabela dinamica da planilha esta incompleta.');

  return { zip, wb, relsWb, textos, dados, tabela };
}

/** Lancamentos: [{ n, mes, dist, nome, total }] */
function lerLancamentos(aba, textos) {
  const out = [];
  for (const n of [...aba.linhas.keys()].sort((a, b) => a - b)) {
    if (n === 1) continue;
    const c = aba.linhas.get(n).celulas;
    const serial = valorDaCelula(c.get(1), textos);
    const nome = valorDaCelula(c.get(3), textos);
    if (typeof serial !== 'number' || typeof nome !== 'string' || !nome.trim()) continue;
    let total = valorDaCelula(c.get(9), textos);
    if (typeof total !== 'number') {
      total = [4, 5, 6, 7, 8].reduce((s, col) => {
        const v = valorDaCelula(c.get(col), textos);
        return s + (typeof v === 'number' ? v : 0);
      }, 0);
    }
    out.push({ n, mes: mesDoSerial(serial), dist: String(valorDaCelula(c.get(2), textos) ?? '').trim(), nome, total });
  }
  return out;
}

// -------------------------------------------------------------------- a previa

/** O que vai de cada pessoa: km, pedagio e o resto (estacionamento, hotel, outros). */
function partesDoPortal(p) {
  return {
    km: centavos(p.valor_km || 0),
    pedagio: centavos(p.pedagio || 0),
    outros: centavos((p.estac || 0) + (p.hotel || 0) + (p.outros || 0)),
  };
}

function montar(planilha, mes, pessoas, decisoes = {}) {
  const lanc = lerLancamentos(planilha.dados.aba, planilha.textos);
  const ultimo = lanc.map((l) => l.mes).sort().pop();
  if (!ultimo) throw new Error('A aba de lancamentos esta vazia.');
  if (lanc.some((l) => l.mes === mes)) {
    throw new Error(`${mes} ja esta lancado na planilha. Use a planilha de antes desse mes.`);
  }
  if (mesAntes(mes) !== ultimo) {
    throw new Error(`A planilha vai ate ${ultimo}. O proximo mes que da para gerar e ${mesDepois(ultimo)}.`);
  }

  const nomesDecididos = decisoes.nomes || {};
  const valoresDigitados = decisoes.valores || {};
  const diso = pessoas.filter((p) => p.empresa === 'DISO');
  const porId = new Map(pessoas.map((p) => [p.id, p]));

  const resolver = (nome) => {
    const salvo = nomesDecididos[normalizarNome(nome)];
    if (salvo && porId.has(Number(salvo))) return { pessoa: porId.get(Number(salvo)) };
    const t = pedacos(nome);
    const achados = diso.filter((p) => mesmoNome(t, pedacos(p.nome)));
    if (achados.length === 1) return { pessoa: achados[0] };
    if (achados.length > 1) return { candidatos: achados.map((p) => p.id) };
    const fora = pessoas.filter((p) => p.empresa !== 'DISO' && mesmoNome(t, pedacos(p.nome)));
    if (fora.length === 1) return { candidatos: [], fora: fora[0] };
    return { candidatos: [] };
  };

  const digitado = (chave) => {
    const d = valoresDigitados[chave];
    return d != null && d !== '' && Number.isFinite(Number(d)) ? centavos(d) : null;
  };

  // Quem estava no ultimo mes da planilha continua: e a lista de supervisores.
  const itens = [];
  const vistos = new Set();
  for (const l of lanc.filter((x) => x.mes === ultimo)) {
    const chaveNome = normalizarNome(l.nome);
    if (vistos.has(chaveNome)) continue;
    vistos.add(chaveNome);
    const r = resolver(l.nome);
    const p = r.pessoa;
    const chave = p ? `u:${p.id}` : `n:${chaveNome}`;
    const aprovado = p?.status === STATUS_APROVADO;
    const temRdv = p?.status && p.status !== 'RASCUNHO';
    let situacao = 'sem_nome';
    if (p) situacao = aprovado ? 'ok' : temRdv ? 'pendente' : 'sem_rdv';
    const valorDigitado = digitado(chave);
    itens.push({
      chave,
      nome: p?.nome || l.nome.trim(),
      nome_planilha: l.nome,
      dist: l.dist || GRUPOS[0],
      usuario_id: p?.id ?? null,
      status: p?.status ?? null,
      situacao,
      valor_portal: temRdv ? centavos(p.total) : null,
      valor: valorDigitado ?? (aprovado ? centavos(p.total) : null),
      // Valor digitado nao tem como ser separado em km e pedagio: vai inteiro em OUTROS.
      partes: valorDigitado != null ? { km: 0, pedagio: 0, outros: valorDigitado } : aprovado ? partesDoPortal(p) : null,
      anterior: centavos(l.total),
      candidatos: r.candidatos ?? null,
      aviso: r.fora ? `Está como ${r.fora.empresa} no portal: ${r.fora.nome}` : (p && p.empresa !== 'DISO' ? `Está como ${p.empresa} no portal` : null),
      atual: {},
    });
  }

  const naPlanilha = new Set(itens.map((i) => i.usuario_id).filter(Boolean));
  const novos = diso
    .filter((p) => p.ativo && p.funcao === 'Supervisor' && p.status && p.status !== 'RASCUNHO' && !naPlanilha.has(p.id))
    .map((p) => {
      const valorDigitado = digitado(`u:${p.id}`);
      const aprovado = p.status === STATUS_APROVADO;
      return {
        usuario_id: p.id,
        nome: p.nome,
        status: p.status,
        valor_portal: centavos(p.total),
        valor: valorDigitado ?? (aprovado ? centavos(p.total) : null),
        partes: valorDigitado != null ? { km: 0, pedagio: 0, outros: valorDigitado } : aprovado ? partesDoPortal(p) : null,
      };
    });

  return { ultimo, lanc, itens, novos };
}

/**
 * O mes a lancar sai da propria planilha: o seguinte ao ultimo que ela ja tem.
 * Assim nao importa qual mes esta aberto no admin.
 */
export async function mesParaLancarDiso(buffer) {
  const planilha = await abrirPlanilha(buffer);
  const ultimo = lerLancamentos(planilha.dados.aba, planilha.textos).map((l) => l.mes).sort().pop();
  if (!ultimo) throw new Error('A aba de lancamentos esta vazia.');
  return mesDepois(ultimo);
}

export async function previaDoComparativoDiso(buffer, mes, pessoas, decisoes) {
  const planilha = await abrirPlanilha(buffer);
  const m = montar(planilha, mes, pessoas, decisoes);
  return {
    mes,
    ultimo_mes_da_planilha: m.ultimo,
    coluna_ja_existe: false,
    itens: m.itens,
    novos: m.novos,
    grupos: GRUPOS,
    pessoas: pessoas
      .filter((p) => p.empresa === 'DISO')
      .map((p) => ({ id: p.id, nome: p.nome }))
      .sort((a, b) => normalizarNome(a.nome).localeCompare(normalizarNome(b.nome))),
  };
}

// ------------------------------------------------------------ gravar o mes novo

/** Acrescenta as linhas do mes no fim dos lancamentos e liga o filtro nele. */
function lancarMes(planilha, mes, linhasNovas) {
  const aba = planilha.dados.aba;
  const numeros = [...aba.linhas.keys()].sort((a, b) => a - b);
  const ultima = numeros[numeros.length - 1];
  const modelo = aba.linhas.get(ultima);
  const s = (col) => modelo?.celulas.get(col)?.attrs.s;
  const attrsLinha = { ...(modelo?.attrs ?? {}) };
  delete attrsLinha.hidden;

  // O filtro da aba mostrava o mes anterior: passa a mostrar so o novo.
  for (const n of numeros) if (n > 1) aba.linhas.get(n).attrs.hidden = '1';

  let n = ultima;
  for (const l of linhasNovas) {
    n += 1;
    const num = (col, v) => (v ? celulaDeNumero(s(col), v) : celulaVazia(s(col)));
    const total = centavos(l.partes.km + l.partes.pedagio + l.partes.outros);
    aba.linhas.set(n, {
      attrs: { ...attrsLinha },
      celulas: new Map([
        [1, celulaDeNumero(s(1), serialDoMes(mes))],
        [2, celulaDeTexto(s(2), l.dist)],
        [3, celulaDeTexto(s(3), l.nome)],
        [4, num(4, l.partes.km)],
        [5, num(5, l.partes.pedagio)],
        [6, celulaVazia(s(6))],
        [7, celulaVazia(s(7))],
        [8, num(8, l.partes.outros)],
        [9, { ...celulaDeFormula(s(9), `SUM(D${n}:H${n})`), v: String(total) }],
      ]),
    });
  }

  const [ano, m] = mes.split('-').map(Number);
  aba.pe = aba.pe
    .replace(/(<autoFilter\b[^>]*\bref=")A1:[A-Z]+\d+(")/, `$1A1:I${n}$2`)
    .replace(/<dateGroupItem\b[^>]*\/>/g, `<dateGroupItem year="${ano}" month="${m}" dateTimeGrouping="month"/>`);
  // A tabela da planilha tambem pode estar ordenada por um trecho velho: o
  // sortState so atrapalha o Excel ao abrir, entao sai.
  aba.pe = aba.pe.replace(/<sortState\b[\s\S]*?<\/sortState>/, '');
  return n;
}

/**
 * Anda a tabela dinamica um mes e a redesenha. Devolve o XML novo da tabela,
 * do cache e da aba onde ela fica.
 */
function andarTabela(planilha, mes, lancamentos) {
  const { tabela } = planilha;
  let pt = tabela.ptXml;
  let cd = tabela.cdXml;

  // --- cache: os 3 primeiros campos sao MÊS, DIST e SUPERVISORES
  const camposCache = [...cd.matchAll(/<cacheField\b[^>]*?(?:\/>|>[\s\S]*?<\/cacheField>)/g)].map((m) => m[0]);
  const nomeDoCampo = (xml) => desescaparXml(lerAtributos(xml.match(/<cacheField\b[^>]*>/)[0]).name);
  const iMes = camposCache.findIndex((c) => normalizarNome(nomeDoCampo(c)) === normalizarNome('MÊS'));
  const iDist = camposCache.findIndex((c) => normalizarNome(nomeDoCampo(c)) === 'dist');
  const iNome = camposCache.findIndex((c) => normalizarNome(nomeDoCampo(c)) === 'supervisores');
  if (iMes < 0 || iDist < 0 || iNome < 0) throw new Error('A tabela dinamica nao tem os campos MÊS, DIST e SUPERVISORES.');

  const itensCache = camposCache.map((c) => {
    const si = c.match(/<sharedItems\b[^>]*?(?:\/>|>([\s\S]*?)<\/sharedItems>)/);
    return lerItensCompartilhados(si?.[1] || '');
  });

  // --- campos da tabela, na mesma ordem dos do cache
  const camposPt = [...pt.matchAll(/<pivotField\b[^>]*?(?:\/>|>[\s\S]*?<\/pivotField>)/g)].map((m) => m[0]);
  const itensPt = camposPt.map((c) => lerItensDoCampo(c.match(/<items\b[^>]*>([\s\S]*?)<\/items>/)?.[1] || ''));

  // Mes novo: entra no fim do cache e da lista do campo.
  const novoDataStr = `${mes}-01T00:00:00`;
  if (!itensCache[iMes].some((i) => i.tipo === 'd' && mesDaData(i.v) === mes)) {
    itensCache[iMes].push({ tipo: 'd', v: novoDataStr, attrs: { v: novoDataStr } });
    itensPt[iMes].push({ x: itensCache[iMes].length - 1, h: false, m: false, n: null, t: null });
  }

  // Os 4 meses da tabela: o novo e os 3 anteriores.
  const visiveis = [mes];
  while (visiveis.length < MESES_NA_TABELA) visiveis.unshift(mesAntes(visiveis[0]));
  const mesDoItem = (it) => {
    const c = itensCache[iMes][it.x];
    return c?.tipo === 'd' ? mesDaData(c.v) : null;
  };
  for (const it of itensPt[iMes]) if (it.x != null) it.h = !visiveis.includes(mesDoItem(it));

  // Nome ou DIST que a tabela ainda nao conhece entra no fim, visivel.
  const posicao = (iCampo, texto) => {
    const lista = itensPt[iCampo];
    const achar = () => lista.findIndex((it) => {
      const c = itensCache[iCampo][it.x];
      return !it.m && c?.tipo === 's' && c.v === texto;
    });
    let pos = achar();
    if (pos >= 0) return pos;
    // O cache pode ja ter o nome como "nao usado" (u="1"), de quem saiu e voltou:
    // repetir o texto no cache faz o Excel pedir reparo, entao reaproveita.
    let xCache = itensCache[iCampo].findIndex((c) => c.tipo === 's' && c.v === texto);
    if (xCache >= 0) {
      delete itensCache[iCampo][xCache].attrs.u;
    } else {
      itensCache[iCampo].push({ tipo: 's', v: texto, attrs: { v: escaparXml(texto) } });
      xCache = itensCache[iCampo].length - 1;
    }
    pos = lista.findIndex((it) => it.x === xCache);
    if (pos >= 0) {
      lista[pos].m = false;
      lista[pos].h = false;
    } else {
      lista.push({ x: xCache, h: false, m: false, n: null, t: null });
      pos = lista.length - 1;
    }
    return pos;
  };

  // Soma por (DIST, nome) e mes, so dos 4 meses.
  const linhas = new Map();
  for (const l of lancamentos) {
    const iCol = visiveis.indexOf(l.mes);
    if (iCol < 0) continue;
    const pd = posicao(iDist, l.dist);
    const pn = posicao(iNome, l.nome);
    if (itensPt[iDist][pd].h || itensPt[iNome][pn].h) continue; // escondido na tabela
    const k = `${pd}|${pn}`;
    if (!linhas.has(k)) linhas.set(k, { pd, pn, dist: l.dist, valores: Array(MESES_NA_TABELA).fill(null) });
    const v = linhas.get(k).valores;
    v[iCol] = centavos((v[iCol] ?? 0) + l.total);
  }
  const ordem = [...linhas.values()].sort((a, b) => a.pd - b.pd || a.pn - b.pn);
  const rotuloNome = (pn) => {
    const it = itensPt[iNome][pn];
    return it.n != null ? desescaparXml(it.n) : itensCache[iNome][it.x].v;
  };

  // --- grava o cache
  const reescreverCampoCache = (xml, itens) =>
    xml.replace(/<sharedItems\b([^>]*?)(?:\/>|>[\s\S]*?<\/sharedItems>)/, (_, attrs) => {
      const a = lerAtributos(attrs);
      a.count = String(itens.length);
      const datas = itens.filter((i) => i.tipo === 'd').map((i) => i.v).sort();
      if (datas.length && a.maxDate) {
        const ult = datas[datas.length - 1];
        a.maxDate = `${ult.slice(0, 8)}02T00:00:00`;
      }
      const corpo = itens.map((i) => `<${i.tipo}${Object.entries(i.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('');
      return `<sharedItems${Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('')}>${corpo}</sharedItems>`;
    });
  let i = 0;
  cd = cd.replace(/<cacheField\b[^>]*?(?:\/>|>[\s\S]*?<\/cacheField>)/g, (c) => {
    const idx = i++;
    return [iMes, iDist, iNome].includes(idx) ? reescreverCampoCache(c, itensCache[idx]) : c;
  });
  // O Excel refaz tudo a partir dos lancamentos ao abrir.
  if (!/refreshOnLoad=/.test(cd)) cd = cd.replace(/<pivotCacheDefinition\b/, '<pivotCacheDefinition refreshOnLoad="1"');

  // --- grava a tabela
  i = 0;
  pt = pt.replace(/<pivotField\b[^>]*?(?:\/>|>[\s\S]*?<\/pivotField>)/g, (c) => {
    const idx = i++;
    if (![iMes, iDist, iNome].includes(idx)) return c;
    const lista = itensPt[idx];
    return c.replace(/<items\b[^>]*>[\s\S]*?<\/items>/, `<items count="${lista.length}">${lista.map(escreverItemDoCampo).join('')}</items>`);
  });

  const posMeses = visiveis.map((mv) => itensPt[iMes].findIndex((it) => mesDoItem(it) === mv));
  pt = pt.replace(/<colItems\b[^>]*>[\s\S]*?<\/colItems>/,
    `<colItems count="${posMeses.length}">${posMeses.map((p) => `<i>${p ? `<x v="${p}"/>` : '<x/>'}</i>`).join('')}</colItems>`);

  const x = (v) => (v ? `<x v="${v}"/>` : '<x/>');
  const rowItems = [];
  let distAnterior = null;
  for (const l of ordem) {
    rowItems.push(l.pd === distAnterior ? `<i r="1">${x(l.pn)}</i>` : `<i>${x(l.pd)}${x(l.pn)}</i>`);
    distAnterior = l.pd;
  }
  rowItems.push('<i t="grand"><x/></i>');
  pt = pt.replace(/<rowItems\b[^>]*>[\s\S]*?<\/rowItems>/, `<rowItems count="${rowItems.length}">${rowItems.join('')}</rowItems>`);

  const loc = pt.match(/<location\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/);
  const linhaIni = Number(loc[2]); // "Soma de TOTAL"
  const linhaCab = linhaIni + 1; // DIST | SUPERVISORES | meses
  const primeira = linhaCab + 1;
  const linhaTotal = primeira + ordem.length;
  pt = pt.replace(/(<location\b[^>]*\bref=")[A-Z]+\d+:[A-Z]+\d+"/, `$1${loc[1]}${linhaIni}:${loc[3]}${linhaTotal}"`);

  // --- redesenha a aba da tabela
  const aba = tabela.aba;
  const modeloPessoa = aba.linhas.get(primeira + 1) ?? aba.linhas.get(primeira);
  const modeloTotal = [...aba.linhas.entries()].find(([, l]) => /^total geral$/i.test(String(valorDaCelula(l.celulas.get(1), planilha.textos) ?? '').trim()));
  const modeloSobra = aba.linhas.get(Math.max(...aba.linhas.keys()));
  const st = (linha, col) => linha?.celulas.get(col)?.attrs.s;

  // Titulo: "RELATORIO DE DESPESA DISO SETEMBRO-2026" -> mes novo.
  const [ano, m] = mes.split('-').map(Number);
  const titulo = aba.linhas.get(1)?.celulas.get(1);
  const textoTitulo = valorDaCelula(titulo, planilha.textos);
  if (titulo && typeof textoTitulo === 'string') {
    const novo = textoTitulo.replace(new RegExp(`(${MESES.join('|')})\\s*-\\s*\\d{4}`, 'i'), `${MESES[m - 1]}-${ano}`);
    aba.linhas.get(1).celulas.set(1, celulaDeTexto(titulo.attrs.s, novo));
  }

  const cab = aba.linhas.get(linhaCab).celulas;
  visiveis.forEach((mv, k) => cab.set(3 + k, celulaDeNumero(cab.get(3 + k)?.attrs.s, serialDoMes(mv))));

  for (const n of [...aba.linhas.keys()]) if (n >= primeira) aba.linhas.delete(n);

  const media = (vals) => {
    const nums = vals.filter((v) => v != null);
    return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
  };
  const totais = Array(MESES_NA_TABELA).fill(0);
  ordem.forEach((l, k) => {
    const n = primeira + k;
    const celulas = new Map();
    celulas.set(1, celulaDeTexto(st(modeloPessoa, 1), l.dist));
    celulas.set(2, celulaDeTexto(st(modeloPessoa, 2), rotuloNome(l.pn)));
    l.valores.forEach((v, c) => {
      celulas.set(3 + c, v != null ? celulaDeNumero(st(modeloPessoa, 3 + c), v) : celulaVazia(st(modeloPessoa, 3 + c)));
      if (v != null) totais[c] += v;
    });
    const ult = l.valores[MESES_NA_TABELA - 1] ?? 0;
    const pen = l.valores[MESES_NA_TABELA - 2] ?? 0;
    celulas.set(7, { ...celulaDeFormula(st(modeloPessoa, 7), `AVERAGE(C${n}:F${n})`), v: String(media(l.valores)) });
    celulas.set(8, { ...celulaDeFormula(st(modeloPessoa, 8), `F${n}-E${n}`), v: String(centavos(ult - pen)) });
    celulas.set(9, celulaVazia(st(modeloPessoa, 9))); // justificativa do mes novo: em branco
    aba.linhas.set(n, { attrs: { ...(modeloPessoa?.attrs ?? {}) }, celulas });
  });

  const mt = modeloTotal?.[1];
  const tot = new Map();
  tot.set(1, celulaDeTexto(st(mt, 1), 'Total Geral'));
  tot.set(2, celulaVazia(st(mt, 2)));
  totais.forEach((v, c) => tot.set(3 + c, celulaDeNumero(st(mt, 3 + c), centavos(v))));
  tot.set(7, { ...celulaDeFormula(st(mt, 7), `AVERAGE(C${linhaTotal}:F${linhaTotal})`), v: String(media(totais)) });
  tot.set(8, { ...celulaDeFormula(st(mt, 8), `F${linhaTotal}-E${linhaTotal}`), v: String(centavos(totais[3] - totais[2])) });
  tot.set(9, celulaVazia(st(mt, 9)));
  aba.linhas.set(linhaTotal, { attrs: { ...(mt?.attrs ?? {}) }, celulas: tot });

  // As duas linhas de folga que a planilha tinha embaixo do total.
  for (const n of [linhaTotal + 1, linhaTotal + 2]) {
    const celulas = new Map();
    for (const [col, c] of modeloSobra?.celulas ?? []) celulas.set(col, celulaVazia(c.attrs.s));
    aba.linhas.set(n, { attrs: { ...(modeloSobra?.attrs ?? {}) }, celulas });
  }

  aba.pe = aba.pe.replace(/(<conditionalFormatting\b[^>]*sqref=")H\d+:H\d+"/, `$1H${primeira}:H${linhaTotal + 2}"`);
  aba.cabeca = aba.cabeca.replace(/<selection\b[^>]*\/>/, '<selection activeCell="A1" sqref="A1"/>');

  return { pt, cd, pessoas: ordem.length };
}

/**
 * Grava o mes na planilha da DISO e devolve o arquivo novo.
 */
export async function gerarComparativoDiso(buffer, mes, pessoas, decisoes = {}) {
  const planilha = await abrirPlanilha(buffer);
  const m = montar(planilha, mes, pessoas, decisoes);

  const resumo = { lancados: 0, novos: 0, sem_valor: [], justificativas: 0 };
  const linhasNovas = [];
  for (const item of m.itens) {
    if (item.partes == null) {
      resumo.sem_valor.push(item.nome);
      continue;
    }
    linhasNovas.push({ dist: item.dist, nome: item.nome_planilha, partes: item.partes });
    resumo.lancados += 1;
    if (item.valor - item.anterior > 0.1) resumo.justificativas += 1;
  }
  for (const p of m.novos) {
    const grupo = decisoes.novos?.[p.usuario_id]?.grupo;
    if (!GRUPOS.includes(grupo) || p.partes == null) continue;
    linhasNovas.push({ dist: grupo, nome: p.nome.toUpperCase(), partes: p.partes });
    resumo.novos += 1;
    resumo.justificativas += 1;
  }
  // Na ordem da planilha: DISO antes de DISO-SP, e por nome dentro de cada uma.
  linhasNovas.sort((a, b) => GRUPOS.indexOf(a.dist) - GRUPOS.indexOf(b.dist)
    || normalizarNome(a.nome).localeCompare(normalizarNome(b.nome), 'pt-BR'));

  const ultimaLinha = lancarMes(planilha, mes, linhasNovas);
  const lancamentos = [
    ...m.lanc,
    ...linhasNovas.map((l) => ({ mes, dist: l.dist, nome: l.nome, total: centavos(l.partes.km + l.partes.pedagio + l.partes.outros) })),
  ];
  const { pt, cd } = andarTabela(planilha, mes, lancamentos);

  const zip = planilha.zip;
  zip.file(planilha.dados.caminho, escreverAba(planilha.dados.aba));
  zip.file(planilha.tabela.caminho, escreverAba(planilha.tabela.aba));
  zip.file(planilha.tabela.ptCaminho, pt);
  zip.file(planilha.tabela.cdCaminho, cd);

  let wb = planilha.wb.replace(
    /(<definedName\b[^>]*name="_xlnm\._FilterDatabase"[^>]*>[^<]*!\$A\$1:\$[A-Z]+\$)\d+/,
    `$1${ultimaLinha}`,
  );
  wb = wb.replace(/<calcPr\b([^>]*?)\/>/, (t, a) => (a.includes('fullCalcOnLoad') ? t : `<calcPr${a} fullCalcOnLoad="1"/>`));
  zip.file('xl/workbook.xml', wb);
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    zip.file('xl/_rels/workbook.xml.rels', planilha.relsWb.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, ''));
    const tipos = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', tipos.replace(/<Override\b[^>]*calcChain[^>]*\/>/, ''));
  }

  const arquivo = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { arquivo, resumo };
}
