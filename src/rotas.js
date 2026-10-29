// Todas as rotas /api do Portal RDV.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  db, agora, valorDoKm, lerConfig, gravarConfig, PASTA_ANEXOS,
  EMPRESAS, FUNCOES, cracha, empresaDaFuncao, podeDarFuncao, CARROS, carroPadrao,
  PAPEIS, ehSuper, ehAdmin, escopoDe, podeMexerNoUsuario, podeVerUsuario, filtroSql,
} from './banco.js';
import {
  autenticar,
  abrirSessao,
  fecharSessao,
  trocarSenha,
  criarUsuario,
  cookieDeSessao,
  cookieDeSaida,
} from './auth.js';
import { checarSaude } from './saude.js';
import { chavePublica, inscrever, desinscrever, enviar as enviarNotificacao } from './notificacoes.js';
import {
  conferir,
  diferencaDePedagio as achadoDeDiferenca,
  passagensSemExplicacao,
  achadoDaIaSobrePedagio,
  gravidadeDoAchadoDaIa,
  ehGerente,
  pagoPorCombustivel,
  cobraFotoOdometro,
  dataValida,
  VERSAO_REGRAS,
} from './conferencia.js';
import { conferirComIa, iaDisponivel, textoDosIgnorados } from './ia.js';
import { conferirEmDemo } from './ia-demo.js';
import { conferirPorCodigo } from './leitura-comprovantes.js';
import { gerarPlanilha, gerarHistorico } from './planilha.js';
import { enviarBackup, restaurarBackup, resumoDosDados, bancoFechadoPelaRestauracao } from './backup.js';
import { montarImpressao } from './impressao.js';
import { resumoDoArmazenamento, enviarBloco, liberarBloco, devolverBloco } from './arquivamento.js';
import { extrairDoRdv, motivoDeNaoConseguirLer } from './extrair.js';
import { subtotalDoRdv } from './leitura-rdv.js';
import * as log from './log.js';
import { verificarAssinatura, achadosDaAssinatura } from './assinatura.js';
import { assinaturaNoPdf, assinaturaNoEscaneado, rdvEstaAssinado } from './caixa-assinatura.js';
import { paginasDoPdfComoImagem } from './ocr.js';
import { assinaturaSobrePlaca } from './placa.js';
import { galeriaDe, enviarPacote } from './galeria.js';
import { comecarFila, estadoDaFila, pedirParada, naVezDaIa } from './fila.js';
import { nomeDoFeriado, fimDeSemana, diaDaSemana } from './feriados.js';
import { REGRAS, checar, registrar, limpar, recadoDeEspera } from './limite.js';
import {
  responderJson,
  erro,
  ipDoPedido,
  lerJson,
  lerCorpo,
  numero,
  mesValido,
  mesAtual,
  diasDoMes,
  mesPorExtenso,
  nomeDeArquivoSeguro,
  ROTULO_STATUS, listaDeJson, textoDaIa, placaLimpa, odometroInteiro,
} from './util.js';

const TIPOS_DE_ANEXO = new Set([
  'rdv', 'pedagio', 'danfe', 'odometro', 'hotel', 'outras_despesas', 'outro',
]);
// Mexer no RDV e enviar. Depois que o relatorio sai da mao da pessoa, so volta
// a abrir se a conferencia REPROVAR - e ai ela corrige o que foi apontado.
//
// "So falta DANFE" ficou de fora de proposito: nesse estado o RDV ja foi aceito
// e o que falta e um documento. Deixar reabrir aqui permitia reescrever
// quilometragem e itinerario de um relatorio ja conferido, escondido atras de
// "vou anexar a nota".
const EDITAVEL = new Set(['RASCUNHO', 'ERRADA']);

// Receber anexo e mais largo que editar: em "So falta DANFE" a pessoa precisa
// conseguir mandar a nota que faltou, sem poder tocar no resto.
//
// ENVIADO entrou aqui depois. Quem acabou de mandar e percebe que anexou o
// extrato errado ficava de maos atadas: tinha que esperar ser REPROVADO para
// so entao poder trocar o arquivo. Um ciclo inteiro de conferencia - e uma
// reprovacao no historico da pessoa - por causa de um anexo trocado.
//
// CONFERINDO fica de fora: a IA esta lendo os arquivos naquele instante, e
// trocar no meio produz parecer sobre arquivo que ja nao existe.
//
// CERTA fica de fora: aprovado e aprovado. Deixar trocar comprovante depois da
// aprovacao desmancha justamente o que foi aprovado.
const ACEITA_ANEXO = new Set([...EDITAVEL, 'SO_FALTA_DANFE', 'ENVIADO']);

// E, nesse estado, so a nota de abastecimento entra - nao vale trocar o proprio
// RDV nem as fotos do odometro por baixo dos panos.
const ANEXO_SO_FALTA_DANFE = new Set(['danfe']);

// Formatos de planilha, recusados no anexo do RDV - ver subirAnexo.
const PLANILHA = new Set(['.xlsx', '.xlsm', '.xls', '.csv']);

// ---------------------------------------------------------------- despachante

export async function tratarApi(req, res, url, usuario, seguro) {
  const rota = url.pathname;
  const metodo = req.method;

  // --- rotas abertas ---
  // Sem sessao de proposito: e o monitor externo que bate aqui, e ele nao tem
  // como fazer login. Devolve 503 quando ha problema, porque monitor entende
  // codigo HTTP - um 200 dizendo "ok:false" no corpo nao dispara alerta nenhum.
  if (rota === '/api/saude' && metodo === 'GET') {
    const s = checarSaude();
    if (!s.ok) log.falha('saude', 'portal com problema', null, { problemas: s.problemas.join('; ') });
    return responderJson(res, s, s.ok ? 200 : 503);
  }

  // Teto geral por IP.
  //
  // Largo de proposito: doze pessoas com o painel do admin se atualizando de
  // minuto em minuto ficam muito abaixo de 300 por minuto. Isto e contra
  // varredura automatica, nao contra gente trabalhando.
  //
  // Fica DEPOIS do /api/saude porque quem bate la e o monitor externo. Limitar
  // ele viraria alarme falso justo quando o portal esta bem - e o alarme so
  // serve enquanto ninguem aprendeu a ignora-lo.
  // Quem ja entrou conta por PESSOA; so quem nao entrou conta por endereco.
  //
  // O escritorio inteiro sai por um IP so. Com 15 pessoas o teto por endereco
  // nunca apertava; no teste de carga com 100+ ele travou todo mundo junto -
  // "Muitas tentativas" para quem nao tentou nada. Contar por pessoa devolve o
  // teto ao proposito dele (conter varredura automatica) sem punir o colega da
  // mesa ao lado. Para quem ainda nao entrou, o IP segue sendo o unico
  // identificador que existe.
  const ip = ipDoPedido(req);
  const regraDoTeto = usuario ? REGRAS.GERAL : REGRAS.ANONIMO;
  const chaveDoTeto = usuario ? `u${usuario.id}` : `ip${ip}`;
  const teto = checar(regraDoTeto, chaveDoTeto);
  if (!teto.ok) {
    log.aviso('limite', 'teto geral', { quem: usuario?.login, ip, esperar: teto.esperarSegundos });
    return erro(res, recadoDeEspera(teto.esperarSegundos), 429, {
      'Retry-After': String(teto.esperarSegundos),
    });
  }
  registrar(regraDoTeto, chaveDoTeto);

  if (rota === '/api/entrar' && metodo === 'POST') return entrar(req, res, seguro);
  if (rota === '/api/sair' && metodo === 'POST') return sair(req, res);

  // --- daqui pra baixo precisa estar logado ---
  if (!usuario) return erro(res, 'Sessao expirada. Entre de novo.', 401);

  if (rota === '/api/eu' && metodo === 'GET') return eu(res, usuario);
  if (rota === '/api/trocar-senha' && metodo === 'POST') return trocarMinhaSenha(req, res, usuario);
  if (rota === '/api/push/chave' && metodo === 'GET') return responderJson(res, { chave: chavePublica() });
  if (rota === '/api/push/inscrever' && metodo === 'POST') return inscreverAparelho(req, res, usuario);
  if (rota === '/api/push/sair' && metodo === 'POST') return desinscreverAparelho(req, res, usuario);

  // Admin lancando pelo colaborador: `?em_nome_de=<id>` faz o relatorio e os
  // anexos cairem na conta dele, como se ele mesmo tivesse mandado. Serve para
  // quem entrega os papeis por e-mail em vez de subir no portal. So vale dentro
  // do recorte do admin, e so para colaborador - admin nao lanca por admin.
  const emNomeDe = url.searchParams.get('em_nome_de');
  let dono = usuario;
  if (emNomeDe) {
    if (!ehAdmin(usuario)) return erro(res, 'Area restrita ao administrador.', 403);
    const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(emNomeDe));
    if (!alvo || alvo.papel !== 'colaborador' || !podeVerUsuario(usuario, alvo)) {
      return erro(res, 'Colaborador nao encontrado.', 404);
    }
    log.info('em-nome-de', `${metodo} ${rota}`, { quem: usuario.login, por: alvo.login });
    dono = alvo;
  }

  if (rota === '/api/relatorio' && metodo === 'GET') return pegarRelatorio(req, res, url, dono);
  if (rota === '/api/relatorio' && metodo === 'PUT') return salvarRelatorio(req, res, dono);
  if (rota === '/api/relatorio/ler-rdv' && metodo === 'POST') return lerRdv(req, res, dono);
  if (rota === '/api/relatorio/enviar' && metodo === 'POST') return enviarRelatorio(req, res, dono);
  if (rota === '/api/meus-relatorios' && metodo === 'GET') return meusRelatorios(res, dono);

  if (rota === '/api/anexo' && metodo === 'POST') return subirAnexo(req, res, url, dono);
  if (rota.startsWith('/api/anexo/') && metodo === 'GET') return baixarAnexo(req, res, rota, usuario);
  if (rota.startsWith('/api/anexo/') && metodo === 'DELETE') return apagarAnexo(res, rota, usuario);

  // --- area do administrador ---
  if (rota.startsWith('/api/admin/')) {
    if (!ehAdmin(usuario)) return erro(res, 'Area restrita ao administrador.', 403);

    // Ajustes que valem para as duas empresas ficam so com quem ve tudo.
    const soSuper = [
      '/api/admin/config',
      '/api/admin/backup',
      '/api/admin/restaurar',
      '/api/admin/dados',
      '/api/admin/tudo',
      '/api/admin/armazenamento',
      '/api/admin/bloco',
      '/api/admin/bloco-liberar',
      '/api/admin/bloco-devolver',
    ];
    if (soSuper.includes(rota) && !ehSuper(usuario)) {
      return erro(
        res,
        'Essa area e restrita. Fale com o Eduardo Ramos ou o Victor Sarmento.',
        403,
      );
    }

    if (rota === '/api/admin/painel' && metodo === 'GET') return painel(res, url, usuario);
    if (rota === '/api/admin/relatorio' && metodo === 'GET') return relatorioDetalhe(res, url, usuario);
    if (rota === '/api/admin/conferir' && metodo === 'POST') return conferirUm(req, res, usuario);
    if (rota === '/api/admin/conferir-pendentes' && metodo === 'POST') return conferirPendentes(req, res, usuario);
    if (rota === '/api/admin/fila' && metodo === 'GET') return responderJson(res, estadoDaFila());
    if (rota === '/api/admin/fila-parar' && metodo === 'POST') return responderJson(res, pedirParada());
    if (rota === '/api/admin/decidir' && metodo === 'POST') return decidir(req, res, usuario);
    if (rota === '/api/admin/vetar' && metodo === 'POST') return vetarErro(req, res, usuario);
    if (rota === '/api/admin/relatorio-editar' && metodo === 'POST') return editarRelatorio(req, res, usuario);
    if (rota === '/api/admin/impresso' && metodo === 'POST') return marcarImpresso(req, res, usuario);
    if (rota === '/api/admin/galeria' && metodo === 'GET') return verGaleria(res, url, usuario);
    if (rota === '/api/admin/pacote' && metodo === 'GET') return baixarPacote(res, url, usuario);
    if (rota === '/api/admin/impressao' && metodo === 'GET') return baixarImpressao(res, url, usuario);
    if (rota === '/api/admin/usuarios' && metodo === 'GET') return listarUsuarios(res, usuario);
    if (rota === '/api/admin/usuarios' && metodo === 'POST') return novoUsuario(req, res, usuario);
    if (rota === '/api/admin/usuario-senha' && metodo === 'POST') return resetarSenha(req, res, usuario);
    if (rota === '/api/admin/usuario-login' && metodo === 'POST') return mudarLogin(req, res, usuario);
    if (rota === '/api/admin/usuario-nome' && metodo === 'POST') return mudarNome(req, res, usuario);
    if (rota === '/api/admin/usuario-placa' && metodo === 'POST') return mudarPlaca(req, res, usuario);
    if (rota === '/api/admin/usuario-ativo' && metodo === 'POST') return ativarUsuario(req, res, usuario);
    if (rota === '/api/admin/usuario-empresa' && metodo === 'POST') return mudarEmpresa(req, res, usuario);
    if (rota === '/api/admin/valores-pagos' && metodo === 'GET') return listarValoresPagos(res, url, usuario);
    if (rota === '/api/admin/valor-pago' && metodo === 'POST') return gravarValorPago(req, res, usuario);
    if (rota === '/api/admin/usuario' && metodo === 'DELETE') return excluirUsuario(req, res, usuario);
    if (rota === '/api/admin/aparelhos' && metodo === 'GET') return listarAparelhos(res, usuario);
    if (rota === '/api/admin/notificar' && metodo === 'POST') return notificar(req, res, usuario);
    if (rota === '/api/admin/historico' && metodo === 'GET') return exportarHistorico(res, url, usuario);
    if (rota === '/api/admin/config' && metodo === 'GET') return pegarConfig(res);
    if (rota === '/api/admin/config' && metodo === 'POST') return salvarConfig(req, res);
    if (rota === '/api/admin/exportar' && metodo === 'GET') return exportarCsv(res, url, usuario);
    if (rota === '/api/admin/backup' && metodo === 'GET') return baixarBackup(res, usuario);
    if (rota === '/api/admin/restaurar' && metodo === 'POST') return subirBackup(req, res, usuario);
    if (rota === '/api/admin/dados' && metodo === 'GET') return responderJson(res, resumoDosDados());
    if (rota === '/api/admin/tudo' && metodo === 'GET') return verTudo(res, usuario);
    if (rota === '/api/admin/armazenamento' && metodo === 'GET') return responderJson(res, resumoDoArmazenamento());
    if (rota === '/api/admin/bloco' && metodo === 'GET') return baixarBloco(res, url, usuario);
    if (rota === '/api/admin/bloco-liberar' && metodo === 'POST') return liberarUmBloco(req, res, usuario);
    if (rota === '/api/admin/bloco-devolver' && metodo === 'POST') return devolverUmBloco(req, res, usuario);
  }

  return erro(res, 'Rota nao encontrada.', 404);
}

// ------------------------------------------------------------------- sessao

async function entrar(req, res, seguro) {
  const { login, senha } = await lerJson(req);
  const ip = ipDoPedido(req);
  const nome = String(login || '').trim().toLowerCase();

  // A chave e `login|ip`, NAO o ip.
  //
  // O escritorio inteiro sai por um endereco so - no log de 01/09 sao cinco
  // contas no mesmo IP. Limitar por ip trancaria a empresa toda cada vez que
  // uma pessoa errasse a senha, e isso acontece: o bruno.st errou quatro
  // vezes seguidas as 11:04 antes de acertar. Um portal que se tranca sozinho
  // no fechamento do mes e pior que o problema que isto resolve.
  //
  // O limite por ip puro existe, mas com a rede bem mais larga: 50 falhas de
  // logins DIFERENTES e varredura, nao gente esquecida.
  const porLogin = checar(REGRAS.LOGIN, `${nome}|${ip}`);
  const porIp = checar(REGRAS.LOGIN_IP, ip);
  const travado = !porLogin.ok ? porLogin : !porIp.ok ? porIp : null;
  if (travado) {
    log.aviso('limite', 'login bloqueado', { login: nome, ip, esperar: travado.esperarSegundos });
    return erro(res, recadoDeEspera(travado.esperarSegundos), 429, {
      'Retry-After': String(travado.esperarSegundos),
    });
  }

  const u = autenticar(login, senha);
  if (!u) {
    registrar(REGRAS.LOGIN, `${nome}|${ip}`);
    registrar(REGRAS.LOGIN_IP, ip);
    // O login tentado entra no log, a senha nunca. Repetido do mesmo IP e o
    // sinal de que alguem esta chutando - ou de que um vendedor esqueceu a
    // senha e vai ligar daqui a pouco.
    log.aviso('entrada', 'login recusado', { login: nome });
    return erro(res, 'Login ou senha invalidos.', 401);
  }

  // Acertou: zera o contador daquele login. O do IP fica - ele mede varredura
  // de logins diferentes, e um acerto nao desmente isso.
  limpar(REGRAS.LOGIN, `${nome}|${ip}`);

  const token = abrirSessao(u.id);
  log.info('entrada', 'entrou', { quem: u.login, papel: u.papel, empresa: u.empresa });
  responderJson(
    res,
    { ok: true, usuario: publico(u) },
    200,
    { 'Set-Cookie': cookieDeSessao(token, seguro) },
  );
}

async function sair(req, res) {
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)sid=([^;]+)/);
  if (m) fecharSessao(decodeURIComponent(m[1]));
  responderJson(res, { ok: true }, 200, { 'Set-Cookie': cookieDeSaida });
}

function eu(res, usuario) {
  responderJson(res, {
    usuario: publico(usuario),
    valor_km: valorDoKm(),
    ia_disponivel: iaDisponivel(),
    mes_atual: mesAtual(),
    // Fora de producao a tela ganha uma faixa. Um portal de teste identico ao
    // de verdade e um convite a lancar o RDV do mes no lugar errado.
    ambiente: process.env.AMBIENTE && process.env.AMBIENTE !== 'producao'
      ? process.env.AMBIENTE
      : null,
    // A tela usa isto para mostrar so o que a pessoa pode fazer.
    escopo: escopoDe(usuario),
    pode_tudo: ehSuper(usuario),
  });
}

async function trocarMinhaSenha(req, res, usuario) {
  const { senha } = await lerJson(req);
  if (!senha || String(senha).length < 6) {
    return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  }
  trocarSenha(usuario.id, String(senha));
  responderJson(res, { ok: true, aviso: 'Senha trocada. Entre de novo.' });
}

const publico = (u) => ({
  id: u.id,
  login: u.login,
  nome: u.nome,
  email: u.email,
  papel: u.papel,
  empresa: u.empresa,
  funcao: u.funcao,
  carro: u.carro,
  cracha: cracha(u.empresa, u.funcao),
  placas: u.placas,
  trocar_senha: Boolean(u.trocar_senha),
});

// ---------------------------------------------------------------- relatorio

function acharOuCriar(usuarioId, mes) {
  let rel = db
    .prepare('SELECT * FROM relatorios WHERE usuario_id = ? AND mes_ref = ?')
    .get(usuarioId, mes);
  if (!rel) {
    db.prepare(
      'INSERT INTO relatorios (usuario_id, mes_ref, status, criado_em) VALUES (?, ?, ?, ?)',
    ).run(usuarioId, mes, 'RASCUNHO', agora());
    rel = db
      .prepare('SELECT * FROM relatorios WHERE usuario_id = ? AND mes_ref = ?')
      .get(usuarioId, mes);
  }
  return rel;
}

// O ultimo mes ja enviado antes deste, para comparar o gasto.
// Rascunho nao conta: so vale mes que a pessoa realmente prestou contas.
function mesAnteriorDe(usuarioId, mes) {
  // O valor que o admin digitou para um mes de antes do portal (agosto) vale
  // como mes anterior - a nao ser que exista um relatorio de verdade mais novo
  // ou do mesmo mes, que ganha dele.
  const pago = db
    .prepare(
      `SELECT mes_ref, valor FROM valores_pagos
        WHERE usuario_id = ? AND mes_ref < ?
        ORDER BY mes_ref DESC LIMIT 1`,
    )
    .get(usuarioId, mes);

  const r = db
    .prepare(
      `SELECT mes_ref, valor_km, pedagio_declarado, estac_declarado,
              hotel_declarado, outros_declarado
         FROM relatorios
        WHERE usuario_id = ? AND mes_ref < ? AND status <> 'RASCUNHO'
        ORDER BY mes_ref DESC LIMIT 1`,
    )
    .get(usuarioId, mes);

  if (pago && (!r || pago.mes_ref > r.mes_ref)) {
    return {
      mes: pago.mes_ref,
      mesExtenso: mesPorExtenso(pago.mes_ref),
      total: Number(Number(pago.valor).toFixed(2)),
      informado: true,
    };
  }

  if (!r) return null;

  return {
    mes: r.mes_ref,
    mesExtenso: mesPorExtenso(r.mes_ref),
    // Tem que somar exatamente o que o mes atual soma, senao o primeiro mes
    // com hotel apareceria como aumento so por causa da conta diferente.
    // Relatorio antigo nao tem os dois campos e conta zero - que e a verdade.
    total: Number(
      (
        Number(r.valor_km || 0)
        + Number(r.pedagio_declarado || 0)
        + Number(r.estac_declarado || 0)
        + Number(r.hotel_declarado || 0)
        + Number(r.outros_declarado || 0)
      ).toFixed(2),
    ),
  };
}

function linhasDo(relId) {
  return db
    .prepare('SELECT * FROM linhas WHERE relatorio_id = ? ORDER BY data, ordem')
    .all(relId);
}

function anexosDo(relId) {
  return db
    .prepare(
      `SELECT id, tipo, nome_original, mime, tamanho, km, data_leitura, valor, enviado_em,
              arquivado_em, arquivado_bloco
         FROM anexos WHERE relatorio_id = ? ORDER BY tipo, km, id`,
    )
    .all(relId);
}

// A conferencia por regra depende da empresa do dono do relatorio (fim de
// semana e 18h so sao aviso na DSO). Todo lugar que confere passa por aqui,
// para nenhum esquecer de mandar a empresa.
//
// O erro que o conferente vetou no relatorio nao volta por aqui: senao a tela
// do colaborador continuaria cobrando o que ja foi dispensado. `comVetados` e
// para a conferencia, que precisa da lista inteira para guardar o que vetou.
function conferirRel(rel, linhas, anexos, { comVetados = false } = {}) {
  const dono = db.prepare('SELECT empresa, funcao, carro FROM usuarios WHERE id = ?').get(rel.usuario_id);
  const r = conferir(
    rel,
    linhas,
    anexos,
    valorDoKm(),
    mesAnteriorDe(rel.usuario_id, rel.mes_ref),
    dono?.empresa ?? null,
    dono?.funcao ?? null,
    dono?.carro ?? 'pessoal',
  );
  if (!comVetados && separarVetados(r.achados, listaDeJson(rel.vetos)).length) {
    r.statusSugerido = statusPelosErros(r.achados);
  }
  return r;
}

// ------------------------------------------------------------ erros vetados
//
// O conferente olha um erro apitado e decide que, neste relatorio, ele nao
// vale: o sabado foi trabalhado mesmo, a foto que falta esta justificada. O
// veto e por TIPO de erro dentro do relatorio - vetar "lancamento em fim de
// semana" dispensa todos os dias daquele relatorio, que e como a tela mostra.
// O recado livre da IA nao tem tipo, entao vale o texto.
const chaveDoVeto = (a) => (a.codigo === 'ia' ? `ia|${a.mensagem}` : a.codigo);

const statusPelosErros = (achados) => {
  const erros = achados.filter((a) => a.gravidade === 'erro');
  if (erros.length === 0) return 'CERTA';
  return erros.length === 1 && erros[0].codigo === 'sem_danfe' ? 'SO_FALTA_DANFE' : 'ERRADA';
};

/** Tira de `achados` (na propria lista) os erros vetados e devolve os que sairam. */
function separarVetados(achados, vetos) {
  const chaves = new Set((vetos || []).map((v) => v.chave));
  const sairam = [];
  if (!chaves.size) return sairam;
  for (let i = achados.length - 1; i >= 0; i--) {
    if (achados[i].gravidade === 'erro' && chaves.has(chaveDoVeto(achados[i]))) {
      sairam.unshift(...achados.splice(i, 1));
    }
  }
  return sairam;
}

/**
 * A mesma conferencia, sem os amarelos - e o que vai para a tela do colaborador.
 *
 * O vermelho continua inteiro, inclusive a cobranca de anexo: esconder ISSO
 * dele ja foi tentado uma vez e o efeito foi o oposto, ele so descobria a
 * pendencia no clique do Enviar, quando ja era tarde. O que sai daqui sao os
 * AVISOS.
 *
 * Eles nao eram acionaveis para quem preenche: "a leitura do arquivo teve
 * pontos duvidosos", "na extracao de texto da pagina 2 os valores aparecem
 * concatenados" e recado da IA para quem confere, nao tarefa de vendedor. No
 * meio deles o pouco que era acionavel se perdia, e a aba vivia amarela de
 * coisa que ninguem ia fazer nada a respeito.
 *
 * O conferente continua vendo tudo: o painel do admin nao passa por aqui.
 */
function soOsErros(resultado) {
  return { ...resultado, achados: resultado.achados.filter((a) => a.gravidade === 'erro') };
}

// A mesma peneira na lista ja gravada. O null e preservado de proposito: ele
// quer dizer "ninguem conferiu ainda", que nao e a mesma coisa que "conferiram
// e nao acharam nada" - a tela mostra coisas diferentes para os dois casos.
function soErrosGravados(bruto) {
  const lista = listaDeJson(bruto);
  return lista && lista.filter((a) => a.gravidade === 'erro');
}

// Monta a grade do mes: todo dia do mes, com o que ja foi preenchido.
function gradeDoMes(mes, linhas) {
  const porData = new Map(linhas.map((l) => [l.data, l]));
  return diasDoMes(mes).map((data) => {
    const l = porData.get(data);
    return {
      data,
      dia_semana: diaDaSemana(data),
      fim_de_semana: fimDeSemana(data),
      feriado: nomeDoFeriado(data),
      km_inicial: l ? l.km_inicial : 0,
      km_final: l ? l.km_final : 0,
      itinerario: l ? l.itinerario || '' : '',
      pedagio: l ? l.pedagio : 0,
      estacionamento: l ? l.estacionamento : 0,
      combustivel: l ? l.combustivel || 0 : 0,
      justificativa_hora: l ? l.justificativa_hora || '' : '',
    };
  });
}

function pegarRelatorio(req, res, url, usuario) {
  const mes = url.searchParams.get('mes') || mesAtual();
  if (!mesValido(mes)) return erro(res, 'Mes invalido. Use o formato AAAA-MM.');

  const rel = acharOuCriar(usuario.id, mes);
  const linhas = linhasDo(rel.id);
  const anexos = anexosDo(rel.id);
  // "previa": e a aba que o colaborador ve enquanto preenche. A cobranca de
  // DANFE e de foto de odometro sai dali e volta na hora do envio.
  const resultado = conferirRel(rel, linhas, anexos);

  responderJson(res, {
    relatorio: {
      ...rel,
      mes_extenso: mesPorExtenso(mes),
      rotulo_status: ROTULO_STATUS[rel.status],
      editavel: EDITAVEL.has(rel.status),
      // Em "So falta DANFE" a pessoa nao edita nada, mas ainda manda a nota.
      aceita_anexo: ACEITA_ANEXO.has(rel.status),
      so_falta_danfe: rel.status === 'SO_FALTA_DANFE',
      // O parecer ja gravado tambem chega limpo: se o amarelo nao aparece
      // enquanto ele preenche, nao faz sentido voltar depois da conferencia.
      achados: soErrosGravados(rel.achados),
      extraido: rel.extraido ? JSON.parse(rel.extraido) : null,
    },
    grade: gradeDoMes(mes, linhas),
    anexos,
    previa: soOsErros(resultado),
    valor_km: valorDoKm(),
  });
}

async function salvarRelatorio(req, res, usuario) {
  const corpo = await lerJson(req);
  const mes = corpo.mes;
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  const rel = acharOuCriar(usuario.id, mes);
  if (!EDITAVEL.has(rel.status)) {
    return erro(res, `Esse relatorio esta como "${ROTULO_STATUS[rel.status]}" e nao pode ser editado.`);
  }

  const recebidas = Array.isArray(corpo.linhas) ? corpo.linhas : [];

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM linhas WHERE relatorio_id = ?').run(rel.id);

    const inserir = db.prepare(
      `INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, pedagio, estacionamento, ordem, hora_pedagio, justificativa_hora, combustivel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let ordem = 0;
    for (const l of recebidas) {
      const ki = numero(l.km_inicial);
      const kf = numero(l.km_final);
      const ped = numero(l.pedagio);
      const est = numero(l.estacionamento);
      const comb = Math.max(0, numero(l.combustivel));
      const itin = String(l.itinerario || '').trim().slice(0, 500);
      // Hora da passagem mais tarde do dia, e o porque dela quando passa das 18h.
      const horaRecebida = String(l.hora_pedagio || '').trim();
      const hora = /^\d{1,2}:\d{2}$/.test(horaRecebida) ? horaRecebida : null;
      const porQue = String(l.justificativa_hora || '').trim().slice(0, 500) || null;
      // Dia totalmente em branco nao vira linha. Justificativa escrita conta
      // como preenchido: a foto de um sabado sem lancamento tambem pode pedir
      // explicacao (troca de carro), e ela nao pode se perder no salvar.
      if (ki === 0 && kf === 0 && ped === 0 && est === 0 && comb === 0 && !itin && !porQue) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.data || ''))) continue;
      if (!String(l.data).startsWith(mes)) continue;
      inserir.run(rel.id, l.data, ki, kf, itin, ped, est, ordem++, hora, porQue, comb);
    }

    const linhas = linhasDo(rel.id);
    const anexos = anexosDo(rel.id);
    const r = conferirRel(rel, linhas, anexos);

    db.prepare(
      `UPDATE relatorios
          SET total_km = ?, valor_km = ?, pedagio_declarado = ?, estac_declarado = ?,
              observacao = ?, justificativa = ?
        WHERE id = ?`,
    ).run(
      r.totalKm,
      r.valorKm,
      r.pedagioDeclarado,
      r.estacDeclarado,
      // Hotel e outras despesas nao passam mais por aqui: o valor e o que o RDV
      // declara (gravado na leitura do PDF), e a prova sao os comprovantes.
      String(corpo.observacao || '').slice(0, 2000),
      corpo.justificativa === undefined
        ? rel.justificativa
        : String(corpo.justificativa || '').slice(0, 2000) || null,
      rel.id,
    );

    db.exec('COMMIT');

    const atualizado = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
    responderJson(res, {
      ok: true,
      relatorio: atualizado,
      previa: soOsErros(conferirRel(atualizado, linhas, anexos)),
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Le o arquivo do RDV com a IA e preenche as linhas a partir dele.
// O colaborador nao digita dia a dia: ele anexa o relatorio que ja produz hoje.
async function lerRdv(req, res, usuario) {
  const { mes } = await lerJson(req);
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  // Esta e a unica rota do portal que gasta dinheiro: fala com a API da
  // Anthropic e leva uns 20 segundos. Um vendedor honesto le o RDV de 1 a 3
  // vezes no mes; dez por hora e folga larga e ainda assim poe teto na conta.
  //
  // Conta a CHAMADA, nao o sucesso, e por isso vem antes de tudo: botao preso
  // repetindo tambem custa. No log de 01/09 ha uma leitura de 20,6s que
  // terminou em 400 - gastou e nao entregou.
  //
  // Por usuario, nao por IP: um vendedor gastar a cota nao pode travar o
  // colega da mesa ao lado, que sai pelo mesmo endereco.
  const cota = checar(REGRAS.IA, String(usuario.id));
  if (!cota.ok) {
    log.aviso('limite', 'leitura de rdv', { quem: usuario.login, esperar: cota.esperarSegundos });
    return erro(res, recadoDeEspera(cota.esperarSegundos), 429, {
      'Retry-After': String(cota.esperarSegundos),
    });
  }
  registrar(REGRAS.IA, String(usuario.id));

  const rel = acharOuCriar(usuario.id, mes);
  if (!EDITAVEL.has(rel.status)) {
    return erro(res, `Esse relatorio esta como "${ROTULO_STATUS[rel.status]}" e nao pode ser relido.`);
  }

  const arquivos = db
    .prepare("SELECT * FROM anexos WHERE relatorio_id = ? AND tipo = 'rdv' ORDER BY id")
    .all(rel.id);

  if (!arquivos.length) {
    return erro(res, 'Anexe primeiro o arquivo do seu RDV (PDF ou foto).');
  }

  let lido;
  try {
    lido = await lerEGravarRdv(rel, usuario, arquivos, mes);
  } catch (e) {
    if (e.mesDoDocumento) {
      return responderJson(res, { erro: e.message, mes_do_documento: e.mesDoDocumento }, 400);
    }
    if (e.naoLeu) return erro(res, e.message, 502);
    throw e;
  }
  const { extraido, linhas, anexos } = lido;

  responderJson(res, {
    ok: true,
    extraido,
    previa: soOsErros(
      conferirRel(db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id), linhas, anexos),
    ),
    grade: gradeDoMes(mes, linhas),
    aviso: avisoDaLeitura(extraido, usuario),
  });
}

/**
 * Le o arquivo do RDV e grava os dias, os totais e o que o documento declarava.
 *
 * Saiu de dentro da rota porque a conferencia tambem precisa: quem anexa o RDV
 * e envia sem tocar em "Ler meu relatorio" chegava ao painel com zero dias, e
 * o relatorio certo ficava cobrado de "lancamentos dia a dia".
 *
 * Lanca erro com `naoLeu` quando a leitura falha e com `mesDoDocumento` quando
 * o arquivo e de outro mes; nos dois casos nada e gravado.
 */
async function lerEGravarRdv(rel, usuario, arquivos, mes) {
  let extraido;
  const comecouEm = Date.now();
  try {
    const saida = await extrairDoRdv(arquivos, mes);
    extraido = saida.extraido;
    // Por texto, por OCR ou pela IA: quem confere e quem deixa enviar precisam
    // saber o quanto confiar nos dias lidos.
    extraido.lido_por = saida.por || 'ia';
    log.info('rdv', { codigo: 'lido por codigo', ocr: 'lido por OCR (escaneado)' }[saida.por] || 'lido pela IA', {
      quem: usuario.login, mes, linhas: extraido.linhas.length, levou: log.desde(comecouEm),
    });
  } catch (e) {
    // O motivo ia so para a tela do vendedor. Quando cinco tentativas seguidas
    // falharam, o log tinha o 502 e nenhuma pista do porque - e a pessoa ja
    // tinha desistido. O tempo entra junto: falha em milissegundos e chave ou
    // arquivo recusado; falha em segundos e a API que respondeu erro.
    log.falha('rdv', 'nao consegui ler o RDV', e, {
      quem: usuario.login,
      mes,
      arquivos: arquivos.map((a) => a.nome_original).join(' | '),
      levou: log.desde(comecouEm),
    });
    e.naoLeu = true;
    throw e;
  }

  // O "Subtotal das Despesas" e o total que o documento declara. Se a leitura
  // nao trouxe, o codigo procura no texto do PDF.
  if (extraido.totais_declarados && extraido.totais_declarados.subtotal == null) {
    extraido.totais_declarados.subtotal = await subtotalDosRdvs(arquivos);
  }

  // O relatorio e de outro mes. Recusar e melhor que arquivar julho dentro de
  // setembro ou esvaziar tudo porque o seletor estava errado.
  if (extraido.mes_do_documento && extraido.mes_do_documento !== mes) {
    const e = new Error(
      `Este arquivo e o relatorio de ${mesPorExtenso(extraido.mes_do_documento)}, `
        + `mas voce esta no mes de ${mesPorExtenso(mes)}. `
        + 'Troque o mes no topo da tela e leia de novo, ou anexe o relatorio do mes certo.',
    );
    e.mesDoDocumento = extraido.mes_do_documento;
    throw e;
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM linhas WHERE relatorio_id = ?').run(rel.id);

    const inserir = db.prepare(
      `INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, pedagio, estacionamento, ordem, hora_pedagio, justificativa_hora, combustivel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let ordem = 0;
    for (const l of extraido.linhas) {
      inserir.run(
        rel.id,
        l.data,
        l.km_inicial,
        l.km_final,
        l.itinerario,
        l.pedagio,
        l.estacionamento,
        ordem++,
        // A leitura do RDV nao traz hora nem explicacao - quem informa e a pessoa,
        // na grade. Reler o arquivo nao pode apagar o que ela ja escreveu, entao
        // estes dois campos ficam nulos e sao preenchidos pelo salvar.
        null,
        null,
        l.combustivel || 0,
      );
    }

    // Guarda tambem o que o documento declarava, para a conferencia comparar.
    db.prepare(
      `UPDATE relatorios SET extraido = ?, extraido_em = ?, totais_do_admin = 0 WHERE id = ?`,
    ).run(JSON.stringify(extraido), agora(), rel.id);

    const linhas = linhasDo(rel.id);
    const anexos = anexosDo(rel.id);
    const atualizado = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
    // Documento novo: hotel e outros vem DELE, nao do que estava gravado antes.
    const r = conferirRel({ ...atualizado, hotel_declarado: null, outros_declarado: null }, linhas, anexos);

    // Hotel e outros ficam gravados, e nao so dentro de `extraido`: a
    // comparacao com o mes anterior le estas colunas no banco. Deixar o valor
    // so no JSON da leitura faria o mes passado contar zero de hotel e o mes
    // atual aparecer como aumento sem motivo.
    db.prepare(
      `UPDATE relatorios
          SET total_km = ?, valor_km = ?, pedagio_declarado = ?, estac_declarado = ?,
              hotel_declarado = ?, outros_declarado = ?,
              outros_descricao = COALESCE(?, outros_descricao)
        WHERE id = ?`,
    ).run(
      r.totalKm,
      r.valorKm,
      r.pedagioDeclarado,
      r.estacDeclarado,
      r.hotelDeclarado,
      r.outrosDeclarado,
      String(extraido.totais_declarados?.outros_descricao || '').trim().slice(0, 300) || null,
      rel.id,
    );

    db.exec('COMMIT');

    // RDV "Carro da Empresa" (combustivel por dia) de quem esta no cadastro
    // com carro pessoal: o cadastro e que esta atrasado. Acerta aqui, para a
    // tela dele parar de pedir foto do odometro e a nota passar a pedir o valor.
    if (usuario.carro !== 'empresa' && extraido.linhas.some((l) => Number(l.combustivel) > 0)) {
      db.prepare("UPDATE usuarios SET carro = 'empresa' WHERE id = ?").run(usuario.id);
      log.info('relatorio', 'RDV de carro da empresa - cadastro passou para carro da empresa', {
        quem: usuario.login, mes,
      });
    }

    // Se o documento trouxe placa e a pessoa ainda nao tem, aproveita.
    //
    // Passa pela peneira antes: isto grava no CADASTRO de uma pessoa a partir
    // do que um modelo leu num arquivo. Sem conferencia, um dia a extracao
    // devolveu 3.314 caracteres de payload e eles foram parar no campo placa
    // de um vendedor - a janela do relatorio dele virou um muro de texto.
    // Nao parecendo placa, nao grava: cadastro sem placa e melhor que cadastro
    // com lixo, e a pessoa pode digitar a dela depois.
    const daLeitura = placaLimpa(extraido.placas);
    if (daLeitura && !usuario.placas) {
      db.prepare('UPDATE usuarios SET placas = ? WHERE id = ?').run(daLeitura, usuario.id);
    } else if (extraido.placas && !daLeitura) {
      log.aviso('relatorio', 'a leitura devolveu algo que nao e placa - ignorado', {
        quem: usuario.login,
        veio: String(extraido.placas).slice(0, 80),
        tamanho: String(extraido.placas).length,
      });
    }

    return { extraido, linhas, anexos };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function avisoDaLeitura(extraido, usuario) {
  const partes = [`Foram lidos ${extraido.linhas.length} dia(s) do seu relatorio.`];

  if (extraido.confianca !== 'alta') {
    partes.push('A leitura teve pontos duvidosos - confira os dias abaixo antes de enviar.');
  }

  // O dono do RDV e o nome dentro do arquivo. Se nao bater, e provavel que a
  // pessoa tenha anexado o relatorio de outra.
  const limpar = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .split(/\s+/)
      .filter(Boolean);

  const noArquivo = limpar(extraido.nome_no_relatorio);
  const doLogin = limpar(usuario.nome);
  if (noArquivo.length && doLogin.length) {
    const emComum = noArquivo.filter((p) => doLogin.includes(p)).length;
    if (emComum === 0) {
      partes.push(
        `ATENCAO: o nome no arquivo e "${extraido.nome_no_relatorio}", diferente do seu cadastro (${usuario.nome}). Confira se anexou o relatorio certo.`,
      );
    }
  }

  return partes.join(' ');
}

async function enviarRelatorio(req, res, usuario) {
  const { mes } = await lerJson(req);
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  const rel = db
    .prepare('SELECT * FROM relatorios WHERE usuario_id = ? AND mes_ref = ?')
    .get(usuario.id, mes);
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);
  if (!EDITAVEL.has(rel.status)) return erro(res, 'Esse relatorio ja foi enviado.');

  const linhas = linhasDo(rel.id);
  // O envio so e recusado quando nao ha NADA para mandar: nem um dia lancado,
  // nem o arquivo do RDV. Com o arquivo anexado e a leitura falhando, vai assim
  // mesmo - quem confere abre o documento.
  const temArquivoDoRdv = Boolean(
    db.prepare("SELECT 1 FROM anexos WHERE relatorio_id = ? AND tipo = 'rdv' LIMIT 1").get(rel.id),
  );
  if (linhas.length === 0 && !temArquivoDoRdv) {
    log.aviso('relatorio', 'envio recusado', {
      quem: usuario.login,
      mes: rel.mes_ref,
      bloqueios: 'sem_lancamentos',
    });
    return erro(
      res,
      'Anexe o arquivo do seu RDV e toque em "Ler meu relatorio" antes de enviar.',
    );
  }

  const anexos = anexosDo(rel.id);
  const r = conferirRel(rel, linhas, anexos);

  // Erro NAO impede o envio (ordem do Eduardo em 02/10/2026): a pessoa manda
  // o relatorio como esta, a conferencia aponta o que achou e ela corrige
  // depois. Ja houve uma lista de "bloqueios duros" aqui - km invertido,
  // leitura incerta, falta de comprovante, aumento sem justificativa - e o
  // efeito era relatorio certo no papel preso porque o portal leu errado.
  // Fica so o registro do que estava vermelho na hora do envio.
  const errosNoEnvio = r.achados.filter((a) => a.gravidade === 'erro').map((a) => a.codigo);
  if (errosNoEnvio.length) {
    log.info('relatorio', 'enviado com pendencias', {
      quem: usuario.login, mes: rel.mes_ref, erros: errosNoEnvio.join(','),
    });
  }

  const codigos = new Set(r.achados.map((a) => a.codigo));
  const faltando = [];
  // A nota so reprova gerente; para os outros ela nao entra no "faltou".
  if (r.achados.some((a) => a.codigo === 'sem_danfe' && a.gravidade === 'erro')) {
    faltando.push('a nota de abastecimento');
  }
  if (codigos.has('sem_odometro')) faltando.push('a foto do odometro');

  // Reenvio: guarda os erros que o relatorio tinha, para o painel mostrar o
  // que a pessoa corrigiu e o que continua.
  const errosAnteriores = rel.enviado_em ? errosDoParecer(rel.achados) : null;

  db.prepare(
    `UPDATE relatorios SET status = 'ENVIADO', enviado_em = ?, achados = NULL, parecer_ia = NULL,
            envios = COALESCE(envios, 0) + 1, erros_do_envio_anterior = ?,
            o_que_fazer = NULL, conferido_em = NULL, pedagio_comprovado = NULL,
            pedagio_comprovado_admin = NULL,
            -- Reenviou: o que estava impresso era a versao antiga, e a decisao
            -- do conferente era sobre ela.
            impresso_em = NULL, impresso_por = NULL, decisao_manual = NULL
      WHERE id = ?`,
  ).run(agora(), errosAnteriores ? JSON.stringify(errosAnteriores) : null, rel.id);

  log.info('relatorio', rel.status === 'RASCUNHO' ? 'enviado' : 'reenviado corrigido', {
    rel: rel.id,
    mes: rel.mes_ref,
    quem: usuario.login,
    km: r.totalKm,
    linhas: linhas.length,
    anexos: anexos.length,
    // Achado de aviso nao trava o envio, mas e o que a conferencia vai olhar.
    ressalvas: r.achados.filter((a) => a.gravidade === 'aviso').length || undefined,
  });

  responderJson(res, {
    ok: true,
    // A cobranca de anexo nao aparece mais na aba durante o preenchimento, entao
    // o "enviado" e a ultima chance de dizer o que ficou faltando.
    aviso: faltando.length
      ? `Enviado, mas faltou ${faltando.join(' e ')} - isso costuma reprovar o relatorio.`
      : 'Relatorio enviado para conferencia.',
  });

  // A conferencia comeca sozinha, DEPOIS de responder.
  //
  // Sem isso o relatorio ficava parado esperando alguem clicar "Conferir os
  // pendentes com IA" - e ate esse clique o pedagio comprovado ficava vazio,
  // porque quem soma o extrato da tag e a conferencia, nao o envio.
  //
  // Fora da resposta de proposito: a leitura leva uns 30 segundos e o vendedor
  // nao pode ficar com a tela presa esperando. Ele ja recebeu o "enviado"; o
  // parecer aparece no painel quando ficar pronto.
  //
  // Roda com ou sem IA: sem ela, os comprovantes sao lidos por codigo.
  {
    const atual = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
    conferirRelatorio(atual, { usarIa: true, decididoPor: null })
      .then((saida) => {
        log.info('ia', 'conferencia automatica', {
          rel: rel.id,
          quem: usuario.login,
          resultado: saida.status,
          pedagio: saida.parecer?.pedagio_comprovado,
        });
      })
      .catch((e) => {
        if (e.naoRodou) {
          log.info('ia', 'conferencia automatica nao rodou', { rel: rel.id, motivo: e.message });
          return;
        }
        // Falhar aqui nao pode desfazer o envio: o relatorio ja esta com o
        // administrador, que confere na mao pelo botao de sempre.
        log.falha('ia', 'conferencia automatica falhou - o relatorio segue para conferencia manual', e, {
          rel: rel.id,
          quem: usuario.login,
        });
      });
  }
}

function meusRelatorios(res, usuario) {
  const lista = db
    .prepare(
      `SELECT id, mes_ref, status, total_km, valor_km, pedagio_declarado, estac_declarado,
              o_que_fazer, enviado_em, conferido_em
         FROM relatorios WHERE usuario_id = ? ORDER BY mes_ref DESC`,
    )
    .all(usuario.id);
  responderJson(
    res,
    lista.map((r) => ({ ...r, rotulo_status: ROTULO_STATUS[r.status], mes_extenso: mesPorExtenso(r.mes_ref) })),
  );
}

// ------------------------------------------------------------------- anexos

async function subirAnexo(req, res, url, usuario) {
  const mes = url.searchParams.get('mes');
  const tipo = url.searchParams.get('tipo');
  const nomeBruto = url.searchParams.get('nome') || 'arquivo';
  const kmBruto = url.searchParams.get('km');
  const dataLeitura = url.searchParams.get('data');
  const valorBruto = url.searchParams.get('valor');
  const leiturasBrutas = url.searchParams.get('leituras');

  if (!mesValido(mes)) return erro(res, 'Mes invalido.');
  if (!TIPOS_DE_ANEXO.has(tipo)) return erro(res, 'Tipo de anexo invalido.');

  // Foto de odometro sem o numero digitado nao serve para conferir nada:
  // alguem teria que abrir a imagem e ler o painel na mao, que e o trabalho
  // que este sistema existe para acabar.
  let km = null;
  // PDF ou PowerPoint com varias fotos do painel: vem uma leitura (dia + KM)
  // por foto. Cada uma vira um anexo proprio, com uma copia do arquivo, para a
  // conferencia ver o mes inteiro e nao uma foto so.
  let leituras = null;
  if (tipo === 'odometro' && leiturasBrutas) {
    let lista;
    try {
      lista = JSON.parse(leiturasBrutas);
    } catch {
      return erro(res, 'Leituras do odometro invalidas.');
    }
    if (!Array.isArray(lista) || !lista.length || lista.length > 60) {
      return erro(res, 'Informe de 1 a 60 leituras do odometro.');
    }
    leituras = [];
    for (const l of lista) {
      const k = numero(l?.km, NaN);
      if (!Number.isFinite(k) || k <= 0) return erro(res, 'Digite o KM de cada foto do arquivo.');
      if (k > 9_999_999) return erro(res, 'Um dos KM parece alto demais. Confira o numero.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l?.data || ''))) return erro(res, 'Informe o dia de cada foto do arquivo.');
      leituras.push({ km: k, data: l.data });
    }
  }
  if (tipo === 'odometro' && leituras) {
    km = leituras[0].km;
  } else if (tipo === 'odometro') {
    km = numero(kmBruto, NaN);
    if (!Number.isFinite(km) || km <= 0) {
      return erro(res, 'Digite o KM que aparece no painel da foto.');
    }
    if (km > 9_999_999) return erro(res, 'Esse KM parece alto demais. Confira o numero.');
  }

  if (dataLeitura && !/^\d{4}-\d{2}-\d{2}$/.test(dataLeitura)) {
    return erro(res, 'Data da leitura invalida.');
  }

  // Nota de abastecimento leva o valor. Para gerente e obrigatorio: e com a
  // soma das notas que o combustivel dele e conferido.
  let valorNota = null;
  if (tipo === 'danfe' && valorBruto != null && valorBruto !== '') {
    valorNota = numero(valorBruto, NaN);
    if (!Number.isFinite(valorNota) || valorNota <= 0) return erro(res, 'Valor da nota invalido.');
    if (valorNota > 100_000) return erro(res, 'Esse valor de nota parece alto demais. Confira.');
  }
  // Carro da empresa tambem: e com a soma das notas que o combustivel e conferido.
  if (tipo === 'danfe' && (ehGerente(usuario.funcao) || usuario.carro === 'empresa') && valorNota == null) {
    return erro(res, 'Digite o valor total da nota de abastecimento.');
  }
  // Hotel e outras despesas: a soma dos comprovantes e conferida contra o RDV.
  if ((tipo === 'hotel' || tipo === 'outras_despesas') && valorBruto != null && valorBruto !== '') {
    valorNota = numero(valorBruto, NaN);
    if (!Number.isFinite(valorNota) || valorNota <= 0) return erro(res, 'Valor do comprovante invalido.');
    if (valorNota > 100_000) return erro(res, 'Esse valor parece alto demais. Confira.');
  }
  if ((tipo === 'hotel' || tipo === 'outras_despesas') && valorNota == null) {
    return erro(res, 'Digite o valor total do comprovante.');
  }

  const rel = acharOuCriar(usuario.id, mes);
  if (!ACEITA_ANEXO.has(rel.status)) return erro(res, 'Esse relatorio nao aceita mais anexos.');
  if (rel.status === 'SO_FALTA_DANFE' && !ANEXO_SO_FALTA_DANFE.has(tipo)) {
    return erro(
      res,
      'Esse relatorio esta aguardando so a nota de abastecimento. '
        + 'Anexe a DANFE - o resto do relatorio ja foi conferido e nao muda mais.',
    );
  }

  // O RDV tem que vir em PDF.
  //
  // A planilha ate e LIDA na extracao - o portal converte a tabela em texto -,
  // mas nao pode ser CONFERIDA: a API le imagem e PDF, e um .xlsx e um ZIP de
  // XMLs, cujos bytes nao dizem nada para o modelo. Na pratica o relatorio era
  // conferido sem que ninguem olhasse o proprio RDV; no 108 ele apareceu como
  // "formato .xlsx nao suportado" na lista de anexos nao lidos.
  //
  // So vale para o RDV. Pedágio, nota e odômetro continuam como estavam.
  if (tipo === 'rdv' && PLANILHA.has(path.extname(nomeBruto || '').toLowerCase())) {
    return erro(
      res,
      'Mande o RDV em PDF. A planilha nao pode ser conferida - so o PDF permite '
        + 'que o relatorio seja lido junto dos comprovantes. No Excel: Arquivo > '
        + 'Salvar como > PDF.',
    );
  }

  const dados = await lerCorpo(req);
  if (dados.length === 0) return erro(res, 'O arquivo chegou vazio (0 KB). Tente enviar de novo.');

  const nomeLimpo = nomeDeArquivoSeguro(decodeURIComponent(nomeBruto));
  const salvo = `${rel.id}-${crypto.randomBytes(6).toString('hex')}-${nomeLimpo}`;
  const caminhoSalvo = path.join(PASTA_ANEXOS, salvo);
  fs.writeFileSync(caminhoSalvo, dados);

  // A conferencia de leitura precisa do arquivo em disco, entao acontece depois
  // de gravar. Se o arquivo nao abre, ele nao vira registro: sai do disco e a
  // pessoa recebe o recado na hora, enquanto ainda esta com o RDV na mao.
  const naoAbre = await motivoDeNaoConseguirLer(caminhoSalvo, path.extname(nomeLimpo).toLowerCase());
  if (naoAbre) {
    try {
      fs.unlinkSync(caminhoSalvo);
    } catch {
      // ja sumiu - nao ha o que limpar
    }
    return erro(res, naoAbre);
  }

  const inserir = db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho,
                         km, data_leitura, valor, enviado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const nomeOriginal = decodeURIComponent(nomeBruto).slice(0, 200);
  const mime = req.headers['content-type'] || 'application/octet-stream';
  if (leituras && leituras.length > 1) {
    leituras.forEach((l, i) => {
      let arquivo = salvo;
      if (i > 0) {
        arquivo = `${rel.id}-${crypto.randomBytes(6).toString('hex')}-${nomeLimpo}`;
        fs.copyFileSync(caminhoSalvo, path.join(PASTA_ANEXOS, arquivo));
      }
      // A extensao fica no fim: e por ela que o arquivo e aberto e lido.
      const ext = path.extname(nomeOriginal);
      const base = nomeOriginal.slice(0, nomeOriginal.length - ext.length).slice(0, 170);
      inserir.run(rel.id, tipo, `${base} (foto ${i + 1} de ${leituras.length})${ext}`,
        arquivo, mime, dados.length, l.km, l.data, null, agora());
    });
  } else {
    inserir.run(rel.id, tipo, nomeOriginal, salvo, mime, dados.length, km,
      (leituras ? leituras[0].data : dataLeitura) || null, valorNota, agora());
  }

  // A nota que faltava chegou: o relatorio volta sozinho para a fila de
  // conferencia. Sem isso ele ficaria parado em "So falta DANFE" para sempre -
  // a pessoa nao pode mais reenviar, entao anexar E o reenvio dela.
  let voltouParaFila = false;
  if (rel.status === 'SO_FALTA_DANFE') {
    db.prepare(
      `UPDATE relatorios SET status = 'ENVIADO', enviado_em = ?, achados = NULL,
              parecer_ia = NULL, o_que_fazer = NULL, conferido_em = NULL,
              envios = COALESCE(envios, 0) + 1, erros_do_envio_anterior = ?
        WHERE id = ?`,
    ).run(agora(), JSON.stringify(errosDoParecer(rel.achados) || []), rel.id);
    voltouParaFila = true;
  }

  responderJson(res, {
    ok: true,
    anexos: anexosDo(rel.id),
    aviso: voltouParaFila
      ? 'Nota anexada. O relatorio voltou para a conferencia - nao precisa enviar de novo.'
      : undefined,
  });
}

function anexoPermitido(id, usuario) {
  const a = db.prepare('SELECT * FROM anexos WHERE id = ?').get(Number(id));
  if (!a) return null;
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(a.relatorio_id);
  if (!rel) return null;
  // O dono sempre pode. Quem confere so pode dentro do proprio recorte -
  // senao um Adm DISO baixaria o comprovante de alguem da DSO pela URL.
  if (rel.usuario_id !== usuario.id) {
    if (!ehAdmin(usuario)) return null;
    const dono = db
      .prepare('SELECT empresa, funcao FROM usuarios WHERE id = ?')
      .get(rel.usuario_id);
    if (!podeVerUsuario(usuario, dono)) return null;
  }
  return { anexo: a, rel };
}

// O que o navegador pode ABRIR na propria origem do portal. Fora desta lista o
// arquivo so baixa.
//
// O tipo sai da EXTENSAO, nunca do que o cliente mandou. A coluna `mime` da
// tabela guarda o cabecalho Content-Type do envio - um valor que quem sobe o
// arquivo escolhe. Devolver aquilo de volta como Content-Type, com `inline`,
// deixava qualquer colaborador anexar um .html com <script> e fazer o script
// rodar na origem do portal quando a conferente abrisse o comprovante. O cookie
// e HttpOnly, mas isso nao adianta: o script chama a API como a pessoa logada -
// criar admin, baixar o backup inteiro - sem precisar ler cookie nenhum.
const MIME_SEGURO = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.bmp', 'image/bmp'],
]);

function baixarAnexo(req, res, rota, usuario) {
  const id = rota.split('/').pop();
  const achado = anexoPermitido(id, usuario);
  if (!achado) return erro(res, 'Anexo nao encontrado.', 404);

  const caminho = path.join(PASTA_ANEXOS, achado.anexo.arquivo);
  if (achado.anexo.arquivado_em) {
    return erro(
      res,
      `Esse comprovante foi arquivado no computador do dono em ${new Date(achado.anexo.arquivado_em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} `
        + `(bloco ${achado.anexo.arquivado_bloco}). Para ver aqui, devolva o bloco ao portal.`,
      410,
    );
  }
  if (!fs.existsSync(caminho)) return erro(res, 'Arquivo sumiu do servidor.', 404);

  const nomeLimpo = nomeDeArquivoSeguro(achado.anexo.nome_original);
  const tipo = MIME_SEGURO.get(path.extname(nomeLimpo).toLowerCase());

  const dados = fs.readFileSync(caminho);
  res.writeHead(200, {
    'Content-Type': tipo || 'application/octet-stream',
    'Content-Length': dados.length,
    // Sem tipo conhecido o arquivo nao abre na tela: baixa.
    'Content-Disposition': `${tipo ? 'inline' : 'attachment'}; filename="${nomeLimpo}"`,
    'Cache-Control': 'private, max-age=3600',
    // Impede o navegador de adivinhar outro tipo a partir do conteudo.
    'X-Content-Type-Options': 'nosniff',
    // Segunda tranca: mesmo que algo escape da lista acima, o arquivo nao
    // executa script nem alcanca a API.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  });
  res.end(dados);
}

function apagarAnexo(res, rota, usuario) {
  const id = rota.split('/').pop();
  const achado = anexoPermitido(id, usuario);
  if (!achado) return erro(res, 'Anexo nao encontrado.', 404);
  // ACEITA_ANEXO, nao EDITAVEL: trocar um arquivo e apagar o velho e mandar o
  // certo. Se apagar seguisse a regra mais estreita, quem enviou so conseguiria
  // ACRESCENTAR anexo, nunca substituir o errado - que e o caso comum.
  if (!ACEITA_ANEXO.has(achado.rel.status) && !ehAdmin(usuario)) {
    return erro(res, 'Esse relatorio nao pode mais ser alterado.');
  }

  try {
    fs.unlinkSync(path.join(PASTA_ANEXOS, achado.anexo.arquivo));
  } catch {
    // arquivo ja tinha sumido - segue e limpa o registro mesmo assim
  }
  db.prepare('DELETE FROM anexos WHERE id = ?').run(achado.anexo.id);
  responderJson(res, { ok: true, anexos: anexosDo(achado.rel.id) });
}

// ------------------------------------------------------------------- admin

function painel(res, url, quem) {
  const mes = url.searchParams.get('mes') || mesAtual();
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  // O recorte e no SQL, nao na tela: esconder linha nao impede ninguem de
  // chamar a API direto.
  const escopo = escopoDe(quem);
  const { sql: filtro, args: argsEscopo } = filtroSql(quem);

  const linhas = db
    .prepare(
      `SELECT r.*, u.nome, u.login, u.placas, u.empresa, u.funcao
         FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.mes_ref = ? ${filtro}
        ORDER BY CASE r.status
                   WHEN 'ENVIADO' THEN 0 WHEN 'CONFERINDO' THEN 1 WHEN 'ERRADA' THEN 2
                   WHEN 'SO_FALTA_DANFE' THEN 3 WHEN 'CERTA' THEN 4 ELSE 5 END,
                 u.nome`,
    )
    .all(mes, ...argsEscopo);

  const semEnviar = db
    .prepare(
      `SELECT u.id, u.nome, u.login, u.empresa, u.funcao,
              -- Comecou a preencher (tem dia lancado ou arquivo anexado) e nao enviou.
              EXISTS (
                SELECT 1 FROM relatorios r
                 WHERE r.usuario_id = u.id AND r.mes_ref = ?
                   AND (EXISTS (SELECT 1 FROM linhas l WHERE l.relatorio_id = r.id)
                     OR EXISTS (SELECT 1 FROM anexos a WHERE a.relatorio_id = r.id))
              ) AS comecou
         FROM usuarios u
        WHERE u.ativo = 1 AND u.papel = 'colaborador' ${filtro}
          AND u.id NOT IN (
            SELECT usuario_id FROM relatorios WHERE mes_ref = ? AND status <> 'RASCUNHO'
          )
        ORDER BY u.nome`,
    )
    .all(mes, ...argsEscopo, mes)
    .map((u) => ({ ...u, comecou: Boolean(u.comecou), cracha: cracha(u.empresa, u.funcao) }));

  const contagem = {};
  for (const l of linhas) contagem[l.status] = (contagem[l.status] || 0) + 1;

  responderJson(res, {
    mes,
    mes_extenso: mesPorExtenso(mes),
    escopo,
    ia_disponivel: iaDisponivel(),
    contagem,
    nao_enviaram: semEnviar,
    relatorios: linhas.map((r) => ({
      id: r.id,
      usuario_id: r.usuario_id,
      nome: r.nome,
      login: r.login,
      empresa: r.empresa,
      funcao: r.funcao,
      cracha: cracha(r.empresa, r.funcao),
      justificativa: r.justificativa,
      status: r.status,
      rotulo_status: ROTULO_STATUS[r.status],
      total_km: r.total_km,
      valor_km: r.valor_km,
      declarado: Number((r.pedagio_declarado + r.estac_declarado).toFixed(2)),
      // O que a pessoa recebe no mes, e o total que o proprio RDV declara
      // ("Subtotal das Despesas"). Os dois tem que ser o mesmo numero.
      total_a_receber: Number(
        (r.valor_km + r.pedagio_declarado + r.estac_declarado
          + (r.hotel_declarado || 0) + (r.outros_declarado || 0)).toFixed(2),
      ),
      subtotal_rdv: subtotalGravado(r.extraido),
      // Quem confere marca na mao o que ja foi para o papel.
      impresso_em: r.impresso_em || null,
      // 2o envio em diante: quantos erros do envio anterior sumiram.
      correcao: (() => {
        const c = correcaoDoReenvio(r);
        return c && { envio: c.envio, aguardando: c.aguardando, corrigidos: c.corrigidos.length, continuam: c.continuam.length };
      })(),
      comprovado: r.pedagio_comprovado,
      // Diferenca so existe quando ha DOIS numeros para comparar.
      //
      // Sem valor declarado nao ha divergencia nenhuma - o que havia era o
      // comprovado inteiro sendo repetido na coluna de diferenca e pintado de
      // vermelho, num relatorio que estava aprovado. Isso apontava erro onde
      // nao tinha, que e o pior tipo de alerta: ensina a ignorar a coluna.
      diferenca: diferencaDePedagio(r),
      o_que_fazer: r.o_que_fazer,
      // Parecer julgado por regra anterior a atual. Nao e erro: e aviso de que
      // este relatorio nao passou pelas regras de hoje.
      regras_antigas: Boolean(r.conferido_em) && (r.versao_regras ?? 0) < VERSAO_REGRAS,
      enviado_em: r.enviado_em,
      conferido_em: r.conferido_em,
      achados: listaDeJson(r.achados),
    })),
  });
}

// Os erros de um parecer gravado, so com o que precisa para comparar.
function errosDoParecer(achadosJson) {
  const erros = (listaDeJson(achadosJson) || []).filter((a) => a.gravidade === 'erro');
  return erros.length ? erros.map((a) => ({ codigo: a.codigo, mensagem: a.mensagem, data: a.data || null })) : null;
}

/**
 * Reenvio: o que estava errado no envio anterior e foi corrigido, e o que
 * continua. null no primeiro envio. Enquanto a conferencia do novo envio nao
 * roda, `aguardando` fica true e nada e dado como corrigido.
 */
function correcaoDoReenvio(r) {
  if (!(r.envios > 1)) return null;
  // Envio anterior sem erro grava null: lista vazia, senao o painel cai.
  const anteriores = listaDeJson(r.erros_do_envio_anterior) || [];
  const chave = (a) => `${a.codigo}|${a.data || ''}`;
  if (!r.conferido_em) {
    return { envio: r.envios, aguardando: true, corrigidos: [], continuam: [], anteriores: anteriores.length };
  }
  const atuais = new Set((listaDeJson(r.achados) || []).filter((a) => a.gravidade === 'erro').map(chave));
  return {
    envio: r.envios,
    aguardando: false,
    corrigidos: anteriores.filter((a) => !atuais.has(chave(a))),
    continuam: anteriores.filter((a) => atuais.has(chave(a))),
    anteriores: anteriores.length,
  };
}

// O subtotal do RDV guardado junto da leitura, ou null.
function subtotalGravado(extraido) {
  if (!extraido) return null;
  try {
    const v = JSON.parse(extraido)?.totais_declarados?.subtotal;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function relatorioDetalhe(res, url, quem) {
  const id = Number(url.searchParams.get('id'));
  const rel = db
    .prepare(
      `SELECT r.*, u.nome, u.login, u.placas, u.empresa, u.funcao, u.carro FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id WHERE r.id = ?`,
    )
    .get(id);
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);
  if (!podeVerUsuario(quem, rel)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

  const linhas = linhasDo(rel.id);
  const anexos = anexosDo(rel.id);

  // O que estaria pendente se a conferencia rodasse agora.
  //
  // `rel.achados` e o parecer GRAVADO: so existe depois que alguem conferiu.
  // Enquanto o relatorio e rascunho, ou foi enviado e ninguem olhou ainda,
  // aquela coluna esta vazia - e o admin abria e nao via pendencia nenhuma,
  // mesmo faltando a nota e a foto do odometro.
  //
  // O `rel` cru e de proposito - `conferir` le `rel.extraido` como texto e
  // faz o proprio JSON.parse. O objeto ja parseado vai na resposta abaixo.
  const pendenciasAgora = conferirRel(rel, linhas, anexos);

  responderJson(res, {
    relatorio: {
      ...rel,
      rotulo_status: ROTULO_STATUS[rel.status],
      mes_extenso: mesPorExtenso(rel.mes_ref),
      achados: listaDeJson(rel.achados),
      vetos: listaDeJson(rel.vetos) || [],
      regras_antigas: Boolean(rel.conferido_em) && (rel.versao_regras ?? 0) < VERSAO_REGRAS,
      parecer_ia: rel.parecer_ia ? JSON.parse(rel.parecer_ia) : null,
      assinatura: rel.assinatura ? JSON.parse(rel.assinatura) : null,
      extraido: rel.extraido ? JSON.parse(rel.extraido) : null,
    },
    linhas,
    anexos,
    // Só sai por esta rota, que é do admin. A rota do colaborador
    // (`/api/relatorio`) não tem este campo, e a prévia dele continua sem as
    // cobranças de anexo.
    pendencias_agora: pendenciasAgora,
    correcao: correcaoDoReenvio(rel),
    // Para a tela de edicao refazer as contas enquanto o admin digita.
    valor_do_km: valorDoKm(),
    gerente: pagoPorCombustivel(rel.funcao, rel.carro, linhas),
    // Carro da empresa nao manda foto do odometro: o "o que falta chegar" do
    // painel nao pode cobrar. O RDV com combustivel por dia vale como carro da
    // empresa mesmo com o cadastro atrasado, igual na conferencia.
    cobra_odometro: cobraFotoOdometro(
      rel.empresa,
      rel.funcao,
      linhas.some((l) => Number(l.combustivel) > 0) ? 'empresa' : rel.carro,
    ),
  });
}

/**
 * A conferencia em si, sem depender de quem pediu.
 *
 * Nasceu presa a rota do admin, e por isso so acontecia quando alguem clicava
 * "Conferir os pendentes com IA". Quem enviava o relatorio e olhava o painel
 * via o pedagio zerado - o `pedagio_comprovado` e preenchido AQUI, pela leitura
 * do extrato, e em lugar nenhum antes disso.
 *
 * Agora tambem roda sozinha logo depois do envio, sem ninguem clicar. As duas
 * portas entram por esta funcao para nao existirem duas conferencias com
 * regras que podem divergir com o tempo.
 *
 * `decididoPor` e null quando foi automatica - o painel mostra que o veredito
 * nao veio da mao de um administrador.
 *
 * Lanca erro se a IA falhar; quem chama decide o que fazer com isso.
 */
/**
 * O arquivo que a IA apontou, casado com um anexo DE VERDADE deste relatorio.
 *
 * O nome vem de um modelo, entao ele nao vira link por decreto: so o que casa
 * com um anexo do proprio relatorio ganha `anexo_id`, e e o id - nunca o texto
 * do modelo - que monta a URL. Assim um nome inventado nao abre arquivo de
 * ninguem.
 *
 * Quando nao casa, o nome ainda aparece na tela como texto: quase sempre e o
 * mesmo arquivo com uma diferenca boba de escrita, e dizer "a foto tal" ajuda
 * mais que nao dizer nada. O que ele nao ganha e o link.
 */
export function anexoDoAchado(nomeDito, anexos, relId) {
  const nome = String(nomeDito || '').trim();
  if (!nome) return { anexo_id: null, anexo_nome: null };

  const chave = (t) => String(t || '').trim().toLowerCase();
  const achado = anexos.find((a) => chave(a.nome_original) === chave(nome));
  if (achado) return { anexo_id: achado.id, anexo_nome: achado.nome_original };

  log.aviso('ia', 'a IA citou um anexo que nao existe no relatorio', { rel: relId, citado: nome.slice(0, 120) });
  return { anexo_id: null, anexo_nome: nome.slice(0, 120) };
}

// Relatorios com uma conferencia em andamento (ou esperando a vez da IA).
//
// Sem isto, o envio disparava a conferencia automatica e, minutos depois, o
// "Conferir os pendentes" pegava o mesmo relatorio ainda em CONFERINDO e
// rodava de novo. Se a mais lenta falhasse depois da outra ter fechado o
// veredito, o catch devolvia o status antigo e o veredito sumia.
const conferindoAgora = new Set();

function conferenciaNaoRoda(motivo) {
  const e = new Error(motivo);
  e.naoRodou = true;
  return e;
}

async function conferirRelatorio(rel, opcoes = {}) {
  const { usarIa = true, demo = false, decididoPor = null } = opcoes;
  if (conferindoAgora.has(rel.id)) {
    throw conferenciaNaoRoda('Esse relatorio ja esta sendo conferido. Aguarde o resultado.');
  }
  conferindoAgora.add(rel.id);
  try {
    if (demo || !usarIa || !iaDisponivel()) return await conferirRelatorioAgora(rel, opcoes);

    // Quem clicou no painel passa na frente dos envios automaticos: ele esta
    // olhando para a tela esperando.
    return await naVezDaIa(async () => {
      // A espera pode levar minutos. Le de novo: se alguem decidiu na mao ou
      // o relatorio mudou nesse meio tempo, a conferencia nao roda por cima.
      const atual = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
      if (!atual || atual.status !== rel.status) {
        throw conferenciaNaoRoda('O relatorio mudou enquanto esperava a vez da conferencia.');
      }
      return conferirRelatorioAgora(atual, opcoes);
    }, { primeiro: decididoPor != null });
  } finally {
    conferindoAgora.delete(rel.id);
  }
}

async function conferirRelatorioAgora(rel, { usarIa = true, demo = false, decididoPor = null } = {}) {
  let usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(rel.usuario_id);
  let linhas = linhasDo(rel.id);
  const anexos = db.prepare('SELECT * FROM anexos WHERE relatorio_id = ?').all(rel.id);
  const vlrKm = valorDoKm();

  // Conferir sem os comprovantes daria parecer falso ("faltou a nota").
  const arquivado = anexos.find((a) => a.arquivado_em);
  if (arquivado) {
    throw conferenciaNaoRoda(
      `Os comprovantes deste relatorio foram arquivados (bloco ${arquivado.arquivado_bloco}). `
        + 'Devolva o bloco ao portal antes de conferir de novo.',
    );
  }

  // Anexou o RDV e enviou sem tocar em "Ler meu relatorio": o arquivo esta
  // aqui, entao a conferencia le antes de reclamar que nao ha dia nenhum.
  let motivoDaLeitura = '';
  const arquivosDoRdv = anexos.filter((a) => a.tipo === 'rdv').sort((a, b) => a.id - b.id);
  if (linhas.length === 0 && arquivosDoRdv.length) {
    try {
      await lerEGravarRdv(rel, usuario, arquivosDoRdv, rel.mes_ref);
      linhas = linhasDo(rel.id);
      rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
      usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(rel.usuario_id);
      log.info('relatorio', 'RDV enviado sem leitura - lido na conferencia', {
        rel: rel.id, quem: usuario.login, linhas: linhas.length,
      });
    } catch (e) {
      if (!e.naoLeu && !e.mesDoDocumento) throw e;
      motivoDaLeitura = e.message;
    }
  }

  if (linhas.length === 0) {
    const e = new Error(
      arquivosDoRdv.length
        ? `Nao consegui ler os dias do arquivo do RDV${motivoDaLeitura ? ` (${motivoDaLeitura})` : ''}. `
          + 'Abra o arquivo e decida na mao pelos botoes abaixo.'
        : 'Este relatorio nao tem os lancamentos dia a dia nem o arquivo do RDV. '
          + 'Decida na mao pelos botoes abaixo.',
    );
    e.semLinhas = true;
    throw e;
  }

  await garantirSubtotal(rel, anexos);
  const kmConsertado = consertarKmComPonto(linhas);
  // KM de foto gravado com fracao ("113,436"): e 113.436 digitado com a
  // virgula no lugar do ponto. Volta a ser inteiro, na lista e no banco.
  for (const a of anexos) {
    if (a.tipo !== 'odometro' || a.km == null) continue;
    const inteiro = odometroInteiro(a.km);
    if (inteiro !== Number(a.km)) {
      a.km = inteiro;
      db.prepare('UPDATE anexos SET km = ? WHERE id = ?').run(inteiro, a.id);
    }
  }
  const porRegra = conferirRel(rel, linhas, anexos, { comVetados: true });
  // Os dias mudaram: o total de km e o valor gravados eram a soma errada.
  if (kmConsertado) {
    db.prepare('UPDATE relatorios SET total_km = ?, valor_km = ? WHERE id = ?')
      .run(porRegra.totalKm, porRegra.valorKm, rel.id);
    log.info('relatorio', 'km com ponto de milhar lido como decimal - corrigido', {
      rel: rel.id, dias: kmConsertado, total_km: porRegra.totalKm,
    });
  }
  const daAssinatura = conferirAssinatura(rel, anexos, usuario);
  porRegra.achados.push(...daAssinatura.achados);

  let parecer = null;
  let avisoIa = null;
  let anexosIgnorados = [];

  if (demo) {
    parecer = conferirEmDemo({ rel, linhas, anexos, resultadoRegra: porRegra });
    avisoIa = 'MODO DEMONSTRACAO: nenhum comprovante foi lido. Este parecer e simulado e nao vale como conferencia.';
  } else if (usarIa && iaDisponivel()) {
    db.prepare('UPDATE relatorios SET status = ? WHERE id = ?').run('CONFERINDO', rel.id);
    try {
      const saida = await conferirComIa({ usuario, rel, linhas, anexos, resultadoRegra: porRegra, vlrKm });
      parecer = saida.parecer;
      anexosIgnorados = saida.anexosIgnorados;
      if (anexosIgnorados.length) {
        avisoIa = `Anexos nao lidos pela IA: ${textoDosIgnorados(anexosIgnorados)}`;
      }
    } catch (e) {
      // A IA fora do ar nao pode parar a conferencia: em 01/10 a conta ficou
      // sem credito e o portal inteiro devolvia 502 com gente enviando o mes.
      // Segue so com as regras; o que dependia de ler comprovante vira aviso.
      log.aviso('ia', 'IA falhou - conferencia so pelas regras', { rel: rel.id });
      avisoIa = 'A leitura dos comprovantes pela IA falhou - conferencia feita so pelas regras automaticas.';
    }
  } else if (usarIa && !iaDisponivel()) {
    avisoIa = 'Comprovantes lidos por codigo (sem IA).';
  }

  // Sem a IA, os comprovantes sao lidos por codigo: texto do PDF, OCR da foto,
  // QR code da nota. Ele confirma ou avisa - nunca reprova.
  let achadosDoCodigo = [];
  if (!parecer && !demo) {
    db.prepare('UPDATE relatorios SET status = ? WHERE id = ?').run('CONFERINDO', rel.id);
    try {
      const saida = await conferirPorCodigo({ rel, linhas, anexos, declarado: porRegra.totalDeclarado });
      parecer = saida.parecer;
      // Pedagio que uma conferencia anterior ja confirmou no centavo nao volta
      // a ser duvida so porque o OCR de hoje nao leu o cupom.
      const jaConfirmado = rel.pedagio_comprovado_admin != null || (rel.pedagio_comprovado != null
        && Math.round(rel.pedagio_comprovado * 100) === Math.round(porRegra.totalDeclarado * 100));
      // E se a conferencia anterior ja acusa diferenca em vermelho, o amarelo
      // com OUTRO numero so confunde: fica o vermelho, que ja manda conferir.
      const jaAcusado = porRegra.achados.some((a) => a.codigo === 'pedagio_diferenca');
      achadosDoCodigo = saida.achados.filter(
        (a) => !((jaConfirmado || jaAcusado) && a.codigo === 'pedagio_nao_confirmado'),
      );
      avisoIa ??= 'Comprovantes lidos por codigo (sem IA).';
    } catch (e) {
      log.falha('leitura', 'conferencia por codigo falhou', e, { rel: rel.id });
      db.prepare('UPDATE relatorios SET status = ? WHERE id = ?').run(rel.status, rel.id);
    }
  }
  const porCodigo = parecer?.por === 'codigo';

  // O comprovado que o admin digitou na mao vale mais que qualquer leitura:
  // ele abriu o comprovante e somou. Sem isto, conferir de novo desfazia a
  // correcao dele.
  const comprovadoDoAdmin = rel.pedagio_comprovado_admin ?? null;
  if (comprovadoDoAdmin != null && parecer && !demo) parecer.pedagio_comprovado = comprovadoDoAdmin;

  const achados = [...porRegra.achados, ...achadosDoCodigo];
  // Sem a leitura, ninguem somou os comprovantes. Fica dito, em amarelo, para
  // quem confere olhar o valor na mao - senao o relatorio sairia CERTA calado.
  if (!parecer && !demo && comprovadoDoAdmin == null && porRegra.totalDeclarado > 0
      && !achados.some((a) => a.codigo === 'pedagio_sem_comprovante')) {
    achados.push({
      gravidade: 'aviso',
      codigo: 'pedagio_nao_conferido',
      mensagem: `Pedagio/estacionamento de ${porRegra.totalDeclarado.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} `
        + 'declarado: o valor dos comprovantes nao foi lido automaticamente. Confira na mao.',
      data: null,
    });
  }
  if (parecer) {
    for (const a of parecer.achados || []) {
      // Passa pelo saneador: o texto vem de um modelo e vai direto para a tela.
      achados.push({
        gravidade: gravidadeDoAchadoDaIa(a),
        codigo: 'ia',
        mensagem: textoDaIa(a.mensagem, 160),
        data: null,
        ...anexoDoAchado(a.anexo, anexos, rel.id),
      });
    }
    if (parecer.tem_danfe_de_abastecimento) {
      const i = achados.findIndex((a) => a.codigo === 'sem_danfe');
      if (i >= 0) achados.splice(i, 1);
    }
  }

  // Selo do gov.br em cima da placa: a placa some do documento e ninguem
  // consegue conferir o veiculo. Reprova - mas so quando a CONTA diz que cobre
  // (posicao do selo contra a posicao do numero da placa no PDF). A IA julgava
  // isso pela imagem e acusava selo que estava so encostado, na caixa de
  // assinatura logo abaixo da placa; onde o codigo nao enxerga (escaneado,
  // assinado a mao), a opiniao dela vira aviso para quem confere olhar.
  if (!demo) {
    const porCodigoNaPlaca = await placaCobertaNosRdvs(anexos);
    if (porCodigoNaPlaca?.situacao === 'sim') {
      achados.push({
        gravidade: 'erro',
        codigo: 'assinatura_sobre_placa',
        mensagem: 'A assinatura esta em cima da placa do veiculo no RDV. Assine de novo deixando a placa visivel.',
        data: null,
        anexo_id: porCodigoNaPlaca.anexo.id,
        anexo_nome: porCodigoNaPlaca.anexo.nome_original,
      });
    } else if (!porCodigoNaPlaca && parecer?.assinatura_sobre_placa?.situacao === 'sim') {
      achados.push({
        gravidade: 'aviso',
        codigo: 'assinatura_perto_da_placa',
        mensagem: 'A assinatura pode estar em cima da placa do veiculo no RDV. Abra o documento e confira se a placa esta visivel.',
        data: null,
        ...anexoDoAchado(parecer.assinatura_sobre_placa.anexo, anexos, rel.id),
      });
    }

    // RDV sem assinatura nenhuma - nem gov.br, nem a mao - reprova. E quando
    // ninguem conseguiu confirmar (escaneado ou foto, sem a IA) tambem: como
    // aviso, relatorio sem assinatura saia aprovado.
    const assinado = rdvEstaAssinado(await assinaturaDosRdvs(anexos), parecer?.rdv_assinado);
    if (assinado === 'nao') {
      achados.push({
        gravidade: 'erro',
        codigo: 'sem_assinatura',
        mensagem: 'O RDV nao esta assinado. Assine no gov.br ou a mao e envie de novo.',
        data: null,
      });
    } else if (assinado === null) {
      achados.push({
        gravidade: 'erro',
        codigo: 'assinatura_nao_confirmada',
        mensagem: 'Nao foi possivel confirmar a assinatura do RDV: nao tem assinatura do gov.br e a assinatura a mao nao foi reconhecida. Confira o documento; se estiver assinado, aprove na mao.',
        data: null,
      });
    }
  }

  // Anexo que a conferencia nem conseguiu abrir vira pendencia com nome e
  // motivo.
  //
  // Isto so existia como aviso na resposta do administrador - e na conferencia
  // automatica do envio nem isso, so uma linha de log. O vendedor mandava um
  // PDF com senha, recebia um parecer que ignorava aquele comprovante e nao
  // tinha como saber qual arquivo o sistema nao leu.
  //
  // Aviso, e nao erro: o relatorio pode estar inteiro certo mesmo assim, e
  // reprovar por causa de um arquivo a mais seria pior que o problema.
  for (const i of anexosIgnorados) {
    achados.push({
      gravidade: 'aviso',
      codigo: 'anexo_nao_lido',
      mensagem: `A conferencia nao conseguiu ler este comprovante: ${i.motivo}. `
        + 'Reenvie em PDF ou foto, se ele for necessario.',
      data: null,
      anexo_id: i.id,
      anexo_nome: i.nome,
    });
  }

  // A diferenca de pedagio so pode ser julgada AGORA, depois da IA.
  //
  // O `porRegra` la em cima comparou `rel.pedagio_comprovado`, que na primeira
  // conferencia ainda e NULL - o envio zera. Quem descobre o valor e a IA, que
  // acabou de ler o extrato. Sem esta chamada, um RDV com R$ 10 de diferenca
  // saia APROVADO, e so reprovava se alguem clicasse "Conferir de novo".
  //
  // Qualquer centavo conta.
  //
  // Numa RECONFERENCIA o `porRegra` usou o comprovado da rodada anterior. Se a
  // IA acabou de ler um valor, e ele que vale: o achado velho sai. Senao, quem
  // anexava o extrato certo e pedia "Conferir de novo" continuava reprovado
  // pelo numero do extrato ilegivel ate uma segunda reconferencia.
  if (parecer && parecer.pedagio_comprovado != null) {
    for (let i = achados.length - 1; i >= 0; i--) {
      if (achados[i].codigo === 'pedagio_diferenca') achados.splice(i, 1);
    }
  }
  if (parecer && !achados.some((a) => a.codigo === 'pedagio_diferenca')) {
    const d = achadoDeDiferenca(porRegra.totalDeclarado, parecer.pedagio_comprovado ?? null);
    if (d) achados.push(d);
  }

  // Passagem depois das 18h precisa de explicacao, e a hora vem do EXTRATO -
  // lida agora pela IA, nao do que a pessoa digitou. Cada uma e cobrada contra
  // a explicacao do dia dela, entao ele responde no proprio dia da despesa.
  //
  // Vale para DSO e PROMOTORES. A DISO ficou de fora - a propria regra trata
  // disso, por isso a empresa do dono do relatorio vai junto.
  if (parecer) {
    achados.push(...passagensSemExplicacao(parecer.passagens_apos_18h, linhas, usuario.empresa));
  }

  // Pedagio batendo centavo a centavo: o que a IA escreveu sobre ele e ida e
  // volta na mesma praca, que e o normal e nao precisa nem de aviso.
  if (parecer?.pedagio_comprovado != null && !achados.some((a) => a.codigo === 'pedagio_diferenca')) {
    for (let i = achados.length - 1; i >= 0; i--) {
      if (achados[i].codigo === 'ia' && achadoDaIaSobrePedagio(achados[i])) achados.splice(i, 1);
    }
  }

  // O que o conferente vetou neste relatorio sai do parecer e nao conta. O veto
  // guarda o que a conferencia de hoje apitou, para a tela mostrar o que ficou
  // de fora.
  const vetos = listaDeJson(rel.vetos) || [];
  if (vetos.length) {
    const vetados = separarVetados(achados, vetos);
    for (const v of vetos) v.itens = vetados.filter((a) => chaveDoVeto(a) === v.chave);
  }

  const erros = achados.filter((a) => a.gravidade === 'erro');
  const statusDaConferencia = statusPelosErros(achados);

  // A decisao que o conferente tomou na mao se mantem. Conferir de novo
  // atualiza os achados - para ele ver o que a conferencia aponta hoje -, mas
  // quem aprovou ou reprovou foi uma pessoa olhando o documento, e uma regra
  // nova nao desfaz isso calada. So o reenvio pelo colaborador zera.
  const manual = ['CERTA', 'SO_FALTA_DANFE', 'ERRADA'].includes(rel.decisao_manual) ? rel.decisao_manual : null;
  const status = manual || statusDaConferencia;
  if (manual && manual !== statusDaConferencia) {
    const quem = db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(rel.decidido_por)?.nome;
    achados.unshift({
      gravidade: 'aviso',
      codigo: 'decisao_manual',
      mensagem: `${manual === 'CERTA' ? 'Aprovado' : manual === 'ERRADA' ? 'Reprovado' : 'Marcado como so falta DANFE'} na mao`
        + `${quem ? ` por ${quem}` : ''}. A conferencia automatica daria "${ROTULO_STATUS[statusDaConferencia]}"; `
        + 'a decisao do conferente foi mantida.',
      data: null,
    });
  }
  // Fica no registro do servidor o que cada conferencia concluiu: e o que
  // permite responder "por que o relatorio de fulano saiu reprovado".
  log.info('conferencia', `${rel.status} -> ${status}`, {
    rel: rel.id,
    de: usuario.nome,
    automatica: statusDaConferencia,
    manual: manual || undefined,
    erros: erros.map((e) => e.codigo).join(',') || 'nenhum',
  });

  // Se a IA quis reprovar por pedagio, o "o que fazer" dela manda corrigir o
  // que nao esta errado. Nesse caso vale o texto montado dos erros de verdade.
  const iaErrouDePedagio = (parecer?.achados || []).some(
    (a) => a.gravidade === 'erro' && gravidadeDoAchadoDaIa(a) === 'aviso',
  );
  const oQueFazer = manual ? (rel.o_que_fazer || '') :
    (iaErrouDePedagio ? '' : textoDaIa(parecer?.o_que_fazer, 220))
    || (status === 'CERTA'
      ? ''
      : erros.map((e) => e.mensagem).join(' ') || 'Corrija os pontos apontados e reenvie.');

  // O declarado tambem e regravado aqui, nao so o comprovado.
  //
  // Ele era gravado apenas na leitura do RDV. Quando a regra de como calcular o
  // declarado mudou - passar a usar o total do quadro de resumo quando o
  // formulario nao tem coluna por dia -, os relatorios ja enviados ficaram com
  // o valor velho, e nao havia como corrigir sem a pessoa reenviar o mes.
  // Conferindo de novo, o valor se acerta.
  db.prepare(
    `UPDATE relatorios
        SET status = ?, achados = ?, parecer_ia = ?, o_que_fazer = ?,
            pedagio_comprovado = ?, conferido_em = ?, decidido_por = ?,
            pedagio_declarado = ?, estac_declarado = ?, versao_regras = ?, vetos = ?
      WHERE id = ?`,
  ).run(
    status,
    JSON.stringify(achados),
    parecer ? JSON.stringify(parecer) : null,
    oQueFazer,
    // Leitura por codigo que nao confirmou nao apaga o que ja se sabia: fica o
    // comprovado da conferencia anterior (ou nada).
    porCodigo
      ? (parecer.pedagio_comprovado ?? rel.pedagio_comprovado ?? null)
      : parecer ? Number(parecer.pedagio_comprovado ?? 0) : comprovadoDoAdmin,
    agora(),
    // Com decisao na mao, quem decidiu continua sendo quem decidiu.
    manual ? rel.decidido_por : decididoPor,
    porRegra.pedagioDeclarado,
    porRegra.estacDeclarado,
    // Em que versao das regras este parecer foi julgado. E o que permite o
    // painel avisar quando um relatorio ficou para tras.
    VERSAO_REGRAS,
    vetos.length ? JSON.stringify(vetos) : null,
    rel.id,
  );

  return { status, achados, parecer, aviso: avisoIa };
}

/**
 * A tela "Tudo": o portal inteiro numa resposta so.
 *
 * Existe porque as respostas estavam espalhadas - quanto entrou neste mes, o
 * que quebrou hoje, quanto a IA gastou, se a fila esta andando, se o disco
 * aguenta. Cada uma dessas morava numa tela diferente, ou so no painel da
 * Railway. Aqui e uma pagina com o retrato completo, e so quem ve tudo abre.
 */
function verTudo(res, quem) {
  const meses = db
    .prepare(
      `SELECT mes_ref,
              COUNT(*) AS total,
              SUM(status = 'CERTA') AS certas,
              SUM(status = 'SO_FALTA_DANFE') AS so_danfe,
              SUM(status = 'ERRADA') AS erradas,
              SUM(status IN ('ENVIADO','CONFERINDO')) AS pendentes,
              SUM(status = 'RASCUNHO') AS rascunhos,
              ROUND(SUM(valor_km + pedagio_declarado + estac_declarado + hotel_declarado + outros_declarado), 2) AS dinheiro,
              ROUND(SUM(total_km), 0) AS km
         FROM relatorios
        GROUP BY mes_ref ORDER BY mes_ref DESC LIMIT 12`,
    )
    .all();

  const porEmpresa = db
    .prepare(
      `SELECT u.empresa,
              COUNT(DISTINCT u.id) AS pessoas,
              SUM(u.ativo) AS ativos,
              COUNT(r.id) AS relatorios,
              ROUND(SUM(COALESCE(r.valor_km, 0) + COALESCE(r.pedagio_declarado, 0)
                        + COALESCE(r.estac_declarado, 0) + COALESCE(r.hotel_declarado, 0)
                        + COALESCE(r.outros_declarado, 0)), 2) AS dinheiro
         FROM usuarios u LEFT JOIN relatorios r ON r.usuario_id = u.id
        GROUP BY u.empresa ORDER BY u.empresa`,
    )
    .all();

  const mesAtualRef = mesAtual();
  const semEnviar = db
    .prepare(
      `SELECT u.nome, u.login, u.empresa, u.funcao
         FROM usuarios u
        WHERE u.ativo = 1 AND u.papel = 'colaborador'
          AND NOT EXISTS (
            SELECT 1 FROM relatorios r
             WHERE r.usuario_id = u.id AND r.mes_ref = ? AND r.status <> 'RASCUNHO')
        ORDER BY u.empresa, u.nome`,
    )
    .all(mesAtualRef);

  // Relatorios julgados por regra antiga: sao os que merecem reconferencia.
  const atrasados = db
    .prepare(
      `SELECT COUNT(*) AS n FROM relatorios
        WHERE conferido_em IS NOT NULL AND COALESCE(versao_regras, 0) < ?`,
    )
    .get(VERSAO_REGRAS).n;

  return responderJson(res, {
    quem: quem.login,
    agora: agora(),
    versao_regras: VERSAO_REGRAS,
    saude: checarSaude(),
    fila: estadoDaFila(),
    dados: resumoDosDados(),
    ia: { disponivel: iaDisponivel(), ...log.usoDaIa() },
    meses,
    por_empresa: porEmpresa,
    mes_atual: mesAtualRef,
    sem_enviar: semEnviar,
    conferidos_com_regra_antiga: atrasados,
    erros: log.recentes({ quantos: 60, nivel: 'ERRO' }),
    avisos: log.recentes({ quantos: 60, nivel: 'AVISO' }),
    eventos: log.recentes({ quantos: 80 }),
  });
}

/**
 * Enfileira a conferencia dos pendentes do mes e responde na hora.
 *
 * A conferencia roda no servidor, nao no navegador: o administrador pode
 * fechar a aba, trocar de mes ou ir embora, que os relatorios continuam sendo
 * conferidos. O painel acompanha por /api/admin/fila.
 */
async function conferirPendentes(req, res, admin) {
  const { mes, demo = false } = await lerJson(req);
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  // So os deste mes, so os pendentes, e so os que este administrador pode ver.
  const pendentes = db
    .prepare(
      `SELECT r.id, r.usuario_id, u.nome, u.empresa FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.mes_ref = ? AND r.status IN ('ENVIADO', 'CONFERINDO')
        ORDER BY u.nome`,
    )
    .all(mes)
    .filter((r) => podeVerUsuario(admin, r));

  if (!pendentes.length) return erro(res, 'Nao ha relatorio pendente de conferencia neste mes.');

  const resposta = comecarFila({
    itens: pendentes,
    mes,
    demo,
    quem: admin.login,
    processar: async (item) => {
      const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(item.id);
      // Alguem pode ter conferido na mao enquanto a fila andava.
      if (!rel || !['ENVIADO', 'CONFERINDO'].includes(rel.status)) return;
      try {
        await conferirRelatorio(rel, { usarIa: true, demo, decididoPor: admin.id });
      } catch (e) {
        // Ja estava sendo conferido (o envio dispara sozinho) ou mudou na
        // espera: nao e falha, alguem ja cuidou dele.
        if (!e.naoRodou) throw e;
      }
    },
  });

  return responderJson(res, resposta);
}

async function conferirUm(req, res, admin) {
  const { relatorio_id, usar_ia = true, demo = false } = await lerJson(req);
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);
  if (rel.status === 'RASCUNHO') return erro(res, 'Esse relatorio ainda nao foi enviado.');

  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(rel.usuario_id);
  if (!podeVerUsuario(admin, usuario)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

  try {
    const r = await conferirRelatorio(rel, { usarIa: usar_ia, demo, decididoPor: admin.id });
    return responderJson(res, { ok: true, ...r, rotulo_status: ROTULO_STATUS[r.status] });
  } catch (e) {
    if (e.semLinhas || e.naoRodou) return erro(res, e.message, 409);
    log.falha('ia', 'conferencia falhou', e, { rel: rel.id, por: admin?.login });
    return erro(res, `Falha na conferencia com IA: ${e.message}`, 502);
  }
}

async function decidir(req, res, admin) {
  const { relatorio_id, status, o_que_fazer } = await lerJson(req);
  if (!['CERTA', 'SO_FALTA_DANFE', 'ERRADA'].includes(status)) {
    return erro(res, 'Status invalido.');
  }
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);

  const dono = db.prepare('SELECT nome, empresa, funcao FROM usuarios WHERE id = ?').get(rel.usuario_id);
  if (!podeVerUsuario(admin, dono)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

  db.prepare(
    `UPDATE relatorios SET status = ?, o_que_fazer = ?, conferido_em = ?, decidido_por = ?,
            decisao_manual = ? WHERE id = ?`,
  ).run(status, String(o_que_fazer || '').slice(0, 2000), agora(), admin.id, status, rel.id);

  // A decisao que libera ou trava o reembolso. O banco guarda so o estado
  // final; o log guarda a sequencia - quem decidiu o que, e quando mudou de
  // ideia. E a pergunta que aparece quando alguem contesta um valor.
  log.info('decisao', `${rel.status} -> ${status}`, {
    rel: rel.id,
    mes: rel.mes_ref,
    de: dono.nome,
    por: admin.login,
    valor: rel.valor_km,
  });

  responderJson(res, { ok: true, status, rotulo_status: ROTULO_STATUS[status] });
}

/**
 * Veta (ou devolve) um erro apitado num relatorio ja conferido.
 *
 * Nao roda a conferencia de novo: mexe no parecer gravado, que e o que o
 * conferente esta olhando, e refaz o status pelos erros que sobraram. Decisao
 * tomada na mao continua mandando no status.
 */
async function vetarErro(req, res, admin) {
  const { relatorio_id, chave, vetar = true } = await lerJson(req);
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);

  const dono = db.prepare('SELECT nome, empresa, funcao FROM usuarios WHERE id = ?').get(rel.usuario_id);
  if (!podeVerUsuario(admin, dono)) return erro(res, 'Esse relatorio e de outra empresa.', 403);
  if (!['CERTA', 'SO_FALTA_DANFE', 'ERRADA'].includes(rel.status) || rel.achados == null) {
    return erro(res, 'So da para vetar erro de relatorio ja conferido. Confira primeiro.');
  }

  const achados = listaDeJson(rel.achados) || [];
  let vetos = listaDeJson(rel.vetos) || [];
  const jaVetado = vetos.find((v) => v.chave === chave);

  if (vetar) {
    if (jaVetado) return erro(res, 'Esse erro ja esta vetado.');
    const itens = separarVetados(achados, [{ chave }]);
    if (!itens.length) return erro(res, 'Esse erro nao esta mais no parecer. Abra o relatorio de novo.');
    vetos.push({ chave, codigo: itens[0].codigo, itens, por: admin.nome, por_id: admin.id, em: agora() });
  } else {
    if (!jaVetado) return erro(res, 'Esse erro nao esta vetado.');
    vetos = vetos.filter((v) => v !== jaVetado);
    achados.push(...(jaVetado.itens || []));
  }

  const manual = ['CERTA', 'SO_FALTA_DANFE', 'ERRADA'].includes(rel.decisao_manual) ? rel.decisao_manual : null;
  const status = manual || statusPelosErros(achados);
  const oQueFazer = manual
    ? (rel.o_que_fazer || '')
    : achados.filter((a) => a.gravidade === 'erro').map((a) => a.mensagem).join(' ');

  db.prepare(
    'UPDATE relatorios SET status = ?, achados = ?, vetos = ?, o_que_fazer = ?, decidido_por = ? WHERE id = ?',
  ).run(
    status,
    JSON.stringify(achados),
    vetos.length ? JSON.stringify(vetos) : null,
    oQueFazer,
    // O status mudou por causa de uma pessoa: fica o nome dela no parecer.
    status !== rel.status ? admin.id : rel.decidido_por,
    rel.id,
  );

  log.info('veto', vetar ? 'erro vetado' : 'veto desfeito', {
    rel: rel.id, mes: rel.mes_ref, de: dono.nome, por: admin.login, erro: chave.slice(0, 80),
    status: status !== rel.status ? `${rel.status} -> ${status}` : undefined,
  });

  responderJson(res, { ok: true, status, rotulo_status: ROTULO_STATUS[status] });
}

/**
 * Marca (ou desmarca) o relatorio como impresso.
 *
 * E so um lembrete de quem confere - "este eu ja mandei para a impressora" -
 * e nao muda status nem parecer. Cada relatorio e de uma pessoa num mes, entao
 * a marca de setembro nao vale para outubro.
 */
async function marcarImpresso(req, res, admin) {
  const { relatorio_id, impresso } = await lerJson(req);
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);

  const dono = db.prepare('SELECT nome, empresa, funcao FROM usuarios WHERE id = ?').get(rel.usuario_id);
  if (!podeVerUsuario(admin, dono)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

  const quando = impresso ? agora() : null;
  db.prepare('UPDATE relatorios SET impresso_em = ?, impresso_por = ? WHERE id = ?')
    .run(quando, impresso ? admin.id : null, rel.id);
  log.info('impressao', impresso ? 'marcado como impresso' : 'marca de impresso tirada', {
    rel: rel.id, mes: rel.mes_ref, de: dono.nome, por: admin.login,
  });
  responderJson(res, { ok: true, impresso_em: quando });
}

/**
 * O admin corrige os numeros de um relatorio na mao: os totais, o valor de
 * cada comprovante e os lancamentos dos dias.
 *
 * So chega aqui o que MUDOU - a tela manda o campo que a pessoa mexeu, nao o
 * formulario inteiro. Assim o log diz exatamente o que foi alterado, e o
 * pedagio comprovado so vira "digitado pelo admin" quando ele digitou mesmo.
 *
 * O parecer gravado nao muda aqui: ele e a foto da ultima conferencia. Quem
 * edita confere de novo (ou decide na mao) logo depois.
 */
async function editarRelatorio(req, res, admin) {
  const corpo = await lerJson(req);
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(corpo.relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);

  const dono = db.prepare('SELECT nome, empresa, funcao FROM usuarios WHERE id = ?').get(rel.usuario_id);
  if (!podeVerUsuario(admin, dono)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }
  if (rel.status === 'CONFERINDO' || conferindoAgora.has(rel.id)) {
    return erro(res, 'Esse relatorio esta sendo conferido agora. Espere terminar para editar.', 409);
  }

  // Numero digitado, ou a frase do que esta errado.
  const ruins = [];
  const valorDe = (bruto, nome, teto = 1_000_000) => {
    const n = numero(bruto, NaN);
    if (!Number.isFinite(n) || n < 0 || n > teto) {
      ruins.push(nome);
      return 0;
    }
    return n;
  };
  const vazio = (v) => v == null || String(v).trim() === '';

  const mudou = []; // para o log: "campo: antes -> depois"
  const sets = [];
  const args = [];

  const valores = corpo.valores && typeof corpo.valores === 'object' ? corpo.valores : {};
  const NOMES = {
    total_km: 'total de km',
    valor_km: 'valor do km',
    pedagio_declarado: 'pedagio declarado',
    estac_declarado: 'estacionamento declarado',
    hotel_declarado: 'hotel',
    outros_declarado: 'outras despesas',
  };
  const novos = {};
  let totaisEditados = false;
  for (const [campo, nome] of Object.entries(NOMES)) {
    if (valores[campo] === undefined) continue;
    const n = campo === 'total_km'
      ? valorDe(valores[campo], nome, 9_999_999)
      : Number(valorDe(valores[campo], nome).toFixed(2));
    novos[campo] = n;
    if (campo === 'total_km' || campo === 'valor_km') totaisEditados = true;
    sets.push(`${campo} = ?`);
    args.push(n);
    mudou.push(`${campo}: ${rel[campo]} -> ${n}`);
  }
  if (valores.pedagio_comprovado !== undefined) {
    // Em branco apaga a correcao do admin: a proxima conferencia volta a ler.
    const n = vazio(valores.pedagio_comprovado)
      ? null
      : Number(valorDe(valores.pedagio_comprovado, 'pedagio comprovado').toFixed(2));
    sets.push('pedagio_comprovado = ?', 'pedagio_comprovado_admin = ?');
    args.push(n, n);
    mudou.push(`pedagio_comprovado: ${rel.pedagio_comprovado} -> ${n}`);
  }

  const linhasDoRel = new Map(linhasDo(rel.id).map((l) => [l.id, l]));
  const linhasNovas = [];
  for (const l of Array.isArray(corpo.linhas) ? corpo.linhas : []) {
    const atual = linhasDoRel.get(Number(l?.id));
    if (!atual) return erro(res, 'Um dos lancamentos nao e deste relatorio. Abra o relatorio de novo.');
    const dia = atual.data.split('-').reverse().slice(0, 2).join('/');
    linhasNovas.push({
      id: atual.id,
      data: atual.data,
      // "111,961" digitado com virgula de milhar viraria 111,961 km: painel nao
      // marca fracao.
      km_inicial: odometroInteiro(valorDe(l.km_inicial, `KM inicial de ${dia}`, 9_999_999)),
      km_final: odometroInteiro(valorDe(l.km_final, `KM final de ${dia}`, 9_999_999)),
      itinerario: String(l.itinerario || '').trim().slice(0, 500),
      pedagio: Number(valorDe(l.pedagio, `pedagio de ${dia}`).toFixed(2)),
      estacionamento: Number(valorDe(l.estacionamento, `estacionamento de ${dia}`).toFixed(2)),
      combustivel: Number(valorDe(l.combustivel, `combustivel de ${dia}`).toFixed(2)),
    });
  }

  const anexosDoRel = new Map(
    db.prepare('SELECT * FROM anexos WHERE relatorio_id = ?').all(rel.id).map((a) => [a.id, a]),
  );
  const anexosNovos = [];
  for (const a of Array.isArray(corpo.anexos) ? corpo.anexos : []) {
    const atual = anexosDoRel.get(Number(a?.id));
    if (!atual) return erro(res, 'Um dos comprovantes nao e deste relatorio. Abra o relatorio de novo.');
    const novo = { id: atual.id, nome: atual.nome_original };
    if (a.valor !== undefined) {
      novo.valor = vazio(a.valor) ? null : Number(valorDe(a.valor, `valor de ${atual.nome_original}`, 100_000).toFixed(2));
    }
    if (a.km !== undefined && atual.tipo === 'odometro') {
      novo.km = vazio(a.km) ? null : odometroInteiro(valorDe(a.km, `KM da foto ${atual.nome_original}`, 9_999_999));
    }
    if (a.data_leitura !== undefined && atual.tipo === 'odometro') {
      if (vazio(a.data_leitura)) novo.data_leitura = null;
      else if (dataValida(String(a.data_leitura))) novo.data_leitura = String(a.data_leitura);
      else ruins.push(`dia da foto ${atual.nome_original}`);
    }
    anexosNovos.push({ ...novo, antes: atual });
  }

  if (ruins.length) {
    return erro(res, `Numero invalido em: ${ruins.slice(0, 5).join(', ')}. Confira e salve de novo.`);
  }
  if (!sets.length && !linhasNovas.length && !anexosNovos.length) {
    return erro(res, 'Nada foi alterado.');
  }

  db.exec('BEGIN');
  try {
    const gravarLinha = db.prepare(
      `UPDATE linhas SET km_inicial = ?, km_final = ?, itinerario = ?, pedagio = ?,
              estacionamento = ?, combustivel = ? WHERE id = ?`,
    );
    for (const l of linhasNovas) {
      gravarLinha.run(l.km_inicial, l.km_final, l.itinerario, l.pedagio, l.estacionamento, l.combustivel, l.id);
      mudou.push(`dia ${l.data}`);
    }

    for (const a of anexosNovos) {
      if ('valor' in a) {
        db.prepare('UPDATE anexos SET valor = ? WHERE id = ?').run(a.valor, a.id);
        mudou.push(`valor de ${a.nome}: ${a.antes.valor} -> ${a.valor}`);
      }
      if ('km' in a) {
        db.prepare('UPDATE anexos SET km = ? WHERE id = ?').run(a.km, a.id);
        mudou.push(`km de ${a.nome}: ${a.antes.km} -> ${a.km}`);
      }
      if ('data_leitura' in a) {
        db.prepare('UPDATE anexos SET data_leitura = ? WHERE id = ?').run(a.data_leitura, a.id);
        mudou.push(`dia de ${a.nome}: ${a.antes.data_leitura} -> ${a.data_leitura}`);
      }
    }

    // O total que o admin digitou passa a ser o DECLARADO. A conferencia
    // compara a soma dos dias com o que o documento dizia (`extraido`); sem
    // acertar isso junto, ela continuaria cobrando o numero antigo do PDF.
    if (rel.extraido && Object.keys(novos).length) {
      let doPdf = null;
      try {
        doPdf = JSON.parse(rel.extraido);
      } catch {
        doPdf = null;
      }
      if (doPdf && typeof doPdf === 'object') {
        const t = (doPdf.totais_declarados ??= {});
        if ('total_km' in novos) t.total_km = novos.total_km;
        if ('valor_km' in novos) t.valor_total_km = novos.valor_km;
        if ('hotel_declarado' in novos) t.hotel = novos.hotel_declarado;
        if ('outros_declarado' in novos) t.outros = novos.outros_declarado;
        if ('pedagio_declarado' in novos || 'estac_declarado' in novos) {
          t.pedagio_estacionamento = Number((
            (novos.pedagio_declarado ?? rel.pedagio_declarado ?? 0)
            + (novos.estac_declarado ?? rel.estac_declarado ?? 0)
          ).toFixed(2));
        }
        // O admin assumiu os numeros: o subtotal declarado acompanha a soma
        // deles, senao a conferencia cobraria o total antigo do documento.
        t.subtotal = Number(
          ['valor_km', 'pedagio_declarado', 'estac_declarado', 'hotel_declarado', 'outros_declarado']
            .reduce((s, c) => s + Number(novos[c] ?? rel[c] ?? 0), 0)
            .toFixed(2),
        );
        sets.push('extraido = ?');
        args.push(JSON.stringify(doPdf));
      }
    }

    // Total de km ou valor digitado na mao: a conferencia passa a usar esses
    // totais. Mexer so nos dias devolve a conta para a soma deles.
    if (totaisEditados) sets.push('totais_do_admin = 1');
    else if (linhasNovas.length) sets.push('totais_do_admin = 0');

    if (sets.length) {
      db.prepare(`UPDATE relatorios SET ${sets.join(', ')} WHERE id = ?`).run(...args, rel.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Dinheiro mudando de valor pela mao de alguem: fica escrito quem e o que.
  log.info('edicao', 'admin editou o relatorio', {
    rel: rel.id,
    mes: rel.mes_ref,
    de: dono.nome,
    por: admin.login,
    mudou: mudou.join('; ').slice(0, 1500),
  });

  responderJson(res, { ok: true });
}

function baixarBackup(res, quem) {
  const carimbo = new Date().toISOString().slice(0, 10);
  // Guardado para a tela poder dizer ha quanto tempo foi o ultimo. Backup que
  // depende de alguem lembrar so funciona se alguem for lembrado.
  gravarConfig('ultimo_backup_em', agora());
  log.info('backup', 'backup baixado', { por: quem?.login });
  return enviarBackup(res, `portal-rdv-backup-${carimbo}.zip`);
}

// ------------------------------------------------- arquivamento em blocos

function baixarBloco(res, url, quem) {
  const empresa = url.searchParams.get('empresa') || null;
  const usuarioId = Number(url.searchParams.get('usuario_id')) || null;
  if (empresa && !EMPRESAS.includes(empresa)) return erro(res, 'Empresa invalida.');
  if (!empresa && !usuarioId) return erro(res, 'Escolha a empresa ou a pessoa.');
  if (!enviarBloco(res, { empresa, usuarioId, quem })) {
    return erro(res, 'Nao ha comprovante de relatorio aprovado para arquivar aqui.', 404);
  }
}

async function liberarUmBloco(req, res, quem) {
  const { id, tamanho } = await lerJson(req);
  try {
    responderJson(res, { ok: true, ...liberarBloco(id, tamanho, quem) });
  } catch (e) {
    erro(res, e.message, 400);
  }
}

async function devolverUmBloco(req, res, quem) {
  try {
    responderJson(res, { ok: true, ...(await devolverBloco(req, quem)) });
  } catch (e) {
    log.aviso('arquivo', 'bloco nao devolvido', { por: quem?.login, motivo: e.message });
    erro(res, e.message, 400);
  }
}

async function subirBackup(req, res, quem) {
  // 500 MB: o backup carrega todos os anexos junto.
  const zip = await lerCorpo(req, 500 * 1024 * 1024);
  if (!zip.length) return erro(res, 'Nenhum arquivo recebido.');

  // O que esta saindo do lugar, registrado ANTES de ser substituido. E a acao
  // mais destrutiva do portal e a unica testemunha do que havia antes.
  const antes = resumoDosDados();

  try {
    const r = await restaurarBackup(zip);
    log.info('backup', 'DADOS RESTAURADOS', {
      por: quem?.login,
      antes: `${antes.usuarios}u/${antes.relatorios}r/${antes.anexos}a`,
      depois: `${r.usuarios ?? '?'}u/${r.relatorios ?? '?'}r/${r.anexos ?? '?'}a`,
    });
    responderJson(res, {
      ok: true,
      ...r,
      aviso: 'Dados restaurados. O portal reinicia sozinho agora - espere uns 30 segundos e recarregue a pagina.',
    });
  } catch (e) {
    log.aviso('backup', 'restauracao recusada', { por: quem?.login, motivo: e.message });
    erro(res, e.message, 400);
  } finally {
    // O banco foi fechado para receber o arquivo novo: nada mais funciona ate
    // reabrir. Sai com codigo 1 porque a Railway (ON_FAILURE) e o vigia.cmd so
    // religam processo que caiu com erro. O segundo de folga deixa a resposta
    // chegar no navegador.
    if (bancoFechadoPelaRestauracao()) {
      log.info('backup', 'reiniciando para abrir o banco restaurado');
      setTimeout(() => process.exit(1), 1500);
    }
  }
}

// Dias gravados com o ponto de milhar lido como decimal (61.35 no lugar de
// 61350): corrige na lista e no banco. Devolve quantos dias mudaram.
function consertarKmComPonto(linhas) {
  let mudaram = 0;
  const gravar = db.prepare('UPDATE linhas SET km_inicial = ?, km_final = ? WHERE id = ?');
  for (const l of linhas) {
    // Km inicial zerado: o km final e o total do dia, e fracao ali pode ser real.
    if (!(Number(l.km_inicial) > 0)) continue;
    const ki = odometroInteiro(l.km_inicial);
    const kf = odometroInteiro(l.km_final);
    if (ki === Number(l.km_inicial) && kf === Number(l.km_final)) continue;
    l.km_inicial = ki;
    l.km_final = kf;
    gravar.run(ki, kf, l.id);
    mudaram++;
  }
  return mudaram;
}

// O "Subtotal das Despesas" lido do texto do(s) PDF(s) de RDV, ou null.
async function subtotalDosRdvs(anexos) {
  for (const a of anexos) {
    if (a.tipo !== 'rdv' || !/\.pdf$/i.test(a.nome_original || '')) continue;
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(caminho)) continue;
    try {
      const valor = await subtotalDoRdv(caminho);
      if (valor != null) return valor;
    } catch {
      // PDF que nao abre: segue para o proximo
    }
  }
  return null;
}

// Relatorio lido antes de o portal guardar o subtotal do RDV: procura agora e
// grava junto da leitura, para a conferencia comparar com o total a receber.
// Roda uma vez so - depois a chave existe, com o valor ou com null.
async function garantirSubtotal(rel, anexos) {
  if (!rel.extraido) return;
  let doPdf;
  try {
    doPdf = JSON.parse(rel.extraido);
  } catch {
    return;
  }
  if (!doPdf || typeof doPdf !== 'object') return;
  const t = (doPdf.totais_declarados ??= {});
  if (t.subtotal !== undefined) return;
  t.subtotal = await subtotalDosRdvs(anexos);
  rel.extraido = JSON.stringify(doPdf);
  db.prepare('UPDATE relatorios SET extraido = ? WHERE id = ?').run(rel.extraido, rel.id);
}

// A assinatura cobre a placa em algum dos PDFs de RDV? Devolve
// `{ situacao: 'sim' | 'nao', anexo }`, ou null quando o codigo nao consegue
// dizer (ver placa.js). Um arquivo coberto basta para o "sim".
async function placaCobertaNosRdvs(anexos) {
  let visivel = null;
  for (const a of anexos) {
    if (a.tipo !== 'rdv' || !/\.pdf$/i.test(a.nome_original || '')) continue;
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(caminho)) continue;
    const r = await assinaturaSobrePlaca(caminho);
    if (r?.situacao === 'sim') return { situacao: 'sim', anexo: a };
    if (r?.situacao === 'nao') visivel = { situacao: 'nao', anexo: a };
  }
  return visivel;
}

// Mudou o jeito de olhar a assinatura? Sobe o numero e os anexos sao vistos de novo.
const VERSAO_DA_ASSINATURA = 1;

// O que o codigo consegue dizer da assinatura de cada arquivo de RDV: tem
// assinatura digital (ou o selo do gov.br), e se a caixa de assinatura do
// formulario esta em branco. Foto e papel escaneado ficam sem resposta - so
// olhando a imagem.
async function assinaturaDosRdvs(anexos) {
  const saida = [];
  for (const a of anexos) {
    if (a.tipo !== 'rdv') continue;
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    const item = { digital: false, caixa: null };
    const ehPdf = /\.pdf$/i.test(a.nome_original || '');
    const ehFoto = /\.(jpe?g|jfif|png|webp|gif)$/i.test(a.nome_original || '');

    // O arquivo de um anexo nao muda, e olhar a assinatura de um escaneado
    // custa um OCR: o que ja foi visto fica guardado.
    const guardada = db.prepare('SELECT leitura FROM leituras_codigo WHERE anexo_id = ?').get(a.id);
    if (guardada) {
      try {
        const visto = JSON.parse(guardada.leitura);
        if (visto.tipo === 'rdv-assinatura' && visto.versao === VERSAO_DA_ASSINATURA) {
          saida.push({ digital: visto.digital, caixa: visto.caixa });
          continue;
        }
      } catch {
        // leitura guardada corrompida: olha de novo
      }
    }

    if (ehFoto && fs.existsSync(caminho)) {
      // RDV fotografado: carimbo do gov.br ou tinta na caixa, vistos por OCR.
      const visto = await assinaturaNoEscaneado([caminho]);
      item.digital = visto.selo;
      item.caixa = visto.caixa;
    }
    if (ehPdf && fs.existsSync(caminho)) {
      const pdf = fs.readFileSync(caminho);
      try {
        item.digital = verificarAssinatura(pdf).assinado;
      } catch {
        item.digital = false;
      }
      if (!item.digital) {
        const visto = await assinaturaNoPdf(pdf);
        // O selo do gov.br na pagina vale mesmo quando o arquivo foi salvo de
        // novo depois de assinado e perdeu a assinatura digital.
        item.digital = visto.selo;
        item.caixa = visto.caixa;
        // PDF sem texto e papel escaneado: a assinatura esta na imagem.
        if (!item.digital && item.caixa == null) {
          const naImagem = await assinaturaNoEscaneado(await paginasDoPdfComoImagem(caminho, 2));
          item.digital = naImagem.selo;
          item.caixa = naImagem.caixa;
        }
      }
    }
    if (ehPdf || ehFoto) {
      db.prepare(
        'INSERT OR REPLACE INTO leituras_codigo (anexo_id, versao, feito_em, leitura) VALUES (?, ?, ?, ?)',
      ).run(a.id, VERSAO_DA_ASSINATURA, agora(), JSON.stringify({ tipo: 'rdv-assinatura', versao: VERSAO_DA_ASSINATURA, ...item }));
    }
    saida.push(item);
  }
  return saida;
}

// Verifica a assinatura digital do(s) arquivo(s) de RDV anexados.
function conferirAssinatura(rel, anexos, usuario) {
  const arquivos = anexos.filter(
    (a) => a.tipo === 'rdv' && /\.pdf$/i.test(a.nome_original || ''),
  );
  if (!arquivos.length) return { achados: [], resultado: null };

  const achados = [];
  const resultados = [];

  for (const a of arquivos) {
    const caminho = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(caminho)) continue;
    try {
      const r = verificarAssinatura(fs.readFileSync(caminho));
      resultados.push({ arquivo: a.nome_original, ...r });
      achados.push(...achadosDaAssinatura(r, usuario.nome));
    } catch (e) {
      // Nao verificar a assinatura deixou de ser pendencia (regras versao 5).
      log.aviso('assinatura', 'nao consegui verificar', { rel: rel.id, arquivo: a.nome_original, erro: e.message });
    }
  }

  if (resultados.length) {
    db.prepare('UPDATE relatorios SET assinatura = ? WHERE id = ?').run(
      JSON.stringify(resultados),
      rel.id,
    );
  }

  return { achados, resultado: resultados };
}

async function exportarHistorico(res, url, quem) {
  const id = Number(url.searchParams.get('usuario_id'));
  const usuario = db
    .prepare('SELECT id, nome, login, empresa, funcao, placas FROM usuarios WHERE id = ?')
    .get(id);
  if (!usuario) return erro(res, 'Colaborador nao encontrado.', 404);
  if (!podeVerUsuario(quem, usuario)) {
    return erro(res, 'Esse colaborador e de outra empresa.', 403);
  }

  const relatorios = db
    .prepare("SELECT * FROM relatorios WHERE usuario_id = ? AND status <> 'RASCUNHO'")
    .all(id)
    .map((r) => ({ ...r, achados: listaDeJson(r.achados) ?? [] }));

  if (relatorios.length === 0) {
    return erro(res, `${usuario.nome} ainda nao enviou nenhum relatorio.`, 404);
  }

  const anexos = db
    .prepare(
      `SELECT a.tipo, a.nome_original, a.tamanho, a.enviado_em, r.mes_ref
         FROM anexos a JOIN relatorios r ON r.id = a.relatorio_id
        WHERE r.usuario_id = ?
        ORDER BY r.mes_ref DESC, a.tipo, a.enviado_em`,
    )
    .all(id);

  const dados = Buffer.from(
    await gerarHistorico({ usuario, relatorios, anexos, valorKm: valorDoKm() }),
  );

  const nome = usuario.nome
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9 ]/g, '');

  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': dados.length,
    'Content-Disposition': `attachment; filename="Historico - ${nome}.xlsx"`,
  });
  res.end(dados);
}

// Confere se o admin pode olhar os dados daquele colaborador.
function alcanca(quem, usuarioId) {
  const alvo = db.prepare('SELECT empresa, funcao FROM usuarios WHERE id = ?').get(Number(usuarioId));
  if (!alvo) return null;
  return podeVerUsuario(quem, alvo) ? alvo : false;
}

function verGaleria(res, url, quem) {
  const id = Number(url.searchParams.get('usuario_id'));
  const alvo = alcanca(quem, id);
  if (alvo === null) return erro(res, 'Colaborador nao encontrado.', 404);
  if (alvo === false) return erro(res, 'Esse colaborador e de outra empresa.', 403);

  const g = galeriaDe(id);
  if (!g) return erro(res, 'Colaborador nao encontrado.', 404);
  responderJson(res, g);
}

/**
 * Caderno de comprovantes do mes, em PDF unico.
 *
 * Sem `usuario_id` sai o mes inteiro, uma pessoa depois da outra. Com ele, sai
 * so aquele colaborador.
 */
async function baixarImpressao(res, url, quem) {
  const mes = url.searchParams.get('mes');
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  const idBruto = url.searchParams.get('usuario_id');
  let id = null;
  if (idBruto) {
    id = Number(idBruto);
    const alvo = alcanca(quem, id);
    if (alvo === null) return erro(res, 'Colaborador nao encontrado.', 404);
    if (alvo === false) return erro(res, 'Esse colaborador e de outra empresa.', 403);
  }

  const caderno = await montarImpressao(mes, id, escopoDe(quem));
  if (!caderno) {
    return erro(res, 'Não há comprovantes nem RDV neste mês, então não dá para imprimir.', 404);
  }

  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${caderno.nome}"`,
    'Content-Length': caderno.bytes.length,
    'Cache-Control': 'no-store',
  });
  res.end(Buffer.from(caderno.bytes));
}

function baixarPacote(res, url, quem) {
  const id = Number(url.searchParams.get('usuario_id'));
  const mes = url.searchParams.get('mes');
  if (mes && !mesValido(mes)) return erro(res, 'Mes invalido.');

  const alvo = alcanca(quem, id);
  if (alvo === null) return erro(res, 'Colaborador nao encontrado.', 404);
  if (alvo === false) return erro(res, 'Esse colaborador e de outra empresa.', 403);

  if (!enviarPacote(res, id, mes || null)) {
    return erro(res, 'Colaborador nao encontrado.', 404);
  }
}

function listarUsuarios(res, quem) {
  const { sql: filtro, args } = filtroSql(quem);

  responderJson(
    res,
    db
      .prepare(
        `SELECT u.id, u.login, u.nome, u.email, u.papel, u.empresa, u.funcao, u.carro, u.placas, u.ativo,
                u.trocar_senha, u.criado_em,
                (SELECT COUNT(*) FROM anexos a
                   JOIN relatorios r ON r.id = a.relatorio_id
                  WHERE r.usuario_id = u.id) AS anexos,
                (SELECT COUNT(*) FROM relatorios r WHERE r.usuario_id = u.id) AS relatorios
           FROM usuarios u WHERE 1=1 ${filtro}
          ORDER BY u.papel DESC, u.empresa, u.funcao, u.nome`,
      )
      .all(...args)
      .map((u) => ({
        ...u,
        cracha: cracha(u.empresa, u.funcao),
        // A tela precisa saber em quem este admin pode mexer.
        editavel: podeMexerNoUsuario(quem, u),
      })),
  );
}

async function novoUsuario(req, res, quem) {
  const {
    login, nome, email, papel = 'colaborador', senha, placas,
    empresa = 'DISO', funcao = 'Vendedor', carro,
  } = await lerJson(req);
  if (!login || !nome || !senha) return erro(res, 'Login, nome e senha sao obrigatorios.');
  // Mesma regra da troca de login: minusculas, sem espaco, sem caractere solto.
  const { login: loginFinal, erro: recadoLogin } = loginNormalizado(login);
  if (recadoLogin) return erro(res, recadoLogin);
  if (String(senha).length < 6) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  if (!PAPEIS.includes(papel)) return erro(res, 'Perfil invalido.');
  if (!EMPRESAS.includes(empresa)) {
    return erro(res, `Empresa invalida. Use ${EMPRESAS.join(' ou ')}.`);
  }
  if (!FUNCOES.includes(funcao)) {
    return erro(res, `Funcao invalida. Use ${FUNCOES.join(', ')}.`);
  }
  if (!podeDarFuncao(quem, funcao)) {
    return erro(res, `So o Adm Promotor cadastra ${funcao}.`, 403);
  }
  if (carro != null && !CARROS.includes(carro)) return erro(res, 'Carro invalido. Use pessoal ou empresa.');

  // "Adm DISO" / "Adm DSO" ja dizem a empresa - nao deixa ficar cruzado.
  const empresaFinal = empresaDaFuncao(funcao) || empresa;

  // Quem nao ve tudo so cadastra colaborador, e so dentro do proprio recorte.
  if (!ehSuper(quem)) {
    if (papel !== 'colaborador') {
      return erro(
        res,
        'Voce so pode cadastrar colaborador. Para criar um administrador, fale com o Eduardo Ramos ou o Victor Sarmento.',
        403,
      );
    }
    if (!podeVerUsuario(quem, { empresa: empresaFinal, funcao })) {
      const e = escopoDe(quem);
      return erro(res, `Voce so cadastra ${e.rotulo}.`, 403);
    }
  }

  try {
    const id = criarUsuario({
      login: loginFinal, nome, email, papel, senha,
      // Mesma peneira da leitura do RDV: o campo aceita placa, nao texto livre.
      placas: placaLimpa(placas),
      empresa: empresaFinal, funcao,
      // Gerente e coordenador sempre entram com carro da empresa.
      carro: carroPadrao(funcao) === 'empresa' ? 'empresa' : (carro ?? 'pessoal'),
    });
    responderJson(res, { ok: true, id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return erro(res, 'Ja existe um usuario com esse login.');
    throw e;
  }
}

// ------------------------------------------------ valor pago antes do portal
//
// Agosto/2026 nao passou pelo portal, entao o sistema nao sabe quanto cada
// pessoa recebeu - e sem isso a regra "aumento acima de R$ 100 precisa de
// justificativa" nao tem base em setembro. O admin digita o valor pago de cada
// colaborador, e ele entra como o mes anterior.

function listarValoresPagos(res, url, quem) {
  const mes = url.searchParams.get('mes') || '2026-08';
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');
  const { sql: filtro, args } = filtroSql(quem);

  const lista = db
    .prepare(
      `SELECT u.id, u.nome, u.login, u.empresa, u.funcao, v.valor, v.lancado_em
         FROM usuarios u
         LEFT JOIN valores_pagos v ON v.usuario_id = u.id AND v.mes_ref = ?
        WHERE u.ativo = 1 AND u.papel = 'colaborador' ${filtro}
        ORDER BY u.empresa, u.nome`,
    )
    .all(mes, ...args)
    .map((u) => ({ ...u, cracha: cracha(u.empresa, u.funcao) }));

  responderJson(res, { mes, mes_extenso: mesPorExtenso(mes), colaboradores: lista });
}

async function gravarValorPago(req, res, quem) {
  const { usuario_id, mes, valor } = await lerJson(req);
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');
  // So mes que ja passou: o do mes corrente vem do proprio RDV.
  if (mes >= mesAtual()) return erro(res, 'So da para informar o valor de um mes que ja terminou.');

  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!alvo) return erro(res, 'Colaborador nao encontrado.', 404);
  if (!podeVerUsuario(quem, alvo)) return erro(res, 'Esse colaborador e de outra empresa.', 403);

  // Campo vazio apaga o valor informado.
  if (valor == null || String(valor).trim() === '') {
    db.prepare('DELETE FROM valores_pagos WHERE usuario_id = ? AND mes_ref = ?').run(alvo.id, mes);
    log.info('valor-pago', 'valor apagado', { de: alvo.login, mes, por: quem.login });
    return responderJson(res, { ok: true, valor: null });
  }

  const v = numero(valor, NaN);
  if (!Number.isFinite(v) || v < 0) return erro(res, 'Valor invalido.');
  if (v > 1_000_000) return erro(res, 'Esse valor parece alto demais. Confira.');

  db.prepare(
    `INSERT INTO valores_pagos (usuario_id, mes_ref, valor, lancado_por, lancado_em)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (usuario_id, mes_ref)
     DO UPDATE SET valor = excluded.valor, lancado_por = excluded.lancado_por, lancado_em = excluded.lancado_em`,
  ).run(alvo.id, mes, Number(v.toFixed(2)), quem.id, agora());

  // Quem decide dinheiro precisa de rastro: quem informou quanto, e quando.
  log.info('valor-pago', 'valor informado', { de: alvo.login, mes, valor: v.toFixed(2), por: quem.login });
  responderJson(res, { ok: true, valor: Number(v.toFixed(2)) });
}

async function mudarEmpresa(req, res, quem) {
  const { usuario_id, empresa, funcao, carro } = await lerJson(req);
  if (carro != null && !CARROS.includes(carro)) return erro(res, 'Carro invalido. Use pessoal ou empresa.');

  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!podeMexerNoUsuario(quem, alvo)) {
    return erro(res, 'Voce nao pode alterar esse cadastro.', 403);
  }
  // A alteracao nao pode empurrar a pessoa para fora do que este admin alcanca -
  // senao ele "perde" o cadastro que acabou de mexer, e pior, move gente para
  // um recorte que nao e dele.
  if (!ehSuper(quem)) {
    const depois = {
      empresa: empresaDaFuncao(funcao ?? alvo.funcao) || empresa || alvo.empresa,
      funcao: funcao ?? alvo.funcao,
    };
    if (!podeVerUsuario(quem, depois)) {
      const e = escopoDe(quem);
      return erro(res, `Essa mudanca tira a pessoa do seu alcance (${e.rotulo}).`, 403);
    }
  }

  if (empresa != null) {
    if (!EMPRESAS.includes(empresa)) {
      return erro(res, `Empresa invalida. Use ${EMPRESAS.join(' ou ')}.`);
    }
    db.prepare('UPDATE usuarios SET empresa = ? WHERE id = ?').run(empresa, Number(usuario_id));
  }

  if (funcao != null) {
    if (!FUNCOES.includes(funcao)) {
      return erro(res, `Funcao invalida. Use ${FUNCOES.join(', ')}.`);
    }
    if (funcao !== alvo.funcao && !podeDarFuncao(quem, funcao)) {
      return erro(res, `So o Adm Promotor coloca alguem como ${funcao}.`, 403);
    }
    db.prepare('UPDATE usuarios SET funcao = ? WHERE id = ?').run(funcao, Number(usuario_id));

    // Escolher "Adm DSO" move a pessoa para a DSO, senao o cadastro fica cruzado.
    const daFuncao = empresaDaFuncao(funcao);
    if (daFuncao) {
      db.prepare('UPDATE usuarios SET empresa = ? WHERE id = ?').run(daFuncao, Number(usuario_id));
    }

    // Virou gerente ou coordenador: ja passa para carro da empresa.
    if (funcao !== alvo.funcao && carro == null && carroPadrao(funcao) === 'empresa') {
      db.prepare("UPDATE usuarios SET carro = 'empresa' WHERE id = ?").run(Number(usuario_id));
    }
  }

  if (carro != null) {
    db.prepare('UPDATE usuarios SET carro = ? WHERE id = ?').run(carro, Number(usuario_id));
  }

  const u = db.prepare('SELECT empresa, funcao, carro FROM usuarios WHERE id = ?').get(Number(usuario_id));
  responderJson(res, { ok: true, cracha: u ? cracha(u.empresa, u.funcao) : null, carro: u?.carro });
}

/**
 * Normaliza e confere um login, para o cadastro e para a troca.
 *
 * As duas portas precisam da MESMA regra. Enquanto so a troca normalizava, dava
 * para cadastrar "Bruno.ST" pelo formulario de novo colaborador e criar um
 * acesso em que ninguem entra: o autenticar() procura o login em minusculas e
 * nunca acha o que foi gravado com maiuscula.
 *
 * Devolve { login } quando passa, ou { erro } com o recado pronto.
 */
function loginNormalizado(bruto) {
  const login = String(bruto || '').trim().toLowerCase();
  if (login.length < 3) return { erro: 'O login precisa ter pelo menos 3 caracteres.' };
  if (/\s/.test(login)) return { erro: 'O login nao pode ter espaco.' };
  if (!/^[a-z0-9._-]+$/.test(login)) {
    return { erro: 'O login aceita apenas letras, numeros, ponto, hifen e sublinhado.' };
  }
  return { login };
}

/**
 * Troca o login de um colaborador.
 *
 * Serve para quando o login foi cadastrado errado, ou a pessoa passou a usar
 * outro. O cadastro e o mesmo: relatorios, anexos e historico continuam presos
 * ao `id`, entao nada se perde na troca.
 *
 * Duas cautelas que o formulario sozinho nao garante:
 *  - MINUSCULAS. O `autenticar()` procura o login em minusculas; gravar
 *    "Bruno.ST" criaria um cadastro em que ninguem consegue entrar.
 *  - As sessoes caem. Quem estava logado com o login velho e desconectado, do
 *    mesmo jeito que acontece na troca de senha.
 */
async function mudarLogin(req, res, quem) {
  const { usuario_id, login } = await lerJson(req);

  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!alvo) return erro(res, 'Colaborador nao encontrado.', 404);
  if (!podeMexerNoUsuario(quem, alvo)) {
    return erro(res, 'Voce nao pode alterar esse cadastro.', 403);
  }

  const { login: novo, erro: recado } = loginNormalizado(login);
  if (recado) return erro(res, recado);
  if (novo === alvo.login) return erro(res, 'Esse ja e o login atual.');

  const ocupado = db.prepare('SELECT nome FROM usuarios WHERE login = ? AND id <> ?')
    .get(novo, alvo.id);
  if (ocupado) return erro(res, `O login "${novo}" ja e de ${ocupado.nome}.`);

  db.prepare('UPDATE usuarios SET login = ? WHERE id = ?').run(novo, alvo.id);
  // Sessao aberta com o login antigo nao continua valendo.
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(alvo.id);

  responderJson(res, { ok: true, login: novo, anterior: alvo.login });
}

/**
 * Corrige o nome de um colaborador.
 *
 * O nome e so rotulo: nao entra em login, nem em permissao, nem em nada que o
 * sistema decida. Trocar aqui muda como a pessoa aparece no painel, na galeria
 * e nas planilhas - inclusive nos relatorios que ela ja mandou, porque tudo
 * aponta para o `id`, nunca para o texto do nome.
 *
 * A unica dependencia de nome no sistema e a rede de seguranca que reconhece os
 * dois supervisores, e ela so vale quando o login nao bateu - ver banco.js.
 */
async function mudarNome(req, res, quem) {
  const { usuario_id, nome } = await lerJson(req);

  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!alvo) return erro(res, 'Colaborador nao encontrado.', 404);
  if (!podeMexerNoUsuario(quem, alvo)) {
    return erro(res, 'Voce nao pode alterar esse cadastro.', 403);
  }

  // Espaco duplo vira um so: o nome vai para planilha e para o cabecalho do
  // relatorio, e "Joao  Silva" aparece torto no meio dos outros.
  const novo = String(nome || '').trim().replace(/\s+/g, ' ');
  if (novo.length < 3) return erro(res, 'O nome precisa ter pelo menos 3 caracteres.');
  if (novo.length > 120) return erro(res, 'O nome ficou longo demais (maximo 120 caracteres).');
  if (novo === alvo.nome) return erro(res, 'Esse ja e o nome atual.');

  db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(novo, alvo.id);
  responderJson(res, { ok: true, nome: novo, anterior: alvo.nome });
}

/**
 * Corrige a placa de um colaborador - ou apaga a que esta la.
 *
 * Nao existia jeito nenhum de mexer neste campo depois de gravado: o cadastro
 * so deixava trocar login, nome, senha, empresa, funcao e ativo. Quando a
 * leitura do RDV entupiu o campo de um vendedor com 3.314 caracteres de lixo,
 * a unica saida teria sido mexer no banco na mao.
 *
 * Texto vazio limpa o campo. E o que conserta um cadastro sujo sem precisar de
 * ninguem com acesso ao banco.
 */
async function mudarPlaca(req, res, quem) {
  const { usuario_id, placas } = await lerJson(req);

  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!alvo) return erro(res, 'Colaborador nao encontrado.', 404);
  if (!podeMexerNoUsuario(quem, alvo)) {
    return erro(res, 'Voce nao pode alterar esse cadastro.', 403);
  }

  const bruto = String(placas ?? '').trim();
  if (!bruto) {
    db.prepare('UPDATE usuarios SET placas = NULL WHERE id = ?').run(alvo.id);
    return responderJson(res, { ok: true, placas: null });
  }

  const nova = placaLimpa(bruto);
  if (!nova) {
    return erro(
      res,
      'Isso nao parece uma placa. Use letras e numeros, ate 60 caracteres - '
        + 'por exemplo "ABC1D23" ou "ABC1D23, XYZ4E56". Para apagar, deixe o campo vazio.',
    );
  }

  db.prepare('UPDATE usuarios SET placas = ? WHERE id = ?').run(nova, alvo.id);
  responderJson(res, { ok: true, placas: nova, anterior: alvo.placas });
}

async function resetarSenha(req, res, quem) {
  const { usuario_id, senha } = await lerJson(req);
  if (!senha || String(senha).length < 6) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!u) return erro(res, 'Usuario nao encontrado.', 404);
  if (!podeMexerNoUsuario(quem, u)) {
    return erro(res, 'Voce nao pode trocar a senha desse cadastro.', 403);
  }
  trocarSenha(u.id, String(senha));
  db.prepare('UPDATE usuarios SET trocar_senha = 1 WHERE id = ?').run(u.id);
  responderJson(res, { ok: true });
}

// Exclusao definitiva. Leva junto os relatorios, os anexos do banco e os
// arquivos do disco - por isso exige confirmacao com o login digitado.
async function excluirUsuario(req, res, quemPediu) {
  const { usuario_id, confirmacao } = await lerJson(req);
  const id = Number(usuario_id);

  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!alvo) return erro(res, 'Colaborador nao encontrado.', 404);

  if (alvo.id === quemPediu.id) {
    return erro(res, 'Voce nao pode excluir a propria conta.');
  }

  if (!podeMexerNoUsuario(quemPediu, alvo)) {
    return erro(
      res,
      ehSuper(quemPediu)
        ? 'Nao e possivel excluir esse cadastro.'
        : 'Voce so exclui colaborador da sua empresa.',
      403,
    );
  }

  // A trava e para nao ficar ninguem podendo administrar. Conta admin E super:
  // apagar o ultimo admin comum e seguro se ainda existe um super.
  if (alvo.papel === 'admin' || alvo.papel === 'super') {
    const mandam = db
      .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel IN ('admin','super') AND ativo = 1")
      .get().n;
    if (mandam <= 1) return erro(res, 'Nao da para excluir o unico administrador.');

    // E nunca pode sobrar zero super.
    if (alvo.papel === 'super') {
      const supers = db
        .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'super' AND ativo = 1").get().n;
      if (supers <= 1) {
        return erro(res, 'Nao da para excluir o unico usuario que ve tudo.');
      }
    }
  }

  const relatorios = db
    .prepare('SELECT COUNT(*) AS n FROM relatorios WHERE usuario_id = ?').get(id).n;
  const arquivos = db
    .prepare(
      `SELECT a.arquivo FROM anexos a JOIN relatorios r ON r.id = a.relatorio_id
        WHERE r.usuario_id = ?`,
    )
    .all(id);

  // Confirmacao burra de proposito: digitar o login evita clique errado numa
  // acao que apaga meses de comprovante.
  if (String(confirmacao || '').trim().toLowerCase() !== alvo.login) {
    return responderJson(
      res,
      {
        erro: `Para excluir, confirme digitando o login "${alvo.login}".`,
        vai_apagar: { relatorios, anexos: arquivos.length },
      },
      400,
    );
  }

  db.exec('BEGIN');
  try {
    // As chaves estrangeiras estao em cascade: apagar o usuario leva
    // relatorios, linhas e anexos junto.
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Os arquivos do disco nao saem por cascade.
  let apagados = 0;
  for (const a of arquivos) {
    try {
      fs.unlinkSync(path.join(PASTA_ANEXOS, a.arquivo));
      apagados++;
    } catch {
      // arquivo ja tinha sumido
    }
  }

  responderJson(res, {
    ok: true,
    nome: alvo.nome,
    relatorios,
    anexos: arquivos.length,
    arquivos_apagados: apagados,
  });
}

async function ativarUsuario(req, res, quem) {
  const { usuario_id, ativo } = await lerJson(req);
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!u) return erro(res, 'Usuario nao encontrado.', 404);
  if (!podeMexerNoUsuario(quem, u)) {
    return erro(res, 'Voce nao pode alterar esse cadastro.', 403);
  }
  db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, u.id);
  responderJson(res, { ok: true });
}

function pegarConfig(res) {
  const chave = lerConfig('chave_api');
  responderJson(res, {
    valor_km: valorDoKm(),
    modelo_ia: lerConfig('modelo_ia') || 'claude-opus-5',
    // nunca devolve a chave inteira
    chave_api_resumo: chave ? `${chave.slice(0, 8)}...${chave.slice(-4)}` : '',
    chave_por_ambiente: Boolean(process.env.ANTHROPIC_API_KEY),
    ia_disponivel: iaDisponivel(),
  });
}

async function salvarConfig(req, res) {
  const corpo = await lerJson(req);
  if (corpo.valor_km != null) {
    const v = numero(corpo.valor_km, 0);
    if (v <= 0) return erro(res, 'O valor do km precisa ser maior que zero.');
    gravarConfig('valor_km', v.toFixed(2));
  }
  if (typeof corpo.chave_api === 'string' && corpo.chave_api.trim()) {
    gravarConfig('chave_api', corpo.chave_api.trim());
  }
  if (corpo.limpar_chave) gravarConfig('chave_api', '');
  if (corpo.modelo_ia) {
    const modelo = String(corpo.modelo_ia).trim();
    // Nome errado aqui derruba toda leitura e conferencia com "model not found".
    if (!/^claude-[a-z0-9.-]+$/.test(modelo)) return erro(res, 'Nome de modelo invalido.');
    gravarConfig('modelo_ia', modelo);
    log.info('config', 'modelo da IA trocado', { modelo });
  }
  pegarConfig(res);
}

async function exportarCsv(res, url, quem) {
  const mes = url.searchParams.get('mes') || mesAtual();
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  const { sql: filtro, args: argsEscopo } = filtroSql(quem);

  const linhas = db
    .prepare(
      `SELECT r.*, u.nome, u.empresa, u.funcao FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.mes_ref = ? AND r.status <> 'RASCUNHO' ${filtro}`,
    )
    .all(mes, ...argsEscopo);

  if (linhas.length === 0) {
    return erro(res, `Nenhum RDV foi enviado em ${mesPorExtenso(mes)}, então ainda não há planilha para baixar.`, 404);
  }

  const relatorios = linhas.map((r) => ({
    ...r,
    achados: listaDeJson(r.achados) ?? [],
    // Quando a resposta da DANFE nao esta gravada, deduz pelos anexos.
    tem_danfe_por_anexo:
      db.prepare("SELECT COUNT(*) AS n FROM anexos WHERE relatorio_id = ? AND tipo = 'danfe'").get(r.id).n > 0,
  }));

  const dados = Buffer.from(await gerarPlanilha({ mes, relatorios, valorKm: valorDoKm() }));

  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': dados.length,
    'Content-Disposition': `attachment; filename="RDV-${mes}.xlsx"`,
  });
  res.end(dados);
}

/**
 * Quanto o comprovado destoa do declarado - ou null quando nao da para dizer.
 *
 * Devolve null em dois casos, e nos dois "—" na tela e mais honesto que um
 * numero:
 *   - ainda nao foi conferido: nao existe comprovado;
 *   - o relatorio nao declara pedagio: nao existe com o que comparar, e o
 *     comprovado sozinho nao e divergencia.
 *
 * Centavo de arredondamento tambem vira zero. Um relatorio certo mostra 0, que
 * e o que quem confere espera ver.
 */
function diferencaDePedagio(rel) {
  const comprovado = rel.pedagio_comprovado;
  if (comprovado == null) return null;

  const declarado = Number(rel.pedagio_declarado || 0) + Number(rel.estac_declarado || 0);
  if (declarado === 0) return null;

  const dif = Number((comprovado - declarado).toFixed(2));
  return Math.abs(dif) < 0.01 ? 0 : dif;
}

// ------------------------------------------------------------- notificacoes

async function inscreverAparelho(req, res, usuario) {
  const { inscricao, descricao, instalado } = await lerJson(req);
  try {
    inscrever(usuario.id, inscricao, { descricao, instalado });
  } catch (e) {
    return erro(res, e.message);
  }
  responderJson(res, { ok: true });
}

async function desinscreverAparelho(req, res, usuario) {
  const { endpoint } = await lerJson(req);
  desinscrever(usuario.id, endpoint);
  responderJson(res, { ok: true });
}

// Cada admin ve e notifica so quem esta no recorte dele, como no resto do painel.
function aparelhosNoAlcance(quem) {
  const { sql: filtro, args } = filtroSql(quem);
  return db
    .prepare(
      `SELECT a.id, a.endpoint, a.p256dh, a.auth, a.descricao, a.instalado, a.criado_em, a.visto_em,
              a.ultimo_envio, a.ultimo_erro,
              u.id AS usuario_id, u.nome, u.login, u.empresa, u.funcao
         FROM aparelhos a JOIN usuarios u ON u.id = a.usuario_id
        WHERE u.ativo = 1 ${filtro}
        ORDER BY u.nome, a.visto_em DESC`,
    )
    .all(...args);
}

function listarAparelhos(res, quem) {
  responderJson(
    res,
    aparelhosNoAlcance(quem).map(({ endpoint, p256dh, auth, ...a }) => ({
      ...a,
      cracha: cracha(a.empresa, a.funcao),
    })),
  );
}

async function notificar(req, res, quem) {
  const { titulo, texto, ids } = await lerJson(req);
  const t = String(titulo || '').trim().slice(0, 80);
  const x = String(texto || '').trim().slice(0, 300);
  if (!t) return erro(res, 'Escreva o titulo da notificacao.');
  if (!Array.isArray(ids) || !ids.length) return erro(res, 'Escolha pelo menos um aparelho.');

  const escolhidos = new Set(ids.map(Number));
  const alvo = aparelhosNoAlcance(quem).filter((a) => escolhidos.has(a.id));
  if (!alvo.length) return erro(res, 'Nenhum dos aparelhos escolhidos esta no seu alcance.');

  const r = await enviarNotificacao(alvo, {
    titulo: t, texto: x, url: '/', contato: `https://${req.headers.host}`,
  });
  log.info('push', 'notificacao enviada', { quem: quem.login, titulo: t, ...r });
  responderJson(res, r);
}
