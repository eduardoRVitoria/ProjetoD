// Backup diario por e-mail.
//
// O backup manual so protege quem lembra de aperta-lo. Este roda sozinho de
// madrugada e manda o .zip para fora do servidor - que e o ponto: guardar copia
// no mesmo disco nao protege de perder o disco, foi exatamente o que aconteceu
// quando a Railway apagou o volume.
//
// Precisa de tres variaveis de ambiente. Sem elas, o portal sobe normalmente e
// so avisa no log que o backup automatico esta desligado:
//
//   BACKUP_EMAIL_PARA     para quem mandar
//   BACKUP_EMAIL_USUARIO  a conta Gmail que envia
//   BACKUP_EMAIL_SENHA    a "senha de app" do Google, nao a senha da conta
//
// Opcional: BACKUP_HORA (0-23, hora de Brasilia). Padrao 3.

import nodemailer from 'nodemailer';
import { gerarBackupEmMemoria, resumoDosDados } from './backup.js';
import { gravarConfig, agora } from './banco.js';
import * as log from './log.js';

// O Gmail recusa mensagem acima de 25 MB. O corte e antes disso para deixar
// folga: o anexo cresce ~35% ao ser codificado em base64 para o e-mail.
const LIMITE_ANEXO = 18 * 1024 * 1024;

const config = () => ({
  para: process.env.BACKUP_EMAIL_PARA,
  usuario: process.env.BACKUP_EMAIL_USUARIO,
  senha: process.env.BACKUP_EMAIL_SENHA,
  hora: Number(process.env.BACKUP_HORA ?? 3),
});

export const backupAutomaticoLigado = () => {
  const c = config();
  return Boolean(c.para && c.usuario && c.senha);
};

/**
 * Quantos milissegundos faltam para a proxima vez que der `hora` em Brasilia.
 *
 * O container roda em UTC, e o horario de Brasilia e o que a pessoa entende
 * quando escolhe "3 da manha". A conta e feita comparando o relogio local de
 * Sao Paulo com o do processo, para funcionar sem depender do fuso da maquina.
 */
export function faltaPara(hora, agoraMs = Date.now()) {
  const emSP = (d) => new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const agoraSP = emSP(new Date(agoraMs));

  const alvoSP = new Date(agoraSP);
  alvoSP.setHours(hora, 0, 0, 0);
  if (alvoSP <= agoraSP) alvoSP.setDate(alvoSP.getDate() + 1);

  return alvoSP.getTime() - agoraSP.getTime();
}

/** Monta o backup e manda. Devolve o tamanho enviado. */
export async function enviarBackupPorEmail() {
  const c = config();
  const zip = await gerarBackupEmMemoria();
  const d = resumoDosDados();
  const dia = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  if (zip.length > LIMITE_ANEXO) {
    // Falhar avisando e melhor que mandar um e-mail que o Gmail vai rejeitar
    // calado. Quando chegar aqui, e hora de trocar o destino por um
    // armazenamento em nuvem.
    throw new Error(
      `O backup esta com ${(zip.length / 1048576).toFixed(1)} MB e nao cabe mais num e-mail. `
        + 'Baixe pelo painel e configure um destino em nuvem.',
    );
  }

  const correio = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: c.usuario, pass: c.senha },
  });

  await correio.sendMail({
    from: `Portal RDV <${c.usuario}>`,
    to: c.para,
    subject: `Backup do Portal RDV — ${dia}`,
    text: [
      `Backup automatico do Portal RDV de ${dia}.`,
      '',
      `Colaboradores: ${d.usuarios}`,
      `Relatorios:    ${d.relatorios}`,
      `Anexos:        ${d.anexos} (${(d.tamanho_anexos / 1048576).toFixed(1)} MB)`,
      '',
      'Para restaurar: entre no portal como administrador, va em Configuracoes,',
      'cartao "Backup dos dados", e envie este arquivo em "Restaurar".',
      '',
      'Guarde este e-mail. Ele e a copia que traz tudo de volta se o servidor',
      'for perdido.',
    ].join('\n'),
    attachments: [{
      filename: `portal-rdv-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      content: zip,
    }],
  });

  gravarConfig('ultimo_backup_em', agora());
  gravarConfig('ultimo_backup_automatico_em', agora());
  return zip.length;
}

/**
 * Liga o relogio do backup.
 *
 * Reagenda a cada volta em vez de usar um intervalo fixo de 24h: assim o
 * horario nao escorrega com o tempo, e a virada do horario de verao nao
 * empurra o backup para uma hora que ninguem escolheu.
 */
export function agendarBackupDiario() {
  const c = config();

  // Staging herda as variaveis de producao ao ser duplicado, e passaria a
  // mandar um segundo e-mail por dia - com dados de teste, no mesmo assunto do
  // de verdade. Backup de ambiente descartavel nao serve para nada.
  if (process.env.AMBIENTE && process.env.AMBIENTE !== 'producao') {
    log.info('backup', 'backup automatico nao roda fora de producao', {
      ambiente: process.env.AMBIENTE,
    });
    return;
  }

  if (!backupAutomaticoLigado()) {
    log.aviso('backup', 'backup automatico DESLIGADO - faltam as variaveis de ambiente', {
      falta: ['BACKUP_EMAIL_PARA', 'BACKUP_EMAIL_USUARIO', 'BACKUP_EMAIL_SENHA']
        .filter((n) => !process.env[n]).join(','),
    });
    return;
  }

  const hora = Number.isInteger(c.hora) && c.hora >= 0 && c.hora <= 23 ? c.hora : 3;

  const marcar = () => {
    const espera = faltaPara(hora);
    log.info('backup', 'backup automatico agendado', {
      para: c.para,
      hora: `${String(hora).padStart(2, '0')}:00 (Brasilia)`,
      faltam: `${(espera / 3600000).toFixed(1)}h`,
    });

    const t = setTimeout(async () => {
      try {
        const tamanho = await enviarBackupPorEmail();
        log.info('backup', 'backup enviado por e-mail', {
          para: c.para,
          tamanho: `${(tamanho / 1048576).toFixed(1)}MB`,
        });
      } catch (e) {
        // Nunca derruba o portal nem para de tentar: amanha tem outra chance,
        // e um e-mail que nao saiu nao pode custar o sistema no ar.
        log.falha('backup', 'falha ao enviar o backup por e-mail', e, { para: c.para });
      }
      marcar();
    }, espera);

    // Um backup pendente nao pode segurar o processo na hora de desligar.
    t.unref();
  };

  marcar();
}
