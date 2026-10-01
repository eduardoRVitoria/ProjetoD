// Conferencia dos COMPROVANTES por codigo, sem IA.
//
// E o que roda quando a IA nao esta disponivel (sem chave, sem credito, fora do
// ar). Cada anexo e lido do jeito que da:
//
//   extrato de pedagio em PDF/planilha  -> texto de verdade, soma exata
//   foto de cupom, print do aplicativo  -> OCR (ocr.js)
//   nota de abastecimento               -> chave de acesso no texto ou no QR code
//   foto do odometro                    -> OCR, procurando o km lancado no RDV
//
// A regra de ouro: o codigo CONFIRMA, nunca reprova. OCR erra - le "20.3" onde
// esta "20,30", nao enxerga cupom amassado, troca digito de painel. Entao
// quando a soma lida bate com o declarado, esta conferido; quando nao bate ou
// nao deu para ler, vira aviso em amarelo para alguem olhar, com os dois
// numeros na mensagem. Reprovar por leitura de OCR seria repetir o erro de
// 01/10, quando a IA marcou ida e volta como divergencia.

import fs from 'node:fs';
import path from 'node:path';
import { db, PASTA_ANEXOS, agora } from './banco.js';
import { linhasDoPdf } from './leitura-rdv.js';
import { planilhaEmTexto } from './extrair.js';
import { textoDaImagem, qrDaImagem, paginasDoPdfComoImagem } from './ocr.js';
import { fotosDoPptx } from './pptx.js';
import { somarExtrato } from './conferencia.js';
import * as log from './log.js';

// Mudou o jeito de ler? Sobe a versao e as leituras guardadas sao refeitas.
const VERSAO_LEITURA = 3;

// Quantas paginas de um PDF escaneado passam pelo OCR. Eram 6, e o PDF de
// aplicativo de escanear com os cupons do mes inteiro ficava lido pela metade.
const PAGINAS_DE_OCR = 15;

const IMAGEM = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif']);
const PLANILHA = new Set(['.xlsx', '.xlsm', '.xls']);

// Ler a mesma foto de novo a cada "Conferir de novo" custaria segundos por
// anexo. O arquivo de um anexo nunca muda (trocar e apagar e enviar outro),
// entao a leitura fica guardada.
db.exec(`
CREATE TABLE IF NOT EXISTS leituras_codigo (
  anexo_id  INTEGER PRIMARY KEY,
  versao    INTEGER NOT NULL,
  feito_em  TEXT NOT NULL,
  leitura   TEXT NOT NULL
)`);

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const centavos = (v) => Math.round(Number(v) * 100);

// ------------------------------------------------------------ extrato (texto)

const DATA = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const VALOR = /^(?:R\$)?(\d{1,4}(?:\.\d{3})*,\d{2}|\d{1,4}\.\d{2})$/;
// Lancamento do extrato que nao e despesa de viagem.
const NAO_E_PASSAGEM = /MENSALIDADE|RECARGA|\bIOF\b|DIAS\s+DE\s+USO|ADESAO|TAXA|MULTA|SALDO|NEGOCIA|ESTORNO|CREDITO/;

function valorDoToken(s) {
  const m = String(s).match(VALOR);
  if (!m) return null;
  const n = m[1].includes(',') ? Number(m[1].replace(/\./g, '').replace(',', '.')) : Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * As passagens de um extrato de tag (Sem Parar, ConectCar, Veloe...), a partir
 * das linhas de texto: uma linha que comeca com data e termina com valor.
 * Recebe listas de palavras, uma por linha. Funcao pura.
 */
export function passagensDoExtrato(linhasDePalavras) {
  const passagens = [];
  const ignorados = [];
  for (const palavras of linhasDePalavras) {
    const m = String(palavras[0] || '').match(DATA);
    if (!m) continue;
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    const ano = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;

    // Extrato com colunas de credito, debito e saldo marca o debito com "-R$":
    // e ele que vale. Nos outros, o valor e o ultimo numero em dinheiro.
    let valor = null;
    const iDebito = palavras.findIndex((p) => /^-R\$/.test(p));
    if (iDebito > 0) valor = valorDoToken(palavras[iDebito].slice(1)) ?? valorDoToken(palavras[iDebito + 1] ?? '');
    for (let i = palavras.length - 1; i > 0 && valor == null; i--) valor = valorDoToken(palavras[i]);
    if (valor == null || valor <= 0) continue;

    const texto = semAcento(palavras.slice(1).join(' ')).toUpperCase();
    if (NAO_E_PASSAGEM.test(texto) || /\bOUTROS\b/.test(texto)) {
      ignorados.push({ descricao: palavras.slice(1).join(' ').slice(0, 80), valor });
      continue;
    }
    const hora = palavras.find((p) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(p)) || '';
    passagens.push({
      data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
      hora: hora.slice(0, 5),
      valor,
      local: palavras.slice(1).filter((p) => valorDoToken(p) == null && p !== 'R$').join(' ').slice(0, 60),
      tipo: /ESTACIONAMENTO/.test(texto) ? 'estacionamento' : 'pedagio',
    });
  }
  return { passagens, ignorados };
}

// ------------------------------------------------------------------ foto (OCR)

const DINHEIRO_SOLTO = /(?<![\d.,])(\d{1,4}[.,]\d{2})(?![\d.,%])/g;
const numero = (s) => Number(String(s).replace(',', '.'));

/**
 * Os valores pagos que aparecem no texto lido de uma foto de comprovante.
 * Tres formatos, do mais especifico para o mais generico:
 *   cupom de pedagio  -> o que vem depois de "TARIFA" ou "VALOR" (um por cupom;
 *                        a mesma foto costuma trazer a ida e a volta)
 *   recibo            -> o que vem depois de "TOTAL" (um so)
 *   lista do app      -> cada linha com "R$" e um unico valor
 * Funcao pura.
 */
export function valoresDoComprovante(texto) {
  const linhas = String(texto).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cupons = [];
  const totais = [];
  const lista = [];
  const POR_CUPOM = /(?:TARIFA|VALOR\s*PAGO|VALOR)\s*[:=]?\s*(?:R\$|RS|R5)?\s*(\d{1,4}[.,]\d{2})(?![\d.,%])/g;

  for (const linha of linhas) {
    const chapada = semAcento(linha).toUpperCase();
    // Duas colunas de cupons lado a lado viram uma linha so: pega todos.
    const doCupom = [...chapada.matchAll(POR_CUPOM)].map((m) => numero(m[1])).filter((v) => v > 0);
    if (doCupom.length) {
      cupons.push(...doCupom);
      continue;
    }
    if (/TROCO|ENTREGUE|TRIBUT|IBPT|SALDO|LIMITE|CNPJ|CPF|DESCONTO/.test(chapada)) continue;

    const mTotal = chapada.match(/TOTAL\s*[:=]?\s*(?:R\$|RS)?\s*(\d{1,4}[.,]\d{2})(?![\d.,%])/);
    if (mTotal) {
      totais.push(numero(mTotal[1]));
      continue;
    }
    if (/R\$|\bRS\s?\d/.test(chapada)) {
      const valores = [...chapada.matchAll(DINHEIRO_SOLTO)].map((m) => numero(m[1]));
      if (valores.length === 1 && valores[0] > 0) lista.push(valores[0]);
    }
  }

  if (cupons.length) return cupons;
  if (totais.length) return [Math.max(...totais)];
  return lista;
}

/** Todo valor em dinheiro escrito no texto - para procurar o total declarado. */
export function todosOsValores(texto) {
  const achados = String(texto).matchAll(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,4}[.,]\d{2})(?![\d.,%])/g);
  const valores = [...achados].map((m) => (m[1].includes(',') ? Number(m[1].replace(/\./g, '').replace(',', '.')) : Number(m[1])));
  return [...new Set(valores)].filter((v) => v > 0).slice(0, 400);
}

// --------------------------------------------------------------------- nota

/** A chave de acesso da NF-e/NFC-e (44 digitos, modulo 11), ou null. */
export function chaveDeAcesso(texto) {
  const soDigitos = String(texto).replace(/[\s.]/g, '');
  for (const m of soDigitos.matchAll(/\d{44}/g)) {
    const c = m[0];
    let soma = 0;
    let peso = 2;
    for (let i = 42; i >= 0; i--) {
      soma += Number(c[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    if ((resto < 2 ? 0 : 11 - resto) === Number(c[43])) return c;
  }
  return null;
}

const falaDeCombustivel = (texto) =>
  /GASOLINA|ETANOL|DIESEL|\bGNV\b|COMBUSTIVEL|ALCOOL|\bLITROS?\b|\bBOMBA\b|\bBICO\b/.test(semAcento(texto).toUpperCase());

// ------------------------------------------------------------- um anexo so

/** O texto de um anexo, pelo caminho que o formato permite. */
async function textoDoAnexo(caminho, ext) {
  if (ext === '.pdf') {
    const linhas = (await linhasDoPdf(caminho)).map((l) => l.tokens.map((t) => t.s));
    if (linhas.flat().join('').length >= 120) return { metodo: 'pdf', linhas };
    // Quase sem texto: e escaneado (CamScanner, foto salva como PDF). Desenha
    // as paginas e passa o OCR em cada uma.
    const partes = [];
    const imagens = await paginasDoPdfComoImagem(caminho, PAGINAS_DE_OCR);
    for (const imagem of imagens) partes.push(await textoDaImagem(imagem));
    const texto = partes.join('\n');
    return { metodo: 'pdf-ocr', linhas: texto.split(/\r?\n/).map((l) => l.trim().split(/\s+/).filter(Boolean)), texto, imagens };
  }
  if (ext === '.pptx') {
    // Fotos coladas num PowerPoint: OCR em cada uma, como se fossem soltas.
    const imagens = (await fotosDoPptx(caminho, PAGINAS_DE_OCR)).map((f) => f.dados);
    const partes = [];
    for (const imagem of imagens) partes.push(await textoDaImagem(imagem));
    const texto = partes.join('\n');
    return { metodo: 'pptx-ocr', linhas: texto.split(/\r?\n/).map((l) => l.trim().split(/\s+/).filter(Boolean)), texto, imagens };
  }
  if (PLANILHA.has(ext)) {
    const texto = await planilhaEmTexto(caminho, ext);
    return {
      metodo: 'planilha',
      linhas: texto.split('\n').map((l) => l.replace(/^\d+:\s*/, '').split(' | ').flatMap((c) => c.trim().split(/\s+/)).filter(Boolean)),
    };
  }
  if (IMAGEM.has(ext)) {
    const texto = await textoDaImagem(caminho);
    return { metodo: 'ocr', linhas: texto.split(/\r?\n/).map((l) => l.trim().split(/\s+/).filter(Boolean)), texto };
  }
  return { metodo: null, linhas: [] };
}

/**
 * O que um comprovante de pedagio/estacionamento diz. Extrato tem a data de
 * cada passagem; cupom e print, so os valores. `todos` guarda cada valor
 * escrito no documento, para achar nele o total que a pessoa declarou.
 */
function doPedagio(t, corrido) {
  // Alguem anexou o proprio RDV como comprovante: as linhas dele tem data e
  // valor, e virariam "passagens".
  if (/KM\s+INICIAL/i.test(corrido)) return { todos: [] };
  const todos = todosOsValores(corrido);
  const extrato = passagensDoExtrato(t.linhas);
  if (extrato.passagens.length) return { passagens: extrato.passagens, ignorados: extrato.ignorados, todos };
  return { valores: valoresDoComprovante(corrido), todos };
}

/**
 * Le um anexo e devolve so o que a conferencia precisa dele. Nao guarda o
 * texto inteiro: o que fica no banco e o resultado, nao o documento.
 */
async function lerAnexo(a) {
  const guardada = db.prepare('SELECT versao, leitura FROM leituras_codigo WHERE anexo_id = ?').get(a.id);
  if (guardada && guardada.versao === VERSAO_LEITURA) {
    try {
      return JSON.parse(guardada.leitura);
    } catch {
      // leitura guardada corrompida: le de novo
    }
  }

  const caminho = path.join(PASTA_ANEXOS, a.arquivo);
  const ext = path.extname(a.nome_original || a.arquivo).toLowerCase();
  const leitura = { tipo: a.tipo, metodo: null, leu: false };

  if (fs.existsSync(caminho) && fs.statSync(caminho).size > 0) {
    const t = await textoDoAnexo(caminho, ext);
    const corrido = t.texto ?? t.linhas.map((l) => l.join(' ')).join('\n');
    leitura.metodo = t.metodo;
    leitura.leu = corrido.replace(/\s/g, '').length >= 8;

    if (a.tipo === 'pedagio') {
      Object.assign(leitura, doPedagio(t, corrido));
    } else if (a.tipo === 'danfe') {
      let chave = chaveDeAcesso(corrido);
      if (!chave && t.metodo === 'ocr') chave = chaveDeAcesso(await qrDaImagem(caminho));
      // Nota escaneada em PDF: o QR code esta na imagem de alguma pagina.
      for (const imagem of (!chave && t.imagens) || []) {
        chave = chaveDeAcesso(await qrDaImagem(imagem));
        if (chave) break;
      }
      leitura.chave = chave ? `${chave.slice(0, 4)}...${chave.slice(-4)}` : null;
      leitura.combustivel = falaDeCombustivel(corrido);
    } else if (a.tipo === 'odometro') {
      // So os numeros de 4 a 7 digitos: e o que pode ser um hodometro.
      leitura.numeros = [...corrido.replace(/(?<=\d)[.,\s](?=\d{3}\b)/g, '').matchAll(/\d{4,7}/g)].map((m) => m[0]).slice(0, 40);
    }
  }

  db.prepare(
    'INSERT OR REPLACE INTO leituras_codigo (anexo_id, versao, feito_em, leitura) VALUES (?, ?, ?, ?)',
  ).run(a.id, VERSAO_LEITURA, agora(), JSON.stringify(leitura));
  return leitura;
}

// ------------------------------------------------------------ o relatorio

/**
 * Junta as leituras num parecer. Funcao pura: recebe `[{ anexo, leitura }]`, as
 * linhas do RDV e o total declarado; devolve o parecer e os achados.
 */
export function montarParecer({ lidos, linhas, mesRef, declarado }) {
  const achados = [];
  const aviso = (codigo, mensagem, anexo) => achados.push({
    gravidade: 'aviso', codigo, mensagem, data: null,
    ...(anexo ? { anexo_id: anexo.id, anexo_nome: anexo.nome_original } : {}),
  });

  // ---- pedagio e estacionamento
  const dePedagio = lidos.filter((l) => l.anexo.tipo === 'pedagio');
  const passagens = dePedagio.flatMap((l) => l.leitura.passagens || []);
  const soma = somarExtrato(passagens, linhas, mesRef);
  const dasFotos = dePedagio.flatMap((l) => l.leitura.valores || []);
  const lido = (centavos(soma.total) + dasFotos.reduce((s, v) => s + centavos(v), 0)) / 100;
  const semLeitura = dePedagio.filter((l) => !(l.leitura.passagens?.length || l.leitura.valores?.length));

  // Duas formas de confirmar: a soma do que foi lido da o declarado, ou o
  // proprio documento traz o total declarado escrito (o extrato da tag fecha
  // com "Pedagios R$ 242,80"). Bater no centavo por acaso e improvavel.
  const totalEscrito = dePedagio.some((l) => (l.leitura.todos || []).some((v) => centavos(v) === centavos(declarado)));

  // Leitura FECHADA: todo comprovante e extrato, e a soma das passagens lidas
  // de cada um e o total que o proprio documento imprime. Ai o numero lido e
  // tao bom quanto o do extrato, e vale como comprovado mesmo quando NAO bate
  // com o declarado - a diferenca e de verdade e reprova, como na leitura da IA.
  // Caso da Cristine (set/26): declarou R$ 272,80, o extrato fecha em R$ 227,80,
  // e a tela mostrava em vermelho um R$ 251,80 velho, de uma leitura anterior.
  const fechada = dePedagio.length > 0 && dePedagio.every((l) => {
    const doArquivo = (l.leitura.passagens || []).reduce((s, p) => s + centavos(p.valor), 0);
    return doArquivo > 0 && (l.leitura.todos || []).some((v) => centavos(v) === doArquivo);
  });

  let comprovado = null;
  if (declarado > 0 && dePedagio.length) {
    if (centavos(lido) === centavos(declarado) || totalEscrito) {
      comprovado = declarado;
    } else if (fechada) {
      comprovado = lido;
    } else {
      aviso(
        'pedagio_nao_confirmado',
        `Pedagio/estacionamento: declarado ${brl(declarado)}; a leitura automatica dos comprovantes somou ${brl(lido)}`
          + `${semLeitura.length ? ` e nao conseguiu ler ${semLeitura.length} arquivo(s)` : ''}. Confira na mao.`,
      );
    }
  }

  // ---- nota de abastecimento
  const notas = lidos.filter((l) => l.anexo.tipo === 'danfe');
  const notaConfirmada = notas.some((l) => l.leitura.chave || l.leitura.combustivel);
  if (notas.length && !notaConfirmada) {
    aviso(
      'danfe_nao_confirmada',
      'Nao deu para confirmar automaticamente que a nota anexada e de abastecimento '
        + '(sem chave de acesso legivel nem mencao a combustivel). Confira na mao.',
      notas[0].anexo,
    );
  }

  // ---- odometro: a foto e referencia, nunca reprova. So conta em quantas o
  // km lancado no RDV aparece.
  const kmsDoRdv = new Set(linhas.flatMap((l) => [l.km_inicial, l.km_final]).filter((k) => Number(k) > 0).map((k) => String(Math.round(k))));
  const fotos = lidos.filter((l) => l.anexo.tipo === 'odometro');
  const batem = fotos.filter((l) => (l.leitura.numeros || []).some((n) => kmsDoRdv.has(n))).length;

  return {
    achados,
    parecer: {
      por: 'codigo',
      passagens,
      passagens_fora: soma.fora,
      passagens_apos_18h: [],
      itens_ignorados: dePedagio.flatMap((l) => l.leitura.ignorados || []),
      valores_das_fotos: dasFotos,
      pedagio_lido: lido,
      leitura_fechada: fechada,
      pedagio_comprovado: comprovado,
      tem_danfe_de_abastecimento: notaConfirmada,
      odometro: {
        fotos_lidas: fotos.filter((l) => l.leitura.leu).length,
        fotos_com_km_do_rdv: batem,
        observacao: fotos.length ? `Em ${batem} de ${fotos.length} foto(s) o km lancado no RDV foi encontrado pela leitura automatica.` : '',
      },
      achados: [],
      status: null,
      resumo: 'Conferencia dos comprovantes feita por codigo (sem IA).',
      o_que_fazer: '',
    },
  };
}

/** Confere os comprovantes de um relatorio por codigo. */
export async function conferirPorCodigo({ rel, linhas, anexos, declarado }) {
  const comeco = Date.now();
  const lidos = [];
  for (const a of anexos) {
    if (!['pedagio', 'danfe', 'odometro'].includes(a.tipo)) continue;
    try {
      lidos.push({ anexo: a, leitura: await lerAnexo(a) });
    } catch (e) {
      log.falha('leitura', 'nao consegui ler o anexo por codigo', e, { anexo: a.id, tipo: a.tipo });
      lidos.push({ anexo: a, leitura: { tipo: a.tipo, metodo: null, leu: false } });
    }
  }
  const saida = montarParecer({ lidos, linhas, mesRef: rel.mes_ref, declarado });
  log.info('leitura', 'comprovantes por codigo', {
    rel: rel.id,
    anexos: lidos.length,
    tempo: log.desde(comeco),
    declarado,
    lido: saida.parecer.pedagio_lido,
    confirmou: saida.parecer.pedagio_comprovado != null,
  });
  return saida;
}

// So para o experimento e os testes: le um arquivo solto, sem banco.
export async function lerArquivoSolto(caminho, tipo, nome = caminho) {
  const ext = path.extname(nome).toLowerCase();
  const t = await textoDoAnexo(caminho, ext);
  const corrido = t.texto ?? t.linhas.map((l) => l.join(' ')).join('\n');
  const p = doPedagio(t, corrido);
  return {
    metodo: t.metodo,
    caracteres: corrido.replace(/\s/g, '').length,
    passagens: p.passagens || [],
    ignorados: p.ignorados || [],
    valores: p.valores || [],
    todos: p.todos,
    chave: chaveDeAcesso(corrido) || (t.metodo === 'ocr' && tipo !== 'pedagio' ? chaveDeAcesso(await qrDaImagem(caminho)) : null),
    combustivel: falaDeCombustivel(corrido),
  };
}
