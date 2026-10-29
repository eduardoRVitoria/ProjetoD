// Notificacao no celular (Web Push).
//
// Cada aparelho que aceita "Permitir notificacoes" ganha um endereco no
// servico de push do fabricante (Google, Apple, Mozilla). O portal guarda esse
// endereco em `aparelhos` e, para avisar alguem, manda a mensagem para la.
//
// Quem nunca aceitou nao tem endereco - nao ha como alcancar. Por isso a lista
// so cresce a partir de quem abre o portal e toca em "Permitir".
//
// iPhone so recebe com o portal instalado na tela de inicio (iOS 16.4+).

import webpush from 'web-push';
import { db, agora, lerConfig, gravarConfig } from './banco.js';
import * as log from './log.js';

db.exec(`
CREATE TABLE IF NOT EXISTS aparelhos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  descricao   TEXT,                       -- "Android - Chrome", "iPhone"
  instalado   INTEGER NOT NULL DEFAULT 0, -- aberto como app da tela de inicio
  criado_em   TEXT NOT NULL,
  visto_em    TEXT NOT NULL,
  ultimo_envio TEXT,
  ultimo_erro TEXT
);
CREATE INDEX IF NOT EXISTS idx_aparelhos_usuario ON aparelhos(usuario_id);
`);

// As chaves VAPID identificam o portal para o servico de push. Sao geradas uma
// vez e ficam no banco: trocar de chave invalida TODAS as inscricoes, e cada
// celular teria que aceitar de novo. Variavel de ambiente vence o banco, para
// quem quiser fixar por fora.
function chaves() {
  let publica = process.env.VAPID_PUBLICA || lerConfig('vapid_publica');
  let privada = process.env.VAPID_PRIVADA || lerConfig('vapid_privada');
  if (!publica || !privada) {
    const novas = webpush.generateVAPIDKeys();
    publica = novas.publicKey;
    privada = novas.privateKey;
    gravarConfig('vapid_publica', publica);
    gravarConfig('vapid_privada', privada);
    log.info('push', 'chaves VAPID geradas');
  }
  return { publica, privada };
}

export function chavePublica() {
  return chaves().publica;
}

/** Grava (ou renova) a inscricao deste aparelho para este usuario. */
export function inscrever(usuarioId, inscricao, { descricao, instalado }) {
  const endpoint = String(inscricao?.endpoint || '');
  const p256dh = String(inscricao?.keys?.p256dh || '');
  const auth = String(inscricao?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    throw new Error('Inscricao de notificacao invalida.');
  }
  const quando = agora();
  // O mesmo celular pode trocar de dono (alguem sai e outro entra). O
  // endereco e do aparelho, entao ele passa para quem esta logado agora.
  db.prepare(
    `INSERT INTO aparelhos (usuario_id, endpoint, p256dh, auth, descricao, instalado, criado_em, visto_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth,
       descricao = excluded.descricao, instalado = excluded.instalado,
       visto_em = excluded.visto_em, ultimo_erro = NULL`,
  ).run(
    usuarioId, endpoint, p256dh, auth,
    String(descricao || '').slice(0, 80), instalado ? 1 : 0, quando, quando,
  );
}

export function desinscrever(usuarioId, endpoint) {
  db.prepare('DELETE FROM aparelhos WHERE usuario_id = ? AND endpoint = ?').run(usuarioId, String(endpoint || ''));
}

/**
 * Manda a mesma mensagem para uma lista de aparelhos.
 * Endereco que o servico diz que nao existe mais (404/410) e apagado: o
 * celular desinstalou, limpou os dados ou tirou a permissao.
 */
export async function enviar(aparelhos, { titulo, texto, url, contato }) {
  const { publica, privada } = chaves();
  const detalhes = {
    // `subject` e o contato que o servico de push usa se o portal abusar. Vem
    // do endereco do proprio portal, para nao gravar a URL no codigo.
    vapidDetails: {
      subject: process.env.PORTAL_URL || contato,
      publicKey: publica,
      privateKey: privada,
    },
    TTL: 60 * 60 * 24 * 3, // celular desligado recebe se ligar em ate 3 dias
  };
  const corpo = JSON.stringify({ titulo, texto, url: url || '/' });

  const resultado = { enviados: 0, removidos: 0, falhas: 0 };
  await Promise.all(
    aparelhos.map(async (a) => {
      try {
        await webpush.sendNotification(
          { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
          corpo,
          detalhes,
        );
        db.prepare('UPDATE aparelhos SET ultimo_envio = ?, ultimo_erro = NULL WHERE id = ?').run(agora(), a.id);
        resultado.enviados++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          db.prepare('DELETE FROM aparelhos WHERE id = ?').run(a.id);
          resultado.removidos++;
        } else {
          // Falha de rede chega sem statusCode e as vezes com message vazia.
          const motivo = (`${e.statusCode || ''} ${e.body || e.message || ''}`.trim() || e.code || 'falha de rede')
            .slice(0, 200);
          db.prepare('UPDATE aparelhos SET ultimo_erro = ? WHERE id = ?').run(motivo, a.id);
          log.aviso('push', 'falha ao notificar', { aparelho: a.id, motivo });
          resultado.falhas++;
        }
      }
    }),
  );
  return resultado;
}
