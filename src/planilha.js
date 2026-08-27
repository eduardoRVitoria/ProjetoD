// Gera a planilha de conferencia no mesmo formato da RDVS.xlsx que ja era usada
// na mao: titulo, resumo, legenda, as 10 colunas, dados agrupados por status e
// as tres cores. Segunda aba explicando como a conferencia e feita.

import ExcelJS from 'exceljs';
import { mesPorExtenso } from './util.js';
import { cracha } from './banco.js';

// Na planilha vale o rotulo que a RDVS.xlsx ja usava, nao o rotulo da tela.
const ROTULO_PLANILHA = {
  CERTA: 'CERTA',
  SO_FALTA_DANFE: 'SO FALTA A DANFE',
  ERRADA: 'ERRADA',
};

// Cores padrao de status do Excel - as mesmas da planilha original.
const CORES = {
  CERTA: { fundo: 'FFC6EFCE', texto: 'FF006100' },
  SO_FALTA_DANFE: { fundo: 'FFFFEB9C', texto: 'FF9C6500' },
  ERRADA: { fundo: 'FFFFC7CE', texto: 'FF9C0006' },
};

const ORDEM = ['CERTA', 'SO_FALTA_DANFE', 'ERRADA'];

const COLUNAS = [
  { titulo: 'STATUS', largura: 20 },
  { titulo: 'NOME DO COLABORADOR', largura: 38 },
  { titulo: 'TOTAL DE KM RODADO', largura: 14, formato: '#,##0' },
  { titulo: 'VALOR DO KM (KM x R$ %VLR%)', largura: 16, formato: '"R$" #,##0.00' },
  { titulo: 'PEDAGIO + ESTAC. DECLARADO', largura: 16, formato: '"R$" #,##0.00' },
  { titulo: 'PEDAGIO + ESTAC. COMPROVADO', largura: 16, formato: '"R$" #,##0.00' },
  { titulo: 'DIFERENCA (COMPROVADO - DECLARADO)', largura: 16, formato: '"R$" #,##0.00' },
  { titulo: 'MANDOU A DANFE DE ABASTECIMENTO?', largura: 14 },
  { titulo: 'O QUE FOI ENCONTRADO NA CONFERENCIA', largura: 60 },
  { titulo: 'O QUE O COLABORADOR PRECISA FAZER', largura: 60 },
];

const ETAPAS = [
  ['1. Datas', 'Todo lancamento tem que cair em dia util. Sabado e domingo sao erro. Feriado nacional e o estadual de SP (09/07) sao calculados automaticamente e viram alerta quando ha km lancado.'],
  ['2. KM da linha', 'Km final menos km inicial tem que fechar com o total do dia. Km final menor que o inicial e erro.'],
  ['3. Continuidade do odometro', 'O km inicial de um dia tem que continuar de onde o dia anterior parou. Andar para tras costuma ser segundo veiculo (pedir a placa). Saltar para frente significa km rodado que nao foi lancado.'],
  ['4. Soma dos KM', 'A soma das linhas e comparada com o total declarado. No portal esse total e calculado pelo sistema, entao nao ha mais erro de conta.'],
  ['5. Valor', 'Total de km multiplicado pelo valor por km vigente.'],
  ['6. Itinerario', 'Km lancado sem itinerario e erro. Itinerario preenchido com zero km e alerta.'],
  ['7. Pedagio + estacionamento', 'Soma dos comprovantes anexados (Sem Parar, ConectCar, Tag Itau, Veloe, Ultrapasse, C6 Tag, cupons avulsos) comparada com o valor declarado. Declarar pedagio sem anexar comprovante e erro.'],
  ['   Nao entram na soma', 'Mensalidade do plano, IOF, "dias de uso da tag", negociacao de divida, recarga de saldo, taxa de envio da tag e multa. Sao itens do mesmo extrato, mas nao sao despesa de viagem.'],
  ['8. Abastecimento', 'Verificar se a nota/DANFE foi enviada. NAO soma junto do pedagio. Nome de arquivo nao vale como prova: o conteudo e aberto e conferido.'],
  ['9. Fotos de odometro', 'Foto do painel na segunda de manha e na sexta a noite de cada semana, tiradas dentro do proprio portal. O numero da foto e comparado com o km declarado.'],
  ['10. Itinerario x distancia', 'A distancia declarada precisa fazer sentido para o trajeto informado.'],
];

const REGRAS = [
  ['CERTA (verde)', 'Aprovada. Nada a fazer.'],
  ['SO FALTA A DANFE (amarelo)', 'Reprovou UNICAMENTE por nao ter enviado a nota de abastecimento. KM, totais, valor e pedagio todos conferidos.'],
  ['ERRADA (vermelho)', 'Tem divergencia de KM, pedagio, itinerario ou documento. Quem esta sem DANFE E com outro erro entra aqui, nao no amarelo.'],
  ['Dono do relatorio', 'E sempre a pessoa do relatorio, nunca quem encaminhou. No portal cada um entra com o proprio login, entao isso deixou de ser um problema.'],
  ['Versao que vale', 'Havendo mais de um envio do mesmo mes, vale o mais recente.'],
];

/**
 * Planilha com o historico completo de um colaborador: um mes por linha,
 * mais uma aba com todos os arquivos que ele ja enviou.
 */
export async function gerarHistorico({ usuario, relatorios, anexos, valorKm }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Portal RDV — DISO Comércio de Alimentos';
  wb.created = new Date();

  const ws = wb.addWorksheet('HISTORICO', { views: [{ state: 'frozen', ySplit: 5 }] });

  const colunas = [
    { titulo: 'MES', largura: 20 },
    { titulo: 'STATUS', largura: 20 },
    { titulo: 'TOTAL DE KM', largura: 13, formato: '#,##0' },
    { titulo: 'VALOR DO KM', largura: 15, formato: '"R$" #,##0.00' },
    { titulo: 'PED+ESTAC DECLARADO', largura: 15, formato: '"R$" #,##0.00' },
    { titulo: 'PED+ESTAC COMPROVADO', largura: 15, formato: '"R$" #,##0.00' },
    { titulo: 'DIFERENCA', largura: 14, formato: '"R$" #,##0.00' },
    { titulo: 'MANDOU A DANFE?', largura: 13 },
    { titulo: 'ENVIADO EM', largura: 17 },
    { titulo: 'O QUE FOI ENCONTRADO', largura: 60 },
    { titulo: 'O QUE PRECISA FAZER', largura: 60 },
  ];

  ws.mergeCells(1, 1, 1, colunas.length);
  const titulo = ws.getCell('A1');
  titulo.value = `HISTORICO DE RDV — ${usuario.nome.toUpperCase()}`;
  titulo.font = { bold: true, size: 14, color: { argb: 'FF143A61' } };
  ws.getRow(1).height = 26;

  const contagem = {};
  for (const r of relatorios) contagem[r.status] = (contagem[r.status] || 0) + 1;
  const somaKm = relatorios.reduce((s, r) => s + Number(r.total_km || 0), 0);
  const somaValor = relatorios.reduce((s, r) => s + Number(r.valor_km || 0), 0);

  ws.mergeCells(2, 1, 2, colunas.length);
  ws.getCell('A2').value =
    `${cracha(usuario.empresa, usuario.funcao)} · ${usuario.funcao} · ${usuario.login}` +
    `${usuario.placas ? ` · placas: ${usuario.placas}` : ''}  |  ` +
    `${relatorios.length} mes(es)  |  ${contagem.CERTA || 0} aprovados, ` +
    `${contagem.SO_FALTA_DANFE || 0} so faltou DANFE, ${contagem.ERRADA || 0} reprovados  |  ` +
    `total ${somaKm.toLocaleString('pt-BR')} km`;
  ws.getCell('A2').font = { bold: true, size: 11 };

  ws.mergeCells(3, 1, 3, colunas.length);
  ws.getCell('A3').value = `Gerado em ${new Date().toLocaleString('pt-BR')} · valor do km R$ ${valorKm
    .toFixed(2)
    .replace('.', ',')}`;
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF5B6879' } };

  const cab = ws.getRow(5);
  colunas.forEach((c, i) => {
    const cel = cab.getCell(i + 1);
    cel.value = c.titulo;
    cel.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C4E80' } };
    cel.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    ws.getColumn(i + 1).width = c.largura;
  });
  cab.height = 34;

  let linha = 6;
  for (const r of [...relatorios].sort((a, b) => b.mes_ref.localeCompare(a.mes_ref))) {
    const declarado = Number(r.pedagio_declarado || 0) + Number(r.estac_declarado || 0);
    const comp = r.pedagio_comprovado;
    const cor = CORES[r.status];

    const valores = [
      mesPorExtenso(r.mes_ref),
      ROTULO_PLANILHA[r.status] || r.status,
      Number(r.total_km || 0),
      Number(r.valor_km || 0),
      declarado,
      comp == null ? null : Number(comp),
      comp == null ? null : Number((comp - declarado).toFixed(2)),
      r.mandou_danfe == null ? '' : r.mandou_danfe ? 'SIM' : 'NAO',
      r.enviado_em ? new Date(r.enviado_em).toLocaleString('pt-BR') : '',
      (r.achados || []).map((a) => a.mensagem).join(' | '),
      r.o_que_fazer || '',
    ];

    const l = ws.getRow(linha);
    valores.forEach((v, i) => {
      const cel = l.getCell(i + 1);
      cel.value = v;
      if (colunas[i].formato) cel.numFmt = colunas[i].formato;
      cel.alignment = { vertical: 'top', wrapText: i >= 9 };
      cel.border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE7' } } };
    });

    if (cor) {
      for (const col of [1, 2]) {
        l.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cor.fundo } };
        l.getCell(col).font = { bold: col === 2, color: { argb: cor.texto } };
      }
    }
    linha++;
  }

  if (linha > 6) {
    ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: linha - 1, column: colunas.length } };
  }

  // ------------------------------------------------------- aba de arquivos
  const wsA = wb.addWorksheet('ARQUIVOS ENVIADOS');
  const colA = [
    { t: 'MES', w: 20 },
    { t: 'TIPO', w: 26 },
    { t: 'ARQUIVO', w: 60 },
    { t: 'TAMANHO', w: 12 },
    { t: 'ENVIADO EM', w: 20 },
  ];
  const cabA = wsA.getRow(1);
  colA.forEach((c, i) => {
    const cel = cabA.getCell(i + 1);
    cel.value = c.t;
    cel.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C4E80' } };
    wsA.getColumn(i + 1).width = c.w;
  });

  const ROTULO_TIPO = {
    rdv: 'Relatorio (RDV)',
    odometro: 'Foto de odometro',
    pedagio: 'Pedagio / estacionamento',
    danfe: 'Nota de abastecimento',
    outro: 'Outro documento',
  };

  let la = 2;
  for (const a of anexos) {
    const l = wsA.getRow(la++);
    l.getCell(1).value = mesPorExtenso(a.mes_ref);
    l.getCell(2).value = ROTULO_TIPO[a.tipo] || a.tipo;
    l.getCell(3).value = a.nome_original;
    l.getCell(4).value = `${(a.tamanho / 1024).toFixed(0)} KB`;
    l.getCell(5).value = a.enviado_em ? new Date(a.enviado_em).toLocaleString('pt-BR') : '';
  }
  if (la > 2) {
    wsA.autoFilter = { from: { row: 1, column: 1 }, to: { row: la - 1, column: colA.length } };
    wsA.views = [{ state: 'frozen', ySplit: 1 }];
  }

  return wb.xlsx.writeBuffer();
}

export async function gerarPlanilha({ mes, relatorios, valorKm }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Portal RDV — DISO Comércio de Alimentos';
  wb.created = new Date();

  // Uma aba por empresa. So entra empresa que tem gente no mes - nao adianta
  // abrir uma aba DSO vazia.
  const empresas = [...new Set(relatorios.map((r) => r.empresa || 'DISO'))].sort();

  for (const empresa of empresas) {
    montarAba(
      wb,
      mes,
      relatorios.filter((r) => (r.empresa || 'DISO') === empresa),
      valorKm,
      empresas.length > 1 ? empresa : null,
    );
  }

  montarAbaDeRegras(wb, valorKm);
  return wb.xlsx.writeBuffer();
}

function montarAba(wb, mes, relatorios, valorKm, empresa) {
  const extenso = mesPorExtenso(mes).toUpperCase();
  const nomeAba = (empresa ? `${empresa} - ${extenso}` : `CONFERENCIA ${extenso}`).slice(0, 31);
  const ws = wb.addWorksheet(nomeAba, {
    views: [{ state: 'frozen', ySplit: 5 }],
  });

  // ------------------------------------------------------------ 1. titulo
  ws.mergeCells(1, 1, 1, COLUNAS.length);
  const titulo = ws.getCell('A1');
  titulo.value =
    `CONFERENCIA DOS RELATORIOS DE DESPESAS DE VIAGEM (RDV) - ${extenso}` +
    (empresa ? ` - ${empresa}` : '');
  titulo.font = { bold: true, size: 14, color: { argb: 'FF143A61' } };
  titulo.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 26;

  // ------------------------------------------------------------ 2. resumo
  const contagem = {};
  for (const r of relatorios) contagem[r.status] = (contagem[r.status] || 0) + 1;

  ws.mergeCells(2, 1, 2, COLUNAS.length);
  const resumo = ws.getCell('A2');
  resumo.value =
    `Conferido em ${new Date().toLocaleDateString('pt-BR')}  |  ${relatorios.length} relatorios  |  ` +
    `${contagem.CERTA || 0} CERTAS  -  ${contagem.SO_FALTA_DANFE || 0} SO FALTAM A DANFE  -  ` +
    `${contagem.ERRADA || 0} ERRADAS  |  Criterio do KM: total de KM x R$ ${valorKm
      .toFixed(2)
      .replace('.', ',')}`;
  resumo.font = { bold: true, size: 11 };

  // ----------------------------------------------------------- 3. legenda
  const legenda = ws.getRow(3);
  legenda.getCell(1).value = 'LEGENDA:';
  legenda.getCell(1).font = { bold: true, size: 10 };
  const textos = [
    [2, 'VERDE = aprovada, nada a fazer', 'CERTA'],
    [4, 'AMARELO = so falta a nota/DANFE de abastecimento; todo o resto conferiu', 'SO_FALTA_DANFE'],
    [7, 'VERMELHO = tem divergencia de KM, pedagio, itinerario ou documento', 'ERRADA'],
  ];
  for (const [col, texto, status] of textos) {
    const c = legenda.getCell(col);
    c.value = texto;
    c.font = { size: 10, color: { argb: CORES[status].texto } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CORES[status].fundo } };
  }

  // --------------------------------------------------------- 5. cabecalho
  const cab = ws.getRow(5);
  COLUNAS.forEach((c, i) => {
    const cel = cab.getCell(i + 1);
    cel.value = c.titulo.replace('%VLR%', valorKm.toFixed(2).replace('.', ','));
    cel.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C4E80' } };
    cel.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    cel.border = { bottom: { style: 'thin', color: { argb: 'FF143A61' } } };
    ws.getColumn(i + 1).width = c.largura;
  });
  cab.height = 42;

  // ------------------------------------------------------------- 6. dados
  let linha = 6;
  for (const status of ORDEM) {
    const doGrupo = relatorios
      .filter((r) => r.status === status)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    for (const r of doGrupo) {
      const declarado = Number(r.pedagio_declarado || 0) + Number(r.estac_declarado || 0);
      const comprovado = r.pedagio_comprovado;
      const cor = CORES[status];

      const valores = [
        ROTULO_PLANILHA[status],
        r.nome,
        Number(r.total_km || 0),
        Number(r.valor_km || 0),
        declarado,
        comprovado == null ? null : Number(comprovado),
        comprovado == null ? null : Number((comprovado - declarado).toFixed(2)),
        r.mandou_danfe == null ? (r.tem_danfe_por_anexo ? 'SIM' : 'NAO') : r.mandou_danfe ? 'SIM' : 'NAO',
        (r.achados || []).map((a) => a.mensagem).join(' | ') || (status === 'CERTA' ? 'Tudo conferido' : ''),
        r.o_que_fazer || (status === 'CERTA' ? 'Nada. Relatorio aprovado.' : ''),
      ];

      const l = ws.getRow(linha);
      valores.forEach((v, i) => {
        const cel = l.getCell(i + 1);
        cel.value = v;
        if (COLUNAS[i].formato) cel.numFmt = COLUNAS[i].formato;
        cel.alignment = { vertical: 'top', wrapText: i >= 8 };
        cel.border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE7' } } };
      });

      // Cor no status e no nome, como na planilha original.
      for (const col of [1, 2]) {
        const cel = l.getCell(col);
        cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cor.fundo } };
        cel.font = { bold: col === 1, color: { argb: cor.texto } };
      }

      // Diferenca de pedagio em vermelho quando nao fecha.
      if (comprovado != null && Math.abs(comprovado - declarado) > 0.01) {
        l.getCell(7).font = { bold: true, color: { argb: 'FF9C0006' } };
      }

      linha++;
    }
  }

  if (linha > 6) {
    ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: linha - 1, column: COLUNAS.length } };
  }
}

// ------------------------------------------------------ aba de explicacao
function montarAbaDeRegras(wb, valorKm) {
  const wsRegras = wb.addWorksheet('COMO E CONFERIDO');
  wsRegras.getColumn(1).width = 32;
  wsRegras.getColumn(2).width = 110;

  let lr = 1;
  const secao = (texto) => {
    wsRegras.mergeCells(lr, 1, lr, 2);
    const c = wsRegras.getCell(lr, 1);
    c.value = texto;
    c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C4E80' } };
    wsRegras.getRow(lr).height = 22;
    lr += 1;
  };
  const item = ([a, b]) => {
    const r = wsRegras.getRow(lr);
    r.getCell(1).value = a;
    r.getCell(1).font = { bold: true, size: 10 };
    r.getCell(1).alignment = { vertical: 'top', wrapText: true };
    r.getCell(2).value = b;
    r.getCell(2).alignment = { vertical: 'top', wrapText: true };
    lr += 1;
  };

  secao('AS ETAPAS DA CONFERENCIA');
  ETAPAS.forEach(item);
  lr += 1;
  secao('REGRAS DE CLASSIFICACAO');
  REGRAS.forEach(item);
  lr += 1;
  secao('OBSERVACAO');
  item([
    'De onde vem esta planilha',
    'Gerada pelo Portal RDV. Os colaboradores preenchem o relatorio e anexam os comprovantes pelo proprio celular; ' +
      'as etapas 1 a 6 sao conferidas automaticamente no momento do preenchimento, e as etapas 7 a 10 pela leitura ' +
      'dos comprovantes. Esta aba existe para a planilha se explicar sozinha para quem nao acompanhou o processo.',
  ]);
  item([
    'Valor do km vigente',
    `R$ ${valorKm.toFixed(2).replace('.', ',')} por quilometro rodado.`,
  ]);
  item([
    'Aumento sobre o mes anterior',
    'Quando o mes fica mais de R$ 200,00 acima do mes anterior, o colaborador precisa escrever ' +
      'a justificativa antes de enviar. A justificativa aparece na coluna "O QUE FOI ENCONTRADO".',
  ]);
}
