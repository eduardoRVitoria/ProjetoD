// Comparativo DSO: mes novo na planilha, sem estragar o que ja estava la.
//   node testes/comparativo.mjs
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { previaDoComparativo, gerarComparativo, traduzir, ajustarAoInserir } from '../src/comparativo.js';

assert.equal(traduzir('T2-R2', 2, 0), 'V2-T2');
assert.equal(traduzir('T$1', 2, 0), 'V$1');
assert.equal(traduzir('SUM(T5:T9)', 2, 0), 'SUM(V5:V9)');
assert.equal(traduzir('SUM(#REF!,#REF!)', 2, 0), 'SUM(#REF!,#REF!)');
assert.equal(traduzir('[1]DESLIGADOS!G13', 2, 0), '[1]DESLIGADOS!G13');
assert.equal(ajustarAoInserir('SUM(T5:T9)', 10), 'SUM(T5:T10)', 'linha nova no fim do grupo entra na soma');
assert.equal(ajustarAoInserir('SUM(T5:T9)', 7), 'SUM(T5:T10)');
assert.equal(ajustarAoInserir('SUM(T5:T9)', 20), 'SUM(T5:T9)');
assert.equal(ajustarAoInserir('T33+T20', 21), 'T34+T20');

// Planilha de mentira, no formato da de verdade. A real tem nome de gente e nao
// entra no repositorio, que e publico.
async function planilha() {
  const wb = new ExcelJS.Workbook();
  const comp = wb.addWorksheet('COMP PARA O DP');
  comp.addRow(['Nome:', new Date(Date.UTC(2026, 7, 1)), 'AGOSTO X SETEMBRO', new Date(Date.UTC(2026, 8, 1))]);
  comp.addRow(['Bruna Lira', 100, { formula: 'D2-B2' }, 150]);
  comp.addRow(['Zeca Souza', 200, { formula: 'D3-B3' }, 180]);
  comp.addRow(['Ana Prado', 50, { formula: 'D4-B4' }, 60]);
  comp.addRow(['TOTAL DSO', { formula: 'SUM(B2:B4)' }, { formula: 'SUM(C2:C4)' }, { formula: 'SUM(D2:D4)' }]);

  const dso = wb.addWorksheet('DSO 2026');
  dso.addRow(['Nome:', new Date(Date.UTC(2026, 7, 1)), 'AGOSTO X SETEMBRO', new Date(Date.UTC(2026, 8, 1))]);
  dso.addRow(['Bruna Lira', 100, { formula: 'D2-B2' }, 150]);
  dso.addRow(['Zeca Souza', 200, { formula: 'D3-B3' }, 180]);
  dso.addRow(['TOTAL TOP:', { formula: 'SUM(B2:B3)' }, { formula: 'SUM(C2:C3)' }, { formula: 'SUM(D2:D3)' }]);
  dso.addRow(['BEBIDAS', { formula: 'B$1' }, null, { formula: 'D$1' }]);
  dso.addRow(['Ana Prado', 50, { formula: 'D6-B6' }, 60]);
  dso.addRow(['TOTAL BEBIDAS', { formula: 'SUM(B6:B6)' }, { formula: 'SUM(C6:C6)' }, { formula: 'SUM(D6:D6)' }]);
  dso.addRow(['TOTAL', { formula: 'B7+B4' }, { formula: 'C7+C4' }, { formula: 'D7+D4' }]);

  const just = wb.addWorksheet('JUSTIFICATIVAS');
  just.addRow(['MÊS', 'AREA', 'CARGO', 'NOME', 'MOTIVO']);
  just.addRow([new Date(Date.UTC(2026, 8, 1)), null, null, 'Bruna Lira', 'Mais visitas']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const pessoa = (id, nome, status, total, extra = {}) => ({
  id, nome, status, total, empresa: 'DSO', funcao: 'Vendedor', ativo: 1, ...extra,
});
const pessoas = [
  pessoa(1, 'Bruna Tavares Lira', 'CERTA', 170.5), // subiu, nome com um a mais
  pessoa(2, 'Zeca de Souza', 'ERRADA', 999), // nao aprovado: nao entra sozinho
  pessoa(3, 'Ana Prado', 'CERTA', 40), // caiu
  pessoa(4, 'Carlos Novo', 'CERTA', 300), // fora da planilha
  pessoa(5, 'Ana Prado', 'CERTA', 77, { empresa: 'DISO' }), // homonimo de outra empresa
];

const base = await planilha();

// Previa
const p = await previaDoComparativo(base, '2026-10', pessoas, {});
assert.equal(p.coluna_ja_existe, false);
assert.equal(p.itens.find((i) => i.usuario_id === 1).valor, 170.5);
assert.equal(p.itens.find((i) => i.usuario_id === 2).valor, null, 'ERRADA nao entra sozinha');
assert.equal(p.itens.find((i) => i.usuario_id === 2).situacao, 'pendente');
assert.equal(p.itens.find((i) => i.nome === 'Ana Prado').usuario_id, 3, 'DSO primeiro, nao o homonimo');
assert.deepEqual(p.novos.map((n) => n.usuario_id), [4]);
assert.ok(p.grupos.includes('TOTAL TOP:'));

// Pular mes e recusado
await assert.rejects(previaDoComparativo(base, '2026-11', pessoas, {}), /vai ate 2026-09/);

// Gravar
const { arquivo, resumo } = await gerarComparativo(base, '2026-10', pessoas, {
  valores: { 'u:2': 123.45 },
  novos: { 4: { grupo: 'TOTAL TOP:' } },
});
assert.equal(resumo.lancados, 3);
assert.equal(resumo.novos, 1);

const zip = await JSZip.loadAsync(arquivo);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(arquivo);

const comp = wb.getWorksheet('COMP PARA O DP');
assert.equal(comp.getCell('E1').value, 'SETEMBRO X OUTUBRO');
assert.equal(comp.getCell('F1').value.toISOString().slice(0, 10), '2026-10-01');
// Ordem alfabetica, com a formula acompanhando a linha nova de cada um.
assert.deepEqual([2, 3, 4, 5].map((n) => comp.getCell(`A${n}`).value), ['Ana Prado', 'Bruna Lira', 'Carlos Novo', 'Zeca Souza']);
assert.equal(comp.getCell('F2').value, 40);
assert.equal(comp.getCell('E2').formula, 'F2-D2');
assert.equal(comp.getCell('D2').value, 60, 'historico acompanha a pessoa');
assert.equal(comp.getCell('F5').value, 123.45, 'valor digitado vale');
assert.equal(comp.getCell('F4').value, 300);
assert.equal(comp.getCell('F6').formula, 'SUM(F2:F5)');

const dso = wb.getWorksheet('DSO 2026');
assert.equal(dso.getCell('F2').value, 170.5);
assert.equal(dso.getCell('A4').value, 'Carlos Novo', 'entra no fim do grupo escolhido');
assert.equal(dso.getCell('F5').formula, 'SUM(F2:F4)');
assert.equal(dso.getCell('F6').formula, 'F$1');
assert.equal(dso.getCell('F7').value, 40);
assert.equal(dso.getCell('F9').formula, 'F8+F5', 'total geral segue os totais que andaram');

const just = wb.getWorksheet('JUSTIFICATIVAS');
const nomes = [];
just.eachRow((r, n) => { if (n > 2) nomes.push(r.getCell(4).value); });
assert.deepEqual(nomes.sort(), ['Bruna Lira', 'Carlos Novo'], 'so quem aumentou; quem caiu fica fora');

assert.equal(zip.file('xl/calcChain.xml'), null);
assert.match(await zip.file('xl/workbook.xml').async('string'), /fullCalcOnLoad="1"/);

// Rodar de novo no mesmo mes nao sobrescreve nem duplica.
const denovo = await gerarComparativo(arquivo, '2026-10', [
  { ...pessoas[0], total: 5000 }, ...pessoas.slice(1),
], {});
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(denovo.arquivo);
assert.equal(wb2.getWorksheet('DSO 2026').getCell('F2').value, 170.5, 'valor ja gravado fica');
assert.equal(wb2.getWorksheet('DSO 2026').getCell('G1').value, null, 'nao cria coluna de novo');
assert.equal(wb2.getWorksheet('JUSTIFICATIVAS').rowCount, 4, 'nao repete justificativa');

console.log('ok: comparativo');
