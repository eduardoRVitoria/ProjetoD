// Motor de conferencia por regra - roda sem IA e sem custo nenhum.
// Cobre os passos que sao pura aritmetica e calendario. O que depende de ler
// comprovante (somar extrato de pedagio, reconhecer DANFE, ler foto de odometro)
// fica para o modulo de IA em ia.js.

import { fimDeSemana, nomeDoFeriado, diaDaSemana } from './feriados.js';

const CENTAVO = 0.01;
const perto = (a, b, tol = CENTAVO) => Math.abs(a - b) <= tol;
const brl = (v) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function achado(gravidade, codigo, mensagem, data = null) {
  return { gravidade, codigo, mensagem, data };
}

/**
 * Confere um relatorio inteiro.
 * @param {object} rel     linha da tabela relatorios
 * @param {Array}  linhas  linhas do RDV, em ordem de data
 * @param {Array}  anexos  anexos ja enviados
 * @param {number} vlrKm   valor pago por km (padrao 0,90)
 */
export function conferir(rel, linhas, anexos, vlrKm = 0.9) {
  const achados = [];

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

    if (kf === ki && itin && !fimDeSemana(l.data)) {
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
      // Rodou entre um lancamento e outro sem declarar. Tolera 1 km de
      // arredondamento de painel.
      const lacuna = inicio - fimAnterior;
      if (lacuna > 1) {
        achados.push(
          achado(
            'aviso',
            'hodometro_lacuna',
            `${dataBr(at.data)}: o KM inicial (${inicio}) esta ${lacuna} km acima do KM final do dia anterior (${fimAnterior}). Esses ${lacuna} km rodaram sem estar lancados.`,
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
  const declaradoValor = doPdf?.totais_declarados?.valor_km ?? Number(rel.valor_km);

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
  const declarado = Number((pedagioLinhas + estacLinhas).toFixed(2));

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

  if (rel.pedagio_comprovado != null) {
    const dif = Number((Number(rel.pedagio_comprovado) - declarado).toFixed(2));
    if (Math.abs(dif) > CENTAVO) {
      achados.push(
        achado(
          'erro',
          'pedagio_diferenca',
          `Declarado ${brl(declarado)} em pedagio/estacionamento, comprovado ${brl(
            Number(rel.pedagio_comprovado),
          )}. Diferenca de ${brl(dif)}.`,
        ),
      );
    }
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
    achados.push(
      achado(
        'aviso',
        'odometro_incompleto',
        `Foram enviadas ${fotos.length} fotos de odometro, menos que as ${faltando.length * 2} esperadas para as semanas trabalhadas.`,
      ),
    );
  }

  const erros = achados.filter((a) => a.gravidade === 'erro');
  const soFaltaDanfe = erros.length === 1 && erros[0].codigo === 'sem_danfe';

  return {
    totalKm,
    valorKm,
    pedagioDeclarado: Number(pedagioLinhas.toFixed(2)),
    estacDeclarado: Number(estacLinhas.toFixed(2)),
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
