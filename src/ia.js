// Conferencia com IA - le os comprovantes anexados (extrato de pedagio, DANFE de
// abastecimento, fotos de odometro) e cruza com o que foi declarado no RDV.
// O motor de regra em conferencia.js ja resolveu tudo que e aritmetica; aqui
// entra so o que exige olhar documento.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { chaveDaApi, lerConfig, PASTA_ANEXOS } from './banco.js';
import * as log from './log.js';
import { dataBr, somarExtrato } from './conferencia.js';
import { pensamentoDoModelo } from './util.js';

// Teto de tempo de UMA conferencia.
//
// Sem teto, a chamada podia ficar pendurada: o relatorio ficava preso em
// "CONFERINDO" para sempre e, dentro de uma fila, segurava todos os que vem
// atras. Seis minutos e folgado - a conferencia mais pesada ja rodada levou
// pouco mais de um minuto. Quando estoura, o relatorio volta ao estado
// anterior e pode ser conferido de novo.
const TEMPO_LIMITE = 6 * 60 * 1000;

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
const PRIORIDADE = {
  rdv: 0, pedagio: 1, danfe: 2, hotel: 3, outras_despesas: 4, odometro: 5, outro: 6,
};

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

1. PEDAGIO E ESTACIONAMENTO - TRANSCREVA, NAO SOME.
   Copie para "passagens" CADA passagem de pedagio e cada estacionamento dos
   comprovantes (Sem Parar, ConectCar, Tag Itau, Veloe, Ultrapasse, C6 Tag, cupons
   avulsos), uma linha por lancamento, com a data e o valor escritos no documento.
   Transcreva TODAS, de qualquer dia - inclusive fim de semana, feriado e outro
   mes. Nao filtre, nao some, nao arredonde e nao compare com o declarado: quem
   soma e decide o que entra e o sistema. Se o valor nao estiver legivel, deixe a
   passagem de fora e diga isso num achado.
   NAO sao passagens (va para "itens_ignorados"): mensalidade do plano, IOF, "dias
   de uso da tag", negociacao de divida, recarga de saldo, taxa de envio da tag,
   multa.
   Nao escreva achado sobre diferenca entre declarado e comprovado - o sistema
   faz essa conta com a sua transcricao.
   Duas passagens na mesma praca no mesmo dia sao o NORMAL: o colaborador vai ao
   cliente e volta para casa. Transcreva as duas, cada uma com o valor da SUA
   linha (nao o total do dia), e NAO escreva achado sobre isso.
   Nenhum achado sobre pedagio pode ter gravidade "erro".

1.1 HORA DAS PASSAGENS. Preencha "hora" com a hora que esta ESCRITA no extrato
   para aquela passagem. Nao estime pela ordem das linhas e nao deduza do
   trajeto: sem hora legivel, deixe "hora" vazio. Nao escreva achado nenhum
   sobre horario - quem decide se hora tardia vira pendencia e a regra do
   sistema, que nao vale para todas as empresas.

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

5. ASSINATURA EM CIMA DA PLACA. No proprio RDV (o anexo marcado como "relatorio
   RDV"), veja se o selo/carimbo da assinatura digital do gov.br, ou qualquer
   assinatura, esta sobreposto ao campo da PLACA do veiculo, cobrindo o numero
   da placa no todo ou em parte. Responda em "assinatura_sobre_placa":
   "sim" se cobre, "nao" se a placa esta visivel, "sem_rdv" se nao veio o RDV
   ou ele nao tem campo de placa. So "sim" com a sobreposicao clara na imagem.
   O selo na caixa de assinatura logo ABAIXO da linha da placa, com o numero
   da placa inteiro e legivel, e "nao": encostado nao e em cima.
   Nao escreva achado sobre isso - o sistema cria a pendencia.

6. O RDV ESTA ASSINADO? Olhe a caixa de assinatura do RDV ("ASSINATURA POR
   EXTENSO"). Responda em "rdv_assinado": "sim" se ha o selo do gov.br OU uma
   assinatura feita a mao (caneta no papel escaneado/fotografado, ou desenhada
   por cima do arquivo); "nao" se a caixa esta em branco; "sem_rdv" se nao
   veio o RDV. Nome digitado em letra de computador nao e assinatura.
   Nao escreva achado sobre isso - o sistema cria a pendencia.

Regras de julgamento:
- Falta da nota de abastecimento: NAO escreva achado. Quem decide se a falta
  reprova e o sistema (so reprova gerente). Apenas responda
  tem_danfe_de_abastecimento.
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
      passagens: {
        type: 'array',
        description:
          'CADA passagem de pedagio e cada estacionamento dos comprovantes, uma por lancamento, '
          + 'de qualquer dia. Transcreva - nao some, nao filtre. Lista vazia se nao houver '
          + 'comprovante legivel.',
        items: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'AAAA-MM-DD, como esta no comprovante' },
            hora: {
              type: 'string',
              description: 'HH:MM como esta escrito no extrato. Vazio se o documento nao mostra a hora.',
            },
            valor: { type: 'number', description: 'Em reais, exatamente como no documento' },
            local: { type: 'string', description: 'praca ou estabelecimento, como esta no documento' },
            tipo: { type: 'string', enum: ['pedagio', 'estacionamento'] },
          },
          required: ['data', 'hora', 'valor', 'local', 'tipo'],
          additionalProperties: false,
        },
      },
      assinatura_sobre_placa: {
        type: 'object',
        properties: {
          situacao: { type: 'string', enum: ['sim', 'nao', 'sem_rdv'] },
          anexo: {
            type: 'string',
            description: 'Nome do arquivo do RDV, copiado do rotulo "--- Anexo: <nome> ---". Vazio se sem_rdv.',
          },
        },
        required: ['situacao', 'anexo'],
        additionalProperties: false,
      },
      rdv_assinado: {
        type: 'string',
        description: 'O RDV tem assinatura - selo do gov.br ou a mao? "sem_rdv" se o RDV nao veio.',
        enum: ['sim', 'nao', 'sem_rdv'],
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
      'passagens',
      'assinatura_sobre_placa',
      'rdv_assinado',
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
    // PDF que nao vai inteiro - grande demais, ou com mais paginas do que cabe -
    // vai pagina a pagina, cada uma como foto encolhida. E o PDF de aplicativo
    // de escanear: dezenas de fotos de cupom ou de painel num arquivo de 15 MB.
    // Antes ele era descartado inteiro ("grande demais") e ninguem lia nada.
    //
    // O PowerPoint (.pptx) vai sempre assim: a API nao le o arquivo, mas le as
    // fotos que a pessoa colou nos slides.
    const extDoAnexo = path.extname(a.nome_original).toLowerCase();
    const ehPptx = extDoAnexo === '.pptx';
    if (extDoAnexo === '.pdf' || ehPptx) {
      const fotosDoSlide = ehPptx ? await pptxEmFotos(caminho) : null;
      const paginasDoArquivo = ehPptx ? fotosDoSlide.length : await paginasDoPdf(caminho);
      const naoVaiInteiro = ehPptx
        || tamanho > LIMITE_POR_ANEXO
        || acumulado + tamanho > LIMITE_TOTAL
        || imagens + paginasDoArquivo > MAX_IMAGENS;
      if (naoVaiInteiro && (ehPptx || !(await pdfProtegido(caminho)))) {
        const vagas = MAX_IMAGENS - imagens;
        const fotos = vagas <= 0 ? []
          : ehPptx ? fotosDoSlide.slice(0, vagas)
            : await pdfEmFotos(caminho, Math.min(paginasDoArquivo, vagas));
        const cabem = [];
        for (const f of fotos) {
          if (acumulado + f.bytes > LIMITE_TOTAL) break;
          acumulado += f.bytes;
          cabem.push(f);
        }
        if (cabem.length) {
          conteudo.push({
            type: 'text',
            text: `\n--- Anexo: ${a.nome_original} (marcado pelo colaborador como "${rotulo(a.tipo)}"; `
              + `${ehPptx ? 'PowerPoint enviado foto a foto' : 'PDF enviado pagina a pagina'}, ${cabem.length} de ${paginasDoArquivo}) ---`,
          });
          for (const f of cabem) {
            conteudo.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 } });
          }
          imagens += cabem.length;
          if (cabem.length < paginasDoArquivo) {
            ignorar(a, `so as ${cabem.length} primeiras ${ehPptx ? 'fotos' : 'paginas'} de ${paginasDoArquivo} couberam na conferencia`);
          }
          continue;
        }
        if (ehPptx) {
          ignorar(a, fotosDoSlide.length ? 'as fotos do PowerPoint nao couberam na conferencia' : 'PowerPoint sem nenhuma foto dentro');
          continue;
        }
        // Nao deu para desenhar as paginas: segue pelas regras de sempre.
      }
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
  // Stream so porque o SDK exige acima de ~21 mil tokens de saida; a resposta
  // final e a mesma de um create.
  let resposta;
  try {
    resposta = await cliente.messages
      .stream(
        {
          model: modelo,
          max_tokens: 32000, // a transcricao passagem a passagem de um extrato cheio e longa
          ...pensamentoDoModelo(modelo),
          system: INSTRUCOES,
          messages: [{ role: 'user', content: conteudo }],
          tools: [FERRAMENTA],
          tool_choice: { type: 'tool', name: 'registrar_parecer' },
        },
        { timeout: TEMPO_LIMITE, maxRetries: 2 },
      )
      .finalMessage();
  } catch (e) {
    // O que chega aqui e mensagem de biblioteca ("Request was aborted"), que
    // nao diz a ninguem o que fazer. Vira recado em portugues, e o log guarda
    // o erro cru para quem for investigar.
    const estourou = e?.name === 'APIConnectionTimeoutError' || /timeout|aborted/i.test(String(e?.message));
    log.falha('ia', estourou ? 'conferencia estourou o tempo' : 'chamada da IA falhou', e, {
      rel: rel.id, modelo, tempo: log.desde(comeco),
    });
    throw new Error(
      estourou
        ? `A conferencia passou de ${Math.round(TEMPO_LIMITE / 60000)} minutos e foi cancelada. `
          + 'Quase sempre e comprovante demais ou foto pesada demais: peca arquivos menores e confira de novo.'
        : `A IA nao respondeu: ${String(e?.message || e).slice(0, 200)}`,
    );
  }

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

  // A IA transcreveu; a soma e a escolha do que entra sao do sistema. O
  // parecer continua com `pedagio_comprovado` e `passagens_apos_18h` porque o
  // resto do portal (painel, regra das 18h) le esses dois campos.
  const parecer = bloco.input;
  const soma = somarExtrato(parecer.passagens, linhas, rel.mes_ref);
  parecer.pedagio_comprovado = soma.total;
  parecer.passagens_fora = soma.fora;
  parecer.passagens_contadas = soma.contadas;
  parecer.passagens_apos_18h = soma.contadas.filter((p) => {
    const hora = String(p.hora || '').trim();
    return /^\d{1,2}:\d{2}$/.test(hora) && Number(hora.split(':')[0]) >= 18;
  });

  return {
    parecer,
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
      rdv: 'relatorio RDV',
      pedagio: 'comprovante de pedagio/estacionamento',
      danfe: 'nota de abastecimento',
      hotel: 'nota do hotel',
      outras_despesas: 'comprovante de outras despesas',
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
    resultadoRegra.gerente
      ? 'GERENTE: e reembolsado pelo COMBUSTIVEL abastecido, nao pelo km. O km e as fotos de odometro continuam valendo como controle. O sistema ja conferiu a soma do combustivel contra as notas (valor digitado em cada nota) - nao refaca essa conta.'
      : `Valor pago por km: R$ ${vlrKm.toFixed(2).replace('.', ',')}`,
    '',
    'DECLARADO NO RELATORIO:',
    `  Total de km: ${resultadoRegra.totalKm}`,
    resultadoRegra.gerente
      ? `  Combustivel do mes: R$ ${resultadoRegra.totalCombustivel.toFixed(2).replace('.', ',')}`
      : `  Valor do km: R$ ${resultadoRegra.valorKm.toFixed(2).replace('.', ',')}`,
    `  Pedagio: R$ ${resultadoRegra.pedagioDeclarado.toFixed(2).replace('.', ',')}`,
    `  Estacionamento: R$ ${resultadoRegra.estacDeclarado.toFixed(2).replace('.', ',')}`,
    `  Pedagio + estacionamento: R$ ${resultadoRegra.totalDeclarado.toFixed(2).replace('.', ',')}`,
    // Hotel e outras despesas so aparecem quando existem. Escrever "R$ 0,00"
    // em todo relatorio ensina o modelo a procurar comprovante que nao ha.
    ...(resultadoRegra.hotelDeclarado > 0
      ? [`  Hotel: R$ ${resultadoRegra.hotelDeclarado.toFixed(2).replace('.', ',')}`]
      : []),
    ...(resultadoRegra.outrosDeclarado > 0
      ? [
          `  Outras despesas: R$ ${resultadoRegra.outrosDeclarado.toFixed(2).replace('.', ',')}`
            + (rel.outros_descricao ? ` (${rel.outros_descricao})` : ''),
        ]
      : []),
    '',
    'LANCAMENTOS DIA A DIA:',
  ];

  const corpo = linhas.map((l) => {
    const rodou = Number(l.km_final) - Number(l.km_inicial);
    const extras = [];
    if (Number(l.pedagio) > 0) extras.push(`pedagio R$ ${Number(l.pedagio).toFixed(2)}`);
    if (Number(l.estacionamento) > 0)
      extras.push(`estac. R$ ${Number(l.estacionamento).toFixed(2)}`);
    if (Number(l.combustivel) > 0)
      extras.push(`abasteceu R$ ${Number(l.combustivel).toFixed(2)}`);
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

// As fotos coladas num PowerPoint, em jpeg e dentro do lado maximo da API.
async function pptxEmFotos(caminho) {
  try {
    const { fotosDoPptx } = await import('./pptx.js');
    const { default: sharp } = await import('sharp');
    const fotos = [];
    for (const f of await fotosDoPptx(caminho, MAX_IMAGENS)) {
      try {
        const jpg = await sharp(f.dados, { failOn: 'none' })
          .rotate()
          .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        fotos.push({ base64: jpg.toString('base64'), bytes: jpg.length });
      } catch {
        // imagem do slide que o sharp nao abre: fica de fora
      }
    }
    return fotos;
  } catch (e) {
    log.aviso('ia', 'nao consegui abrir o PowerPoint', { arquivo: path.basename(caminho), erro: e.message });
    return [];
  }
}

// As paginas de um PDF como fotos em jpeg, ja dentro do lado maximo da API.
async function pdfEmFotos(caminho, maxPaginas) {
  try {
    const { paginasDoPdfComoImagem } = await import('./ocr.js');
    const { default: sharp } = await import('sharp');
    const fotos = [];
    for (const png of await paginasDoPdfComoImagem(caminho, maxPaginas)) {
      const jpg = await sharp(png)
        .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      fotos.push({ base64: jpg.toString('base64'), bytes: jpg.length });
    }
    return fotos;
  } catch (e) {
    log.aviso('ia', 'nao consegui abrir o PDF pagina a pagina', { arquivo: path.basename(caminho), erro: e.message });
    return [];
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
