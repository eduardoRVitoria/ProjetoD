// Backup e restauracao da pasta de dados inteira (banco + anexos).
//
// Serve para duas coisas:
//  1. levar os dados daqui para o servidor no momento da publicacao;
//  2. backup de rotina - a pasta dados/ e o sistema inteiro.
//
// Usa archiver/unzipper, que ja vieram junto com o exceljs.

import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { PASTA_DADOS, PASTA_ANEXOS, db } from './banco.js';

const NOME_BANCO = 'portal-rdv.db';

/** Escreve um .zip da pasta de dados direto na resposta HTTP. */
export function enviarBackup(res, nomeArquivo) {
  // Garante que tudo que esta no WAL entrou no arquivo principal antes de copiar.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // segue mesmo assim - o WAL vai junto no zip
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
    'Cache-Control': 'no-store',
  });

  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => res.destroy());
  zip.pipe(res);

  for (const nome of fs.readdirSync(PASTA_DADOS)) {
    const alvo = path.join(PASTA_DADOS, nome);
    const info = fs.statSync(alvo);
    if (info.isDirectory()) {
      if (nome === 'anexos') zip.directory(alvo, 'anexos');
    } else if (nome === NOME_BANCO || nome.endsWith('.csv')) {
      // So o banco e a lista de senhas iniciais.
      //
      // O -wal e o -shm ficam de fora de proposito: o checkpoint la em cima ja
      // jogou o conteudo deles para dentro do .db, entao nao acrescentam nada -
      // e restaurar um -wal por cima de um banco que esta aberto e a receita
      // para corromper os dois.
      zip.file(alvo, { name: nome });
    }
  }

  return zip.finalize();
}

/**
 * O mesmo backup, so que em memoria.
 *
 * O enviarBackup escreve direto na resposta HTTP, que serve para o download
 * pelo navegador mas nao para anexar num e-mail. Aqui o zip vira um Buffer.
 */
export function gerarBackupEmMemoria() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // segue: o .db ja tem o que foi confirmado ate agora
  }

  return new Promise((resolve, reject) => {
    const pedacos = [];
    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.on('data', (p) => pedacos.push(p));
    zip.on('error', reject);
    zip.on('end', () => resolve(Buffer.concat(pedacos)));

    for (const nome of fs.readdirSync(PASTA_DADOS)) {
      const alvo = path.join(PASTA_DADOS, nome);
      const info = fs.statSync(alvo);
      if (info.isDirectory()) {
        if (nome === 'anexos') zip.directory(alvo, 'anexos');
      } else if (nome === NOME_BANCO || nome.endsWith('.csv')) {
        zip.file(alvo, { name: nome });
      }
    }
    zip.finalize();
  });
}

/**
 * Restaura a partir de um .zip gerado por enviarBackup.
 * Substitui o banco e os anexos. Devolve um resumo do que entrou.
 */
export async function restaurarBackup(bufferZip) {
  let diretorio;
  try {
    diretorio = await unzipper.Open.buffer(bufferZip);
  } catch {
    // A biblioteca devolve coisas como "FILE_ENDED" e "invalid signature".
    // Quem esta na tela mandou um arquivo errado, e e isso que precisa ler.
    throw new Error(
      'Esse arquivo nao e um .zip valido. Envie o arquivo que o botao '
        + '"Baixar backup agora" gerou, sem descompactar nem renomear.',
    );
  }

  const temBanco = diretorio.files.some((f) => f.path === NOME_BANCO);
  if (!temBanco) {
    throw new Error(`O arquivo enviado nao parece um backup do portal: falta o ${NOME_BANCO}.`);
  }

  // Guarda o estado atual antes de sobrescrever.
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const antigo = path.join(PASTA_DADOS, `antes-da-restauracao-${carimbo}`);
  fs.mkdirSync(antigo, { recursive: true });
  for (const nome of fs.readdirSync(PASTA_DADOS)) {
    if (nome.startsWith(NOME_BANCO)) {
      fs.copyFileSync(path.join(PASTA_DADOS, nome), path.join(antigo, nome));
    }
  }

  fs.mkdirSync(PASTA_ANEXOS, { recursive: true });

  let anexos = 0;
  let bytes = 0;

  const recusados = [];

  for (const arquivo of diretorio.files) {
    if (arquivo.type !== 'File') continue;

    // Nunca deixa o zip escrever fora da pasta de dados.
    //
    // A comparacao e por path.relative, nao por startsWith de texto: o
    // destino sai do path.join com as barras do sistema, e comparar as duas
    // strings cruas fazia a guarda recusar TUDO quando a pasta vinha escrita
    // de outro jeito - e recusar em silencio, devolvendo "restaurado" com zero
    // arquivo. Aqui a pergunta e a certa: o destino esta dentro da pasta?
    const relativo = path.normalize(arquivo.path).replace(/^(\.\.[/\\])+/, '');

    // Backup antigo pode trazer -wal/-shm; eles nunca entram. Ver o comentario
    // no enviarBackup: o conteudo ja esta dentro do .db, e escrever por cima
    // dos que estao em uso corrompe o banco.
    if (relativo.endsWith('-wal') || relativo.endsWith('-shm')) continue;

    const destino = path.resolve(PASTA_DADOS, relativo);
    const dentro = path.relative(PASTA_DADOS, destino);
    if (dentro.startsWith('..') || path.isAbsolute(dentro)) {
      recusados.push(arquivo.path);
      continue;
    }

    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const conteudo = await arquivo.buffer();
    fs.writeFileSync(destino, conteudo);
    bytes += conteudo.length;
    if (relativo.startsWith('anexos')) anexos++;
  }

  if (recusados.length) {
    console.warn(`[backup] ${recusados.length} entrada(s) do zip recusadas por apontarem para fora da pasta de dados.`);
  }

  // Um zip que passou na checagem do banco mas nao escreveu nada e sinal de
  // defeito, nao de backup vazio. Falhar alto aqui evita o pior caso possivel:
  // alguem restaurar depois de uma perda, ler "tudo certo" e so descobrir
  // muito depois que nao voltou nada.
  if (bytes === 0) {
    throw new Error(
      'O backup foi lido mas nenhum arquivo pode ser gravado. Nada foi restaurado - '
        + 'o portal continua como estava. Avise o responsavel tecnico.',
    );
  }

  // O -wal e o -shm que sobraram sao do banco ANTIGO. Deixados ali, o SQLite
  // tentaria aplicar um journal que nao pertence mais ao arquivo que acabou de
  // chegar. A copia deles ja foi guardada na pasta antes-da-restauracao.
  for (const sufixo of ['-wal', '-shm']) {
    try {
      fs.rmSync(path.join(PASTA_DADOS, NOME_BANCO + sufixo), { force: true });
    } catch {
      // em uso pelo processo - o reinicio pedido no aviso resolve
    }
  }

  return { anexos, bytes, backupAnterior: path.basename(antigo) };
}

export function resumoDosDados() {
  const conta = (sql) => db.prepare(sql).get().n;
  let tamanho = 0;
  try {
    for (const nome of fs.readdirSync(PASTA_ANEXOS)) {
      tamanho += fs.statSync(path.join(PASTA_ANEXOS, nome)).size;
    }
  } catch {
    // pasta ainda nao existe
  }
  let ultimo = null;
  try {
    ultimo = db.prepare("SELECT valor FROM config WHERE chave = 'ultimo_backup_em'").get()?.valor;
  } catch {
    // config ainda nao existe num banco recem-criado
  }

  return {
    usuarios: conta('SELECT COUNT(*) AS n FROM usuarios'),
    relatorios: conta('SELECT COUNT(*) AS n FROM relatorios'),
    anexos: conta('SELECT COUNT(*) AS n FROM anexos'),
    tamanho_anexos: tamanho,
    pasta: PASTA_DADOS,
    ultimo_backup_em: ultimo || null,
  };
}
