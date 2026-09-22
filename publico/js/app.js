// Tela do colaborador: preencher o RDV, anexar comprovantes e enviar.

import {
  api, subirArquivo, mostrarRecado, escapar, brl, numeroBr,
  dataBr, dataHoraBr, tamanhoBr, mesAtual, sair, ROTULO_ANEXO, marcarAmbiente, anexoDoAchado,
} from '/js/comum.js';

const $ = (id) => document.getElementById(id);

// ATENCAO: todo `const`/`let` de topo tem que ficar ACIMA dos `await` deste
// arquivo. O `await` pausa a avaliacao do modulo; uma constante declarada
// depois ainda nao existe quando a inicializacao roda, e o erro que sai
// ("Cannot access X before initialization") derruba a tela inteira.
const seletor = $('seletor');
let tipoEmUso = null;

// Lista "para enviar" do resumo do mes. Cada item responde uma pergunta
// ("mandei a nota?") e o clique leva para a etapa onde aquilo se resolve.
const MARCA_DO_ITEM = {
  ok: '<path d="m7 12.5 3.2 3.2L17 9"/>',
  alerta: '<path d="M12 7.5v5.5M12 16.5v.1"/>',
  falha: '<path d="m8.5 8.5 7 7M15.5 8.5l-7 7"/>',
};
const DO_ODOMETRO = /odometro|foto|troca_de_carro/;

// O que o seletor de arquivo oferece. Precisa citar a extensao E o mime: o
// Android costuma casar pelo mime, e o iPhone pela extensao.
const ACEITOS = [
  '.xlsx', '.xlsm', '.xls', '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel',
  'text/csv',
  '.pdf', 'application/pdf',
  'image/*',
].join(',');

// O RDV vai em PDF. A planilha e lida na extracao, mas nao pode ser CONFERIDA:
// a API le imagem e PDF, e um .xlsx e um ZIP de XMLs. Sem isto o relatorio era
// conferido sem que ninguem olhasse o proprio RDV.
const SO_PDF_E_FOTO = ['.pdf', 'application/pdf', 'image/*'].join(',');

// O que o servidor REALMENTE recusa no envio.
//
// Precisa espelhar a lista de bloqueios do `enviarRelatorio`, em src/rotas.js.
// Se as duas discordarem, ou a tela trava um envio que passaria, ou deixa
// passar um que volta 400 - e o vendedor fica sem entender o que fazer.
//
// O resto do vermelho aparece na aba Conferencia para ele corrigir, mas nao
// tranca o botao: mandar sem a nota de abastecimento e um caminho previsto,
// e o status "So falta DANFE" existe exatamente para isso.
const TRAVAM_O_ENVIO = new Set([
  'km_invertido',
  'sem_linhas',
  'leitura_incerta',
  'pedagio_sem_comprovante',
  'aumento_sem_justificativa',
]);

// Achado que a pessoa resolve ESCREVENDO - o unico tipo que ganha o botao de
// justificar na aba Conferencia. O resto (falta a nota, km invertido) se
// resolve anexando arquivo ou corrigindo numero, e botao ali so atrapalharia.
//
// Fica aqui em cima com as outras constantes de topo pelo aviso do comeco do
// arquivo: declarada depois do `await`, ela ainda nao existe quando a primeira
// tela e desenhada, e a tela inteira cai.
// Os status que o servidor deixa mexer (EDITAVEL, em rotas.js). O historico usa
// para decidir se o botao da linha diz "Editar" ou "Ver" - prometer edicao num
// mes que o servidor recusa e pior que nao ter botao.
const EDITAVEIS = new Set(['RASCUNHO', 'ERRADA']);

const PEDEM_JUSTIFICATIVA = new Map([
  ['aumento_sem_justificativa', 'mes'],
  ['aumento_justificado', 'mes'],
  ['despesa_noturna_sem_justificativa', 'dia'],
  ['foto_nao_bate_com_o_dia', 'dia'],
  ['foto_nao_bate_justificada', 'dia'],
  ['fotos_em_ordem_errada', 'dia'],
  ['troca_de_carro_justificada', 'dia'],
]);

// O que a caixa pergunta, por tipo de pendencia. A justificativa e a mesma do
// dia (um campo por dia), mas a pergunta muda com o motivo.
const PERGUNTA_DO_DIA = {
  foto_nao_bate_com_o_dia: {
    rotulo: 'Por que a foto do painel não é o KM inicial nem o final desse dia?',
    exemplo: 'Ex.: tirei a foto depois de ir ao posto, o painel já tinha andado 4 km.',
  },
  fotos_em_ordem_errada: {
    rotulo: 'Trocou de carro? Explique por que o painel andou para trás.',
    exemplo: 'Ex.: o carro foi para a oficina e usei o reserva, placa ABC1D23, de 10/09 a 12/09.',
  },
  noturna: {
    rotulo: 'Por que essa despesa aconteceu depois das 18h?',
    exemplo: 'Ex.: a visita terminou às 20h e voltei direto para casa.',
  },
};
PERGUNTA_DO_DIA.foto_nao_bate_justificada = PERGUNTA_DO_DIA.foto_nao_bate_com_o_dia;
PERGUNTA_DO_DIA.troca_de_carro_justificada = PERGUNTA_DO_DIA.fotos_em_ordem_errada;
const perguntaDo = (codigo) => PERGUNTA_DO_DIA[codigo] || PERGUNTA_DO_DIA.noturna;

let modoManual = false;
let relogio = null;
// A caixa de justificativa aberta na aba Conferencia, se houver alguma:
// { chave: 'mes' | 'dia:2026-09-04', texto, focar }. Mora fora do DOM porque
// as listas de achados sao redesenhadas a cada salvamento - o que a pessoa
// digitou nao pode sumir junto.
let justificando = null;

let eu = null;
let mes = mesAtual();
let estado = null; // { relatorio, grade, anexos, previa }
let sujo = false;
let salvando = false;

// ------------------------------------------------------------------- inicio

try {
  const dados = await api('/api/eu');
  eu = dados.usuario;
  $('meu-nome').textContent = eu.nome;
  $('minhas-iniciais').textContent = String(eu.nome || '')
    .split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  marcarAmbiente(dados.ambiente);
  if (eu.trocar_senha) pedirTrocaDeSenha();
} catch {
  location.href = '/';
}

$('mes').value = mes;
$('botao-sair').addEventListener('click', sair);

// As setas do lado do mes: andar um mes para tras ou para frente e o que mais
// se faz aqui, e o calendario do navegador pede tres toques para isso.
for (const [id, passo] of [['mes-antes', -1], ['mes-depois', 1]]) {
  $(id).addEventListener('click', () => {
    const [a, m] = $('mes').value.split('-').map(Number);
    const d = new Date(Date.UTC(a, m - 1 + passo, 1));
    $('mes').value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    $('mes').dispatchEvent(new Event('change'));
  });
}

// Clique num item da lista: vai para a etapa onde aquilo se resolve.
$('luzes').addEventListener('click', (ev) => {
  const luz = ev.target.closest('[data-ir]');
  if (luz) trocarAba(luz.dataset.ir);
});
$('mes').addEventListener('change', async () => {
  if (sujo && !confirm('Você tem alterações não salvas. Trocar de mês mesmo assim?')) {
    $('mes').value = mes;
    return;
  }
  mes = $('mes').value;
  await carregar();
});

for (const b of document.querySelectorAll('.abas button')) {
  b.addEventListener('click', () => trocarAba(b.dataset.aba));
}

$('esconder-vazios').addEventListener('change', desenharGrade);
$('botao-ler').addEventListener('click', lerRdv);

// Escape para quando a leitura falhar ou a IA estiver desligada: a pessoa
// preenche a grade na mao, como antes. Melhor que travar o envio do mes.
$('botao-manual').addEventListener('click', () => {
  modoManual = true;
  $('cartao-lido').style.display = '';
  $('cartao-lido').querySelector('h2').textContent = 'Preencha os dias';
  desenharGrade();
  mostrarRecado(
    'recado-leitura',
    'Modo manual. Preencha os dias que voce rodou — o total e o valor são calculados sozinhos.',
    'info',
  );
  $('cartao-lido').scrollIntoView({ behavior: 'smooth' });
});
$('botao-salvar').addEventListener('click', () => salvar(true));
$('botao-enviar').addEventListener('click', enviar);
$('observacao').addEventListener('input', () => marcarSujo());

// As duas listas da aba Conferencia sao redesenhadas o tempo todo, entao o
// clique e escutado no cartao, que nao troca, e nao no botao.
for (const alvo of [$('achados'), $('parecer')]) {
  alvo.addEventListener('click', cliqueNaConferencia);
  alvo.addEventListener('input', digitandoJustificativa);
}

// Salva sozinho quando a pessoa para de digitar.
function marcarSujo() {
  sujo = true;
  atualizarRodape();
  clearTimeout(relogio);
  relogio = setTimeout(() => salvar(false), 1800);
}

window.addEventListener('beforeunload', (ev) => {
  if (sujo) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

await carregar();

// ------------------------------------------------------------------ dados

async function carregar() {
  try {
    estado = await api(`/api/relatorio?mes=${mes}`);
    sujo = false;
    $('observacao').value = estado.relatorio.observacao || '';
    desenharTudo();
    carregarHistorico();
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
  }
}

function desenharTudo() {
  desenharStatus();
  desenharNumeros();
  desenharGrade();
  desenharAnexos();
  desenharConferencia();
  desenharComparacao();
  atualizarRodape();
  // O bloco de dias aparece depois da leitura, no modo manual, ou quando ja
  // existe lancamento gravado (relatorio que voltou para correcao).
  const temLinhas = estado.grade.some(
    (d) => d.km_inicial || d.km_final || d.itinerario || d.pedagio || d.estacionamento,
  );
  $('cartao-lido').style.display =
    estado.relatorio.extraido || modoManual || temLinhas ? '' : 'none';

  $('botao-ler').textContent = estado.relatorio.extraido ? 'Ler de novo' : 'Ler meu relatório';
}

// ------------------------------------------------------------- leitura do PDF

async function lerRdv() {
  const temArquivo = estado.anexos.some((a) => a.tipo === 'rdv');
  if (!temArquivo) {
    return mostrarRecado('recado-leitura', 'Anexe primeiro o arquivo do seu RDV.', 'erro');
  }

  const botao = $('botao-ler');
  botao.disabled = true;
  botao.textContent = 'Lendo o relatório...';
  mostrarRecado('recado-leitura', 'Lendo o seu relatório. Isso leva alguns segundos.', 'info');

  try {
    const r = await api('/api/relatorio/ler-rdv', { metodo: 'POST', corpo: { mes } });
    estado.grade = r.grade;
    estado.previa = r.previa;
    estado.relatorio.extraido = r.extraido;
    sujo = false;
    desenharTudo();

    const tipo =
      r.extraido.confianca === 'alta' && !/ATENCAO/.test(r.aviso) ? 'ok' : 'atencao';
    mostrarRecado('recado-leitura', r.aviso, tipo);
  } catch (e) {
    mostrarRecado('recado-leitura', e.message, 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = estado.relatorio.extraido ? 'Ler de novo' : 'Ler meu relatório';
  }
}

// Mostra o que o documento declarava contra o que a soma dos dias da.
function desenharComparacao() {
  const ex = estado.relatorio.extraido;
  const alvo = $('comparacao');
  if (!ex) {
    alvo.innerHTML = '';
    return;
  }

  const decl = ex.totais_declarados || {};
  const p = estado.previa;
  const linhas = [];

  const par = (rotulo, declarado, calculado, formatar) => {
    if (declarado == null) return;
    const bate = Math.abs(Number(declarado) - Number(calculado)) < 0.01;
    linhas.push(`
      <tr>
        <td>${rotulo}</td>
        <td class="num">${formatar(declarado)}</td>
        <td class="num">${formatar(calculado)}</td>
        <td class="num" style="color:${bate ? 'var(--verde)' : 'var(--vermelho)'}; font-weight:700">
          ${bate ? 'confere' : formatar(Number(calculado) - Number(declarado))}
        </td>
      </tr>`);
  };

  // Os nomes vem do esquema de extracao em src/extrair.js.
  par('Total de km', decl.total_km, p.totalKm, numeroBr);
  par('Valor do km', decl.valor_total_km, p.valorKm, brl);
  par('Pedágio + estacionamento', decl.pedagio_estacionamento, p.totalDeclarado, brl);

  if (!linhas.length) {
    alvo.innerHTML = `<p class="sub" style="margin:0">O documento não trouxe um quadro de
      totais para comparar. A conferência usa a soma dos dias lidos.</p>`;
    return;
  }

  alvo.innerHTML = `
    <div class="rolagem">
      <table>
        <thead><tr>
          <th>Comparação</th>
          <th class="num">O que está no seu RDV</th>
          <th class="num">Soma dos dias</th>
          <th class="num">Diferença</th>
        </tr></thead>
        <tbody>${linhas.join('')}</tbody>
      </table>
    </div>`;
}

// ------------------------------------------------------------------ status

function desenharStatus() {
  const r = estado.relatorio;
  $('selo-status').innerHTML = `<span class="selo ${r.status}">${escapar(r.rotulo_status)}</span>`;

  const painel = $('painel-status');
  if (r.status === 'ERRADA' || r.status === 'SO_FALTA_DANFE') {
    // As pendencias vem junto do recado, aqui na primeira tela.
    //
    // Elas existiam so no "Resultado da conferencia", dentro da aba
    // Conferencia - que abre fechada. Quem era reprovado lia "corrija e
    // reenvie" sem ver O QUE corrigir, a menos que descobrisse sozinho a outra
    // aba. O motivo da reprovacao tem que estar onde a pessoa cai ao entrar.
    const erros = achadosDoParecer(r).filter((a) => a.gravidade === 'erro');
    const avisos = achadosDoParecer(r).filter((a) => a.gravidade === 'aviso');

    painel.innerHTML = `
      <div class="aviso ${r.status === 'ERRADA' ? 'erro' : 'atencao'}">
        <strong>O que você precisa fazer:</strong><br>${escapar(r.o_que_fazer || 'Corrija e reenvie.')}
      </div>
      ${
        erros.length
          ? `<h2 style="margin:16px 0 8px">O que está errado (${erros.length})</h2>
             ${erros.map((a) => linhaDeAchado(a)).join('')}`
          : ''
      }
      ${
        avisos.length
          ? `<h2 style="margin:16px 0 8px">Confira também (${avisos.length})</h2>
             ${avisos.map((a) => linhaDeAchado(a)).join('')}`
          : ''
      }`;
  } else if (r.status === 'CERTA') {
    painel.innerHTML = `<div class="aviso ok">Relatório aprovado. Nada a fazer.</div>`;
  } else if (r.status === 'ENVIADO' || r.status === 'CONFERINDO') {
    painel.innerHTML = `<div class="aviso info">Enviado em ${dataHoraBr(
      r.enviado_em,
    )}. Aguardando conferência — não dá para editar até sair o resultado.</div>`;
  } else {
    painel.innerHTML = '';
  }
}

function desenharNumeros() {
  const p = estado.previa;
  $('numeros').innerHTML = `
    <div class="numero">
      <div class="rotulo">Total de km</div>
      <div class="valor">${numeroBr(p.totalKm)}</div>
    </div>
    <div class="numero destaque">
      <div class="rotulo">Valor do km (× ${brl(estado.valor_km)})</div>
      <div class="valor">${brl(p.valorKm)}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Pedágio</div>
      <div class="valor">${brl(p.pedagioDeclarado)}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Estacionamento</div>
      <div class="valor">${brl(p.estacDeclarado)}</div>
    </div>`;
}

// ------------------------------------------------------------------- grade

function desenharGrade() {
  if (!estado) return;
  const esconder = $('esconder-vazios').checked;
  const editavel = estado.relatorio.editavel;

  const html = estado.grade
    .filter((d) => {
      if (!esconder) return true;
      const preenchido = d.km_inicial || d.km_final || d.itinerario || d.pedagio || d.estacionamento;
      return preenchido || (!d.fim_de_semana && !d.feriado);
    })
    .map((d) => desenharDia(d, editavel))
    .join('');

  $('grade').innerHTML = html;

  for (const campo of $('grade').querySelectorAll('input')) {
    campo.addEventListener('input', () => {
      atualizarLinhaLocal(campo.dataset.data);
      marcarSujo();
    });
  }
}

function desenharDia(d, editavel) {
  const rodou = Math.max(0, Number(d.km_final) - Number(d.km_inicial));
  const classes = ['dia'];
  if (d.fim_de_semana) classes.push('folga');
  if (d.feriado) classes.push('feriado');

  const marca = d.feriado
    ? `<span class="marca-dia">${escapar(d.feriado)}</span>`
    : d.fim_de_semana
      ? `<span class="marca-dia">não lançar</span>`
      : '';

  const trava = editavel ? '' : 'disabled';

  return `
  <div class="${classes.join(' ')}">
    <div class="cabeca">
      <span>${dataBr(d.data)}</span>
      <span class="semana">${escapar(d.dia_semana)}</span>
      ${marca}
    </div>
    <div class="campos">
      <div>
        <label>Km inicial</label>
        <input type="number" inputmode="numeric" step="1" min="0" ${trava}
               data-data="${d.data}" data-campo="km_inicial" value="${d.km_inicial || ''}">
      </div>
      <div>
        <label>Km final</label>
        <input type="number" inputmode="numeric" step="1" min="0" ${trava}
               data-data="${d.data}" data-campo="km_final" value="${d.km_final || ''}">
      </div>
      <div class="largo">
        <label>Itinerário</label>
        <input type="text" placeholder="De onde para onde, e por quê" ${trava}
               data-data="${d.data}" data-campo="itinerario" value="${escapar(d.itinerario)}">
      </div>
      <div>
        <label>Pedágio (R$)</label>
        <input type="number" inputmode="decimal" step="0.01" min="0" ${trava}
               data-data="${d.data}" data-campo="pedagio" value="${d.pedagio || ''}">
      </div>
      <div>
        <label>Estacionamento (R$)</label>
        <input type="number" inputmode="decimal" step="0.01" min="0" ${trava}
               data-data="${d.data}" data-campo="estacionamento" value="${d.estacionamento || ''}">
      </div>
      <div class="rodou" data-rodou="${d.data}">${rodou > 0 ? `${numeroBr(rodou)} km neste dia` : ''}</div>
    </div>
    ${
      cobrancaNoturna(d.data)
        ? `<div class="depois-das-18">
             <label>${escapar(cobrancaNoturna(d.data))}</label>
             <input type="text" ${trava} placeholder="Ex.: visita terminou tarde em Sorocaba"
                    data-data="${d.data}" data-campo="justificativa_hora"
                    value="${escapar(d.justificativa_hora || '')}">
           </div>`
        : ''
    }
  </div>`;
}

// A caixa de explicacao aparece nos dias que a CONFERENCIA apontou.
//
// A hora vem do extrato da tag, lido pela IA - nao de um campo que a pessoa
// preenche. Se dependesse dela digitar, quem quisesse burlar escrevia 14:00 e
// pronto. Entao a cobranca chega junto com o parecer, no dia em que a despesa
// caiu, e o campo aparece exatamente ali.
function cobrancaNoturna(data) {
  const doParecer = achadosDoParecer(estado.relatorio)
    .find((a) => a.codigo === 'despesa_noturna_sem_justificativa' && a.data === data);
  return doParecer ? doParecer.mensagem : null;
}

function atualizarLinhaLocal(data) {
  const dia = estado.grade.find((d) => d.data === data);
  if (!dia) return;
  for (const campo of $('grade').querySelectorAll(`input[data-data="${data}"]`)) {
    const nome = campo.dataset.campo;
    dia[nome] = ['itinerario', 'hora_pedagio', 'justificativa_hora'].includes(nome)
      ? campo.value
      : Number(campo.value || 0);
  }
  const rodou = Math.max(0, dia.km_final - dia.km_inicial);
  const alvo = $('grade').querySelector(`[data-rodou="${data}"]`);
  if (alvo) alvo.textContent = rodou > 0 ? `${numeroBr(rodou)} km neste dia` : '';
  recalcularLocal();
}

// Recalcula na tela sem ida ao servidor, pra resposta ser instantanea.
function recalcularLocal() {
  let km = 0, ped = 0, est = 0;
  for (const d of estado.grade) {
    km += Math.max(0, Number(d.km_final) - Number(d.km_inicial));
    ped += Number(d.pedagio || 0);
    est += Number(d.estacionamento || 0);
  }
  estado.previa.totalKm = km;
  estado.previa.valorKm = Number((km * estado.valor_km).toFixed(2));
  estado.previa.pedagioDeclarado = Number(ped.toFixed(2));
  estado.previa.estacDeclarado = Number(est.toFixed(2));
  desenharNumeros();
  desenharComparacao();
  atualizarRodape();
}

// ------------------------------------------------------------------ anexos

function desenharAnexos() {
  for (const tipo of ['rdv', 'danfe', 'pedagio', 'odometro', 'outro']) {
    const lista = estado.anexos.filter((a) => a.tipo === tipo);
    const alvo = $(`lista-${tipo}`);
    if (!alvo) continue;

    if (lista.length === 0) {
      alvo.innerHTML = `<p class="sub" style="margin:0">Nenhum arquivo enviado.</p>`;
      continue;
    }

    alvo.innerHTML = lista
      .map(
        (a) => `
      <div class="anexo">
        <span class="nome"><a href="/api/anexo/${a.id}" target="_blank" rel="noopener">${escapar(
          a.nome_original,
        )}</a></span>
        ${
          a.km
            ? `<span class="selo CERTA">${numeroBr(a.km)} km${
                a.data_leitura ? ` · ${dataBr(a.data_leitura)}` : ''
              }</span>`
            : ''
        }
        <span class="peso">${tamanhoBr(a.tamanho)}</span>
        ${
          // `aceita_anexo`, nao `editavel`: quem ja enviou precisa poder TROCAR
          // um arquivo errado, e trocar e remover o velho e mandar o certo.
          // So `editavel` deixaria ele acrescentar sem nunca substituir.
          estado.relatorio.aceita_anexo
            ? `<button class="secundario pequeno" data-apagar="${a.id}">Remover</button>`
            : ''
        }
      </div>`,
      )
      .join('');

    for (const b of alvo.querySelectorAll('[data-apagar]')) {
      b.addEventListener('click', () => apagarAnexo(b.dataset.apagar));
    }
  }
}

for (const zona of document.querySelectorAll('.solta')) {
  zona.addEventListener('click', () => {
    if (!estado.relatorio.aceita_anexo) {
      return mostrarRecado('recado', 'Esse relatório já foi enviado e não aceita mais anexos.', 'atencao');
    }
    // Reprovado por falta da nota: a única coisa que ainda entra é a DANFE.
    // O RDV desse mês já foi conferido e não se mexe mais nele.
    if (estado.relatorio.so_falta_danfe && zona.dataset.tipo !== 'danfe') {
      return mostrarRecado(
        'recado',
        'Esse relatório está esperando só a nota de abastecimento. Anexe a DANFE — o resto já foi conferido.',
        'atencao',
      );
    }
    tipoEmUso = zona.dataset.tipo;
    // Sem `accept`, o celular abre direto na galeria e a planilha nem aparece
    // como opcao. Listando os tipos, o seletor mostra tambem os Arquivos.
    // O RDV so entra em PDF ou foto: planilha o portal ate le, mas a
    // conferencia nao consegue olhar - o servidor tambem recusa.
    seletor.accept =
      tipoEmUso === 'odometro' ? 'image/*'
        : tipoEmUso === 'rdv' ? SO_PDF_E_FOTO
          : ACEITOS;

    // NAO usar `capture` aqui.
    //
    // A foto do odometro ja teve `capture="environment"`, para forcar a foto na
    // hora. O efeito colateral e que o celular abre a camera DIRETO: a galeria
    // nem aparece como opcao, entao quem ja tinha fotografado o painel de manha
    // nao conseguia anexar. E `capture` tambem anula o `multiple` - dava uma
    // foto por vez, sendo que o esperado sao duas por semana.
    //
    // Sem ele, com `accept="image/*"`, o celular abre o menu de sempre:
    // Camera, Galeria e Arquivos. Quem quiser fotografar na hora continua
    // podendo, em um toque a mais.
    seletor.removeAttribute('capture');
    seletor.click();
  });

  zona.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    zona.classList.add('sobre');
  });
  zona.addEventListener('dragleave', () => zona.classList.remove('sobre'));
  zona.addEventListener('drop', (ev) => {
    ev.preventDefault();
    zona.classList.remove('sobre');
    tipoEmUso = zona.dataset.tipo;
    enviarArquivos([...ev.dataTransfer.files]);
  });
}

seletor.addEventListener('change', () => {
  enviarArquivos([...seletor.files]);
  seletor.value = '';
});

let avisoDoServidor = '';

async function enviarArquivos(arquivos) {
  if (!arquivos.length || !tipoEmUso) return;

  // Foto de odometro vai junto com o numero do painel. Sem isso a foto so
  // serve para alguem abrir e ler na mao depois.
  const extras = new Map();
  if (tipoEmUso === 'odometro') {
    for (const arquivo of arquivos) {
      const km = await pedirKm(arquivo);
      if (km === null) {
        return mostrarRecado('recado', 'Envio cancelado — a foto do odômetro precisa do KM.', 'atencao');
      }
      extras.set(arquivo, km);
    }
  }

  mostrarRecado('recado', `Enviando ${arquivos.length} arquivo(s)...`, 'info');
  try {
    for (const arquivo of arquivos) {
      if (arquivo.size === 0) {
        throw new Error(`"${arquivo.name}" está vazio (0 KB). Tente gerar o arquivo de novo.`);
      }
      const r = await subirArquivo(arquivo, { mes, tipo: tipoEmUso, ...(extras.get(arquivo) || {}) });
      estado.anexos = r.anexos;
      // Anexar a DANFE que faltava ja devolve o relatorio para a conferencia:
      // o servidor avisa, e o status muda debaixo da tela.
      if (r.aviso) avisoDoServidor = r.aviso;
    }
    // revalidar() primeiro: o status pode ter mudado, e os anexos sao
    // desenhados conforme o que o novo status ainda permite.
    await revalidar();
    desenharAnexos();
    mostrarRecado('recado', avisoDoServidor || 'Arquivos enviados.', 'ok');
    if (!avisoDoServidor) setTimeout(() => mostrarRecado('recado', ''), 2500);
    avisoDoServidor = '';
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
  }
}

// Caixa que mostra a foto escolhida e pede o numero do painel e o dia.
// Ver a imagem na hora de digitar evita o erro bobo de trocar as fotos.
function pedirKm(arquivo) {
  return new Promise((resolve) => {
    const fundo = document.createElement('div');
    fundo.className = 'fundo-modal';
    fundo.innerHTML = `
      <div class="modal" style="max-width:640px">
        <h2>Qual o KM desta foto?</h2>
        <p class="sub">${escapar(arquivo.name)}</p>
        <img alt="foto do odômetro" id="previa-foto" class="foto-odometro">
        <p class="sub" style="font-size:13px">Toque na foto para ampliar.</p>
        <div id="recado-km"></div>
        <label for="km-foto">KM que aparece no painel</label>
        <input type="number" id="km-foto" inputmode="numeric" step="1" min="1"
               placeholder="ex.: 271368" autocomplete="off">
        <label for="data-foto">Dia da foto</label>
        <input type="date" id="data-foto" value="${new Date().toISOString().slice(0, 10)}">
        <div class="linha-botoes">
          <button id="km-ok">Anexar</button>
          <button class="secundario" id="km-cancela">Cancelar</button>
        </div>
      </div>`;

    document.body.appendChild(fundo);

    const url = URL.createObjectURL(arquivo);
    const foto = fundo.querySelector('#previa-foto');
    foto.src = url;

    // Um toque abre a foto na tela inteira. Mesmo com a previa maior, o numero
    // do painel sai pequeno na foto de celular, e errar um digito aqui e o tipo
    // de coisa que so aparece la na frente, na conferencia.
    let lupa = null;
    foto.addEventListener('click', () => {
      lupa = document.createElement('div');
      lupa.className = 'lupa';
      lupa.innerHTML = '<img alt="foto do odômetro ampliada">';
      lupa.querySelector('img').src = url;
      lupa.addEventListener('click', () => {
        lupa.remove();
        lupa = null;
      });
      document.body.appendChild(lupa);
    });

    const campo = fundo.querySelector('#km-foto');
    campo.focus();

    const fechar = (valor) => {
      if (lupa) lupa.remove();
      URL.revokeObjectURL(url);
      fundo.remove();
      resolve(valor);
    };

    const confirmar = () => {
      const km = Number(campo.value);
      if (!Number.isFinite(km) || km <= 0) {
        return mostrarRecado('recado-km', 'Digite o número que aparece no painel.', 'erro');
      }
      fechar({ km, data: fundo.querySelector('#data-foto').value || undefined });
    };

    fundo.querySelector('#km-ok').addEventListener('click', confirmar);
    fundo.querySelector('#km-cancela').addEventListener('click', () => fechar(null));
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') confirmar();
    });
  });
}

async function apagarAnexo(id) {
  if (!confirm('Remover este arquivo?')) return;
  try {
    const r = await api(`/api/anexo/${id}`, { metodo: 'DELETE' });
    estado.anexos = r.anexos;
    desenharAnexos();
    await revalidar();
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
  }
}

// -------------------------------------------------------------- conferencia

// O mes ainda esta em branco? Nesse caso nao ha o que conferir, e dizer "pode
// enviar" seria mentira - nao existe nada para enviar.
function mesEmBranco() {
  if (estado.anexos.length) return false;
  return !(estado.grade || []).some(
    (d) => Number(d.km_inicial) || Number(d.km_final) || Number(d.pedagio)
      || Number(d.estacionamento) || String(d.itinerario || '').trim(),
  );
}

// As duas listas da aba Conferencia sao desenhadas JUNTAS, de proposito.
//
// O mesmo achado pode aparecer nas duas - a previa ao vivo e o parecer que o
// conferente devolveu. Se cada lista decidisse sozinha, o aumento ganharia
// dois botoes de justificar, e duas caixas abertas para o mesmo texto: a
// segunda apagaria o que a pessoa escreveu na primeira. Entao o desenho passa
// um conjunto de chaves adiante, e o botao sai so na primeira aparicao.
function desenharConferencia() {
  const chavesUsadas = new Set();
  desenharAchados(chavesUsadas);
  desenharParecer(chavesUsadas);

  if (justificando?.focar) {
    justificando.focar = false;
    const campo = document.querySelector('[data-campo-justificativa]');
    if (campo) {
      campo.focus();
      campo.setSelectionRange(campo.value.length, campo.value.length);
      campo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function desenharAchados(chavesUsadas) {
  const lista = estado.previa.achados || [];
  if (!lista.length) {
    $('achados').innerHTML = mesEmBranco()
      ? `<div class="aviso ok">Nada pendente ainda. Comece preenchendo os dias na aba Meu relatório.</div>`
      : `<div class="aviso ok">Nenhuma pendência. Pode enviar.</div>`;
    return;
  }
  $('achados').innerHTML = lista.map((a) => linhaDeAchado(a, chavesUsadas)).join('');
}

// O parecer chega em duas formas: o GET entrega array, e o PUT devolve a linha
// crua do banco, onde `achados` ainda e o texto JSON. Como o parecer passou a
// ser redesenhado depois de cada salvamento, quem le tem que aceitar as duas.
function achadosDoParecer(r) {
  if (Array.isArray(r?.achados)) return r.achados;
  if (typeof r?.achados === 'string') {
    try {
      const lista = JSON.parse(r.achados);
      return Array.isArray(lista) ? lista : [];
    } catch {
      return [];
    }
  }
  return [];
}

function desenharParecer(chavesUsadas) {
  const r = estado.relatorio;
  const lista = achadosDoParecer(r);
  if (!lista.length || !r.conferido_em) {
    $('cartao-parecer').style.display = 'none';
    return;
  }
  $('cartao-parecer').style.display = '';
  $('parecer').innerHTML = `
    <p class="sub">
      Conferido em ${dataHoraBr(r.conferido_em)}. É o que o conferente viu no seu
      relatório. O que se resolve explicando tem o botão de justificar aqui do lado.
    </p>
    ${lista.map((a) => linhaDeAchado(a, chavesUsadas)).join('')}`;
}

// ------------------------------------------------------- justificativas

// Uma justificativa por chave: a do aumento vale o mes inteiro, a da despesa
// noturna vale o dia em que a passagem caiu.
function chaveDoAchado(a) {
  const alvo = PEDEM_JUSTIFICATIVA.get(a.codigo);
  if (!alvo) return null;
  if (alvo === 'mes') return 'mes';
  return a.data ? `dia:${a.data}` : null;
}

function textoJaEscrito(chave) {
  if (chave === 'mes') return estado?.relatorio.justificativa || '';
  const data = chave.slice(4);
  return estado?.grade.find((d) => d.data === data)?.justificativa_hora || '';
}

// `chavesUsadas` e o conjunto do desenho da aba Conferencia. Sem ele o achado
// sai sem botao - e o caso do painel de status, que so lista as pendencias.
// O `instanceof` nao e paranoia: `lista.map(linhaDeAchado)` passaria o INDICE
// aqui, e o segundo achado da lista derrubava a tela inteira.
function linhaDeAchado(a, chavesUsadas = null) {
  if (!(chavesUsadas instanceof Set)) chavesUsadas = null;
  const chave = chavesUsadas ? chaveDoAchado(a) : null;
  // Em conferencia o relatorio esta trancado: mostrar um botao que nao grava
  // seria pior do que nao ter botao nenhum.
  const podeJustificar = !!chave && !chavesUsadas.has(chave) && !!estado?.relatorio.editavel;
  if (podeJustificar) chavesUsadas.add(chave);

  const escrito = podeJustificar ? textoJaEscrito(chave) : '';
  const aberta = podeJustificar && justificando?.chave === chave;

  const botao = !podeJustificar || aberta ? '' : `
    <button class="pequeno" data-abrir-justificativa="${chave}" data-codigo="${escapar(a.codigo)}">
      ${escrito ? 'Editar a justificativa' : 'Escrever a justificativa'}
    </button>`;

  // O parecer e uma foto do dia da conferencia: escrever a explicacao de um
  // dia nao apaga a cobranca dali, ela so sai quando alguem reconfere. Sem
  // este bloco a pessoa escreve, ve o vermelho continuar igual e escreve de
  // novo, achando que nao salvou.
  const resposta = podeJustificar && escrito && chave !== 'mes' && !aberta
    ? `<div class="resposta">
         <strong>Você já explicou:</strong> ${escapar(escrito)}<br>
         Está salvo. O vermelho só sai daqui quando o conferente olhar de novo.
       </div>`
    : '';

  return `<div class="achado ${a.gravidade}">
    <span class="icone">${a.gravidade === 'erro' ? '✕' : '!'}</span>
    <div class="corpo">
      <span>${escapar(a.mensagem)}</span>
      ${anexoDoAchado(a)}
      ${resposta}
      ${botao}
      ${aberta ? caixaDeJustificativa(chave) : ''}
    </div>
  </div>`;
}

function caixaDeJustificativa(chave) {
  const doMes = chave === 'mes';
  const c = estado.previa?.comparacao;

  const comparacao = doMes && c
    ? `<p class="conta">
         Este mês: ${brl(c.total_atual)} · mês anterior: ${brl(c.total_anterior)} ·
         diferença: <strong>${brl(c.diferenca)}</strong> (a empresa pede explicação
         acima de ${brl(c.margem)}).
       </p>`
    : '';

  return `
    <div class="caixa-justificativa">
      <label for="campo-justificativa">
        ${doMes
          ? 'Por que este mês ficou mais caro que o anterior?'
          : perguntaDo(justificando.codigo).rotulo}
      </label>
      ${comparacao}
      <textarea id="campo-justificativa" data-campo-justificativa
        placeholder="${doMes
          ? 'Ex.: assumi a rota do litoral no lugar de um colega afastado, foram três viagens a Santos no mês.'
          : perguntaDo(justificando.codigo).exemplo}">${escapar(justificando.texto)}</textarea>
      <p class="dica" data-dica-justificativa>${dicaDaCaixa(chave)}</p>
      <p class="erro-caixa esconde" data-erro-justificativa></p>
      <div class="linha-botoes">
        <button class="pequeno" data-enviar-justificativa>Enviar justificativa</button>
        <button class="pequeno secundario" data-cancelar-justificativa>Cancelar</button>
      </div>
    </div>`;
}

// Quantas letras ainda faltam - a regra dos 15 e do servidor, e a pessoa
// precisa saber disso ANTES de clicar em enviar e levar uma recusa.
function dicaDaCaixa(chave) {
  const texto = (justificando?.texto || '').trim();
  if (chave !== 'mes') {
    return PERGUNTA_DO_DIA[justificando?.codigo]
      ? 'Quem confere lê exatamente este texto. É a mesma explicação do dia, vale para as pendências dele.'
      : 'Vale para todas as passagens desse dia. Escreva o que te fez estar na rua àquela hora.';
  }
  const faltam = 15 - texto.length;
  return faltam > 0
    ? `Conte o que mudou na sua rota. Faltam ${faltam} letra${faltam === 1 ? '' : 's'} para o mínimo.`
    : 'Pode enviar. Quem confere lê exatamente este texto.';
}

function cliqueNaConferencia(ev) {
  const abrir = ev.target.closest('[data-abrir-justificativa]');
  if (abrir) return abrirJustificativa(abrir.dataset.abrirJustificativa, abrir.dataset.codigo);

  if (ev.target.closest('[data-cancelar-justificativa]')) {
    justificando = null;
    return desenharConferencia();
  }

  if (ev.target.closest('[data-enviar-justificativa]')) return enviarJustificativa();
}

// Digitar nao redesenha a lista: perderia o foco no meio da frase. So o texto
// guardado, a dica e o contador de letras acompanham.
function digitandoJustificativa(ev) {
  const campo = ev.target.closest('[data-campo-justificativa]');
  if (!campo || !justificando) return;
  justificando.texto = campo.value;
  const dica = document.querySelector('[data-dica-justificativa]');
  if (dica) dica.textContent = dicaDaCaixa(justificando.chave);
  const erro = document.querySelector('[data-erro-justificativa]');
  if (erro) erro.classList.add('esconde');
}

function abrirJustificativa(chave, codigo = null) {
  justificando = { chave, codigo, texto: textoJaEscrito(chave), focar: true };
  trocarAba('conferencia');
  desenharConferencia();
}

async function enviarJustificativa() {
  if (!justificando) return;
  const { chave } = justificando;
  const texto = justificando.texto.trim();

  // O minimo de 15 e a mesma conta do servidor (conferencia.js). Recusar aqui
  // evita a pessoa salvar, ver o vermelho continuar e nao entender o porque.
  const curto = chave === 'mes' ? texto.length < 15 : texto.length === 0;
  if (curto) {
    const erro = document.querySelector('[data-erro-justificativa]');
    if (erro) {
      erro.textContent = chave === 'mes'
        ? `Escreva pelo menos 15 letras — está com ${texto.length}. Quem confere precisa entender o motivo sem te ligar.`
        : 'Escreva o motivo antes de enviar.';
      erro.classList.remove('esconde');
    }
    return;
  }

  if (chave === 'mes') {
    estado.relatorio.justificativa = texto;
  } else {
    const dia = estado.grade.find((d) => d.data === chave.slice(4));
    if (!dia) return mostrarRecado('recado', 'Não achei esse dia no seu mês. Recarregue a página.', 'erro');
    dia.justificativa_hora = texto;
  }

  justificando = null;
  // salvar() manda a grade inteira junto. Um PUT so com o texto apagaria os
  // lancamentos do mes - o servidor troca as linhas pelas que recebeu.
  await salvar(false);
  desenharGrade();
  mostrarRecado('recado', 'Justificativa salva. Ela vai junto do relatório para quem confere.', 'ok');
  setTimeout(() => mostrarRecado('recado', ''), 4000);
}

// ------------------------------------------------------------ salvar/enviar

function linhasParaEnviar() {
  return estado.grade.map((d) => ({
    data: d.data,
    km_inicial: d.km_inicial,
    km_final: d.km_final,
    itinerario: d.itinerario,
    pedagio: d.pedagio,
    estacionamento: d.estacionamento,
    justificativa_hora: d.justificativa_hora,
  }));
}

async function salvar(avisar) {
  if (!estado?.relatorio.editavel || salvando) return;
  salvando = true;
  $('botao-salvar').disabled = true;
  try {
    const r = await api('/api/relatorio', {
      metodo: 'PUT',
      corpo: {
        mes,
        linhas: linhasParaEnviar(),
        observacao: $('observacao').value,
        justificativa: estado.relatorio.justificativa || '',
      },
    });
    estado.relatorio = { ...estado.relatorio, ...r.relatorio };
    estado.previa = r.previa;
    sujo = false;
    desenharNumeros();
    desenharConferencia();
    atualizarRodape();
    if (avisar) {
      mostrarRecado('recado', 'Salvo.', 'ok');
      setTimeout(() => mostrarRecado('recado', ''), 2000);
    }
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
  } finally {
    salvando = false;
    $('botao-salvar').disabled = false;
  }
}

// Recarrega a conferencia do servidor (usado depois de mexer em anexo).
async function revalidar() {
  const r = await api(`/api/relatorio?mes=${mes}`);
  estado.previa = r.previa;
  estado.relatorio = r.relatorio;
  desenharConferencia();
  atualizarRodape();
}

async function enviar() {
  if (sujo) await salvar(false);

  const erros = (estado.previa.achados || []).filter((a) => a.gravidade === 'erro');

  // Nem todo vermelho impede o envio.
  //
  // O colaborador ve a lista inteira na aba Conferencia, para poder corrigir
  // antes. Mas travar o botao em tudo que e vermelho impediria de mandar o RDV
  // sem a nota de abastecimento - e esse fluxo existe de proposito, e o status
  // "So falta DANFE". Entao a tela so trava no que o servidor tambem recusa; o
  // resto vira um aviso com confirmacao.
  const travam = erros.filter((e) => TRAVAM_O_ENVIO.has(e.codigo));
  const avisam = erros.filter((e) => !TRAVAM_O_ENVIO.has(e.codigo));

  if (travam.some((e) => e.codigo === 'aumento_sem_justificativa')) {
    // Nao basta mandar para a Conferencia: a caixa ja abre escrita e focada,
    // com o cursor dentro. O caminho entre "nao deu para enviar" e "escrever a
    // explicacao" tem que ser zero clique.
    abrirJustificativa('mes');
    return mostrarRecado(
      'recado',
      'Falta explicar o aumento deste mês. Abri a caixa na aba Conferência — escreva o motivo e clique em Enviar justificativa.',
      'erro',
    );
  }

  if (travam.length) {
    trocarAba('conferencia');
    return mostrarRecado(
      'recado',
      'Corrija os pontos em vermelho antes de enviar. Eles estão na aba Conferência.',
      'erro',
    );
  }

  if (avisam.length && !confirm(
    `Antes de enviar, ainda falta:\n\n${avisam.map((a) => `• ${a.mensagem}`).join('\n')}\n\n`
      + 'Isso costuma reprovar o relatório. Enviar assim mesmo?',
  )) {
    trocarAba('comprovantes');
    return;
  }

  $('botao-enviar').disabled = true;
  try {
    const r = await api('/api/relatorio/enviar', { metodo: 'POST', corpo: { mes } });
    mostrarRecado('recado', r.aviso, avisam.length ? 'atencao' : 'ok');
    await carregar();
  } catch (e) {
    const bloqueios = e.dados?.bloqueios;
    if (bloqueios?.length) {
      trocarAba('conferencia');
      // Pelo mesmo desenho da lista: se o servidor recusou por falta de
      // justificativa, o botao de escrever vem junto da recusa.
      const chavesUsadas = new Set();
      $('achados').innerHTML = bloqueios
        .map((a) => linhaDeAchado({ gravidade: 'erro', ...a }, chavesUsadas))
        .join('');
    }
    mostrarRecado('recado', e.message, 'erro');
  } finally {
    $('botao-enviar').disabled = false;
  }
}

// ------------------------------------------------------------ resumo do mes

function luzesDoMes() {
  const p = estado.previa;
  const achados = p.achados || [];
  const tem = (t) => estado.anexos.some((a) => a.tipo === t);
  const lido = estado.grade.some((d) => d.km_inicial || d.km_final);
  const erros = achados.filter((a) => a.gravidade === 'erro');
  const avisos = achados.filter((a) => a.gravidade === 'aviso');
  const doOdometro = achados.filter((a) => DO_ODOMETRO.test(a.codigo));
  const fotos = p.qtdFotosOdometro || 0;
  // A luz do pedagio olha a conferencia, nao so o arquivo: extrato anexado com
  // diferenca de valor continua sendo problema.
  const doPedagio = achados.filter((a) => a.codigo.startsWith('pedagio') && a.gravidade === 'erro');
  const semNota = achados.some((a) => a.codigo === 'sem_danfe');

  return [
    {
      icone: 'rdv', ir: 'lancamentos', titulo: 'RDV',
      estado: lido ? 'ok' : tem('rdv') ? 'alerta' : 'falha',
      texto: lido ? `${numeroBr(p.totalKm)} km lidos` : tem('rdv') ? 'Anexado, falta ler' : 'Anexe o PDF',
    },
    {
      icone: 'nota', ir: 'comprovantes', titulo: 'Nota do combustível',
      estado: tem('danfe') && !semNota ? 'ok' : 'falha',
      texto: tem('danfe') && !semNota ? 'Enviada' : 'Falta enviar',
    },
    {
      icone: 'pedagio', ir: p.totalDeclarado > 0 && !tem('pedagio') ? 'comprovantes' : 'conferencia',
      titulo: 'Pedágio',
      estado: doPedagio.length ? 'falha' : 'ok',
      texto: p.totalDeclarado > 0 && !tem('pedagio') ? 'Falta o extrato'
        : doPedagio.length ? 'Valor não bate'
        : p.totalDeclarado > 0 ? `${brl(p.totalDeclarado)} comprovado` : 'Nada lançado',
    },
    {
      icone: 'odometro', ir: 'comprovantes', titulo: 'Fotos do odômetro',
      estado: doOdometro.some((a) => a.gravidade === 'erro') ? 'falha' : doOdometro.length ? 'alerta' : 'ok',
      texto: fotos ? `${fotos} foto${fotos > 1 ? 's' : ''}${doOdometro.length ? ', confira' : ''}` : 'Nenhuma foto',
    },
    {
      icone: 'pendencia', ir: 'conferencia', titulo: 'Pendências',
      estado: erros.length ? 'falha' : avisos.length ? 'alerta' : 'ok',
      texto: erros.length
        ? `${erros.length} para corrigir`
        : avisos.length ? `${avisos.length} aviso${avisos.length > 1 ? 's' : ''}` : 'Nenhuma',
    },
  ];
}

function desenharPainel() {
  const p = estado.previa;
  const r = estado.relatorio;
  const luzes = luzesDoMes();

  $('titulo-mes').textContent = `Relatório de ${r.mes_extenso || 'viagem'}`;
  $('odometro').textContent = `${numeroBr(p.totalKm || 0)} km`;
  $('cifra-pedagio').textContent = brl(p.totalDeclarado || 0);
  $('a-receber').textContent = brl(p.totalDoMes || 0);

  // Quanto do mes ja esta pronto para enviar.
  const prontos = luzes.filter((l) => l.estado === 'ok').length;
  $('medidor-barra').style.width = `${Math.round((prontos / luzes.length) * 100)}%`;
  $('medidor-barra').classList.toggle('completo', prontos === luzes.length);
  $('medidor-quanto').textContent = `${prontos} de ${luzes.length}`;
  const falta = luzes.length - prontos;
  $('medidor-frase').textContent =
    r.status === 'CERTA' ? 'Relatório aprovado'
    : r.status === 'ENVIADO' || r.status === 'CONFERINDO' ? 'Enviado, aguardando a conferência'
    : falta === 0 ? 'Tudo pronto para enviar'
    : `Falta${falta > 1 ? 'm' : ''} ${falta} ${falta > 1 ? 'itens' : 'item'} para enviar`;

  $('luzes').innerHTML = luzes
    .map((l) => `
      <li><button class="item ${l.estado}" data-ir="${l.ir}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${MARCA_DO_ITEM[l.estado]}</svg>
        <span><span class="t">${escapar(l.titulo)}</span><span class="s">${escapar(l.texto)}</span></span>
      </button></li>`)
    .join('');

  // O estado de cada etapa.
  const [rdv, nota, pedagio, fotos, pend] = luzes;
  const comprov = [nota, pedagio, fotos].filter((l) => l.estado === 'ok').length;
  const nErros = (p.achados || []).filter((a) => a.gravidade === 'erro').length;
  paradaEm('estado-lancamentos', rdv.estado, rdv.estado === 'ok' ? 'Lido' : 'Falta');
  paradaEm('estado-comprovantes', comprov === 3 ? 'ok' : 'falha', `${comprov}/3`);
  paradaEm('estado-conferencia', pend.estado, nErros ? String(nErros) : pend.estado === 'ok' ? 'Ok' : '!');
}

function paradaEm(id, estadoLuz, texto) {
  const alvo = $(id);
  if (!alvo) return;
  alvo.className = `estado-etapa ${estadoLuz}`;
  alvo.textContent = texto;
}

function atualizarRodape() {
  if (!estado) return;
  desenharPainel();
  const p = estado.previa;
  const editavel = estado.relatorio.editavel;
  $('resumo-rodape').innerHTML = `
    <strong>${numeroBr(p.totalKm)} km</strong> · ${brl(p.valorKm)}<br>
    ${sujo ? 'Alterações não salvas' : 'Tudo salvo'}`;
  $('botao-salvar').classList.toggle('esconde', !editavel);
  $('botao-enviar').classList.toggle('esconde', !editavel);
  $('botao-enviar').textContent =
    estado.relatorio.status === 'RASCUNHO' ? 'Enviar' : 'Reenviar corrigido';
}

// ---------------------------------------------------------------- historico

async function carregarHistorico() {
  try {
    const lista = await api('/api/meus-relatorios');
    if (!lista.length) {
      $('historico').innerHTML = `<p class="sub">Nenhum relatório ainda.</p>`;
      return;
    }
    // Pedagio e estacionamento aparecem separados, e o total ao lado: o valor
    // do km sozinho nao e o que a pessoa recebe pelo mes, e ela nao deveria
    // precisar somar de cabeca para saber.
    $('historico').innerHTML = `
      <table>
        <thead><tr>
          <th>Mês</th><th>Status</th><th class="num">Km</th>
          <th class="num">Valor do km</th>
          <th class="num">Pedágio</th><th class="num">Estacion.</th>
          <th class="num">Total</th>
          <th>O que fazer</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${lista
            .map((r) => {
              const pedagio = Number(r.pedagio_declarado || 0);
              const estac = Number(r.estac_declarado || 0);
              return `<tr>
            <td>${escapar(r.mes_extenso)}</td>
            <td><span class="selo ${r.status}">${escapar(r.rotulo_status)}</span></td>
            <td class="num">${numeroBr(r.total_km)}</td>
            <td class="num">${brl(r.valor_km)}</td>
            <td class="num">${brl(pedagio)}</td>
            <td class="num">${brl(estac)}</td>
            <td class="num"><strong>${brl(Number(r.valor_km || 0) + pedagio + estac)}</strong></td>
            <td>${escapar(r.o_que_fazer || '—')}</td>
            <td><button class="pequeno ${EDITAVEIS.has(r.status) ? '' : 'secundario'}"
                        data-abrir-mes="${escapar(r.mes_ref)}">
              ${EDITAVEIS.has(r.status) ? 'Editar' : 'Ver'}
            </button></td>
          </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;

    // Abrir o mes da linha, sem a pessoa ter que adivinhar o seletor de mes.
    //
    // Ate aqui o historico era so leitura: para mexer num mes de tras, tinha
    // que voltar na aba "Meu relatorio" e trocar o campo de mes na mao - e
    // ninguem descobria isso sozinho. Mes reprovado ou em rascunho abre para
    // editar; o resto abre para ver, com o rodape de salvar/enviar escondido
    // pelo proprio `editavel` que o servidor manda.
    for (const b of $('historico').querySelectorAll('[data-abrir-mes]')) {
      b.addEventListener('click', () => abrirMes(b.dataset.abrirMes));
    }
  } catch { /* silencioso - o historico e secundario */ }
}

async function abrirMes(alvo) {
  if (alvo === mes) return trocarAba('lancamentos');
  if (sujo && !confirm('Você tem alterações não salvas neste mês. Abrir outro mês mesmo assim?')) {
    return;
  }
  mes = alvo;
  $('mes').value = alvo;
  await carregar();
  trocarAba('lancamentos');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --------------------------------------------------------------------- abas

function trocarAba(nome) {
  for (const b of document.querySelectorAll('.abas button')) {
    b.classList.toggle('ativa', b.dataset.aba === nome);
  }
  for (const s of document.querySelectorAll('main > section')) {
    s.classList.toggle('esconde', s.id !== `aba-${nome}`);
  }
  $('rodape').classList.toggle('esconde', nome === 'historico');
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------ troca de senha

function pedirTrocaDeSenha() {
  const fundo = document.createElement('div');
  fundo.className = 'fundo-modal';
  fundo.innerHTML = `
    <div class="modal">
      <h2>Troque sua senha</h2>
      <p class="sub">Você está usando a senha provisória. Escolha uma senha só sua.</p>
      <div id="recado-senha"></div>
      <label for="nova">Nova senha (mínimo 6 caracteres)</label>
      <input type="password" id="nova" autocomplete="new-password">
      <label for="repete">Repita a senha</label>
      <input type="password" id="repete" autocomplete="new-password">
      <div class="linha-botoes">
        <button id="confirma-senha">Trocar senha</button>
        <button class="secundario" id="depois">Depois</button>
      </div>
    </div>`;
  document.body.appendChild(fundo);

  fundo.querySelector('#depois').addEventListener('click', () => fundo.remove());
  fundo.querySelector('#confirma-senha').addEventListener('click', async () => {
    const a = fundo.querySelector('#nova').value;
    const b = fundo.querySelector('#repete').value;
    if (a.length < 6) return mostrarRecado('recado-senha', 'Mínimo de 6 caracteres.', 'erro');
    if (a !== b) return mostrarRecado('recado-senha', 'As duas senhas não batem.', 'erro');
    try {
      await api('/api/trocar-senha', { metodo: 'POST', corpo: { senha: a } });
      alert('Senha trocada. Entre de novo com a senha nova.');
      location.href = '/';
    } catch (e) {
      mostrarRecado('recado-senha', e.message, 'erro');
    }
  });
}

/** Uma pendencia desenhada, do mesmo jeito nas duas telas em que aparece. */
