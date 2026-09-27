// Funcoes usadas pelas tres telas.

// fetch que fala portugues quando a rede cai. Sem isto o celular mostrava
// "Failed to fetch" (Chrome) ou "Load failed" (iPhone).
async function buscar(rota, opcoes) {
  try {
    return await fetch(rota, opcoes);
  } catch {
    throw new Error('Sem conexão com o portal. Confira o sinal da internet e tente de novo.');
  }
}

/** Data de hoje (AAAA-MM-DD) no fuso do aparelho - nao em UTC. */
export function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

export async function subirArquivo(arquivo, { mes, tipo, km, data }) {
  let rota = `/api/anexo?mes=${encodeURIComponent(mes)}&tipo=${encodeURIComponent(
    tipo,
  )}&nome=${encodeURIComponent(arquivo.name)}`;
  if (km != null) rota += `&km=${encodeURIComponent(km)}`;
  if (data) rota += `&data=${encodeURIComponent(data)}`;
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
