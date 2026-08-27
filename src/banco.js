// Banco de dados do Portal RDV.
// Usa o SQLite embutido no Node 22+ (node:sqlite) - nao precisa instalar nada.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));

// Em producao (Railway/Render) o disco persistente e montado num caminho proprio
// e vem por DADOS_DIR. Sem a variavel, usa a pasta local do projeto.
export const PASTA_DADOS = process.env.DADOS_DIR || path.join(aqui, '..', 'dados');
export const PASTA_ANEXOS = path.join(PASTA_DADOS, 'anexos');

fs.mkdirSync(PASTA_ANEXOS, { recursive: true });

export const db = new DatabaseSync(path.join(PASTA_DADOS, 'portal-rdv.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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
  tipo           TEXT NOT NULL,   -- pedagio | danfe | odometro | outro
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

  const colUsuarios = new Set(db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name));
  if (!colUsuarios.has('empresa')) {
    db.exec("ALTER TABLE usuarios ADD COLUMN empresa TEXT NOT NULL DEFAULT 'DISO'");
  }
  if (!colUsuarios.has('funcao')) {
    db.exec("ALTER TABLE usuarios ADD COLUMN funcao TEXT NOT NULL DEFAULT 'Vendedor'");
  }
}

// As duas empresas do grupo.
export const EMPRESAS = ['DISO', 'DSO'];

// A funcao entra junto da empresa e vira a sigla: DISO (V), DSO (P).
// As funcoes administrativas ja trazem a empresa no nome, entao aparecem
// inteiras no cracha em vez de virar "DISO (Adm DISO)".
export const FUNCOES = [
  'Vendedor', 'Promotor', 'Supervisor', 'Adm Promotor', 'Adm DISO', 'Adm DSO',
];

export const SIGLA_FUNCAO = {
  Vendedor: 'V',
  Promotor: 'P',
  Supervisor: 'S',
  'Adm Promotor': 'AP',
};

// Funcao administrativa manda na empresa: "Adm DSO" nao pode ficar na DISO.
export const empresaDaFuncao = (funcao) =>
  funcao === 'Adm DISO' ? 'DISO' : funcao === 'Adm DSO' ? 'DSO' : null;

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
export const MARGEM_AUMENTO = 200;
