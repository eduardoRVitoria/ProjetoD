// MODO DEMONSTRACAO - nao chama a API e nao le comprovante nenhum.
//
// Existe para voce testar e apresentar o fluxo completo (botao de conferir,
// tela de parecer, mudanca de status, recado chegando no colaborador) sem
// gastar credito. O parecer sai coerente com os dados reais do relatorio,
// mas e INVENTADO: os valores dos comprovantes nao foram lidos.
//
// Todo parecer daqui sai com simulado = true, e a interface mostra isso em
// vermelho. Nunca use para aprovar RDV de verdade.

const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

export function conferirEmDemo({ rel, linhas, anexos, resultadoRegra }) {
  const temPedagio = anexos.some((a) => a.tipo === 'pedagio');
  const temDanfe = anexos.some((a) => a.tipo === 'danfe');
  const fotos = anexos.filter((a) => a.tipo === 'odometro');
  const declarado = resultadoRegra.totalDeclarado;

  const achados = [];

  // Finge que leu o extrato: bate certinho quando ha comprovante.
  const comprovado = temPedagio ? declarado : 0;
  if (declarado > 0 && !temPedagio) {
    achados.push({
      gravidade: 'erro',
      mensagem: `[SIMULADO] Declarou ${brl(declarado)} de pedagio/estacionamento e nao ha extrato anexado para conferir.`,
    });
  }

  if (!temDanfe) {
    achados.push({
      gravidade: 'erro',
      mensagem: '[SIMULADO] Nao ha nota de abastecimento entre os anexos.',
    });
  }

  // Odometro: compara a quantidade de fotos com as semanas trabalhadas.
  const semanas = new Set(
    linhas
      .filter((l) => Number(l.km_final) - Number(l.km_inicial) > 0)
      .map((l) => Math.floor(new Date(`${l.data}T12:00:00Z`).getTime() / (7 * 86400_000))),
  ).size;

  let confere = 'sem_foto';
  let obsOdometro = 'Nenhuma foto de odometro foi anexada.';
  if (fotos.length > 0) {
    const esperado = semanas * 2;
    if (fotos.length >= esperado) {
      confere = 'sim';
      obsOdometro = `${fotos.length} foto(s) para ${semanas} semana(s) trabalhada(s).`;
    } else {
      confere = 'parcial';
      obsOdometro = `${fotos.length} foto(s) para ${semanas} semana(s) - o esperado seria ${esperado} (segunda de manha e sexta a noite).`;
      achados.push({
        gravidade: 'aviso',
        mensagem: `[SIMULADO] Faltam fotos de odometro: ${fotos.length} enviadas, ${esperado} esperadas.`,
      });
    }
  }

  const erros = achados.filter((a) => a.gravidade === 'erro');
  const errosRegra = resultadoRegra.achados.filter((a) => a.gravidade === 'erro');
  const todosErros = [...errosRegra, ...erros];
  const soDanfe =
    todosErros.length === 1 &&
    (todosErros[0].codigo === 'sem_danfe' || /nota de abastecimento/i.test(todosErros[0].mensagem));

  const status = todosErros.length === 0 ? 'CERTA' : soDanfe ? 'SO_FALTA_DANFE' : 'ERRADA';

  const oQueFazer =
    status === 'CERTA'
      ? ''
      : status === 'SO_FALTA_DANFE'
        ? 'Envie a nota fiscal do abastecimento do mes. O resto do relatorio esta correto.'
        : todosErros.map((e) => e.mensagem.replace('[SIMULADO] ', '')).join(' ');

  return {
    simulado: true,
    pedagio_comprovado: comprovado,
    itens_ignorados: [],
    tem_danfe_de_abastecimento: temDanfe,
    odometro: {
      fotos_lidas: fotos.length,
      confere_com_o_rdv: confere,
      observacao: `[SIMULADO - as fotos nao foram lidas] ${obsOdometro}`,
    },
    achados,
    status,
    resumo:
      'PARECER SIMULADO. Nenhum comprovante foi aberto ou lido - este resultado serve so ' +
      'para testar o funcionamento da tela. Configure a chave da API para a conferencia real.',
    o_que_fazer: oQueFazer,
  };
}
