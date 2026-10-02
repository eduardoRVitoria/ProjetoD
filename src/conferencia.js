// Motor de conferencia por regra - roda sem IA e sem custo nenhum.
// Cobre os passos que sao pura aritmetica e calendario. O que depende de ler
// comprovante (somar extrato de pedagio, reconhecer DANFE, ler foto de odometro)
// fica para o modulo de IA em ia.js.

import { fimDeSemana, nomeDoFeriado, diaDaSemana } from './feriados.js';
import { MARGEM_AUMENTO } from './banco.js';
import { totalDeKmDeclarado } from './util.js';

// Distancia que nao cabe num dia de trabalho, de carro.
export const KM_IMPOSSIVEL_NUM_DIA = 2000;

// Quanto o carro pode rodar fora do trabalho entre dois lancamentos sem que
// isso chame atencao. Fim de semana com viagem particular cabe aqui.
const USO_PARTICULAR_ESPERADO = 600;

// A foto do painel e do inicio ou do fim do dia, entao a leitura tem que cair
// dentro do que o RDV registra naquele dia. A folga cobre o trecho entre tirar
// a foto e comecar a rodar - casa, posto, primeira visita.
const FOLGA_DA_FOTO = 0;

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
//   5  revisao do Eduardo de 22/09: fim de semana e 18h viram aviso so para a
//      DSO (18h nao vale mais para DISO nem PROMOTORES); salto de 600 km entre
//      dias uteis; valor do km sem tolerancia; foto do painel tem que ser o km
//      inicial ou final do dia; fotos por trecho de dias uteis (feriado parte
//      a semana); troca de carro justificavel; aumento acima de R$ 100; RDV
//      sem assinatura e erro; o sistema soma o pedagio, nao mais a IA.
//   6  hotel e outras despesas: podem ser somados ao mes, mas cada um so vale
//      com o SEU comprovante - o do hotel e o da outra despesa, separados.
//   8  hotel e outras despesas: o valor vem do RDV e a soma dos comprovantes
//      (valor digitado em cada um) tem que bater com ele.
//   7  gerente e pago pelo combustivel: a soma do abastecimento dos dias tem
//      que bater com o total do RDV e com a soma das notas (valor digitado em
//      cada DANFE). A DANFE so e obrigatoria para gerente - para os outros, a
//      falta dela vira aviso e o relatorio nao cai mais em "So falta DANFE".
//   9  carro da empresa (gerente, alguns supervisores): foto do odometro nao
//      e obrigatoria.
//  10  excecao da 9: gerente da ALPHA manda a foto do odometro mesmo com
//      carro da empresa.
//  11  RDV sem assinatura digital nao reprova mais: pode estar assinado a mao
//      (vira aviso para quem confere olhar). Duas passagens na mesma praca no
//      mesmo dia deixam de gerar aviso - ida e volta e o normal.
//  12  sem IA, os comprovantes sao lidos por codigo (texto do PDF, OCR da foto,
//      QR code da nota). A leitura por codigo confirma ou avisa em amarelo;
//      nunca reprova.
//  13  assinatura em cima da placa e decidida pela posicao do selo e da placa
//      no PDF (placa.js), nao pela IA: selo encostado na placa nao reprova
//      mais. Onde o codigo nao enxerga, a opiniao da IA vira aviso.
//  14  RDV sem assinatura nenhuma - nem gov.br, nem a mao - volta a reprovar.
//      Assinado a mao continua valendo. So fica aviso quando ninguem consegue
//      ver (papel escaneado ou foto, sem a IA).
//  15  o total a receber (km + pedagio/estacionamento + hotel + outros) tem que
//      bater com o "Subtotal das Despesas" que o RDV declara.
//  16  dia com mais de 2.000 km rodados e erro: e numero lido ou digitado
//      errado, e nao pode entrar calado no total a receber.
//  17  assinatura: a caixa de assinatura do RDV em branco reprova (o codigo
//      mede a tinta dentro dela), e assinatura que ninguem conseguiu
//      confirmar reprova em vez de virar aviso.
//  18  sabado e domingo com lancamento reprovam em todas as empresas - a DSO
//      perdeu a excecao da versao 5. Combustivel de gerente no fim de semana
//      tambem conta.
//  19  saiu a regra do salto impossivel do odometro (KM inicial muito acima
//      do KM final do dia anterior): nao reprova mais.
//  20  quem tem carro da empresa e entrega o RDV de combustivel por dia e
//      conferido como o gerente: recebe o combustivel, nao km x taxa.
//
// A 4 perdoa: quem da DISO foi reprovado so por despesa noturna aparece no
// painel como "regras antigas" e merece uma reconferencia.
export const VERSAO_REGRAS = 20;

const CENTAVO = 0.01;
const perto = (a, b, tol = CENTAVO) => Math.abs(a - b) <= tol;

/**
 * Numero de verdade, ou zero.
 *
 * Tudo que entra aqui vem do banco ou da leitura do PDF pela IA, e nem sempre
 * chega numero: campo em branco vira null, a IA ja devolveu "R$ 1.234" como
 * texto, e um dia sem km lido vira undefined. Somar isso direto produz NaN,
 * que contamina o total do mes e sobe para a tela como "NaN km" - foi o que o
 * teste de robustez pegou.
 */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A data existe mesmo? 'AAAA-MM-DD' de um dia que o calendario tem. */
export function dataValida(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** O numero que a pessoa DECLAROU, ou null quando nao da para saber. */
const declaradoOuNulo = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
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
  // So a DSO cobra explicacao por horario, e como AVISO: aparece para quem
  // confere, mas nao reprova. DISO e PROMOTORES sairam da regra (versao 5), e a
  // ALPHA ja entrou fora dela.
  if (empresa !== 'DSO') return [];

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
        'aviso',
        'despesa_noturna_sem_justificativa',
        `${dataBr(p.data)} as ${p.hora}: ${brl(Number(p.valor || 0))} em `
          + `${String(p.local || 'pedagio/estacionamento').slice(0, 40)}, depois das `
          + `${HORA_LIMITE}h. Explique o motivo desse horario no dia ${dataBr(p.data)}.`,
        p.data,
      ),
    );
}

/**
 * O que a IA escreve sobre pedagio nunca reprova: sai sempre como aviso.
 *
 * Pedagio e conta do sistema - ele soma a transcricao e compara com o
 * declarado. A instrucao manda a IA nao opinar sobre isso, mas ela continuou
 * marcando ida e volta como erro (o colaborador vai ao cliente e volta para
 * casa: duas passagens no dia e o normal). Instrucao nao segura modelo; isto
 * segura.
 */
export function gravidadeDoAchadoDaIa(a) {
  return achadoDaIaSobrePedagio(a) || a?.gravidade !== 'erro' ? 'aviso' : 'erro';
}

/**
 * O achado da IA fala de pedagio/estacionamento?
 *
 * Duas passagens na mesma praca no mesmo dia nao sao nem aviso (versao 11): e
 * ida e volta, o normal. Com o pedagio batendo centavo a centavo, o que a IA
 * escreve sobre ele e so isso - "correto, mas com 2 passagens" - e a
 * conferencia joga fora. Foi o que deixou o RDV do supervisor da ALPHA com
 * "comprovante errado" em 01/10 (2x R$ 4,30 em Cajati, 08:35 e 14:17).
 */
export function achadoDaIaSobrePedagio(a) {
  return /ped[aá]gio|passage|estacionamento/i.test(String(a?.mensagem || ''));
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

/**
 * Soma as passagens que a IA transcreveu do extrato.
 *
 * A IA so transcreve; quem soma e decide o que entra e este codigo. Deixar a
 * conta com o modelo fazia ele "fechar" a soma no valor declarado - foi o que
 * aconteceu no rdv-app em 10/09. Numero que decide dinheiro sai daqui.
 *
 * Entra: passagem do mes de referencia em dia util, e passagem de fim de
 * semana ou feriado SE o RDV lanca aquele dia (km, pedagio ou estacionamento).
 * Fica de fora, listada com o motivo: outro mes, e fim de semana/feriado que o
 * RDV nao lanca - uso particular do carro, que nao e despesa da empresa.
 *
 * Antes a IA descartava fim de semana calada: o vendedor declarava pedagio do
 * sabado e so via uma "diferenca" sem explicacao. Agora o dia declarado conta,
 * e a regra de fim de semana e quem aponta o sabado.
 */
export function somarExtrato(passagens, linhas, mesRef) {
  const lancados = new Set(
    linhas
      .filter(
        (l) =>
          Number(l.km_final) - Number(l.km_inicial) > 0
          || Number(l.pedagio) > 0
          || Number(l.estacionamento) > 0,
      )
      .map((l) => l.data),
  );

  let centavos = 0;
  const contadas = [];
  const fora = [];

  for (const p of passagens || []) {
    const valor = Number(p?.valor);
    const data = String(p?.data || '');
    if (!Number.isFinite(valor) || valor <= 0) continue;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !data.startsWith(mesRef)) {
      fora.push({ ...p, motivo: 'fora do mes do relatorio' });
      continue;
    }
    const naoUtil = fimDeSemana(data) || nomeDoFeriado(data);
    if (naoUtil && !lancados.has(data)) {
      fora.push({ ...p, motivo: 'fim de semana/feriado sem lancamento no RDV' });
      continue;
    }
    centavos += Math.round(valor * 100);
    contadas.push(p);
  }

  return { total: centavos / 100, contadas, fora };
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
 * @param {string} empresa empresa do dono do relatorio (DISO, DSO, PROMOTORES, ALPHA)
 * @param {string} funcao  funcao do dono - Gerente e pago pelo combustivel
 * @param {string} carro   'pessoal' ou 'empresa' - carro da empresa nao cobra foto do odometro
 */
export function conferir(
  rel, linhas, anexos, vlrKm = 0.9, mesAnterior = null, empresa = null, funcao = null, carro = 'pessoal',
) {
  const achados = [];
  // Pago pelo combustivel: gerente e coordenador sempre; e quem tem carro da
  // empresa e entregou o formulario de combustivel por dia (supervisor com
  // carro da empresa usa o mesmo RDV "Carro da Empresa" do gerente).
  const gerente = pagoPorCombustivel(funcao, carro, linhas);

  // Dia com data que nao existe ("2026-13-45", campo em branco) vira pendencia
  // e sai da conta. Antes ele chegava nas contas de calendario e derrubava a
  // conferencia inteira com "Invalid time value": o relatorio dessa pessoa
  // ficava sem parecer e o painel do administrador mostrava erro.
  const todas = Array.isArray(linhas) ? linhas : [];
  linhas = todas.filter((l) => dataValida(l?.data));
  for (const ruim of todas.filter((l) => !dataValida(l?.data))) {
    achados.push(
      achado(
        'erro',
        'data_invalida',
        `Um dia do relatorio veio com data invalida (${String(ruim?.data ?? 'em branco').slice(0, 20)}) `
          + 'e ficou de fora da conta. Confira o arquivo e leia o RDV de novo.',
      ),
    );
  }

  const justificativaDoDia = new Map(
    linhas.map((l) => [l.data, String(l.justificativa_hora || '').trim()]),
  );

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
      hotelDeclarado: 0,
      outrosDeclarado: 0,
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

    // Sabado e domingo nao entram no RDV, em nenhuma empresa (versao 18). A
    // DSO tinha ficado so com aviso na versao 5, e o resultado foi relatorio
    // somando fim de semana e saindo aprovado. O combustivel do gerente conta
    // como lancamento tambem - antes passava sem ninguem olhar.
    const despesaDoDia = num(l.pedagio) + num(l.estacionamento) + num(l.combustivel);
    if (fds && (rodou > 0 || despesaDoDia > 0)) {
      achados.push(
        achado(
          'erro',
          'data_fim_de_semana',
          `${dataBr(l.data)} caiu num ${fds} e tem lancamento (${rodou} km, ${brl(despesaDoDia)}). `
            + 'Fim de semana nao entra no RDV: tire esse dia do relatorio.',
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

    // Ninguem roda isso num dia. E numero lido ou digitado errado - dois
    // campos grudados, um digito a mais, km inicial em branco - e sem esta
    // trava o dia entrava na soma: um RDV chegou a mostrar mais de um bilhao de
    // reais a receber.
    if (kf - ki > KM_IMPOSSIVEL_NUM_DIA) {
      achados.push(
        achado(
          'erro',
          'km_do_dia_impossivel',
          `${dataBr(l.data)}: ${(kf - ki).toLocaleString('pt-BR')} km num dia so (KM inicial ${ki.toLocaleString('pt-BR')}, `
            + `final ${kf.toLocaleString('pt-BR')}). O numero foi lido ou digitado errado - corrija o KM desse dia.`,
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
      const seguidos = diasSeguidos(ant.data, at.data);

      // O salto do painel de um dia para o outro nao reprova mais (versao 19):
      // a regra "salto impossivel" - mais de 600 km entre dias uteis seguidos,
      // ou mais de 2 mil com fim de semana no meio - foi tirada a pedido do
      // Eduardo em 02/10. Fica so o aviso de quando ha fim de semana no meio.
      if (!seguidos && lacuna > USO_PARTICULAR_ESPERADO) {
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
    (s, l) => s + Math.max(0, num(l.km_final) - num(l.km_inicial)),
    0,
  );
  // Gerente: o que se paga e o combustivel abastecido no mes, nao km x valor
  // do km. No RDV dele a linha "KM R$" do resumo ja e a soma do combustivel.
  const totalCombustivel = Number(
    linhas.reduce((s, l) => s + num(l.combustivel), 0).toFixed(2),
  );
  const valorKm = gerente ? totalCombustivel : Number((totalKm * num(vlrKm)).toFixed(2));

  // Quando o RDV veio de PDF, o total que vale para a comparacao e o que a
  // PESSOA escreveu no documento, nao o que o sistema gravou. E aqui que o erro
  // de conta aparece - ele nao e mais evitado na origem, entao tem que ser pego.
  // O JSON e escrito pelo proprio sistema, mas um arquivo cortado pela metade
  // (queda no meio da gravacao) derrubaria a conferencia de quem tem esse
  // relatorio - e, no painel, a tela inteira do administrador.
  let doPdf = null;
  if (rel.extraido) {
    try {
      doPdf = JSON.parse(rel.extraido);
    } catch {
      doPdf = null;
    }
  }
  // `declaradoOuNulo`: texto que nao vira numero e "nao sei", nao zero. Tratar
  // como zero acusaria a pessoa de ter declarado 0 km.
  // Leitura antiga pode ter guardado "4.547" como 4,547 km: a soma dos dias
  // diz se era quatro mil.
  const declaradoKmLido = declaradoOuNulo(doPdf?.totais_declarados?.total_km ?? rel.total_km);
  const declaradoKm = declaradoKmLido == null ? null : totalDeKmDeclarado(declaradoKmLido, totalKm);
  const declaradoValor = declaradoOuNulo(doPdf?.totais_declarados?.valor_total_km ?? rel.valor_km);

  if (declaradoKm != null && !perto(totalKm, declaradoKm, 0.5)) {
    const dif = totalKm - declaradoKm;
    achados.push(
      achado(
        'erro',
        'soma_km',
        `A soma dos dias da ${totalKm} km, mas o relatorio declara ${declaradoKm} km. ` +
          `Diferenca de ${dif > 0 ? '+' : ''}${dif.toFixed(0)} km.`,
      ),
    );
  }

  // Sem tolerancia: o valor tem que ser a conta exata, em centavos.
  if (gerente) {
    if (declaradoValor != null && Math.round(valorKm * 100) !== Math.round(declaradoValor * 100)) {
      achados.push(
        achado(
          'erro',
          'valor_combustivel',
          `A soma do combustivel dos dias da ${brl(valorKm)}, mas o relatorio declara ${brl(
            Number(declaradoValor),
          )}. Diferenca de ${brl(valorKm - Number(declaradoValor))}.`,
        ),
      );
    }
  } else if (declaradoValor != null && Math.round(valorKm * 100) !== Math.round(declaradoValor * 100)) {
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
  const pedagioLinhas = linhas.reduce((s, l) => s + num(l.pedagio), 0);
  const estacLinhas = linhas.reduce((s, l) => s + num(l.estacionamento), 0);

  // O formulario de RDV normalmente nao tem coluna de pedagio por dia - traz so
  // "PEDAGIO + ESTACIONAMENTO" no quadro de resumo. Quando for esse o caso, o
  // valor declarado e o do quadro, nao a soma (que seria zero).
  // `num`: a IA ja devolveu esse campo como texto, e ai o `.toFixed` de antes
  // lancava erro e o relatorio inteiro ficava sem conferencia.
  const agregadoDoPdf = num(doPdf?.totais_declarados?.pedagio_estacionamento);
  const somaDasLinhas = Number((pedagioLinhas + estacLinhas).toFixed(2));
  const declarado = somaDasLinhas > 0 ? somaDasLinhas : Number(agregadoDoPdf.toFixed(2));

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

  // --------------------------------------------- 5.1 hotel e outras despesas
  //
  // O quadro do RDV tem duas linhas que nao sao km nem pedagio: HOTEL e OUTROS.
  // Elas podem entrar na conta do mes junto com o resto - a pessoa recebe os
  // dois somados -, mas cada uma so vale com o SEU comprovante. Nao serve
  // mandar a nota do hotel e escrever "e mais R$ 80 de outros": sao duas
  // despesas diferentes, cada uma com o seu papel.
  //
  // A coluna do banco e a verdade: a leitura do PDF grava nela o valor do
  // documento, e cada salvamento grava o que esta na tela da pessoa. O quadro
  // do PDF so vale quando a coluna nao veio (a leitura manda null de proposito
  // para pegar o valor do documento novo).
  //
  // Era `coluna || pdf`: o 0 contava como "nao digitou". Quem apagava um hotel
  // que o PDF trazia via os R$ 350 voltarem na conferencia - e ainda levava
  // "hotel sem comprovante".
  const hotelDeclarado = Number(
    (declaradoOuNulo(rel.hotel_declarado) ?? (Number(doPdf?.totais_declarados?.hotel) || 0)).toFixed(2),
  );
  const outrosDeclarado = Number(
    (declaradoOuNulo(rel.outros_declarado) ?? (Number(doPdf?.totais_declarados?.outros) || 0)).toFixed(2),
  );

  if (hotelDeclarado > 0 && !anexos.some((a) => a.tipo === 'hotel')) {
    achados.push(
      achado(
        'erro',
        'hotel_sem_comprovante',
        `Voce declarou ${brl(hotelDeclarado)} de hotel mas nao anexou a nota da hospedagem.`,
      ),
    );
  }

  if (outrosDeclarado > 0 && !anexos.some((a) => a.tipo === 'outras_despesas')) {
    achados.push(
      achado(
        'erro',
        'outros_sem_comprovante',
        `Voce declarou ${brl(outrosDeclarado)} em outras despesas mas nao anexou o comprovante `
          + 'delas. O comprovante do hotel nao cobre esta linha: cada despesa pede o seu.',
      ),
    );
  }

  // Com comprovante anexado, a soma deles tem que ser o valor do RDV. O valor
  // de cada comprovante e digitado no envio - a conta e do sistema, sem IA.
  for (const [tipo, declaradoTipo, nome, codigo] of [
    ['hotel', hotelDeclarado, 'hotel', 'hotel_nao_bate'],
    ['outras_despesas', outrosDeclarado, 'outras despesas', 'outros_nao_bate'],
  ]) {
    const comp = anexos.filter((a) => a.tipo === tipo);
    if (!comp.length) continue;
    const semValor = comp.filter((a) => !(Number(a.valor) > 0));
    if (semValor.length) {
      achados.push(
        achado(
          'erro',
          `${codigo.split('_')[0]}_sem_valor`,
          `${semValor.length} comprovante(s) de ${nome} sem o valor: ${semValor
            .slice(0, 3)
            .map((a) => a.nome_original)
            .join(', ')}. Apague e anexe de novo informando o valor.`,
        ),
      );
      continue;
    }
    const soma = Number(comp.reduce((s, a) => s + num(a.valor), 0).toFixed(2));
    if (Math.round(soma * 100) !== Math.round(declaradoTipo * 100)) {
      achados.push(
        achado(
          'erro',
          codigo,
          declaradoTipo > 0
            ? `O RDV declara ${brl(declaradoTipo)} de ${nome}, mas os comprovantes somam ${brl(soma)}. `
              + `Diferenca de ${brl(soma - declaradoTipo)}.`
            : `Ha comprovante(s) de ${nome} somando ${brl(soma)}, mas o RDV nao declara ${nome}. `
              + 'Confira o quadro de resumo do RDV.',
        ),
      );
    }
  }

  // -------------------------------------------------------- 6. abastecimento
  //
  // A nota so e obrigatoria para GERENTE, que e pago pelo combustivel. Para o
  // resto (vendedor, supervisor, promotor) o reembolso e por km: a nota ajuda,
  // mas a falta dela e so um aviso para quem confere.
  const notas = anexos.filter((a) => a.tipo === 'danfe');
  const temDanfe = notas.length > 0;
  if (!temDanfe) {
    achados.push(
      gerente
        ? achado('erro', 'sem_danfe', 'Nao foi enviada a nota/DANFE de abastecimento do mes.')
        : achado('aviso', 'sem_danfe', 'Nao foi enviada nota de abastecimento neste mes.'),
    );
  }

  // Gerente: a soma do que ele abasteceu nos dias tem que ser a soma das notas.
  // O valor de cada nota e digitado no envio - a conta e do sistema, sem IA.
  let totalNotas = null;
  if (gerente && temDanfe) {
    const semValor = notas.filter((a) => !(Number(a.valor) > 0));
    if (semValor.length) {
      achados.push(
        achado(
          'erro',
          'danfe_sem_valor',
          `${semValor.length} nota(s) de abastecimento sem o valor digitado: ${semValor
            .slice(0, 3)
            .map((a) => a.nome_original)
            .join(', ')}. Apague e anexe de novo informando o valor da nota.`,
        ),
      );
    }
    totalNotas = Number(notas.reduce((s, a) => s + num(a.valor), 0).toFixed(2));
    if (!semValor.length && Math.round(totalNotas * 100) !== Math.round(totalCombustivel * 100)) {
      achados.push(
        achado(
          'erro',
          'combustivel_nao_bate',
          `O combustivel lancado nos dias soma ${brl(totalCombustivel)}, mas as notas anexadas somam `
            + `${brl(totalNotas)}. Diferenca de ${brl(totalCombustivel - totalNotas)}. `
            + 'Confira o valor de cada dia e de cada nota.',
        ),
      );
    }
  }

  // -------------------------------------------------------- 7. odometro
  const fotos = anexos.filter((a) => a.tipo === 'odometro');
  // Carro da empresa: a foto nao e cobrada - menos para gerente da ALPHA. Se
  // vier, as checagens de cada foto (7.1 em diante) continuam valendo.
  const carroDaEmpresa = carro === 'empresa';
  if (!cobraFotoOdometro(empresa, funcao, carro)) {
    // nada a cobrar
  } else if (fotos.length === 0) {
    achados.push(
      achado(
        'erro',
        'sem_odometro',
        'Nao foi enviada nenhuma foto do odometro. E preciso a foto de segunda de manha e a de sexta a noite de cada semana.',
      ),
    );
  } else {
    // Uma foto no comeco e outra no fim de cada trecho de dias uteis. Feriado
    // parte a semana: com feriado na quarta, sao quatro fotos - segunda de
    // manha, terca a noite, quinta de manha e sexta a noite.
    const faltam = fotosQueFaltam(fotosEsperadas(linhas, rel.mes_ref), fotos);
    if (faltam.length > 0) {
      const lista = faltam
        .slice(0, 6)
        .map((f) => `${diaDaSemana(f.data)} ${dataBr(f.data).slice(0, 5)} ${f.momento === 'manha' ? 'de manha' : 'a noite'}`)
        .join(', ');
      const resto = faltam.length > 6 ? ` e mais ${faltam.length - 6}` : '';
      achados.push(
        achado(
          'aviso',
          'odometro_incompleto',
          `Falta${faltam.length > 1 ? 'm' : ''} ${faltam.length} foto(s) do odometro: ${lista}${resto}. `
            + 'E uma foto no primeiro dia util de manha e outra no ultimo a noite; feriado no meio da semana pede foto antes e depois dele.',
        ),
      );
    }
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

    // Tolerancia zero: a foto e do comeco ou do fim do dia, entao tem que ser
    // exatamente o KM inicial ou o KM final. Com justificativa escrita no dia,
    // vira aviso e quem confere le o motivo.
    if (km !== ki && km !== kf) {
      const dif = Math.min(Math.abs(km - ki), Math.abs(km - kf));
      const porQue = justificativaDoDia.get(f.data_leitura);
      const fato = `${dataBr(f.data_leitura)}: a foto do painel marca ${km.toLocaleString('pt-BR')} km, `
        + `mas o RDV lanca ${ki.toLocaleString('pt-BR')} (inicial) e ${kf.toLocaleString('pt-BR')} (final) `
        + `nesse dia. Diferenca de ${dif.toLocaleString('pt-BR')} km.`;
      achados.push(
        porQue
          ? achado('aviso', 'foto_nao_bate_justificada', `${fato} Justificativa: "${porQue}"`, f.data_leitura)
          : achado('erro', 'foto_nao_bate_com_o_dia', `${fato} Corrija o KM ou justifique.`, f.data_leitura),
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
      // Troca de carro explica: com justificativa escrita no dia, vira aviso.
      const porQue = justificativaDoDia.get(at.data_leitura);
      const fato = `A foto de ${dataBr(at.data_leitura)} marca ${Number(at.km).toLocaleString('pt-BR')} km, `
        + `menos que a de ${dataBr(ant.data_leitura)} (${Number(ant.km).toLocaleString('pt-BR')} km).`;
      achados.push(
        porQue
          ? achado('aviso', 'troca_de_carro_justificada', `${fato} Justificativa: "${porQue}"`, at.data_leitura)
          : achado(
            'erro',
            'fotos_em_ordem_errada',
            `${fato} O painel nao anda para tras - confira os numeros ou as datas, ou justifique se trocou de carro.`,
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

      // So o painel ABAIXO do RDV e problema. Acima e o carro rodando fora do
      // trabalho, que e o normal - dava erro ate a versao 4 e contradizia a
      // instrucao da IA.
      const fora = leituras.filter((n) => n < menorRdv - TOLERANCIA);

      if (fora.length) {
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
  // O que a empresa desembolsa: o valor dos km, mais pedagio e estacionamento,
  // mais hotel e outras despesas. Hotel entra aqui de proposito - um mes com
  // viagem realmente custa mais, e e isso que a comparacao existe para mostrar.
  const totalDoMes = Number(
    (valorKm + declarado + hotelDeclarado + outrosDeclarado).toFixed(2),
  );

  // -------------------------------------- 8.1 total a receber x subtotal do RDV
  // O RDV traz o proprio total: "Subtotal das Despesas", ao lado da caixa azul.
  // O que o portal soma para pagar tem que ser esse numero, no centavo. Quando
  // nao e, alguma parcela foi lida ou lancada errada - e sem esta comparacao o
  // total do portal ficava diferente do documento sem ninguem ser avisado.
  const subtotalDoRdv = declaradoOuNulo(doPdf?.totais_declarados?.subtotal);
  if (subtotalDoRdv != null && Math.round(subtotalDoRdv * 100) !== Math.round(totalDoMes * 100)) {
    achados.push(
      achado(
        'erro',
        'subtotal_nao_bate',
        `O total a receber soma ${brl(totalDoMes)} (${gerente ? 'combustivel' : 'km'} ${brl(valorKm)} + `
          + `pedagio/estacionamento ${brl(declarado)} + hotel ${brl(hotelDeclarado)} + outros ${brl(outrosDeclarado)}), `
          + `mas o Subtotal das Despesas do RDV e ${brl(subtotalDoRdv)}. `
          + `Diferenca de ${brl(Number((totalDoMes - subtotalDoRdv).toFixed(2)))}.`,
      ),
    );
  }

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
    subtotalDoRdv,
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
    hotelDeclarado,
    outrosDeclarado,
    temDanfe,
    gerente,
    totalCombustivel,
    totalNotas,
    qtdFotosOdometro: fotos.length,
    carroDaEmpresa,
    achados,
    statusSugerido: erros.length === 0 ? 'CERTA' : soFaltaDanfe ? 'SO_FALTA_DANFE' : 'ERRADA',
  };
}

const DIA_MS = 86400_000;
const somarDias = (iso, n) =>
  new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * DIA_MS).toISOString().slice(0, 10);
const diaUtil = (iso) => !fimDeSemana(iso) && !nomeDoFeriado(iso);

/**
 * Que fotos de odometro o mes pede: uma de manha no primeiro dia e uma a noite
 * no ultimo dia de cada trecho de dias uteis seguidos.
 *
 * O trecho e a semana de segunda a sexta, partida por feriado, e segue o
 * calendario - nao os dias rodados: quem nao rodou na sexta mas fotografou o
 * painel na sexta fez certo. Trecho sem nenhum dia rodado nao pede nada.
 *
 * A semana da virada do mes pode ter uma ponta no mes vizinho. A foto dessa
 * ponta nao e cobrada aqui: ela pertence ao relatorio do outro mes.
 */
export function fotosEsperadas(linhas, mesRef) {
  const rodados = new Set(
    linhas.filter((l) => Number(l.km_final) - Number(l.km_inicial) > 0).map((l) => l.data),
  );
  const segundas = new Set();
  for (const d of rodados) {
    const n = new Date(`${d}T12:00:00Z`).getUTCDay();
    segundas.add(somarDias(d, -((n + 6) % 7)));
  }

  const esperadas = [];
  for (const segunda of [...segundas].sort()) {
    let trecho = [];
    const fechar = () => {
      if (trecho.some((d) => rodados.has(d))) {
        const pontas = [
          { data: trecho[0], momento: 'manha' },
          { data: trecho[trecho.length - 1], momento: 'noite' },
        ];
        esperadas.push(...pontas.filter((p) => p.data.startsWith(mesRef)));
      }
      trecho = [];
    };
    for (let i = 0; i < 5; i++) {
      const d = somarDias(segunda, i);
      if (diaUtil(d)) trecho.push(d);
      else fechar();
    }
    fechar();
  }
  return esperadas;
}

/**
 * Quais das fotos esperadas nao chegaram.
 *
 * A foto da noite vale tambem com a data do dia seguinte quando esse dia nao
 * e util: a de sexta as 23h50 o celular costuma datar no sabado. Foto sem data
 * de leitura nao tem como ser encaixada num dia, entao cobre qualquer falta.
 */
export function fotosQueFaltam(esperadas, fotos) {
  const porData = new Map();
  let semData = 0;
  for (const f of fotos) {
    if (f.data_leitura) porData.set(f.data_leitura, (porData.get(f.data_leitura) || 0) + 1);
    else semData++;
  }
  const usar = (data) => {
    const n = porData.get(data) || 0;
    if (!n) return false;
    porData.set(data, n - 1);
    return true;
  };

  const faltam = [];
  for (const e of esperadas) {
    if (usar(e.data)) continue;
    const seguinte = somarDias(e.data, 1);
    if (e.momento === 'noite' && !diaUtil(seguinte) && usar(seguinte)) continue;
    if (semData > 0) {
      semData--;
      continue;
    }
    faltam.push(e);
  }
  return faltam;
}

/** Quem e pago pelo combustivel em vez do km. Coordenador segue a regra do gerente. */
export const ehGerente = (funcao) => funcao === 'Gerente' || funcao === 'Coordenador';

/**
 * Esta pessoa recebe pelo combustivel abastecido, e nao por km rodado?
 * Gerente e coordenador, sempre. Quem tem carro da empresa, quando o RDV dele
 * traz combustivel por dia - e o formulario "Carro da Empresa".
 */
export const pagoPorCombustivel = (funcao, carro, linhas = []) =>
  ehGerente(funcao)
  || (carro === 'empresa' && (linhas || []).some((l) => Number(l?.combustivel) > 0));

/**
 * Se a foto do odometro e obrigatoria. Carro da empresa dispensa, menos para
 * gerente da ALPHA: ele manda a foto mesmo com carro da empresa.
 */
export const cobraFotoOdometro = (empresa, funcao, carro) =>
  carro !== 'empresa' || (empresa === 'ALPHA' && ehGerente(funcao));

export function dataBr(iso) {
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

export { diaDaSemana };
