// Portal RDV - servidor HTTP.
// Sem framework: http, fs e o sqlite embutido do Node. Nada de node_modules
// alem do SDK oficial da Anthropic.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { db, agora } from './src/banco.js';
import { usuarioDaSessao, lerCookies, limparSessoesVencidas, criarUsuario } from './src/auth.js';
import { tratarApi } from './src/rotas.js';
import { responderJson, erro, ipDoPedido } from './src/util.js';
import * as log from './src/log.js';
import { agendarBackupDiario } from './src/backup-automatico.js';

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
  const qtd = db
    .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel IN ('admin', 'super')").get().n;
  if (qtd > 0) return null;
  const senha = 'rdv2026';
  criarUsuario({
    login: 'admin',
    nome: 'Eduardo Ramos',
    papel: 'super',
    funcao: 'Adm DSO',
    empresa: 'DSO',
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

// -------------------------------------------------------------- cabecalhos

/**
 * A politica de conteudo da pagina.
 *
 * `script-src 'self'` so vale a pena porque nao ha mais <script> escrito dentro
 * do HTML - o do login virou /js/entrar.js. Com script embutido, a unica CSP
 * possivel seria com 'unsafe-inline', que autoriza justamente o que ela existe
 * para barrar.
 *
 * O 'unsafe-inline' fica em style-src, e nao da para tirar por enquanto: as tres
 * telas usam `style=` direto no elemento em dezenas de lugares, e o index tem um
 * <style> proprio. Estilo injetado faz muito menos estrago que script, entao
 * essa fica para quando os style= sairem do HTML e do JS.
 *
 * blob: em img-src: o app.js mostra a previa da foto do odometro por
 * URL.createObjectURL antes de enviar.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function aplicarCabecalhosDeSeguranca(res, seguro) {
  // Valem como padrao para toda resposta. Quem chama writeHead depois com o
  // mesmo nome sobrescreve - e o que o download de anexo faz, com uma politica
  // mais fechada ainda.
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // So faz sentido quando a conexao ja e https: no acesso pela rede local, que
  // e http, isto trancaria o portal fora do ar para quem abrisse uma vez.
  if (seguro) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

// ------------------------------------------------------------------ servidor

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;
  const comeco = Date.now();

  // atras de um tunel/proxy https o cookie precisa ser Secure
  const seguro =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  aplicarCabecalhosDeSeguranca(res, seguro);

  // Uma linha por chamada de API, escrita quando a resposta termina - so ai se
  // sabe o status e quanto demorou. Arquivo estatico fica de fora: CSS e icone
  // enchendo o log escondem o que importa.
  //
  // A rota vai sem a query string de proposito: ela carrega nome de arquivo e
  // mes, e o log nao precisa disso para responder "quem fez o que".
  if (rota.startsWith('/api/')) {
    res.on('finish', () => {
      const quem = res.locals?.usuario;
      const dados = { quem, ip: ipDoPedido(req) };
      const linha = `${req.method} ${rota} ${res.statusCode} ${log.desde(comeco)}`;
      if (res.statusCode >= 500) log.falha('http', linha, null, dados);
      else if (res.statusCode >= 400) log.aviso('http', linha, dados);
      else log.info('http', linha, dados);
    });
  }

  try {
    if (rota.startsWith('/api/')) {
      const usuario = usuarioDaSessao(lerCookies(req).sid);
      // Guardado para a linha de log la em cima, que so roda no fim da resposta.
      res.locals = { usuario: usuario?.login };
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
    // O erro que chega aqui e o que ninguem previu. A mensagem crua dele conta
    // coisas que o usuario nao deve ver - caminho de arquivo do servidor,
    // trecho de SQL, nome de coluna -, entao ela fica so no log.
    //
    // A ponte entre os dois e a etiqueta: a pessoa le um codigo curto na tela e
    // repete para o administrador, que acha a linha exata no log da Railway.
    // Sem isso, "deu erro" vira uma investigacao as cegas.
    const etiqueta = crypto.randomBytes(3).toString('hex').toUpperCase();
    log.falha('http', `falha interna em ${req.method} ${rota}`, e, { etiqueta });
    if (!res.headersSent) {
      responderJson(
        res,
        {
          erro: 'Algo deu errado aqui no servidor, e nao foi culpa do que voce fez. '
            + `Tente de novo; se repetir, passe este codigo para o administrador: ${etiqueta}`,
        },
        500,
      );
    } else {
      // Resposta ja comecou a sair (download de anexo, planilha, PDF). Nao da
      // para trocar por JSON: encerra e o navegador acusa o arquivo incompleto.
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

// ------------------------------------------------- o processo nao pode sumir

/**
 * Promessa rejeitada que ninguem pegou.
 *
 * Nao derruba nada: quase sempre e uma operacao isolada que falhou - uma
 * chamada da IA, a leitura de um anexo - e o resto do portal continua inteiro.
 * Sem este ouvinte o Node encerra o processo, e um relatorio com problema
 * desconectaria todo mundo que estivesse usando.
 */
process.on('unhandledRejection', (motivo) => {
  log.falha('processo', 'promessa rejeitada sem tratamento', motivo);
});

/**
 * Excecao que escapou de todos os try.
 *
 * Aqui e diferente: o processo pode ter ficado num estado que nao da para
 * confiar, e seguir atendendo poderia gravar dado errado no banco. Entao o
 * portal fecha com cuidado e deixa a Railway subir um container limpo - alguns
 * segundos fora do ar valem mais que um relatorio corrompido.
 */
process.on('uncaughtException', (e) => {
  log.falha('processo', 'excecao nao tratada - encerrando para reiniciar limpo', e);
  encerrar(1);
});

// A Railway manda SIGTERM antes de trocar o container. Fechar o banco na mao
// garante que o WAL entre no arquivo principal: e o que evita o banco ficar
// pela metade quando um deploy pega alguem salvando.
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    log.info('processo', `${sinal} recebido - encerrando o portal`);
    encerrar(0);
  });
}

let encerrando = false;
function encerrar(codigo) {
  if (encerrando) return;
  encerrando = true;

  // Se algo travar no caminho, o processo sai assim mesmo em 8 segundos.
  const tranca = setTimeout(() => process.exit(codigo), 8000);
  tranca.unref();

  servidor.close(() => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (e) {
      log.falha('processo', 'falha ao fechar o banco', e);
    }
    process.exit(codigo);
  });
}

/**
 * Solta quem ficou preso em "Em conferencia".
 *
 * A conferencia roda em segundo plano e leva uns 30 segundos. Se o container
 * reinicia no meio - um deploy, um restart da Railway - ela morre e o relatorio
 * fica em CONFERINDO para sempre: o painel mostra "Em conferencia" e nao sai
 * mais dali, porque nada vai retomar aquela chamada.
 *
 * CONFERINDO so existe DURANTE a conferencia. Se ha algum nesse estado quando o
 * servidor esta subindo, e porque a anterior nao terminou - entao volta para
 * ENVIADO, que e o estado real: enviado e esperando conferencia.
 */
function soltarConferenciasInterrompidas() {
  const presos = db.prepare("SELECT id FROM relatorios WHERE status = 'CONFERINDO'").all();
  if (!presos.length) return;
  db.prepare("UPDATE relatorios SET status = 'ENVIADO' WHERE status = 'CONFERINDO'").run();
  log.aviso('processo', 'conferencias interrompidas por reinicio devolvidas para ENVIADO', {
    quantos: presos.length,
    rel: presos.map((r) => r.id).join(','),
  });
}

limparSessoesVencidas();
soltarConferenciasInterrompidas();
const senhaInicial = garantirAdmin();
agendarBackupDiario();

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
