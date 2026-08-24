// Login, senha e sessao. Sem dependencia externa: scrypt e randomBytes do proprio Node.

import crypto from 'node:crypto';
import { db, agora } from './banco.js';

const DIAS_DE_SESSAO = 30;

export function gerarHash(senha, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { hash, salt };
}

export function senhaConfere(senha, hashGravado, salt) {
  const { hash } = gerarHash(senha, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashGravado, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function criarUsuario({ login, nome, email = null, papel = 'colaborador', senha, placas = null }) {
  const { hash, salt } = gerarHash(senha);
  const info = db
    .prepare(
      `INSERT INTO usuarios (login, nome, email, papel, senha_hash, senha_salt, trocar_senha, placas, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(login.trim().toLowerCase(), nome.trim(), email, papel, hash, salt, placas, agora());
  return Number(info.lastInsertRowid);
}

export function trocarSenha(usuarioId, novaSenha) {
  const { hash, salt } = gerarHash(novaSenha);
  db.prepare('UPDATE usuarios SET senha_hash = ?, senha_salt = ?, trocar_senha = 0 WHERE id = ?').run(
    hash,
    salt,
    usuarioId,
  );
  // Uma troca de senha derruba as outras sessoes da pessoa.
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuarioId);
}

export function autenticar(login, senha) {
  const u = db
    .prepare('SELECT * FROM usuarios WHERE login = ? AND ativo = 1')
    .get(String(login || '').trim().toLowerCase());
  if (!u) return null;
  if (!senhaConfere(senha, u.senha_hash, u.senha_salt)) return null;
  return u;
}

export function abrirSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + DIAS_DE_SESSAO * 86400_000).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em, criado_em) VALUES (?, ?, ?, ?)').run(
    token,
    usuarioId,
    expira,
    agora(),
  );
  return token;
}

export function fecharSessao(token) {
  if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

export function usuarioDaSessao(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessoes WHERE token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expira_em) < new Date()) {
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(s.usuario_id) || null;
}

export function limparSessoesVencidas() {
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(agora());
}

// ------------------------------------------------------------------- cookies

export function lerCookies(req) {
  const bruto = req.headers.cookie || '';
  const saida = {};
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    saida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return saida;
}

export function cookieDeSessao(token, seguro) {
  const base = `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DIAS_DE_SESSAO * 86400}`;
  return seguro ? `${base}; Secure` : base;
}

export const cookieDeSaida = 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
