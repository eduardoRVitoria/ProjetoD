// Sinal de vida do portal.
//
// Existe por causa do dia em que o servico caiu e ninguem ficou sabendo: o
// portal passou dias fora do ar e a descoberta veio de um vendedor reclamando.
// Um monitor externo (UptimeRobot e afins) bate aqui de minuto em minuto e
// avisa quando para de responder - o portal caido nao consegue avisar nada
// sobre si mesmo, entao quem cobra tem que estar de fora.
//
// A resposta e deliberadamente magra. Esta rota nao pede senha, para o monitor
// alcancar; entao ela nao diz nome de colaborador, quantidade de relatorio nem
// nada que sirva para alguem de fora entender o negocio. Numero detalhado fica
// no painel, atras de login.

import fs from 'node:fs';
import path from 'node:path';
import { db, PASTA_DADOS } from './banco.js';

const SUBIU_EM = Date.now();

/**
 * Verifica o que faz o portal funcionar de verdade.
 *
 * Responder 200 porque o processo esta vivo nao basta: o caso que interessa e
 * o portal de pe com o disco perdido, atendendo requisicao e sem conseguir
 * gravar nada. Foi o que aconteceu quando o volume sumiu. Por isso aqui o
 * banco e lido E o disco e escrito.
 */
export function checarSaude() {
  const problemas = [];

  try {
    db.prepare('SELECT COUNT(*) AS n FROM usuarios').get();
  } catch (e) {
    problemas.push(`banco ilegivel: ${e.message}`);
  }

  // Escrita de verdade, e nao so um existsSync: disco cheio e disco somente
  // leitura respondem que a pasta esta la e falham na hora de gravar.
  const teste = path.join(PASTA_DADOS, '.saude');
  try {
    fs.writeFileSync(teste, String(Date.now()));
    fs.rmSync(teste, { force: true });
  } catch (e) {
    problemas.push(`disco nao aceita escrita: ${e.message}`);
  }

  return {
    ok: problemas.length === 0,
    ambiente: process.env.AMBIENTE || 'producao',
    no_ar_ha: Math.round((Date.now() - SUBIU_EM) / 1000),
    problemas,
  };
}
