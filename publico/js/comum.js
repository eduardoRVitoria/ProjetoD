// Funcoes usadas pelas tres telas.

// fetch que fala portugues quando a rede cai. Sem isto o celular mostrava
// "Failed to fetch" (Chrome) ou "Load failed" (iPhone).
async function buscarUmaVez(rota, opcoes) {
  try {
    return await fetch(rota, opcoes);
  } catch {
    throw new Error('Sem conexão com o portal. Confira o sinal da internet e tente de novo.');
  }
}

// ------------------------------------------------ sessao que cai no meio
//
// A sessao cai quando vence, quando a senha e trocada em outro aparelho ou
// quando o admin reseta a senha. Antes, o salvar falhava com "Sessao expirada"
// e o que a pessoa digitou ficava preso na tela: nenhum salvamento funcionava
// mais e sair da pagina perdia tudo.
//
// Agora a mesma tela pede a senha por cima e o pedido que falhou e refeito
// sozinho. So entra em acao depois que a tela sabe quem esta logado - no
// carregamento, sem sessao, o caminho continua sendo a pagina de login.

let quemEsta = null;
let reentrada = null;

/** A tela avisa quem esta logado, para a reentrada conferir que e a mesma pessoa. */
export function lembrarQuemEsta(login) {
  quemEsta = login;
}

async function buscar(rota, opcoes) {
  const resposta = await buscarUmaVez(rota, opcoes);
  if (resposta.status !== 401 || !quemEsta || rota.startsWith('/api/entrar')) return resposta;
  try {
    await pedirReentrada();
  } catch {
    return resposta; // desistiu: segue o erro original
  }
  return buscarUmaVez(rota, opcoes);
}

// Varios pedidos podem cair juntos (autosave + upload): uma janela so.
function pedirReentrada() {
  if (!reentrada) {
    reentrada = new Promise(abrirJanelaDeReentrada).finally(() => {
      reentrada = null;
    });
  }
  return reentrada;
}

function abrirJanelaDeReentrada(entrou, desistiu) {
  const fundo = document.createElement('div');
  fundo.className = 'fundo-modal';
  fundo.innerHTML = `
    <form class="modal" autocomplete="on">
      <h2>Entre de novo para continuar</h2>
      <p class="sub">Sua sessão expirou. O que você digitou continua aqui —
        depois de entrar, o portal termina o que estava fazendo.</p>
      <div id="recado-reentrada"></div>
      <label for="reentrada-login">Login</label>
      <input type="text" id="reentrada-login" autocomplete="username" autocapitalize="none"
             value="${escapar(quemEsta)}" readonly>
      <label for="reentrada-senha">Senha</label>
      <input type="password" id="reentrada-senha" autocomplete="current-password">
      <div class="linha-botoes">
        <button type="submit" id="reentrada-ok">Entrar</button>
        <button type="button" class="secundario" id="reentrada-cancela">Agora não</button>
      </div>
    </form>`;
  document.body.appendChild(fundo);
  const senha = fundo.querySelector('#reentrada-senha');
  senha.focus();

  fundo.querySelector('#reentrada-cancela').addEventListener('click', () => {
    fundo.remove();
    desistiu(new Error('cancelado'));
  });

  fundo.querySelector('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const botao = fundo.querySelector('#reentrada-ok');
    botao.disabled = true;
    try {
      const r = await buscarUmaVez('/api/entrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: quemEsta, senha: senha.value }),
        credentials: 'same-origin',
      });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(dados.erro || 'Não foi possível entrar.');
      fundo.remove();
      entrou();
    } catch (e) {
      mostrarRecado('recado-reentrada', e.message, 'erro');
      senha.select();
    } finally {
      botao.disabled = false;
    }
  });
}

/** Data de hoje (AAAA-MM-DD) no fuso do aparelho - nao em UTC. */
export function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

/** Valor para mostrar num campo de dinheiro: 45.9 -> "45,90", 0 -> "". */
export function valorNoCampo(v) {
  const n = Number(v);
  return n ? n.toFixed(2).replace('.', ',') : '';
}

export async function api(rota, { metodo = 'GET', corpo = null } = {}) {
  const opcoes = { method: metodo, headers: {}, credentials: 'same-origin' };
  if (corpo != null) {
    opcoes.headers['Content-Type'] = 'application/json';
    opcoes.body = JSON.stringify(corpo);
  }
  const resposta = await buscar(rota, opcoes);
  const texto = await resposta.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    throw new Error('O servidor respondeu algo inesperado.');
  }
  if (!resposta.ok) {
    const e = new Error(dados.erro || `Erro ${resposta.status}`);
    e.dados = dados;
    e.status = resposta.status;
    throw e;
  }
  return dados;
}

export async function subirArquivo(arquivo, { mes, tipo, km, data, valor, leituras }) {
  let rota = `/api/anexo?mes=${encodeURIComponent(mes)}&tipo=${encodeURIComponent(
    tipo,
  )}&nome=${encodeURIComponent(arquivo.name)}`;
  if (km != null) rota += `&km=${encodeURIComponent(km)}`;
  if (data) rota += `&data=${encodeURIComponent(data)}`;
  if (valor != null) rota += `&valor=${encodeURIComponent(valor)}`;
  if (leituras) rota += `&leituras=${encodeURIComponent(JSON.stringify(leituras))}`;
  const resposta = await buscar(rota, {
    method: 'POST',
    headers: { 'Content-Type': arquivo.type || 'application/octet-stream' },
    body: arquivo,
    credentials: 'same-origin',
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro || 'Falha ao enviar o arquivo.');
  return dados;
}

export function mostrarRecado(idOuElemento, texto, tipo = 'info') {
  const alvo =
    typeof idOuElemento === 'string' ? document.getElementById(idOuElemento) : idOuElemento;
  if (!alvo) return;
  if (!texto) {
    alvo.innerHTML = '';
    return;
  }
  alvo.innerHTML = `<div class="aviso ${tipo}">${escapar(texto)}</div>`;
}

export function escapar(t) {
  return String(t ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * O comprovante de que o achado fala, como uma linha embaixo da mensagem.
 *
 * Mora aqui porque as duas telas mostram achado - a do vendedor e a do
 * conferente - e "qual arquivo tem o problema" nao pode aparecer so numa.
 *
 * Com `anexo_id`, vira link para abrir o arquivo; sem ele (a IA citou um nome
 * que nao casou com nenhum anexo), fica so o nome escrito. Vazio quando o
 * achado nao e de um comprovante.
 */
export function anexoDoAchado(a) {
  if (!a?.anexo_id && !a?.anexo_nome) return '';
  const nome = escapar(a.anexo_nome || 'comprovante');
  if (!a.anexo_id) return `<div class="anexo-do-achado">📎 ${nome}</div>`;
  return `<div class="anexo-do-achado">
    📎 <a href="/api/anexo/${encodeURIComponent(a.anexo_id)}" target="_blank" rel="noopener">${nome}</a>
  </div>`;
}

// --------------------------------------------- achados iguais, numa linha so
//
// A conferencia gera um achado por dia: dez dias com o mesmo problema eram dez
// faixas dizendo a mesma coisa, e a tela virava uma parede. Aqui os que falam
// do mesmo assunto viram UMA linha, com os dias na frente; o texto de cada dia
// (os numeros) fica guardado atras de "ver cada dia".

const TITULO_DO_ACHADO = {
  data_fim_de_semana: 'Lançamento em fim de semana',
  data_feriado: 'Km lançado em feriado',
  km_invertido: 'KM final menor que o inicial',
  itinerario_vazio: 'Km lançado sem itinerário',
  km_zerado: 'Itinerário preenchido com 0 km',
  hodometro_retrocedeu: 'KM inicial menor que o KM final do dia anterior',
  hodometro_salto: 'Salto de KM em relação ao dia anterior',
  hodometro_lacuna_grande: 'Painel andou muito sem lançamento',
  despesa_noturna_sem_justificativa: 'Pedágio ou estacionamento depois das 18h sem explicação',
  foto_de_outro_mes: 'Foto de odômetro de outro mês',
  foto_fora_da_sequencia: 'Foto de odômetro fora da sequência do mês',
  foto_nao_bate_com_o_dia: 'Foto do painel não bate com o KM do dia',
  foto_nao_bate_justificada: 'Foto do painel não bate com o KM do dia (justificado)',
  fotos_em_ordem_errada: 'Foto do painel marca menos que a foto anterior',
  troca_de_carro_justificada: 'Troca de carro justificada',
};

// "Dias 03, 04 e 12" quando e tudo do mesmo mes; senao cada um com o mes.
function rotuloDosDias(datas) {
  const dias = [...new Set(datas)].sort();
  const mesmoMes = new Set(dias.map((d) => d.slice(0, 7))).size === 1;
  const nomes = dias.map((d) => (mesmoMes ? d.slice(8, 10) : `${d.slice(8, 10)}/${d.slice(5, 7)}`));
  const lista = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}` : nomes[0];
  return `${nomes.length > 1 ? 'Dias' : 'Dia'} ${lista}`;
}

/**
 * Junta os achados que falam da mesma coisa.
 *
 * Com dia: o mesmo codigo em varios dias vira um grupo. Sem dia: so junta
 * texto identico (o mesmo recado repetido para varios comprovantes).
 * `manter(a)` verdadeiro deixa o achado sozinho - e o caso dos que tem botao
 * de justificar por dia na tela do colaborador.
 *
 * Devolve, na ordem em que apareceram, o achado como veio ou
 * `{ grupo: true, gravidade, codigo, titulo, itens }`.
 */
export function agruparAchados(lista, { manter = () => false } = {}) {
  const saida = [];
  const grupos = new Map();
  for (const a of lista || []) {
    if (manter(a)) {
      saida.push(a);
      continue;
    }
    const chave = a.data
      ? `${a.gravidade}|${a.codigo}`
      : `${a.gravidade}|${a.codigo}|${a.mensagem}`;
    let g = grupos.get(chave);
    if (!g) {
      g = { grupo: true, gravidade: a.gravidade, codigo: a.codigo, itens: [] };
      grupos.set(chave, g);
      saida.push(g);
    }
    g.itens.push(a);
  }
  return saida.map((g) => {
    if (!g.grupo) return g;
    if (g.itens.length === 1) return g.itens[0];
    const primeiro = g.itens[0];
    const titulo = !primeiro.data
      ? primeiro.mensagem
      : TITULO_DO_ACHADO[g.codigo]
        // Codigo sem titulo proprio: o texto do primeiro dia, sem a data.
        || String(primeiro.mensagem).replace(/^\d{2}\/\d{2}(\/\d{4})?(\s+as\s+\d{1,2}:\d{2})?\s*:?\s*/, '');
    return { ...g, titulo };
  });
}

/** O grupo de `agruparAchados` como uma faixa so. */
/** Classe extra do achado: a justificativa do aumento sobre o mes anterior sai em roxo. */
export const classeDoAchado = (a) => (a.codigo === 'aumento_justificado' ? ' justificativa' : '');

export function htmlDoGrupoDeAchados(g, extra = '') {
  const comDia = Boolean(g.itens[0].data);
  const cabeca = comDia
    ? `<strong>${escapar(rotuloDosDias(g.itens.map((a) => a.data)))}</strong> — ${escapar(g.titulo)}`
    : escapar(g.titulo);
  const corpo = comDia
    ? `<details class="detalhe-do-achado">
         <summary>ver cada dia</summary>
         <ul>${g.itens.map((a) => `<li>${escapar(a.mensagem)}${anexoDoAchado(a)}</li>`).join('')}</ul>
       </details>`
    : g.itens.map((a) => anexoDoAchado(a)).join('');
  return `<div class="achado ${g.gravidade}${classeDoAchado(g)}">
    <span class="icone">${g.gravidade === 'erro' ? '✕' : '!'}</span>
    <div class="corpo">
      <span>${cabeca}</span>
      ${corpo}
    </div>${extra}
  </div>`;
}

/**
 * A placa como ela deve aparecer na tela.
 *
 * O servidor agora peneira o que entra no campo, mas cadastro sujo de antes
 * continua no banco - e foi um deles, com 3.314 caracteres, que virou um muro
 * de texto dentro da janela do relatorio. Nenhuma tela despeja esse campo sem
 * limite: o que passar de 60 caracteres aparece cortado, com um aviso de que
 * o cadastro precisa de conserto.
 */
export function placaParaTela(bruto) {
  const texto = String(bruto ?? '').replace(/\s+/g, ' ').trim();
  if (!texto) return '';
  if (texto.length <= 60) return texto;
  return `${texto.slice(0, 60)}… (cadastro com texto inválido no campo placa)`;
}

export const brl = (v) =>
  Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const numeroBr = (v) => Number(v || 0).toLocaleString('pt-BR');

export function dataBr(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

export function dataHoraBr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function tamanhoBr(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function sair() {
  try {
    await api('/api/sair', { metodo: 'POST' });
  } finally {
    location.href = '/';
  }
}

export const ROTULO_ANEXO = {
  rdv: 'Relatório (RDV)',
  pedagio: 'Pedágio / estacionamento',
  danfe: 'Nota de abastecimento',
  hotel: 'Nota do hotel',
  outras_despesas: 'Comprovante de outras despesas',
  odometro: 'Foto do odômetro',
  outro: 'Outro documento',
};

// Registra o service worker para o site poder ser instalado como app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ------------------------------------------------------------ notificacoes
//
// Pede permissao para avisar no celular e manda o endereco do aparelho para o
// servidor, que guarda na lista do admin. O pedido sai de um toque num botao
// porque o iPhone recusa pedido de permissao que nao vem de um toque, e o
// Chrome esconde o que aparece sozinho ao abrir a pagina.

const ADIAR_DIAS = 7;

function estaInstalado() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function ehIphone() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function descricaoDoAparelho() {
  const ua = navigator.userAgent;
  const sistema = ehIphone() ? (/iPad/.test(ua) ? 'iPad' : 'iPhone')
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac/.test(ua) ? 'Mac' : 'Outro';
  const navegador = /SamsungBrowser/.test(ua) ? 'Samsung'
    : /Edg\//.test(ua) ? 'Edge'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : '';
  return navegador ? `${sistema} - ${navegador}` : sistema;
}

function chaveEmBytes(base64url) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function inscreverEsteAparelho() {
  const registro = await navigator.serviceWorker.ready;
  let inscricao = await registro.pushManager.getSubscription();
  if (!inscricao) {
    const { chave } = await api('/api/push/chave');
    inscricao = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: chaveEmBytes(chave),
    });
  }
  await api('/api/push/inscrever', {
    metodo: 'POST',
    corpo: { inscricao: inscricao.toJSON(), descricao: descricaoDoAparelho(), instalado: estaInstalado() },
  });
}

function adiado(chave = 'notif-adiada-ate') {
  try {
    return Number(localStorage.getItem(chave) || 0) > Date.now();
  } catch {
    return false;
  }
}

function adiar(chave = 'notif-adiada-ate', dias = ADIAR_DIAS) {
  try {
    localStorage.setItem(chave, String(Date.now() + dias * 864e5));
  } catch {
    // sem armazenamento: o convite volta na proxima vez, so isso
  }
}

function faixaDeNotificacao(html, { botaoSim = null, chave, dias } = {}) {
  const faixa = document.createElement('div');
  faixa.className = 'cartao';
  faixa.style.cssText = [
    'position:fixed', 'left:12px', 'right:12px', 'bottom:12px', 'z-index:9000',
    'max-width:480px', 'margin:0 auto', 'box-shadow:0 8px 28px rgba(0,0,0,.18)',
  ].join(';');
  faixa.innerHTML = `
    <div>${html}</div>
    <div class="linha-botoes" style="margin-top:12px">
      ${botaoSim ? `<button type="button" data-sim>${botaoSim}</button>` : ''}
      <button type="button" class="secundario" data-nao>Agora não</button>
    </div>`;
  document.body.append(faixa);
  faixa.querySelector('[data-nao]').addEventListener('click', () => {
    adiar(chave, dias);
    faixa.remove();
  });
  return faixa;
}

// ------------------------------------------------------- instalar o app
//
// Notificacao confiavel no celular so com o portal instalado: no iPhone e a
// unica forma, e no Android o app instalado tem o proprio ajuste de som. Por
// isso, quem entra pelo navegador do celular ve o convite para instalar toda
// vez que entra - "Agora nao" so cala por um dia.
//
// O Chrome do Android avisa que da para instalar com o evento
// beforeinstallprompt; guardado aqui, vira o botao "Instalar app". Ele pode
// chegar antes ou depois do convite aparecer, entao o botao nasce escondido.
// iPhone e os outros navegadores nao tem o evento: ficam so as instrucoes.

let pedidoDeInstalacao = null;
let faixaDeInstalacao = null;

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  pedidoDeInstalacao = ev;
  faixaDeInstalacao?.querySelector('[data-sim]')?.classList.remove('esconde');
});

window.addEventListener('appinstalled', () => {
  pedidoDeInstalacao = null;
  if (!faixaDeInstalacao) return;
  faixaDeInstalacao.innerHTML = `<div class="aviso ok"><strong>App instalado!</strong> Agora abra o portal pelo
    ícone <strong>RDV</strong> na tela inicial e toque em <strong>Ativar notificações</strong>.</div>`;
  setTimeout(() => faixaDeInstalacao?.remove(), 8000);
});

function ehCelular() {
  return ehIphone() || /Android|Mobi/.test(navigator.userAgent);
}

function convidarParaInstalar() {
  const comoFazer = ehIphone()
    ? `No Safari, toque em <strong>Compartilhar</strong> (o quadrado com a seta) e depois em
       <strong>Adicionar à Tela de Início</strong>.`
    : `Toque no menu <strong>⋮</strong> do navegador e em <strong>Instalar app</strong>
       (ou <strong>Adicionar à tela inicial</strong>).`;
  faixaDeInstalacao = faixaDeNotificacao(
    `<strong>Instale o app do Portal RDV</strong>
     <p class="sub" style="margin:6px 0 0">É assim que o seu celular recebe os avisos do portal,
     como RDV conferido ou com pendência. ${comoFazer}
     Depois, abra pelo ícone novo e ative as notificações.</p>`,
    { botaoSim: 'Instalar app', chave: 'instalar-adiado-ate', dias: 1 },
  );
  const botao = faixaDeInstalacao.querySelector('[data-sim]');
  if (!pedidoDeInstalacao) botao.classList.add('esconde');
  botao.addEventListener('click', async () => {
    if (!pedidoDeInstalacao) return;
    pedidoDeInstalacao.prompt();
    const { outcome } = await pedidoDeInstalacao.userChoice;
    pedidoDeInstalacao = null;
    // Aceitou: o 'appinstalled' troca o recado. Recusou: o convite volta amanha.
    if (outcome !== 'accepted') {
      adiar('instalar-adiado-ate', 1);
      faixaDeInstalacao.remove();
    }
  });
}

/** Chamar depois do login. Nao trava a tela: tudo aqui e silencioso se falhar. */
export async function oferecerNotificacoes() {
  try {
    const temPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    if (temPush && Notification.permission === 'granted') {
      // Ja aceitou antes: so renova o endereco, que pode ter mudado.
      await inscreverEsteAparelho();
      return;
    }

    // Celular pelo navegador: primeiro instalar. As notificacoes o convite
    // abaixo pede quando a pessoa abrir pelo icone.
    if (ehCelular() && !estaInstalado()) {
      if (!adiado('instalar-adiado-ate')) convidarParaInstalar();
      return;
    }

    if (!temPush || Notification.permission === 'denied' || adiado()) return;

    const faixa = faixaDeNotificacao(
      `<strong>Ativar notificações do Portal RDV?</strong>
       <p class="sub" style="margin:6px 0 0">Você recebe no celular quando o seu RDV for conferido
       ou tiver alguma pendência.</p>`,
      { botaoSim: 'Ativar notificações' },
    );
    faixa.querySelector('[data-sim]').addEventListener('click', async () => {
      const resposta = await Notification.requestPermission();
      if (resposta === 'granted') {
        try {
          await inscreverEsteAparelho();
          faixa.innerHTML = '<div class="aviso ok">Pronto! Este aparelho vai receber os avisos do portal.</div>';
        } catch {
          faixa.innerHTML = '<div class="aviso erro">Não deu para ativar agora. Tente de novo mais tarde.</div>';
        }
        setTimeout(() => faixa.remove(), 3500);
      } else {
        adiar();
        faixa.remove();
      }
    });
  } catch {
    // notificacao e conveniencia: nunca pode quebrar a tela
  }
}

/**
 * Faixa de ambiente de teste.
 *
 * O staging e uma copia identica do portal de verdade - mesma tela, mesmos
 * nomes, mesmos relatorios. Sem um aviso que nao da para ignorar, alguem
 * lanca o RDV do mes no lugar errado e so descobre no fechamento.
 */
export function marcarAmbiente(ambiente) {
  if (!ambiente) return;
  const faixa = document.createElement('div');
  faixa.textContent = `AMBIENTE DE TESTE (${String(ambiente).toUpperCase()}) — nada aqui vale para o fechamento do mês`;
  faixa.style.cssText = [
    'position:sticky', 'top:0', 'z-index:9999',
    'background:#b45309', 'color:#fff',
    'font-weight:700', 'font-size:13px', 'letter-spacing:.02em',
    'text-align:center', 'padding:7px 12px',
  ].join(';');
  document.body.prepend(faixa);
}
