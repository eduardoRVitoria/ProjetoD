// Duas passagens na mesma praca no mesmo dia: ida e volta, nem aviso gera.
// RDV sem assinatura digital: pode estar assinado a mao, nao reprova.
//   node testes/pedagio-repetido.mjs
import assert from 'node:assert/strict';
import { achadoDaIaSobrePedagio, gravidadeDoAchadoDaIa } from '../src/conferencia.js';
import { achadosDaAssinatura, rdvEstaAssinado } from '../src/assinatura.js';

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

// Sem assinatura digital, sozinho, nao gera achado: pode estar assinado a mao.
assert.equal(achadosDaAssinatura({ assinado: false, assinaturas: [] }, 'FULANO DE TAL').length, 0);

// Quem decide e o conjunto: sem gov.br E sem assinatura a mao reprova.
const digital = { digital: true, semMarca: false };
const limpo = { digital: false, semMarca: true }; // PDF direto do Excel, sem nada
const escaneado = { digital: false, semMarca: false }; // foto ou papel escaneado
assert.equal(rdvEstaAssinado([digital], 'nao'), 'sim', 'assinatura digital vale mais que a opiniao da IA');
assert.equal(rdvEstaAssinado([limpo], undefined), 'nao', 'PDF limpo reprova mesmo sem IA');
assert.equal(rdvEstaAssinado([limpo], 'sim'), 'nao', 'a conta ganha da IA');
assert.equal(rdvEstaAssinado([limpo, digital], undefined), 'sim', 'basta um arquivo assinado');
assert.equal(rdvEstaAssinado([escaneado], 'sim'), 'sim', 'assinado a mao, visto pela IA');
assert.equal(rdvEstaAssinado([escaneado], 'nao'), 'nao');
assert.equal(rdvEstaAssinado([escaneado], undefined), null, 'ninguem viu: aviso, nao erro');
assert.equal(rdvEstaAssinado([limpo, escaneado], undefined), null);
assert.equal(rdvEstaAssinado([], 'nao'), 'sem_rdv');

console.log('OK - ida e volta nao gera achado; sem gov.br e sem assinatura a mao reprova');
