// Caderno de impressao do mes.
//
// Junta os comprovantes num PDF unico, pronto para mandar para a impressora ou
// arquivar. Existe porque "Baixar pasta" entrega um zip com dezenas de arquivos
// soltos, em formatos diferentes, e imprimir aquilo e abrir um por um na mao.
//
// Entram RDV, nota de abastecimento e comprovante de pedagio/estacionamento -
// o que a conferencia precisa ter no papel. Foto de odometro e "outros
// documentos" ficam de fora: sao apoio da conferencia na tela, nao documento de
// prestacao de contas.
//
// Cada anexo vira pagina conforme o que ele e:
//   PDF      -> as paginas dele entram inteiras
//   imagem   -> uma pagina com a foto ajustada na folha
//   planilha -> o texto da planilha, que o extrair.js ja sabe ler, em paginas
//   texto    -> as linhas do arquivo em paginas
//
// Nada e descartado em silencio: arquivo que nao abre vira uma pagina dizendo
// qual e e o que aconteceu, para ninguem achar que o comprovante nao existia.

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db, PASTA_ANEXOS } from './banco.js';
import { planilhaEmTexto } from './extrair.js';
import { mesPorExtenso } from './util.js';

// O que vai para o papel, na ordem em que sai impresso.
const TIPOS_IMPRESSOS = ['rdv', 'pedagio', 'danfe'];

const ROTULO_TIPO = {
  rdv: 'RDV',
  pedagio: 'Pedagio e estacionamento',
  danfe: 'Nota de abastecimento',
};

const A4 = { largura: 595.28, altura: 841.89 };
const MARGEM = 40;

const IMAGENS_JPG = new Set(['.jpg', '.jpeg', '.jfif']);
const PLANILHAS = new Set(['.xlsx', '.xlsm', '.xls']);
const TEXTOS = new Set(['.csv', '.txt']);

/**
 * Os anexos que entram na impressao, na ordem de leitura.
 *
 * O `escopo` e o mesmo recorte do painel: null para quem ve tudo, ou a empresa
 * do administrativo. Sem ele, o caderno do mes inteiro entregaria os
 * comprovantes da DSO para um Adm DISO - a impressao nao pode ser a porta dos
 * fundos do controle de acesso.
 */
function anexosParaImprimir(mes, usuarioId = null, escopo = null) {
  const condicoes = ["r.mes_ref = ?", "a.tipo IN ('rdv', 'pedagio', 'danfe')"];
  const args = [mes];
  if (usuarioId) {
    condicoes.push('r.usuario_id = ?');
    args.push(usuarioId);
  }
  if (escopo?.empresa) {
    condicoes.push('u.empresa = ?');
    args.push(escopo.empresa);
  }
  return db
    .prepare(
      `SELECT a.id, a.tipo, a.nome_original, a.arquivo, a.mime, a.enviado_em,
              u.id AS usuario_id, u.nome AS pessoa, u.empresa, u.funcao
         FROM anexos a
         JOIN relatorios r ON r.id = a.relatorio_id
         JOIN usuarios u ON u.id = r.usuario_id
        WHERE ${condicoes.join(' AND ')}
        ORDER BY u.nome, a.id`,
    )
    .all(...args);
}

/** Quebra o texto para caber na largura da folha, sem cortar palavra no meio. */
function quebrarLinhas(texto, fonte, tamanho, larguraMax) {
  const saida = [];
  for (const linha of String(texto).split(/\r?\n/)) {
    if (!linha.trim()) {
      saida.push('');
      continue;
    }
    let atual = '';
    for (const palavra of linha.split(/\s+/)) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (fonte.widthOfTextAtSize(tentativa, tamanho) <= larguraMax) {
        atual = tentativa;
      } else {
        if (atual) saida.push(atual);
        // Palavra sozinha maior que a folha (URL, codigo de barras): corta no
        // limite, porque senao ela transborda para fora do papel.
        if (fonte.widthOfTextAtSize(palavra, tamanho) > larguraMax) {
          let pedaco = '';
          for (const c of palavra) {
            if (fonte.widthOfTextAtSize(pedaco + c, tamanho) > larguraMax) {
              saida.push(pedaco);
              pedaco = c;
            } else {
              pedaco += c;
            }
          }
          atual = pedaco;
        } else {
          atual = palavra;
        }
      }
    }
    if (atual) saida.push(atual);
  }
  return saida;
}

/** Escreve um texto em quantas paginas forem precisas. */
function paginasDeTexto(pdf, fonte, fonteTitulo, titulo, texto) {
  const TAM = 9;
  const ALTURA_LINHA = TAM * 1.35;
  const linhas = quebrarLinhas(texto, fonte, TAM, A4.largura - MARGEM * 2);

  let pagina = null;
  let y = 0;
  const novaPagina = (comTitulo) => {
    pagina = pdf.addPage([A4.largura, A4.altura]);
    y = A4.altura - MARGEM;
    if (comTitulo) {
      pagina.drawText(titulo, { x: MARGEM, y: y - 12, size: 11, font: fonteTitulo, color: rgb(0.1, 0.1, 0.1) });
      y -= 34;
    }
  };
  novaPagina(true);

  for (const linha of linhas) {
    if (y < MARGEM + ALTURA_LINHA) novaPagina(false);
    if (linha) {
      pagina.drawText(linha, { x: MARGEM, y, size: TAM, font: fonte, color: rgb(0, 0, 0) });
    }
    y -= ALTURA_LINHA;
  }
}

/** Uma folha com a imagem ajustada, sem distorcer as proporcoes. */
async function paginaDeImagem(pdf, fonteTitulo, titulo, bytes, ext) {
  const img = IMAGENS_JPG.has(ext) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
  const pagina = pdf.addPage([A4.largura, A4.altura]);

  pagina.drawText(titulo, {
    x: MARGEM, y: A4.altura - MARGEM, size: 11, font: fonteTitulo, color: rgb(0.1, 0.1, 0.1),
  });

  const dispLargura = A4.largura - MARGEM * 2;
  const dispAltura = A4.altura - MARGEM * 2 - 30;
  const escala = Math.min(dispLargura / img.width, dispAltura / img.height, 1);
  const l = img.width * escala;
  const a = img.height * escala;
  pagina.drawImage(img, {
    x: (A4.largura - l) / 2,
    y: (A4.altura - MARGEM - 30 - a),
    width: l,
    height: a,
  });
}

/** Separador com o nome de quem sao os proximos documentos. */
function folhaDoColaborador(pdf, fonteTitulo, fonte, pessoa, info, quantos) {
  const pagina = pdf.addPage([A4.largura, A4.altura]);
  const meio = A4.altura / 2;
  pagina.drawText(pessoa, { x: MARGEM, y: meio + 20, size: 22, font: fonteTitulo, color: rgb(0, 0, 0) });
  pagina.drawText(info, { x: MARGEM, y: meio - 8, size: 12, font: fonte, color: rgb(0.35, 0.35, 0.35) });
  pagina.drawText(`${quantos} documento(s)`, {
    x: MARGEM, y: meio - 28, size: 11, font: fonte, color: rgb(0.35, 0.35, 0.35),
  });
  pagina.drawLine({
    start: { x: MARGEM, y: meio + 8 }, end: { x: A4.largura - MARGEM, y: meio + 8 },
    thickness: 1, color: rgb(0.8, 0.8, 0.8),
  });
}

/**
 * Monta o caderno. Devolve { bytes, nome, total } ou null se nao houver nada
 * para imprimir naquele recorte.
 */
export async function montarImpressao(mes, usuarioId = null, escopo = null) {
  const anexos = anexosParaImprimir(mes, usuarioId, escopo);
  if (!anexos.length) return null;

  const pdf = await PDFDocument.create();
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const fonteTitulo = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Agrupa por pessoa mantendo a ordem alfabetica que a consulta ja trouxe.
  const porPessoa = new Map();
  for (const a of anexos) {
    if (!porPessoa.has(a.usuario_id)) porPessoa.set(a.usuario_id, []);
    porPessoa.get(a.usuario_id).push(a);
  }

  for (const [, lista] of porPessoa) {
    const primeiro = lista[0];
    // Com um colaborador so, a folha separadora seria a capa de si mesma.
    if (porPessoa.size > 1) {
      folhaDoColaborador(
        pdf, fonteTitulo, fonte, primeiro.pessoa,
        `${primeiro.empresa} · ${primeiro.funcao} · ${mesPorExtenso(mes)}`,
        lista.length,
      );
    }

    // Dentro da pessoa, sai na ordem RDV -> pedagio -> DANFE.
    lista.sort((x, y) => TIPOS_IMPRESSOS.indexOf(x.tipo) - TIPOS_IMPRESSOS.indexOf(y.tipo));

    for (const a of lista) {
      const titulo = `${primeiro.pessoa} · ${ROTULO_TIPO[a.tipo]} · ${a.nome_original}`;
      const caminho = path.join(PASTA_ANEXOS, a.arquivo);
      const ext = path.extname(a.nome_original || '').toLowerCase();

      try {
        const bytes = fs.readFileSync(caminho);

        if (ext === '.pdf' || a.mime === 'application/pdf') {
          const origem = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const paginas = await pdf.copyPages(origem, origem.getPageIndices());
          for (const p of paginas) pdf.addPage(p);
        } else if (IMAGENS_JPG.has(ext) || ext === '.png') {
          await paginaDeImagem(pdf, fonteTitulo, titulo, bytes, ext);
        } else if (PLANILHAS.has(ext)) {
          paginasDeTexto(pdf, fonte, fonteTitulo, titulo, await planilhaEmTexto(caminho, ext));
        } else if (TEXTOS.has(ext)) {
          paginasDeTexto(pdf, fonte, fonteTitulo, titulo, bytes.toString('utf8'));
        } else {
          paginasDeTexto(
            pdf, fonte, fonteTitulo, titulo,
            `Este anexo nao pode ser impresso automaticamente (formato ${ext || a.mime}).\n`
              + 'Ele esta no "Baixar pasta" do colaborador.',
          );
        }
      } catch (e) {
        // Falhar aqui nao pode derrubar o caderno inteiro: o comprovante entra
        // como aviso e a conferencia segue com o resto impresso.
        //
        // O caso comum e a planilha protegida por senha - varios RDVs saem
        // assim do sistema da empresa, e nem o SheetJS nem a IA conseguem ler.
        // O recado precisa dizer o que fazer, nao so que deu erro.
        const protegido = /password|encrypt/i.test(e.message);
        paginasDeTexto(
          pdf, fonte, fonteTitulo, titulo,
          protegido
            ? 'Este arquivo esta PROTEGIDO POR SENHA e nao pode ser impresso automaticamente.\n\n'
              + 'Peca para a pessoa reenviar o RDV em PDF, ou abra o arquivo original pelo\n'
              + '"Baixar pasta" do colaborador e imprima por fora.\n\n'
              + `Detalhe tecnico: ${e.message}`
            : `Nao foi possivel abrir este anexo para impressao.\nMotivo: ${e.message}`,
        );
      }
    }
  }

  const quem = usuarioId ? anexos[0].pessoa.replace(/[^\w]+/g, '-').toLowerCase() : 'todos';
  return {
    bytes: await pdf.save(),
    nome: `comprovantes-${mes}-${quem}.pdf`,
    total: anexos.length,
  };
}
