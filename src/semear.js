// Primeira carga do volume, para quando o portal sobe num disco vazio.
//
// A Railway apagou o volume junto com os deployments enquanto a conta estava no
// plano Trial, e o portal voltou ao ar sem nenhum colaborador. Este script leva
// a copia da pasta `semente/` para o disco na PRIMEIRA subida - depois disso ele
// nao encosta em nada.
//
// IMPORTANTE: no servidor a pasta `semente/` normalmente NAO existe. Ela esta
// no .gitignore para nao levar comprovante fiscal para o historico do git, e o
// `railway up` respeita esse arquivo - entao la em cima este script so anuncia
// que vai comecar do zero. Quem recupera dado perdido e o backup: o e-mail
// diario ou o cartao em Configuracoes. A semente serve para montar ambiente de
// teste na maquina local, onde a pasta existe de verdade.
//
// Roda ANTES do servidor (ver o CMD do Dockerfile), porque o banco.js abre o
// banco assim que e importado: se a copia nao estiver no lugar antes disso, o
// portal cria um banco vazio - e um banco vazio nao tem NENHUM usuario, ou
// seja, ninguem consegue nem entrar.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const PASTA_DADOS = process.env.DADOS_DIR || path.join(aqui, '..', 'dados');
const PASTA_SEMENTE = path.join(aqui, '..', 'semente');
const BANCO = 'portal-rdv.db';

/**
 * O disco esta virgem?
 *
 * Sem arquivo de banco, esta. Mas o caso que trouxe este script foi outro: o
 * volume novo subiu com um banco que o proprio portal criou na primeira
 * conexao - existe, tem as tabelas e NENHUM usuario. Um banco sem usuario nao e
 * dado de producao, e ninguem consegue nem entrar no portal; sobrescrever esse
 * e seguro.
 *
 * Ja um banco com um unico usuario cadastrado e trabalho de alguem, e fica.
 */
function discoVirgem() {
  const arquivo = path.join(PASTA_DADOS, BANCO);
  if (!fs.existsSync(arquivo)) return true;
  try {
    const db = new DatabaseSync(arquivo, { readOnly: true });
    const { c } = db.prepare('SELECT COUNT(*) c FROM usuarios').get();
    db.close();
    return c === 0;
  } catch {
    // Sem tabela `usuarios`, ilegivel ou corrompido: nao ha o que preservar.
    return true;
  }
}

// A guarda: um banco ja povoado e dado de producao e nunca pode ser
// sobrescrito - restaurar por cima apagaria o que os vendedores lancaram
// desde a subida.
/** Quem ja esta no disco - o log que explica por que o semear nao agiu. */
function quemJaEsta() {
  try {
    const db = new DatabaseSync(path.join(PASTA_DADOS, BANCO), { readOnly: true });
    const linhas = db.prepare('SELECT login, nome, papel, empresa FROM usuarios ORDER BY nome').all();
    const rel = db.prepare('SELECT COUNT(*) c FROM relatorios').get().c;
    db.close();
    return { linhas, rel };
  } catch (e) {
    return { linhas: [], rel: 0, erro: e.message };
  }
}

// Restauracao deliberada, para o caso em que o disco NAO esta virgem mas o que
// esta nele e descartavel - foi o que aconteceu aqui: o volume voltou com um
// unico admin criado na tentativa de entrar, e esse admin sozinho bloqueava a
// volta dos 13 colaboradores.
//
// Fica atras de uma variavel de ambiente de proposito: sobrescrever banco de
// producao nunca pode ser efeito colateral de um deploy comum. Ligue a
// SEMEAR_FORCAR, faca o deploy, e DESLIGUE logo depois.
const FORCAR = process.env.SEMEAR_FORCAR === '1';

if (FORCAR && fs.existsSync(path.join(PASTA_DADOS, BANCO))) {
  // O que esta saindo do lugar fica guardado no proprio volume, com carimbo de
  // hora, caso a decisao de restaurar tenha sido um engano.
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const guardado = path.join(PASTA_DADOS, `substituido-${carimbo}-${BANCO}`);
  fs.copyFileSync(path.join(PASTA_DADOS, BANCO), guardado);
  console.log(`[semear] SEMEAR_FORCAR ligado. Banco atual guardado em ${path.basename(guardado)}.`);
}

// Reset total do ambiente de teste, guardado atras de ZERAR_TUDO=1.
//
// Apaga TODOS os relatorios, linhas e anexos, e todos os usuarios que NAO sao
// donos - papel 'super' fica, para ninguem trancar a si mesmo pra fora. O banco
// atual e copiado antes, com carimbo de hora, caso tenha sido engano.
//
// Mesma disciplina do SEMEAR_FORCAR: ligue ZERAR_TUDO=1, faca UM deploy, e
// DESLIGUE logo depois - senao todo boot zera de novo.
if (process.env.ZERAR_TUDO === '1' && fs.existsSync(path.join(PASTA_DADOS, BANCO))) {
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const guardado = path.join(PASTA_DADOS, `antes-de-zerar-${carimbo}-${BANCO}`);
  fs.copyFileSync(path.join(PASTA_DADOS, BANCO), guardado);
  for (const sufixo of ['-wal', '-shm']) {
    fs.rmSync(path.join(PASTA_DADOS, BANCO + sufixo), { force: true });
  }

  const db = new DatabaseSync(path.join(PASTA_DADOS, BANCO));
  const antes = db.prepare('SELECT COUNT(*) c FROM usuarios').get().c;
  for (const sql of ['DELETE FROM anexos', 'DELETE FROM linhas', 'DELETE FROM relatorios', 'DELETE FROM sessoes']) {
    try { db.exec(sql); } catch { /* tabela pode nao existir num banco antigo */ }
  }
  const apagados = db.prepare("DELETE FROM usuarios WHERE papel <> 'super'").run().changes;
  const donos = db.prepare('SELECT login FROM usuarios ORDER BY login').all();
  db.close();

  // Os arquivos dos anexos no disco tambem saem - as linhas do banco ja foram.
  const pastaAnexos = path.join(PASTA_DADOS, 'anexos');
  if (fs.existsSync(pastaAnexos)) {
    for (const f of fs.readdirSync(pastaAnexos)) {
      fs.rmSync(path.join(pastaAnexos, f), { force: true, recursive: true });
    }
  }

  console.log(`[semear] ZERAR_TUDO: ${apagados} usuarios apagados (de ${antes}); relatorios, linhas e anexos zerados. Backup em ${path.basename(guardado)}.`);
  console.log(`[semear] Donos mantidos (papel super): ${donos.map((d) => d.login).join(', ') || 'NENHUM - CUIDADO, ninguem entra!'}`);
}

if (!FORCAR && !discoVirgem()) {
  const { linhas, rel } = quemJaEsta();
  console.log(`[semear] O disco ja tem ${linhas.length} usuarios e ${rel} relatorios. Nada a fazer.`);
  for (const u of linhas) {
    console.log(`[semear]   ${u.login} | ${u.nome} | ${u.papel} | ${u.empresa}`);
  }
} else if (!fs.existsSync(path.join(PASTA_SEMENTE, BANCO))) {
  console.log('[semear] Sem pasta semente. O portal vai comecar do zero.');
} else {
  fs.mkdirSync(PASTA_DADOS, { recursive: true });

  // O -wal e o -shm do banco vazio precisam sair antes: sobrescrever so o .db
  // deixaria o SQLite tentando aplicar um journal que nao pertence mais a ele.
  for (const sufixo of ['-wal', '-shm']) {
    fs.rmSync(path.join(PASTA_DADOS, BANCO + sufixo), { force: true });
  }

  fs.copyFileSync(path.join(PASTA_SEMENTE, BANCO), path.join(PASTA_DADOS, BANCO));

  const anexos = path.join(PASTA_SEMENTE, 'anexos');
  if (fs.existsSync(anexos)) {
    fs.cpSync(anexos, path.join(PASTA_DADOS, 'anexos'), { recursive: true });
  }

  const quantos = fs.existsSync(path.join(PASTA_DADOS, 'anexos'))
    ? fs.readdirSync(path.join(PASTA_DADOS, 'anexos')).length
    : 0;
  console.log(`[semear] Disco vazio: banco e ${quantos} anexos restaurados da semente.`);

}

/**
 * Fora de producao a chave da API sai do banco. Sempre, a cada subida.
 *
 * A chave da Anthropic mora dentro do banco, e um ambiente de teste chega a
 * ela por dois caminhos: a semente, que e copia do banco de verdade, e a
 * duplicacao do ambiente na Railway, que pode trazer o disco junto. Limpar so
 * na semeadura cobriria o primeiro e deixaria o segundo passar - por isso a
 * limpeza roda toda vez, nao so quando o disco esta vazio.
 *
 * Sem ela, subir um ambiente descartavel ja o deixa apto a gastar credito
 * real - e a conferencia com IA e justamente o que mais se quer exercitar em
 * teste.
 */
if (process.env.AMBIENTE && process.env.AMBIENTE !== 'producao') {
  try {
    const db = new DatabaseSync(path.join(PASTA_DADOS, BANCO));
    const n = db.prepare("DELETE FROM config WHERE chave = 'chave_api'").run().changes;
    db.close();
    console.log(
      `[semear] AMBIENTE=${process.env.AMBIENTE}: chave da API ${n ? 'REMOVIDA' : 'nao estava'} no banco.`,
    );
  } catch (e) {
    // Banco novo ainda nao tem a tabela `config` - ela nasce quando o banco.js
    // e importado, depois daqui. Sem tabela nao ha chave, entao esta tudo bem;
    // gritar aqui so encheria o log de erro que nao e erro.
    const semTabela = /no such table/i.test(e.message);
    console.log(
      semTabela
        ? `[semear] AMBIENTE=${process.env.AMBIENTE}: banco novo, nao ha chave de API para remover.`
        : `[semear] Nao consegui remover a chave da API: ${e.message}`,
    );
  }
}
