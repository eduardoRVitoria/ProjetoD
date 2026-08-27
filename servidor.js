// Portal RDV - servidor HTTP.
// Sem framework: http, fs e o sqlite embutido do Node. Nada de node_modules
// alem do SDK oficial da Anthropic.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { db, agora } from './src/banco.js';
import { usuarioDaSessao, lerCookies, limparSessoesVencidas, criarUsuario } from './src/auth.js';
import { tratarApi } from './src/rotas.js';
import { responderJson, erro } from './src/util.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(aqui, 'publico');
const PORTA = Number(process.env.PORT) || 3000;

const MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// --------------------------------------------------------- primeiro acesso

function garantirAdmin() {
  const qtd = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin'").get().n;
  if (qtd > 0) return null;
  const senha = 'rdv2026';
  criarUsuario({
    login: 'admin',
    nome: 'Eduardo Ramos',
    papel: 'admin',
    senha,
  });
  return senha;
}

// ------------------------------------------------------------------ estatico

function servirEstatico(req, res, rota) {
  let relativo = rota === '/' ? '/index.html' : rota;
  // impede sair da pasta publico
  const destino = path.join(PUBLICO, path.normalize(relativo).replace(/^(\.\.[/\\])+/, ''));
  if (!destino.startsWith(PUBLICO)) return erro(res, 'Caminho invalido.', 403);

  if (!fs.existsSync(destino) || fs.statSync(destino).isDirectory()) {
    return erro(res, 'Pagina nao encontrada.', 404);
  }

  const ext = path.extname(destino).toLowerCase();
  const dados = fs.readFileSync(destino);

  // HTML, JS e CSS nunca podem ficar em cache: uma versao velha de um deles
  // junto com a nova do outro derruba a tela inteira. Imagem e manifest podem.
  const codigo = ['.html', '.js', '.css'].includes(ext);

  res.writeHead(200, {
    'Content-Type': MIMES[ext] || 'application/octet-stream',
    'Content-Length': dados.length,
    'Cache-Control': codigo ? 'no-store, must-revalidate' : 'public, max-age=3600',
  });
  res.end(dados);
}

// ------------------------------------------------------------------ servidor

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;

  // atras de um tunel/proxy https o cookie precisa ser Secure
  const seguro =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  try {
    if (rota.startsWith('/api/')) {
      const usuario = usuarioDaSessao(lerCookies(req).sid);
      return await tratarApi(req, res, url, usuario, seguro);
    }

    // As paginas protegidas so abrem com sessao valida.
    if (rota === '/app.html' || rota === '/admin.html') {
      const usuario = usuarioDaSessao(lerCookies(req).sid);
      if (!usuario) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      if (rota === '/admin.html' && !['admin', 'super'].includes(usuario.papel)) {
        res.writeHead(302, { Location: '/app.html' });
        return res.end();
      }
    }

    servirEstatico(req, res, rota);
  } catch (e) {
    console.error(`[${agora()}] erro em ${req.method} ${rota}:`, e);
    if (!res.headersSent) {
      responderJson(res, { erro: e.message || 'Erro interno do servidor.' }, 500);
    } else {
      res.end();
    }
  }
});

function enderecosDaRede() {
  const saida = [];
  for (const listas of Object.values(os.networkInterfaces())) {
    for (const i of listas || []) {
      if (i.family === 'IPv4' && !i.internal) saida.push(i.address);
    }
  }
  return saida;
}

limparSessoesVencidas();
const senhaInicial = garantirAdmin();

servidor.listen(PORTA, '0.0.0.0', () => {
  console.log('');
  console.log('  Portal RDV - DISO Comercio de Alimentos');
  console.log('  ----------------------------------------------------');
  console.log(`  Neste PC:      http://localhost:${PORTA}`);
  for (const ip of enderecosDaRede()) {
    console.log(`  Na rede local: http://${ip}:${PORTA}`);
  }
  if (senhaInicial) {
    console.log('');
    console.log('  PRIMEIRO ACESSO - usuario administrador criado:');
    console.log('     login: admin');
    console.log(`     senha: ${senhaInicial}`);
    console.log('     (troque a senha no primeiro login)');
  }
  console.log('');
});
