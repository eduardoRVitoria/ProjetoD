// Feriados nacionais + estaduais de Sao Paulo, calculados para qualquer ano.
// O 09/07 (Revolucao Constitucionalista) e o que mais aparece nos RDVs:
// quase todo mundo zera esse dia, e quem lanca KM nele cai em divergencia.

function domingoDePascoa(ano) {
  // Algoritmo de Meeus/Jones/Butcher.
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const iso = (d) => d.toISOString().slice(0, 10);
const somaDias = (d, n) => new Date(d.getTime() + n * 86400_000);

const cache = new Map();

export function feriadosDoAno(ano) {
  if (cache.has(ano)) return cache.get(ano);

  const pascoa = domingoDePascoa(ano);
  const lista = {
    [`${ano}-01-01`]: 'Confraternizacao Universal',
    [`${ano}-04-21`]: 'Tiradentes',
    [`${ano}-05-01`]: 'Dia do Trabalho',
    [`${ano}-07-09`]: 'Revolucao Constitucionalista (feriado estadual SP)',
    [`${ano}-09-07`]: 'Independencia',
    [`${ano}-10-12`]: 'Nossa Senhora Aparecida',
    [`${ano}-11-02`]: 'Finados',
    [`${ano}-11-15`]: 'Proclamacao da Republica',
    [`${ano}-11-20`]: 'Consciencia Negra',
    [`${ano}-12-25`]: 'Natal',
    [iso(somaDias(pascoa, -48))]: 'Carnaval (segunda)',
    [iso(somaDias(pascoa, -47))]: 'Carnaval (terca)',
    [iso(somaDias(pascoa, -2))]: 'Sexta-feira Santa',
    [iso(somaDias(pascoa, 60))]: 'Corpus Christi',
  };

  cache.set(ano, lista);
  return lista;
}

export function nomeDoFeriado(dataIso) {
  const ano = Number(String(dataIso).slice(0, 4));
  if (!Number.isFinite(ano)) return null;
  return feriadosDoAno(ano)[dataIso] || null;
}

// Segunda = 1 ... Domingo = 0. Retorna 'sabado', 'domingo' ou null.
export function fimDeSemana(dataIso) {
  const d = new Date(`${dataIso}T12:00:00Z`);
  const n = d.getUTCDay();
  if (n === 6) return 'sabado';
  if (n === 0) return 'domingo';
  return null;
}

export function diaDaSemana(dataIso) {
  const nomes = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  return nomes[new Date(`${dataIso}T12:00:00Z`).getUTCDay()];
}
