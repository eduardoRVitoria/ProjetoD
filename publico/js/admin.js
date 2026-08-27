// Tela do administrador: painel do mes, conferencia com IA, colaboradores e ajustes.

import {
  api, mostrarRecado, escapar, brl, numeroBr, dataBr, dataHoraBr,
  tamanhoBr, mesAtual, sair, ROTULO_ANEXO,
} from '/js/comum.js';

const $ = (id) => document.getElementById(id);

let mes = mesAtual();
let painel = null;

// ------------------------------------------------------------------- inicio

try {
  const dados = await api('/api/eu');
  $('meu-nome').textContent = dados.usuario.nome;
} catch {
  location.href = '/';
}

$('mes').value = mes;
$('botao-sair').addEventListener('click', sair);
$('mes').addEventListener('change', () => {
  mes = $('mes').value;
  carregarPainel();
});
$('botao-conferir-todos').addEventListener('click', () => conferirPendentes(false));
$('botao-demo').addEventListener('click', () => conferirPendentes(true));
$('botao-exportar').addEventListener('click', () => {
  location.href = `/api/admin/exportar?mes=${mes}`;
});
$('botao-criar-usuario').addEventListener('click', criarUsuario);

// --- filtros do painel do mes ---
for (const id of ['f-busca', 'f-status', 'f-empresa', 'f-funcao', 'f-agrupar']) {
  $(id).addEventListener('input', () => desenharTabela());
}
$('f-limpar').addEventListener('click', () => {
  $('f-busca').value = '';
  for (const id of ['f-status', 'f-empresa', 'f-funcao']) $(id).value = '';
  $('f-agrupar').checked = true;
  desenharTabela();
});

// --- filtros da lista de colaboradores ---
for (const id of ['fu-busca', 'fu-empresa', 'fu-funcao', 'fu-situacao', 'fu-agrupar']) {
  $(id).addEventListener('input', () => desenharUsuarios());
}
$('fu-limpar').addEventListener('click', () => {
  $('fu-busca').value = '';
  for (const id of ['fu-empresa', 'fu-funcao', 'fu-situacao']) $(id).value = '';
  $('fu-agrupar').checked = true;
  desenharUsuarios();
});
$('botao-salvar-km').addEventListener('click', salvarKm);
$('botao-salvar-chave').addEventListener('click', salvarChave);
$('botao-limpar-chave').addEventListener('click', limparChave);

for (const b of document.querySelectorAll('.abas button')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('.abas button')) {
      o.classList.toggle('ativa', o === b);
    }
    for (const s of document.querySelectorAll('main > section')) {
      s.classList.toggle('esconde', s.id !== `aba-${b.dataset.aba}`);
    }
    if (b.dataset.aba === 'usuarios') carregarUsuarios();
    if (b.dataset.aba === 'config') carregarConfig();
    window.scrollTo({ top: 0 });
  });
}

await carregarPainel();

// ------------------------------------------------------------------- painel

async function carregarPainel() {
  $('tabela').innerHTML = `<p class="carregando">Carregando...</p>`;
  try {
    painel = await api(`/api/admin/painel?mes=${mes}`);
  } catch (e) {
    return mostrarRecado('recado', e.message, 'erro');
  }

  $('status-ia').innerHTML = painel.ia_disponivel
    ? ''
    : `<div class="aviso atencao">Sem chave de API configurada. A conferência roda só com as
       regras automáticas (datas, km, somas, × valor do km). Os comprovantes não são lidos.
       Configure em <strong>Configurações</strong>.</div>`;

  const c = painel.contagem;
  const total = Object.values(c).reduce((s, n) => s + n, 0);
  $('contagem').innerHTML = `
    <div class="numero destaque">
      <div class="rotulo">Recebidos</div><div class="valor">${total}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Aguardando</div><div class="valor">${(c.ENVIADO || 0) + (c.CONFERINDO || 0)}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Aprovados</div><div class="valor" style="color:var(--verde)">${c.CERTA || 0}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Só falta DANFE</div><div class="valor" style="color:var(--amarelo)">${c.SO_FALTA_DANFE || 0}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Reprovados</div><div class="valor" style="color:var(--vermelho)">${c.ERRADA || 0}</div>
    </div>
    <div class="numero">
      <div class="rotulo">Não enviaram</div><div class="valor">${painel.nao_enviaram.length}</div>
    </div>`;

  desenharTabela();

  $('nao-enviaram').innerHTML = painel.nao_enviaram.length
    ? painel.nao_enviaram
        .map((u) => `<div class="anexo"><span class="nome">${escapar(u.nome)}</span>
             <span class="peso">${escapar(u.login)}</span></div>`)
        .join('')
    : `<p class="sub" style="margin:0">Todo mundo já enviou.</p>`;
}

// Normaliza para busca: sem acento, minusculo.
const chave = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

function desenharTabela() {
  const todos = painel.relatorios;
  if (!todos.length) {
    $('tabela').innerHTML = `<p class="sub">Nenhum relatório enviado para ${escapar(
      painel.mes_extenso,
    )}.</p>`;
    $('f-contagem').textContent = '';
    return;
  }

  const busca = chave($('f-busca').value.trim());
  const status = $('f-status').value;
  const empresa = $('f-empresa').value;
  const funcao = $('f-funcao').value;
  const agrupar = $('f-agrupar').checked;

  const lista = todos.filter((r) => {
    if (status && r.status !== status) return false;
    if (empresa && r.empresa !== empresa) return false;
    if (funcao && r.funcao !== funcao) return false;
    if (busca && !chave(`${r.nome} ${r.login}`).includes(busca)) return false;
    return true;
  });

  $('f-contagem').textContent =
    lista.length === todos.length
      ? `${todos.length} relatório(s)`
      : `${lista.length} de ${todos.length}`;

  if (!lista.length) {
    $('tabela').innerHTML = `<p class="sub">Nenhum relatório com esses filtros.</p>`;
    return;
  }

  let corpo;
  if (agrupar) {
    const empresas = [...new Set(lista.map((r) => r.empresa || 'DISO'))].sort();
    corpo = empresas
      .map((e) => {
        const doGrupo = lista.filter((r) => (r.empresa || 'DISO') === e);
        const km = doGrupo.reduce((s, r) => s + Number(r.total_km || 0), 0);
        const valor = doGrupo.reduce((s, r) => s + Number(r.valor_km || 0), 0);
        return (
          `<tr class="grupo-empresa"><td colspan="8">
             ${escapar(e)} — ${doGrupo.length} relatório(s) · ${numeroBr(km)} km · ${brl(valor)}
           </td></tr>` + doGrupo.map(linhaTabela).join('')
        );
      })
      .join('');
  } else {
    corpo = lista.map(linhaTabela).join('');
  }

  $('tabela').innerHTML = `
    <table>
      <thead><tr>
        <th>Status</th><th>Colaborador</th><th class="num">Km</th><th class="num">Valor km</th>
        <th class="num">Declarado</th><th class="num">Comprovado</th><th class="num">Diferença</th>
        <th></th>
      </tr></thead>
      <tbody>${corpo}</tbody>
    </table>`;

  for (const b of $('tabela').querySelectorAll('[data-ver]')) {
    b.addEventListener('click', () => abrirDetalhe(Number(b.dataset.ver)));
  }
  for (const b of $('tabela').querySelectorAll('[data-conferir]')) {
    b.addEventListener('click', () => conferirUm(Number(b.dataset.conferir), b));
  }
}

function linhaTabela(r) {
  const dif =
    r.diferenca == null
      ? '—'
      : `<span style="color:${
          Math.abs(r.diferenca) < 0.01 ? 'var(--verde)' : 'var(--vermelho)'
        }">${brl(r.diferenca)}</span>`;

  const pendente = r.status === 'ENVIADO' || r.status === 'CONFERINDO';

  return `<tr class="de-${escapar(r.empresa || 'DISO')}">
    <td><span class="selo ${r.status}">${escapar(r.rotulo_status)}</span></td>
    <td>
      ${escapar(r.nome)}<br>
      <span class="emp ${escapar(r.empresa || 'DISO')}">${escapar(r.cracha || r.empresa || '')}</span>
    </td>
    <td class="num">${numeroBr(r.total_km)}</td>
    <td class="num">${brl(r.valor_km)}</td>
    <td class="num">${brl(r.declarado)}</td>
    <td class="num">${r.comprovado == null ? '—' : brl(r.comprovado)}</td>
    <td class="num">${dif}</td>
    <td style="white-space:nowrap">
      <button class="secundario pequeno" data-ver="${r.id}">Abrir</button>
      ${pendente ? `<button class="pequeno" data-conferir="${r.id}">Conferir</button>` : ''}
    </td>
  </tr>`;
}

// -------------------------------------------------------------- conferencia

async function conferirUm(id, botao, demo = false) {
  if (botao) {
    botao.disabled = true;
    botao.textContent = 'Conferindo...';
  }
  try {
    const r = await api('/api/admin/conferir', {
      metodo: 'POST',
      corpo: { relatorio_id: id, demo },
    });
    mostrarRecado('recado', `Conferido: ${r.rotulo_status}.${r.aviso ? ' ' + r.aviso : ''}`,
      demo ? 'atencao' : r.status === 'CERTA' ? 'ok' : r.status === 'SO_FALTA_DANFE' ? 'atencao' : 'erro');
    await carregarPainel();
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
    if (botao) {
      botao.disabled = false;
      botao.textContent = 'Conferir';
    }
  }
}

async function conferirPendentes(demo = false) {
  const pendentes = (painel?.relatorios || []).filter(
    (r) => r.status === 'ENVIADO' || r.status === 'CONFERINDO',
  );
  if (!pendentes.length) {
    return mostrarRecado('recado', 'Não há relatório pendente de conferência neste mês.', 'info');
  }

  const pergunta = demo
    ? `MODO DEMONSTRAÇÃO — ${pendentes.length} relatório(s).\n\n` +
      'Nenhum comprovante será lido e nenhum crédito será gasto. ' +
      'O parecer é simulado e serve só para testar a tela.\n\nContinuar?'
    : `Conferir ${pendentes.length} relatório(s) com IA agora?` +
      (painel.ia_disponivel
        ? ' Isso consome créditos da API.'
        : ' (Sem chave: só as regras automáticas.)');

  if (!confirm(pergunta)) return;

  const botao = demo ? $('botao-demo') : $('botao-conferir-todos');
  const rotuloOriginal = botao.textContent;
  botao.disabled = true;
  let feitos = 0;
  const falhas = [];

  for (const r of pendentes) {
    botao.textContent = `Conferindo ${feitos + 1} de ${pendentes.length}...`;
    try {
      await api('/api/admin/conferir', {
        metodo: 'POST',
        corpo: { relatorio_id: r.id, demo },
      });
      feitos++;
    } catch (e) {
      falhas.push(`${r.nome}: ${e.message}`);
    }
  }

  botao.disabled = false;
  botao.textContent = rotuloOriginal;
  mostrarRecado(
    'recado',
    `${feitos} de ${pendentes.length} conferido(s).` +
      (falhas.length ? ` Falhas: ${falhas.join(' | ')}` : ''),
    falhas.length ? 'atencao' : 'ok',
  );
  await carregarPainel();
}

// ----------------------------------------------------------------- detalhe

async function abrirDetalhe(id) {
  let d;
  try {
    d = await api(`/api/admin/relatorio?id=${id}`);
  } catch (e) {
    return mostrarRecado('recado', e.message, 'erro');
  }

  const r = d.relatorio;
  const fundo = document.createElement('div');
  fundo.className = 'fundo-modal';
  fundo.innerHTML = `
    <div class="modal">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px">
        <h2 style="margin:0; flex:1">${escapar(r.nome)}</h2>
        <button class="secundario pequeno" id="fechar">Fechar</button>
      </div>
      <p class="sub">
        ${escapar(r.mes_extenso)} ·
        <span class="selo ${r.status}">${escapar(r.rotulo_status)}</span>
        ${r.placas ? ` · placas: ${escapar(r.placas)}` : ' · sem placa declarada'}
      </p>

      <div class="numeros" style="margin-bottom:16px">
        <div class="numero"><div class="rotulo">Total de km</div>
          <div class="valor">${numeroBr(r.total_km)}</div></div>
        <div class="numero destaque"><div class="rotulo">Valor do km</div>
          <div class="valor">${brl(r.valor_km)}</div></div>
        <div class="numero"><div class="rotulo">Ped.+estac. declarado</div>
          <div class="valor">${brl(r.pedagio_declarado + r.estac_declarado)}</div></div>
        <div class="numero"><div class="rotulo">Comprovado</div>
          <div class="valor">${r.pedagio_comprovado == null ? '—' : brl(r.pedagio_comprovado)}</div></div>
      </div>

      ${r.observacao ? `<div class="aviso info"><strong>Observação do colaborador:</strong><br>${escapar(r.observacao)}</div>` : ''}

      ${blocoAssinatura(r)}
      ${blocoAchados(r)}
      ${blocoParecer(r)}

      <h2 style="margin-top:20px">Comprovantes (${d.anexos.length})</h2>
      ${
        d.anexos.length
          ? d.anexos
              .map(
                (a) => `<div class="anexo">
                  <span class="peso">${escapar(ROTULO_ANEXO[a.tipo] || a.tipo)}</span>
                  <span class="nome"><a href="/api/anexo/${a.id}" target="_blank" rel="noopener">${escapar(
                    a.nome_original,
                  )}</a></span>
                  <span class="peso">${tamanhoBr(a.tamanho)}</span>
                </div>`,
              )
              .join('')
          : '<p class="sub">Nenhum comprovante anexado.</p>'
      }

      <h2 style="margin-top:20px">Lançamentos (${d.linhas.length} dias)</h2>
      <div class="rolagem">
        <table>
          <thead><tr>
            <th>Data</th><th class="num">Km ini</th><th class="num">Km fim</th>
            <th class="num">Rodou</th><th>Itinerário</th><th class="num">Pedágio</th><th class="num">Estac.</th>
          </tr></thead>
          <tbody>
            ${d.linhas
              .map(
                (l) => `<tr>
              <td>${dataBr(l.data)}</td>
              <td class="num">${numeroBr(l.km_inicial)}</td>
              <td class="num">${numeroBr(l.km_final)}</td>
              <td class="num">${numeroBr(l.km_final - l.km_inicial)}</td>
              <td>${escapar(l.itinerario || '—')}</td>
              <td class="num">${l.pedagio ? brl(l.pedagio) : '—'}</td>
              <td class="num">${l.estacionamento ? brl(l.estacionamento) : '—'}</td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <h2 style="margin-top:20px">Decidir</h2>
      <div id="recado-decisao"></div>
      <label for="d-fazer">O que o colaborador precisa fazer</label>
      <textarea id="d-fazer">${escapar(r.o_que_fazer || '')}</textarea>
      <div class="linha-botoes">
        <button data-status="CERTA" style="background:var(--verde)">Aprovar</button>
        <button data-status="SO_FALTA_DANFE" style="background:var(--amarelo)">Só falta DANFE</button>
        <button data-status="ERRADA" class="perigo">Reprovar</button>
        ${
          r.status === 'ENVIADO' || r.status === 'CONFERINDO'
            ? `<button class="secundario" id="conferir-daqui">Conferir com IA</button>`
            : ''
        }
      </div>
    </div>`;

  document.body.appendChild(fundo);

  const fechar = () => fundo.remove();
  fundo.querySelector('#fechar').addEventListener('click', fechar);
  fundo.addEventListener('click', (ev) => {
    if (ev.target === fundo) fechar();
  });

  fundo.querySelector('#conferir-daqui')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Conferindo...';
    fechar();
    await conferirUm(id, null);
  });

  for (const b of fundo.querySelectorAll('[data-status]')) {
    b.addEventListener('click', async () => {
      try {
        await api('/api/admin/decidir', {
          metodo: 'POST',
          corpo: {
            relatorio_id: id,
            status: b.dataset.status,
            o_que_fazer: fundo.querySelector('#d-fazer').value,
          },
        });
        fechar();
        mostrarRecado('recado', 'Decisão registrada.', 'ok');
        await carregarPainel();
      } catch (e) {
        mostrarRecado('recado-decisao', e.message, 'erro');
      }
    });
  }
}

function blocoAssinatura(r) {
  if (!r.assinatura?.length) return '';

  const cartoes = r.assinatura
    .map((arq) => {
      if (!arq.assinado) {
        return `<div class="aviso atencao">
          <strong>${escapar(arq.arquivo)}</strong><br>Sem assinatura digital.</div>`;
      }
      return arq.assinaturas
        .map((a) => {
          if (a.erro) {
            return `<div class="aviso atencao"><strong>${escapar(arq.arquivo)}</strong><br>${escapar(a.erro)}</div>`;
          }
          const alterado = a.integridade === 'alterado';
          const incerto = a.integridade === 'nao_verificavel';
          const cor = alterado ? 'erro' : incerto ? 'atencao' : 'ok';
          const selo = alterado
            ? 'ALTERADO DEPOIS DE ASSINADO'
            : incerto
              ? 'INTEGRIDADE NÃO CONFIRMADA'
              : 'DOCUMENTO ÍNTEGRO';
          return `
            <div class="aviso ${cor}">
              <strong>${selo}</strong><br>
              Assinado por <strong>${escapar(a.signatario || 'não identificado')}</strong>
              ${a.cpf ? ` (CPF ${escapar(a.cpf)})` : ''}
              ${a.assinado_em ? ` em ${dataHoraBr(a.assinado_em)}` : ''}<br>
              Emissor: ${escapar(a.emissor || 'desconhecido')}
              ${a.gov ? ' — certificado ICP-Brasil / gov.br' : ' — <strong>fora da ICP-Brasil</strong>'}
            </div>`;
        })
        .join('');
    })
    .join('');

  return `<h2 style="margin-top:4px">Assinatura digital</h2>${cartoes}`;
}

function blocoAchados(r) {
  if (!r.achados?.length) return '';
  return `<h2 style="margin-top:4px">O que foi encontrado</h2>
    ${r.achados
      .map(
        (a) => `<div class="achado ${a.gravidade}">
          <span class="icone">${a.gravidade === 'erro' ? '✕' : '!'}</span>
          <span>${escapar(a.mensagem)}</span></div>`,
      )
      .join('')}`;
}

function blocoParecer(p) {
  const ia = p.parecer_ia;
  if (!ia) return '';
  const ignorados = ia.itens_ignorados || [];
  return `
    <h2 style="margin-top:20px">Leitura dos comprovantes pela IA</h2>
    ${
      ia.simulado
        ? `<div class="aviso erro"><strong>PARECER SIMULADO — modo demonstração.</strong><br>
           Nenhum comprovante foi aberto ou lido. Estes números são inventados e servem só
           para testar a tela. Não use para aprovar ou reprovar de verdade.</div>`
        : ''
    }
    <div class="aviso info">${escapar(ia.resumo || '')}</div>
    <div class="numeros" style="margin-bottom:12px">
      <div class="numero"><div class="rotulo">Pedágio comprovado</div>
        <div class="valor">${brl(ia.pedagio_comprovado)}</div></div>
      <div class="numero"><div class="rotulo">Nota de abastecimento</div>
        <div class="valor" style="font-size:16px; color:${
          ia.tem_danfe_de_abastecimento ? 'var(--verde)' : 'var(--vermelho)'
        }">${ia.tem_danfe_de_abastecimento ? 'Enviada' : 'Não enviada'}</div></div>
      <div class="numero"><div class="rotulo">Odômetro</div>
        <div class="valor" style="font-size:16px">${escapar(
          { sim: 'Confere', nao: 'Não confere', parcial: 'Confere em parte', sem_foto: 'Sem foto' }[
            ia.odometro?.confere_com_o_rdv
          ] || '—',
        )}</div></div>
    </div>
    ${
      ia.odometro?.observacao
        ? `<p class="sub">Odômetro: ${escapar(ia.odometro.observacao)}</p>`
        : ''
    }
    ${
      ignorados.length
        ? `<p class="sub"><strong>Itens do extrato que não entraram na soma:</strong> ${ignorados
            .map((i) => `${escapar(i.descricao)} (${brl(i.valor)})`)
            .join(', ')}</p>`
        : ''
    }`;
}

// ---------------------------------------------------------------- usuarios

let usuarios = [];

async function carregarUsuarios() {
  try {
    usuarios = await api('/api/admin/usuarios');
    desenharUsuarios();
  } catch (e) {
    mostrarRecado('recado-usuario', e.message, 'erro');
  }
}

const FUNCOES = ['Vendedor', 'Promotor', 'Supervisor', 'Adm Promotor', 'Adm DISO', 'Adm DSO'];

function desenharUsuarios() {
  if (!usuarios.length) return;

  const busca = chave($('fu-busca').value.trim());
  const empresa = $('fu-empresa').value;
  const funcao = $('fu-funcao').value;
  const situacao = $('fu-situacao').value;
  const agrupar = $('fu-agrupar').checked;

  const lista = usuarios.filter((u) => {
    if (empresa && u.empresa !== empresa) return false;
    if (funcao && u.funcao !== funcao) return false;
    if (situacao !== '' && String(u.ativo) !== situacao) return false;
    if (busca && !chave(`${u.nome} ${u.login} ${u.placas || ''}`).includes(busca)) return false;
    return true;
  });

  $('fu-contagem').textContent =
    lista.length === usuarios.length
      ? `${usuarios.length} cadastrado(s)`
      : `${lista.length} de ${usuarios.length}`;

  if (!lista.length) {
    $('lista-usuarios').innerHTML = `<p class="sub">Ninguém com esses filtros.</p>`;
    return;
  }

  let corpo;
  if (agrupar) {
    const empresas = [...new Set(lista.map((u) => u.empresa || 'DISO'))].sort();
    corpo = empresas
      .map((e) => {
        const doGrupo = lista.filter((u) => (u.empresa || 'DISO') === e);
        const ativos = doGrupo.filter((u) => u.ativo).length;
        return (
          `<tr class="grupo-empresa"><td colspan="8">
             ${escapar(e)} — ${doGrupo.length} pessoa(s), ${ativos} ativa(s)
           </td></tr>` + doGrupo.map(linhaUsuario).join('')
        );
      })
      .join('');
  } else {
    corpo = lista.map(linhaUsuario).join('');
  }

  $('lista-usuarios').innerHTML = `
    <table>
      <thead><tr>
        <th>Nome</th><th>Empresa</th><th>Função</th><th>Login</th><th>Placas</th>
        <th class="num">Arquivos</th><th>Situação</th><th></th>
      </tr></thead>
      <tbody>${corpo}</tbody>
    </table>`;

  ligarBotoesDeUsuario();
}

function linhaUsuario(u) {
  const ehAdmin = u.papel === 'admin';
  return `<tr class="de-${escapar(u.empresa || 'DISO')}"${u.ativo ? '' : ' style="opacity:.55"'}>
    <td>
      ${escapar(u.nome)}${ehAdmin ? ' <span class="selo RASCUNHO">admin</span>' : ''}<br>
      <span class="emp ${escapar(u.empresa || 'DISO')}">${escapar(u.cracha || '')}</span>
    </td>
    <td>
      <select data-empresa="${u.id}" style="margin:0; padding:5px 8px; font-size:13px; width:auto">
        <option value="DISO"${u.empresa === 'DISO' ? ' selected' : ''}>DISO</option>
        <option value="DSO"${u.empresa === 'DSO' ? ' selected' : ''}>DSO</option>
      </select>
    </td>
    <td>
      <select data-funcao="${u.id}" style="margin:0; padding:5px 8px; font-size:13px; width:auto">
        ${FUNCOES.map(
          (f) => `<option value="${f}"${u.funcao === f ? ' selected' : ''}>${f}</option>`,
        ).join('')}
      </select>
    </td>
    <td>${escapar(u.login)}</td>
    <td>${escapar(u.placas || '—')}</td>
    <td class="num">${u.anexos}</td>
    <td>${u.ativo ? 'Ativo' : 'Desativado'}</td>
    <td style="white-space:nowrap">
      ${
        u.papel === 'colaborador'
          ? `<button class="pequeno" data-galeria="${u.id}">Galeria</button>
             <button class="secundario pequeno" data-historico="${u.id}"
                     title="Planilha com todos os meses deste colaborador">Histórico</button>
             <button class="secundario pequeno" data-pacote="${u.id}"
                     title="Baixa uma pasta com tudo deste colaborador">Baixar pasta</button>`
          : ''
      }
      <button class="secundario pequeno" data-senha="${u.id}">Nova senha</button>
      <button class="secundario pequeno" data-ativo="${u.id}" data-valor="${u.ativo ? 0 : 1}">
        ${u.ativo ? 'Desativar' : 'Reativar'}
      </button>
      <button class="perigo pequeno" data-excluir="${u.id}"
              title="Apaga o colaborador e tudo que ele enviou">Excluir</button>
    </td>
  </tr>`;
}

function ligarBotoesDeUsuario() {
  const raiz = $('lista-usuarios');

  const salvarCracha = async (elemento, campo) => {
    try {
      const r = await api('/api/admin/usuario-empresa', {
        metodo: 'POST',
        corpo: { usuario_id: Number(elemento.dataset[campo]), [campo]: elemento.value },
      });
      mostrarRecado('recado-usuario', `Atualizado para ${r.cracha}.`, 'ok');
      carregarUsuarios();
    } catch (e) {
      mostrarRecado('recado-usuario', e.message, 'erro');
    }
  };

  for (const s of raiz.querySelectorAll('[data-empresa]')) {
    s.addEventListener('change', () => salvarCracha(s, 'empresa'));
  }
  for (const s of raiz.querySelectorAll('[data-funcao]')) {
    s.addEventListener('change', () => salvarCracha(s, 'funcao'));
  }
  for (const b of raiz.querySelectorAll('[data-galeria]')) {
    b.addEventListener('click', () => abrirGaleria(Number(b.dataset.galeria)));
  }
  for (const b of raiz.querySelectorAll('[data-pacote]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/pacote?usuario_id=${b.dataset.pacote}`;
    });
  }
  for (const b of raiz.querySelectorAll('[data-historico]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/historico?usuario_id=${b.dataset.historico}`;
    });
  }

  for (const b of raiz.querySelectorAll('[data-senha]')) {
    b.addEventListener('click', async () => {
      const senha = prompt('Senha provisória para essa pessoa (mínimo 6 caracteres):');
      if (!senha) return;
      try {
        await api('/api/admin/usuario-senha', {
          metodo: 'POST',
          corpo: { usuario_id: Number(b.dataset.senha), senha },
        });
        mostrarRecado('recado-usuario', 'Senha trocada. Passe a nova senha para a pessoa.', 'ok');
      } catch (e) {
        mostrarRecado('recado-usuario', e.message, 'erro');
      }
    });
  }

  for (const b of raiz.querySelectorAll('[data-ativo]')) {
    b.addEventListener('click', async () => {
      await api('/api/admin/usuario-ativo', {
        metodo: 'POST',
        corpo: { usuario_id: Number(b.dataset.ativo), ativo: Number(b.dataset.valor) },
      });
      carregarUsuarios();
    });
  }

  for (const b of raiz.querySelectorAll('[data-excluir]')) {
    b.addEventListener('click', () => excluirUsuario(Number(b.dataset.excluir)));
  }
}

// Exclusao em dois passos: primeiro o servidor diz o que sera apagado, depois
// a pessoa digita o login para confirmar. Nao da para apagar por engano.
async function excluirUsuario(id) {
  const u = usuarios.find((x) => x.id === id);
  if (!u) return;

  let aviso;
  try {
    await api('/api/admin/usuario', { metodo: 'DELETE', corpo: { usuario_id: id } });
    return; // nao deveria passar sem confirmacao
  } catch (e) {
    if (!e.dados?.vai_apagar) {
      return mostrarRecado('recado-usuario', e.message, 'erro');
    }
    aviso = e.dados.vai_apagar;
  }

  const texto =
    `EXCLUIR ${u.nome}?\n\n` +
    `Isso apaga em definitivo:\n` +
    `  · ${aviso.relatorios} relatório(s)\n` +
    `  · ${aviso.anexos} arquivo(s) — RDVs, comprovantes e fotos de odômetro\n\n` +
    `Não tem como desfazer.\n\n` +
    `Para confirmar, digite o login: ${u.login}`;

  const confirmacao = prompt(texto);
  if (!confirmacao) return;

  try {
    const r = await api('/api/admin/usuario', {
      metodo: 'DELETE',
      corpo: { usuario_id: id, confirmacao },
    });
    mostrarRecado(
      'recado-usuario',
      `${r.nome} foi excluído: ${r.relatorios} relatório(s) e ${r.arquivos_apagados} arquivo(s) apagados.`,
      'ok',
    );
    carregarUsuarios();
    carregarPainel();
  } catch (e) {
    mostrarRecado('recado-usuario', e.message, 'erro');
  }
}

// ---------------------------------------------------------------- galeria

async function abrirGaleria(usuarioId) {
  let g;
  try {
    g = await api(`/api/admin/galeria?usuario_id=${usuarioId}`);
  } catch (e) {
    return mostrarRecado('recado-usuario', e.message, 'erro');
  }

  const fundo = document.createElement('div');
  fundo.className = 'fundo-modal';
  fundo.innerHTML = `
    <div class="modal">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px">
        <h2 style="margin:0; flex:1">${escapar(g.usuario.nome)}</h2>
        <button class="secundario pequeno" id="fechar-galeria">Fechar</button>
      </div>
      <p class="sub">
        ${escapar(g.usuario.cracha || g.usuario.empresa)} · ${escapar(g.usuario.funcao || '')}
        · ${escapar(g.usuario.login)}
        ${g.usuario.placas ? ` · placas: ${escapar(g.usuario.placas)}` : ''}
      </p>

      <div class="numeros" style="margin-bottom:16px">
        <div class="numero"><div class="rotulo">Meses</div><div class="valor">${g.resumo.meses}</div></div>
        <div class="numero destaque"><div class="rotulo">Arquivos</div><div class="valor">${g.resumo.anexos}</div></div>
        <div class="numero"><div class="rotulo">RDVs</div><div class="valor">${g.resumo.rdvs}</div></div>
        <div class="numero"><div class="rotulo">Odômetros</div><div class="valor">${g.resumo.odometros}</div></div>
        <div class="numero"><div class="rotulo">Comprovantes</div><div class="valor">${g.resumo.comprovantes}</div></div>
      </div>

      <div class="linha-botoes" style="margin-bottom:18px">
        <button id="baixar-tudo">Baixar pasta com tudo</button>
      </div>

      ${
        g.meses.length
          ? g.meses.map(blocoDoMes).join('')
          : '<p class="sub">Este colaborador ainda não enviou nada.</p>'
      }
    </div>`;

  document.body.appendChild(fundo);

  const fechar = () => fundo.remove();
  fundo.querySelector('#fechar-galeria').addEventListener('click', fechar);
  fundo.addEventListener('click', (ev) => {
    if (ev.target === fundo) fechar();
  });
  fundo.querySelector('#baixar-tudo').addEventListener('click', () => {
    location.href = `/api/admin/pacote?usuario_id=${usuarioId}`;
  });
  for (const b of fundo.querySelectorAll('[data-baixar-mes]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/pacote?usuario_id=${usuarioId}&mes=${b.dataset.baixarMes}`;
    });
  }
}

function blocoDoMes(m) {
  return `
    <div class="cartao" style="background:var(--superficie-2)">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px">
        <h2 style="margin:0; flex:1; text-transform:none; font-size:16px; color:var(--texto)">
          ${escapar(m.mes_extenso)}
        </h2>
        <span class="selo ${m.status}">${escapar(m.status)}</span>
        <button class="secundario pequeno" data-baixar-mes="${m.mes}">Baixar este mês</button>
      </div>

      ${grupo('Relatório (RDV)', m.rdv)}
      ${
        m.odometro_por_dia.length
          ? `<h2 style="font-size:12px; margin:14px 0 8px">Odômetro — ${m.odometro.length} foto(s)</h2>
             ${m.odometro_por_dia.map(blocoDoDia).join('')}`
          : ''
      }
      ${grupo('Pedágio e estacionamento', m.pedagio)}
      ${grupo('Nota de abastecimento', m.danfe)}
      ${grupo('Outros documentos', m.outro)}
    </div>`;
}

function blocoDoDia({ dia, fotos }) {
  return `
    <div style="margin-bottom:12px">
      <div style="font-size:12px; font-weight:700; color:var(--texto-fraco); margin-bottom:6px">
        ${dataBr(dia)} — ${fotos.length} foto(s)
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        ${fotos.map(miniatura).join('')}
      </div>
    </div>`;
}

function miniatura(f) {
  return `
    <a href="/api/anexo/${f.id}" target="_blank" rel="noopener"
       title="${escapar(f.nome)} — ${tamanhoBr(f.tamanho)}"
       style="display:block; width:92px; height:92px; border-radius:8px; overflow:hidden;
              border:1px solid var(--borda); background:var(--superficie)">
      <img src="/api/anexo/${f.id}" alt="${escapar(f.nome)}" loading="lazy"
           style="width:100%; height:100%; object-fit:cover">
    </a>`;
}

function grupo(titulo, itens) {
  if (!itens?.length) return '';
  return `
    <h2 style="font-size:12px; margin:14px 0 8px">${titulo} — ${itens.length}</h2>
    ${itens
      .map(
        (f) => `<div class="anexo" style="background:var(--superficie)">
          <span class="nome"><a href="/api/anexo/${f.id}" target="_blank" rel="noopener">${escapar(
            f.nome,
          )}</a></span>
          <span class="peso">${tamanhoBr(f.tamanho)}</span>
        </div>`,
      )
      .join('')}`;
}

async function criarUsuario() {
  const corpo = {
    nome: $('u-nome').value.trim(),
    login: $('u-login').value.trim(),
    senha: $('u-senha').value,
    email: $('u-email').value.trim() || null,
    placas: $('u-placas').value.trim() || null,
    papel: $('u-papel').value,
    empresa: $('u-empresa').value,
    funcao: $('u-funcao').value,
  };
  try {
    await api('/api/admin/usuarios', { metodo: 'POST', corpo });
    mostrarRecado(
      'recado-usuario',
      `${corpo.nome} cadastrado. Passe o login "${corpo.login}" e a senha provisória para a pessoa.`,
      'ok',
    );
    for (const id of ['u-nome', 'u-login', 'u-senha', 'u-email', 'u-placas']) $(id).value = '';
    carregarUsuarios();
  } catch (e) {
    mostrarRecado('recado-usuario', e.message, 'erro');
  }
}

// ------------------------------------------------------------------ config

async function carregarConfig() {
  try {
    const c = await api('/api/admin/config');
    $('c-km').value = c.valor_km;
    $('estado-chave').innerHTML = c.chave_por_ambiente
      ? `<div class="aviso ok">Usando a chave da variável de ambiente ANTHROPIC_API_KEY.</div>`
      : c.chave_api_resumo
        ? `<div class="aviso ok">Chave configurada: <code>${escapar(c.chave_api_resumo)}</code></div>`
        : `<div class="aviso atencao">Nenhuma chave configurada — a IA está desligada.</div>`;
  } catch (e) {
    mostrarRecado('recado-config', e.message, 'erro');
  }
}

async function salvarKm() {
  try {
    await api('/api/admin/config', { metodo: 'POST', corpo: { valor_km: $('c-km').value } });
    mostrarRecado('recado-config', 'Valor do km salvo.', 'ok');
    carregarPainel();
  } catch (e) {
    mostrarRecado('recado-config', e.message, 'erro');
  }
}

async function salvarChave() {
  const chave = $('c-chave').value.trim();
  if (!chave) return mostrarRecado('recado-config', 'Cole a chave antes de salvar.', 'erro');
  try {
    await api('/api/admin/config', { metodo: 'POST', corpo: { chave_api: chave } });
    $('c-chave').value = '';
    mostrarRecado('recado-config', 'Chave salva. A conferência com IA está ligada.', 'ok');
    carregarConfig();
    carregarPainel();
  } catch (e) {
    mostrarRecado('recado-config', e.message, 'erro');
  }
}

async function limparChave() {
  if (!confirm('Remover a chave? A conferência com IA deixa de funcionar.')) return;
  await api('/api/admin/config', { metodo: 'POST', corpo: { limpar_chave: true } });
  mostrarRecado('recado-config', 'Chave removida.', 'info');
  carregarConfig();
  carregarPainel();
}
