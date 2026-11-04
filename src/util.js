// Utilitarios pequenos usados pelo servidor.

export function responderJson(res, dados, status = 200, cabecalhos = {}) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store',
    ...cabecalhos,
  });
  res.end(corpo);
}

export function erro(res, mensagem, status = 400, cabecalhos = {}) {
  responderJson(res, { erro: mensagem }, status, cabecalhos);
}

/**
 * De onde veio o pedido.
 *
 * Atras do proxy da Railway o socket sempre mostra um IP interno, entao o que
 * vale e o primeiro nome do X-Forwarded-For - o cliente de verdade.
 *
 * Morava no servidor.js. Veio para ca porque agora o rotas.js tambem precisa:
 * e a chave das regras de limite de login.
 */
export function ipDoPedido(req) {
  const encaminhado = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return encaminhado || req.socket.remoteAddress || '?';
}

export async function lerCorpo(req, limite = 25 * 1024 * 1024) {
  const partes = [];
  let total = 0;
  for await (const pedaco of req) {
    total += pedaco.length;
    if (total > limite) {
      req.destroy();
      throw new Error('Arquivo grande demais.');
    }
    partes.push(pedaco);
  }
  return Buffer.concat(partes);
}

export async function lerJson(req) {
  const bruto = await lerCorpo(req, 5 * 1024 * 1024);
  if (!bruto.length) return {};
  try {
    return JSON.parse(bruto.toString('utf8'));
  } catch {
    throw new Error('Corpo da requisicao nao e um JSON valido.');
  }
}

/**
 * Numero escrito do jeito brasileiro: "45,90", "1.234,56", "R$ 45,90", "271.368".
 *
 * Com virgula, a virgula e o decimal e os pontos sao milhar. Sem virgula, ponto
 * seguido de grupos de 3 digitos e milhar ("45.678" e 45678 km, nao 45); outro
 * ponto e decimal ("45.9"). Texto que nao e numero devolve `padrao`.
 */
export function lerNumeroBr(v, padrao = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : padrao;
  let s = String(v ?? '').replace(/R\$|\s/gi, '');
  if (!s) return padrao;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : padrao;
}

export function numero(v, padrao = 0) {
  return lerNumeroBr(v, padrao);
}

// ------------------------------------------ ponto de milhar lido como decimal
//
// O RDV escreve "61.350" e "4.547" - sessenta e um mil, quatro mil. Quem le o
// documento as vezes devolve o numero com o ponto no lugar: 61.35 e 4.547. Ai
// o dia que rodou 20 km soma 0,02, e o total de 4.547 km vira "4 km e uns
// quebrados". Foi o RDV do Julio Cesar de setembro: o portal somava 4.527 onde
// o documento dizia 4.547.

/**
 * A leitura do odometro de um dia. Painel de carro nao marca fracao: numero
 * abaixo de mil com casas decimais e o ponto de milhar no lugar errado.
 */
export function odometroInteiro(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n > 0 && n < 1000 && !Number.isInteger(n) ? Math.round(n * 1000) : n;
}

/**
 * O total de km que o documento declara. Aqui fracao pode ser de verdade
 * (850,5 km), entao quem decide e a soma dos dias: vale a leitura que ficar
 * mais perto dela.
 */
export function totalDeKmDeclarado(v, somaDosDias) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (!(n > 0 && n < 1000) || Number.isInteger(n) || !(somaDosDias > 0)) return n;
  const vezesMil = Math.round(n * 1000);
  return Math.abs(vezesMil - somaDosDias) < Math.abs(n - somaDosDias) ? vezesMil : n;
}

export function mesValido(mes) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''));
}

export function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Todos os dias uteis do mes, em ordem - e a grade que o colaborador preenche.
export function diasDoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(ano, m, 0)).getUTCDate();
  const dias = [];
  for (let d = 1; d <= ultimo; d++) {
    dias.push(`${mes}-${String(d).padStart(2, '0')}`);
  }
  return dias;
}

const NOMES_MES = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

export function mesPorExtenso(mes) {
  const [ano, m] = mes.split('-').map(Number);
  return `${NOMES_MES[m - 1]} de ${ano}`;
}

/**
 * A placa, limpa - ou `null` quando o que veio nao e placa.
 *
 * Nasceu de um estrago real: a leitura do RDV gravava `extraido.placas` direto
 * no cadastro, sem conferir nada. Um dia a extracao devolveu 3.314 caracteres
 * de payload de ferramenta, com o JSON dos lancamentos dentro, e isso foi para
 * o campo placa de um vendedor. A janela do relatorio imprime a placa embaixo
 * do nome, entao virou um muro de texto - e, como o painel para de atualizar
 * enquanto uma janela esta aberta, a conferente passou um dia lendo dados do
 * dia anterior sem saber.
 *
 * A regra e estreita de proposito: uma linha curta, letras, numeros e os
 * separadores que as pessoas usam quando tem dois carros. Qualquer coisa fora
 * disso devolve `null`, e quem chama NAO grava - melhor cadastro sem placa que
 * cadastro com lixo. O que uma pessoa digita errado ela mesma corrige; o que
 * um modelo escreve errado fica la para sempre.
 */
export function placaLimpa(bruto) {
  const texto = String(bruto ?? '').trim();
  if (!texto) return null;
  if (texto.length > 60) return null;
  // Letras, numeros, espaco e os separadores de "tenho dois carros".
  if (!/^[A-Za-z0-9\-,/ ]+$/.test(texto)) return null;
  // Placa tem numero. Sem isso, "o carro do colega de rota" passaria.
  if (!/[0-9]/.test(texto)) return null;
  return texto.toUpperCase();
}

export function nomeDeArquivoSeguro(nome) {
  return String(nome || 'arquivo')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-120);
}

// export const ROTULO_STATUS = {
//   RASCUNHO: 'Rascunho',
//   ENVIADO: 'Enviado, aguardando conferencia',
//   CONFERINDO: 'Em conferencia',
//   CERTA: 'Aprovado',
//   SO_FALTA_DANFE: 'So falta a nota de abastecimento',
//   ERRADA: 'Reprovado - precisa corrigir',
// };
// O admin ve aprovado/reprovado - decidido sempre na mao.
export const ROTULO_STATUS = {
  RASCUNHO: 'Arquivos não enviados',
  ENVIADO: 'Recebido - aguardando aprovação',
  CONFERINDO: 'Recebido - aguardando aprovação',
  CERTA: 'Aprovado',
  SO_FALTA_DANFE: 'So falta a nota de abastecimento',
  ERRADA: 'Reprovado',
};

// O colaborador nao ve aprovado/reprovado: so "Recebido" ou "Nao enviado".
export const ROTULO_COLABORADOR = {
  RASCUNHO: 'Arquivos não enviados',
  ENVIADO: 'Recebido',
  CONFERINDO: 'Recebido',
  CERTA: 'Recebido',
  SO_FALTA_DANFE: 'Recebido',
  ERRADA: 'Recebido',
};

/**
 * O JSON guardado no banco virando lista, sempre.
 *
 * Os `achados` sao gravados como texto JSON e lidos com JSON.parse espalhado
 * por varias rotas. Bastou um deles devolver outra coisa - texto ainda nao
 * parseado, objeto solto, JSON quebrado pela metade - para a tela estourar num
 * `.map is not a function` e sumir inteira, com o vendedor sem entender nada.
 *
 * Aqui o formato errado vira lista vazia: a tela perde um aviso, que e ruim,
 * mas continua de pe, que e o que importa no meio do fechamento.
 */
export function listaDeJson(bruto) {
  if (bruto == null) return null;
  if (Array.isArray(bruto)) return bruto;
  try {
    const v = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Limpa o texto que a IA escreveu antes de gravar.
 *
 * O modelo as vezes deixa escapar fragmento da propria estrutura da chamada -
 * apareceu um "</parameter>" solto dentro do "o que o colaborador precisa
 * fazer", que foi parar na tela do vendedor. Corta tambem o tamanho, porque
 * pedir no prompt para ser curto nem sempre e obedecido.
 */
export function textoDaIa(bruto, limite = 220) {
  let t = String(bruto ?? '')
    // fragmento de marcacao que vazou da chamada de ferramenta
    .replace(/<\/?[a-z_:][\w:.-]*[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > limite) {
    // Corta na ultima frase inteira que couber, para nao terminar no meio.
    const pedaco = t.slice(0, limite);
    const fim = Math.max(pedaco.lastIndexOf('. '), pedaco.lastIndexOf('! '));
    t = (fim > limite * 0.5 ? pedaco.slice(0, fim + 1) : pedaco.trim() + '...').trim();
  }
  return t;
}

// Pensamento e esforco por modelo. O Haiku 4.5 recusa `thinking: adaptive` e
// `effort` (400), e com a ferramenta forcada ele nao pode pensar - entao vai
// sem os dois. Os demais seguem com o adaptativo em esforco alto.
export function pensamentoDoModelo(modelo) {
  if (/haiku/i.test(String(modelo))) return {};
  return { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } };
}
