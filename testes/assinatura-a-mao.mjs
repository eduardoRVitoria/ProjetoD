// A caixa de assinatura do RDV: em branco reprova, com assinatura passa.
//   node testes/assinatura-a-mao.mjs
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { assinaturaNoPdf, regiaoDaCaixa, tintaNoRecorte } from '../src/caixa-assinatura.js';

// O formulario como sai do Excel: a linha da placa, a caixa com moldura de
// canto arredondado e linhas pontilhadas por dentro, e o rotulo embaixo.
async function formulario(extra = () => {}) {
  const pdf = await PDFDocument.create();
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const pagina = pdf.addPage([842, 595]);
  for (let i = 0; i < 12; i++) {
    pagina.drawText(`0${(i % 9) + 1}/09/2026  61.350  61.528  178  Itapetininga/ Tatui`, { x: 40, y: 320 - i * 18, size: 9, font: fonte });
  }
  pagina.drawText('Placa do veiculo: TMC5G71', { x: 521, y: 399, size: 8, font: fonte });
  // moldura da caixa, com canto arredondado (risco curvo), e duas linhas finas
  pagina.drawSvgPath('M 6 0 L 290 0 Q 296 0 296 6 L 296 38 Q 296 44 290 44 L 6 44 Q 0 44 0 38 L 0 6 Q 0 0 6 0 Z',
    { x: 523, y: 396, borderWidth: 1.2, borderColor: rgb(0.1, 0.2, 0.35) });
  pagina.drawLine({ start: { x: 523, y: 381 }, end: { x: 819, y: 381 }, thickness: 0.5, color: rgb(0.2, 0.2, 0.2), dashArray: [1, 1] });
  pagina.drawLine({ start: { x: 523, y: 367 }, end: { x: 819, y: 367 }, thickness: 0.5, color: rgb(0.2, 0.2, 0.2), dashArray: [1, 1] });
  pagina.drawText('ASSINATURA POR EXTENSO', { x: 619, y: 345, size: 8, font: fonte, color: rgb(1, 0, 0) });
  extra(pagina, fonte);
  return Buffer.from(await pdf.save());
}

// Em branco: so a moldura e as linhas da tabela. Era o furo - a moldura
// arredondada fazia o portal achar que "podia ter" assinatura.
const emBranco = await assinaturaNoPdf(await formulario());
assert.equal(emBranco.caixa, 'vazia', `tinta: ${emBranco.tinta}`);
assert.equal(emBranco.selo, false);

// Assinatura desenhada por cima do arquivo, dentro da caixa.
const assinado = await assinaturaNoPdf(await formulario((p) => p.drawSvgPath(
  'M 0 0 C 20 -30 40 30 60 0 S 100 -30 120 0 S 150 25 170 -5 L 150 -22 L 190 8',
  { x: 590, y: 372, borderWidth: 1.6, borderColor: rgb(0, 0, 0.5) },
)));
assert.equal(assinado.caixa, 'com_tinta', `tinta: ${assinado.tinta}`);

// Marca fora da caixa (um carimbo no rodape) nao conta como assinatura.
const carimboNoRodape = await assinaturaNoPdf(await formulario((p) => p.drawRectangle({ x: 650, y: 30, width: 120, height: 30, color: rgb(0, 0, 0) })));
assert.equal(carimboNoRodape.caixa, 'vazia');

// Papel escaneado nao tem texto: o codigo nao acha a caixa e nao opina.
const semTexto = await PDFDocument.create();
semTexto.addPage([595, 842]);
assert.equal((await assinaturaNoPdf(Buffer.from(await semTexto.save()))).caixa, null);
assert.equal((await assinaturaNoPdf(Buffer.from('nao sou um pdf'))).caixa, null);

// A regiao sai das posicoes medidas num RDV de verdade.
const regiao = regiaoDaCaixa([
  { s: 'Placa do veículo: TMC5G71', x: 521, y: 399, l: 97, a: 6 },
  { s: 'ASSINATURA POR EXTENSO', x: 619, y: 345, l: 105, a: 7 },
], 842);
assert.ok(regiao.x1 > 521 && regiao.x2 < 822 && regiao.y1 > 352 && regiao.y2 < 399, JSON.stringify(regiao));
assert.equal(regiaoDaCaixa([{ s: 'Itinerário', x: 10, y: 10, l: 40, a: 7 }], 842), null);

// Linha fina de tabela nao e tinta; um bloco com corpo e.
const recorte = (pintar) => {
  const width = 60, height = 30, data = new Uint8ClampedArray(width * height * 4).fill(255);
  pintar((x, y) => { const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; });
  return { data, width, height };
};
assert.equal(tintaNoRecorte(recorte((p) => { for (let x = 0; x < 60; x++) p(x, 10); })), 0, 'linha horizontal');
assert.equal(tintaNoRecorte(recorte((p) => { for (let y = 0; y < 30; y++) p(20, y); })), 0, 'divisoria vertical');
assert.ok(tintaNoRecorte(recorte((p) => { for (let x = 10; x < 30; x++) for (let y = 8; y < 20; y++) p(x, y); })) > 100, 'bloco com corpo');

console.log('OK - caixa de assinatura em branco e reconhecida; assinatura desenhada conta; escaneado fica sem resposta');
