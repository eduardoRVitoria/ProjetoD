// Ponto de milhar lido como decimal: "61.350" virando 61.35 e "4.547" virando 4,547 km.
//   node testes/km-ponto.mjs
import assert from 'node:assert/strict';
import { odometroInteiro, totalDeKmDeclarado } from '../src/util.js';
import { conferir } from '../src/conferencia.js';

// Odometro: abaixo de mil com fracao e milhar; o resto fica como esta.
assert.equal(odometroInteiro(61.35), 61350);
assert.equal(odometroInteiro(61.528), 61528);
assert.equal(odometroInteiro(134.029), 134029);
assert.equal(odometroInteiro(61350), 61350);
assert.equal(odometroInteiro(850), 850);
assert.equal(odometroInteiro(0), 0);
assert.equal(odometroInteiro('abc'), 0);

// Total do mes: a soma dos dias decide.
assert.equal(totalDeKmDeclarado(4.547, 4547), 4547);
assert.equal(totalDeKmDeclarado(4.547, 4527), 4547, 'mesmo com a soma dos dias diferente');
assert.equal(totalDeKmDeclarado(4.55, 4550), 4550, '"4.550" chega como 4.55');
assert.equal(totalDeKmDeclarado(850.5, 850.5), 850.5, 'fracao de verdade continua');
assert.equal(totalDeKmDeclarado(4547, 4547), 4547);
assert.equal(totalDeKmDeclarado(4.547, 0), 4.547, 'sem dias nao ha como saber');

// O caso do RDV: o documento declara 4.547 km e a leitura guardou 4.547.
const linhas = [
  { data: '2026-09-01', km_inicial: 61350, km_final: 62350, itinerario: 'A - B' },
  { data: '2026-09-02', km_inicial: 62350, km_final: 63897, itinerario: 'B - C' },
  { data: '2026-09-03', km_inicial: 63897, km_final: 65897, itinerario: 'C - D' },
];
const rel = {
  mes_ref: '2026-09',
  extraido: JSON.stringify({ totais_declarados: { total_km: 4.547, valor_total_km: 4092.3 } }),
};
const r = conferir(rel, linhas, [{ tipo: 'rdv' }], 0.9, null, 'DSO', 'Vendedor');
assert.equal(r.totalKm, 4547);
assert.ok(!r.achados.some((a) => a.codigo === 'soma_km'), 'quatro mil, nao quatro: a soma bate');
assert.ok(!r.achados.some((a) => a.codigo === 'valor_km'));

// Dia com distancia impossivel reprova, dizendo o dia e os numeros - em vez de
// entrar calado no total (um RDV chegou a mostrar mais de R$ 1 bilhao).
const absurdo = conferir(
  { mes_ref: '2026-09' },
  [
    { data: '2026-09-01', km_inicial: 61350, km_final: 61528, itinerario: 'A - B' },
    { data: '2026-09-02', km_inicial: 61528, km_final: 1261528670, itinerario: 'B - C' },
  ],
  [{ tipo: 'rdv' }], 0.9, null, 'DSO', 'Vendedor',
);
const doDia = absurdo.achados.filter((a) => a.codigo === 'km_do_dia_impossivel');
assert.equal(doDia.length, 1);
assert.equal(doDia[0].gravidade, 'erro');
assert.equal(doDia[0].data, '2026-09-02');
assert.match(doDia[0].mensagem, /02\/09\/2026.*km num dia so.*61\.528.*1\.261\.528\.670/);
// Dia longo de verdade (ate 2.000 km) nao e acusado.
assert.ok(!r.achados.some((a) => a.codigo === 'km_do_dia_impossivel'));

console.log('OK - ponto de milhar volta a ser milhar; dia com km impossivel reprova em vez de entrar no total');
