// Le o PDF (ou foto/planilha) do RDV e transforma a tabela em linhas
// estruturadas - as mesmas que o motor de conferencia em conferencia.js espera.
//
// A ideia: o colaborador nao digita nada, so anexa o relatorio que ja produz
// hoje. A extracao devolve tambem os TOTAIS QUE ELE DECLAROU no documento, para
// a conferencia poder comparar com a soma correta das linhas - que e como o
// erro de conta e pego, ja que agora ele nao e mais evitado na origem.

import Anthropic from '@anthropic-ai/sdk';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { chaveDaApi, lerConfig, PASTA_ANEXOS } from './banco.js';

const LIMITE_POR_ANEXO = 12 * 1024 * 1024;

const IMAGENS = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Planilha nao vai como anexo: a API le imagem e PDF, e um .xlsx e um ZIP de
// XMLs - os bytes dele nao dizem nada para o modelo. Entao a planilha vira
// TEXTO aqui no servidor, e o modelo transcreve esse texto como faria com o PDF.
// O .xls e o binario velho do Excel 97-2003, que o exceljs nao abre - esse vai
// pelo SheetJS. Vale lembrar que muito sistema legado (extrato de tag de
// pedagio, por exemplo) exporta uma tabela HTML com o nome trocado para .xls;
// o SheetJS reconhece esse caso sozinho, entao ele entra aqui do mesmo jeito.
const PLANILHAS = new Set(['.xlsx', '.xlsm', '.xls']);
const TEXTO = new Set(['.csv', '.txt']);

/**
 * Data no formato brasileiro, que e o que as INSTRUCOES mandam o modelo ler.
 *
 * Em UTC de proposito: tanto o exceljs quanto o SheetJS entregam a data da
 * planilha como meia-noite UTC. Lendo com getDate() (que e local), no Brasil
 * isso volta para as 21h do dia ANTERIOR e a data sai um dia atrasada - o que
 * bagunca justamente a checagem de fim de semana e feriado.
 */
function dataEmTexto(v) {
  return `${String(v.getUTCDate()).padStart(2, '0')}/${
    String(v.getUTCMonth() + 1).padStart(2, '0')}/${v.getUTCFullYear()}`;
}

/** Formata uma celula do jeito que ela aparece para quem abre a planilha. */
function celulaEmTexto(celula) {
  const v = celula?.value;
  if (v == null) return '';
  if (v instanceof Date) return dataEmTexto(v);
  // Formula: o que importa e o resultado, nao a formula em si.
  if (typeof v === 'object') {
    if (v.result != null) return celulaEmTexto({ value: v.result });
    if (v.text != null) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
    if (v.hyperlink && v.text) return String(v.text);
    return '';
  }
  return String(v);
}

/**
 * A celula crua do SheetJS virando texto.
 *
 * Usa o valor (`v`), nunca o texto formatado (`w`): o `w` de uma data vem no
 * formato americano ("8/3/26"), e as INSTRUCOES dizem ao modelo que data e
 * dd/mm/aaaa - ele leria 8 de marco onde esta 3 de agosto.
 */
function celulaAntigaEmTexto(c) {
  if (!c) return '';
  if (c.v instanceof Date) return dataEmTexto(c.v);
  return c.v == null ? '' : String(c.v);
}

/** Monta a linha "12: a | b | c", sem as celulas vazias do fim. */
function linhaEmTexto(n, celulas) {
  while (celulas.length && celulas[celulas.length - 1] === '') celulas.pop();
  return celulas.some((c) => c !== '') ? `${n}: ${celulas.join(' | ')}` : null;
}

/**
 * Le a planilha e devolve as celulas como texto separado por " | ", uma linha
 * por linha. Mantem o numero da linha para o modelo nao se perder em tabela
 * grande, e pula as linhas totalmente vazias.
 *
 * O `ext` vem do nome_original, nao do caminho salvo: e ele que decide qual
 * leitor abre o arquivo.
 */
export async function planilhaEmTexto(caminho, ext) {
  if (ext === '.xls') return xlsAntigoEmTexto(caminho);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(caminho);

  const partes = [];
  wb.eachSheet((ws) => {
    const linhas = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const celulas = [];
      row.eachCell({ includeEmpty: true }, (c) => celulas.push(celulaEmTexto(c)));
      const linha = linhaEmTexto(n, celulas);
      if (linha) linhas.push(linha);
    });
    if (linhas.length) partes.push(`--- aba "${ws.name}" ---\n${linhas.join('\n')}`);
  });

  return partes.join('\n\n');
}

/**
 * Mesma coisa para o .xls do Excel 97-2003, que o exceljs nao abre. O SheetJS
 * fareja o formato pelos bytes, entao isso aqui tambem cobre o arquivo que na
 * verdade e uma tabela HTML (ou um CSV) com a extensao trocada para .xls -
 * coisa que sistema de pedagio e de posto faz o tempo todo.
 */
function xlsAntigoEmTexto(caminho) {
  // raw: o SheetJS senao "adivinha" o texto das celulas de tabela HTML e erra
  // no padrao brasileiro - vira 03/08/2026 em 8 de marco, e "12,50" em 1250.
  // Com raw a string fica como esta no arquivo; a data de celula de data de
  // verdade continua vindo como Date, que e o que o cellDates garante.
  const wb = XLSX.read(fs.readFileSync(caminho), {
    type: 'buffer',
    cellDates: true,
    raw: true,
  });

  const partes = [];
  for (const nome of wb.SheetNames) {
    const ws = wb.Sheets[nome];
    if (!ws) continue;

    // O "!ref" as vezes vem inflado ("A1:IV65536") e varrer tudo aquilo trava o
    // servidor. O que vale e ate onde existe celula de verdade.
    let ultimaLinha = -1;
    let ultimaColuna = -1;
    for (const chave of Object.keys(ws)) {
      if (chave.startsWith('!')) continue;
      const { r, c } = XLSX.utils.decode_cell(chave);
      if (r > ultimaLinha) ultimaLinha = r;
      if (c > ultimaColuna) ultimaColuna = c;
    }

    const linhas = [];
    for (let r = 0; r <= ultimaLinha; r++) {
      const celulas = [];
      for (let c = 0; c <= ultimaColuna; c++) {
        celulas.push(celulaAntigaEmTexto(ws[XLSX.utils.encode_cell({ r, c })]));
      }
      const linha = linhaEmTexto(r + 1, celulas);
      if (linha) linhas.push(linha);
    }
    if (linhas.length) partes.push(`--- aba "${nome}" ---\n${linhas.join('\n')}`);
  }

  return partes.join('\n\n');
}

const INSTRUCOES = `Voce le Relatorios de Despesas de Viagem (RDV) da DISO Comercio de Alimentos
e transcreve o conteudo para dados estruturados. Voce NAO julga o relatorio nesta
etapa - so transcreve fielmente o que esta escrito no documento.

REGRAS DE TRANSCRICAO

1. Uma entrada em "linhas" para cada dia que aparece preenchido na tabela.
   Pule as linhas totalmente em branco.

2. Datas sempre em AAAA-MM-DD. O documento usa dd/mm/aaaa ou dd/mm.
   Quando o ano nao aparecer, use o ano do mes de referencia do relatorio.

3. Numeros: o documento e brasileiro. "1.234,56" e mil duzentos e trinta e quatro
   e cinquenta e seis centavos - devolva 1234.56. Nunca troque ponto por virgula
   ao contrario.

4. Km inicial e km final sao a leitura do odometro. Se a planilha so trouxer o
   total de km do dia e nao os dois valores, coloque km_inicial = 0 e
   km_final = o total do dia, e registre isso em problemas_de_leitura.

5. Itinerario: copie o texto como esta. Se estiver vazio, devolva string vazia -
   nao invente trajeto, nao deduza a partir da quilometragem.

6. Pedagio e estacionamento POR DIA: a maioria dos formularios NAO tem essas
   colunas por dia - traz so um valor agregado no quadro de resumo. Quando nao
   houver coluna por dia, deixe pedagio e estacionamento em 0 em todas as linhas
   e registre o total no campo agregado (item 7). Isso e o normal, nao e erro:
   nao precisa avisar em problemas_de_leitura.

7. TOTAIS DECLARADOS: transcreva os totais que o PROPRIO DOCUMENTO apresenta,
   normalmente num quadro destacado ao lado ou no rodape. Nao some voce mesmo:
   queremos saber o que a PESSOA declarou, justamente para comparar depois com a
   soma correta. Devolva null no campo que o documento nao trouxer.

   ATENCAO A ESTES DOIS, QUE SE CONFUNDEM:
   - taxa_por_km: o valor pago POR QUILOMETRO. E um numero pequeno, tipicamente
     0,90. Costuma aparecer no cabecalho da coluna.
   - valor_total_km: o valor EM REAIS a receber pelos quilometros rodados, ou
     seja, total de km vezes a taxa. E um numero grande, na casa dos milhares.
     Se o quadro mostrar "TOTAL KM 3.339" e "R$ 3.005,10", entao total_km e 3339
     e valor_total_km e 3005.10 - nunca 0,90.

   - pedagio_estacionamento: o total de pedagio mais estacionamento. Muitos
     formularios trazem os dois somados numa linha so ("PEDAGIO + ESTACIONAMENTO
     R$ 944,64") - nesse caso devolva o valor somado aqui mesmo, e nao tente
     separar. Separar sem base no documento e inventar dado.

   - hotel: o total de hospedagem que o quadro apresenta ("HOTEL", "HOSPEDAGEM",
     "DIARIAS"). So o valor de hotel - nao junte refeicao nem outros aqui.
   - outros: o total da linha de despesas diversas ("OUTROS", "OUTRAS DESPESAS",
     "DESPESAS EVENTUAIS"). Se o quadro trouxer "HOTEL E OUTROS" numa linha so,
     sem separar, devolva o valor em outros e diga em problemas_de_leitura que
     os dois vieram somados - quem confere precisa saber que nao deu para
     separar.
   - outros_descricao: o que o documento escreve ao lado do valor de outros
     (por exemplo "refeicao com cliente", "lavagem"). Vazio se nao houver.

8. O nome do colaborador e o nome DENTRO do documento, nunca quem enviou.

9. Se algo estiver ilegivel, cortado, rasurado ou o arquivo estiver protegido,
   diga em problemas_de_leitura e baixe a confianca. Nunca preencha por
   suposicao - um dado inventado aqui vira reprovacao injusta la na frente.`;

const FERRAMENTA = {
  name: 'transcrever_rdv',
  description: 'Devolve o conteudo do relatorio de despesas de viagem em forma estruturada.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      nome_no_relatorio: {
        type: 'string',
        description: 'Nome do colaborador como aparece dentro do documento. Vazio se nao houver.',
      },
      mes_referencia: {
        type: 'string',
        description: 'Mes do relatorio no formato AAAA-MM. Vazio se nao der para determinar.',
      },
      placas: {
        type: 'string',
        description: 'Placa ou placas declaradas no documento. Vazio se nao houver.',
      },
      linhas: {
        type: 'array',
        description: 'Um item por dia preenchido na tabela, na ordem em que aparecem.',
        items: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'AAAA-MM-DD' },
            km_inicial: { type: 'number' },
            km_final: { type: 'number' },
            itinerario: { type: 'string' },
            pedagio: { type: 'number' },
            estacionamento: { type: 'number' },
          },
          required: ['data', 'km_inicial', 'km_final', 'itinerario', 'pedagio', 'estacionamento'],
          additionalProperties: false,
        },
      },
      totais_declarados: {
        type: 'object',
        description: 'Os totais que o proprio documento apresenta. null onde o documento nao trouxer.',
        properties: {
          total_km: {
            type: ['number', 'null'],
            description: 'Total de quilometros declarado no quadro de resumo.',
          },
          taxa_por_km: {
            type: ['number', 'null'],
            description: 'Valor pago por quilometro. Numero pequeno, tipicamente 0.90.',
          },
          valor_total_km: {
            type: ['number', 'null'],
            description:
              'Valor em reais a receber pelos km (total_km x taxa). Numero grande, na casa dos milhares. NUNCA e a taxa.',
          },
          pedagio_estacionamento: {
            type: ['number', 'null'],
            description:
              'Total de pedagio + estacionamento declarado. Se o documento traz os dois somados numa linha so, devolva o valor somado.',
          },
          hotel: {
            type: ['number', 'null'],
            description: 'Total de hotel/hospedagem declarado no quadro de resumo.',
          },
          outros: {
            type: ['number', 'null'],
            description: 'Total da linha de outras despesas declarado no quadro de resumo.',
          },
          outros_descricao: {
            type: ['string', 'null'],
            description:
              'O que o documento escreve ao lado do valor de outros. Vazio se nao houver.',
          },
        },
        required: [
          'total_km',
          'taxa_por_km',
          'valor_total_km',
          'pedagio_estacionamento',
          'hotel',
          'outros',
          'outros_descricao',
        ],
        additionalProperties: false,
      },
      confianca: {
        type: 'string',
        enum: ['alta', 'media', 'baixa'],
        description: 'Quao confiavel foi a leitura do documento.',
      },
      problemas_de_leitura: {
        type: 'array',
        description: 'O que atrapalhou a leitura. Vazio se estiver tudo legivel.',
        items: { type: 'string' },
      },
    },
    required: [
      'nome_no_relatorio',
      'mes_referencia',
      'placas',
      'linhas',
      'totais_declarados',
      'confianca',
      'problemas_de_leitura',
    ],
    additionalProperties: false,
  },
};

/**
 * Extrai a tabela do RDV a partir dos anexos marcados como o proprio relatorio.
 * @param {Array} anexosDoRdv linhas da tabela anexos com tipo 'rdv'
 * @param {string} mesEsperado 'AAAA-MM' - usado para desambiguar datas sem ano
 */
export async function extrairDoRdv(anexosDoRdv, mesEsperado) {
  const chave = chaveDaApi();
  if (!chave) {
    throw new Error(
      'A leitura do RDV precisa da chave da API da Anthropic. Cadastre em Configuracoes ou defina ANTHROPIC_API_KEY.',
    );
  }
  if (!anexosDoRdv.length) {
    throw new Error('Nenhum arquivo de relatorio foi anexado.');
  }

  const cliente = new Anthropic({ apiKey: chave });
  const conteudo = [
    {
      type: 'text',
      text: `Transcreva o relatorio de despesas de viagem em anexo. Mes de referencia esperado: ${mesEsperado}.`,
    },
  ];

  const ignorados = [];

  for (const a of anexosDoRdv) {
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(caminho)) {
      ignorados.push(`${a.nome_original} (nao encontrado no servidor)`);
      continue;
    }
    const tamanho = fs.statSync(caminho).size;
    if (tamanho === 0) {
      ignorados.push(`${a.nome_original} (chegou vazio, 0 KB)`);
      continue;
    }
    if (tamanho > LIMITE_POR_ANEXO) {
      ignorados.push(`${a.nome_original} (${(tamanho / 1048576).toFixed(1)} MB, grande demais)`);
      continue;
    }

    const ext = path.extname(a.nome_original).toLowerCase();

    if (IMAGENS[ext]) {
      conteudo.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: IMAGENS[ext],
          data: fs.readFileSync(caminho).toString('base64'),
        },
      });
    } else if (ext === '.pdf') {
      conteudo.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: fs.readFileSync(caminho).toString('base64'),
        },
      });
    } else if (PLANILHAS.has(ext)) {
      try {
        const texto = await planilhaEmTexto(caminho, ext);
        if (!texto.trim()) {
          ignorados.push(`${a.nome_original} (planilha sem nenhuma celula preenchida)`);
          continue;
        }
        conteudo.push({
          type: 'text',
          text: `Conteudo da planilha "${a.nome_original}", uma linha por linha da tabela:\n\n${texto}`,
        });
      } catch (e) {
        ignorados.push(`${a.nome_original} (nao consegui abrir a planilha: ${e.message})`);
      }
    } else if (TEXTO.has(ext)) {
      const texto = fs.readFileSync(caminho, 'utf8');
      if (!texto.trim()) {
        ignorados.push(`${a.nome_original} (chegou sem conteudo)`);
        continue;
      }
      conteudo.push({
        type: 'text',
        text: `Conteudo do arquivo "${a.nome_original}":\n\n${texto}`,
      });
    } else {
      ignorados.push(`${a.nome_original} (formato ${ext || 'desconhecido'} nao pode ser lido)`);
    }
  }

  if (conteudo.length === 1) {
    throw new Error(
      `Nenhum arquivo legivel entre os anexados como relatorio. ${ignorados.join('; ')}. ` +
        'Envie o RDV em PDF, planilha (XLSX, XLSM ou XLS) ou como foto (JPG/PNG).',
    );
  }

  const resposta = await cliente.messages.create({
    model: lerConfig('modelo_ia') || 'claude-opus-5',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: INSTRUCOES,
    messages: [{ role: 'user', content: conteudo }],
    tools: [FERRAMENTA],
    tool_choice: { type: 'tool', name: 'transcrever_rdv' },
  });

  if (resposta.stop_reason === 'refusal') {
    throw new Error(
      `O modelo recusou a leitura (${resposta.stop_details?.category || 'sem categoria'}).`,
    );
  }

  const bloco = resposta.content.find(
    (b) => b.type === 'tool_use' && b.name === 'transcrever_rdv',
  );
  if (!bloco) throw new Error('A leitura nao devolveu a transcricao. Tente de novo.');

  const dados = bloco.input;
  if (ignorados.length) {
    dados.problemas_de_leitura = [...(dados.problemas_de_leitura || []), ...ignorados];
  }

  return { extraido: normalizar(dados, mesEsperado), uso: resposta.usage };
}

// Limpa o que veio. O mes que vale e o DO DOCUMENTO, nao o que estava
// selecionado na tela: descartar as linhas por causa de um seletor errado
// esvaziaria o relatorio inteiro em silencio.
function normalizar(d, mesEsperado) {
  const mesDoDoc = /^\d{4}-\d{2}$/.test(String(d.mes_referencia || ''))
    ? String(d.mes_referencia)
    : null;

  // Sem mes no documento, cai no da tela.
  const mesQueVale = mesDoDoc || mesEsperado;

  const linhas = [];
  const foraDoMes = [];

  for (const l of d.linhas || []) {
    const data = String(l.data || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;

    const ki = num(l.km_inicial);
    const kf = num(l.km_final);
    const ped = num(l.pedagio);
    const est = num(l.estacionamento);
    const itin = String(l.itinerario || '').trim().slice(0, 500);

    if (ki === 0 && kf === 0 && ped === 0 && est === 0 && !itin) continue;

    if (!data.startsWith(mesQueVale)) {
      foraDoMes.push(data);
      continue;
    }

    linhas.push({ data, km_inicial: ki, km_final: kf, itinerario: itin, pedagio: ped, estacionamento: est });
  }

  linhas.sort((a, b) => a.data.localeCompare(b.data));

  const problemas = [...(d.problemas_de_leitura || [])];
  if (foraDoMes.length) {
    problemas.push(
      `O documento traz ${foraDoMes.length} lancamento(s) fora de ${mesQueVale} (${foraDoMes
        .slice(0, 5)
        .join(', ')}) - foram descartados.`,
    );
  }

  const t = d.totais_declarados || {};
  const valor = (v) => (v == null ? null : num(v));

  return {
    nome_no_relatorio: String(d.nome_no_relatorio || '').trim(),
    mes_referencia: mesQueVale,
    mes_do_documento: mesDoDoc,
    placas: String(d.placas || '').trim(),
    linhas,
    // Esta lista tem que acompanhar o esquema la em cima. Ela e uma copia
    // campo a campo, entao um campo novo no esquema que nao entre aqui e lido
    // pelo modelo e jogado fora em silencio - foi o que aconteceu com hotel e
    // outros: o RDV do Felipe trazia R$ 159,00 e o portal fechava R$ 159,00
    // abaixo do documento, sem apontar nada.
    totais_declarados: {
      total_km: valor(t.total_km),
      taxa_por_km: valor(t.taxa_por_km),
      valor_total_km: valor(t.valor_total_km),
      pedagio_estacionamento: valor(t.pedagio_estacionamento),
      hotel: valor(t.hotel),
      outros: valor(t.outros),
      outros_descricao: String(t.outros_descricao || '').trim() || null,
    },
    confianca: ['alta', 'media', 'baixa'].includes(d.confianca) ? d.confianca : 'baixa',
    problemas_de_leitura: problemas,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * O arquivo que a pessoa acabou de anexar pode ser lido?
 *
 * Roda no momento do envio, antes de o anexo virar registro. Existe porque um
 * RDV em planilha protegida por senha passava batido: entrava como comprovante
 * valido, e so semanas depois - na conferencia ou na hora de imprimir - se
 * descobria que ninguem consegue abrir. A pessoa ja tinha ido embora do mes.
 *
 * Devolve null quando esta tudo bem, ou o recado pronto para a tela.
 * So checa o que da para checar barato: planilha e PDF. Imagem e texto passam.
 */
export async function motivoDeNaoConseguirLer(caminho, ext) {
  if (PLANILHAS_CONFERIDAS.has(ext)) {
    try {
      const texto = await planilhaEmTexto(caminho, ext);
      if (!String(texto).trim()) {
        return 'A planilha abriu vazia - nenhuma linha foi encontrada. '
          + 'Confira se salvou a aba certa, ou envie o RDV em PDF.';
      }
    } catch (e) {
      if (/password|encrypt/i.test(e.message)) {
        return 'Essa planilha esta protegida por senha e o portal nao consegue abrir. '
          + 'Salve o RDV como PDF (Arquivo > Salvar como > PDF) e anexe o PDF.';
      }
      return 'Nao foi possivel ler essa planilha - o arquivo parece danificado ou '
        + 'nao e uma planilha de verdade. Se ela abre normalmente no seu Excel, '
        + `salve como PDF e anexe o PDF. (${resumoTecnico(e)})`;
    }
  }

  if (ext === '.pdf') {
    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(fs.readFileSync(caminho), { ignoreEncryption: true });

      // PDF trancado passava por aqui: `ignoreEncryption` manda o pdf-lib abrir
      // assim mesmo, e o arquivo era aceito. So que a API da Anthropic recusa a
      // chamada INTEIRA quando recebe um documento protegido - e a conferencia
      // do relatorio morria por causa dele. Melhor barrar no envio, com a
      // pessoa ainda de posse do arquivo.
      if (doc.isEncrypted) {
        return 'Esse PDF esta protegido por senha e o portal nao consegue ler. '
          + 'Abra o arquivo, salve uma copia sem senha (Imprimir > Salvar como PDF) '
          + 'e anexe essa copia.';
      }
      if (doc.getPageCount() === 0) return 'Esse PDF chegou sem nenhuma pagina. Gere o arquivo de novo.';
    } catch (e) {
      return 'Esse PDF esta danificado e nao abre. Gere o arquivo de novo e anexe. '
        + `(${resumoTecnico(e)})`;
    }
  }

  return null;
}

const PLANILHAS_CONFERIDAS = new Set(['.xlsx', '.xlsm', '.xls']);

/**
 * A parte tecnica do erro, curta e sem lixo.
 *
 * O recado vai para o celular de um vendedor: as bibliotecas gostam de devolver
 * URL de documentacao e paragrafos inteiros, e isso so assusta. Fica a primeira
 * frase, cortada, so para dar uma pista se alguem precisar investigar.
 */
function resumoTecnico(e) {
  return String(e.message || 'erro desconhecido')
    .split(/[.:]\s|https?:\/\//)[0]
    .trim()
    .slice(0, 80);
}
