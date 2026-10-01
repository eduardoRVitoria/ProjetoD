// Duas passagens na mesma praca no mesmo dia: aviso (amarelo), nao erro.
//   node testes/pedagio-repetido.mjs
import assert from 'node:assert/strict';
import { passagensRepetidas } from '../src/conferencia.js';

// O caso real de 01/10: supervisor da ALPHA, ida e volta em Cajati e Juquia.
const passagens = [
  { data: '2026-09-15', hora: '08:35', valor: 4.3, local: 'CAJATI KM485+700', tipo: 'pedagio' },
  { data: '2026-09-15', hora: '14:17', valor: 4.3, local: 'CAJATI KM485+700', tipo: 'pedagio' },
  { data: '2026-09-16', hora: '14:28', valor: 4.3, local: 'JUQUIÁ KM426+600', tipo: 'pedagio' },
  { data: '2026-09-16', hora: '08:03', valor: 4.3, local: 'JUQUIÁ KM426+600', tipo: 'pedagio' },
];

const achados = passagensRepetidas(passagens);
assert.equal(achados.length, 2, 'um aviso por dia/praca');
assert.ok(achados.every((a) => a.gravidade === 'aviso'), 'nunca erro');
assert.ok(achados.every((a) => a.codigo === 'pedagio_repetido'));
assert.match(achados[0].mensagem, /15\/09.*2 passagens.*4,30.*CAJATI.*08:35 e 14:17/);
assert.match(achados[1].mensagem, /08:03 e 14:28/, 'horas em ordem');

// Uma passagem so, pracas diferentes ou valores diferentes: nada a avisar.
assert.equal(passagensRepetidas([passagens[0]]).length, 0);
assert.equal(passagensRepetidas([passagens[0], passagens[2]]).length, 0);
assert.equal(passagensRepetidas([passagens[0], { ...passagens[1], valor: 8.6 }]).length, 0);
assert.equal(passagensRepetidas(undefined).length, 0);

console.log('OK - passagem repetida no mesmo dia vira aviso, nao erro');
