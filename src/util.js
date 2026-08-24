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

export function erro(res, mensagem, status = 400) {
  responderJson(res, { erro: mensagem }, status);
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

export function numero(v, padrao = 0) {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : padrao;
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

export function nomeDeArquivoSeguro(nome) {
  return String(nome || 'arquivo')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-120);
}

export const ROTULO_STATUS = {
  RASCUNHO: 'Rascunho',
  ENVIADO: 'Enviado, aguardando conferencia',
  CONFERINDO: 'Em conferencia',
  CERTA: 'Aprovado',
  SO_FALTA_DANFE: 'So falta a nota de abastecimento',
  ERRADA: 'Reprovado - precisa corrigir',
};
