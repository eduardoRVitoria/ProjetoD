// PDF do RDV sem nada que possa ser assinatura: o codigo reconhece sozinho.
//   node testes/assinatura-a-mao.mjs
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pdfSemMarcaDeAssinatura } from '../src/assinatura.js';

// O formulario como sai do Excel: texto e linhas retas de tabela.
async function formulario(extra = () => {}) {
  const pdf = await PDFDocument.create();
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const pagina = pdf.addPage([842, 595]);
  for (let i = 0; i < 20; i++) {
    pagina.drawText(`0${(i % 9) + 1}/09/2026  61.350  61.528  178  Itapetininga/ Cerquilho/ Tatui`, { x: 40, y: 500 - i * 18, size: 9, font: fonte });
    pagina.drawLine({ start: { x: 40, y: 496 - i * 18 }, end: { x: 800, y: 496 - i * 18 } });
  }
  pagina.drawText('ASSINATURA POR EXTENSO', { x: 620, y: 80, size: 9, font: fonte });
  pagina.drawRectangle({ x: 560, y: 95, width: 240, height: 40, borderWidth: 1 });
  extra(pagina);
  return Buffer.from(await pdf.save());
}

assert.equal(await pdfSemMarcaDeAssinatura(await formulario()), true, 'formulario em branco: ninguem assinou');

// Assinatura desenhada por cima vira risco curvo: ja nao da para afirmar.
const rabiscado = await formulario((p) => p.drawSvgPath('M 0 0 C 20 -30 40 30 60 0 S 100 -30 120 0', { x: 600, y: 120, borderWidth: 1 }));
assert.equal(await pdfSemMarcaDeAssinatura(rabiscado), false);

// Papel escaneado nao tem texto: a assinatura pode estar na imagem.
const semTexto = await PDFDocument.create();
semTexto.addPage([595, 842]);
assert.equal(await pdfSemMarcaDeAssinatura(Buffer.from(await semTexto.save())), false);

// Arquivo que nem abre nao acusa ninguem.
assert.equal(await pdfSemMarcaDeAssinatura(Buffer.from('nao sou um pdf')), false);

console.log('OK - PDF limpo e reconhecido como sem assinatura; rabisco, escaneado e arquivo ruim nao');
