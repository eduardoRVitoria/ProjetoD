// Promotor manda foto do odometro todo dia rodado; os outros, segunda e sexta.
import assert from 'node:assert/strict';
import { fotosDiarias, fotosEsperadas, fotosQueFaltam } from '../src/conferencia.js';

const linhas = [
  { data: '2026-09-01', km_inicial: 100, km_final: 150 },
  { data: '2026-09-02', km_inicial: 150, km_final: 150 }, // nao rodou
  { data: '2026-09-03', km_inicial: 150, km_final: 210 },
  { data: '2026-09-04', km_inicial: 210, km_final: 260 },
];

const diarias = fotosDiarias(linhas, '2026-09');
assert.deepEqual(diarias.map((d) => d.data), ['2026-09-01', '2026-09-03', '2026-09-04']);

const faltam = fotosQueFaltam(diarias, [{ data_leitura: '2026-09-01' }, { data_leitura: '2026-09-04' }]);
assert.deepEqual(faltam.map((f) => f.data), ['2026-09-03']);

// Outras empresas continuam com as pontas da semana (a segunda 31/08 e do
// mes anterior, sobra a sexta a noite).
assert.deepEqual(fotosEsperadas(linhas, '2026-09'), [{ data: '2026-09-04', momento: 'noite' }]);

console.log('odometro-promotor OK');
