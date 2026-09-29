// Carro da empresa nao cobra foto do odometro; carro pessoal cobra.
//   node testes/carro.mjs
import assert from 'node:assert/strict';
import { conferir } from '../src/conferencia.js';

const rel = { mes_ref: '2026-09', extraido: null };
const linhas = [
  { data: '2026-09-01', km_inicial: 1000, km_final: 1100, itinerario: 'Campinas', pedagio: 0, estacionamento: 0 },
  { data: '2026-09-02', km_inicial: 1100, km_final: 1200, itinerario: 'Campinas', pedagio: 0, estacionamento: 0 },
];
const codigos = (r) => r.achados.map((a) => a.codigo);

const pessoal = conferir(rel, linhas, [], 0.9, null, 'DISO', 'Supervisor', 'pessoal');
assert.ok(codigos(pessoal).includes('sem_odometro'), 'carro pessoal cobra a foto');

const empresa = conferir(rel, linhas, [], 0.9, null, 'DISO', 'Supervisor', 'empresa');
assert.ok(!codigos(empresa).includes('sem_odometro'));
assert.ok(!codigos(empresa).includes('odometro_incompleto'));
assert.equal(empresa.carroDaEmpresa, true);

// Sem o parametro, continua cobrando (padrao pessoal).
assert.ok(codigos(conferir(rel, linhas, [], 0.9, null, 'DISO', 'Vendedor')).includes('sem_odometro'));

console.log('OK - carro da empresa dispensa a foto do odometro');
