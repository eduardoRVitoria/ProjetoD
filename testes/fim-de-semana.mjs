// Sabado e domingo com lancamento reprovam, em qualquer empresa.
//   node testes/fim-de-semana.mjs
import assert from 'node:assert/strict';
import { conferir } from '../src/conferencia.js';

// 05/09/2026 e sabado, 06/09 e domingo.
const linhas = [
  { data: '2026-09-04', km_inicial: 1000, km_final: 1100, itinerario: 'A - B' },
  { data: '2026-09-05', km_inicial: 1100, km_final: 1180, itinerario: 'B - C' },
  { data: '2026-09-06', km_inicial: 1180, km_final: 1180, itinerario: 'C', pedagio: 12.5 },
];
for (const empresa of ['DISO', 'DSO', 'PROMOTORES', 'ALPHA']) {
  const r = conferir({ mes_ref: '2026-09' }, linhas, [{ tipo: 'rdv' }], 0.9, null, empresa, 'Vendedor');
  const fds = r.achados.filter((a) => a.codigo === 'data_fim_de_semana');
  assert.deepEqual(fds.map((a) => [a.data, a.gravidade]), [['2026-09-05', 'erro'], ['2026-09-06', 'erro']], empresa);
  assert.equal(r.statusSugerido, 'ERRADA', empresa);
}

// Gerente: combustivel lancado no sabado, sem km, tambem e lancamento.
const gerente = conferir(
  { mes_ref: '2026-09' },
  [
    { data: '2026-09-04', km_inicial: 1000, km_final: 1100, itinerario: 'A - B', combustivel: 100 },
    { data: '2026-09-05', km_inicial: 0, km_final: 0, itinerario: '', combustivel: 150 },
  ],
  [{ tipo: 'rdv' }], 0.9, null, 'DSO', 'Gerente',
);
assert.ok(gerente.achados.some((a) => a.codigo === 'data_fim_de_semana' && a.data === '2026-09-05' && a.gravidade === 'erro'));

// Fim de semana em branco no RDV nao e problema.
const limpo = conferir(
  { mes_ref: '2026-09' },
  [
    { data: '2026-09-04', km_inicial: 1000, km_final: 1100, itinerario: 'A - B' },
    { data: '2026-09-05', km_inicial: 0, km_final: 0, itinerario: '' },
    { data: '2026-09-07', km_inicial: 1100, km_final: 1200, itinerario: 'B - C' },
  ],
  [{ tipo: 'rdv' }], 0.9, null, 'DSO', 'Vendedor',
);
assert.ok(!limpo.achados.some((a) => a.codigo === 'data_fim_de_semana'));

console.log('OK - sabado e domingo com lancamento reprovam em todas as empresas, inclusive combustivel de gerente');
