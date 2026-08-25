// Verificacao da assinatura digital dos PDFs de RDV.
//
// Os relatorios sao assinados no gov.br, que produz uma assinatura PAdES
// embutida no proprio PDF. O que da para checar sem depender de servico externo:
//
//   1. existe assinatura?
//   2. quem assinou (nome e CPF do certificado) e quando
//   3. quem emitiu o certificado - e ICP-Brasil / gov.br mesmo?
//   4. o documento foi alterado DEPOIS de assinado?
//
// O item 4 e o que realmente importa contra fraude: comparamos o resumo
// criptografico gravado na assinatura com o resumo calculado sobre o conteudo
// que a assinatura cobre. Se alguem editou o PDF depois de assinar, nao bate.
//
// O que este modulo NAO faz: validar a cadeia do certificado contra as raizes
// da ICP-Brasil nem checar revogacao (LCR/OCSP). Para isso seria preciso
// embarcar as raizes e consultar a AC. Entao "assinatura integra" aqui quer
// dizer "o arquivo nao foi mexido depois de assinado", nao "certificado valido
// perante a ICP-Brasil".

import forge from 'node-forge';

// O gov.br emite como O="Gov-Br", CN="AC Final do Governo Federal do Brasil v1".
const MARCAS_GOV =
  /gov[\s._-]?br|governo federal|ICP[\s-]?Brasil|Autoridade Certificadora|\bAC\b|SERPRO|Certisign|Valid|Soluti|Safeweb/i;

/**
 * Analisa as assinaturas de um PDF.
 * @param {Buffer} pdf
 * @returns {{assinado: boolean, assinaturas: Array, resumo: string}}
 */
export function verificarAssinatura(pdf) {
  const bruto = pdf.toString('latin1');
  const faixas = [...bruto.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];

  if (faixas.length === 0) {
    return {
      assinado: false,
      assinaturas: [],
      resumo: 'O arquivo nao tem assinatura digital.',
    };
  }

  const assinaturas = [];

  for (const f of faixas) {
    const [inicio1, tam1, inicio2, tam2] = f.slice(1, 5).map(Number);

    try {
      assinaturas.push(analisarUma(pdf, bruto, inicio1, tam1, inicio2, tam2));
    } catch (e) {
      assinaturas.push({
        ok: false,
        signatario: null,
        erro: `Nao foi possivel ler esta assinatura: ${e.message}`,
      });
    }
  }

  return { assinado: true, assinaturas, resumo: montarResumo(assinaturas) };
}

function analisarUma(pdf, bruto, inicio1, tam1, inicio2, tam2) {
  // O PDF assinado tem um buraco: [inicio1..tam1] e [inicio2..tam2] sao o
  // conteudo coberto; o que fica entre os dois e a propria assinatura, em hex.
  const hex = bruto
    .slice(inicio1 + tam1, inicio2)
    .replace(/[<>\s\0]/g, '');

  // Nao remover os zeros do fim: o gov.br emite a assinatura em BER de
  // comprimento indefinido (comeca com 3080), e ali os "00 00" finais sao os
  // marcadores de fim de conteudo, nao preenchimento. Cortar quebra o parse.
  // Por isso tambem strict:false - DER estrito nao aceita comprimento indefinido.
  const der = forge.util.hexToBytes(hex);
  const p7 = forge.pkcs7.messageFromAsn1(
    forge.asn1.fromDer(der, { strict: false, parseAllBytes: false }),
  );

  const cert = p7.certificates?.[0];
  const signatario = cert ? campoDoCert(cert.subject) : null;
  const emissor = cert ? campoDoCert(cert.issuer) : null;

  // Data de assinatura declarada nos atributos autenticados.
  let quando = null;
  const attrs = p7.rawCapture?.authenticatedAttributes || [];
  for (const a of attrs) {
    try {
      const oid = forge.asn1.derToOid(a.value[0].value);
      if (oid === forge.pki.oids.signingTime) {
        quando = forge.asn1.utcTimeToDate
          ? forge.asn1.utcTimeToDate(a.value[1].value[0].value)
          : null;
      }
    } catch {
      // atributo em formato inesperado - ignora
    }
  }

  // O ponto central: o conteudo coberto foi alterado depois de assinado?
  const coberto = Buffer.concat([
    pdf.subarray(inicio1, inicio1 + tam1),
    pdf.subarray(inicio2, inicio2 + tam2),
  ]);

  const integro = conferirResumo(p7, coberto);

  return {
    ok: integro === true,
    integridade:
      integro === true ? 'intacto' : integro === false ? 'alterado' : 'nao_verificavel',
    signatario: signatario?.nome || null,
    cpf: signatario?.cpf || null,
    emissor: emissor?.nome || null,
    gov: MARCAS_GOV.test(`${emissor?.nome || ''} ${emissor?.completo || ''}`),
    assinado_em: quando ? quando.toISOString() : null,
    erro: null,
  };
}

// Compara o messageDigest declarado com o resumo do conteudo coberto.
// Devolve true, false, ou null quando nao da para verificar.
function conferirResumo(p7, coberto) {
  try {
    const attrs = p7.rawCapture?.authenticatedAttributes;
    if (!attrs) return null;

    let declarado = null;
    for (const a of attrs) {
      const oid = forge.asn1.derToOid(a.value[0].value);
      if (oid === forge.pki.oids.messageDigest) {
        declarado = forge.util.bytesToHex(a.value[1].value[0].value);
      }
    }
    if (!declarado) return null;

    const algoritmo = forge.asn1.derToOid(p7.rawCapture.digestAlgorithm);
    const nome = { [forge.pki.oids.sha256]: 'sha256', [forge.pki.oids.sha1]: 'sha1', [forge.pki.oids.sha512]: 'sha512' }[
      algoritmo
    ];
    if (!nome) return null;

    const md = forge.md[nome].create();
    md.update(coberto.toString('binary'));
    return md.digest().toHex().toLowerCase() === declarado.toLowerCase();
  } catch {
    return null;
  }
}

// O gov.br grava o nome como "FULANO DE TAL:12345678900" no CN.
function campoDoCert(dn) {
  const cn = dn.getField('CN')?.value || '';
  const o = dn.getField('O')?.value || '';
  const ou = (dn.attributes || []).filter((a) => a.shortName === 'OU').map((a) => a.value);
  const m = cn.match(/^(.*?):(\d{11})$/);
  return {
    nome: (m ? m[1] : cn).trim(),
    cpf: m ? m[2] : null,
    completo: [cn, o, ...ou].join(' | '),
  };
}

function montarResumo(assinaturas) {
  if (!assinaturas.length) return 'O arquivo nao tem assinatura digital.';

  const partes = assinaturas.map((a, i) => {
    if (a.erro) return `Assinatura ${i + 1}: ${a.erro}`;
    const quem = a.signatario || 'signatario nao identificado';
    const cpf = a.cpf ? ` (CPF ${mascararCpf(a.cpf)})` : '';
    const quando = a.assinado_em
      ? ` em ${new Date(a.assinado_em).toLocaleString('pt-BR')}`
      : '';
    const onde = a.gov ? ' via certificado ICP-Brasil/gov.br' : ` emitido por ${a.emissor || 'emissor desconhecido'}`;

    if (a.integridade === 'alterado') {
      return `ATENCAO: o documento foi ALTERADO depois de assinado por ${quem}${cpf}.`;
    }
    if (a.integridade === 'nao_verificavel') {
      return `Assinado por ${quem}${cpf}${quando}${onde}, mas nao foi possivel confirmar a integridade.`;
    }
    return `Assinado por ${quem}${cpf}${quando}${onde}. Documento intacto desde a assinatura.`;
  });

  return partes.join(' ');
}

function mascararCpf(cpf) {
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}

/**
 * Transforma o resultado em achados da conferencia.
 * @param {object} r saida de verificarAssinatura
 * @param {string} nomeDoColaborador para conferir se quem assinou e quem deveria
 */
export function achadosDaAssinatura(r, nomeDoColaborador) {
  const achados = [];

  if (!r.assinado) {
    achados.push({
      gravidade: 'aviso',
      codigo: 'sem_assinatura',
      mensagem: 'O RDV nao esta assinado digitalmente.',
      data: null,
    });
    return achados;
  }

  for (const a of r.assinaturas) {
    if (a.erro) {
      achados.push({
        gravidade: 'aviso',
        codigo: 'assinatura_ilegivel',
        mensagem: a.erro,
        data: null,
      });
      continue;
    }

    if (a.integridade === 'alterado') {
      achados.push({
        gravidade: 'erro',
        codigo: 'assinatura_quebrada',
        mensagem: `O documento foi alterado DEPOIS de assinado por ${a.signatario || 'signatario desconhecido'}. A assinatura nao cobre o conteudo atual do arquivo.`,
        data: null,
      });
      continue;
    }

    if (a.integridade === 'nao_verificavel') {
      achados.push({
        gravidade: 'aviso',
        codigo: 'assinatura_nao_verificada',
        mensagem: `Assinatura de ${a.signatario || 'signatario desconhecido'} encontrada, mas nao foi possivel confirmar a integridade do arquivo.`,
        data: null,
      });
    }

    if (!a.gov) {
      achados.push({
        gravidade: 'aviso',
        codigo: 'assinatura_fora_icp',
        mensagem: `A assinatura nao veio de certificado ICP-Brasil/gov.br (emissor: ${a.emissor || 'desconhecido'}).`,
        data: null,
      });
    }

    // Quem assinou tem que ser o dono do relatorio.
    if (a.signatario && nomeDoColaborador && !mesmaPessoa(a.signatario, nomeDoColaborador)) {
      achados.push({
        gravidade: 'erro',
        codigo: 'assinatura_de_outra_pessoa',
        mensagem: `O RDV foi assinado por "${a.signatario}", que nao confere com o colaborador "${nomeDoColaborador}".`,
        data: null,
      });
    }
  }

  return achados;
}

function mesmaPessoa(a, b) {
  const partes = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toUpperCase()
      .replace(/[^A-Z ]/g, ' ')
      .split(/\s+/)
      .filter((p) => p.length > 2 && !['DE', 'DA', 'DO', 'DOS', 'DAS'].includes(p));

  const pa = partes(a);
  const pb = partes(b);
  if (!pa.length || !pb.length) return true; // sem base para acusar

  // Primeiro nome igual e pelo menos mais um nome em comum.
  const comuns = pa.filter((p) => pb.includes(p));
  return pa[0] === pb[0] && comuns.length >= 2;
}
