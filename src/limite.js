// Limite de tentativas.
//
// A restricao que molda tudo aqui: o escritorio inteiro sai por UM IP. No log
// de 01/09, leticiaadm, cross, admin, bruno.st e kellyadm vieram todos do
// mesmo endereco. Por isso a chave do limite de login e `login|ip`, e nao o
// ip - senao uma pessoa errando a senha trancaria a empresa inteira no dia do
// fechamento, que e pior que o problema que isto resolve. E acontece: as
// 11:04 daquele dia o bruno.st errou quatro vezes seguidas antes de acertar.
//
// O estado vive em memoria, no proprio processo. A Railway roda uma instancia
// so, entao basta - e reiniciar limpa tudo, o que tambem serve de valvula de
// escape se alguem se trancar do lado de fora. Se um dia o portal subir para
// duas instancias, isto precisa virar tabela: cada instancia teria o proprio
// contador e o limite real seria o dobro do configurado.

const MIN = 60_000;

export const REGRAS = {
  // Estas contam FALHAS de senha.
  LOGIN: { nome: 'login', max: 5, janela: 5 * MIN, bloqueio: 15 * MIN },
  LOGIN_IP: { nome: 'login_ip', max: 50, janela: 10 * MIN, bloqueio: 15 * MIN },
  // Estas contam CHAMADAS.
  IA: { nome: 'ia', max: 10, janela: 60 * MIN, bloqueio: 0 },
  GERAL: { nome: 'geral', max: 300, janela: 1 * MIN, bloqueio: 0 },
};

// Teto de memoria: cada chave nova ocupa espaco, e uma varredura com IPs
// forjados encheria o mapa. Passou do teto, zera - perder contador e
// aceitavel, ficar sem memoria nao e.
const MAX_CHAVES = 10_000;

const mapas = new Map();

function mapaDe(regra) {
  let m = mapas.get(regra.nome);
  if (!m) {
    m = new Map();
    mapas.set(regra.nome, m);
  }
  return m;
}

/** Le a entrada ja podada. Devolve null quando nao ha mais nada a considerar. */
function entradaDe(regra, chave, agora) {
  const m = mapaDe(regra);
  const e = m.get(chave);
  if (!e) return null;

  e.carimbos = e.carimbos.filter((t) => t > agora - regra.janela);
  if (!e.carimbos.length && e.bloqueadoAte <= agora) {
    m.delete(chave);
    return null;
  }
  return e;
}

const segundos = (ms) => Math.max(1, Math.ceil(ms / 1000));

/** Pode passar? Se nao, por quantos segundos ainda nao passa. */
export function checar(regra, chave, agora = Date.now()) {
  const e = entradaDe(regra, chave, agora);
  if (!e) return { ok: true };

  if (e.bloqueadoAte > agora) {
    return { ok: false, esperarSegundos: segundos(e.bloqueadoAte - agora) };
  }
  if (e.carimbos.length >= regra.max) {
    // Regra sem bloqueio fixo: libera quando a ocorrencia mais antiga que
    // ainda conta sair da janela.
    const liberaEm = e.carimbos[e.carimbos.length - regra.max] + regra.janela;
    return { ok: false, esperarSegundos: segundos(liberaEm - agora) };
  }
  return { ok: true };
}

/** Registra uma ocorrencia: falha de senha, ou chamada, conforme a regra. */
export function registrar(regra, chave, agora = Date.now()) {
  const m = mapaDe(regra);
  if (m.size >= MAX_CHAVES && !m.has(chave)) m.clear();

  const e = m.get(chave) || { carimbos: [], bloqueadoAte: 0 };
  e.carimbos = e.carimbos.filter((t) => t > agora - regra.janela);
  e.carimbos.push(agora);

  // Regra com bloqueio: estourou, tranca por um tempo fixo contado a partir de
  // agora. Os carimbos sao zerados porque quem manda passa a ser o bloqueio -
  // senao a janela deslizante os apagaria antes da hora e a trava cairia
  // sozinha no meio.
  if (regra.bloqueio && e.carimbos.length >= regra.max) {
    e.bloqueadoAte = agora + regra.bloqueio;
    e.carimbos = [];
  }
  m.set(chave, e);
}

/** Zera - usado quando a pessoa acerta a senha. */
export function limpar(regra, chave) {
  mapaDe(regra).delete(chave);
}

/** O texto que a pessoa le. Segundo exato nao ajuda ninguem; minuto ajuda. */
export function recadoDeEspera(esperarSegundos) {
  if (esperarSegundos < 60) {
    return `Muitas tentativas. Espere ${esperarSegundos} segundos e tente de novo.`;
  }
  const min = Math.ceil(esperarSegundos / 60);
  return `Muitas tentativas. Espere ${min} ${min === 1 ? 'minuto' : 'minutos'} e tente de novo.`;
}

// Faxina periodica: checar e registrar so podam a propria chave, entao chaves
// que ninguem mais toca ficariam para sempre. `unref` para um timer nao
// segurar o processo vivo.
const FAXINA = 10 * MIN;
const porNome = new Map(Object.values(REGRAS).map((r) => [r.nome, r]));

setInterval(() => {
  const agora = Date.now();
  for (const [nome, m] of mapas) {
    const regra = porNome.get(nome);
    if (!regra) continue;
    for (const chave of [...m.keys()]) entradaDe(regra, chave, agora);
  }
}, FAXINA).unref();
