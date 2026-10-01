// Tela do administrador: painel do mes, conferencia com IA, colaboradores e ajustes.

import {
  api, mostrarRecado, escapar, brl, numeroBr, dataBr, dataHoraBr,
  tamanhoBr, mesAtual, sair, ROTULO_ANEXO, marcarAmbiente, anexoDoAchado, placaParaTela,
  lembrarQuemEsta, lerNumeroBr, valorNoCampo, agruparAchados, htmlDoGrupoDeAchados,
} from '/js/comum.js';

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------- downloads
//
// Planilha, caderno de impressao, pacote e backup eram abertos com
// location.href. Quando nao havia o que baixar (mes sem RDV nem comprovante),
// a tela inteira trocava por uma pagina com o erro cru em JSON, e a pessoa
// tinha que voltar. Agora o arquivo e buscado por tras: deu certo, baixa;
// nao deu, sobe um aviso na propria tela e nada muda de lugar.
let avisoFlutuante = null;

function avisar(texto, tipo = 'erro', segundos = 6) {
  avisoFlutuante?.remove();
  const el = document.createElement('div');
  el.className = `aviso-flutuante ${tipo}`;
  el.setAttribute('role', 'status');
  el.textContent = texto;
  document.body.appendChild(el);
  avisoFlutuante = el;
  if (segundos) setTimeout(() => el.isConnected && el.remove(), segundos * 1000);
  return el;
}

async function baixar(url) {
  const espera = avisar('Preparando o arquivo...', 'info', 0);
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      avisar(d.erro || 'Não foi possível gerar o arquivo agora. Tente de novo.', r.status === 404 ? 'atencao' : 'erro');
      return;
    }
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const nome = decodeURIComponent((cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1] || 'arquivo');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    espera.remove();
  } catch {
    avisar('Sem conexão com o portal. Confira a internet e tente de novo.');
  }
}

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
  { titulo: 'Gerentes', funcoes: ['Gerente'] },
  { titulo: 'Coordenadores', funcoes: ['Coordenador'] },
  { titulo: 'Administrativo', funcoes: ['Adm Promotor', 'Adm DISO', 'Adm DSO', 'Adm ALPHA'] },
];

const FUNCOES = ['Vendedor', 'Promotor', 'Supervisor', 'Gerente', 'Coordenador', 'Adm Promotor', 'Adm DISO', 'Adm DSO', 'Adm ALPHA'];
const EMPRESAS = ['DISO', 'DSO', 'PROMOTORES', 'ALPHA'];

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
// Aba Valores pagos. Fica aqui em cima: o #valores na URL abre a aba durante a
// inicializacao, antes de o modulo chegar la embaixo.
let valoresPagos = [];

// ------------------------------------------------------------------- inicio

let souSuper = false;
// `function`: e usada na lista, que pode montar durante a inicializacao.
function ehAdministrativo(funcao) {
  return String(funcao || '').startsWith('Adm ');
}
let possoDarCoordenador = false;

try {
  const dados = await api('/api/eu');
  $('meu-nome').textContent = dados.usuario.nome;
  lembrarQuemEsta(dados.usuario.login);
  souSuper = dados.usuario.papel === 'super';
  // Coordenador so o Adm Promotor (e o dono) coloca. A rota recusa os outros.
  possoDarCoordenador = souSuper || dados.usuario.funcao === 'Adm Promotor';
  if (possoDarCoordenador) $('opcao-coordenador')?.classList.remove('esconde');
  marcarAmbiente(dados.ambiente);
  // Backup e restauracao sao do dono do sistema. As rotas ja recusam quem nao
  // e super; esconder o cartao evita oferecer um botao que so devolve 403.
  if (!souSuper) $('cartao-backup')?.remove();
  if (!souSuper) $('cartao-armazenamento')?.remove();
  if (souSuper) avisoDeEspaco();
  // A aba "Tudo" e o perfil "Dono" so existem para quem ve tudo. A rota ja
  // recusa os outros; esconder evita oferecer o que so devolveria 403.
  if (souSuper) {
    $('aba-tudo-botao')?.classList.remove('esconde');
    $('opcao-super')?.classList.remove('esconde');
  }
} catch {
  location.href = '/';
}

$('mes').value = mes;
$('botao-sair').addEventListener('click', sair);
// A aba "Não enviaram" tem o seu seletor de mes, que e o mesmo do painel.
$('mes-faltam').value = mes;
$('mes-faltam').addEventListener('change', () => {
  if (!$('mes-faltam').value) return;
  $('mes').value = $('mes-faltam').value;
  $('mes').dispatchEvent(new Event('change'));
});
$('faltam-busca').addEventListener('input', () => desenharNaoEnviaram());

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
  baixar(`/api/admin/exportar?mes=${mes}`);
});
$('botao-imprimir-mes').addEventListener('click', () => {
  baixar(`/api/admin/impressao?mes=${mes}`);
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
  marcarAbaEmpresa('');
  desenharTabela();
});

// --- abas por empresa (acionam o filtro f-empresa) ---
function marcarAbaEmpresa(empresa) {
  for (const b of document.querySelectorAll('#abas-empresa button')) {
    b.classList.toggle('ativa', b.dataset.empresa === empresa);
  }
}
function atualizarAbasEmpresa() {
  const todos = (typeof painel !== 'undefined' && painel && painel.relatorios) || [];
  for (const b of document.querySelectorAll('#abas-empresa button')) {
    const emp = b.dataset.empresa;
    const n = emp ? todos.filter((r) => (r.empresa || 'DISO') === emp).length : todos.length;
    const span = b.querySelector('.n');
    if (span) span.textContent = n ? String(n) : '';
  }
}
for (const b of document.querySelectorAll('#abas-empresa button')) {
  b.addEventListener('click', () => {
    marcarAbaEmpresa(b.dataset.empresa);
    if ($('f-empresa')) $('f-empresa').value = b.dataset.empresa;
    desenharTabela();
  });
}

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
$('c-modelo').addEventListener('change', salvarModelo);
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
    if (b.dataset.aba === 'valores') carregarValoresPagos();
    if (b.dataset.aba === 'tudo') carregarTudo();
    window.scrollTo({ top: 0 });
  });
}

// /admin.html#tudo abre direto naquela aba. Serve para guardar o atalho da
// tela que voce mais usa, e para um recado poder mandar a pessoa ao lugar
// certo em vez de dizer "abra o painel e clique em tal aba".
{
  const alvo = location.hash.replace('#', '');
  const botao = alvo && document.querySelector(`.abas button[data-aba="${CSS.escape(alvo)}"]`);
  if (botao && !botao.classList.contains('esconde')) botao.click();
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

// Uma conferencia pode estar rodando no servidor desde antes desta tela abrir
// - de outro computador, ou de uma aba que ja foi fechada. O painel mostra o
// andamento assim que abre.
//
// O relogio fica declarado AQUI, antes da chamada: declarado la embaixo, junto
// da funcao, a chamada caia nele antes de existir (ReferenceError) e o painel
// aberto no meio de uma fila nao mostrava o andamento.
let relogioDaFila = null;
acompanharFila();

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

  // No painel fica so o resumo; a lista inteira, por empresa, tem aba propria.
  const porEmpresa = naoEnviaramPorEmpresa(painel.nao_enviaram);
  $('nao-enviaram').innerHTML = painel.nao_enviaram.length
    ? `<p class="sub" style="margin:0 0 10px">${painel.nao_enviaram.length} pessoa(s): ${porEmpresa
        .map(([e, lista]) => `${escapar(e)} ${lista.length}`)
        .join(' · ')}.</p>
       <button class="secundario pequeno" id="ver-nao-enviaram">Ver quem não enviou, por empresa</button>`
    : `<p class="sub" style="margin:0">Todo mundo já enviou.</p>`;
  $('ver-nao-enviaram')?.addEventListener('click', () => {
    document.querySelector('.abas button[data-aba="faltam"]')?.click();
  });

  if ($('mes-faltam')) $('mes-faltam').value = mes;
  desenharNaoEnviaram();
}

// ------------------------------------------------------------ nao enviaram
//
// Quem ainda nao mandou o RDV do mes, separado por empresa - e a lista que se
// usa para cobrar. "Começou e não enviou" e quem ja lancou dia ou anexou
// arquivo: esta mais perto de mandar do que quem nem abriu o mes.

const ORDEM_DAS_EMPRESAS = ['DISO', 'DSO', 'PROMOTORES', 'ALPHA'];

function naoEnviaramPorEmpresa(lista) {
  const grupos = new Map();
  for (const u of lista) {
    const e = u.empresa || 'DISO';
    if (!grupos.has(e)) grupos.set(e, []);
    grupos.get(e).push(u);
  }
  const posicao = (e) => (ORDEM_DAS_EMPRESAS.includes(e) ? ORDEM_DAS_EMPRESAS.indexOf(e) : 99);
  return [...grupos.entries()].sort((a, b) => posicao(a[0]) - posicao(b[0]) || a[0].localeCompare(b[0]));
}

function desenharNaoEnviaram() {
  if (!painel || !$('faltam-lista')) return;
  const todos = painel.nao_enviaram;
  const busca = chave(String($('faltam-busca').value || '').trim());
  const lista = busca
    ? todos.filter((u) => chave(u.nome).includes(busca) || chave(u.login).includes(busca))
    : todos;
  const grupos = naoEnviaramPorEmpresa(lista);

  $('faltam-contagem').innerHTML = `
    <div class="numero destaque"><div class="rotulo">Não enviaram em ${escapar(painel.mes_extenso)}</div>
      <div class="valor">${todos.length}</div></div>
    ${naoEnviaramPorEmpresa(todos).map(([e, l]) => `<div class="numero">
      <div class="rotulo">${escapar(e)}</div><div class="valor">${l.length}</div></div>`).join('')}
    <div class="numero"><div class="rotulo">Começaram e não enviaram</div>
      <div class="valor" style="color:var(--amarelo)">${todos.filter((u) => u.comecou).length}</div></div>`;

  if (!todos.length) {
    $('faltam-lista').innerHTML = `<div class="cartao"><p class="sub" style="margin:0">Todo mundo já enviou o RDV de ${escapar(painel.mes_extenso)}.</p></div>`;
    return;
  }
  if (!lista.length) {
    $('faltam-lista').innerHTML = `<div class="cartao"><p class="sub" style="margin:0">Ninguém com esse nome na lista.</p></div>`;
    return;
  }

  $('faltam-lista').innerHTML = grupos
    .map(([empresa, pessoas]) => `<div class="cartao">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px">
        <h2 style="margin:0; flex:1; border:0; padding:0">${escapar(empresa)} — ${pessoas.length} não enviaram</h2>
        <button class="secundario pequeno" data-copiar-empresa="${escapar(empresa)}"
                title="Copia os nomes, um por linha, para colar numa mensagem">Copiar nomes</button>
      </div>
      <div class="rolagem"><table>
        <thead><tr><th>Colaborador</th><th>Crachá</th><th>Login</th><th>Situação</th></tr></thead>
        <tbody>${pessoas.map((u) => `<tr class="de-${escapar(empresa)}">
          <td>${escapar(u.nome)}</td>
          <td><span class="emp ${escapar(empresa)}">${escapar(u.cracha || empresa)}</span></td>
          <td>${escapar(u.login)}</td>
          <td>${u.comecou
            ? '<span style="color:var(--amarelo); font-weight:600">Começou e não enviou</span>'
            : 'Nem começou'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`)
    .join('');

  for (const b of $('faltam-lista').querySelectorAll('[data-copiar-empresa]')) {
    b.addEventListener('click', async () => {
      const nomes = (grupos.find(([e]) => e === b.dataset.copiarEmpresa)?.[1] || []).map((u) => u.nome).join('\n');
      try {
        await navigator.clipboard.writeText(nomes);
        avisar('Nomes copiados.', 'info', 3);
      } catch {
        avisar('Não consegui copiar. Selecione os nomes na tabela e copie na mão.', 'atencao');
      }
    });
  }
}

function desenharTabela() {
  const todos = painel.relatorios;
  atualizarAbasEmpresa();
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
        const valor = doGrupo.reduce((s, r) => s + Number(r.total_a_receber || 0), 0);
        return (
          `<tr class="grupo-empresa"><td colspan="9">
             ${escapar(e)} — ${doGrupo.length} relatório(s) · ${numeroBr(km)} km · ${brl(valor)} a receber
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
        <th class="num" title="Pedágio + estacionamento declarados">Ped.+estac.</th><th class="num">Comprovado</th><th class="num">Diferença</th>
        <th class="num" title="Valor do km + pedágio + estacionamento + hotel + outras despesas">Total a receber</th>
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
      baixar(`/api/admin/impressao?mes=${mes}&usuario_id=${b.dataset.imprimirRel}`);
    });
  }
}

// O total do portal diferente do "Subtotal das Despesas" do RDV, em vermelho.
// Vazio quando bate ou quando o subtotal nao foi lido.
function subtotalDiferente(total, subtotal) {
  if (subtotal == null || Math.round(Number(total) * 100) === Math.round(Number(subtotal) * 100)) return '';
  return `<br><span style="color:var(--vermelho); font-size:12.5px"
    title="O Subtotal das Despesas escrito no RDV é diferente do total somado pelo portal.">RDV: ${brl(subtotal)}</span>`;
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
    <td class="num"><strong>${brl(r.total_a_receber)}</strong>${subtotalDiferente(r.total_a_receber, r.subtotal_rdv)}</td>
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

  // Quem confere e o SERVIDOR: esta chamada so enfileira e responde na hora.
  // A aba pode ser fechada, o mes pode ser trocado, o computador pode dormir -
  // a fila segue. Daqui para baixo so acompanhamos o andamento.
  try {
    const r = await api('/api/admin/conferir-pendentes', { metodo: 'POST', corpo: { mes, demo } });
    if (r.ja_rodando) {
      mostrarRecado('recado', 'Já existe uma conferência em andamento. O andamento aparece abaixo.', 'info');
    }
  } catch (e) {
    return mostrarRecado('recado', e.message, 'erro');
  }
  acompanharFila();
}

// ------------------------------------------------------------------ fila

// Enquanto a fila roda, o painel pergunta o andamento de 3 em 3 segundos.
// Quem abrir o painel no meio - inclusive em outro computador - cai no mesmo
// estado: ele mora no servidor, nao nesta tela.

async function acompanharFila() {
  clearTimeout(relogioDaFila);
  let fila;
  try {
    fila = await api('/api/admin/fila');
  } catch {
    return; // sessao caiu ou portal reiniciando: a proxima carga do painel tenta de novo
  }
  desenharFila(fila);
  if (fila.rodando) relogioDaFila = setTimeout(acompanharFila, 3000);
  else if (fila.total) await carregarPainel({ silencioso: true });
}

function desenharFila(f) {
  const alvo = $('fila');
  if (!alvo) return;
  if (!f.total) {
    alvo.innerHTML = '';
    return;
  }

  const falhas = f.qtd_falhas
    ? `<p class="sub" style="margin:8px 0 0">${f.qtd_falhas} não conferido(s): ${f.falhas
        .map((x) => `${escapar(x.nome)} (${escapar(x.erro)})`)
        .join(' · ')}</p>`
    : '';

  alvo.innerHTML = f.rodando
    ? `<div class="aviso info">
         <strong>Conferindo ${Math.min(f.feitos + 1, f.total)} de ${f.total}${f.demo ? ' (demonstração)' : ''}.</strong>
         ${f.atual ? ` Agora: ${escapar(f.atual)}.` : ''}
         Pode fechar esta página — quem confere é o servidor.
         <div class="progresso" style="margin-top:10px"><div class="progresso-barra"
              style="width:${Math.round((f.feitos / f.total) * 100)}%"></div></div>
         <button class="secundario pequeno" id="botao-parar-fila" style="margin-top:10px">Parar depois do atual</button>
         ${falhas}
       </div>`
    : `<div class="aviso ${f.qtd_falhas ? 'atencao' : 'ok'}">
         <strong>Conferência terminada:</strong> ${f.certos} de ${f.total} conferido(s)${f.parando ? ', parada a pedido' : ''}.
         ${falhas}
       </div>`;

  const parar = $('botao-parar-fila');
  if (parar) {
    parar.addEventListener('click', async () => {
      parar.disabled = true;
      try { await api('/api/admin/fila-parar', { metodo: 'POST' }); } catch {}
      acompanharFila();
    });
  }
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
  // O total que o proprio RDV declara: tem que ser o total a receber.
  const subtotalDoRel = r.extraido?.totais_declarados?.subtotal ?? null;
  const subtotalBate = subtotalDoRel != null
    && Math.round(subtotalDoRel * 100) === Math.round(totalAReceber(r) * 100);
  const fundo = document.createElement('div');
  fundo.className = 'fundo-modal';
  fundo.innerHTML = `
    <div class="modal">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px">
        <h2 style="margin:0; flex:1">${escapar(r.nome)}</h2>
        ${r.status === 'CONFERINDO' ? '' : '<button class="secundario pequeno" id="editar">Editar valores</button>'}
        <button class="secundario pequeno" id="fechar">Fechar</button>
      </div>
      <p class="sub">
        ${escapar(r.mes_extenso)} ·
        <span class="selo ${r.status}">${escapar(r.rotulo_status)}</span>
        ${r.placas ? ` · placas: ${escapar(placaParaTela(r.placas))}` : " · sem placa declarada"}
      </p>

      <div id="edicao" class="esconde"></div>
      <div id="leitura">
      <div class="numeros" style="margin-bottom:16px">
        <div class="numero"><div class="rotulo">Total de km</div>
          <div class="valor">${numeroBr(r.total_km)}</div></div>
        <div class="numero"><div class="rotulo">Valor do km</div>
          <div class="valor">${brl(r.valor_km)}</div></div>
        <div class="numero"><div class="rotulo">Ped.+estac. declarado</div>
          <div class="valor">${brl(r.pedagio_declarado + r.estac_declarado)}</div></div>
        <div class="numero"><div class="rotulo">Comprovado${r.pedagio_comprovado_admin != null ? ' (digitado)' : ''}</div>
          <div class="valor">${r.pedagio_comprovado == null ? '—' : brl(r.pedagio_comprovado)}</div></div>
        ${Number(r.hotel_declarado) + Number(r.outros_declarado) > 0
          ? `<div class="numero"><div class="rotulo">Hotel + outras</div>
          <div class="valor">${brl(Number(r.hotel_declarado) + Number(r.outros_declarado))}</div></div>`
          : ''}
        <div class="numero destaque"><div class="rotulo">Total a receber</div>
          <div class="valor">${brl(totalAReceber(r))}</div></div>
        <div class="numero"><div class="rotulo">Subtotal no RDV</div>
          <div class="valor" style="${subtotalDoRel == null ? '' : `color:${subtotalBate ? 'var(--verde)' : 'var(--vermelho)'}`}">${subtotalDoRel == null ? '—' : brl(subtotalDoRel)}</div></div>
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
                  ${a.valor ? `<span class="selo CERTA">${brl(a.valor)}</span>` : ''}
                  ${a.arquivado_em ? `<span class="selo" title="Tirado do servidor. Devolva o bloco para abrir aqui.">Arquivado · bloco ${a.arquivado_bloco}</span>` : ''}
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
            ${d.linhas.some((l) => Number(l.combustivel) > 0) ? '<th class="num">Combustível</th>' : ''}
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
              ${d.linhas.some((x) => Number(x.combustivel) > 0) ? `<td class="num">${Number(l.combustivel) ? brl(l.combustivel) : '—'}</td>` : ''}
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

  // Editar troca a leitura pelo formulario, na mesma janela.
  const edicao = fundo.querySelector('#edicao');
  const leitura = fundo.querySelector('#leitura');
  const botaoEditar = fundo.querySelector('#editar');
  const mostrarEdicao = (sim) => {
    edicao.classList.toggle('esconde', !sim);
    leitura.classList.toggle('esconde', sim);
    botaoEditar?.classList.toggle('esconde', sim);
  };
  botaoEditar?.addEventListener('click', () => {
    edicao.innerHTML = formDeEdicao(d);
    ligarEdicao(edicao, d, {
      aoCancelar: () => mostrarEdicao(false),
      aoSalvar: async () => {
        fundo.remove();
        await abrirDetalhe(id);
        avisar('Alterações salvas. Confira de novo para atualizar o parecer.', 'info');
      },
    });
    mostrarEdicao(true);
  });

  fundo.addEventListener('click', (ev) => {
    // No meio de uma edicao, clique fora nao fecha: perderia o que foi digitado.
    if (ev.target === fundo && edicao.classList.contains('esconde')) fechar();
  });

  // O mes vem do relatorio aberto, nao do seletor do painel: sao sempre o
  // mesmo hoje, mas se um dia deixarem de ser, imprimir o mes errado sem avisar
  // seria o pior desfecho.
  fundo.querySelector('#imprimir-daqui')?.addEventListener('click', () => {
    baixar(`/api/admin/impressao?mes=${r.mes_ref}&usuario_id=${r.usuario_id}`);
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
  // Hotel e outras despesas: um comprovante nao vale pelo outro.
  if (Number(pendencias.hotelDeclarado || 0) > 0
      && !d.anexos.some((a) => a.tipo === 'hotel')) {
    falta.push('a nota do hotel');
  }
  if (Number(pendencias.outrosDeclarado || 0) > 0
      && !d.anexos.some((a) => a.tipo === 'outras_despesas')) {
    falta.push('o comprovante das outras despesas');
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
  // Erro primeiro, aviso depois; o mesmo problema em varios dias vira uma
  // linha so, com os dias na frente.
  const emOrdem = [
    ...r.achados.filter((a) => a.gravidade === 'erro'),
    ...r.achados.filter((a) => a.gravidade !== 'erro'),
  ];
  return `<h2 style="margin-top:4px">O que foi encontrado</h2>
    ${agruparAchados(emOrdem)
      .map((a) =>
        a.grupo
          ? htmlDoGrupoDeAchados(a)
          : `<div class="achado ${a.gravidade}">
          <span class="icone">${a.gravidade === 'erro' ? '✕' : '!'}</span>
          <div class="corpo">
            <span>${escapar(a.mensagem)}</span>
            ${anexoDoAchado(a)}
          </div></div>`,
      )
      .join('')}`;
}

// ------------------------------------------------- edicao pelo admin
//
// O admin corrige os numeros do relatorio na mao: totais, valor de cada
// comprovante e os lancamentos dos dias. So vai para o servidor o que mudou.

const VALORES_EDITAVEIS = [
  ['total_km', 'Total de km', 'km'],
  ['valor_km', 'Valor do km (R$)', 'dinheiro'],
  ['pedagio_declarado', 'Pedágio declarado', 'dinheiro'],
  ['estac_declarado', 'Estacionamento declarado', 'dinheiro'],
  ['hotel_declarado', 'Hotel', 'dinheiro'],
  ['outros_declarado', 'Outras despesas', 'dinheiro'],
  ['pedagio_comprovado', 'Pedágio comprovado', 'dinheiro'],
];
const CAMPOS_DA_LINHA = ['km_inicial', 'km_final', 'itinerario', 'pedagio', 'estacionamento', 'combustivel'];

// Numero como a pessoa digita: virgula no decimal, vazio quando nao ha valor.
const noCampo = (v) => (v == null || v === '' ? '' : String(Number(v)).replace('.', ','));
const totalAReceber = (r) =>
  ['valor_km', 'pedagio_declarado', 'estac_declarado', 'hotel_declarado', 'outros_declarado']
    .reduce((s, c) => s + Number(r[c] || 0), 0);

function campoDeEdicao(atributos, valor, classe = '') {
  return `<input type="text" autocomplete="off" ${atributos} class="${classe}"
            value="${escapar(valor)}" data-original="${escapar(valor)}">`;
}

function formDeEdicao(d) {
  const r = d.relatorio;
  const comCombustivel = d.gerente || d.linhas.some((l) => Number(l.combustivel) > 0);
  return `
    <div id="recado-edicao"></div>
    <p class="sub">Mude o que precisar e salve. O parecer só muda quando você conferir de novo
      ou decidir na mão.</p>

    <div class="edicao-valores">
      ${VALORES_EDITAVEIS.map(([campo, rotulo, tipo]) => `<div>
          <label>${rotulo}</label>
          ${campoDeEdicao(`data-valor="${campo}" inputmode="decimal"`, tipo === 'km' ? noCampo(r[campo] || '') : valorNoCampo(r[campo]))}
        </div>`).join('')}
      <div><label>Total a receber</label><input type="text" id="e-total" readonly></div>
    </div>
    <p class="sub">Total a receber = valor do km + pedágio + estacionamento + hotel + outras despesas.
      Pedágio comprovado em branco volta a valer a leitura do comprovante.</p>

    <h2 style="margin-top:20px">Comprovantes (${d.anexos.length})</h2>
    ${d.anexos.length ? `<div class="rolagem"><table class="tabela-edicao">
      <thead><tr><th>Tipo</th><th>Arquivo</th><th class="num">Valor (R$)</th><th class="num">KM da foto</th></tr></thead>
      <tbody>${d.anexos.map((a) => `<tr data-anexo="${a.id}">
        <td>${escapar(ROTULO_ANEXO[a.tipo] || a.tipo)}</td>
        <td><a href="/api/anexo/${a.id}" target="_blank" rel="noopener">${escapar(a.nome_original)}</a></td>
        <td class="num">${a.tipo === 'rdv' || a.tipo === 'odometro' ? '—' : campoDeEdicao('data-campo="valor" inputmode="decimal"', valorNoCampo(a.valor))}</td>
        <td class="num">${a.tipo === 'odometro' ? campoDeEdicao('data-campo="km" inputmode="decimal"', noCampo(a.km || '')) : '—'}</td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="sub">Nenhum comprovante anexado.</p>'}

    <h2 style="margin-top:20px">Lançamentos (${d.linhas.length} dias)</h2>
    ${d.linhas.length ? `<div class="rolagem"><table class="tabela-edicao">
      <thead><tr><th>Data</th><th class="num">Km ini</th><th class="num">Km fim</th><th>Itinerário</th>
        <th class="num">Pedágio</th><th class="num">Estac.</th>${comCombustivel ? '<th class="num">Combustível</th>' : ''}</tr></thead>
      <tbody>${d.linhas.map((l) => `<tr data-linha="${l.id}">
        <td>${dataBr(l.data).slice(0, 5)}</td>
        <td class="num">${campoDeEdicao('data-campo="km_inicial" inputmode="decimal"', noCampo(l.km_inicial || ''))}</td>
        <td class="num">${campoDeEdicao('data-campo="km_final" inputmode="decimal"', noCampo(l.km_final || ''))}</td>
        <td>${campoDeEdicao('data-campo="itinerario"', l.itinerario || '', 'largo')}</td>
        <td class="num">${campoDeEdicao('data-campo="pedagio" inputmode="decimal"', valorNoCampo(l.pedagio))}</td>
        <td class="num">${campoDeEdicao('data-campo="estacionamento" inputmode="decimal"', valorNoCampo(l.estacionamento))}</td>
        ${comCombustivel ? `<td class="num">${campoDeEdicao('data-campo="combustivel" inputmode="decimal"', valorNoCampo(l.combustivel))}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>` : '<p class="sub">Sem lançamentos dia a dia.</p>'}

    <div class="linha-botoes" style="margin-top:16px">
      <button id="salvar-edicao">Salvar alterações</button>
      <button class="secundario" id="cancelar-edicao">Cancelar</button>
    </div>`;
}

// Liga as contas e os botoes do formulario. `aoSalvar` roda depois de gravar.
function ligarEdicao(alvo, d, { aoSalvar, aoCancelar }) {
  const campoDoValor = (campo) => alvo.querySelector(`[data-valor="${campo}"]`);
  const mudou = (el) => el.value.trim() !== el.dataset.original.trim();
  const numeroDe = (linha, campo) => lerNumeroBr(linha.querySelector(`[data-campo="${campo}"]`)?.value);

  const refazerTotal = () => {
    const soma = ['valor_km', 'pedagio_declarado', 'estac_declarado', 'hotel_declarado', 'outros_declarado']
      .reduce((s, c) => s + lerNumeroBr(campoDoValor(c).value), 0);
    alvo.querySelector('#e-total').value = brl(soma);
  };

  // Mexeu num dia: os totais acompanham, pela mesma conta do portal. Quem
  // quiser um total diferente da soma dos dias digita por cima depois.
  const refazerPelosDias = () => {
    const linhas = [...alvo.querySelectorAll('[data-linha]')];
    const km = linhas.reduce(
      (s, l) => s + Math.max(0, numeroDe(l, 'km_final') - numeroDe(l, 'km_inicial')), 0);
    const combustivel = linhas.reduce((s, l) => s + numeroDe(l, 'combustivel'), 0);
    const pedagio = linhas.reduce((s, l) => s + numeroDe(l, 'pedagio'), 0);
    const estac = linhas.reduce((s, l) => s + numeroDe(l, 'estacionamento'), 0);
    campoDoValor('total_km').value = noCampo(km || '');
    campoDoValor('valor_km').value = valorNoCampo(d.gerente ? combustivel : km * Number(d.valor_do_km || 0));
    // Formulario sem pedagio por dia traz so o total do quadro: ai nao mexe.
    if (pedagio + estac > 0) {
      campoDoValor('pedagio_declarado').value = valorNoCampo(pedagio);
      campoDoValor('estac_declarado').value = valorNoCampo(estac);
    }
  };

  alvo.addEventListener('input', (ev) => {
    if (ev.target.closest('[data-linha]') && ev.target.dataset.campo !== 'itinerario') refazerPelosDias();
    refazerTotal();
  });
  refazerTotal();

  alvo.querySelector('#cancelar-edicao').addEventListener('click', aoCancelar);

  alvo.querySelector('#salvar-edicao').addEventListener('click', async (ev) => {
    const valores = {};
    for (const [campo] of VALORES_EDITAVEIS) {
      const el = campoDoValor(campo);
      if (!mudou(el)) continue;
      // Comprovado em branco e "apagar", nao zero.
      valores[campo] = campo === 'pedagio_comprovado' && !el.value.trim() ? '' : lerNumeroBr(el.value);
    }

    const linhas = [...alvo.querySelectorAll('[data-linha]')]
      .filter((l) => [...l.querySelectorAll('input')].some(mudou))
      .map((l) => ({
        id: Number(l.dataset.linha),
        ...Object.fromEntries(CAMPOS_DA_LINHA.map((c) => {
          const el = l.querySelector(`[data-campo="${c}"]`);
          if (c === 'itinerario') return [c, el.value];
          // Coluna que a tabela nao mostra (combustivel) fica como estava.
          return [c, el ? lerNumeroBr(el.value) : Number(d.linhas.find((x) => x.id === Number(l.dataset.linha))?.[c] || 0)];
        })),
      }));

    const anexos = [...alvo.querySelectorAll('[data-anexo]')]
      .map((l) => {
        const item = { id: Number(l.dataset.anexo) };
        for (const el of l.querySelectorAll('input')) {
          if (mudou(el)) item[el.dataset.campo] = el.value.trim() ? lerNumeroBr(el.value) : '';
        }
        return item;
      })
      .filter((a) => Object.keys(a).length > 1);

    if (!Object.keys(valores).length && !linhas.length && !anexos.length) {
      return mostrarRecado('recado-edicao', 'Nada foi alterado.', 'info');
    }

    ev.target.disabled = true;
    try {
      await api('/api/admin/relatorio-editar', {
        metodo: 'POST',
        corpo: { relatorio_id: d.relatorio.id, valores, linhas, anexos },
      });
      await aoSalvar();
    } catch (e) {
      ev.target.disabled = false;
      mostrarRecado('recado-edicao', e.message, 'erro');
    }
  });
}

function blocoParecer(p) {
  const ia = p.parecer_ia;
  if (!ia) return '';
  const ignorados = ia.itens_ignorados || [];
  return `
    <h2 style="margin-top:20px">${ia.por === 'codigo' ? 'Leitura dos comprovantes por código (sem IA)' : 'Leitura dos comprovantes pela IA'}</h2>
    ${
      ia.simulado
        ? `<div class="aviso erro"><strong>PARECER SIMULADO — modo demonstração.</strong><br>
           Nenhum comprovante foi aberto ou lido. Estes números são inventados e servem só
           para testar a tela. Não use para aprovar ou reprovar de verdade.</div>`
        : ''
    }
    <div class="aviso info">${escapar(ia.resumo || '')}</div>
    <div class="numeros" style="margin-bottom:12px">
      <div class="numero"><div class="rotulo">${ia.por === 'codigo' && ia.pedagio_comprovado == null ? 'Pedágio lido (não confirmado)' : 'Pedágio comprovado'}</div>
        <div class="valor">${brl(ia.pedagio_comprovado ?? ia.pedagio_lido)}</div></div>
      <div class="numero"><div class="rotulo">Nota de abastecimento</div>
        <div class="valor" style="font-size:16px; color:${
          ia.tem_danfe_de_abastecimento ? 'var(--verde)' : 'var(--vermelho)'
        }">${ia.tem_danfe_de_abastecimento ? (ia.por === 'codigo' ? 'Confirmada' : 'Enviada') : (ia.por === 'codigo' ? 'Não confirmada' : 'Não enviada')}</div></div>
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
    }
    ${
      (ia.passagens_fora || []).length
        ? `<p class="sub"><strong>Passagens do extrato fora da soma:</strong> ${ia.passagens_fora
            .map((p) => `${escapar(dataCurta(p.data))} ${escapar(p.local || '')} ${brl(Number(p.valor || 0))} — ${escapar(p.motivo || '')}`)
            .join('; ')}</p>`
        : ''
    }`;
}

// AAAA-MM-DD -> DD/MM. Texto vindo do modelo: se nao tiver o formato, sai como veio.
function dataCurta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}` : String(iso || '');
}

// ---------------------------------------------------------------- usuarios

// ------------------------------------------------------- valores pagos
//
// Quanto cada colaborador recebeu num mes de antes do portal (agosto). Serve
// de mes anterior para a regra do aumento. Uma linha por pessoa, salvando ao
// sair do campo - com 160 pessoas, um botao "salvar" por linha seria clique
// demais, e um "salvar tudo" perderia tudo se a sessao caisse no meio.


async function carregarValoresPagos() {
  try {
    const d = await api(`/api/admin/valores-pagos?mes=${encodeURIComponent($('vp-mes').value)}`);
    valoresPagos = d.colaboradores;
    desenharValoresPagos();
  } catch (e) {
    mostrarRecado('recado-valores', e.message, 'erro');
  }
}

function desenharValoresPagos() {
  const busca = String($('vp-busca').value || '').trim().toLowerCase();
  const empresa = $('vp-empresa').value;
  const soVazios = $('vp-so-vazios').checked;

  const lista = valoresPagos.filter((u) =>
    (!busca || u.nome.toLowerCase().includes(busca) || u.login.includes(busca))
    && (!empresa || u.empresa === empresa)
    && (!soVazios || u.valor == null));

  const informados = valoresPagos.filter((u) => u.valor != null).length;
  $('vp-contagem').textContent = `${informados} de ${valoresPagos.length} informados`;

  $('vp-lista').innerHTML = lista.length
    ? lista.map((u) => `
      <tr>
        <td>${escapar(u.nome)}<br><span class="sub" style="font-size:12.5px">${escapar(u.login)}</span></td>
        <td><span class="emp ${escapar(u.empresa)}">${escapar(u.cracha)}</span></td>
        <td class="num">
          <input type="text" inputmode="decimal" autocomplete="off" placeholder="0,00"
                 data-valor-pago="${u.id}" value="${u.valor != null ? valorNoCampo(u.valor) || '0,00' : ''}"
                 style="max-width:140px; margin:0; text-align:right">
        </td>
        <td class="sub" data-vp-estado="${u.id}" style="white-space:nowrap">${u.valor != null ? 'salvo' : ''}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="sub">Ninguém nesta lista.</td></tr>';

  for (const campo of $('vp-lista').querySelectorAll('[data-valor-pago]')) {
    campo.addEventListener('change', () => salvarValorPago(campo));
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') campo.blur();
    });
  }
}

async function salvarValorPago(campo) {
  const id = Number(campo.dataset.valorPago);
  const estado = $('vp-lista').querySelector(`[data-vp-estado="${id}"]`);
  const bruto = campo.value.trim();
  const valor = bruto === '' ? null : lerNumeroBr(bruto, NaN);
  if (valor !== null && (!Number.isFinite(valor) || valor < 0)) {
    estado.textContent = 'valor inválido';
    estado.style.color = 'var(--vermelho)';
    return;
  }
  estado.textContent = 'salvando...';
  estado.style.color = '';
  try {
    const r = await api('/api/admin/valor-pago', {
      metodo: 'POST',
      corpo: { usuario_id: id, mes: $('vp-mes').value, valor },
    });
    const u = valoresPagos.find((x) => x.id === id);
    if (u) u.valor = r.valor;
    campo.value = r.valor != null ? valorNoCampo(r.valor) || '0,00' : '';
    estado.textContent = r.valor != null ? 'salvo' : 'apagado';
    estado.style.color = 'var(--verde)';
    const informados = valoresPagos.filter((x) => x.valor != null).length;
    $('vp-contagem').textContent = `${informados} de ${valoresPagos.length} informados`;
  } catch (e) {
    estado.textContent = e.message;
    estado.style.color = 'var(--vermelho)';
  }
}

$('vp-mes').addEventListener('change', carregarValoresPagos);
$('vp-busca').addEventListener('input', desenharValoresPagos);
$('vp-empresa').addEventListener('change', desenharValoresPagos);
$('vp-so-vazios').addEventListener('change', desenharValoresPagos);

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
  ligarMenus($('lista-usuarios'));
}

// ------------------------------------------------------ menu de tres pontos

// Um menu aberto por vez. Guardar qual esta aberto e mais simples do que varrer
// a tela procurando menu aberto toda vez que alguem clica em algum lugar.
let menuAberto = null;
let menusLigados = false;

function fecharMenu(devolverFoco = false) {
  if (!menuAberto) return;
  const { botao, lista } = menuAberto;
  lista.hidden = true;
  botao.setAttribute('aria-expanded', 'false');
  menuAberto = null;
  if (devolverFoco) botao.focus();
}

function abrirMenu(botao, lista) {
  fecharMenu();
  lista.hidden = false;
  botao.setAttribute('aria-expanded', 'true');
  menuAberto = { botao, lista };
}

function ligarMenus(raiz) {
  if (!raiz) return;

  for (const botao of raiz.querySelectorAll('.menu-botao')) {
    const lista = botao.nextElementSibling;
    if (!lista) continue;

    botao.addEventListener('click', (ev) => {
      // Sem isto o clique sobe ate o document e fecha o menu que acabou de abrir.
      ev.stopPropagation();
      if (menuAberto && menuAberto.botao === botao) fecharMenu();
      else abrirMenu(botao, lista);
    });

    botao.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown') return;
      ev.preventDefault();
      abrirMenu(botao, lista);
      lista.querySelector('[role=menuitem]')?.focus();
    });

    // Escolheu uma acao: o menu sai da frente e deixa ver o que aconteceu.
    lista.addEventListener('click', () => fecharMenu());

    lista.addEventListener('keydown', (ev) => {
      const itens = [...lista.querySelectorAll('[role=menuitem]')];
      if (!itens.length) return;
      const atual = itens.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        itens[(atual + 1) % itens.length].focus();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        itens[(atual - 1 + itens.length) % itens.length].focus();
      }
    });
  }

  // Clique fora e Esc valem para a tela inteira, entao sao ligados uma vez so -
  // a lista e redesenhada a cada mudanca e empilharia um ouvinte por redesenho.
  if (menusLigados) return;
  menusLigados = true;
  document.addEventListener('click', () => fecharMenu());
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') fecharMenu(true);
  });
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

// Continua com o nome antigo porque o resto do arquivo chama por ele, mas hoje
// desenha uma lista de cartoes, nao uma tabela: com 8 colunas a tabela so cabia
// rolando de lado, e as acoes ocupavam mais espaco que a propria pessoa.
function tabelaDeUsuarios(lista) {
  return `<div class="pessoas">${lista.map(linhaUsuario).join('')}</div>`;
}

// Duas letras bastam para diferenciar as pessoas na lista.
function iniciaisDoNome(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  const primeira = partes[0][0] || '';
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
  return (primeira + ultima).toUpperCase();
}

function linhaUsuario(u) {
  const ehAdmin = u.papel === 'admin';
  const empresa = escapar(u.empresa || 'DISO');
  const nome = escapar(u.nome);
  const placa = placaParaTela(u.placas);

  // A linha de baixo junta o que identifica a pessoa sem competir com o nome.
  const secundaria = [escapar(u.login), placa ? escapar(placa) : '', `${u.anexos} arquivo(s)`]
    .filter(Boolean)
    .join(' · ');

  const soColaborador =
    u.papel === 'colaborador'
      ? `<button role="menuitem" data-galeria="${u.id}">Galeria</button>
         <button role="menuitem" data-historico="${u.id}"
                 title="Planilha com todos os meses deste colaborador">Histórico</button>
         <button role="menuitem" data-pacote="${u.id}"
                 title="Baixa uma pasta com tudo deste colaborador">Baixar pasta</button>
         <button role="menuitem" data-imprimir="${u.id}"
                 title="PDF único com RDV, nota de abastecimento e pedágio do mês, pronto para imprimir">Imprimir mês</button>
         <div class="menu-risco" role="separator"></div>`
      : '';

  // Desativado fica MARCADO, nao apagado: com 42 pessoas desativadas, esmaecer
  // a linha fazia parecer que elas nao estavam na tela.
  return `
  <div class="pessoa de-${empresa}${u.ativo ? '' : ' inativo'}">
    <span class="avatar ${empresa}" aria-hidden="true">${escapar(iniciaisDoNome(u.nome))}</span>

    <div class="pessoa-id">
      <div class="pessoa-nome">
        ${nome}${ehAdmin ? ' <span class="selo RASCUNHO">admin</span>' : ''}
      </div>
      <div class="pessoa-sub">
        <span class="emp ${empresa}">${escapar(u.cracha || '')}</span>
        ${secundaria}
      </div>
    </div>

    <div class="pessoa-meta">
      <select data-empresa="${u.id}" aria-label="Empresa de ${nome}">
        ${EMPRESAS.map(
          (e) => `<option value="${e}"${u.empresa === e ? ' selected' : ''}>${e}</option>`,
        ).join('')}
      </select>
      ${
        // Administrativo nao manda RDV: carro nao se aplica.
        ehAdministrativo(u.funcao)
          ? ''
          : `<select data-carro="${u.id}" aria-label="Carro de ${nome}" title="Carro pessoal: foto do odômetro obrigatória">
        <option value="pessoal"${u.carro !== 'empresa' ? ' selected' : ''}>Carro pessoal</option>
        <option value="empresa"${u.carro === 'empresa' ? ' selected' : ''}>Carro da empresa</option>
      </select>`
      }
      <select data-funcao="${u.id}" aria-label="Função de ${nome}">
        ${FUNCOES.filter((f) => f !== 'Coordenador' || possoDarCoordenador || u.funcao === f)
          .map((f) => `<option value="${f}"${u.funcao === f ? ' selected' : ''}>${f}</option>`)
          .join('')}
      </select>
      ${
        u.ativo
          ? '<span class="selo CERTA">Ativo</span>'
          : '<span class="selo ERRADA">Desativado</span>'
      }
    </div>

    <div class="menu">
      <button type="button" class="menu-botao" aria-label="Ações de ${nome}"
              aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>
        </svg>
      </button>
      <div class="menu-lista" role="menu" hidden>
        ${soColaborador}
        <button role="menuitem" data-nome="${u.id}"
                title="Corrige o nome que aparece no painel e nas planilhas.">Editar nome</button>
        <button role="menuitem" data-placa="${u.id}"
                title="Corrige a placa, ou apaga o que estiver errado no campo.">Editar placa</button>
        <button role="menuitem" data-login="${u.id}"
                title="Corrige o login de acesso. O cadastro e os relatórios continuam os mesmos.">Trocar login</button>
        <button role="menuitem" data-senha="${u.id}">Nova senha</button>
        <button role="menuitem" data-ativo="${u.id}" data-valor="${u.ativo ? 0 : 1}">
          ${u.ativo ? 'Desativar' : 'Reativar'}
        </button>
        <div class="menu-risco" role="separator"></div>
        <button role="menuitem" class="menu-perigo" data-excluir="${u.id}"
                title="Apaga o colaborador e tudo que ele enviou">Excluir</button>
      </div>
    </div>
  </div>`;
}

function ligarBotoesDeUsuario() {
  const raiz = $('lista-usuarios');

  const salvarCracha = async (elemento, campo) => {
    try {
      const r = await api('/api/admin/usuario-empresa', {
        metodo: 'POST',
        corpo: { usuario_id: Number(elemento.dataset[campo]), [campo]: elemento.value },
      });
      mostrarRecado(
        'recado-usuario',
        campo === 'carro'
          ? (r.carro === 'empresa' ? 'Agora com carro da empresa: a foto do odômetro deixa de ser cobrada.' : 'Agora com carro pessoal: a foto do odômetro volta a ser obrigatória.')
          : `Atualizado para ${r.cracha}.`,
        'ok',
      );
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
  for (const s of raiz.querySelectorAll('[data-carro]')) {
    s.addEventListener('change', () => salvarCracha(s, 'carro'));
  }
  for (const b of raiz.querySelectorAll('[data-galeria]')) {
    aoClicar(b, () => abrirGaleria(Number(b.dataset.galeria)), 'abrir a galeria');
  }
  for (const b of raiz.querySelectorAll('[data-pacote]')) {
    b.addEventListener('click', () => {
      baixar(`/api/admin/pacote?usuario_id=${b.dataset.pacote}`);
    });
  }
  for (const b of raiz.querySelectorAll('[data-imprimir]')) {
    b.addEventListener('click', () => {
      baixar(`/api/admin/impressao?mes=${mes}&usuario_id=${b.dataset.imprimir}`);
    });
  }
  for (const b of raiz.querySelectorAll('[data-historico]')) {
    b.addEventListener('click', () => {
      baixar(`/api/admin/historico?usuario_id=${b.dataset.historico}`);
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
    baixar(`/api/admin/pacote?usuario_id=${usuarioId}`);
  });
  for (const b of fundo.querySelectorAll('[data-baixar-mes]')) {
    b.addEventListener('click', () => {
      baixar(`/api/admin/pacote?usuario_id=${usuarioId}&mes=${b.dataset.baixarMes}`);
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
      ${grupo('Nota do hotel', m.hotel)}
      ${grupo('Outras despesas', m.outras_despesas)}
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

// Gerente e coordenador andam de carro da empresa: ja sugere. Da para trocar.
// Administrativo nao manda RDV, entao o campo nem aparece.
$('u-funcao')?.addEventListener('change', () => {
  const funcao = $('u-funcao').value;
  $('u-carro').value = ['Gerente', 'Coordenador'].includes(funcao) ? 'empresa' : 'pessoal';
  $('u-carro').parentElement.classList.toggle('esconde', ehAdministrativo(funcao));
});

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
    carro: $('u-carro').value,
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
    // Modelo gravado que nao esta na lista (escolhido a mao no banco) aparece
    // como opcao extra, para a tela nao mostrar um modelo que nao e o usado.
    const sel = $('c-modelo');
    if (![...sel.options].some((o) => o.value === c.modelo_ia)) {
      sel.add(new Option(`${c.modelo_ia} (atual)`, c.modelo_ia));
    }
    sel.value = c.modelo_ia;
    $('estado-chave').innerHTML = c.chave_por_ambiente
      ? `<div class="aviso ok">Usando a chave da variável de ambiente ANTHROPIC_API_KEY.</div>`
      : c.chave_api_resumo
        ? `<div class="aviso ok">Chave configurada: <code>${escapar(c.chave_api_resumo)}</code></div>`
        : `<div class="aviso atencao">Nenhuma chave configurada — a IA está desligada.</div>`;
  } catch (e) {
    mostrarRecado('recado-config', e.message, 'erro');
  }
  carregarResumoBackup();
  carregarArmazenamento();
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
  baixar('/api/admin/backup');
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

// ------------------------------------------------------------ armazenamento

// `function`, nao `const`: o aviso de espaco roda durante a inicializacao,
// antes de o modulo chegar aqui (ver o ATENCAO no topo).
function gb(b) {
  return `${(b / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}

function rotuloDoBloco(status) {
  return {
    GERANDO: 'baixando…',
    BAIXADO: 'no servidor e no seu PC',
    LIMPO: 'só no seu PC',
    DEVOLVIDO: 'devolvido ao servidor',
  }[status] || status;
}

// Faixa no topo para o dono: passou de 3 GB, e hora de baixar blocos.
async function avisoDeEspaco() {
  try {
    const d = await api('/api/admin/armazenamento');
    if (!d.passou_do_limite) return;
    $('aviso-espaco').innerHTML = `
      <div class="aviso atencao" style="margin-bottom:16px">
        <strong>O servidor está com ${gb(d.usado)} de ${gb(d.capacidade)}.</strong>
        Baixe os blocos dos relatórios aprovados e libere espaço antes de encher.
        <button class="secundario pequeno" id="ir-armazenamento" style="margin-left:8px">Abrir armazenamento</button>
      </div>`;
    $('ir-armazenamento').addEventListener('click', () => {
      document.querySelector('.abas button[data-aba="config"]')?.click();
      setTimeout(() => $('cartao-armazenamento')?.scrollIntoView({ behavior: 'smooth' }), 100);
    });
  } catch {
    // o aviso e extra; sem ele o resto da tela segue
  }
}

async function carregarArmazenamento() {
  const alvo = $('resumo-armazenamento');
  if (!alvo) return;
  try {
    const d = await api('/api/admin/armazenamento');
    const pct = Math.min(100, Math.round((d.usado / d.capacidade) * 100));
    const tom = d.passou_do_limite ? 'atencao' : 'ok';

    const empresas = d.empresas.length
      ? d.empresas
          .map(
            (e) => `
        <details style="margin-top:10px">
          <summary style="cursor:pointer">
            <strong>${escapar(e.empresa)}</strong> — ${e.anexos} arquivo(s), ${tamanhoBr(e.bytes)}
            <button class="pequeno" data-bloco-empresa="${escapar(e.empresa)}" style="margin-left:8px">Baixar bloco da empresa</button>
          </summary>
          ${e.pessoas
            .map(
              (p) => `<div class="anexo">
                <span class="nome">${escapar(p.nome)}</span>
                <span class="peso">${p.anexos} arquivo(s) · ${tamanhoBr(p.bytes)}</span>
                <button class="secundario pequeno" data-bloco-pessoa="${p.usuario_id}">Baixar bloco</button>
              </div>`,
            )
            .join('')}
        </details>`,
          )
          .join('')
      : '<p class="sub">Nenhum comprovante de relatório aprovado ainda no servidor.</p>';

    const blocos = d.blocos.length
      ? `<h3 style="margin-top:20px">Blocos baixados</h3>
         ${d.blocos
           .map(
             (b) => `<div class="anexo">
               <span class="peso">Bloco ${b.id}</span>
               <span class="nome">${escapar(b.rotulo)} — ${b.anexos} arquivo(s), ${tamanhoBr(b.bytes)}
                 <br><span class="sub">${dataHoraBr(b.criado_em)} · ${rotuloDoBloco(b.status)}</span></span>
               ${
                 b.status === 'BAIXADO' || b.status === 'DEVOLVIDO'
                   ? `<button class="pequeno" data-liberar="${b.id}">Liberar espaço</button>`
                   : ''
               }
             </div>`,
           )
           .join('')}`
      : '';

    alvo.innerHTML = `
      <div class="aviso ${tom}">
        Em uso: <strong>${gb(d.usado)}</strong> de ${gb(d.capacidade)} (${pct}%).
        ${d.passou_do_limite ? 'Passou do limite de aviso — hora de liberar espaço.' : `O aviso dispara em ${gb(d.limite)}.`}
      </div>
      ${empresas}
      ${blocos}`;
  } catch (e) {
    alvo.innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

// Um bloco pode ter GBs: vai por download direto do navegador, nao pelo
// fetch() dos outros downloads, que seguraria o arquivo inteiro na memoria.
function baixarBloco(parametros) {
  const a = document.createElement('a');
  a.href = `/api/admin/bloco?${new URLSearchParams(parametros)}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  mostrarRecado(
    'recado-armazenamento',
    'O download começou. Quando terminar, guarde o arquivo no computador e clique em "Liberar espaço" no bloco abaixo.',
    'info',
  );
  // O bloco entra na lista quando o servidor termina de gerar.
  setTimeout(carregarArmazenamento, 4000);
}

let liberandoBloco = null;

$('resumo-armazenamento')?.addEventListener('click', (ev) => {
  const empresa = ev.target.closest('[data-bloco-empresa]');
  const pessoa = ev.target.closest('[data-bloco-pessoa]');
  const liberar = ev.target.closest('[data-liberar]');
  if (empresa) {
    ev.preventDefault(); // o botao mora dentro do <summary>
    baixarBloco({ empresa: empresa.dataset.blocoEmpresa });
  } else if (pessoa) {
    baixarBloco({ usuario_id: pessoa.dataset.blocoPessoa });
  } else if (liberar) {
    liberandoBloco = Number(liberar.dataset.liberar);
    $('arquivo-liberar').value = '';
    $('arquivo-liberar').click();
  }
});

// So o tamanho do arquivo sai daqui. E a prova de que o zip inteiro esta no PC
// antes de o servidor apagar alguma coisa.
$('arquivo-liberar')?.addEventListener('change', async () => {
  const arquivo = $('arquivo-liberar').files?.[0];
  if (!arquivo || !liberandoBloco) return;
  if (!confirm(
    `Tirar do servidor os arquivos do bloco ${liberandoBloco}?\n\n`
      + `Confira que "${arquivo.name}" está guardado num lugar seguro: depois disso, `
      + 'a única cópia desses comprovantes é esse arquivo.',
  )) return;
  try {
    const r = await api('/api/admin/bloco-liberar', {
      metodo: 'POST',
      corpo: { id: liberandoBloco, tamanho: arquivo.size },
    });
    mostrarRecado(
      'recado-armazenamento',
      `Pronto: ${r.apagados} arquivo(s) saíram do servidor (${tamanhoBr(r.bytes)} liberados).`
        + (r.pulados ? ` ${r.pulados} ficaram porque o relatório não está mais aprovado.` : ''),
      'ok',
    );
    carregarArmazenamento();
    carregarResumoBackup();
  } catch (e) {
    mostrarRecado('recado-armazenamento', e.message, 'erro');
  }
});

$('botao-devolver')?.addEventListener('click', async () => {
  const arquivo = $('arquivo-devolver').files?.[0];
  if (!arquivo) {
    return mostrarRecado('recado-armazenamento', 'Escolha primeiro o arquivo .zip do bloco.', 'atencao');
  }
  mostrarRecado('recado-armazenamento', 'Enviando o bloco... não feche esta página.', 'info');
  try {
    const r = await fetch('/api/admin/bloco-devolver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: arquivo,
      credentials: 'same-origin',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Falha ao devolver o bloco.');
    mostrarRecado(
      'recado-armazenamento',
      `Bloco ${d.bloco}: ${d.voltaram} arquivo(s) voltaram para o portal.`
        + (d.ja_estavam ? ` ${d.ja_estavam} já estavam no servidor.` : '')
        + (d.sem_registro ? ` ${d.sem_registro} não voltaram porque o anexo foi excluído do portal.` : ''),
      'ok',
    );
    $('arquivo-devolver').value = '';
    carregarArmazenamento();
    carregarResumoBackup();
  } catch (e) {
    mostrarRecado('recado-armazenamento', e.message, 'erro');
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

async function salvarModelo() {
  const sel = $('c-modelo');
  try {
    await api('/api/admin/config', { metodo: 'POST', corpo: { modelo_ia: sel.value } });
    mostrarRecado('recado-config', `Modelo trocado: ${sel.selectedOptions[0].textContent.split(' —')[0]}.`, 'ok');
  } catch (e) {
    mostrarRecado('recado-config', e.message, 'erro');
    carregarConfig();
  }
}

async function limparChave() {
  if (!confirm('Remover a chave? A conferência com IA deixa de funcionar.')) return;
  await api('/api/admin/config', { metodo: 'POST', corpo: { limpar_chave: true } });
  mostrarRecado('recado-config', 'Chave removida.', 'info');
  carregarConfig();
  carregarPainel();
}

// ------------------------------------------------------------------- tudo
//
// O retrato inteiro do portal numa tela so, para quem ve tudo: dinheiro por
// mes e por empresa, quem ainda nao enviou, a fila, o gasto com a IA, o que
// quebrou hoje e como esta o disco. Antes cada uma dessas respostas morava num
// lugar diferente - algumas so no painel da Railway.

async function carregarTudo() {
  const alvo = $('tudo');
  try {
    const t = await api('/api/admin/tudo');
    alvo.innerHTML = desenharTudo(t);
  } catch (e) {
    alvo.innerHTML = `<div class="aviso erro">${escapar(e.message)}</div>`;
  }
}

function desenharTudo(t) {
  const s = t.saude || {};
  const ia = t.ia || {};
  const d = t.dados || {};
  const fila = t.fila || {};

  const problemas = (s.problemas || []).length
    ? `<div class="aviso erro"><strong>Atenção:</strong> ${s.problemas.map(escapar).join(' · ')}</div>`
    : '';

  const naFila = fila.rodando
    ? `<div class="aviso info"><strong>Conferência em andamento:</strong> ${fila.feitos} de ${fila.total}${
        fila.atual ? ` — agora: ${escapar(fila.atual)}` : ''
      }</div>`
    : '';

  const linhaMes = (m) => `<tr>
    <td>${escapar(mesPorExtensoCurto(m.mes_ref))}</td>
    <td class="num">${m.total}</td>
    <td class="num" style="color:var(--verde)">${m.certas || 0}</td>
    <td class="num" style="color:var(--amarelo)">${m.so_danfe || 0}</td>
    <td class="num" style="color:var(--vermelho)">${m.erradas || 0}</td>
    <td class="num">${m.pendentes || 0}</td>
    <td class="num">${numeroBr(m.km || 0)}</td>
    <td class="num"><strong>${brl(m.dinheiro || 0)}</strong></td>
  </tr>`;

  const linhaEmpresa = (e) => `<tr>
    <td><span class="emp ${escapar(e.empresa || 'DISO')}">${escapar(e.empresa || '—')}</span></td>
    <td class="num">${e.ativos || 0} de ${e.pessoas || 0}</td>
    <td class="num">${e.relatorios || 0}</td>
    <td class="num"><strong>${brl(e.dinheiro || 0)}</strong></td>
  </tr>`;

  const evento = (l) => `<tr>
    <td style="white-space:nowrap">${escapar(l.hora)}</td>
    <td><span class="selo ${l.nivel === 'ERRO' ? 'ERRADA' : l.nivel === 'AVISO' ? 'SO_FALTA_DANFE' : 'ENVIADO'}">${escapar(l.area)}</span></td>
    <td>${escapar(l.mensagem)} <span class="sub" style="margin:0">${escapar(l.dados || '')}</span></td>
  </tr>`;

  const semEnviar = t.sem_enviar || [];

  return `
    ${problemas}${naFila}

    <div class="cartao">
      <h2>O portal agora</h2>
      <div class="numeros">
        <div class="numero"><div class="rotulo">No ar há</div><div class="valor">${duracaoBr(s.no_ar_ha)}</div></div>
        <div class="numero"><div class="rotulo">Regras em uso</div><div class="valor">versão ${t.versao_regras}</div></div>
        <div class="numero"><div class="rotulo">Conferidos com regra antiga</div><div class="valor">${t.conferidos_com_regra_antiga || 0}</div></div>
        <div class="numero"><div class="rotulo">Chave da IA</div><div class="valor" style="color:${ia.disponivel ? 'var(--verde)' : 'var(--vermelho)'}">${ia.disponivel ? 'ligada' : 'desligada'}</div></div>
        <div class="numero"><div class="rotulo">Conferências com IA</div><div class="valor">${ia.chamadas || 0}${ia.falhas ? ` <span style="font-size:14px;color:var(--vermelho)">${ia.falhas} falha(s)</span>` : ''}</div></div>
        <div class="numero"><div class="rotulo">Tokens usados (entrada/saída)</div><div class="valor" style="font-size:20px">${numeroBr(ia.entrada || 0)} / ${numeroBr(ia.saida || 0)}</div></div>
        <div class="numero"><div class="rotulo">Comprovantes guardados</div><div class="valor">${numeroBr(d.anexos || 0)}</div></div>
        <div class="numero"><div class="rotulo">Espaço dos comprovantes</div><div class="valor" style="font-size:20px">${tamanhoBr(d.tamanho_anexos || 0)}</div></div>
      </div>
      <p class="sub" style="margin:14px 0 0">Os números da IA contam desde a última vez que o portal subiu.</p>
    </div>

    <div class="cartao">
      <h2>Mês a mês</h2>
      <div class="rolagem"><table>
        <thead><tr><th>Mês</th><th class="num">Relatórios</th><th class="num">Certos</th>
          <th class="num">Só DANFE</th><th class="num">Errados</th><th class="num">Pendentes</th>
          <th class="num">Km</th><th class="num">Total</th></tr></thead>
        <tbody>${(t.meses || []).map(linhaMes).join('') || '<tr><td colspan="8">Nenhum relatório ainda.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="cartao">
      <h2>Por empresa</h2>
      <div class="rolagem"><table>
        <thead><tr><th>Empresa</th><th class="num">Pessoas ativas</th><th class="num">Relatórios</th><th class="num">Total</th></tr></thead>
        <tbody>${(t.por_empresa || []).map(linhaEmpresa).join('')}</tbody>
      </table></div>
    </div>

    <div class="cartao">
      <h2>Ainda não enviaram — ${escapar(mesPorExtensoCurto(t.mes_atual))} (${semEnviar.length})</h2>
      ${
        semEnviar.length
          ? `<div class="pessoas">${semEnviar.slice(0, 40)
              .map(
                (u) => `<div class="pessoa"><div class="pessoa-id">
                  <div class="pessoa-nome">${escapar(u.nome)} <span class="emp ${escapar(u.empresa || 'DISO')}">${escapar(u.empresa || '')}</span></div>
                  <div class="pessoa-sub">${escapar(u.login)} · ${escapar(u.funcao || '')}</div>
                </div></div>`,
              )
              .join('')}</div>${semEnviar.length > 40 ? `<p class="sub" style="margin:10px 0 0">e mais ${semEnviar.length - 40} pessoa(s). A lista completa sai na planilha do mes.</p>` : ''}`
          : '<p class="sub" style="margin:0">Todo mundo já enviou.</p>'
      }
    </div>

    <div class="cartao">
      <h2>O que quebrou (${(t.erros || []).length})</h2>
      ${
        (t.erros || []).length
          ? `<div class="rolagem"><table><tbody>${t.erros.map(evento).join('')}</tbody></table></div>`
          : '<p class="sub" style="margin:0">Nenhum erro desde que o portal subiu.</p>'
      }
    </div>

    <div class="cartao">
      <h2>Últimos acontecimentos</h2>
      <div class="rolagem"><table><tbody>${(t.eventos || []).map(evento).join('')}</tbody></table></div>
    </div>`;
}

// 'AAAA-MM' -> 'agosto de 2026'. Sem depender do servidor: esta tela ja traz
// muita coisa, e o mes por extenso e barato de montar aqui.
function mesPorExtensoCurto(mesRef) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesRef || ''));
  if (!m) return String(mesRef || '—');
  const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${nomes[Number(m[2]) - 1]} de ${m[1]}`;
}

/** Segundos -> "3 h 20 min", que e como a pessoa pensa em tempo no ar. */
function duracaoBr(segundos) {
  const s = Number(segundos);
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  if (!h) return `${min} min`;
  return `${h} h ${min} min`;
}
