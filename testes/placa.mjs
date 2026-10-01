// Assinatura em cima da placa, decidida pela posicao do selo e do numero.
//   node testes/placa.mjs
import assert from 'node:assert/strict';
import { retanguloDaPlaca, seloCobre } from '../src/placa.js';

// Posicoes medidas em dois RDVs de verdade (pontos do PDF, y para cima).

// Coordenador dos PROMOTORES, setembro: selo na caixa de assinatura, logo
// abaixo da placa. A IA dizia "em cima"; a placa esta inteira visivel.
const encostado = retanguloDaPlaca([
  { s: 'JUSTIFICATIVAS', x: 640, y: 410, l: 60, a: 7 },
  { s: 'Placa do veículo: TMC5G71', x: 521, y: 399, l: 97, a: 6 },
  { s: 'ASSINATURA POR EXTENSO', x: 619, y: 345, l: 105, a: 7 },
]);
assert.equal(encostado.placa, 'TMC5G71');
assert.ok(encostado.x1 > 580 && encostado.x2 <= 618.5, 'so o numero, nao o rotulo');
assert.equal(seloCobre(encostado, [[523, 352, 820, 396]]), false, 'selo abaixo da linha nao cobre');
assert.equal(seloCobre(encostado, [[523, 352, 820, 399.5]]), false, 'encostar na base da letra nao cobre');

// Vendedor, julho: o selo subiu e tapou o numero - esse reprova.
const picado = [
  { s: 'Placa', x: 537, y: 398, l: 22, a: 7 },
  { s: 'do', x: 563, y: 398, l: 9, a: 7 },
  { s: 'veículo:', x: 576, y: 398, l: 34, a: 7 },
  { s: 'FQA9J59', x: 614, y: 398, l: 31, a: 7 },
];
const coberto = retanguloDaPlaca(picado);
assert.equal(coberto.placa, 'FQA9J59');
assert.equal(seloCobre(coberto, [[611, 359, 776, 404]]), true);
// O mesmo selo mais para a direita, cobrindo so o vazio depois da placa.
assert.equal(seloCobre(coberto, [[660, 359, 825, 404]]), false);

// Placa antiga com hifen, e formulario sem placa preenchida.
assert.equal(retanguloDaPlaca([{ s: 'Placa do veículo: EFY-1734', x: 191, y: 417, l: 140, a: 10 }]).placa, 'EFY-1734');
assert.equal(retanguloDaPlaca([{ s: 'Placa do veículo:', x: 500, y: 401, l: 68, a: 7 }]), null);
assert.equal(retanguloDaPlaca([{ s: 'Itinerário de Trabalho', x: 500, y: 300, l: 90, a: 7 }]), null);

console.log('OK - selo encostado na placa nao reprova; selo em cima do numero reprova');
