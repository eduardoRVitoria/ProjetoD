// Banco de dados do Portal RDV.
// Usa o SQLite embutido no Node 22+ (node:sqlite) - nao precisa instalar nada.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));

// Em producao (Railway/Render) o disco persistente e montado num caminho proprio
// e vem por DADOS_DIR. Sem a variavel, usa a pasta local do projeto.
// O `resolve` nao e enfeite: o valor vem de fora e pode chegar com barra
// trocada ou caminho relativo. Quem compara este texto com o resultado de um
// path.join - a guarda que impede um zip de escrever fora da pasta - so acerta
// se os dois estiverem escritos do mesmo jeito.
export const PASTA_DADOS = path.resolve(process.env.DADOS_DIR || path.join(aqui, '..', 'dados'));
export const PASTA_ANEXOS = path.join(PASTA_DADOS, 'anexos');

fs.mkdirSync(PASTA_ANEXOS, { recursive: true });

export const db = new DatabaseSync(path.join(PASTA_DADOS, 'portal-rdv.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// Num redeploy o container velho ainda fecha o banco enquanto o novo abre. Sem
// isto, uma escrita que cruza com a dele falha na hora com SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  nome          TEXT NOT NULL,
  email         TEXT,
  papel         TEXT NOT NULL DEFAULT 'colaborador',  -- colaborador | admin
  senha_hash    TEXT NOT NULL,
  senha_salt    TEXT NOT NULL,
  trocar_senha  INTEGER NOT NULL DEFAULT 1,
  ativo         INTEGER NOT NULL DEFAULT 1,
  placas        TEXT,
  criado_em     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessoes (
  token       TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em   TEXT NOT NULL,
  criado_em   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relatorios (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id          INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  mes_ref             TEXT NOT NULL,             -- 'AAAA-MM'
  status              TEXT NOT NULL DEFAULT 'RASCUNHO',
  -- RASCUNHO | ENVIADO | CONFERINDO | CERTA | SO_FALTA_DANFE | ERRADA
  total_km            REAL NOT NULL DEFAULT 0,
  valor_km            REAL NOT NULL DEFAULT 0,
  pedagio_declarado   REAL NOT NULL DEFAULT 0,
  estac_declarado     REAL NOT NULL DEFAULT 0,
  pedagio_comprovado  REAL,
  observacao          TEXT,
  achados             TEXT,                      -- JSON com o resultado da conferencia
  parecer_ia          TEXT,
  o_que_fazer         TEXT,
  decidido_por        INTEGER REFERENCES usuarios(id),
  criado_em           TEXT NOT NULL,
  enviado_em          TEXT,
  conferido_em        TEXT,
  UNIQUE (usuario_id, mes_ref)
);

CREATE TABLE IF NOT EXISTS linhas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  relatorio_id  INTEGER NOT NULL REFERENCES relatorios(id) ON DELETE CASCADE,
  data          TEXT NOT NULL,                   -- 'AAAA-MM-DD'
  km_inicial    REAL NOT NULL DEFAULT 0,
  km_final      REAL NOT NULL DEFAULT 0,
  itinerario    TEXT,
  pedagio       REAL NOT NULL DEFAULT 0,
  estacionamento REAL NOT NULL DEFAULT 0,
  ordem         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS anexos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  relatorio_id   INTEGER NOT NULL REFERENCES relatorios(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL,   -- pedagio | danfe | odometro | hotel | outras_despesas | outro
  nome_original  TEXT NOT NULL,
  arquivo        TEXT NOT NULL,   -- nome do arquivo salvo em dados/anexos
  mime           TEXT NOT NULL,
  tamanho        INTEGER NOT NULL,
  enviado_em     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  chave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);

-- Quanto cada pessoa recebeu num mes que NAO passou pelo portal (agosto/2026,
-- o mes antes da estreia). O admin digita, e o valor serve de base para a
-- regra do aumento sobre o mes anterior - sem ele, setembro nao teria com o
-- que comparar.
CREATE TABLE IF NOT EXISTS valores_pagos (
  usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  mes_ref      TEXT NOT NULL,
  valor        REAL NOT NULL,
  lancado_por  INTEGER,
  lancado_em   TEXT NOT NULL,
  PRIMARY KEY (usuario_id, mes_ref)
);

CREATE INDEX IF NOT EXISTS idx_linhas_rel  ON linhas(relatorio_id);
CREATE INDEX IF NOT EXISTS idx_anexos_rel  ON anexos(relatorio_id);
CREATE INDEX IF NOT EXISTS idx_rel_usuario ON relatorios(usuario_id);
CREATE INDEX IF NOT EXISTS idx_rel_mes     ON relatorios(mes_ref);
`);

// Migracoes leves: colunas que entraram depois. ALTER TABLE dispara erro se a
// coluna ja existe, entao so roda o que falta.
{
  const colunas = new Set(db.prepare('PRAGMA table_info(relatorios)').all().map((c) => c.name));
  if (!colunas.has('mandou_danfe')) {
    // null = derivar dos anexos; 1/0 = resposta explicita (usado na importacao)
    db.exec('ALTER TABLE relatorios ADD COLUMN mandou_danfe INTEGER');
  }
  if (!colunas.has('extraido')) {
    // JSON do que a IA leu no PDF do RDV: linhas, totais declarados e problemas
    db.exec('ALTER TABLE relatorios ADD COLUMN extraido TEXT');
    db.exec('ALTER TABLE relatorios ADD COLUMN extraido_em TEXT');
  }
  if (!colunas.has('assinatura')) {
    // JSON da verificacao da assinatura digital do PDF do RDV
    db.exec('ALTER TABLE relatorios ADD COLUMN assinatura TEXT');
  }
  if (!colunas.has('justificativa')) {
    // Explicacao do colaborador quando o mes vem mais caro que o anterior
    db.exec('ALTER TABLE relatorios ADD COLUMN justificativa TEXT');
  }
  if (!colunas.has('hotel_declarado')) {
    // Hotel e "outras despesas": o quadro do RDV traz os dois fora do km e do
    // pedagio. Entram na conta do mes, mas cada um so vale com o SEU
    // comprovante - a regra esta em conferencia.js, secao 5.1.
    db.exec('ALTER TABLE relatorios ADD COLUMN hotel_declarado REAL NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE relatorios ADD COLUMN outros_declarado REAL NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE relatorios ADD COLUMN outros_descricao TEXT');
  }
  if (!colunas.has('versao_regras')) {
    // Em que versao das regras este parecer foi julgado. NULL = antes de o
    // controle existir, ou seja, antigo - que e a verdade.
    db.exec('ALTER TABLE relatorios ADD COLUMN versao_regras INTEGER');
  }
  if (!colunas.has('pedagio_comprovado_admin')) {
    // Pedagio comprovado que o admin digitou na mao. Enquanto existir, vale
    // mais que a leitura do comprovante - senao "Conferir de novo" apagava a
    // correcao dele. O reenvio pelo colaborador zera.
    db.exec('ALTER TABLE relatorios ADD COLUMN pedagio_comprovado_admin REAL');
  }

  const colLinhas = new Set(db.prepare('PRAGMA table_info(linhas)').all().map((c) => c.name));
  if (!colLinhas.has('hora_pedagio')) {
    // Hora da passagem mais tarde do dia, e o porque dela quando passa das 18h.
    //
    // A grade tem um valor de pedagio por dia, nao passagem a passagem, entao a
    // hora tambem e uma so - e a que interessa para esta regra e a ultima.
    db.exec('ALTER TABLE linhas ADD COLUMN hora_pedagio TEXT');
    db.exec('ALTER TABLE linhas ADD COLUMN justificativa_hora TEXT');
  }
  if (!colLinhas.has('combustivel')) {
    // Gerente e pago pelo combustivel, nao pelo km: cada dia traz quanto ele
    // abasteceu (a coluna "R$ COMBUSTIVEL" do RDV dele).
    db.exec('ALTER TABLE linhas ADD COLUMN combustivel REAL NOT NULL DEFAULT 0');
  }

  const colAnexos = new Set(db.prepare('PRAGMA table_info(anexos)').all().map((c) => c.name));
  if (!colAnexos.has('km')) {
    // Leitura do odometro que o colaborador digita junto com a foto.
    // A foto sozinha nao da para conferir sem alguem ler o numero na mao.
    db.exec('ALTER TABLE anexos ADD COLUMN km REAL');
    db.exec('ALTER TABLE anexos ADD COLUMN data_leitura TEXT');
  }
  if (!colAnexos.has('valor')) {
    // Valor da nota de abastecimento, digitado junto com a DANFE (como o KM na
    // foto do odometro). E com ele que a soma do combustivel do gerente e
    // conferida sem precisar da IA ler nota por nota.
    db.exec('ALTER TABLE anexos ADD COLUMN valor REAL');
  }
  if (!colAnexos.has('arquivado_em')) {
    // Arquivo tirado do servidor para liberar espaco: o registro fica, o
    // arquivo esta no bloco que o dono baixou. Ver src/arquivamento.js.
    db.exec('ALTER TABLE anexos ADD COLUMN arquivado_em TEXT');
    db.exec('ALTER TABLE anexos ADD COLUMN arquivado_bloco INTEGER');
  }
  // Cada zip de arquivamento baixado. `itens` e a lista dos anexos que foram
  // no zip; `bytes_zip` e o tamanho exato gerado, conferido contra o arquivo
  // que o dono escolhe no PC antes de apagar qualquer coisa.
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rotulo        TEXT NOT NULL,
      empresa       TEXT,
      usuario_id    INTEGER,
      anexos        INTEGER NOT NULL,
      bytes         INTEGER NOT NULL,
      bytes_zip     INTEGER,
      itens         TEXT NOT NULL,
      status        TEXT NOT NULL,   -- GERANDO | BAIXADO | FALHOU | LIMPO | DEVOLVIDO
      criado_por    INTEGER,
      criado_em     TEXT NOT NULL,
      limpo_em      TEXT,
      devolvido_em  TEXT
    )
  `);

  // Uma vez so: relatorio lido antes de existir a coluna de hotel/outros tem 0
  // nela e o valor so dentro de `extraido`. A conferencia passou a confiar na
  // coluna, entao o valor do documento e copiado para ela - que e o que a
  // conferencia ja usava para esses relatorios.
  const jaCopiou = db.prepare("SELECT 1 FROM config WHERE chave = 'migracao_hotel_coluna'").get();
  if (!jaCopiou) {
    db.exec(`
      UPDATE relatorios
         SET hotel_declarado = COALESCE(json_extract(extraido, '$.totais_declarados.hotel'), 0)
       WHERE hotel_declarado = 0 AND json_valid(extraido)
         AND json_type(extraido, '$.totais_declarados.hotel') IN ('integer', 'real')
         AND COALESCE(json_extract(extraido, '$.totais_declarados.hotel'), 0) > 0;
      UPDATE relatorios
         SET outros_declarado = COALESCE(json_extract(extraido, '$.totais_declarados.outros'), 0)
       WHERE outros_declarado = 0 AND json_valid(extraido)
         AND json_type(extraido, '$.totais_declarados.outros') IN ('integer', 'real')
         AND COALESCE(json_extract(extraido, '$.totais_declarados.outros'), 0) > 0;
      INSERT INTO config (chave, valor) VALUES ('migracao_hotel_coluna', '1');
    `);
  }

  // Eduardo Ramos e Victor Sarmento sao os unicos que veem e fazem tudo.
  // Fica aqui, e nao num script solto, para valer sozinho a cada publicacao -
  // inclusive se alguem for recadastrado depois.
  // O login e o criterio firme: nao muda quando alguem corrige o nome no
  // cadastro. O nome fica como rede de seguranca, e casa por primeiro+ultimo
  // para aguentar nome do meio ("Eduardo Vitoria Ramos" continua valendo).
  const SUPERS_LOGIN = ['admin', 'victoradm'];
  const SUPERS_NOME = [['EDUARDO', 'RAMOS'], ['VICTOR', 'SARMENTO']];

  const semAcento = (s) =>
    String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toUpperCase();

  const ehUmDosDonos = (u) => {
    if (SUPERS_LOGIN.includes(String(u.login || '').trim().toLowerCase())) return true;
    const partes = semAcento(u.nome).split(/\s+/).filter(Boolean);
    if (!partes.length) return false;
    return SUPERS_NOME.some(
      ([primeiro, ultimo]) => partes[0] === primeiro && partes[partes.length - 1] === ultimo,
    );
  };

  for (const u of db
    .prepare("SELECT id, login, nome, papel FROM usuarios WHERE papel <> 'super'")
    .all()) {
    if (ehUmDosDonos(u)) {
      db.prepare("UPDATE usuarios SET papel = 'super' WHERE id = ?").run(u.id);
    }
  }

  const colUsuarios = new Set(db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name));
  if (!colUsuarios.has('empresa')) {
    db.exec("ALTER TABLE usuarios ADD COLUMN empresa TEXT NOT NULL DEFAULT 'DISO'");
  }
  if (!colUsuarios.has('funcao')) {
    db.exec("ALTER TABLE usuarios ADD COLUMN funcao TEXT NOT NULL DEFAULT 'Vendedor'");
  }
  if (!colUsuarios.has('carro')) {
    // Carro pessoal: foto do odometro obrigatoria. Carro da empresa: nao.
    // Gerente anda de carro da empresa; o resto comeca como pessoal e o admin
    // troca quem tambem usa o da empresa (alguns supervisores).
    db.exec("ALTER TABLE usuarios ADD COLUMN carro TEXT NOT NULL DEFAULT 'pessoal'");
    db.exec("UPDATE usuarios SET carro = 'empresa' WHERE funcao IN ('Gerente', 'Coordenador')");
  }
}

// As frentes do grupo. PROMOTORES e uma janela propria: todo promotor mora la,
// e nao dentro da DISO ou da DSO.
export const EMPRESAS = ['DISO', 'DSO', 'PROMOTORES', 'ALPHA'];

// A funcao entra junto da empresa e vira a sigla: DISO (V), DSO (P).
// As funcoes administrativas ja trazem a empresa no nome, entao aparecem
// inteiras no cracha em vez de virar "DISO (Adm DISO)".
export const FUNCOES = [
  'Vendedor', 'Promotor', 'Supervisor', 'Gerente', 'Coordenador',
  'Adm Promotor', 'Adm DISO', 'Adm DSO', 'Adm ALPHA',
];

export const SIGLA_FUNCAO = {
  Vendedor: 'V',
  Promotor: 'P',
  Supervisor: 'S',
  Gerente: 'G',
  Coordenador: 'C',
  'Adm Promotor': 'AP',
};

// A funcao manda na empresa quando ela ja diz de qual frente e: "Adm DSO" nao
// pode ficar na DISO, e promotor (e quem administra promotor) mora sempre na
// janela PROMOTORES.
const EMPRESA_DA_FUNCAO = {
  'Adm DISO': 'DISO',
  'Adm DSO': 'DSO',
  'Adm ALPHA': 'ALPHA',
  'Adm Promotor': 'PROMOTORES',
  Promotor: 'PROMOTORES',
  Coordenador: 'PROMOTORES',
};

export const empresaDaFuncao = (funcao) => EMPRESA_DA_FUNCAO[funcao] || null;

// De quem e o carro. Com carro da empresa a foto do odometro nao e cobrada.
export const CARROS = ['pessoal', 'empresa'];
export const carroPadrao = (funcao) => (funcao === 'Gerente' || funcao === 'Coordenador' ? 'empresa' : 'pessoal');

// Coordenador lidera os promotores: so o Adm Promotor (e o dono) coloca alguem
// nessa funcao. Os outros administrativos nem enxergam a janela PROMOTORES,
// mas a regra fica explicita para nao depender so do recorte por empresa.
const FUNCOES_SO_ADM_PROMOTOR = ['Coordenador'];

export const podeDarFuncao = (quem, funcao) =>
  !FUNCOES_SO_ADM_PROMOTOR.includes(funcao) || ehSuper(quem) || quem?.funcao === 'Adm Promotor';

// "Adm DISO" e "Adm DSO" ja dizem a empresa, entao aparecem inteiras.
// As demais viram sigla ao lado da empresa: DISO (V), DSO (AP).
export const cracha = (empresa, funcao) => {
  if (empresaDaFuncao(funcao)) return funcao;
  return `${empresa} (${SIGLA_FUNCAO[funcao] || funcao?.[0] || '?'})`;
};

// ---------------------------------------------------------------- configuracao

const PADROES = {
  valor_km: '0.90',
  chave_api: '',
  modelo_ia: 'claude-opus-5',
};

export function lerConfig(chave) {
  const linha = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  if (linha) return linha.valor;
  return PADROES[chave] ?? '';
}

export function gravarConfig(chave, valor) {
  db.prepare(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
  ).run(chave, String(valor));
}

export function valorDoKm() {
  const v = Number.parseFloat(lerConfig('valor_km'));
  return Number.isFinite(v) && v > 0 ? v : 0.9;
}

// A chave da API pode vir da variavel de ambiente ou da tela de configuracao.
export function chaveDaApi() {
  return process.env.ANTHROPIC_API_KEY || lerConfig('chave_api') || '';
}

export const agora = () => new Date().toISOString();

// Quanto o mes pode subir em relacao ao anterior sem precisar de explicacao.
export const MARGEM_AUMENTO = 100;

// ------------------------------------------------------------------- perfis
//
//   colaborador : envia o proprio RDV.
//   admin       : confere, mas SO da propria empresa. Nao cria outro admin.
//   super       : ve e faz tudo, nas duas empresas.
//
// A regra vale no servidor, nao na tela: esconder botao nao impede ninguem de
// chamar a API na mao.

export const PAPEIS = ['colaborador', 'admin', 'super'];

export const ehSuper = (u) => u?.papel === 'super';
export const ehAdmin = (u) => u?.papel === 'admin' || u?.papel === 'super';

/**
 * O que este usuario alcanca. `null` = tudo, e so o super tem isso.
 * Cada administrativo fica preso a propria janela:
 *   Adm DISO     -> empresa DISO
 *   Adm DSO      -> empresa DSO
 *   Adm ALPHA    -> empresa ALPHA
 *   Adm Promotor -> empresa PROMOTORES, onde moram todos os promotores
 *
 * O recorte por funcao (`funcoes`) continua valendo no filtro e na checagem,
 * mas hoje ninguem usa: desde que PROMOTORES virou empresa, separar por
 * empresa ja da conta.
 */
export function escopoDe(u) {
  if (ehSuper(u)) return null;
  return { empresa: u?.empresa || null, funcoes: null, rotulo: u?.empresa || 'sua empresa' };
}

/** Pode enxergar este cadastro (e os relatorios dele)? */
export function podeVerUsuario(quem, alvo) {
  if (!alvo) return false;
  const e = escopoDe(quem);
  if (!e) return true;
  if (e.empresa && alvo.empresa !== e.empresa) return false;
  if (e.funcoes && !e.funcoes.includes(alvo.funcao)) return false;
  return true;
}

/** Alem de enxergar, pode alterar? Admin nao mexe em admin nem em super. */
export function podeMexerNoUsuario(quem, alvo) {
  if (!alvo) return false;
  if (ehSuper(quem)) return true;
  if (quem.papel !== 'admin') return false;
  if (!podeVerUsuario(quem, alvo)) return false;
  return alvo.papel === 'colaborador';
}

/**
 * Devolve o pedaco de SQL e os argumentos que aplicam o escopo numa consulta
 * onde a tabela usuarios esta como `u`.
 */
export function filtroSql(quem) {
  const e = escopoDe(quem);
  if (!e) return { sql: '', args: [] };

  const partes = [];
  const args = [];
  if (e.empresa) {
    partes.push('u.empresa = ?');
    args.push(e.empresa);
  }
  if (e.funcoes?.length) {
    partes.push(`u.funcao IN (${e.funcoes.map(() => '?').join(', ')})`);
    args.push(...e.funcoes);
  }
  return { sql: partes.length ? `AND ${partes.join(' AND ')}` : '', args };
}
