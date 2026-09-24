// O log do portal.
//
// Serve para duas perguntas, e as duas aparecem sempre depois do fato:
//   "quem mexeu nisso?"  - e dinheiro de reembolso, precisa ter rastro
//   "por que deu errado?" - e o vendedor esta no telefone esperando
//
// Uma linha por evento, para dar para ler correndo no painel da Railway e para
// um grep achar o que precisa. Nada de JSON: quem le isto e uma pessoa.
//
//   02:24:44 INFO  http    POST /api/relatorio/enviar 200 145ms haline.franco
//   02:24:45 AVISO entrada login recusado login=jorge ip=1.2.3.4
//   02:25:01 INFO  ia      conferencia rel=12 8.2s entrada=15230 saida=1840
//
// A hora e a de Brasilia, nao UTC: quem le o log e quem trabalha aqui, e
// converter tres horas de cabeca no meio de um problema atrapalha.

const SEGREDOS = /^(senha|senha_hash|senha_salt|chave|chave_api|token|sid|authorization)$/i;

/** Hora de Brasilia no formato HH:MM:SS. */
function hora() {
  return new Date().toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
  });
}

/**
 * Os detalhes viram `chave=valor`, com o que for segredo trocado por ***.
 *
 * A protecao e por nome do campo, nao por confianca em quem chama: basta
 * alguem passar o objeto do usuario inteiro por engano uma vez para o hash da
 * senha ficar no log da Railway para sempre.
 */
function detalhes(dados) {
  if (!dados) return '';
  const partes = [];
  for (const [chave, valor] of Object.entries(dados)) {
    if (valor === undefined || valor === null || valor === '') continue;
    if (SEGREDOS.test(chave)) {
      partes.push(`${chave}=***`);
      continue;
    }
    const texto = String(valor);
    // Espaco quebraria o par chave=valor na leitura e no grep.
    partes.push(`${chave}=${/\s/.test(texto) ? JSON.stringify(texto) : texto}`);
  }
  return partes.join(' ');
}

// ---------------------------------------------------------------- memoria
//
// O log sai na tela do servidor, e na Railway ele some quando o container e
// trocado. A tela "Tudo" precisa responder "o que deu errado hoje?" sem
// ninguem abrir o painel da Railway - entao os ultimos eventos ficam tambem
// aqui, na memoria do processo.
//
// Teto fixo: isto nao pode virar vazamento de memoria num portal que fica
// meses no ar. Guarda os 300 mais recentes e descarta o resto.
const TETO_MEMORIA = 300;
const ultimos = [];

// Gasto com a IA desde que o portal subiu. Sai do proprio log da conferencia,
// que ja registra os tokens - assim nao existe uma segunda contabilidade para
// divergir da primeira.
const usoIa = { chamadas: 0, entrada: 0, saida: 0, falhas: 0 };

function guardar(nivel, area, mensagem, dados) {
  ultimos.push({ hora: hora(), nivel, area, mensagem, dados: detalhes(dados) });
  if (ultimos.length > TETO_MEMORIA) ultimos.shift();

  if (area === 'ia') {
    if (dados?.entrada || dados?.saida) {
      usoIa.chamadas++;
      usoIa.entrada += Number(dados.entrada) || 0;
      usoIa.saida += Number(dados.saida) || 0;
    } else if (nivel === 'ERRO') {
      usoIa.falhas++;
    }
  }
}

/** Os ultimos eventos, do mais novo para o mais velho. */
export function recentes({ quantos = 120, nivel = null } = {}) {
  const lista = nivel ? ultimos.filter((l) => l.nivel === nivel) : ultimos;
  return lista.slice(-quantos).reverse();
}

/** Quanto a IA foi usada desde que o portal subiu. */
export function usoDaIa() {
  return { ...usoIa };
}

function escrever(saida, nivel, area, mensagem, dados) {
  const extra = detalhes(dados);
  guardar(nivel, area, mensagem, dados);
  saida(`${hora()} ${nivel.padEnd(5)} ${String(area).padEnd(9)} ${mensagem}${extra ? ' ' + extra : ''}`);
}

/** O que aconteceu, e deu certo. */
export function info(area, mensagem, dados) {
  escrever(console.log, 'INFO', area, mensagem, dados);
}

/**
 * Nao quebrou, mas alguem precisa saber.
 *
 * Login recusado, arquivo que o portal nao conseguiu abrir, relatorio que a IA
 * se recusou a analisar: nada disso e falha do sistema, e tudo isso vira
 * pergunta no seu telefone mais tarde.
 */
export function aviso(area, mensagem, dados) {
  escrever(console.warn, 'AVISO', area, mensagem, dados);
}

/** Quebrou. O erro vai inteiro, com pilha, porque aqui alguem vai investigar. */
export function falha(area, mensagem, e, dados) {
  escrever(console.error, 'ERRO', area, mensagem, dados);
  if (e) console.error(e);
}

/** Quanto tempo levou, em segundo com uma casa - ou em ms quando foi rapido. */
export function desde(comeco) {
  const ms = Date.now() - comeco;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
