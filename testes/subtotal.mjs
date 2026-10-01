// O total a receber tem que bater com o "Subtotal das Despesas" do RDV.
//   node testes/subtotal.mjs
import assert from 'node:assert/strict';
import { conferir } from '../src/conferencia.js';
import { interpretarRdv } from '../src/leitura-rdv.js';

const linhas = [
  { data: '2026-09-01', km_inicial: 1000, km_final: 1100, itinerario: 'A - B' },
  { data: '2026-09-02', km_inicial: 1100, km_final: 1300, itinerario: 'B - C' },
];
const anexos = [{ tipo: 'rdv' }, { tipo: 'pedagio' }, { tipo: 'hotel', valor: 150 }];
// 300 km x 0,90 = 270,00 + 50,00 de pedagio + 150,00 de hotel = 470,00
const relatorio = (subtotal) => ({
  mes_ref: '2026-09',
  hotel_declarado: 150,
  outros_declarado: 0,
  extraido: JSON.stringify({
    totais_declarados: { total_km: 300, valor_total_km: 270, pedagio_estacionamento: 50, hotel: 150, outros: 0, subtotal },
  }),
});
const conferirCom = (subtotal) => conferir(relatorio(subtotal), linhas, anexos, 0.9, null, 'DSO', 'Vendedor');

const certo = conferirCom(470);
assert.equal(certo.totalDoMes, 470);
assert.equal(certo.subtotalDoRdv, 470);
assert.ok(!certo.achados.some((a) => a.codigo === 'subtotal_nao_bate'));

const errado = conferirCom(480);
const achado = errado.achados.find((a) => a.codigo === 'subtotal_nao_bate');
assert.equal(achado?.gravidade, 'erro');
assert.match(achado.mensagem, /470,00.*km.*270,00.*50,00.*hotel.*150,00.*Subtotal das Despesas do RDV e R\$\s480,00/);

// Um centavo de diferenca conta.
assert.ok(conferirCom(470.01).achados.some((a) => a.codigo === 'subtotal_nao_bate'));

// Relatorio lido antes de o portal guardar o subtotal: sem numero, sem cobranca.
assert.ok(!conferirCom(null).achados.some((a) => a.codigo === 'subtotal_nao_bate'));
assert.ok(!conferirCom(undefined).achados.some((a) => a.codigo === 'subtotal_nao_bate'));

// A leitura do PDF traz o subtotal do quadro de resumo.
const linha = (y, ...tokens) => ({ pagina: 1, y, tokens: tokens.map(([s, x]) => ({ s, x })) });
const lido = interpretarRdv([
  linha(500, ['KM', 60], ['R$', 80], ['R$', 740], ['270,00', 800]),
  linha(490, ['PEDAGIO', 60], ['+', 110], ['ESTACIONAMENTO', 120], ['R$', 740], ['50,00', 800]),
  linha(480, ['HOTEL', 60], ['R$', 740], ['150,00', 800]),
  linha(470, ['OUTROS', 60], ['R$', 740], ['-', 800]),
  linha(450, ['Subtotal', 270], ['das', 320], ['Despesas', 345], ['R$', 740], ['470,00', 800]),
  linha(430, ['Data', 100], ['Km', 300], ['Inicial', 320], ['Km', 560], ['Final', 580], ['Total', 770], ['KM', 800]),
  linha(420, ['01/09/2026', 100], ['1.000', 320], ['1.100', 580], ['100', 790]),
  linha(410, ['02/09/2026', 100], ['1.100', 320], ['1.300', 580], ['200', 790]),
  linha(400, ['300', 780], ['R$', 870], ['270,00', 900]),
]);
assert.equal(lido.totais_declarados.subtotal, 470);
assert.equal(lido.linhas.length, 2);

console.log('OK - total a receber diferente do Subtotal das Despesas do RDV reprova; igual passa');
