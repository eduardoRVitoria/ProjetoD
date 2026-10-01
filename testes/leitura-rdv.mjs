// Leitura do RDV por codigo, sem IA.
//   node testes/leitura-rdv.mjs
import assert from 'node:assert/strict';
import { interpretarRdv } from '../src/leitura-rdv.js';

// Monta as linhas como o `linhasDoPdf` devolve: "x:texto | x:texto".
const linha = (pagina, y, texto) => ({
  pagina,
  y,
  tokens: texto.split(' | ').flatMap((p) => {
    const [x, ...s] = p.split(':');
    return s.join(':').split(' ').filter(Boolean).map((t) => ({ s: t, x: Number(x) }));
  }),
});

// ---- 1. O formulario normal, numa pagina so.
const normal = interpretarRdv([
  linha(1, 447, '224:Cargo: Vendedor - Nome Completo: FULANO DE TAL'),
  linha(1, 422, '17:KM R$ | 356:R$ | 401:2.750,40'),
  linha(1, 410, '17:PEDAGIO + ESTACIONAMENTO | 356:R$ | 410:249,64'),
  linha(1, 399, '17:HOTEL | 356:R$ | 424:- | 538:Placa do veículo: | 619:ABC1D23'),
  linha(1, 387, '17:OUTROS | 356:R$ | 410:159,00'),
  linha(1, 365, '120:Subtotal das Despesas | 356:R$ | 401:3.159,04'),
  linha(1, 343, '482:0,41 | 637:ASSINATURA POR EXTENSO'),
  linha(1, 330, '46:Data | 134:Km Inicial | 266:Km Final | 379:Total KM | 449:R$ | 512:0,90 | 637:Itinerário de Trabalho'),
  linha(1, 319, '33:03/08/2026 | 141:134.029 | 268:134.110 | 392:81 | 449:R$ | 507:72,90 | 671:JUNDIAI'),
  linha(1, 308, '33:04/08/2026 | 141:134.116 | 268:134.385 | 390:269 | 449:R$ | 503:242,10 | 648:SALTO DE PIRAPORA'),
  linha(1, 296, '33:05/08/2026 | 154:0 | 282:0 | 394:0 | 449:R$ | 516:- | 662:HOME OFFICE'),
  linha(1, 79, '385:350 | 449:R$ | 494:315,00'),
]);
assert.equal(normal.nome_no_relatorio, 'FULANO DE TAL');
assert.equal(normal.placas, 'ABC1D23');
assert.equal(normal.mes_referencia, '2026-08');
assert.deepEqual(normal.linhas[0], {
  data: '2026-08-03', km_inicial: 134029, km_final: 134110, itinerario: 'JUNDIAI',
  pedagio: 0, estacionamento: 0, combustivel: 0,
});
assert.equal(normal.linhas[1].itinerario, 'SALTO DE PIRAPORA');
assert.equal(normal.linhas[2].itinerario, 'HOME OFFICE');
assert.deepEqual(normal.totais_declarados, {
  total_km: 350, taxa_por_km: 0.9, valor_total_km: 2750.4, pedagio_estacionamento: 249.64,
  hotel: 0, outros: 159, outros_descricao: null, subtotal: 3159.04,
});

// ---- 2. Excel em ingles: mes/dia e "1,793.70".
const ingles = interpretarRdv([
  linha(1, 415, '26:KM R$ | 340:R$ | 379:1,793.70'),
  linha(1, 405, '26:PEDAGIO + ESTACIONAMENTO | 340:R$ | 387:527.10'),
  linha(1, 334, '53:Data | 134:Km Inicial | 255:Km Final | 358:Total KM | 423:R$ | 481:0.90 | 596:Itinerário de Trabalho'),
  linha(1, 324, '45:8/3/2026 | 140:111,985 | 257:112,219 | 368:234 | 423:R$ | 473:210.60 | 622:Campinas'),
  linha(1, 314, '45:8/4/2026 | 140:112,221 | 257:112,384 | 368:163 | 423:R$ | 473:146.70 | 622:Campinas'),
  linha(1, 100, '366:397 | 423:R$ | 473:357.30'),
]);
assert.deepEqual(ingles.linhas.map((l) => l.data), ['2026-08-03', '2026-08-04'], 'mes/dia vira dia certo');
assert.equal(ingles.linhas[0].km_inicial, 111985);
assert.equal(ingles.totais_declarados.valor_total_km, 1793.7);
assert.equal(ingles.totais_declarados.pedagio_estacionamento, 527.1);
assert.equal(ingles.totais_declarados.taxa_por_km, 0.9);

// ---- 3. Planilha partida: km na pagina 1, R$ e itinerario na pagina 2,
// formato contabil, e um dia em que so o km inicial foi preenchido.
const partida = interpretarRdv([
  linha(1, 447, '53:KM R$ | 550:(R$ | 630:2.230,20)'),
  linha(1, 432, '53:PEDAGIO + ESTACIONAMENTO | 550:(R$ | 640:297,14)'),
  linha(1, 327, '97:Data | 233:Km Inicial | 425:Km Final | 592:Total KM'),
  linha(1, 312, '83:8/3/2026 | 238:312.128'),
  linha(1, 297, '83:8/4/2026 | 238:312.151 | 426:312.313 | 605:162'),
  linha(1, 282, '83:8/5/2026 | 612:0'),
  linha(1, 100, '612:0'),
  linha(1, 85, '600:2.478'),
  linha(2, 327, '52:(R$ | 138:0,90) | 309:Itinerário de Trabalho'),
  linha(2, 312, '52:(R$ | 144:- | 150:)'),
  linha(2, 297, '52:(R$ | 132:145,80) | 309:Tatuí - Boituva'),
  linha(2, 282, '52:(R$ | 144:- | 150:) | 309:Reunião'),
]);
assert.deepEqual(partida.linhas.map((l) => [l.data, l.km_inicial, l.km_final, l.itinerario]), [
  ['2026-08-03', 312128, 0, ''],
  ['2026-08-04', 312151, 312313, 'Tatuí - Boituva'],
  ['2026-08-05', 0, 0, 'Reunião'],
]);
assert.equal(partida.totais_declarados.total_km, 2478);
assert.equal(partida.totais_declarados.valor_total_km, 2230.2);
assert.equal(partida.totais_declarados.taxa_por_km, 0.9);

// ---- 4. Extrato de pedagio tem datas, mas nao e o formulario: nada sai.
const extrato = interpretarRdv([
  linha(1, 500, '30:Extrato Sem Parar'),
  linha(1, 480, '30:03/08/2026 | 120:08:35 | 200:PEDAGIO CAJATI | 400:R$ | 430:4,30'),
]);
assert.equal(extrato.linhas.length, 0);

console.log('OK - RDV lido por codigo: normal, Excel em ingles, planilha partida e extrato recusado');
