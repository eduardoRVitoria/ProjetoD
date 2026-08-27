// Todas as rotas /api do Portal RDV.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  db, agora, valorDoKm, lerConfig, gravarConfig, PASTA_ANEXOS,
  EMPRESAS, FUNCOES, cracha, empresaDaFuncao,
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
import { conferir } from './conferencia.js';
import { conferirComIa, iaDisponivel } from './ia.js';
import { conferirEmDemo } from './ia-demo.js';
import { gerarPlanilha, gerarHistorico } from './planilha.js';
import { enviarBackup, restaurarBackup, resumoDosDados } from './backup.js';
import { extrairDoRdv } from './extrair.js';
import { verificarAssinatura, achadosDaAssinatura } from './assinatura.js';
import { galeriaDe, enviarPacote } from './galeria.js';
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

const TIPOS_DE_ANEXO = new Set(['rdv', 'pedagio', 'danfe', 'odometro', 'outro']);
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
  if (rota === '/api/relatorio/ler-rdv' && metodo === 'POST') return lerRdv(req, res, usuario);
  if (rota === '/api/relatorio/enviar' && metodo === 'POST') return enviarRelatorio(req, res, usuario);
  if (rota === '/api/meus-relatorios' && metodo === 'GET') return meusRelatorios(res, usuario);

  if (rota === '/api/anexo' && metodo === 'POST') return subirAnexo(req, res, url, usuario);
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
    if (rota === '/api/admin/decidir' && metodo === 'POST') return decidir(req, res, usuario);
    if (rota === '/api/admin/galeria' && metodo === 'GET') return verGaleria(res, url, usuario);
    if (rota === '/api/admin/pacote' && metodo === 'GET') return baixarPacote(res, url, usuario);
    if (rota === '/api/admin/usuarios' && metodo === 'GET') return listarUsuarios(res, usuario);
    if (rota === '/api/admin/usuarios' && metodo === 'POST') return novoUsuario(req, res, usuario);
    if (rota === '/api/admin/usuario-senha' && metodo === 'POST') return resetarSenha(req, res, usuario);
    if (rota === '/api/admin/usuario-ativo' && metodo === 'POST') return ativarUsuario(req, res, usuario);
    if (rota === '/api/admin/usuario-empresa' && metodo === 'POST') return mudarEmpresa(req, res, usuario);
    if (rota === '/api/admin/usuario' && metodo === 'DELETE') return excluirUsuario(req, res, usuario);
    if (rota === '/api/admin/historico' && metodo === 'GET') return exportarHistorico(res, url, usuario);
    if (rota === '/api/admin/config' && metodo === 'GET') return pegarConfig(res);
    if (rota === '/api/admin/config' && metodo === 'POST') return salvarConfig(req, res);
    if (rota === '/api/admin/exportar' && metodo === 'GET') return exportarCsv(res, url, usuario);
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
  const r = db
    .prepare(
      `SELECT mes_ref, valor_km, pedagio_declarado, estac_declarado
         FROM relatorios
        WHERE usuario_id = ? AND mes_ref < ? AND status <> 'RASCUNHO'
        ORDER BY mes_ref DESC LIMIT 1`,
    )
    .get(usuarioId, mes);

  if (!r) return null;

  return {
    mes: r.mes_ref,
    mesExtenso: mesPorExtenso(r.mes_ref),
    total: Number(
      (Number(r.valor_km || 0) + Number(r.pedagio_declarado || 0) + Number(r.estac_declarado || 0)).toFixed(2),
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
      `SELECT id, tipo, nome_original, mime, tamanho, km, data_leitura, enviado_em
         FROM anexos WHERE relatorio_id = ? ORDER BY tipo, km, id`,
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
  const resultado = conferir(rel, linhas, anexos, valorDoKm(), mesAnteriorDe(rel.usuario_id, rel.mes_ref));

  responderJson(res, {
    relatorio: {
      ...rel,
      mes_extenso: mesPorExtenso(mes),
      rotulo_status: ROTULO_STATUS[rel.status],
      editavel: EDITAVEL.has(rel.status),
      achados: rel.achados ? JSON.parse(rel.achados) : null,
      extraido: rel.extraido ? JSON.parse(rel.extraido) : null,
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
    const r = conferir(rel, linhas, anexos, valorDoKm(), mesAnteriorDe(rel.usuario_id, rel.mes_ref));

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
      previa: conferir(atualizado, linhas, anexos, valorDoKm(), mesAnteriorDe(atualizado.usuario_id, atualizado.mes_ref)),
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

  let extraido;
  try {
    const saida = await extrairDoRdv(arquivos, mes);
    extraido = saida.extraido;
  } catch (e) {
    return erro(res, e.message, 502);
  }

  // O relatorio e de outro mes. Recusar e melhor que arquivar julho dentro de
  // setembro ou esvaziar tudo porque o seletor estava errado.
  if (extraido.mes_do_documento && extraido.mes_do_documento !== mes) {
    return responderJson(
      res,
      {
        erro:
          `Este arquivo e o relatorio de ${mesPorExtenso(extraido.mes_do_documento)}, ` +
          `mas voce esta no mes de ${mesPorExtenso(mes)}. ` +
          'Troque o mes no topo da tela e leia de novo, ou anexe o relatorio do mes certo.',
        mes_do_documento: extraido.mes_do_documento,
      },
      400,
    );
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM linhas WHERE relatorio_id = ?').run(rel.id);

    const inserir = db.prepare(
      `INSERT INTO linhas (relatorio_id, data, km_inicial, km_final, itinerario, pedagio, estacionamento, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    }

    // Guarda tambem o que o documento declarava, para a conferencia comparar.
    db.prepare(
      `UPDATE relatorios SET extraido = ?, extraido_em = ? WHERE id = ?`,
    ).run(JSON.stringify(extraido), agora(), rel.id);

    const linhas = linhasDo(rel.id);
    const anexos = anexosDo(rel.id);
    const atualizado = db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id);
    const r = conferir(atualizado, linhas, anexos, valorDoKm(), mesAnteriorDe(atualizado.usuario_id, atualizado.mes_ref));

    db.prepare(
      `UPDATE relatorios SET total_km = ?, valor_km = ?, pedagio_declarado = ?, estac_declarado = ? WHERE id = ?`,
    ).run(r.totalKm, r.valorKm, r.pedagioDeclarado, r.estacDeclarado, rel.id);

    db.exec('COMMIT');

    // Se o documento trouxe placa e a pessoa ainda nao tem, aproveita.
    if (extraido.placas && !usuario.placas) {
      db.prepare('UPDATE usuarios SET placas = ? WHERE id = ?').run(extraido.placas, usuario.id);
    }

    responderJson(res, {
      ok: true,
      extraido,
      previa: conferir(
        db.prepare('SELECT * FROM relatorios WHERE id = ?').get(rel.id),
        linhas,
        anexos,
        valorDoKm(),
        mesAnteriorDe(usuario.id, mes),
      ),
      grade: gradeDoMes(mes, linhas),
      aviso: avisoDaLeitura(extraido, usuario),
    });
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
  if (linhas.length === 0) {
    return erro(
      res,
      'Anexe o arquivo do seu RDV e toque em "Ler meu relatorio" antes de enviar.',
    );
  }

  const anexos = anexosDo(rel.id);
  const r = conferir(rel, linhas, anexos, valorDoKm(), mesAnteriorDe(rel.usuario_id, rel.mes_ref));

  // Bloqueios duros: coisas que a pessoa consegue resolver sozinha antes de enviar.
  // A soma de km e o valor NAO entram aqui: com o RDV vindo de PDF, a divergencia
  // e do documento dela, e quem decide o que fazer com isso e a conferencia.
  const bloqueios = r.achados.filter(
    (a) =>
      a.gravidade === 'erro' &&
      [
        'km_invertido',
        'sem_linhas',
        'leitura_incerta',
        'pedagio_sem_comprovante',
        'aumento_sem_justificativa',
      ].includes(a.codigo),
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
  const kmBruto = url.searchParams.get('km');
  const dataLeitura = url.searchParams.get('data');

  if (!mesValido(mes)) return erro(res, 'Mes invalido.');
  if (!TIPOS_DE_ANEXO.has(tipo)) return erro(res, 'Tipo de anexo invalido.');

  // Foto de odometro sem o numero digitado nao serve para conferir nada:
  // alguem teria que abrir a imagem e ler o painel na mao, que e o trabalho
  // que este sistema existe para acabar.
  let km = null;
  if (tipo === 'odometro') {
    km = numero(kmBruto, NaN);
    if (!Number.isFinite(km) || km <= 0) {
      return erro(res, 'Digite o KM que aparece no painel da foto.');
    }
    if (km > 9_999_999) return erro(res, 'Esse KM parece alto demais. Confira o numero.');
  }

  if (dataLeitura && !/^\d{4}-\d{2}-\d{2}$/.test(dataLeitura)) {
    return erro(res, 'Data da leitura invalida.');
  }

  const rel = acharOuCriar(usuario.id, mes);
  if (!EDITAVEL.has(rel.status)) return erro(res, 'Esse relatorio nao aceita mais anexos.');

  const dados = await lerCorpo(req);
  if (dados.length === 0) return erro(res, 'O arquivo chegou vazio (0 KB). Tente enviar de novo.');

  const nomeLimpo = nomeDeArquivoSeguro(decodeURIComponent(nomeBruto));
  const salvo = `${rel.id}-${crypto.randomBytes(6).toString('hex')}-${nomeLimpo}`;
  fs.writeFileSync(path.join(PASTA_ANEXOS, salvo), dados);

  db.prepare(
    `INSERT INTO anexos (relatorio_id, tipo, nome_original, arquivo, mime, tamanho,
                         km, data_leitura, enviado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rel.id,
    tipo,
    decodeURIComponent(nomeBruto).slice(0, 200),
    salvo,
    req.headers['content-type'] || 'application/octet-stream',
    dados.length,
    km,
    dataLeitura || null,
    agora(),
  );

  responderJson(res, { ok: true, anexos: anexosDo(rel.id) });
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
  if (!EDITAVEL.has(achado.rel.status) && !ehAdmin(usuario)) {
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
      `SELECT u.id, u.nome, u.login, u.empresa, u.funcao FROM usuarios u
        WHERE u.ativo = 1 AND u.papel = 'colaborador' ${filtro}
          AND u.id NOT IN (
            SELECT usuario_id FROM relatorios WHERE mes_ref = ? AND status <> 'RASCUNHO'
          )
        ORDER BY u.nome`,
    )
    .all(...argsEscopo, mes);

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

function relatorioDetalhe(res, url, quem) {
  const id = Number(url.searchParams.get('id'));
  const rel = db
    .prepare(
      `SELECT r.*, u.nome, u.login, u.placas, u.empresa, u.funcao FROM relatorios r
         JOIN usuarios u ON u.id = r.usuario_id WHERE r.id = ?`,
    )
    .get(id);
  if (!rel) return erro(res, 'Relatorio nao encontrado.', 404);
  if (!podeVerUsuario(quem, rel)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

  responderJson(res, {
    relatorio: {
      ...rel,
      rotulo_status: ROTULO_STATUS[rel.status],
      mes_extenso: mesPorExtenso(rel.mes_ref),
      achados: rel.achados ? JSON.parse(rel.achados) : null,
      parecer_ia: rel.parecer_ia ? JSON.parse(rel.parecer_ia) : null,
      assinatura: rel.assinatura ? JSON.parse(rel.assinatura) : null,
      extraido: rel.extraido ? JSON.parse(rel.extraido) : null,
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
  if (!podeVerUsuario(admin, usuario)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

  const linhas = linhasDo(rel.id);
  const anexos = db.prepare('SELECT * FROM anexos WHERE relatorio_id = ?').all(rel.id);
  const vlrKm = valorDoKm();

  // Relatorio sem dia a dia (os importados da conferencia manual) nao pode
  // passar pelas regras: elas somariam zero e reprovariam todo mundo,
  // apagando o veredito que ja existia. Ou se le o PDF primeiro, ou se decide
  // na mao pelo botao de aprovar/reprovar.
  if (linhas.length === 0) {
    return erro(
      res,
      'Este relatorio nao tem os lancamentos dia a dia (veio da conferencia antiga). ' +
        'Use "Ler o RDV" para extrair do arquivo, ou decida na mao pelos botoes abaixo.',
      409,
    );
  }

  const porRegra = conferir(rel, linhas, anexos, vlrKm, mesAnteriorDe(rel.usuario_id, rel.mes_ref));

  // Assinatura digital do RDV: quem assinou, quando, e se o arquivo foi
  // alterado depois. Roda local, sem custo e sem depender da IA.
  const daAssinatura = conferirAssinatura(rel, anexos, usuario);
  porRegra.achados.push(...daAssinatura.achados);

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

  const dono = db.prepare('SELECT empresa, funcao FROM usuarios WHERE id = ?').get(rel.usuario_id);
  if (!podeVerUsuario(admin, dono)) {
    return erro(res, 'Esse relatorio e de outra empresa.', 403);
  }

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
      achados.push({
        gravidade: 'aviso',
        codigo: 'assinatura_erro',
        mensagem: `Nao foi possivel verificar a assinatura de "${a.nome_original}": ${e.message}`,
        data: null,
      });
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
    .map((r) => ({ ...r, achados: r.achados ? JSON.parse(r.achados) : [] }));

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
        `SELECT u.id, u.login, u.nome, u.email, u.papel, u.empresa, u.funcao, u.placas, u.ativo,
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
    empresa = 'DISO', funcao = 'Vendedor',
  } = await lerJson(req);
  if (!login || !nome || !senha) return erro(res, 'Login, nome e senha sao obrigatorios.');
  if (String(senha).length < 6) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  if (!PAPEIS.includes(papel)) return erro(res, 'Perfil invalido.');
  if (!EMPRESAS.includes(empresa)) {
    return erro(res, `Empresa invalida. Use ${EMPRESAS.join(' ou ')}.`);
  }
  if (!FUNCOES.includes(funcao)) {
    return erro(res, `Funcao invalida. Use ${FUNCOES.join(', ')}.`);
  }

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
      login, nome, email, papel, senha, placas, empresa: empresaFinal, funcao,
    });
    responderJson(res, { ok: true, id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return erro(res, 'Ja existe um usuario com esse login.');
    throw e;
  }
}

async function mudarEmpresa(req, res, quem) {
  const { usuario_id, empresa, funcao } = await lerJson(req);

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
    db.prepare('UPDATE usuarios SET funcao = ? WHERE id = ?').run(funcao, Number(usuario_id));

    // Escolher "Adm DSO" move a pessoa para a DSO, senao o cadastro fica cruzado.
    const daFuncao = empresaDaFuncao(funcao);
    if (daFuncao) {
      db.prepare('UPDATE usuarios SET empresa = ? WHERE id = ?').run(daFuncao, Number(usuario_id));
    }
  }

  const u = db.prepare('SELECT empresa, funcao FROM usuarios WHERE id = ?').get(Number(usuario_id));
  responderJson(res, { ok: true, cracha: u ? cracha(u.empresa, u.funcao) : null });
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

  if (alvo.papel === 'admin' || alvo.papel === 'super') {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin' AND ativo = 1").get().n;
    if (admins <= 1) return erro(res, 'Nao da para excluir o unico administrador.');
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
  if (corpo.modelo_ia) gravarConfig('modelo_ia', String(corpo.modelo_ia).trim());
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
