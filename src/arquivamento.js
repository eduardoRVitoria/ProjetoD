// Arquivamento em blocos: tirar do servidor os comprovantes de relatorios ja
// aprovados, para o disco caber no plano de 5 GB.
//
// O caminho e sempre o mesmo, e nenhum passo apaga nada sozinho:
//   1. o dono baixa um BLOCO (.zip) de uma empresa ou de uma pessoa;
//   2. escolhe na tela o zip que salvou no PC. O navegador compara o tamanho
//      com o que o servidor gerou - nada e enviado - e so entao o servidor
//      apaga os arquivos daquele bloco;
//   3. se precisar de volta, sobe o zip e os arquivos voltam para o lugar.
//
// O registro do anexo fica no banco (tipo, valor, km, nome): o historico do
// relatorio continua inteiro. Sai so o arquivo pesado, e o anexo passa a dizer
// em que bloco esta.
//
// So entra relatorio APROVADO (CERTA). O que ainda pode ser conferido de novo
// precisa dos arquivos no servidor.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import unzipper from 'unzipper';
import nodemailer from 'nodemailer';
import { db, PASTA_DADOS, PASTA_ANEXOS, agora, lerConfig, gravarConfig } from './banco.js';
import * as log from './log.js';

// A partir daqui o painel e o e-mail avisam. O plano free da Railway tem 5 GB;
// 3 GB deixa folga para baixar os blocos com calma.
export const LIMITE_AVISO = 3 * 1024 ** 3;
export const CAPACIDADE = 5 * 1024 ** 3;

const MANIFESTO = 'manifesto-portal-rdv.json';

// ------------------------------------------------------------------ espaco

let medido = null;

function tamanhoDe(pasta) {
  let total = 0;
  for (const item of fs.readdirSync(pasta, { withFileTypes: true })) {
    const alvo = path.join(pasta, item.name);
    try {
      total += item.isDirectory() ? tamanhoDe(alvo) : fs.statSync(alvo).size;
    } catch {
      // arquivo apagado no meio da contagem
    }
  }
  return total;
}

/**
 * Quanto a pasta de dados ocupa (banco + anexos + copias de restauracao).
 * Varrer milhares de arquivos a cada clique pesa; guarda por 5 minutos.
 */
export function espacoUsado({ fresco = false } = {}) {
  if (!fresco && medido && Date.now() - medido.em < 5 * 60 * 1000) return medido.bytes;
  medido = { bytes: tamanhoDe(PASTA_DADOS), em: Date.now() };
  return medido.bytes;
}

// --------------------------------------------------------------- o que sai

function arquivaveis({ empresa = null, usuarioId = null } = {}) {
  const filtros = [];
  const args = [];
  if (empresa) {
    filtros.push('u.empresa = ?');
    args.push(empresa);
  }
  if (usuarioId) {
    filtros.push('u.id = ?');
    args.push(usuarioId);
  }
  return db
    .prepare(
      `SELECT a.id, a.tipo, a.nome_original, a.arquivo, a.tamanho, r.mes_ref,
              u.id AS usuario_id, u.nome, u.empresa
         FROM anexos a
         JOIN relatorios r ON r.id = a.relatorio_id
         JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.status = 'CERTA' AND a.arquivado_em IS NULL
          ${filtros.map((f) => `AND ${f}`).join(' ')}
        ORDER BY u.empresa, u.nome, r.mes_ref, a.tipo, a.id`,
    )
    .all(...args)
    .filter((a) => fs.existsSync(path.join(PASTA_ANEXOS, a.arquivo)));
}

/** Resumo para a tela: por empresa e, dentro dela, por pessoa. */
export function resumoDoArmazenamento() {
  const empresas = new Map();
  for (const a of arquivaveis()) {
    if (!empresas.has(a.empresa)) {
      empresas.set(a.empresa, { empresa: a.empresa, anexos: 0, bytes: 0, pessoas: new Map() });
    }
    const e = empresas.get(a.empresa);
    e.anexos++;
    e.bytes += a.tamanho;
    if (!e.pessoas.has(a.usuario_id)) {
      e.pessoas.set(a.usuario_id, { usuario_id: a.usuario_id, nome: a.nome, anexos: 0, bytes: 0 });
    }
    const p = e.pessoas.get(a.usuario_id);
    p.anexos++;
    p.bytes += a.tamanho;
  }

  const blocos = db
    .prepare(
      `SELECT b.id, b.rotulo, b.status, b.anexos, b.bytes, b.bytes_zip, b.criado_em,
              b.limpo_em, b.devolvido_em, u.nome AS criado_por
         FROM blocos b LEFT JOIN usuarios u ON u.id = b.criado_por
        WHERE b.status <> 'FALHOU'
        ORDER BY b.id DESC LIMIT 30`,
    )
    .all();

  const usado = espacoUsado();
  return {
    usado,
    limite: LIMITE_AVISO,
    capacidade: CAPACIDADE,
    passou_do_limite: usado >= LIMITE_AVISO,
    empresas: [...empresas.values()].map((e) => ({ ...e, pessoas: [...e.pessoas.values()] })),
    blocos,
  };
}

// ------------------------------------------------------------------ baixar

const limpo = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\w .()-]+/g, '_')
    .trim()
    .slice(0, 80) || 'sem-nome';

/**
 * Gera o zip do bloco direto na resposta. Devolve false quando nao ha nada
 * para arquivar (quem chamou responde com o erro).
 */
export function enviarBloco(res, { empresa = null, usuarioId = null, quem }) {
  const itens = arquivaveis({ empresa, usuarioId });
  if (!itens.length) return false;

  const rotulo = usuarioId ? `${itens[0].empresa} - ${itens[0].nome}` : empresa;
  const bytes = itens.reduce((s, a) => s + a.tamanho, 0);
  const id = Number(
    db
      .prepare(
        `INSERT INTO blocos (rotulo, empresa, usuario_id, anexos, bytes, itens, status, criado_por, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, 'GERANDO', ?, ?)`,
      )
      .run(rotulo, empresa || itens[0].empresa, usuarioId, itens.length, bytes,
        JSON.stringify(itens.map((a) => a.id)), quem?.id ?? null, agora())
      .lastInsertRowid,
  );

  const nomeZip = `portal-rdv-bloco-${id} - ${limpo(rotulo)}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${nomeZip}"`,
    'Cache-Control': 'no-store',
  });

  // Foto e PDF ja vem comprimidos: comprimir de novo so gasta CPU.
  const zip = archiver('zip', { store: true });
  zip.on('error', () => res.destroy());
  zip.pipe(res);

  const manifesto = [];
  for (const a of itens) {
    const caminho = [
      limpo(a.empresa),
      limpo(a.nome),
      a.mes_ref,
      `${a.tipo} - ${a.id} - ${limpo(a.nome_original)}`,
    ].join('/');
    zip.file(path.join(PASTA_ANEXOS, a.arquivo), { name: caminho });
    manifesto.push({ id: a.id, arquivo: a.arquivo, caminho, tamanho: a.tamanho });
  }
  zip.append(
    JSON.stringify({ portal: 'portal-rdv', tipo: 'bloco', bloco: id, rotulo, criado_em: agora(), itens: manifesto }, null, 1),
    { name: MANIFESTO },
  );
  zip.append(
    [
      `Bloco ${id} do Portal RDV - ${rotulo}`,
      '',
      'Comprovantes de relatorios aprovados, tirados do servidor para liberar espaco.',
      'As pastas sao Empresa / Pessoa / Mes.',
      '',
      'Para devolver ao portal: Configuracoes > Armazenamento > "Devolver um bloco".',
      `Envie ESTE arquivo, sem descompactar nem renomear. O ${MANIFESTO} e o que`,
      'diz ao portal para onde cada arquivo volta.',
    ].join('\r\n'),
    { name: 'LEIA-ME.txt' },
  );

  res.on('close', () => {
    if (res.writableFinished) {
      db.prepare("UPDATE blocos SET status = 'BAIXADO', bytes_zip = ? WHERE id = ?").run(zip.pointer(), id);
      log.info('arquivo', 'bloco baixado', { bloco: id, rotulo, anexos: itens.length, por: quem?.login });
    } else {
      db.prepare("UPDATE blocos SET status = 'FALHOU' WHERE id = ?").run(id);
      log.aviso('arquivo', 'download do bloco interrompido', { bloco: id, por: quem?.login });
    }
  });

  zip.finalize();
  return true;
}

// ----------------------------------------------------------------- liberar

/**
 * Apaga do servidor os arquivos do bloco. `tamanhoNoPc` e o tamanho do zip que
 * a pessoa escolheu na tela: tem que ser exatamente o que o servidor gerou,
 * senao o download veio pela metade e apagar seria perder o comprovante.
 */
export function liberarBloco(id, tamanhoNoPc, quem) {
  const b = db.prepare('SELECT * FROM blocos WHERE id = ?').get(Number(id));
  if (!b) throw new Error('Bloco nao encontrado.');
  if (b.status === 'LIMPO') throw new Error('Esse bloco ja foi tirado do servidor.');
  if (b.status !== 'BAIXADO' && b.status !== 'DEVOLVIDO') {
    throw new Error('Esse bloco nao terminou de baixar. Baixe de novo antes de liberar o espaco.');
  }
  if (Number(tamanhoNoPc) !== b.bytes_zip) {
    throw new Error(
      `O arquivo escolhido nao e o bloco ${b.id} inteiro (esperado ${b.bytes_zip} bytes, `
        + `veio ${Number(tamanhoNoPc) || 0}). Nada foi apagado. Baixe o bloco de novo.`,
    );
  }

  const ids = JSON.parse(b.itens || '[]');
  const pega = db.prepare(
    `SELECT a.id, a.arquivo, a.tamanho, r.status FROM anexos a
       JOIN relatorios r ON r.id = a.relatorio_id WHERE a.id = ?`,
  );
  const marca = db.prepare('UPDATE anexos SET arquivado_em = ?, arquivado_bloco = ? WHERE id = ?');
  let apagados = 0;
  let bytes = 0;
  let pulados = 0;
  const quando = agora();
  for (const anexoId of ids) {
    const a = pega.get(anexoId);
    // Relatorio que saiu de aprovado depois do download (reaberto, reprovado)
    // volta a precisar do arquivo: fica no servidor.
    if (!a || a.status !== 'CERTA') {
      pulados++;
      continue;
    }
    try {
      fs.unlinkSync(path.join(PASTA_ANEXOS, a.arquivo));
    } catch {
      // ja nao estava la
    }
    marca.run(quando, b.id, a.id);
    apagados++;
    bytes += a.tamanho;
  }
  db.prepare("UPDATE blocos SET status = 'LIMPO', limpo_em = ? WHERE id = ?").run(quando, b.id);
  espacoUsado({ fresco: true });
  log.info('arquivo', 'bloco tirado do servidor', { bloco: b.id, apagados, pulados, por: quem?.login });
  return { apagados, pulados, bytes };
}

// ---------------------------------------------------------------- devolver

/** Grava o corpo da requisicao num arquivo, sem segurar tudo na memoria. */
async function corpoParaArquivo(req, destino, limite) {
  let total = 0;
  const conta = new Transform({
    transform(pedaco, _cod, feito) {
      total += pedaco.length;
      if (total > limite) return feito(new Error('Arquivo grande demais.'));
      feito(null, pedaco);
    },
  });
  await pipeline(req, conta, fs.createWriteStream(destino));
  return total;
}

/** Recebe o zip de um bloco e poe os arquivos de volta no lugar. */
export async function devolverBloco(req, quem) {
  const temp = path.join(PASTA_DADOS, `devolvendo-${Date.now()}.zip`);
  try {
    const recebido = await corpoParaArquivo(req, temp, 6 * 1024 ** 3);
    if (!recebido) throw new Error('Nenhum arquivo recebido.');

    let dir;
    try {
      dir = await unzipper.Open.file(temp);
    } catch {
      throw new Error('Esse arquivo nao e um .zip valido. Envie o bloco como foi baixado, sem descompactar.');
    }
    const entradaManifesto = dir.files.find((f) => f.path === MANIFESTO);
    if (!entradaManifesto) {
      throw new Error('Esse zip nao e um bloco do portal (falta o manifesto). Para o backup completo use "Restaurar".');
    }
    const manifesto = JSON.parse((await entradaManifesto.buffer()).toString('utf8'));
    const porCaminho = new Map(dir.files.map((f) => [f.path, f]));

    const pega = db.prepare('SELECT id, arquivo, arquivado_em FROM anexos WHERE id = ?');
    const solta = db.prepare('UPDATE anexos SET arquivado_em = NULL, arquivado_bloco = NULL WHERE id = ?');
    let voltaram = 0;
    let jaEstavam = 0;
    let semRegistro = 0;
    for (const item of manifesto.itens || []) {
      const a = pega.get(Number(item.id));
      // O anexo pode ter sido excluido do portal depois; sem registro nao ha
      // onde pendurar o arquivo.
      if (!a || a.arquivo !== item.arquivo) {
        semRegistro++;
        continue;
      }
      if (!a.arquivado_em) {
        jaEstavam++;
        continue;
      }
      const entrada = porCaminho.get(item.caminho);
      if (!entrada) {
        semRegistro++;
        continue;
      }
      // O nome vem do banco, nunca do zip: nada escreve fora da pasta de anexos.
      await pipeline(entrada.stream(), fs.createWriteStream(path.join(PASTA_ANEXOS, path.basename(a.arquivo))));
      solta.run(a.id);
      voltaram++;
    }

    if (manifesto.bloco && voltaram) {
      db.prepare("UPDATE blocos SET status = 'DEVOLVIDO', devolvido_em = ? WHERE id = ?")
        .run(agora(), Number(manifesto.bloco));
    }
    espacoUsado({ fresco: true });
    log.info('arquivo', 'bloco devolvido', { bloco: manifesto.bloco, voltaram, jaEstavam, semRegistro, por: quem?.login });
    return { bloco: manifesto.bloco, voltaram, ja_estavam: jaEstavam, sem_registro: semRegistro };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// ------------------------------------------------------------ aviso diario

/**
 * Confere o espaco de tempos em tempos e manda um e-mail quando passa do
 * limite - no maximo um a cada 3 dias, para nao virar ruido. Usa a mesma conta
 * do backup automatico; sem ela, fica so o aviso no painel e no log.
 */
export function vigiarEspaco() {
  if (process.env.AMBIENTE && process.env.AMBIENTE !== 'producao') return;

  const checar = async () => {
    try {
      const usado = espacoUsado({ fresco: true });
      if (usado < LIMITE_AVISO) return;
      const ultimo = lerConfig('ultimo_aviso_espaco_em');
      if (ultimo && Date.now() - new Date(ultimo) < 3 * 86400000) return;

      const gb = (usado / 1024 ** 3).toFixed(2);
      log.aviso('arquivo', 'armazenamento passou do limite', { usado: `${gb}GB` });

      const { BACKUP_EMAIL_PARA: para, BACKUP_EMAIL_USUARIO: usuario, BACKUP_EMAIL_SENHA: senha } = process.env;
      if (!para || !usuario || !senha) return;
      await nodemailer
        .createTransport({ service: 'gmail', auth: { user: usuario, pass: senha } })
        .sendMail({
          from: `Portal RDV <${usuario}>`,
          to: para,
          subject: `Portal RDV: armazenamento em ${gb} GB de 5 GB`,
          text: [
            `O servidor do Portal RDV esta usando ${gb} GB dos 5 GB do plano.`,
            '',
            'Para liberar espaco: entre como dono, va em Configuracoes > Armazenamento,',
            'baixe os blocos (por empresa ou por pessoa) e depois clique em',
            '"Liberar espaco" em cada um, escolhendo o zip que salvou no computador.',
            '',
            'Os arquivos podem voltar a qualquer momento em "Devolver um bloco".',
          ].join('\n'),
        });
      gravarConfig('ultimo_aviso_espaco_em', agora());
    } catch (e) {
      log.falha('arquivo', 'falha ao conferir o espaco', e);
    }
  };

  setTimeout(checar, 60 * 1000).unref();
  setInterval(checar, 6 * 3600 * 1000).unref();
}
