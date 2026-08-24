// Le o PDF (ou foto/planilha) do RDV e transforma a tabela em linhas
// estruturadas - as mesmas que o motor de conferencia em conferencia.js espera.
//
// A ideia: o colaborador nao digita nada, so anexa o relatorio que ja produz
// hoje. A extracao devolve tambem os TOTAIS QUE ELE DECLAROU no documento, para
// a conferencia poder comparar com a soma correta das linhas - que e como o
// erro de conta e pego, ja que agora ele nao e mais evitado na origem.

import Anthropic from '@anthropic-ai/sdk';
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

6. Pedagio e estacionamento: so o que estiver lancado naquela linha do relatorio.
   Se o documento tiver uma coluna unica de "despesas", coloque em pedagio e
   avise em problemas_de_leitura.

7. TOTAIS DECLARADOS: transcreva os totais que o PROPRIO DOCUMENTO apresenta
   (normalmente num quadro destacado ao lado ou no rodape) - total de km, valor
   do km, pedagio e estacionamento. Nao some voce mesmo: queremos saber o que a
   pessoa declarou, justamente para comparar depois com a soma correta.
   Se um total nao aparecer no documento, devolva null naquele campo.

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
          total_km: { type: ['number', 'null'] },
          valor_km: { type: ['number', 'null'] },
          pedagio: { type: ['number', 'null'] },
          estacionamento: { type: ['number', 'null'] },
        },
        required: ['total_km', 'valor_km', 'pedagio', 'estacionamento'],
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
    const dados = fs.readFileSync(caminho).toString('base64');

    if (IMAGENS[ext]) {
      conteudo.push({
        type: 'image',
        source: { type: 'base64', media_type: IMAGENS[ext], data: dados },
      });
    } else if (ext === '.pdf') {
      conteudo.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: dados },
      });
    } else {
      ignorados.push(`${a.nome_original} (formato ${ext || 'desconhecido'} nao pode ser lido)`);
    }
  }

  if (conteudo.length === 1) {
    throw new Error(
      `Nenhum arquivo legivel entre os anexados como relatorio. ${ignorados.join('; ')}. ` +
        'Envie o RDV em PDF ou como foto (JPG/PNG).',
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

// Limpa o que veio: datas fora do mes, numeros invalidos, linhas vazias.
function normalizar(d, mesEsperado) {
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

    if (!data.startsWith(mesEsperado)) {
      foraDoMes.push(data);
      continue;
    }

    linhas.push({ data, km_inicial: ki, km_final: kf, itinerario: itin, pedagio: ped, estacionamento: est });
  }

  linhas.sort((a, b) => a.data.localeCompare(b.data));

  const problemas = [...(d.problemas_de_leitura || [])];
  if (foraDoMes.length) {
    problemas.push(
      `O documento traz ${foraDoMes.length} lancamento(s) fora de ${mesEsperado} (${foraDoMes
        .slice(0, 5)
        .join(', ')}) - foram descartados.`,
    );
  }

  const t = d.totais_declarados || {};
  return {
    nome_no_relatorio: String(d.nome_no_relatorio || '').trim(),
    mes_referencia: String(d.mes_referencia || '').slice(0, 7),
    placas: String(d.placas || '').trim(),
    linhas,
    totais_declarados: {
      total_km: t.total_km == null ? null : num(t.total_km),
      valor_km: t.valor_km == null ? null : num(t.valor_km),
      pedagio: t.pedagio == null ? null : num(t.pedagio),
      estacionamento: t.estacionamento == null ? null : num(t.estacionamento),
    },
    confianca: ['alta', 'media', 'baixa'].includes(d.confianca) ? d.confianca : 'baixa',
    problemas_de_leitura: problemas,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
