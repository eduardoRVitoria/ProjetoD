// Todas as rotas /api do Portal RDV.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, agora, valorDoKm, lerConfig, gravarConfig, PASTA_ANEXOS } from './banco.js';
import {
  autenticar,
  abrirSessao,
  fecharSessao,
  trocarSenha,
  criarUsuario,
  cookieDeSessao,
  cookieDeSaida,
} from './auth.js';
import { conferir } from './conferencia.js';
import { conferirComIa, iaDisponivel } from './ia.js';
import { conferirEmDemo } from './ia-demo.js';
import { gerarPlanilha } from './planilha.js';
import { enviarBackup, restaurarBackup, resumoDosDados } from './backup.js';
import { nomeDoFeriado, fimDeSemana, diaDaSemana } from './feriados.js';
import {
  responderJson,
  erro,
  lerJson,
  lerCorpo,
  numero,
  mesValido,
  mesAtual,
  diasDoMes,
  mesPorExtenso,
  nomeDeArquivoSeguro,
  ROTULO_STATUS,
} from './util.js';

const TIPOS_DE_ANEXO = new Set(['pedagio', 'danfe', 'odometro', 'outro']);
const EDITAVEL = new Set(['RASCUNHO', 'ERRADA', 'SO_FALTA_DANFE']);

// ---------------------------------------------------------------- despachante

export async function tratarApi(req, res, url, usuario, seguro) {
  const rota = url.pathname;
  const metodo = req.method;

  // --- rotas abertas ---
  if (rota === '/api/entrar' && metodo === 'POST') return entrar(req, res, seguro);
  if (rota === '/api/sair' && metodo === 'POST') return sair(req, res);

  // --- daqui pra baixo precisa estar logado ---
  if (!usuario) return erro(res, 'Sessao expirada. Entre de novo.', 401);

  if (rota === '/api/eu' && metodo === 'GET') return eu(res, usuario);
  if (rota === '/api/trocar-senha' && metodo === 'POST') return trocarMinhaSenha(req, res, usuario);

  if (rota === '/api/relatorio' && metodo === 'GET') return pegarRelatorio(req, res, url, usuario);
  if (rota === '/api/relatorio' && metodo === 'PUT') return salvarRelatorio(req, res, usuario);
  if (rota === '/api/relatorio/enviar' && metodo === 'POST') return enviarRelatorio(req, res, usuario);
  if (rota === '/api/meus-relatorios' && metodo === 'GET') return meusRelatorios(res, usuario);

  if (rota === '/api/anexo' && metodo === 'POST') return subirAnexo(req, res, url, usuario);
  if (rota.startsWith('/api/anexo/') && metodo === 'GET') return baixarAnexo(req, res, rota, usuario);
  if (rota.startsWith('/api/anexo/') && metodo === 'DELETE') return apagarAnexo(res, rota, usuario);

  // --- area do administrador ---
  if (rota.startsWith('/api/admin/')) {
    if (usuario.papel !== 'admin') return erro(res, 'Area restrita ao administrador.', 403);

    if (rota === '/api/admin/painel' && metodo === 'GET') return painel(res, url);
    if (rota === '/api/admin/relatorio' && metodo === 'GET') return relatorioDetalhe(res, url);
    if (rota === '/api/admin/conferir' && metodo === 'POST') return conferirUm(req, res, usuario);
    if (rota === '/api/admin/decidir' && metodo === 'POST') return decidir(req, res, usuario);
    if (rota === '/api/admin/usuarios' && metodo === 'GET') return listarUsuarios(res);
    if (rota === '/api/admin/usuarios' && metodo === 'POST') return novoUsuario(req, res);
    if (rota === '/api/admin/usuario-senha' && metodo === 'POST') return resetarSenha(req, res);
    if (rota === '/api/admin/usuario-ativo' && metodo === 'POST') return ativarUsuario(req, res);
    if (rota === '/api/admin/config' && metodo === 'GET') return pegarConfig(res);
    if (rota === '/api/admin/config' && metodo === 'POST') return salvarConfig(req, res);
    if (rota === '/api/admin/exportar' && metodo === 'GET') return exportarCsv(res, url);
    if (rota === '/api/admin/backup' && metodo === 'GET') return baixarBackup(res);
    if (rota === '/api/admin/restaurar' && metodo === 'POST') return subirBackup(req, res);
    if (rota === '/api/admin/dados' && metodo === 'GET') return responderJson(res, resumoDosDados());
  }

  return erro(res, 'Rota nao encontrada.', 404);
}

// ------------------------------------------------------------------- sessao

async function entrar(req, res, seguro) {
  const { login, senha } = await lerJson(req);
  const u = autenticar(login, senha);
  if (!u) return erro(res, 'Login ou senha invalidos.', 401);
  const token = abrirSessao(u.id);
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

function linhasDo(relId) {
  return db
    .prepare('SELECT * FROM linhas WHERE relatorio_id = ? ORDER BY data, ordem')
    .all(relId);
}

function anexosDo(relId) {
  return db
    .prepare(
      'SELECT id, tipo, nome_original, mime, tamanho, enviado_em FROM anexos WHERE relatorio_id = ? ORDER BY tipo, id',
    )
    .all(relId);
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
    };
  });
}

function pegarRelatorio(req, res, url, usuario) {
  const mes = url.searchParams.get('mes') || mesAtual();
  if (!mesValido(mes)) return erro(res, 'Mes invalido. Use o formato AAAA-MM.');

  const rel = acharOuCriar(usuario.id, mes);
  const linhas = linhasDo(rel.id);
  const anexos = anexosDo(rel.id);
  const resultado = conferir(rel, linhas, anexos, valorDoKm());

  responderJson(res, {
    relatorio: {
      ...rel,
      mes_extenso: mesPorExtenso(mes),
      rotulo_status: ROTULO_STATUS[rel.status],
      editavel: EDITAVEL.has(rel.status),
      achados: rel.achados ? JSON.parse(rel.achados) : null,
    },
    grade: gradeDoMes(mes, linhas),
    anexos,
    previa: resultado,
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
      `INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, pedagio, estacionamento, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let ordem = 0;
    for (const l of recebidas) {
      const ki = numero(l.km_inicial);
      const kf = numero(l.km_final);
      const ped = numero(l.pedagio);
      const est = numero(l.estacionamento);
      const itin = String(l.itinerario || '').trim().slice(0, 500);
      // Dia totalmente em branco nao vira linha.
      if (ki === 0 && kf === 0 && ped === 0 && est === 0 && !itin) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.data || ''))) continue;
      if (!String(l.data).startsWith(mes)) continue;
      inserir.run(rel.id, l.data, ki, kf, itin, ped, est, ordem++);
    }

    const linhas = linhasDo(rel.id);
    const anexos = anexosDo(rel.id);
    const r = conferir(rel, linhas, anexos, valorDoKm());

    db.prepare(
      `UPDATE relatorios
          SET total_km = ?, valor_km = ?, pedagio_declarado = ?, estac_declarado = ?, observacao = ?
        WHERE id = ?`,
    ).run(
      r.totalKm,
      r.valorKm,
      r.pedagioDeclarado,
      r.estacDeclarado,
      String(corpo.observacao || '').slice(0, 2000),
      rel.id,
    );

    db.exec('COMMIT');

    const atualizado = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
    responderJson(res, {
      ok: true,
      relatorio: atualizado,
      previa: conferir(atualizado, linhas, anexos, valorDoKm()),
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
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
  if (linhas.length === 0) return erro(res, 'Preencha pelo menos um dia antes de enviar.');

  const anexos = anexosDo(rel.id);
  const r = conferir(rel, linhas, anexos, valorDoKm());

  // Bloqueios duros: coisas que a pessoa consegue resolver sozinha antes de enviar.
  const bloqueios = r.achados.filter(
    (a) =>
      a.gravidade === 'erro' &&
      ['data_fim_de_semana', 'km_invertido', 'itinerario_vazio', 'soma_km', 'valor_km', 'pedagio_sem_comprovante'].includes(
        a.codigo,
      ),
  );
  if (bloqueios.length > 0) {
    return responderJson(
      res,
      {
        erro: 'O relatorio tem pendencias que precisam ser corrigidas antes do envio.',
        bloqueios,
      },
      400,
    );
  }

  db.prepare(
    `UPDATE relatorios SET status = 'ENVIADO', enviado_em = ?, achados = NULL, parecer_ia = NULL,
            o_que_fazer = NULL, conferido_em = NULL, pedagio_comprovado = NULL
      WHERE id = ?`,
  ).run(agora(), rel.id);

  responderJson(res, {
    ok: true,
    aviso: r.achados.some((a) => a.codigo === 'sem_danfe')
      ? 'Enviado, mas voce nao anexou a nota de abastecimento - isso costuma reprovar o relatorio.'
      : 'Relatorio enviado para conferencia.',
  });
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

  if (!mesValido(mes)) return erro(res, 'Mes invalido.');
  if (!TIPOS_DE_ANEXO.has(tipo)) return erro(res, 'Tipo de anexo invalido.');

  const rel = acharOuCriar(usuario.id, mes);
  if (!EDITAVEL.has(rel.status)) return erro(res, 'Esse relatorio nao aceita mais anexos.');

  const dados = await lerCorpo(req);
  if (dados.length === 0) return erro(res, 'O arquivo chegou vazio (0 KB). Tente enviar de novo.');

  const nomeLimpo = nomeDeArquivoSeguro(decodeURIComponent(nomeBruto));
  const salvo = `${rel.id}-${crypto.randomBytes(6).toString('hex')}-${nomeLimpo}`;
  fs.writeFileSync(path.join(PASTA_ANEXOS, salvo), dados);

  db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho, enviado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rel.id,
    tipo,
    decodeURIComponent(nomeBruto).slice(0, 200),
    salvo,
    req.headers['content-type'] || 'application/octet-stream',
    dados.length,
    agora(),
  );

  responderJson(res, { ok: true, anexos: anexosDo(rel.id) });
}

function anexoPermitido(id, usuario) {
  const a = db.prepare('SELECT * FROM anexos WHERE id = ?').get(Number(id));
  if (!a) return null;
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(a.relatorio_id);
  if (!rel) return null;
  if (usuario.papel !== 'admin' && rel.usuario_id !== usuario.id) return null;
  return { anexo: a, rel };
}

function baixarAnexo(req, res, rota, usuario) {
  const id = rota.split('/').pop();
  const achado = anexoPermitido(id, usuario);
  if (!achado) return erro(res, 'Anexo nao encontrado.', 404);

  const caminho = path.join(PASTA_ANEXOS, achado.anexo.arquivo);
  if (!fs.existsSync(caminho)) return erro(res, 'Arquivo sumiu do servidor.', 404);

  const dados = fs.readFileSync(caminho);
  res.writeHead(200, {
    'Content-Type': achado.anexo.mime || 'application/octet-stream',
    'Content-Length': dados.length,
    'Content-Disposition': `inline; filename="${nomeDeArquivoSeguro(achado.anexo.nome_original)}"`,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(dados);
}

function apagarAnexo(res, rota, usuario) {
  const id = rota.split('/').pop();
  const achado = anexoPermitido(id, usuario);
  if (!achado) return erro(res, 'Anexo nao encontrado.', 404);
  if (!EDITAVEL.has(achado.rel.status) && usuario.papel !== 'admin') {
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

function painel(res, url) {
  const mes = url.searchParams.get('mes') || mesAtual();
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  const linhas = db
    .prepare(
      `SELECT r.*, u.nome, u.login, u.placas
         FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.mes_ref = ?
        ORDER BY CASE r.status
                   WHEN 'ENVIADO' THEN 0 WHEN 'CONFERINDO' THEN 1 WHEN 'ERRADA' THEN 2
                   WHEN 'SO_FALTA_DANFE' THEN 3 WHEN 'CERTA' THEN 4 ELSE 5 END,
                 u.nome`,
    )
    .all(mes);

  const semEnviar = db
    .prepare(
      `SELECT u.id, u.nome, u.login FROM usuarios u
        WHERE u.ativo = 1 AND u.papel = 'colaborador'
          AND u.id NOT IN (
            SELECT usuario_id FROM relatorios WHERE mes_ref = ? AND status <> 'RASCUNHO'
          )
        ORDER BY u.nome`,
    )
    .all(mes);

  const contagem = {};
  for (const l of linhas) contagem[l.status] = (contagem[l.status] || 0) + 1;

  responderJson(res, {
    mes,
    mes_extenso: mesPorExtenso(mes),
    ia_disponivel: iaDisponivel(),
    contagem,
    nao_enviaram: semEnviar,
    relatorios: linhas.map((r) => ({
      id: r.id,
      usuario_id: r.usuario_id,
      nome: r.nome,
      login: r.login,
      status: r.status,
      rotulo_status: ROTULO_STATUS[r.status],
      total_km: r.total_km,
      valor_km: r.valor_km,
      declarado: Number((r.pedagio_declarado + r.estac_declarado).toFixed(2)),
      comprovado: r.pedagio_comprovado,
      diferenca:
        r.pedagio_comprovado == null
          ? null
          : Number((r.pedagio_comprovado - (r.pedagio_declarado + r.estac_declarado)).toFixed(2)),
      o_que_fazer: r.o_que_fazer,
      enviado_em: r.enviado_em,
      conferido_em: r.conferido_em,
      achados: r.achados ? JSON.parse(r.achados) : null,
    })),
  });
}

function relatorioDetalhe(res, url) {
  const id = Number(url.searchParams.get('id'));
  const rel = db
    .prepare(
      `SELECT r.*, u.nome, u.login, u.placas FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id WHERE r.id = ?`,
    )
    .get(id);
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);

  responderJson(res, {
    relatorio: {
      ...rel,
      rotulo_status: ROTULO_STATUS[rel.status],
      mes_extenso: mesPorExtenso(rel.mes_ref),
      achados: rel.achados ? JSON.parse(rel.achados) : null,
      parecer_ia: rel.parecer_ia ? JSON.parse(rel.parecer_ia) : null,
    },
    linhas: linhasDo(rel.id),
    anexos: anexosDo(rel.id),
  });
}

async function conferirUm(req, res, admin) {
  const { relatorio_id, usar_ia = true, demo = false } = await lerJson(req);
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);
  if (rel.status === 'RASCUNHO') return erro(res, 'Esse relatorio ainda nao foi enviado.');

  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(rel.usuario_id);
  const linhas = linhasDo(rel.id);
  const anexos = db.prepare('SELECT * FROM anexos WHERE relatorio_id = ?').all(rel.id);
  const vlrKm = valorDoKm();

  const porRegra = conferir(rel, linhas, anexos, vlrKm);

  let parecer = null;
  let avisoIa = null;

  if (demo) {
    // Nao chama a API. Serve para testar e apresentar o fluxo sem gastar credito.
    parecer = conferirEmDemo({ rel, linhas, anexos, resultadoRegra: porRegra });
    avisoIa =
      'MODO DEMONSTRACAO: nenhum comprovante foi lido. Este parecer e simulado e nao vale como conferencia.';
  } else if (usar_ia && iaDisponivel()) {
    db.prepare('UPDATE relatorios SET status = ? WHERE id = ?').run('CONFERINDO', rel.id);
    try {
      const saida = await conferirComIa({ usuario, rel, linhas, anexos, resultadoRegra: porRegra, vlrKm });
      parecer = saida.parecer;
      if (saida.anexosIgnorados.length) {
        avisoIa = `Anexos nao lidos pela IA: ${saida.anexosIgnorados.join('; ')}`;
      }
    } catch (e) {
      db.prepare('UPDATE relatorios SET status = ? WHERE id = ?').run(rel.status, rel.id);
      return erro(res, `Falha na conferencia com IA: ${e.message}`, 502);
    }
  } else if (usar_ia && !iaDisponivel()) {
    avisoIa = 'Sem chave de API configurada - conferencia feita so pelas regras automaticas.';
  }

  // Junta os dois pareceres. A IA manda no que depende de comprovante;
  // a regra manda no que e calendario e aritmetica.
  const achados = [...porRegra.achados];
  if (parecer) {
    for (const a of parecer.achados || []) {
      achados.push({ gravidade: a.gravidade, codigo: 'ia', mensagem: a.mensagem, data: null });
    }
    if (parecer.tem_danfe_de_abastecimento) {
      // A IA olhou o conteudo e confirmou: derruba o achado da regra.
      const i = achados.findIndex((a) => a.codigo === 'sem_danfe');
      if (i >= 0) achados.splice(i, 1);
    }
  }

  const erros = achados.filter((a) => a.gravidade === 'erro');
  const soDanfe = erros.length === 1 && erros[0].codigo === 'sem_danfe';
  const status = erros.length === 0 ? 'CERTA' : soDanfe ? 'SO_FALTA_DANFE' : 'ERRADA';

  const oQueFazer =
    parecer?.o_que_fazer?.trim() ||
    (status === 'CERTA'
      ? ''
      : erros.map((e) => e.mensagem).join(' ') || 'Corrija os pontos apontados e reenvie.');

  db.prepare(
    `UPDATE relatorios
        SET status = ?, achados = ?, parecer_ia = ?, o_que_fazer = ?,
            pedagio_comprovado = ?, conferido_em = ?, decidido_por = ?
      WHERE id = ?`,
  ).run(
    status,
    JSON.stringify(achados),
    parecer ? JSON.stringify(parecer) : null,
    oQueFazer,
    parecer ? Number(parecer.pedagio_comprovado ?? 0) : null,
    agora(),
    admin.id,
    rel.id,
  );

  responderJson(res, {
    ok: true,
    status,
    rotulo_status: ROTULO_STATUS[status],
    achados,
    parecer,
    aviso: avisoIa,
  });
}

async function decidir(req, res, admin) {
  const { relatorio_id, status, o_que_fazer } = await lerJson(req);
  if (!['CERTA', 'SO_FALTA_DANFE', 'ERRADA'].includes(status)) {
    return erro(res, 'Status invalido.');
  }
  const rel = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(Number(relatorio_id));
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);

  db.prepare(
    'UPDATE relatorios SET status = ?, o_que_fazer = ?, conferido_em = ?, decidido_por = ? WHERE id = ?',
  ).run(status, String(o_que_fazer || '').slice(0, 2000), agora(), admin.id, rel.id);

  responderJson(res, { ok: true, status, rotulo_status: ROTULO_STATUS[status] });
}

function baixarBackup(res) {
  const carimbo = new Date().toISOString().slice(0, 10);
  return enviarBackup(res, `portal-rdv-backup-${carimbo}.zip`);
}

async function subirBackup(req, res) {
  // 500 MB: o backup carrega todos os anexos junto.
  const zip = await lerCorpo(req, 500 * 1024 * 1024);
  if (!zip.length) return erro(res, 'Nenhum arquivo recebido.');

  try {
    const r = await restaurarBackup(zip);
    responderJson(res, {
      ok: true,
      ...r,
      aviso:
        'Dados restaurados. Reinicie o servidor para o banco ser reaberto a partir do arquivo novo.',
    });
  } catch (e) {
    erro(res, e.message, 400);
  }
}

function listarUsuarios(res) {
  responderJson(
    res,
    db
      .prepare(
        `SELECT id, login, nome, email, papel, placas, ativo, trocar_senha, criado_em
           FROM usuarios ORDER BY papel DESC, nome`,
      )
      .all(),
  );
}

async function novoUsuario(req, res) {
  const { login, nome, email, papel = 'colaborador', senha, placas } = await lerJson(req);
  if (!login || !nome || !senha) return erro(res, 'Login, nome e senha sao obrigatorios.');
  if (String(senha).length < 6) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  if (!['colaborador', 'admin'].includes(papel)) return erro(res, 'Papel invalido.');

  try {
    const id = criarUsuario({ login, nome, email, papel, senha, placas });
    responderJson(res, { ok: true, id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return erro(res, 'Ja existe um usuario com esse login.');
    throw e;
  }
}

async function resetarSenha(req, res) {
  const { usuario_id, senha } = await lerJson(req);
  if (!senha || String(senha).length < 6) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  const u = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(Number(usuario_id));
  if (!u) return erro(res, 'Usuario nao encontrado.', 404);
  trocarSenha(u.id, String(senha));
  db.prepare('UPDATE usuarios SET trocar_senha = 1 WHERE id = ?').run(u.id);
  responderJson(res, { ok: true });
}

async function ativarUsuario(req, res) {
  const { usuario_id, ativo } = await lerJson(req);
  db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, Number(usuario_id));
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
  if (corpo.modelo_ia) gravarConfig('modelo_ia', String(corpo.modelo_ia).trim());
  pegarConfig(res);
}

async function exportarCsv(res, url) {
  const mes = url.searchParams.get('mes') || mesAtual();
  if (!mesValido(mes)) return erro(res, 'Mes invalido.');

  const linhas = db
    .prepare(
      `SELECT r.*, u.nome FROM relatorios r JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.mes_ref = ? AND r.status <> 'RASCUNHO'`,
    )
    .all(mes);

  if (linhas.length === 0) {
    return erro(res, `Nenhum relatorio enviado em ${mesPorExtenso(mes)}.`, 404);
  }

  const relatorios = linhas.map((r) => ({
    ...r,
    achados: r.achados ? JSON.parse(r.achados) : [],
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
