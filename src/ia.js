// Conferencia com IA - le os comprovantes anexados (extrato de pedagio, DANFE de
// abastecimento, fotos de odometro) e cruza com o que foi declarado no RDV.
// O motor de regra em conferencia.js ja resolveu tudo que e aritmetica; aqui
// entra so o que exige olhar documento.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { chaveDaApi, lerConfig, PASTA_ANEXOS } from './banco.js';
import { dataBr } from './conferencia.js';

const LIMITE_POR_ANEXO = 8 * 1024 * 1024; // 8 MB
const LIMITE_TOTAL = 24 * 1024 * 1024; // folga sobre o teto de 32 MB da requisicao

const IMAGENS = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg', // mesmo formato do jpeg, so muda a extensao
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const INSTRUCOES = `Voce confere Relatorios de Despesas de Viagem (RDV) da DISO Comercio de Alimentos.
Sua tarefa e olhar os comprovantes anexados e cruzar com o que o colaborador declarou.

O que voce PRECISA verificar:

1. PEDAGIO E ESTACIONAMENTO. Some tudo que for pedagio ou estacionamento nos
   comprovantes (Sem Parar, ConectCar, Tag Itau, Veloe, Ultrapasse, C6 Tag, cupons
   avulsos) e compare com o valor declarado.
   NAO SOME estes itens, que aparecem no mesmo extrato mas nao sao despesa de viagem:
   mensalidade do plano, IOF, "dias de uso da tag", negociacao de divida, recarga de
   saldo, taxa de envio da tag, multa.
   Considere apenas lancamentos dentro do mes de referencia e em dia util.

2. ABASTECIMENTO. Confirme se existe mesmo uma nota fiscal / DANFE / cupom de
   abastecimento. O nome do arquivo nao vale como prova - o "GASOLINA.pdf" de alguem
   ja veio sem nota nenhuma dentro. Olhe o conteudo.

3. FOTOS DE ODOMETRO. Leia o numero do painel em cada foto e compare com o KM
   declarado no relatorio. A ideia e ter a foto de segunda de manha e a de sexta a
   noite de cada semana. Se o numero da foto nao bate com o KM do RDV, aponte.

4. ITINERARIO. Veja se a distancia declarada faz sentido para o trajeto descrito.
   Aponte so o que for claramente desproporcional, nao chute quilometragem exata.

Regras de julgamento:
- Falta da nota de abastecimento, sozinha, e o unico problema => "SO_FALTA_DANFE".
- Qualquer outra divergencia => "ERRADA".
- Tudo conferido => "CERTA".
- Odometro andando para tras geralmente e segundo veiculo, nao fraude: aponte como
  aviso e peca a placa, nao trate como erro grave.
- Comprovante ilegivel ou protegido por senha: diga isso, nao invente valor.

Escreva em portugues do Brasil, direto, sem rodeio. O campo "o_que_fazer" e lido
pelo proprio colaborador - escreva a acao concreta que ele precisa tomar, e deixe
vazio se estiver tudo certo.`;

const FERRAMENTA = {
  name: 'registrar_parecer',
  description: 'Registra o resultado da conferencia dos comprovantes do RDV.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      pedagio_comprovado: {
        type: 'number',
        description:
          'Soma, em reais, de tudo que e pedagio e estacionamento nos comprovantes. Use 0 se nao houver comprovante legivel.',
      },
      itens_ignorados: {
        type: 'array',
        description:
          'Lancamentos que apareceram no extrato mas nao sao pedagio/estacionamento (mensalidade, IOF, recarga...).',
        items: {
          type: 'object',
          properties: {
            descricao: { type: 'string' },
            valor: { type: 'number' },
          },
          required: ['descricao', 'valor'],
          additionalProperties: false,
        },
      },
      tem_danfe_de_abastecimento: {
        type: 'boolean',
        description: 'true so se voce viu mesmo uma nota/cupom de combustivel no conteudo.',
      },
      odometro: {
        type: 'object',
        properties: {
          fotos_lidas: { type: 'integer' },
          confere_com_o_rdv: {
            type: 'string',
            enum: ['sim', 'nao', 'parcial', 'sem_foto'],
          },
          observacao: { type: 'string' },
        },
        required: ['fotos_lidas', 'confere_com_o_rdv', 'observacao'],
        additionalProperties: false,
      },
      achados: {
        type: 'array',
        description: 'Uma entrada por divergencia encontrada. Vazio se nao houver nenhuma.',
        items: {
          type: 'object',
          properties: {
            gravidade: { type: 'string', enum: ['erro', 'aviso'] },
            mensagem: { type: 'string' },
          },
          required: ['gravidade', 'mensagem'],
          additionalProperties: false,
        },
      },
      status: {
        type: 'string',
        enum: ['CERTA', 'SO_FALTA_DANFE', 'ERRADA'],
      },
      resumo: {
        type: 'string',
        description: 'Uma ou duas frases sobre o que foi encontrado.',
      },
      o_que_fazer: {
        type: 'string',
        description: 'A acao concreta que o colaborador precisa tomar. Vazio se estiver tudo certo.',
      },
    },
    required: [
      'pedagio_comprovado',
      'itens_ignorados',
      'tem_danfe_de_abastecimento',
      'odometro',
      'achados',
      'status',
      'resumo',
      'o_que_fazer',
    ],
    additionalProperties: false,
  },
};

export function iaDisponivel() {
  return Boolean(chaveDaApi());
}

/**
 * Manda o relatorio e os anexos para o Claude conferir.
 * Lanca Error com mensagem em portugues se algo impedir a chamada.
 */
export async function conferirComIa({ usuario, rel, linhas, anexos, resultadoRegra, vlrKm }) {
  const chave = chaveDaApi();
  if (!chave) {
    throw new Error(
      'Nenhuma chave da API da Anthropic configurada. Cadastre em Configuracoes ou defina ANTHROPIC_API_KEY.',
    );
  }

  const cliente = new Anthropic({ apiKey: chave });
  const conteudo = [];

  conteudo.push({ type: 'text', text: montarResumo({ usuario, rel, linhas, resultadoRegra, vlrKm }) });

  let acumulado = 0;
  const ignorados = [];

  for (const a of anexos) {
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(caminho)) {
      ignorados.push(`${a.nome_original} (arquivo nao encontrado no servidor)`);
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
    if (acumulado + tamanho > LIMITE_TOTAL) {
      ignorados.push(`${a.nome_original} (estourou o limite total da requisicao)`);
      continue;
    }

    const ext = path.extname(a.nome_original).toLowerCase();
    const dados = fs.readFileSync(caminho).toString('base64');
    acumulado += tamanho;

    conteudo.push({
      type: 'text',
      text: `\n--- Anexo: ${a.nome_original} (marcado pelo colaborador como "${rotulo(a.tipo)}") ---`,
    });

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
      acumulado -= tamanho;
      ignorados.push(`${a.nome_original} (formato ${ext || 'desconhecido'} nao suportado)`);
      conteudo.pop();
    }
  }

  if (ignorados.length) {
    conteudo.push({
      type: 'text',
      text: `\nAnexos que NAO puderam ser lidos: ${ignorados.join('; ')}. Considere isso no parecer.`,
    });
  }

  const resposta = await cliente.messages.create({
    model: lerConfig('modelo_ia') || 'claude-opus-5',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: INSTRUCOES,
    messages: [{ role: 'user', content: conteudo }],
    tools: [FERRAMENTA],
    tool_choice: { type: 'tool', name: 'registrar_parecer' },
  });

  if (resposta.stop_reason === 'refusal') {
    throw new Error(
      `O modelo recusou a analise (${resposta.stop_details?.category || 'sem categoria'}). Confira manualmente.`,
    );
  }

  const bloco = resposta.content.find(
    (b) => b.type === 'tool_use' && b.name === 'registrar_parecer',
  );
  if (!bloco) {
    throw new Error('A IA respondeu sem preencher o parecer. Tente de novo.');
  }

  return {
    parecer: bloco.input,
    anexosIgnorados: ignorados,
    uso: resposta.usage,
  };
}

function rotulo(tipo) {
  return (
    {
      pedagio: 'comprovante de pedagio/estacionamento',
      danfe: 'nota de abastecimento',
      odometro: 'foto do odometro',
      outro: 'outro documento',
    }[tipo] || tipo
  );
}

function montarResumo({ usuario, rel, linhas, resultadoRegra, vlrKm }) {
  const cabecalho = [
    `Colaborador: ${usuario.nome}`,
    usuario.placas ? `Placas declaradas: ${usuario.placas}` : 'Placas declaradas: nenhuma',
    `Mes de referencia: ${rel.mes_ref}`,
    `Valor pago por km: R$ ${vlrKm.toFixed(2).replace('.', ',')}`,
    '',
    'DECLARADO NO RELATORIO:',
    `  Total de km: ${resultadoRegra.totalKm}`,
    `  Valor do km: R$ ${resultadoRegra.valorKm.toFixed(2).replace('.', ',')}`,
    `  Pedagio: R$ ${resultadoRegra.pedagioDeclarado.toFixed(2).replace('.', ',')}`,
    `  Estacionamento: R$ ${resultadoRegra.estacDeclarado.toFixed(2).replace('.', ',')}`,
    `  Pedagio + estacionamento: R$ ${resultadoRegra.totalDeclarado.toFixed(2).replace('.', ',')}`,
    '',
    'LANCAMENTOS DIA A DIA:',
  ];

  const corpo = linhas.map((l) => {
    const rodou = Number(l.km_final) - Number(l.km_inicial);
    const extras = [];
    if (Number(l.pedagio) > 0) extras.push(`pedagio R$ ${Number(l.pedagio).toFixed(2)}`);
    if (Number(l.estacionamento) > 0)
      extras.push(`estac. R$ ${Number(l.estacionamento).toFixed(2)}`);
    return `  ${dataBr(l.data)} | ${l.km_inicial} -> ${l.km_final} (${rodou} km) | ${
      l.itinerario || '(itinerario em branco)'
    }${extras.length ? ` | ${extras.join(', ')}` : ''}`;
  });

  const jaAchado = resultadoRegra.achados.length
    ? [
        '',
        'A conferencia automatica de calendario e aritmetica ja apontou:',
        ...resultadoRegra.achados.map((a) => `  [${a.gravidade}] ${a.mensagem}`),
        '',
        'Nao repita esses itens. Cuide do que depende de olhar os comprovantes.',
      ]
    : ['', 'A conferencia automatica de calendario e aritmetica nao achou nada.'];

  return [...cabecalho, ...corpo, ...jaAchado].join('\n');
}
