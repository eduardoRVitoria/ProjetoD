// Fila de conferencia no SERVIDOR.
//
// Antes, "Conferir os pendentes com IA" era um laco dentro do navegador do
// administrador: um relatorio por vez, e se ele fechasse a aba, trocasse de
// mes ou o celular dormisse, a conferencia parava no meio. Com 15 pessoas dava
// para esperar olhando; com 100 sao mais de uma hora de aba aberta.
//
// Agora quem roda e o servidor: a rota so ENFILEIRA e responde na hora. O
// painel acompanha o andamento perguntando de tempos em tempos, e pode ser
// fechado a vontade - inclusive o administrador pode sair e voltar depois.
//
// Uma fila por vez, de proposito: duas filas em paralelo dobrariam o gasto com
// a API e ainda brigariam pelo mesmo relatorio. Quem tentar comecar a segunda
// recebe o andamento da primeira.

import * as log from './log.js';

// Respiro entre um relatorio e outro: a chamada da IA e pesada e o portal
// continua atendendo vendedor enquanto a fila corre.
const PAUSA_ENTRE = 400;

let fila = null;

/** Como esta a fila agora - e o que o painel desenha. */
export function estadoDaFila() {
  if (!fila) return { rodando: false };
  return {
    rodando: fila.rodando,
    mes: fila.mes,
    demo: fila.demo,
    quem: fila.quem,
    total: fila.total,
    feitos: fila.feitos,
    certos: fila.certos,
    falhas: fila.falhas.slice(-20),
    qtd_falhas: fila.falhas.length,
    comecou_em: fila.comecou_em,
    terminou_em: fila.terminou_em,
    atual: fila.atual,
    parando: fila.parar,
  };
}

/** Pede para a fila parar depois do relatorio que esta rodando agora. */
export function pedirParada() {
  if (fila?.rodando) fila.parar = true;
  return estadoDaFila();
}

/**
 * Comeca a fila. `processar` recebe um item e faz a conferencia dele.
 *
 * Nao espera terminar: devolve o estado inicial para a rota responder rapido.
 * Erro em um relatorio nao derruba os outros - vai para a lista de falhas e a
 * fila segue, senao um PDF ruim no meio pararia o fechamento do mes inteiro.
 */
export function comecarFila({ itens, mes, demo, quem, processar }) {
  if (fila?.rodando) return { ja_rodando: true, ...estadoDaFila() };

  fila = {
    rodando: true,
    parar: false,
    mes,
    demo: Boolean(demo),
    quem,
    total: itens.length,
    feitos: 0,
    certos: 0,
    falhas: [],
    atual: null,
    comecou_em: new Date().toISOString(),
    terminou_em: null,
  };

  log.info('fila', 'conferencia em fila comecou', { mes, quantos: itens.length, por: quem, demo: Boolean(demo) });

  (async () => {
    for (const item of itens) {
      if (fila.parar) break;
      fila.atual = item.nome || `relatorio ${item.id}`;
      try {
        await processar(item);
        fila.certos++;
      } catch (e) {
        fila.falhas.push({ nome: item.nome || `relatorio ${item.id}`, erro: String(e?.message || e).slice(0, 200) });
        log.falha('fila', 'relatorio nao conferido', e, { rel: item.id });
      }
      fila.feitos++;
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE));
    }
    fila.rodando = false;
    fila.atual = null;
    fila.terminou_em = new Date().toISOString();
    log.info('fila', 'conferencia em fila terminou', {
      mes: fila.mes, feitos: fila.feitos, certos: fila.certos, falhas: fila.falhas.length, parada: fila.parar,
    });
  })();

  return estadoDaFila();
}

// ------------------------------------------- vez de cada relatorio com a IA
//
// Todo envio dispara a conferencia sozinho. Com 160 pessoas enviando na mesma
// manha seriam 160 chamadas pesadas (cada uma com uns 20 comprovantes) batendo
// na API ao mesmo tempo: a API recusa por limite de uso e as conferencias
// falham em bloco. Aqui cada uma espera a sua vez, em ordem de chegada. Vale
// para todos os caminhos - envio, fila do admin e o botao de conferir um.

const IA_AO_MESMO_TEMPO = Math.max(1, Number(process.env.IA_AO_MESMO_TEMPO) || 2);
let rodandoIa = 0;
const esperandoIa = [];

/**
 * Roda `fn` quando houver vaga. `primeiro` fura a fila (clique do admin).
 * Quantos estao esperando: `naFilaDaIa()`.
 */
export async function naVezDaIa(fn, { primeiro = false } = {}) {
  // A vaga passa de mao em mao: quem sai entrega direto para o proximo da
  // fila, sem soltar o contador - senao quem chegasse naquele instante furava
  // a fila e rodariam tres.
  if (rodandoIa >= IA_AO_MESMO_TEMPO) {
    await new Promise((vaga) => (primeiro ? esperandoIa.unshift(vaga) : esperandoIa.push(vaga)));
  } else {
    rodandoIa++;
  }
  try {
    return await fn();
  } finally {
    const proximo = esperandoIa.shift();
    if (proximo) proximo();
    else rodandoIa--;
  }
}

export function naFilaDaIa() {
  return { rodando: rodandoIa, esperando: esperandoIa.length };
}
