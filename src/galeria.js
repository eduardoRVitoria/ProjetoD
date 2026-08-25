// Galeria do colaborador e o pacote de download.
//
// A galeria organiza tudo que a pessoa ja enviou:
//   - odometros por mes e por dia
//   - RDVs por mes
//   - comprovantes (pedagio, DANFE, outros) por mes
//
// O pacote monta um zip com a mesma organizacao, para arquivar ou mandar para
// o financeiro.

import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { db, PASTA_ANEXOS } from './banco.js';
import { mesPorExtenso } from './util.js';

const PASTA_DO_TIPO = {
  rdv: 'RDV',
  odometro: 'Odometro',
  pedagio: 'Pedagio e estacionamento',
  danfe: 'Nota de abastecimento',
  outro: 'Outros documentos',
};

function anexosDoColaborador(usuarioId, mes = null) {
  const filtroMes = mes ? 'AND r.mes_ref = ?' : '';
  const args = mes ? [usuarioId, mes] : [usuarioId];
  return db
    .prepare(
      `SELECT a.id, a.tipo, a.nome_original, a.arquivo, a.mime, a.tamanho, a.enviado_em,
              r.mes_ref, r.status, r.id AS relatorio_id
         FROM anexos a
         JOIN relatorios r ON r.id = a.relatorio_id
        WHERE r.usuario_id = ? ${filtroMes}
        ORDER BY r.mes_ref DESC, a.tipo, a.enviado_em`,
    )
    .all(...args);
}

/** Monta a galeria agrupada para a tela. */
export function galeriaDe(usuarioId) {
  const usuario = db
    .prepare('SELECT id, nome, login, empresa, placas FROM usuarios WHERE id = ?')
    .get(usuarioId);
  if (!usuario) return null;

  const anexos = anexosDoColaborador(usuarioId);
  const porMes = new Map();

  for (const a of anexos) {
    if (!porMes.has(a.mes_ref)) {
      porMes.set(a.mes_ref, {
        mes: a.mes_ref,
        mes_extenso: mesPorExtenso(a.mes_ref),
        status: a.status,
        rdv: [],
        odometro: [],
        pedagio: [],
        danfe: [],
        outro: [],
        total: 0,
      });
    }
    const m = porMes.get(a.mes_ref);
    const item = {
      id: a.id,
      nome: a.nome_original,
      tamanho: a.tamanho,
      mime: a.mime,
      enviado_em: a.enviado_em,
      // Para odometro vale o dia da FOTO, nao o do upload: quem importou 12
      // fotos de julho num dia so nao quer ver as 12 empilhadas nesse dia.
      dia: diaDaFoto(a.nome_original, a.mes_ref) || (a.enviado_em ? a.enviado_em.slice(0, 10) : null),
      imagem: /^image\//.test(a.mime || ''),
    };
    (m[a.tipo] || m.outro).push(item);
    m.total++;
  }

  // Os odometros ficam agrupados por dia dentro do mes - e assim que voce
  // confere a foto de segunda de manha contra a de sexta a noite.
  const meses = [...porMes.values()].map((m) => {
    const porDia = new Map();
    for (const f of m.odometro) {
      const dia = f.dia || 'sem data';
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia).push(f);
    }
    return {
      ...m,
      odometro_por_dia: [...porDia.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([dia, fotos]) => ({ dia, fotos })),
    };
  });

  return {
    usuario,
    meses,
    resumo: {
      meses: meses.length,
      anexos: anexos.length,
      odometros: anexos.filter((a) => a.tipo === 'odometro').length,
      rdvs: anexos.filter((a) => a.tipo === 'rdv').length,
      comprovantes: anexos.filter((a) => ['pedagio', 'danfe'].includes(a.tipo)).length,
    },
  };
}

/**
 * Escreve na resposta um zip com tudo do colaborador, organizado em pastas:
 *   Nome/2026-07 julho/RDV/...
 *                   /Odometro/2026-07-15/...
 *                   /Pedagio e estacionamento/...
 */
export function enviarPacote(res, usuarioId, mes = null) {
  const usuario = db.prepare('SELECT nome, login FROM usuarios WHERE id = ?').get(usuarioId);
  if (!usuario) return false;

  const anexos = anexosDoColaborador(usuarioId, mes);
  const base = semAcento(usuario.nome);
  const nomeZip = mes ? `${base} - ${mes}.zip` : `${base} - tudo.zip`;

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${nomeZip}"`,
    'Cache-Control': 'no-store',
  });

  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => res.destroy());
  zip.pipe(res);

  const usados = new Set();

  for (const a of anexos) {
    const origem = path.join(PASTA_ANEXOS, a.arquivo);
    if (!fs.existsSync(origem)) continue;

    const pastaTipo = PASTA_DO_TIPO[a.tipo] || 'Outros documentos';
    // Odometro ganha subpasta por dia; o resto fica direto na pasta do tipo.
    const dia =
      a.tipo === 'odometro'
        ? diaDaFoto(a.nome_original, a.mes_ref) || (a.enviado_em ? a.enviado_em.slice(0, 10) : null)
        : null;
    const subDia = dia ? `/${dia}` : '';

    let destino = `${base}/${a.mes_ref} ${mesPorExtenso(a.mes_ref)}/${pastaTipo}${subDia}/${semAcento(a.nome_original)}`;

    // Dois arquivos com o mesmo nome no mesmo lugar: numera.
    let n = 2;
    const original = destino;
    while (usados.has(destino)) {
      const ext = path.extname(original);
      destino = `${original.slice(0, -ext.length)} (${n})${ext}`;
      n++;
    }
    usados.add(destino);

    zip.file(origem, { name: destino });
  }

  // Um resumo em texto junto, para quem abrir a pasta entender o que e.
  zip.append(montarLeiaMe(usuario, anexos, mes), { name: `${base}/LEIA-ME.txt` });

  zip.finalize();
  return true;
}

function montarLeiaMe(usuario, anexos, mes) {
  const porMes = new Map();
  for (const a of anexos) {
    porMes.set(a.mes_ref, (porMes.get(a.mes_ref) || 0) + 1);
  }

  const linhas = [
    `Documentos de ${usuario.nome} (${usuario.login})`,
    mes ? `Mes: ${mesPorExtenso(mes)}` : 'Todos os meses enviados',
    `Gerado pelo Portal RDV em ${new Date().toLocaleString('pt-BR')}`,
    '',
    `Total de arquivos: ${anexos.length}`,
    '',
    'Por mes:',
    ...[...porMes.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([m, n]) => `  ${mesPorExtenso(m)}: ${n} arquivo(s)`),
    '',
    'Organizacao das pastas:',
    '  RDV                       - o relatorio de despesas de viagem',
    '  Odometro                  - fotos do painel, em subpasta por dia de envio',
    '  Pedagio e estacionamento  - extratos de tag e cupons',
    '  Nota de abastecimento     - DANFE / cupom fiscal de combustivel',
    '  Outros documentos         - o que nao se encaixa acima',
  ];

  return linhas.join('\r\n');
}

const MESES_CURTOS = {
  jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
};

// Tenta achar a data da foto no proprio nome do arquivo. Os padroes que
// aparecem de verdade: "01JUL MANHA.jpg", "photo_2026-08-24_11-26-54.jpg",
// "2026-07-15 painel.jpg", "15-07-2026.jpg".
function diaDaFoto(nome, mesRef) {
  const n = String(nome || '').toLowerCase();

  let m = n.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = n.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  // "01JUL", "1 jul", "01-jul"
  m = n.match(/\b(\d{1,2})\s*[-_ ]?\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/);
  if (m) {
    const ano = String(mesRef || '').slice(0, 4) || String(new Date().getFullYear());
    return `${ano}-${MESES_CURTOS[m[2]]}-${m[1].padStart(2, '0')}`;
  }

  return null;
}

function semAcento(s) {
  return String(s || 'arquivo')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim();
}
