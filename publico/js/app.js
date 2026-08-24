// Tela do colaborador: preencher o RDV, anexar comprovantes e enviar.

import {
  api, subirArquivo, mostrarRecado, escapar, brl, numeroBr,
  dataBr, dataHoraBr, tamanhoBr, mesAtual, sair, ROTULO_ANEXO,
} from '/js/comum.js';

const $ = (id) => document.getElementById(id);

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
  if (eu.trocar_senha) pedirTrocaDeSenha();
} catch {
  location.href = '/';
}

$('mes').value = mes;
$('botao-sair').addEventListener('click', sair);
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
$('botao-salvar').addEventListener('click', () => salvar(true));
$('botao-enviar').addEventListener('click', enviar);
$('observacao').addEventListener('input', () => marcarSujo());

// Salva sozinho quando a pessoa para de digitar.
let relogio = null;
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
  desenharAchados();
  desenharParecer();
  atualizarRodape();
}

// ------------------------------------------------------------------ status

function desenharStatus() {
  const r = estado.relatorio;
  $('selo-status').innerHTML = `<span class="selo ${r.status}">${escapar(r.rotulo_status)}</span>`;

  const painel = $('painel-status');
  if (r.status === 'ERRADA' || r.status === 'SO_FALTA_DANFE') {
    painel.innerHTML = `
      <div class="aviso ${r.status === 'ERRADA' ? 'erro' : 'atencao'}">
        <strong>O que você precisa fazer:</strong><br>${escapar(r.o_que_fazer || 'Corrija e reenvie.')}
      </div>`;
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
  </div>`;
}

function atualizarLinhaLocal(data) {
  const dia = estado.grade.find((d) => d.data === data);
  if (!dia) return;
  for (const campo of $('grade').querySelectorAll(`input[data-data="${data}"]`)) {
    const nome = campo.dataset.campo;
    dia[nome] = nome === 'itinerario' ? campo.value : Number(campo.value || 0);
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
  atualizarRodape();
}

// ------------------------------------------------------------------ anexos

function desenharAnexos() {
  for (const tipo of ['danfe', 'pedagio', 'odometro', 'outro']) {
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
        <span class="peso">${tamanhoBr(a.tamanho)}</span>
        ${
          estado.relatorio.editavel
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

const seletor = $('seletor');
let tipoEmUso = null;

for (const zona of document.querySelectorAll('.solta')) {
  zona.addEventListener('click', () => {
    if (!estado.relatorio.editavel) {
      return mostrarRecado('recado', 'Esse relatório já foi enviado e não aceita mais anexos.', 'atencao');
    }
    tipoEmUso = zona.dataset.tipo;
    seletor.accept = tipoEmUso === 'odometro' ? 'image/*' : '';
    if (tipoEmUso === 'odometro') seletor.setAttribute('capture', 'environment');
    else seletor.removeAttribute('capture');
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

async function enviarArquivos(arquivos) {
  if (!arquivos.length || !tipoEmUso) return;
  mostrarRecado('recado', `Enviando ${arquivos.length} arquivo(s)...`, 'info');
  try {
    for (const arquivo of arquivos) {
      if (arquivo.size === 0) {
        throw new Error(`"${arquivo.name}" está vazio (0 KB). Tente gerar o arquivo de novo.`);
      }
      const r = await subirArquivo(arquivo, { mes, tipo: tipoEmUso });
      estado.anexos = r.anexos;
    }
    desenharAnexos();
    await revalidar();
    mostrarRecado('recado', 'Arquivos enviados.', 'ok');
    setTimeout(() => mostrarRecado('recado', ''), 2500);
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
  }
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

function desenharAchados() {
  const lista = estado.previa.achados;
  if (!lista.length) {
    $('achados').innerHTML = `<div class="aviso ok">Nenhuma pendência. Pode enviar.</div>`;
    return;
  }
  $('achados').innerHTML = lista
    .map(
      (a) => `
    <div class="achado ${a.gravidade}">
      <span class="icone">${a.gravidade === 'erro' ? '✕' : '!'}</span>
      <span>${escapar(a.mensagem)}</span>
    </div>`,
    )
    .join('');
}

function desenharParecer() {
  const r = estado.relatorio;
  if (!r.achados || !r.conferido_em) {
    $('cartao-parecer').style.display = 'none';
    return;
  }
  $('cartao-parecer').style.display = '';
  $('parecer').innerHTML = `
    <p class="sub">Conferido em ${dataHoraBr(r.conferido_em)}.</p>
    ${r.achados
      .map(
        (a) => `<div class="achado ${a.gravidade}">
          <span class="icone">${a.gravidade === 'erro' ? '✕' : '!'}</span>
          <span>${escapar(a.mensagem)}</span></div>`,
      )
      .join('')}`;
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
  }));
}

async function salvar(avisar) {
  if (!estado?.relatorio.editavel || salvando) return;
  salvando = true;
  $('botao-salvar').disabled = true;
  try {
    const r = await api('/api/relatorio', {
      metodo: 'PUT',
      corpo: { mes, linhas: linhasParaEnviar(), observacao: $('observacao').value },
    });
    estado.relatorio = { ...estado.relatorio, ...r.relatorio };
    estado.previa = r.previa;
    sujo = false;
    desenharNumeros();
    desenharAchados();
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
  desenharAchados();
  atualizarRodape();
}

async function enviar() {
  if (sujo) await salvar(false);

  const erros = estado.previa.achados.filter((a) => a.gravidade === 'erro');
  const soDanfe = erros.length === 1 && erros[0].codigo === 'sem_danfe';

  if (erros.length && !soDanfe) {
    trocarAba('conferencia');
    return mostrarRecado(
      'recado',
      'Corrija os pontos em vermelho antes de enviar. Eles estão na aba Conferência.',
      'erro',
    );
  }

  if (soDanfe && !confirm(
    'Você não anexou a nota de abastecimento. Isso costuma reprovar o relatório. Enviar assim mesmo?',
  )) {
    trocarAba('comprovantes');
    return;
  }

  $('botao-enviar').disabled = true;
  try {
    const r = await api('/api/relatorio/enviar', { metodo: 'POST', corpo: { mes } });
    mostrarRecado('recado', r.aviso, soDanfe ? 'atencao' : 'ok');
    await carregar();
  } catch (e) {
    const bloqueios = e.dados?.bloqueios;
    if (bloqueios?.length) {
      trocarAba('conferencia');
      $('achados').innerHTML = bloqueios
        .map(
          (a) => `<div class="achado erro"><span class="icone">✕</span><span>${escapar(
            a.mensagem,
          )}</span></div>`,
        )
        .join('');
    }
    mostrarRecado('recado', e.message, 'erro');
  } finally {
    $('botao-enviar').disabled = false;
  }
}

function atualizarRodape() {
  if (!estado) return;
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
    $('historico').innerHTML = `
      <table>
        <thead><tr>
          <th>Mês</th><th>Status</th><th class="num">Km</th>
          <th class="num">Valor</th><th>O que fazer</th>
        </tr></thead>
        <tbody>
          ${lista
            .map(
              (r) => `<tr>
            <td>${escapar(r.mes_extenso)}</td>
            <td><span class="selo ${r.status}">${escapar(r.rotulo_status)}</span></td>
            <td class="num">${numeroBr(r.total_km)}</td>
            <td class="num">${brl(r.valor_km)}</td>
            <td>${escapar(r.o_que_fazer || '—')}</td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
  } catch { /* silencioso - o historico e secundario */ }
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
