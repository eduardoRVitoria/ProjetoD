// Motor de conferencia por regra - roda sem IA e sem custo nenhum.
// Cobre os passos que sao pura aritmetica e calendario. O que depende de ler
// comprovante (somar extrato de pedagio, reconhecer DANFE, ler foto de odometro)
// fica para o modulo de IA em ia.js.

import { fimDeSemana, nomeDoFeriado, diaDaSemana } from './feriados.js';
import { MARGEM_AUMENTO } from './banco.js';

// Acima disto o painel nao "andou": alguem digitou errado, fotografou outro
// carro, ou lancou dia de outro mes. Um vendedor rodando o mes inteiro faz uns
// 3 mil km, entao 2 mil de uma vez ja e fora da realidade do trabalho.
const SALTO_IMPOSSIVEL = 2000;

// Quanto o carro pode rodar fora do trabalho entre dois lancamentos sem que
// isso chame atencao. Fim de semana com viagem particular cabe aqui.
const USO_PARTICULAR_ESPERADO = 600;

// A foto do painel e do inicio ou do fim do dia, entao a leitura tem que cair
// dentro do que o RDV registra naquele dia. A folga cobre o trecho entre tirar
// a foto e comecar a rodar - casa, posto, primeira visita.
const FOLGA_DA_FOTO = 30;

// A partir desta hora, pedagio e estacionamento pedem explicacao: e despesa
// fora do expediente, e sem motivo escrito ninguem consegue julgar depois.
const HORA_LIMITE = 18;

// Versao das regras de conferencia.
//
// Sobe UM numero sempre que uma regra mudar o que reprova ou o que perdoa. O
// parecer guarda a versao em que foi julgado, e o painel marca quem ficou para
// tras - senao um relatorio aprovado com regra antiga fica identico a um
// aprovado agora, e so se descobre quando alguem reclama. Foi assim que a
// divergencia de km da Laís passou batida.
//
//   1  regras originais
//   2  salto impossivel de odometro, foto contra o dia dela, fotos em ordem
//   3  diferenca de pedagio na primeira conferencia; passagem depois das 18h
//   4  a DISO saiu da regra das 18h (as outras empresas continuam nela)
//
// A 4 perdoa: quem da DISO foi reprovado so por despesa noturna aparece no
// painel como "regras antigas" e merece uma reconferencia.
export const VERSAO_REGRAS = 4;

const CENTAVO = 0.01;
const perto = (a, b, tol = CENTAVO) => Math.abs(a - b) <= tol;
const brl = (v) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function achado(gravidade, codigo, mensagem, data = null) {
  return { gravidade, codigo, mensagem, data };
}

/**
 * Passagens depois do expediente que ainda nao foram explicadas.
 *
 * A hora vem do EXTRATO lido pela IA, nao do que a pessoa digita - por isso
 * mora fora do `conferir`, que roda antes da leitura. Cada passagem e cobrada
 * contra a explicacao do dia dela (`justificativa_hora` da linha), entao o
 * vendedor responde no proprio dia em que a despesa caiu.
 */
export function passagensSemExplicacao(passagens, linhas, empresa = null) {
  // A DISO nao cobra explicacao por horario. O que a regra tem em maos e o
  // nome do estabelecimento e a hora que o extrato da tag registrou - e a DISO
  // decidiu que isso sozinho nao acusa ninguem. As outras empresas continuam
  // cobrando, entao a regra fica de pe e so essa empresa sai dela.
  //
  // Sem `empresa` a regra vale: quem nao disse de quem e o relatorio nao ganha
  // a isencao de graca.
  if (empresa === 'DISO') return [];

  const explicacaoDoDia = new Map(
    linhas.map((l) => [l.data, String(l.justificativa_hora || '').trim()]),
  );

  return (passagens || [])
    .filter((p) => {
      const hora = String(p?.hora || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(hora)) return false;
      if (Number(hora.split(':')[0]) < HORA_LIMITE) return false;
      return !explicacaoDoDia.get(p.data);
    })
    .map((p) =>
      achado(
        'erro',
        'despesa_noturna_sem_justificativa',
        `${dataBr(p.data)} as ${p.hora}: ${brl(Number(p.valor || 0))} em `
          + `${String(p.local || 'pedagio/estacionamento').slice(0, 40)}, depois das `
          + `${HORA_LIMITE}h. Explique o motivo desse horario no dia ${dataBr(p.data)}.`,
        p.data,
      ),
    );
}

/**
 * Declarado bate com o comprovado? Devolve o achado, ou null quando bate.
 *
 * Fica fora do `conferir` porque precisa ser chamada DEPOIS da IA. A regra
 * dentro do conferir le `rel.pedagio_comprovado`, e quem preenche esse campo e
 * a propria conferencia, com o que a IA acabou de ler no extrato. Na primeira
 * passada ele ainda e NULL - o envio zera - entao a comparacao nao acontecia e
 * um RDV com diferenca de verdade saia APROVADO. So reprovava se alguem
 * clicasse "Conferir de novo", quando o campo ja tinha valor da vez anterior.
 *
 * Qualquer centavo conta: `dif` ja vem arredondado em duas casas, entao
 * diferente de zero e diferenca de verdade.
 */

export function diferencaDePedagio(declarado, comprovado) {
  if (comprovado == null) return null;
  const dif = Number((Number(comprovado) - Number(declarado)).toFixed(2));
  if (dif === 0) return null;
  return achado(
    'erro',
    'pedagio_diferenca',
    `Declarado ${brl(Number(declarado))} em pedagio/estacionamento, comprovado `
      + `${brl(Number(comprovado))}. Diferenca de ${brl(dif)}.`,
  );
}

// Itinerarios que explicam legitimamente um dia com 0 km.
const SEM_DESLOCAMENTO =
  /home\s*office|feriado|folga|ferias|f[eé]rias|atestado|licen[cç]a|falta|treinamento\s+online|reuni[aã]o\s+online|escrit[oó]rio|sem\s+visita/i;

// Os dois dias sao uteis e consecutivos? Se houver fim de semana ou feriado no
// meio, o carro rodou por conta propria e a diferenca de hodometro e esperada.
function diasSeguidos(dataAnterior, dataAtual) {
  const a = new Date(`${dataAnterior}T12:00:00Z`);
  const b = new Date(`${dataAtual}T12:00:00Z`);
  for (let d = new Date(a.getTime() + 86400_000); d < b; d = new Date(d.getTime() + 86400_000)) {
    const iso = d.toISOString().slice(0, 10);
    if (fimDeSemana(iso) || nomeDoFeriado(iso)) return false;
  }
  return true;
}

/**
 * Confere um relatorio inteiro.
 * @param {object} rel     linha da tabela relatorios
 * @param {Array}  linhas  linhas do RDV, em ordem de data
 * @param {Array}  anexos  anexos ja enviados
 * @param {number} vlrKm   valor pago por km (padrao 0,90)
 */
export function conferir(rel, linhas, anexos, vlrKm = 0.9, mesAnterior = null) {
  const achados = [];

  // Mes em branco nao tem o que conferir.
  //
  // Sem esta saida, um login novo abria a aba Conferencia ja com duas
  // pendencias em vermelho - "falta a DANFE" e "falta foto do odometro". As
  // duas sao cobrancas de ANEXO: nao dependem de nenhum lancamento, entao
  // disparavam sozinhas num mes em que a pessoa ainda nao tinha digitado nada.
  // Todo o resto do motor depende de `linhas` ou de valor declarado, e por isso
  // ficava quieto - era sempre esse par, sempre no primeiro acesso.
  if (linhas.length === 0 && anexos.length === 0) {
    return {
      totalKm: 0,
      valorKm: 0,
      totalDoMes: 0,
      comparacao: null,
      pedagioDeclarado: 0,
      estacDeclarado: 0,
      totalDeclarado: 0,
      temDanfe: false,
      qtdFotosOdometro: 0,
      achados: [],
      statusSugerido: 'CERTA',
    };
  }

  // ---------------------------------------------------------------- 1. datas
  for (const l of linhas) {
    const rodou = Number(l.km_final) - Number(l.km_inicial);
    const fds = fimDeSemana(l.data);
    const feriado = nomeDoFeriado(l.data);

    if (fds && (rodou > 0 || Number(l.pedagio) > 0 || Number(l.estacionamento) > 0)) {
      achados.push(
        achado(
          'erro',
          'data_fim_de_semana',
          `${dataBr(l.data)} caiu num ${fds} e tem lancamento (${rodou} km, ${brl(
            Number(l.pedagio) + Number(l.estacionamento),
          )}). Despesa de fim de semana nao entra no RDV.`,
          l.data,
        ),
      );
    }

    if (feriado && rodou > 0) {
      achados.push(
        achado(
          'aviso',
          'data_feriado',
          `${dataBr(l.data)} e feriado (${feriado}) e tem ${rodou} km lancados. Confirme se realmente trabalhou.`,
          l.data,
        ),
      );
    }
  }

  // ------------------------------------------------------------- 2. km/linha
  for (const l of linhas) {
    const ki = Number(l.km_inicial);
    const kf = Number(l.km_final);
    const itin = String(l.itinerario || '').trim();

    if (kf < ki) {
      achados.push(
        achado(
          'erro',
          'km_invertido',
          `${dataBr(l.data)}: KM final (${kf}) menor que o inicial (${ki}).`,
          l.data,
        ),
      );
    }

    if (kf > ki && !itin) {
      achados.push(
        achado(
          'erro',
          'itinerario_vazio',
          `${dataBr(l.data)}: ${kf - ki} km lancados sem itinerario. Descreva o trajeto.`,
          l.data,
        ),
      );
    }

    // "0 km com itinerario" so e suspeito quando o itinerario descreve trajeto.
    // HOME OFFICE, FERIADO, FOLGA e afins com 0 km estao certos - avisar seria
    // ruido em cima de quem preencheu direito.
    if (kf === ki && itin && !fimDeSemana(l.data) && !SEM_DESLOCAMENTO.test(itin)) {
      achados.push(
        achado(
          'aviso',
          'km_zerado',
          `${dataBr(l.data)}: tem itinerario preenchido mas 0 km. Faltou o KM?`,
          l.data,
        ),
      );
    }
  }

  // ------------------------------------------- 3. continuidade do hodometro
  const comKm = linhas.filter((l) => Number(l.km_final) > 0 || Number(l.km_inicial) > 0);
  for (let i = 1; i < comKm.length; i++) {
    const ant = comKm[i - 1];
    const at = comKm[i];
    const inicio = Number(at.km_inicial);
    const fimAnterior = Number(ant.km_final);

    if (inicio < fimAnterior) {
      // Quase sempre e um segundo veiculo, nao fraude - por isso e aviso.
      achados.push(
        achado(
          'aviso',
          'hodometro_retrocedeu',
          `${dataBr(at.data)}: o KM inicial (${inicio}) e menor que o KM final do dia anterior (${fimAnterior}). Se voce usa mais de um veiculo, declare as placas.`,
          at.data,
        ),
      );
    } else if (inicio > fimAnterior) {
      const lacuna = inicio - fimAnterior;

      // O fim de semana explica uso particular, nao qualquer numero.
      //
      // Este filtro existia para nao acusar toda segunda-feira: o carro roda no
      // sabado e no domingo, e essa diferenca nao entra no RDV. So que ele
      // desligava a checagem por completo, e um salto de 67.868 km entre a
      // sexta e a segunda passou como se fosse um passeio de fim de semana.
      //
      // Agora o fim de semana justifica ate um limite. Acima dele nao existe
      // explicacao inocente - e digito trocado no painel, foto de outro
      // veiculo, ou lancamento de outro mes - e vira erro, que trava o envio.
      if (lacuna > SALTO_IMPOSSIVEL) {
        achados.push(
          achado(
            'erro',
            'hodometro_salto',
            `${dataBr(at.data)}: o KM inicial (${inicio.toLocaleString('pt-BR')}) esta `
              + `${lacuna.toLocaleString('pt-BR')} km acima do KM final de ${dataBr(ant.data)} `
              + `(${fimAnterior.toLocaleString('pt-BR')}). Confira se o numero foi digitado certo.`,
            at.data,
          ),
        );
      } else if (diasSeguidos(ant.data, at.data) && lacuna > 1) {
        // Dias uteis colados: nao ha fim de semana para explicar a diferenca.
        achados.push(
          achado(
            'aviso',
            'hodometro_lacuna',
            `${dataBr(at.data)}: o KM inicial (${inicio}) esta ${lacuna} km acima do KM final do dia util anterior (${fimAnterior}). Esses ${lacuna} km rodaram sem estar lancados.`,
            at.data,
          ),
        );
      } else if (lacuna > USO_PARTICULAR_ESPERADO) {
        // Tem fim de semana no meio, mas rodar isso tudo fora do trabalho e
        // muito - vale a pessoa confirmar, sem travar o envio.
        achados.push(
          achado(
            'aviso',
            'hodometro_lacuna_grande',
            `${dataBr(at.data)}: o painel andou ${lacuna.toLocaleString('pt-BR')} km desde `
              + `${dataBr(ant.data)} sem lancamento. Confirme se nao faltou lancar algum dia.`,
            at.data,
          ),
        );
      }
    }
  }

  // -------------------------------------------------------------- 4. totais
  const totalKm = linhas.reduce(
    (s, l) => s + Math.max(0, Number(l.km_final) - Number(l.km_inicial)),
    0,
  );
  const valorKm = Number((totalKm * vlrKm).toFixed(2));

  // Quando o RDV veio de PDF, o total que vale para a comparacao e o que a
  // PESSOA escreveu no documento, nao o que o sistema gravou. E aqui que o erro
  // de conta aparece - ele nao e mais evitado na origem, entao tem que ser pego.
  const doPdf = rel.extraido ? JSON.parse(rel.extraido) : null;
  const declaradoKm = doPdf?.totais_declarados?.total_km ?? Number(rel.total_km);
  const declaradoValor = doPdf?.totais_declarados?.valor_total_km ?? Number(rel.valor_km);

  if (declaradoKm != null && !perto(totalKm, Number(declaradoKm), 0.5)) {
    const dif = totalKm - Number(declaradoKm);
    achados.push(
      achado(
        'erro',
        'soma_km',
        `A soma dos dias da ${totalKm} km, mas o relatorio declara ${declaradoKm} km. ` +
          `Diferenca de ${dif > 0 ? '+' : ''}${dif.toFixed(0)} km.`,
      ),
    );
  }

  if (declaradoValor != null && !perto(valorKm, Number(declaradoValor))) {
    achados.push(
      achado(
        'erro',
        'valor_km',
        `${totalKm} km x ${brl(vlrKm)} = ${brl(valorKm)}, mas o relatorio declara ${brl(
          Number(declaradoValor),
        )}.`,
      ),
    );
  }

  // A leitura do documento pode ter falhado - isso precisa aparecer, senao a
  // conferencia julga em cima de dado que ninguem conferiu.
  if (doPdf) {
    if (doPdf.confianca === 'baixa') {
      achados.push(
        achado(
          'erro',
          'leitura_incerta',
          'A leitura do arquivo do RDV ficou incerta. Confira os dias extraidos antes de aprovar, ou peca o relatorio em PDF legivel.',
        ),
      );
    } else if (doPdf.confianca === 'media') {
      achados.push(
        achado(
          'aviso',
          'leitura_parcial',
          'A leitura do arquivo do RDV teve pontos duvidosos. Vale conferir os dias extraidos.',
        ),
      );
    }
    for (const p of doPdf.problemas_de_leitura || []) {
      achados.push(achado('aviso', 'leitura_problema', p));
    }
    if (linhas.length === 0) {
      achados.push(
        achado(
          'erro',
          'sem_linhas',
          'Nenhum lancamento foi encontrado no arquivo do RDV. Confira se anexou o relatorio certo.',
        ),
      );
    }
  }

  // ------------------------------------------------- 5. pedagio/estacionamento
  const pedagioLinhas = linhas.reduce((s, l) => s + Number(l.pedagio || 0), 0);
  const estacLinhas = linhas.reduce((s, l) => s + Number(l.estacionamento || 0), 0);

  // O formulario de RDV normalmente nao tem coluna de pedagio por dia - traz so
  // "PEDAGIO + ESTACIONAMENTO" no quadro de resumo. Quando for esse o caso, o
  // valor declarado e o do quadro, nao a soma (que seria zero).
  const agregadoDoPdf = doPdf?.totais_declarados?.pedagio_estacionamento;
  const somaDasLinhas = Number((pedagioLinhas + estacLinhas).toFixed(2));
  const declarado =
    somaDasLinhas > 0 ? somaDasLinhas : Number((agregadoDoPdf ?? 0).toFixed(2));

  const temComprovantePedagio = anexos.some((a) => a.tipo === 'pedagio');
  if (declarado > 0 && !temComprovantePedagio) {
    achados.push(
      achado(
        'erro',
        'pedagio_sem_comprovante',
        `Voce declarou ${brl(declarado)} de pedagio/estacionamento mas nao anexou nenhum comprovante.`,
      ),
    );
  }

  {
    const d = diferencaDePedagio(declarado, rel.pedagio_comprovado);
    if (d) achados.push(d);
  }

  // -------------------------------------------------------- 6. abastecimento
  const temDanfe = anexos.some((a) => a.tipo === 'danfe');
  if (!temDanfe) {
    achados.push(
      achado('erro', 'sem_danfe', 'Nao foi enviada a nota/DANFE de abastecimento do mes.'),
    );
  }

  // -------------------------------------------------------- 7. odometro
  const fotos = anexos.filter((a) => a.tipo === 'odometro');
  const faltando = semanasSemFoto(linhas, fotos);
  if (fotos.length === 0) {
    achados.push(
      achado(
        'erro',
        'sem_odometro',
        'Nao foi enviada nenhuma foto do odometro. E preciso a foto de segunda de manha e a de sexta a noite de cada semana.',
      ),
    );
  } else if (faltando.length > 0) {
    // O texto antigo dizia "9 fotos, menos que as 2 esperadas" - `faltando`
    // conta as semanas que FALTAM, nao o total esperado. Dava uma frase que se
    // contradizia sozinha e nao ajudava ninguem.
    const semanas = semanasTrabalhadas(linhas);
    achados.push(
      achado(
        'aviso',
        'odometro_incompleto',
        `${fotos.length} foto(s) de odometro para ${semanas} semana(s) trabalhada(s). `
          + 'O esperado sao duas por semana: segunda de manha e sexta a noite.',
      ),
    );
  }

  // ------------------------------------------- 7.1 cada foto contra o SEU dia
  //
  // A checagem que faltava. Ate aqui a foto era comparada com o intervalo do
  // MES inteiro - do menor ao maior km do RDV, com 50 km de folga -, entao uma
  // leitura que nao batia com o proprio dia passava batido desde que caisse em
  // algum lugar do mes. E o dia e justamente onde a divergencia aparece.
  const comData = fotos.filter((f) => f.data_leitura && Number(f.km) > 0);
  const linhaDoDia = new Map(linhas.map((l) => [l.data, l]));

  for (const f of comData) {
    const km = Number(f.km);
    const l = linhaDoDia.get(f.data_leitura);

    // Dia que o RDV nao lista.
    //
    // Aqui a pergunta NAO pode ser "esse dia foi lancado?". Dia sem
    // quilometragem nao vira linha - o salvarRelatorio descarta dia em branco -,
    // entao home office, folga, atestado e feriado nunca estao na lista. E a
    // foto de sexta as 23h50 o celular costuma datar no sabado. Nos tres casos
    // o vendedor fez tudo certo e era acusado de nao ter lancado o dia.
    //
    // A pergunta certa e "essa leitura bate com o RDV?". Se o numero couber
    // entre o km do dia lancado anterior e o do seguinte, o painel esta
    // coerente e nao ha o que falar. So sobra recado quando ele nao encaixa em
    // lugar nenhum - ai e digito trocado, outro veiculo, ou outro mes.
    if (!l) {
      if (!String(f.data_leitura).startsWith(rel.mes_ref)) {
        achados.push(
          achado(
            'erro',
            'foto_de_outro_mes',
            `Foto de odometro de ${dataBr(f.data_leitura)} num relatorio de `
              + `${String(rel.mes_ref).split('-').reverse().join('/')}. Confira a data da foto.`,
            f.data_leitura,
          ),
        );
        continue;
      }

      const antes = linhas.filter((x) => x.data < f.data_leitura);
      const depois = linhas.filter((x) => x.data > f.data_leitura);
      const piso = antes.length
        ? Math.min(...antes.map((x) => Number(x.km_inicial))) - FOLGA_DA_FOTO
        : -Infinity;
      const teto = depois.length
        ? Math.max(...depois.map((x) => Number(x.km_final))) + FOLGA_DA_FOTO
        : Infinity;

      if (km < piso || km > teto) {
        achados.push(
          achado(
            'aviso',
            'foto_fora_da_sequencia',
            `Foto de odometro de ${dataBr(f.data_leitura)} marca `
              + `${km.toLocaleString('pt-BR')} km, fora da sequencia do mes no RDV. `
              + 'Confira a data e o numero da foto.',
            f.data_leitura,
          ),
        );
      }
      continue;
    }

    const ki = Number(l.km_inicial);
    const kf = Number(l.km_final);
    if (!(ki > 0 || kf > 0)) continue;

    const menor = Math.min(ki, kf) - FOLGA_DA_FOTO;
    const maior = Math.max(ki, kf) + FOLGA_DA_FOTO;

    if (km < menor || km > maior) {
      const dif = km < menor ? menor - km : km - maior;
      achados.push(
        achado(
          'erro',
          'foto_nao_bate_com_o_dia',
          `${dataBr(f.data_leitura)}: a foto do painel marca ${km.toLocaleString('pt-BR')} km, `
            + `mas o RDV lanca de ${ki.toLocaleString('pt-BR')} a ${kf.toLocaleString('pt-BR')} `
            + `nesse dia. Diferenca de ${dif.toLocaleString('pt-BR')} km.`,
          f.data_leitura,
        ),
      );
    }
  }

  // ------------------------------- 7.2 as fotos entre si, na ordem das datas
  //
  // Painel nao anda para tras. Duas fotos em datas crescentes com leitura
  // decrescente sao de veiculos diferentes, ou uma delas tem o numero errado.
  const emOrdem = [...comData].sort((a, b) =>
    String(a.data_leitura).localeCompare(String(b.data_leitura)),
  );
  for (let i = 1; i < emOrdem.length; i++) {
    const ant = emOrdem[i - 1];
    const at = emOrdem[i];
    if (Number(at.km) < Number(ant.km)) {
      achados.push(
        achado(
          'erro',
          'fotos_em_ordem_errada',
          `A foto de ${dataBr(at.data_leitura)} marca ${Number(at.km).toLocaleString('pt-BR')} km, `
            + `menos que a de ${dataBr(ant.data_leitura)} (${Number(ant.km).toLocaleString('pt-BR')} km). `
            + 'O painel nao anda para tras - confira os numeros ou as datas.',
          at.data_leitura,
        ),
      );
    }
  }

  // O KM digitado junto de cada foto permite conferir o painel contra o
  // relatorio sem ninguem abrir imagem nenhuma.
  const leituras = fotos
    .map((f) => Number(f.km))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (leituras.length && linhas.length) {
    const kms = linhas
      .flatMap((l) => [Number(l.km_inicial), Number(l.km_final)])
      .filter((n) => Number.isFinite(n) && n > 0);

    if (kms.length) {
      const menorRdv = Math.min(...kms);
      const maiorRdv = Math.max(...kms);
      const TOLERANCIA = 50; // o painel anda entre a foto e o primeiro registro

      const abaixo = leituras.filter((n) => n < menorRdv - TOLERANCIA);
      const acima = leituras.filter((n) => n > maiorRdv + TOLERANCIA);

      if (abaixo.length || acima.length) {
        const fora = [...abaixo, ...acima];
        achados.push(
          achado(
            'erro',
            'odometro_fora_do_rdv',
            `${fora.length} leitura(s) de odometro nao batem com o relatorio: ` +
              `${fora.map((n) => n.toLocaleString('pt-BR')).join(', ')} km, ` +
              `enquanto o RDV vai de ${menorRdv.toLocaleString('pt-BR')} a ${maiorRdv.toLocaleString('pt-BR')} km.`,
          ),
        );
      }

      // Aqui existia um aviso quando o painel andava MAIS que o declarado.
      // Foi retirado: isso e o normal, nao um problema. O carro roda fora do
      // trabalho - fim de semana, uso particular, ida ao posto - e nada disso
      // entra no RDV. O painel andar mais que a soma dos km lancados e o que
      // se espera; avisar sobre isso enchia todo relatorio de alerta inutil.
      //
      // O caso oposto continua valendo, e esta no bloco acima: leitura de
      // painel ABAIXO do que o RDV ja registrou nao tem explicacao inocente.
    }
  }

  const fotosSemKm = fotos.filter((f) => !Number.isFinite(Number(f.km)) || Number(f.km) <= 0);
  if (fotosSemKm.length) {
    achados.push(
      achado(
        'aviso',
        'odometro_sem_km',
        `${fotosSemKm.length} foto(s) de odometro foram enviadas sem o KM digitado.`,
      ),
    );
  }

  // ------------------------------------------- 8. aumento sobre o mes anterior
  // O que a empresa desembolsa: o valor dos km mais pedagio e estacionamento.
  const totalDoMes = Number((valorKm + declarado).toFixed(2));
  let comparacao = null;

  if (mesAnterior && mesAnterior.total > 0) {
    const diferenca = Number((totalDoMes - mesAnterior.total).toFixed(2));
    const precisaExplicar = diferenca > MARGEM_AUMENTO;
    const temJustificativa = String(rel.justificativa || '').trim().length >= 15;

    comparacao = {
      mes_anterior: mesAnterior.mes,
      total_anterior: mesAnterior.total,
      total_atual: totalDoMes,
      diferenca,
      margem: MARGEM_AUMENTO,
      precisa_justificar: precisaExplicar,
      tem_justificativa: temJustificativa,
    };

    if (precisaExplicar && !temJustificativa) {
      achados.push(
        achado(
          'erro',
          'aumento_sem_justificativa',
          `Este mes ficou ${brl(diferenca)} acima de ${mesAnterior.mesExtenso || mesAnterior.mes} ` +
            `(${brl(totalDoMes)} contra ${brl(mesAnterior.total)}). Acima de ${brl(
              MARGEM_AUMENTO,
            )} de aumento e preciso explicar o motivo.`,
        ),
      );
    } else if (precisaExplicar && temJustificativa) {
      achados.push(
        achado(
          'aviso',
          'aumento_justificado',
          `Este mes ficou ${brl(diferenca)} acima de ${mesAnterior.mesExtenso || mesAnterior.mes}. ` +
            `Justificativa do colaborador: "${String(rel.justificativa).trim()}"`,
        ),
      );
    }
  }

  // O status e as travas continuam olhando a lista INTEIRA: o que a aba mostra
  // e questao de momento, mas o estado real do relatorio nao muda por causa
  // disso. Por isso `erros` sai de `achados`, e nao da lista filtrada abaixo.
  const erros = achados.filter((a) => a.gravidade === 'erro');
  const soFaltaDanfe = erros.length === 1 && erros[0].codigo === 'sem_danfe';

  // O colaborador ve a lista INTEIRA, igual ao admin.
  //
  // Houve uma tentativa de esconder dele as cobrancas de anexo - falta a nota,
  // faltam as fotos - com o argumento de que ainda nao tem os comprovantes em
  // maos e a aba ficava vermelha desde o primeiro dia. O efeito na pratica foi
  // o oposto do que o portal se propoe: ele so descobria o problema no clique
  // do Enviar, quando ja era tarde. A promessa e "ele corrige antes, nao
  // depois", e para corrigir antes ele precisa enxergar antes.
  //
  // Ver o vermelho NAO impede o envio. Quem decide o que trava e a lista de
  // bloqueios do enviarRelatorio - `sem_danfe` nao esta nela de proposito, e o
  // status "So falta DANFE" existe exatamente para esse caso.
  return {
    totalKm,
    valorKm,
    totalDoMes,
    comparacao,
    // Quando o formulario nao tem coluna por dia, as linhas somam zero e o
    // valor real esta no quadro de resumo do documento. O `declarado` acima ja
    // resolve isso - mas quem grava no banco usava `pedagioDeclarado`, que era
    // so a soma das linhas. O resultado: RDV com R$ 254,80 de pedagio no
    // documento aparecia como "Declarado R$ 0,00" no painel, e o comprovado
    // inteiro virava diferenca em vermelho.
    pedagioDeclarado: somaDasLinhas > 0
      ? Number(pedagioLinhas.toFixed(2))
      : Number((agregadoDoPdf ?? 0).toFixed(2)),
    estacDeclarado: somaDasLinhas > 0 ? Number(estacLinhas.toFixed(2)) : 0,
    totalDeclarado: declarado,
    temDanfe,
    qtdFotosOdometro: fotos.length,
    achados,
    statusSugerido: erros.length === 0 ? 'CERTA' : soFaltaDanfe ? 'SO_FALTA_DANFE' : 'ERRADA',
  };
}

// Quantas semanas o RDV cobre com trabalho de verdade.
function semanasSemFoto(linhas, fotos) {
  const semanas = new Set();
  for (const l of linhas) {
    if (Number(l.km_final) - Number(l.km_inicial) > 0) {
      semanas.add(numeroDaSemana(l.data));
    }
  }
  const esperado = semanas.size;
  const faltam = Math.max(0, esperado - Math.floor(fotos.length / 2));
  return Array.from({ length: faltam }, (_, i) => i);
}

function numeroDaSemana(dataIso) {
  const d = new Date(`${dataIso}T12:00:00Z`);
  const inicio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d - inicio) / (7 * 86400_000));
}

export function dataBr(iso) {
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

export { diaDaSemana };

/** Quantas semanas a pessoa realmente rodou no mes. */
function semanasTrabalhadas(linhas) {
  const semanas = new Set();
  for (const l of linhas) {
    if (Number(l.km_final) - Number(l.km_inicial) > 0) semanas.add(numeroDaSemana(l.data));
  }
  return semanas.size;
}
