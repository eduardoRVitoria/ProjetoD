// Funcoes usadas pelas tres telas.

export async function api(rota, { metodo = 'GET', corpo = null } = {}) {
  const opcoes = { method: metodo, headers: {}, credentials: 'same-origin' };
  if (corpo != null) {
    opcoes.headers['Content-Type'] = 'application/json';
    opcoes.body = JSON.stringify(corpo);
  }
  const resposta = await fetch(rota, opcoes);
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
    throw e;
  }
  return dados;
}

export async function subirArquivo(arquivo, { mes, tipo }) {
  const rota = `/api/anexo?mes=${encodeURIComponent(mes)}&tipo=${encodeURIComponent(
    tipo,
  )}&nome=${encodeURIComponent(arquivo.name)}`;
  const resposta = await fetch(rota, {
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
  pedagio: 'Pedágio / estacionamento',
  danfe: 'Nota de abastecimento',
  odometro: 'Foto do odômetro',
  outro: 'Outro documento',
};

// Registra o service worker para o site poder ser instalado como app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
