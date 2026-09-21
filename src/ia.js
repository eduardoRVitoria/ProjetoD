// Conferencia com IA - le os comprovantes anexados (extrato de pedagio, DANFE de
// abastecimento, fotos de odometro) e cruza com o que foi declarado no RDV.
// O motor de regra em conferencia.js ja resolveu tudo que e aritmetica; aqui
// entra so o que exige olhar documento.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { chaveDaApi, lerConfig, PASTA_ANEXOS } from './banco.js';
import * as log from './log.js';
import { dataBr } from './conferencia.js';

const LIMITE_POR_ANEXO = 8 * 1024 * 1024; // 8 MB
const LIMITE_TOTAL = 24 * 1024 * 1024; // folga sobre o teto de 32 MB da requisicao

// Acima de 20 imagens a API exige no maximo 2000 px por lado, e foto de
// celular tem 3000 ou 4000. Uma unica foto grande derrubava a chamada INTEIRA:
//
//   At least one of the image dimensions exceed max allowed size
//   for many-image requests: 2000 pixels
//
// Como agora toda foto e encolhida para caber nesse lado (ver `encolher`), o
// teto pode subir muito: deixou de ser preciso escolher QUAIS comprovantes a
// conferencia vai olhar. Fica em 60 - abaixo das 100 imagens em que a API
// aperta de novo, e com folga para o mes mais cheio.
//
// O numero ainda importa porque `encolher` pode falhar (sharp ausente no
// conteiner, imagem corrompida). Nesse caso o arquivo vai como esta, e o teto
// volta a ser a unica protecao.
const MAX_IMAGENS = 60;

// Quando nao cabe tudo, o que fica e o que decide dinheiro. A foto de odometro
// e referencia: perder uma atrasa a conferencia dela, perder o extrato da tag
// deixa o valor sem conferir.
const PRIORIDADE = { rdv: 0, pedagio: 1, danfe: 2, odometro: 3, outro: 4 };

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

1.1 HORA DAS PASSAGENS. O extrato da tag traz a hora de cada passagem. Liste em
   "passagens_apos_18h" toda passagem de pedagio ou estacionamento com hora
   18:00 ou mais tarde. Apenas LISTE: nao escreva achado nenhum sobre horario,
   nao cobre explicacao e nao trate hora tardia como problema. Quem decide se
   isso vira pendencia e a regra do sistema, que nao vale para todas as
   empresas - achado seu sobre horario cobraria quem esta isento.
   Leia a hora que esta escrita no extrato. Nao estime pela ordem das linhas,
   nao deduza do trajeto e nao inclua lancamento sem hora legivel: a lista
   vazia e a resposta certa quando o extrato nao mostra hora. Acusar alguem de
   rodar de madrugada por causa de hora inventada e pior que nao checar.

2. ABASTECIMENTO. Confirme se existe mesmo uma nota fiscal / DANFE / cupom de
   abastecimento. O nome do arquivo nao vale como prova - o "GASOLINA.pdf" de alguem
   ja veio sem nota nenhuma dentro. Olhe o conteudo.
   E SO ISSO: existe ou nao existe uma nota de abastecimento.
   NAO compare o valor da nota com a quilometragem, nao calcule consumo, nao
   verifique se o combustivel "cobre" os km rodados e nao cobre mais de uma nota.
   Uma notinha de um abastecimento basta - o reembolso e por km rodado, nao pelo
   combustivel gasto. Apontar isso como divergencia esta errado.

3. FOTOS DE ODOMETRO. Leia o numero do painel em cada foto e diga o que leu.
   A foto e uma REFERENCIA, nao um conferidor de conta.
   O numero do painel NAO precisa bater com o km do RDV, e diferenca normal NAO
   e divergencia: o carro tambem roda fora do trabalho - fim de semana, uso
   particular, ida ao posto - e nada disso entra no relatorio. Um painel maior
   que a soma dos km lancados e o esperado, nao um problema.
   So aponte quando a foto contar outra historia: painel MENOR que o km ja
   lancado no periodo (o carro teria andado para tras), ou uma distancia
   absurda, de outra ordem de grandeza. Fora isso, registre o que leu e siga.
   Nunca reprove um relatorio por diferenca entre o painel e o km declarado.

4. ITINERARIO. Veja se a distancia declarada faz sentido para o trajeto descrito.
   Aponte so o que for claramente desproporcional, nao chute quilometragem exata.

Regras de julgamento:
- Falta da nota de abastecimento, sozinha, e o unico problema => "SO_FALTA_DANFE".
- Qualquer outra divergencia => "ERRADA".
- Tudo conferido => "CERTA".
- Odometro andando para tras geralmente e segundo veiculo, nao fraude: aponte como
  aviso e peca a placa, nao trate como erro grave.
- Comprovante ilegivel ou protegido por senha: diga isso, nao invente valor.

COMO ESCREVER OS ACHADOS. Quem le e um vendedor no celular, no fim do mes, com
pressa. Cada achado e uma frase curta que diz O QUE ESTA ERRADO e O QUE FAZER.

- Va direto ao ponto. Nada de "identificamos que", "foi constatado", "recomenda-se".
- Diga o numero e o dia quando existirem: "Dia 12: pedagio R$ 45 declarado,
  R$ 30 no extrato. Confira." vale mais que "ha divergencia nos pedagios".
- Uma pendencia por achado. Nao junte tres problemas numa frase.
- Sem repetir o que a conferencia automatica ja apontou.
- Nao explique o que voce fez para chegar la; escreva so a conclusao.
- QUANDO O PROBLEMA ESTA NUM COMPROVANTE, DIGA EM QUAL. Preencha o campo
  "anexo" com o nome do arquivo copiado do rotulo "--- Anexo: <nome> ---" que
  veio antes daquele documento, letra por letra. E o que faz o vendedor saber
  qual foto reenviar em vez de mandar todas de novo. Um achado por arquivo:
  se duas fotos estao ilegiveis, sao dois achados. Deixe "anexo" vazio quando o
  problema nao for de um comprovante - conta errada, dia faltando, itinerario.
  Nome que nao esta na lista de anexos nao vira link nenhum, entao copiar
  errado e o mesmo que nao responder.

Escreva em portugues do Brasil. O campo "o_que_fazer" e lido pelo proprio
colaborador - a acao concreta que ele precisa tomar, em uma ou duas frases.
Vazio se estiver tudo certo.`;

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
      passagens_apos_18h: {
        type: 'array',
        description:
          'Passagens de pedagio ou estacionamento do extrato cuja HORA e 18:00 ou mais tarde. '
          + 'Leia a hora que esta no proprio extrato - nao invente, nao estime, e nao inclua '
          + 'lancamento sem hora legivel. Lista vazia se o extrato nao mostrar hora, ou se '
          + 'nenhuma passagem for depois das 18h.',
        items: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'AAAA-MM-DD' },
            hora: { type: 'string', description: 'HH:MM, como esta no extrato' },
            valor: { type: 'number' },
            local: { type: 'string', description: 'praca ou estabelecimento, como esta no extrato' },
          },
          required: ['data', 'hora', 'valor', 'local'],
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
            description:
              'Se a foto do painel e COERENTE com o relatorio - nao se bate numero com numero. '
              + 'Painel maior que a soma dos km lancados e normal (o carro roda fora do trabalho) '
              + 'e continua sendo "sim". Use "nao" apenas quando o painel for MENOR que o km ja '
              + 'lancado no periodo, ou a distancia for de outra ordem de grandeza.',
            enum: ['sim', 'nao', 'parcial', 'sem_foto'],
          },
          observacao: { type: 'string' },
        },
        required: ['fotos_lidas', 'confere_com_o_rdv', 'observacao'],
        additionalProperties: false,
      },
      achados: {
        type: 'array',
        description:
          'Uma entrada por divergencia encontrada. Vazio se nao houver nenhuma. '
          + 'No maximo 4 entradas: escolha as que importam, nao liste tudo que notou.',
        items: {
          type: 'object',
          properties: {
            gravidade: { type: 'string', enum: ['erro', 'aviso'] },
            mensagem: {
              type: 'string',
              description:
                'Uma frase curta, no maximo 140 caracteres. Diz o que esta errado e o que fazer, '
                + 'com o dia e o valor quando existirem. Sem preambulo e sem explicar o raciocinio. '
                + 'Exemplo: "Dia 12: pedagio R$ 45 declarado, R$ 30 no extrato. Confira."',
            },
            anexo: {
              type: 'string',
              description:
                'O arquivo em que o problema esta, copiado LETRA POR LETRA do rotulo '
                + '"--- Anexo: <nome> ---" que veio antes do documento. Serve para o portal '
                + 'mostrar um link direto para o comprovante. Nao invente nome, nao abrevie e '
                + 'nao cite dois arquivos. String vazia quando o achado nao e de um comprovante '
                + 'especifico (conta, dia, itinerario).',
            },
          },
          required: ['gravidade', 'mensagem', 'anexo'],
          additionalProperties: false,
        },
      },
      status: {
        type: 'string',
        enum: ['CERTA', 'SO_FALTA_DANFE', 'ERRADA'],
      },
      resumo: {
        type: 'string',
        description: 'Uma ou duas frases, no maximo 200 caracteres, sobre o que foi encontrado.',
      },
      o_que_fazer: {
        type: 'string',
        description:
          'A acao concreta que o colaborador precisa tomar, no maximo 200 caracteres. '
          + 'Vazio se estiver tudo certo.',
      },
    },
    required: [
      'pedagio_comprovado',
      'itens_ignorados',
      'passagens_apos_18h',
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

  // Anexo que ficou de fora guarda id, nome e motivo separados - nao um texto
  // pronto. Quem recebe monta a frase que serve para ele: o log junta tudo numa
  // linha, e a conferencia vira um achado com link para o arquivo. Antes era so
  // texto, e o vendedor nunca ficava sabendo qual comprovante falhou.
  const ignorados = [];
  const ignorar = (a, motivo) => ignorados.push({ id: a.id, nome: a.nome_original, motivo });

  // Ordem de importancia, nao de chegada: se algo tiver que ficar de fora, que
  // seja a foto de odometro, nao o extrato da tag.
  const naOrdem = [...anexos].sort(
    (x, y) => (PRIORIDADE[x.tipo] ?? 9) - (PRIORIDADE[y.tipo] ?? 9),
  );
  let imagens = 0;

  for (const a of naOrdem) {
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(caminho)) {
      ignorar(a, `arquivo nao encontrado no servidor`);
      continue;
    }
    const tamanho = fs.statSync(caminho).size;
    if (tamanho === 0) {
      ignorar(a, `chegou vazio, 0 KB`);
      continue;
    }
    if (tamanho > LIMITE_POR_ANEXO) {
      ignorar(a, `${(tamanho / 1048576).toFixed(1)} MB, grande demais`);
      continue;
    }
    // Imagem nao entra aqui: ela ainda vai ser encolhida, e medir o original
    // descartaria foto que caberia folgada depois de reduzida.
    if (!IMAGENS[path.extname(a.nome_original).toLowerCase()] && acumulado + tamanho > LIMITE_TOTAL) {
      ignorar(a, `estourou o limite total da requisicao`);
      continue;
    }

    const ext = path.extname(a.nome_original).toLowerCase();

    // O teto de imagens vem antes de ler o arquivo: passar de MAX_IMAGENS faz
    // a API recusar a chamada INTEIRA por causa do tamanho em pixels, e ai o
    // relatorio todo fica sem conferencia - o pior desfecho possivel.
    // Foto grande e encolhida para caber no limite de pixel da API. Com todas
    // dentro de 2000px, o teto de imagens sobe muito - deixa de ser preciso
    // escolher quais comprovantes a conferencia vai olhar.
    let encolhida = null;
    if (IMAGENS[ext]) {
      encolhida = await encolher(caminho);
      if (imagens >= MAX_IMAGENS) {
        ignorar(a, `passou do limite de ${MAX_IMAGENS} imagens por conferencia`);
        continue;
      }
    }

    const efetivo = encolhida ? encolhida.bytes : tamanho;
    if (acumulado + efetivo > LIMITE_TOTAL) {
      ignorar(a, `estourou o limite total da requisicao`);
      continue;
    }

    const dados = encolhida ? encolhida.base64 : fs.readFileSync(caminho).toString('base64');
    acumulado += efetivo;

    conteudo.push({
      type: 'text',
      text: `\n--- Anexo: ${a.nome_original} (marcado pelo colaborador como "${rotulo(a.tipo)}") ---`,
    });

    if (IMAGENS[ext]) {
      imagens++;
      conteudo.push({
        type: 'image',
        // Encolhida sai sempre em jpeg, entao o media_type acompanha - dizer
        // 'image/png' para bytes de jpeg faz a API recusar a chamada.
        source: { type: 'base64', media_type: encolhida ? 'image/jpeg' : IMAGENS[ext], data: dados },
      });
    } else if (ext === '.pdf') {
      // PDF protegido por senha faz a API recusar a chamada inteira com 400 -
      // e ai o relatorio todo fica sem conferencia por causa de um anexo. Sai
      // da lista e vira aviso, como qualquer outro arquivo ilegivel.
      if (await pdfProtegido(caminho)) {
        acumulado -= tamanho;
        ignorar(a, `PDF protegido por senha`);
        conteudo.pop();
        continue;
      }

      // Cada pagina do PDF vira uma imagem do lado da API, entao ela conta no
      // mesmo teto. Sem isto, um extrato de 30 paginas derrubava a chamada
      // inteira mesmo com poucas fotos anexadas.
      const paginas = await paginasDoPdf(caminho);
      if (imagens + paginas > MAX_IMAGENS) {
        acumulado -= tamanho;
        ignorar(a, `${paginas} pagina(s); nao coube no limite de ${MAX_IMAGENS} imagens por conferencia`);
        conteudo.pop();
        continue;
      }
      imagens += paginas;

      conteudo.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: dados },
      });
    } else {
      acumulado -= tamanho;
      ignorar(a, `formato ${ext || 'desconhecido'} nao suportado`);
      conteudo.pop();
    }
  }

  if (ignorados.length) {
    conteudo.push({
      type: 'text',
      text: `\nAnexos que NAO puderam ser lidos: ${textoDosIgnorados(ignorados)}. Considere isso no parecer.`,
    });
  }

  const comeco = Date.now();
  const modelo = lerConfig('modelo_ia') || 'claude-opus-5';
  const resposta = await cliente.messages.create({
    model: modelo,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: INSTRUCOES,
    messages: [{ role: 'user', content: conteudo }],
    tools: [FERRAMENTA],
    tool_choice: { type: 'tool', name: 'registrar_parecer' },
  });

  // O unico lugar do portal que gasta dinheiro por uso. Sem esta linha, "a
  // conferencia esta cara" e "a conferencia esta lenta" nao tem como ser
  // respondido - nem da para saber qual relatorio puxou a conta para cima.
  log.info('ia', 'conferencia', {
    rel: rel.id,
    de: usuario.nome,
    modelo,
    tempo: log.desde(comeco),
    entrada: resposta.usage?.input_tokens,
    saida: resposta.usage?.output_tokens,
    anexos: conteudo.length - 1,
    ignorados: ignorados.length || undefined,
  });

  if (resposta.stop_reason === 'refusal') {
    const motivo = resposta.stop_details?.category || 'sem categoria';
    log.aviso('ia', 'modelo recusou a analise', { rel: rel.id, motivo });
    throw new Error(`O modelo recusou a analise (${motivo}). Confira manualmente.`);
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

// A lista de ignorados vira uma linha so - para o log, para o aviso do
// administrador e para o texto que o modelo recebe.
export function textoDosIgnorados(ignorados) {
  return (ignorados || []).map((i) => `${i.nome} (${i.motivo})`).join('; ');
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

/**
 * O PDF esta trancado com senha?
 *
 * A API da Anthropic recusa a requisicao INTEIRA quando um dos documentos e
 * protegido - responde 400 e nenhum dos outros anexos chega a ser lido. Por
 * isso a checagem acontece aqui, antes de montar a chamada.
 *
 * `ignoreEncryption` deixa o pdf-lib abrir o arquivo mesmo trancado; sem isso
 * ele lanca e nao da para perguntar nada. A resposta esta em `isEncrypted`.
 */
async function pdfProtegido(caminho) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(caminho), { ignoreEncryption: true });
    return Boolean(doc.isEncrypted);
  } catch {
    // Nao abriu nem para perguntar: trata como suspeito e deixa de fora, que e
    // melhor que arriscar derrubar a conferencia do relatorio inteiro.
    return true;
  }
}

/**
 * Quantas paginas o PDF tem.
 *
 * A API converte CADA pagina de PDF numa imagem. Um extrato de 30 paginas ja
 * estoura sozinho o limite de imagens - foi o que continuou derrubando o
 * relatorio 108 depois do primeiro teto, que so contava arquivo de imagem.
 *
 * Quando nao da para abrir, assume 1: chutar alto excluiria um extrato inteiro
 * por precaucao, e o extrato e o documento que decide dinheiro.
 */
// Limite de pixel da API quando a chamada leva muitas imagens.
const LADO_MAXIMO = 2000;

/**
 * Encolhe a foto para caber no limite de pixel da API.
 *
 * Devolve o base64 ja reduzido, ou `null` quando nao precisou mexer (imagem
 * pequena) ou quando nao deu para processar. `null` significa "use o arquivo
 * como esta" - quem chama decide o que fazer.
 *
 * O `sharp` e carregado aqui dentro, sob try: se ele faltar no conteiner, a
 * conferencia continua funcionando com o teto de imagens, em vez de o portal
 * inteiro parar por causa de uma dependencia nativa que nao subiu.
 */
async function encolher(caminho) {
  try {
    const { default: sharp } = await import('sharp');
    const img = sharp(caminho, { failOn: 'none' });
    const { width, height } = await img.metadata();
    if (!width || !height) return null;
    if (width <= LADO_MAXIMO && height <= LADO_MAXIMO) return null;

    const menor = await img
      .rotate() // respeita o EXIF: foto de celular deitada viraria de lado
      .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    return { base64: menor.toString('base64'), bytes: menor.length, de: `${width}x${height}` };
  } catch (e) {
    log.aviso('ia', 'nao consegui encolher a imagem', { arquivo: path.basename(caminho), erro: e.message });
    return null;
  }
}

async function paginasDoPdf(caminho) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(caminho), { ignoreEncryption: true });
    return Math.max(1, doc.getPageCount());
  } catch {
    return 1;
  }
}
