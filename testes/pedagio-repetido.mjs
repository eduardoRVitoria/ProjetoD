// Duas passagens na mesma praca no mesmo dia: ida e volta, nem aviso gera.
// RDV sem assinatura digital: pode estar assinado a mao, nao reprova.
//   node testes/pedagio-repetido.mjs
import assert from 'node:assert/strict';
import { achadoDaIaSobrePedagio, gravidadeDoAchadoDaIa } from '../src/conferencia.js';
import { achadosDaAssinatura } from '../src/assinatura.js';

// O que a IA escreveu de verdade em 01/10 (supervisor da ALPHA, ida e volta em
// Cajati e Juquia), como erro: e achado de pedagio, que a conferencia descarta
// quando o valor bate, e que nunca reprova quando nao bate.
const daIa = [
  'Pedagio dia 16: declarado R$ 8,60, comprovantes mostram R$ 4,30 (08:03) + R$ 4,30 (14:28) = R$ 8,60 (correto, mas com 2 passagens).',
  'Pedágio dia 15/09: R$ 8,60 declarado, R$ 8,60 comprovado (2x R$ 4,30). Confira se houve duas passagens no mesmo dia.',
];
for (const mensagem of daIa) {
  assert.equal(achadoDaIaSobrePedagio({ mensagem }), true);
  assert.equal(gravidadeDoAchadoDaIa({ gravidade: 'erro', mensagem }), 'aviso');
}
// Erro da IA sobre outro assunto continua erro; aviso continua aviso.
const odometro = { gravidade: 'erro', mensagem: 'Foto do odometro ilegivel. Reenvie.' };
assert.equal(achadoDaIaSobrePedagio(odometro), false);
assert.equal(gravidadeDoAchadoDaIa(odometro), 'erro');
assert.equal(gravidadeDoAchadoDaIa({ gravidade: 'aviso', mensagem: 'Itinerario longo para 20 km.' }), 'aviso');

// PDF sem assinatura digital: so aviso, o relatorio continua podendo sair CERTA.
const semDigital = achadosDaAssinatura({ assinado: false, assinaturas: [] }, 'FULANO DE TAL');
assert.equal(semDigital.length, 1);
assert.equal(semDigital[0].gravidade, 'aviso');
assert.equal(semDigital[0].codigo, 'sem_assinatura_digital');

console.log('OK - ida e volta nao gera achado; RDV assinado a mao nao reprova');
