// Tela do administrador: painel do mes, conferencia com IA, colaboradores e ajustes.

import {
  api, mostrarRecado, escapar, brl, numeroBr, dataBr, dataHoraBr,
  tamanhoBr, mesAtual, sair, ROTULO_ANEXO, marcarAmbiente, anexoDoAchado, placaParaTela,
} from '/js/comum.js';

const $ = (id) => document.getElementById(id);

// Le um campo de filtro sem quebrar se ele nao existir na pagina.
// Um HTML antigo em cache com o JS novo derrubava a tela inteira: sem os
// filtros, o `$(id).value` estourava e a lista nunca era desenhada.
const filtro = (id, padrao = '') => {
  const el = $(id);
  if (!el) return padrao;
  return el.type === 'checkbox' ? el.checked : el.value;
};
const ligar = (id, evento, fn) => $(id)?.addEventListener(evento, fn);

// Clique que dispara funcao `async` PRECISA de .catch.
//
// Sem ele, qualquer erro depois do primeiro `await` vira uma promise rejeitada
// que ninguem pega: o navegador engole, a tela nao abre, nao aparece recado
// nenhum e a pessoa fica olhando o mesmo painel achando que o botao nao
// funciona. Era o caso do "Abrir": o try/catch de abrirDetalhe cobria so a
// chamada da API - montar o modal, os anexos e os lancamentos ficava de fora.
const aoClicar = (elemento, fn, oQue) =>
  elemento.addEventListener('click', () =>
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        console.error(`falha ao ${oQue}`, e);
        mostrarRecado('recado', `Não foi possível ${oQue}: ${e?.message || e}`, 'erro');
      }),
  );

// Normaliza para busca: sem acento, minusculo.
const chave = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

// As tres frentes. Um vendedor e um Adm DISO nao tem nada a ver um com o outro,
// entao nao faz sentido aparecerem na mesma lista.
// Vendedor e promotor ficam em secoes separadas porque agora moram em janelas
// diferentes: promotor so existe na PROMOTORES. Cada secao vazia some sozinha,
// entao a DISO mostra "Vendedores" e a PROMOTORES mostra "Promotores".
const SECOES = [
  { titulo: 'Vendedores', funcoes: ['Vendedor'] },
  { titulo: 'Promotores', funcoes: ['Promotor'] },
  { titulo: 'Supervisores', funcoes: ['Supervisor'] },
  { titulo: 'Administrativo', funcoes: ['Adm Promotor', 'Adm DISO', 'Adm DSO'] },
];

const FUNCOES = ['Vendedor', 'Promotor', 'Supervisor', 'Adm Promotor', 'Adm DISO', 'Adm DSO'];
const EMPRESAS = ['DISO', 'DSO', 'PROMOTORES'];

// ATENCAO: tudo que for `const`/`let` e usado durante a inicializacao precisa
// ficar ACIMA dos `await` de topo de modulo. O `await` pausa a avaliacao do
// modulo, entao uma constante declarada depois ainda nao existe quando o
// carregarPainel() roda - e o erro que sai e "Cannot access X before
// initialization", que derruba o modulo inteiro e todas as abas junto.
// O mes escolhido fica guardado no navegador. Antes, recarregar a pagina
// voltava para o mes corrente - quem estava conferindo agosto perdia o lugar a
// cada F5 e achava que os relatorios tinham sumido.
let mes = localStorage.getItem('rdv-mes') || mesAtual();
let painel = null;
let usuarios = [];

// ------------------------------------------------------------------- inicio

let souSuper = false;

try {
  const dados = await api('/api/eu');
  $('meu-nome').textContent = dados.usuario.nome;
  souSuper = dados.usuario.papel === 'super';
  marcarAmbiente(dados.ambiente);
  // Backup e restauracao sao do dono do sistema. As rotas ja recusam quem nao
  // e super; esconder o cartao evita oferecer um botao que so devolve 403.
  if (!souSuper) $('cartao-backup')?.remove();
} catch {
  location.href = '/';
}

$('mes').value = mes;
$('botao-sair').addEventListener('click', sair);
$('mes').addEventListener('change', () => {
  mes = $('mes').value;
  try { localStorage.setItem('rdv-mes', mes); } catch {}
  carregarPainel();
});
$('botao-conferir-todos').addEventListener('click', () => conferirPendentes(false));
$('botao-demo').addEventListener('click', () => conferirPendentes(true));
aoClicar(
  $('botao-reconferir-antigos'),
  reconferirAntigos,
  'reconferir os relatórios com regras antigas',
);
$('botao-exportar').addEventListener('click', () => {
  location.href = `/api/admin/exportar?mes=${mes}`;
});
$('botao-imprimir-mes').addEventListener('click', () => {
  location.href = `/api/admin/impressao?mes=${mes}`;
});
$('botao-criar-usuario').addEventListener('click', criarUsuario);

// --- filtros do painel do mes ---
for (const id of ['f-busca', 'f-status', 'f-empresa', 'f-funcao', 'f-agrupar']) {
  ligar(id, 'input', () => desenharTabela());
}
ligar('f-limpar', 'click', () => {
  if ($('f-busca')) $('f-busca').value = '';
  for (const id of ['f-status', 'f-empresa', 'f-funcao']) if ($(id)) $(id).value = '';
  if ($('f-agrupar')) $('f-agrupar').checked = true;
  desenharTabela();
});

// --- filtros da lista de colaboradores ---
for (const id of ['fu-busca', 'fu-empresa', 'fu-funcao', 'fu-situacao', 'fu-agrupar']) {
  ligar(id, 'input', () => desenharUsuarios());
}
ligar('fu-limpar', 'click', () => {
  if ($('fu-busca')) $('fu-busca').value = '';
  for (const id of ['fu-empresa', 'fu-funcao', 'fu-situacao']) if ($(id)) $(id).value = '';
  if ($('fu-agrupar')) $('fu-agrupar').checked = true;
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

// Sem `await` aqui de proposito: se o carregamento do painel falhar, o erro
// nao pode impedir o modulo de terminar de inicializar - senao as outras abas
// morrem junto. Foi exatamente o que aconteceu quando o desenho da tabela
// estourou: a aba Colaboradores passou a dar "Cannot access 'usuarios' before
// initialization", porque o modulo nunca chegou ao fim.
/**
 * O painel se atualiza sozinho.
 *
 * A conferencia comeca no envio e leva uns 30 segundos, entao o que esta na
 * tela envelhece sozinho: um relatorio entra, outro sai de "Em conferencia", e
 * quem estava olhando nao via nada mudar sem apertar F5.
 *
 * Tres cuidados para a atualizacao nao atrapalhar quem esta trabalhando:
 *  - modal aberto nao e interrompido: ninguem quer o relatorio fechando na cara
 *    enquanto le o parecer;
 *  - campo em foco tambem segura, senao a busca ou o filtro perde o que a
 *    pessoa esta digitando;
 *  - aba escondida nao consulta nada - nao adianta gastar chamada para uma tela
 *    que ninguem esta vendo, e ao voltar ela atualiza na hora.
 */
const INTERVALO_ATUALIZACAO = 60000;

/**
 * Diz de quando e o que esta na tela - e avisa quando parou de atualizar.
 *
 * O painel congela de proposito enquanto uma janela de relatorio esta aberta,
 * e isso era invisivel: uma conferente ficou um dia inteiro decidindo em cima
 * da tela do dia anterior, achando que os vendedores nao tinham enviado nada,
 * porque a janela de um relatorio tinha ficado aberta. Dado velho sem aviso e
 * pior que tela vazia: ninguem desconfia dele.
 */
let atualizadoEm = null;

function marcarAtualizacao() {
  atualizadoEm = new Date();
  mostrarIdade();
}

function mostrarIdade() {
  const alvo = $('atualizado-em');
  if (!alvo || !atualizadoEm) return;

  const minutos = Math.floor((Date.now() - atualizadoEm.getTime()) / 60000);
  const hora = atualizadoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  // Dois minutos ja passam do intervalo de um minuto: se chegou ate aqui, o
  // painel esta parado por algum motivo, e a pessoa precisa saber qual.
  if (minutos >= 2) {
    const porque = document.querySelector('.fundo-modal')
      ? 'enquanto a janela de um relatório está aberta'
      : 'enquanto você está digitando em um campo';
    alvo.innerHTML = `<span style="color:var(--amarelo); font-weight:600">
      Esta tela é de ${hora} (${minutos} min atrás). O painel não atualiza ${porque}.</span>`;
    return;
  }
  alvo.textContent = `Atualizado às ${hora}.`;
}

// A idade da tela corre sozinha: sem isto, "Atualizado as 14:39" continuaria
// parecendo recente as 17h.
setInterval(mostrarIdade, 30000);

function podeAtualizarAgora() {
  if (document.hidden) return false;
  if (document.querySelector('.fundo-modal')) return false;
  const focado = document.activeElement;
  if (focado && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focado.tagName)) return false;
  // So faz sentido no Painel do mes; nas outras abas ele nem esta na tela.
  return !$('aba-painel')?.classList.contains('esconde');
}

setInterval(() => {
  if (podeAtualizarAgora()) carregarPainel({ silencioso: true }).catch(() => {});
}, INTERVALO_ATUALIZACAO);

// Voltou para a aba depois de um tempo fora: atualiza sem esperar o intervalo.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && podeAtualizarAgora()) carregarPainel({ silencioso: true }).catch(() => {});
});

carregarPainel().catch((e) => {
  console.error('falha ao carregar o painel', e);
  const t = $('tabela');
  if (t) {
    t.innerHTML = `<div class="aviso erro">Não foi possível carregar o painel deste mês.
      Recarregue a página. Se continuar, me mostre esta mensagem: ${escapar(e.message || e)}</div>`;
  }
});

// ------------------------------------------------------------------- painel

async function carregarPainel({ silencioso = false } = {}) {
  // A atualizacao automatica nao pisca "Carregando..." na tabela: de minuto em
  // minuto isso viraria um flash constante na cara de quem esta lendo a lista.
  if (!silencioso) $('tabela').innerHTML = `<p class="carregando">Carregando...</p>`;
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
  marcarAtualizacao();

  $('nao-enviaram').innerHTML = painel.nao_enviaram.length
    ? painel.nao_enviaram
        .map((u) => `<div class="anexo"><span class="nome">${escapar(u.nome)}</span>
             <span class="peso">${escapar(u.login)}</span></div>`)
        .join('')
    : `<p class="sub" style="margin:0">Todo mundo já enviou.</p>`;
}

function desenharTabela() {
  const todos = painel.relatorios;
  if (!todos.length) {
    $('tabela').innerHTML = `<p class="sub">Nenhum relatório enviado para ${escapar(
      painel.mes_extenso,
    )}.</p>`;
    if ($('f-contagem')) $('f-contagem').textContent = '';
    return;
  }

  const busca = chave(String(filtro('f-busca')).trim());
  const status = filtro('f-status');
  const empresa = filtro('f-empresa');
  const funcao = filtro('f-funcao');
  const agrupar = filtro('f-agrupar', true);

  const lista = todos.filter((r) => {
    if (status && r.status !== status) return false;
    if (empresa && r.empresa !== empresa) return false;
    if (funcao && r.funcao !== funcao) return false;
    if (busca && !chave(`${r.nome} ${r.login}`).includes(busca)) return false;
    return true;
  });

  if ($('f-contagem')) $('f-contagem').textContent =
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
    aoClicar(b, () => abrirDetalhe(Number(b.dataset.ver)), 'abrir este relatório');
  }
  for (const b of $('tabela').querySelectorAll('[data-conferir]')) {
    b.addEventListener('click', () => conferirUm(Number(b.dataset.conferir), b));
  }
  for (const b of $('tabela').querySelectorAll('[data-imprimir-rel]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/impressao?mes=${mes}&usuario_id=${b.dataset.imprimirRel}`;
    });
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
    <td><span class="selo ${r.status}">${escapar(r.rotulo_status)}</span>${r.regras_antigas ? `<br><span class="regras-antigas" title="Este parecer foi dado antes das regras atuais. Conferir de novo aplica as de hoje.">regras antigas</span>` : ''}</td>
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
      <button class="secundario pequeno" data-imprimir-rel="${r.usuario_id}"
              title="PDF com o RDV, a nota de abastecimento e o pedágio deste vendedor no mês">Imprimir</button>
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

/**
 * Reconfere os relatorios deste mes que foram julgados por regras antigas.
 *
 * Nao pega "todos" ao pe da letra: quem ja esta na versao atual seria conferido
 * de novo para dar exatamente o mesmo parecer, gastando IA e tempo a toa. O
 * alvo sao os que a tela marca como "regras antigas" - que e justamente o que
 * este botao existe para limpar.
 *
 * Relatorio de antes do lancamento dia a dia recusa com 409 e nao ha o que
 * fazer por aqui: entra na lista de falhas com o motivo, em vez de sumir.
 */
async function reconferirAntigos() {
  const antigos = (painel?.relatorios || []).filter((r) => r.regras_antigas);
  if (!antigos.length) {
    return mostrarRecado('recado', 'Nenhum relatório deste mês está com regras antigas.', 'info');
  }

  if (!confirm(
    `Reconferir ${antigos.length} relatório(s) julgado(s) com regras antigas?\n\n`
      + 'Cada um leva uns 20 segundos e consome créditos da API.\n\n'
      + 'ATENÇÃO: o parecer novo substitui o antigo. Relatório aprovado pode '
      + 'passar a reprovado, e o colaborador vê isso na tela dele.',
  )) return;

  const botao = $('botao-reconferir-antigos');
  const rotulo = botao.textContent;
  botao.disabled = true;
  let feitos = 0;
  const falhas = [];

  for (const r of antigos) {
    botao.textContent = `Reconferindo ${feitos + 1} de ${antigos.length}...`;
    try {
      await api('/api/admin/conferir', { metodo: 'POST', corpo: { relatorio_id: r.id } });
      feitos++;
    } catch (e) {
      falhas.push(`${r.nome}: ${e.message}`);
    }
  }

  botao.disabled = false;
  botao.textContent = rotulo;
  mostrarRecado(
    'recado',
    `${feitos} de ${antigos.length} reconferido(s).`
      + (falhas.length ? ` Não deu para reconferir: ${falhas.join(' | ')}` : ''),
    falhas.length ? 'atencao' : 'ok',
  );
  await carregarPainel();
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
        ${r.placas ? ` · placas: ${escapar(placaParaTela(r.placas))}` : " · sem placa declarada"}
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
      ${blocoPendenciasAgora(d.pendencias_agora, d)}
      ${r.regras_antigas ? `<div class="aviso atencao">Este parecer foi dado com <strong>regras anteriores</strong> as de hoje. Use \"Conferir de novo com IA\" para aplicar as regras atuais.</div>` : ''}
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
          // Vale para qualquer status, nao so para o pendente. Um relatorio ja
          // conferido ficava com o parecer preso para sempre: quando a regra de
          // conferencia mudava, o unico jeito de atualizar o texto era reescrever
          // na mao. Reconferir regrava o parecer com as regras de agora.
          r.status === 'RASCUNHO'
            ? ''
            : `<button class="secundario" id="conferir-daqui">${
                r.conferido_em ? 'Conferir de novo com IA' : 'Conferir com IA'
              }</button>`
        }
        <button class="secundario" id="imprimir-daqui"
                title="PDF com o RDV, a nota de abastecimento e o pedágio deste vendedor no mês">Imprimir este</button>
      </div>
    </div>`;

  document.body.appendChild(fundo);

  // Fechar a janela atualiza o painel na hora.
  //
  // Enquanto ela esta aberta o painel NAO atualiza, de proposito - ninguem quer
  // o relatorio fechando na cara no meio da leitura. So que sem esta linha a
  // tela ficava velha ate o proximo minuto, e uma janela esquecida aberta
  // congelava tudo em silencio: uma conferente passou um dia inteiro vendo os
  // relatorios como "rascunho" porque a tela dela era de ontem.
  const fechar = () => {
    fundo.remove();
    carregarPainel({ silencioso: true }).catch(() => {});
  };
  fundo.querySelector('#fechar').addEventListener('click', fechar);
  fundo.addEventListener('click', (ev) => {
    if (ev.target === fundo) fechar();
  });

  // O mes vem do relatorio aberto, nao do seletor do painel: sao sempre o
  // mesmo hoje, mas se um dia deixarem de ser, imprimir o mes errado sem avisar
  // seria o pior desfecho.
  fundo.querySelector('#imprimir-daqui')?.addEventListener('click', () => {
    location.href = `/api/admin/impressao?mes=${r.mes_ref}&usuario_id=${r.usuario_id}`;
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

/**
 * O que está pendente NESTE MOMENTO, recalculado ao abrir o relatório.
 *
 * Não confundir com `blocoAchados`, logo abaixo: aquele mostra o parecer
 * GRAVADO, que só existe depois que alguém conferiu. Este roda as regras na
 * hora, e por isso é o único que diz alguma coisa num rascunho ou num
 * relatório enviado que ninguém olhou ainda.
 *
 * Só existe aqui, na tela do admin. O colaborador não recebe este dado.
 */
function blocoPendenciasAgora(pendencias, d) {
  if (!pendencias) return '';

  // "Pendente" aqui e o que FALTA CHEGAR, nao o que esta errado.
  //
  // O bloco listava todos os achados, e isso duplicava o parecer logo abaixo -
  // km invertido, fim de semana e afins sao problema do que ja veio, nao coisa
  // faltando. O que interessa nesta linha do painel e: ja da para conferir
  // este relatorio, ou ainda estou esperando documento?
  const falta = [];
  if (!d.linhas.length) falta.push('os lançamentos do dia a dia');
  if (!d.anexos.some((a) => a.tipo === 'rdv')) falta.push('o arquivo do RDV');
  if (!d.anexos.some((a) => a.tipo === 'danfe')) falta.push('a nota de abastecimento');
  if (!d.anexos.some((a) => a.tipo === 'odometro')) falta.push('as fotos do odômetro');

  const declarado = Number(pendencias.totalDeclarado || 0);
  if (declarado > 0 && !d.anexos.some((a) => a.tipo === 'pedagio')) {
    falta.push('o comprovante de pedágio/estacionamento');
  }

  const corpo = falta.length
    ? falta
        .map((f) => `<div class="achado erro"><span class="icone">✕</span>
            <span>Falta ${escapar(f)}.</span></div>`)
        .join('')
    : '<div class="aviso ok">Chegou tudo. Pode conferir.</div>';

  return `<h2 style="margin-top:4px">O que falta chegar</h2>
    <p class="sub">Documentos e lançamentos que ainda não vieram. O que está
       errado no que já chegou aparece no parecer, abaixo.</p>
    ${corpo}`;
}

function blocoAchados(r) {
  if (!r.achados?.length) return '';
  return `<h2 style="margin-top:4px">O que foi encontrado</h2>
    ${(r.achados || [])
      .map(
        (a) => `<div class="achado ${a.gravidade}">
          <span class="icone">${a.gravidade === 'erro' ? '✕' : '!'}</span>
          <div class="corpo">
            <span>${escapar(a.mensagem)}</span>
            ${anexoDoAchado(a)}
          </div></div>`,
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

async function carregarUsuarios() {
  try {
    usuarios = await api('/api/admin/usuarios');
    desenharUsuarios();
  } catch (e) {
    mostrarRecado('recado-usuario', e.message, 'erro');
  }
}

function desenharUsuarios() {
  if (!usuarios.length) return;

  const busca = chave(String(filtro('fu-busca')).trim());
  const empresa = filtro('fu-empresa');
  const funcao = filtro('fu-funcao');
  const situacao = filtro('fu-situacao');
  const agrupar = filtro('fu-agrupar', true);

  const lista = usuarios.filter((u) => {
    if (empresa && u.empresa !== empresa) return false;
    if (funcao && u.funcao !== funcao) return false;
    if (situacao !== '' && String(u.ativo) !== situacao) return false;
    if (busca && !chave(`${u.nome} ${u.login} ${u.placas || ''}`).includes(busca)) return false;
    return true;
  });

  if ($('fu-contagem')) $('fu-contagem').textContent =
    lista.length === usuarios.length
      ? `${usuarios.length} cadastrado(s)`
      : `${lista.length} de ${usuarios.length}`;

  if (!lista.length) {
    $('lista-usuarios').innerHTML = `<div class="cartao"><p class="sub" style="margin:0">
      Ninguém com esses filtros.</p></div>`;
    return;
  }

  if (agrupar) {
    // Uma janela por empresa, e dentro dela o pessoal de campo separado do
    // administrativo — que faz um trabalho totalmente diferente.
    const empresas = [...new Set(lista.map((u) => u.empresa || 'DISO'))].sort();
    $('lista-usuarios').innerHTML = empresas
      .map((e) => janelaDaEmpresa(e, lista.filter((u) => (u.empresa || 'DISO') === e)))
      .join('');
  } else {
    $('lista-usuarios').innerHTML = `
      <div class="cartao">
        <h2>Todos os cadastrados</h2>
        ${tabelaDeUsuarios(lista)}
      </div>`;
  }

  ligarBotoesDeUsuario();
}

function janelaDaEmpresa(empresa, pessoas) {
  const ativos = pessoas.filter((u) => u.ativo).length;
  const arquivos = pessoas.reduce((s, u) => s + Number(u.anexos || 0), 0);

  const secoes = SECOES.map((s) => {
    const doGrupo = pessoas.filter((u) => s.funcoes.includes(u.funcao));
    if (!doGrupo.length) return '';
    return `
      <h3 class="secao">${s.titulo} <span class="n">${doGrupo.length}</span></h3>
      ${tabelaDeUsuarios(doGrupo)}`;
  }).join('');

  // Funcao fora das secoes conhecidas nao pode sumir da tela.
  const conhecidas = SECOES.flatMap((s) => s.funcoes);
  const sobra = pessoas.filter((u) => !conhecidas.includes(u.funcao));
  const extra = sobra.length
    ? `<h3 class="secao">Sem função definida <span class="n">${sobra.length}</span></h3>
       ${tabelaDeUsuarios(sobra)}`
    : '';

  return `
    <div class="cartao empresa-${escapar(empresa)}">
      <div class="titulo-empresa">
        <span class="sigla">${escapar(empresa)}</span>
        <span class="quantos">
          ${pessoas.length} pessoa(s) · ${ativos} ativa(s) · ${arquivos} arquivo(s)
        </span>
      </div>
      ${secoes}${extra}
    </div>`;
}

function tabelaDeUsuarios(lista) {
  return `
    <div class="rolagem">
      <table>
        <thead><tr>
          <th>Nome</th><th>Empresa</th><th>Função</th><th>Login</th><th>Placas</th>
          <th class="num">Arquivos</th><th>Situação</th><th></th>
        </tr></thead>
        <tbody>${lista.map(linhaUsuario).join('')}</tbody>
      </table>
    </div>`;
}

function linhaUsuario(u) {
  const ehAdmin = u.papel === 'admin';
  // Desativado fica MARCADO, nao apagado: com 42 pessoas desativadas, esmaecer
  // a linha fazia parecer que elas nao estavam na tela.
  return `<tr class="de-${escapar(u.empresa || 'DISO')}${u.ativo ? '' : ' inativo'}">
    <td>
      ${escapar(u.nome)}${ehAdmin ? ' <span class="selo RASCUNHO">admin</span>' : ''}<br>
      <span class="emp ${escapar(u.empresa || 'DISO')}">${escapar(u.cracha || '')}</span>
    </td>
    <td>
      <select data-empresa="${u.id}" style="margin:0; padding:5px 8px; font-size:13px; width:auto">
        ${EMPRESAS.map(
          (e) => `<option value="${e}"${u.empresa === e ? ' selected' : ''}>${e}</option>`,
        ).join('')}
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
    <td>${escapar(placaParaTela(u.placas) || "—")}</td>
    <td class="num">${u.anexos}</td>
    <td>${
      u.ativo
        ? '<span class="selo CERTA">Ativo</span>'
        : '<span class="selo ERRADA">Desativado</span>'
    }</td>
    <td style="white-space:nowrap">
      ${
        u.papel === 'colaborador'
          ? `<button class="pequeno" data-galeria="${u.id}">Galeria</button>
             <button class="secundario pequeno" data-historico="${u.id}"
                     title="Planilha com todos os meses deste colaborador">Histórico</button>
             <button class="secundario pequeno" data-pacote="${u.id}"
                     title="Baixa uma pasta com tudo deste colaborador">Baixar pasta</button>
             <button class="secundario pequeno" data-imprimir="${u.id}"
                     title="PDF único com RDV, nota de abastecimento e pedágio do mês, pronto para imprimir">Imprimir mês</button>`
          : ''
      }
      <button class="secundario pequeno" data-nome="${u.id}"
              title="Corrige o nome que aparece no painel e nas planilhas.">Editar nome</button>
      <button class="secundario pequeno" data-placa="${u.id}"
              title="Corrige a placa, ou apaga o que estiver errado no campo.">Editar placa</button>
      <button class="secundario pequeno" data-login="${u.id}"
              title="Corrige o login de acesso. O cadastro e os relatórios continuam os mesmos.">Trocar login</button>
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
    aoClicar(b, () => abrirGaleria(Number(b.dataset.galeria)), 'abrir a galeria');
  }
  for (const b of raiz.querySelectorAll('[data-pacote]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/pacote?usuario_id=${b.dataset.pacote}`;
    });
  }
  for (const b of raiz.querySelectorAll('[data-imprimir]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/impressao?mes=${mes}&usuario_id=${b.dataset.imprimir}`;
    });
  }
  for (const b of raiz.querySelectorAll('[data-historico]')) {
    b.addEventListener('click', () => {
      location.href = `/api/admin/historico?usuario_id=${b.dataset.historico}`;
    });
  }

  for (const b of raiz.querySelectorAll('[data-placa]')) {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.placa);
      const u = usuarios.find((x) => x.id === id);
      if (!u) return;

      // O valor atual entra no prompt cortado: um cadastro sujo pode ter
      // milhares de caracteres, e ninguem edita isso dentro de um prompt.
      // Apagar (deixar vazio) resolve, e a pessoa digita a placa certa depois.
      const atual = String(u.placas || '');
      const nova = prompt(
        `Placa de ${u.nome}.\n\n`
          + 'Letras e números, até 60 caracteres. Dois carros: separe por vírgula.\n'
          + 'Para apagar a placa, deixe o campo vazio e confirme.',
        atual.length > 60 ? '' : atual,
      );
      if (nova === null) return;

      try {
        const r = await api('/api/admin/usuario-placa', {
          metodo: 'POST',
          corpo: { usuario_id: id, placas: nova },
        });
        mostrarRecado(
          'recado-usuario',
          r.placas ? `Placa de ${u.nome} agora é ${r.placas}.` : `Placa de ${u.nome} apagada.`,
          'ok',
        );
        carregarUsuarios();
      } catch (e) {
        mostrarRecado('recado-usuario', e.message, 'erro');
      }
    });
  }

  for (const b of raiz.querySelectorAll('[data-nome]')) {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.nome);
      const u = usuarios.find((x) => x.id === id);
      if (!u) return;

      const novo = prompt(
        `Nome de ${u.nome}.\n\n`
          + 'Muda como a pessoa aparece no painel, na galeria e nas planilhas — '
          + 'inclusive nos relatórios que ela já enviou.\n'
          + 'O login e a senha não mudam.',
        u.nome,
      );
      if (!novo || novo.trim() === u.nome) return;

      try {
        const r = await api('/api/admin/usuario-nome', {
          metodo: 'POST',
          corpo: { usuario_id: id, nome: novo },
        });
        mostrarRecado('recado-usuario', `Nome alterado de "${r.anterior}" para "${r.nome}".`, 'ok');
        carregarUsuarios();
      } catch (e) {
        mostrarRecado('recado-usuario', e.message, 'erro');
      }
    });
  }

  for (const b of raiz.querySelectorAll('[data-login]')) {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.login);
      const u = usuarios.find((x) => x.id === id);
      if (!u) return;

      const novo = prompt(
        `Novo login de acesso para ${u.nome}.\n\n`
          + `Login atual: ${u.login}\n\n`
          + 'Só letras, números, ponto, hífen e sublinhado — sem espaço.\n'
          + 'Os relatórios e anexos continuam com a pessoa; só muda o que ela digita para entrar.',
        u.login,
      );
      if (!novo || novo.trim().toLowerCase() === u.login) return;

      try {
        const r = await api('/api/admin/usuario-login', {
          metodo: 'POST',
          corpo: { usuario_id: id, login: novo },
        });
        // A pessoa cai da sessao na troca: quem avisa e o admin, aqui.
        mostrarRecado(
          'recado-usuario',
          `Login alterado de "${r.anterior}" para "${r.login}". `
            + 'Avise a pessoa — ela foi desconectada e entra com o login novo.',
          'ok',
        );
        carregarUsuarios();
      } catch (e) {
        mostrarRecado('recado-usuario', e.message, 'erro');
      }
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
        ${g.usuario.placas ? ` · placas: ${escapar(placaParaTela(g.usuario.placas))}` : ''}
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
  carregarResumoBackup();
}

// ------------------------------------------------------------------ backup

/**
 * O que existe hoje e quando foi o último backup.
 *
 * O aviso por tempo é o ponto do cartão: backup que depende de alguém lembrar
 * só funciona se alguém for lembrado. Sem isso a tela viraria mais um botão
 * que ninguém aperta — e a cópia mais recente teria sempre meses.
 */
async function carregarResumoBackup() {
  const alvo = $('resumo-backup');
  if (!alvo) return;
  try {
    const d = await api('/api/admin/dados');
    const mb = (d.tamanho_anexos / 1048576).toFixed(1);

    let quando;
    let tom = 'ok';
    if (!d.ultimo_backup_em) {
      quando = 'Nunca foi feito backup por aqui.';
      tom = 'atencao';
    } else {
      const dias = Math.floor((Date.now() - new Date(d.ultimo_backup_em)) / 86400000);
      const data = new Date(d.ultimo_backup_em).toLocaleString('pt-BR');
      quando = dias === 0
        ? `Último backup: hoje, ${data}.`
        : `Último backup: ${data} — há ${dias} dia(s).`;
      if (dias >= 7) tom = 'atencao';
    }

    alvo.innerHTML = `
      <div class="aviso ${tom}">
        ${escapar(quando)}<br>
        Hoje o portal tem <strong>${d.usuarios}</strong> colaboradores,
        <strong>${d.relatorios}</strong> relatórios e
        <strong>${d.anexos}</strong> anexos (${mb} MB).
      </div>`;
  } catch (e) {
    alvo.innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

$('botao-baixar-backup')?.addEventListener('click', () => {
  mostrarRecado('recado-backup', 'Gerando o arquivo... pode demorar um pouco com muitos anexos.', 'info');
  location.href = '/api/admin/backup';
  // O download não avisa quando termina; a data vem do servidor na recarga.
  setTimeout(() => {
    mostrarRecado('recado-backup', 'Backup gerado. Guarde o arquivo fora do servidor.', 'ok');
    carregarResumoBackup();
  }, 3000);
});

$('botao-restaurar')?.addEventListener('click', async () => {
  const arquivo = $('arquivo-restaurar').files?.[0];
  if (!arquivo) {
    return mostrarRecado('recado-backup', 'Escolha primeiro o arquivo .zip do backup.', 'atencao');
  }

  // Duas confirmacoes porque nao ha volta: o banco atual e substituido inteiro.
  if (!confirm(
    `Restaurar a partir de "${arquivo.name}"?\n\n`
      + 'ISSO SUBSTITUI TUDO que está no portal agora — colaboradores, relatórios e anexos '
      + 'passam a ser os do arquivo.\n\nO que existe hoje será perdido.',
  )) return;
  if (!confirm('Tem certeza mesmo? Esta ação não tem desfazer.')) return;

  mostrarRecado('recado-backup', 'Enviando e restaurando... não feche esta página.', 'info');
  try {
    const r = await fetch('/api/admin/restaurar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: arquivo,
      credentials: 'same-origin',
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || 'Falha ao restaurar.');
    mostrarRecado('recado-backup', dados.aviso || 'Dados restaurados.', 'ok');
    carregarResumoBackup();
  } catch (e) {
    mostrarRecado('recado-backup', e.message, 'erro');
  }
});

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
