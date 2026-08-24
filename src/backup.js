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
    } else if (nome.startsWith(NOME_BANCO) || nome.endsWith('.csv')) {
      // banco, -wal, -shm e a lista de senhas iniciais
      zip.file(alvo, { name: nome });
    }
  }

  return zip.finalize();
}

/**
 * Restaura a partir de um .zip gerado por enviarBackup.
 * Substitui o banco e os anexos. Devolve um resumo do que entrou.
 */
export async function restaurarBackup(bufferZip) {
  const diretorio = await unzipper.Open.buffer(bufferZip);

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

  for (const arquivo of diretorio.files) {
    if (arquivo.type !== 'File') continue;

    // Nunca deixa o zip escrever fora da pasta de dados.
    const relativo = path.normalize(arquivo.path).replace(/^(\.\.[/\\])+/, '');
    const destino = path.join(PASTA_DADOS, relativo);
    if (!destino.startsWith(PASTA_DADOS)) continue;

    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const conteudo = await arquivo.buffer();
    fs.writeFileSync(destino, conteudo);
    bytes += conteudo.length;
    if (relativo.startsWith('anexos')) anexos++;
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
  return {
    usuarios: conta('SELECT COUNT(*) AS n FROM usuarios'),
    relatorios: conta('SELECT COUNT(*) AS n FROM relatorios'),
    anexos: conta('SELECT COUNT(*) AS n FROM anexos'),
    tamanho_anexos: tamanho,
    pasta: PASTA_DADOS,
  };
}
