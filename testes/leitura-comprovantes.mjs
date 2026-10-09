// Conferencia dos comprovantes por codigo (texto, OCR, QR) - as partes puras.
//   node testes/leitura-comprovantes.mjs
import assert from 'node:assert/strict';
import {
  passagensDoExtrato, valoresDoComprovante, todosOsValores, chaveDeAcesso, montarParecer,
} from '../src/leitura-comprovantes.js';

const palavras = (s) => s.split(/\s+/);

// ---- extrato de tag: tres formatos que apareceram nos PDFs de julho e agosto
const extrato = passagensDoExtrato([
  palavras('Data Veículo Tipo Descrição Valor'),
  palavras('27/08/2026 52 PALIO - ABC1D23 PASSAGEM PASSAGEM 11.10'),
  palavras('4/8/2026 36 VIRTUS - ABC1D23 Pedágio SP360, KM77+100, SUL, ITATIBA R$ 6,40'),
  palavras('2/7/2026 19 CITY - ABC1D23 Estacionamento SHOPPING PATIO LIMEIRA R$ 12,00'),
  palavras('8/7/2026 07 HRV - ABC1D23 Outros Total de dias de uso cobrados: 3 R$ 14,00'),
  palavras('20/07/2026 - 09:27:28 ABC-1D23 AUTOBAN - NOVA ODESSA 174 SUL, KM 118, -R$ 12.80 R$ 49.88'),
  palavras('15/07/2026 - 10:00:00 Recarga R$ 150.00 R$ 199.88'),
]);
assert.deepEqual(extrato.passagens.map((p) => [p.data, p.valor, p.tipo]), [
  ['2026-08-27', 11.1, 'pedagio'],
  ['2026-08-04', 6.4, 'pedagio'],
  ['2026-07-02', 12, 'estacionamento'],
  ['2026-07-20', 12.8, 'pedagio'], // o debito, nao o saldo
]);
assert.equal(extrato.passagens[3].hora, '09:27');
assert.equal(extrato.ignorados.length, 2, 'dias de uso e recarga ficam de fora');

// ---- foto lida por OCR
// Print do aplicativo da tag: uma passagem por linha.
assert.deepEqual(
  valoresDoComprovante('14 de julho\nULTRA COLINAS - R$20,30\nPagamento de pedágio\nULTRA AUTOBAN - R$12,80\nPagamento de pedágio'),
  [20.3, 12.8],
);
// Foto com a ida e a volta: um valor por cupom, mesmo com ponto no lugar da virgula.
assert.deepEqual(
  valoresDoComprovante('Cat.Cobr:1 Valor: R$ 6,80 | lixo\nTributos: Vlr Estim. 18,24% (Fonte IBPT)\nValor Pago:R$11.70 F.Pgto: DEBITO\nCAT: 01 TARIFA:R$ 20.30 ENTREGUE: 30.00\nTROCO= 9.70'),
  [6.8, 11.7, 20.3],
);
// Recibo de estacionamento.
assert.deepEqual(valoresDoComprovante('COMPRA DE TICKET\nPlaca: ABC-1D23\nValor: R$ 2,50\nVálido: 10:47'), [2.5]);
// Painel de carro nao tem valor nenhum.
assert.deepEqual(valoresDoComprovante('17 de ago. de 2026 12:20:56\n65578 km/h ODO'), []);

assert.deepEqual(todosOsValores('PedágiosR$ 242,80 Total R$ 1.278,80 e 18,24% de tributos'), [242.8, 1278.8]);

// ---- chave de acesso: 44 digitos com o digito verificador certo
const base = '3526081234567800019065001000012345100012345';
let soma = 0;
let peso = 2;
for (let i = 42; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
const dv = soma % 11 < 2 ? 0 : 11 - (soma % 11);
assert.equal(chaveDeAcesso(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${base}${dv}|2|1|1|ABC`), `${base}${dv}`);
assert.equal(chaveDeAcesso(`${base}${(dv + 1) % 10}`), null, 'digito errado nao passa');

// ---- o parecer
const linhas = [
  { data: '2026-08-03', km_inicial: 1000, km_final: 1100, pedagio: 0, estacionamento: 0 },
  { data: '2026-08-04', km_inicial: 1100, km_final: 1200, pedagio: 0, estacionamento: 0 },
];
const anexo = (id, tipo) => ({ id, tipo, nome_original: `${tipo}-${id}.pdf` });
const doExtrato = { anexo: anexo(1, 'pedagio'), leitura: { passagens: [
  { data: '2026-08-03', hora: '', valor: 11.1, local: 'X', tipo: 'pedagio' },
  { data: '2026-08-04', hora: '', valor: 11.1, local: 'X', tipo: 'pedagio' },
], todos: [11.1] } };
const daFoto = { anexo: anexo(2, 'pedagio'), leitura: { valores: [4.3, 4.3], todos: [4.3] } };

// A soma do que foi lido da o declarado: confirmado, sem achado nenhum.
let r = montarParecer({ lidos: [doExtrato, daFoto], linhas, mesRef: '2026-08', declarado: 30.8 });
assert.equal(r.parecer.pedagio_comprovado, 30.8);
assert.equal(r.achados.length, 0);
assert.equal(r.parecer.por, 'codigo');

// Nao bate: aviso com os dois numeros, e NUNCA erro.
r = montarParecer({ lidos: [doExtrato], linhas, mesRef: '2026-08', declarado: 30.8 });
assert.equal(r.parecer.pedagio_comprovado, null);
assert.equal(r.achados.length, 1);
assert.equal(r.achados[0].gravidade, 'aviso');
assert.equal(r.achados[0].codigo, 'pedagio_nao_confirmado');
assert.match(r.achados[0].mensagem, /30,80.*22,20/);

// Leitura fechada: a soma das passagens e o total impresso no extrato. O lido
// vale como comprovado mesmo sem bater com o declarado (caso da Cristine:
// declarou 272,80, o extrato fecha em 227,80) - quem reprova e a regra da
// diferenca, com o numero certo.
const fechado = { anexo: anexo(8, 'pedagio'), leitura: { ...doExtrato.leitura, todos: [11.1, 22.2] } };
r = montarParecer({ lidos: [fechado], linhas, mesRef: '2026-08', declarado: 30.8 });
assert.equal(r.parecer.pedagio_comprovado, 22.2);
assert.equal(r.parecer.leitura_fechada, true);
assert.equal(r.achados.length, 0, 'sem o amarelo: a diferenca sai em vermelho pela regra');
// Com uma foto junto, a leitura nao fecha: continua so aviso.
r = montarParecer({ lidos: [fechado, { anexo: anexo(9, 'pedagio'), leitura: { valores: [4.3], todos: [4.3] } }], linhas, mesRef: '2026-08', declarado: 30.8 });
assert.equal(r.parecer.pedagio_comprovado, null);
assert.equal(r.achados[0].codigo, 'pedagio_nao_confirmado');

// O documento traz o total declarado escrito: confirmado mesmo sem a soma fechar.
r = montarParecer({
  lidos: [{ anexo: anexo(3, 'pedagio'), leitura: { valores: [278.8, 36], todos: [278.8, 36, 242.8] } }],
  linhas, mesRef: '2026-08', declarado: 242.8,
});
assert.equal(r.parecer.pedagio_comprovado, 242.8);

// Extrato com passagem de sabado, e o declarado e o total impresso (que inclui
// o sabado): o total escrito NAO confirma. Comprovado e so o dia util.
const comSabado = { anexo: anexo(10, 'pedagio'), leitura: { passagens: [
  ...doExtrato.leitura.passagens,
  { data: '2026-08-08', hora: '', valor: 15, local: 'X', tipo: 'pedagio' },
], todos: [11.1, 15, 37.2] } };
r = montarParecer({ lidos: [comSabado], linhas, mesRef: '2026-08', declarado: 37.2 });
assert.equal(r.parecer.pedagio_comprovado, 22.2, 'o sabado nao entra no comprovado');
assert.deepEqual(r.achados.map((a) => a.codigo), ['pedagio_fora_da_soma']);
assert.match(r.achados[0].mensagem, /15,00.*08\/08/);
// Mesmo sem o extrato imprimir o total: declarado = uteis + sabado, reprova igual.
r = montarParecer({ lidos: [{ ...comSabado, leitura: { ...comSabado.leitura, todos: [11.1, 15] } }], linhas, mesRef: '2026-08', declarado: 37.2 });
assert.equal(r.parecer.pedagio_comprovado, 22.2);
// Declarou so os dias uteis: confirmado, sem achado - o sabado no extrato nao incomoda.
r = montarParecer({ lidos: [comSabado], linhas, mesRef: '2026-08', declarado: 22.2 });
assert.equal(r.parecer.pedagio_comprovado, 22.2);
assert.equal(r.achados.length, 0);

// Nota: chave OU mencao a combustivel confirma; nada disso, aviso.
r = montarParecer({ lidos: [{ anexo: anexo(4, 'danfe'), leitura: { chave: '3526...0001', combustivel: false } }], linhas, mesRef: '2026-08', declarado: 0 });
assert.equal(r.parecer.tem_danfe_de_abastecimento, true);
assert.equal(r.achados.length, 0);
r = montarParecer({ lidos: [{ anexo: anexo(5, 'danfe'), leitura: { chave: null, combustivel: false } }], linhas, mesRef: '2026-08', declarado: 0 });
assert.equal(r.parecer.tem_danfe_de_abastecimento, false);
assert.deepEqual(r.achados.map((a) => [a.gravidade, a.codigo, a.anexo_id]), [['aviso', 'danfe_nao_confirmada', 5]]);

// Odometro: conta as fotos em que o km do RDV aparece; nunca gera achado.
r = montarParecer({
  lidos: [
    { anexo: anexo(6, 'odometro'), leitura: { leu: true, numeros: ['1220', '1100'] } },
    { anexo: anexo(7, 'odometro'), leitura: { leu: true, numeros: ['65578'] } },
  ],
  linhas, mesRef: '2026-08', declarado: 0,
});
assert.equal(r.parecer.odometro.fotos_com_km_do_rdv, 1);
assert.equal(r.achados.length, 0);

console.log('OK - comprovantes por codigo: extrato, cupom, nota, odometro e parecer que so confirma ou avisa');
