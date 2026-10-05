// RDV lido com duvida: foto do odometro que nao bate com o RDV vira aviso,
// porque o erro pode ser da leitura do papel e nao da foto (Mauricio, 05/10).
import assert from 'node:assert/strict';
import { conferir } from '../src/conferencia.js';

const linhas = [
  { data: '2026-09-01', km_inicial: 5000, km_final: 5100, itinerario: 'A - B' },
  { data: '2026-09-02', km_inicial: 5100, km_final: 5200, itinerario: 'B - C' },
];
// Fotos com o painel de verdade, bem abaixo do que a leitura do papel achou.
const anexos = [
  { tipo: 'rdv' },
  { tipo: 'odometro', km: 1000, data_leitura: '2026-09-01' },
];
const relatorio = (confianca) => ({
  mes_ref: '2026-09',
  extraido: JSON.stringify({ confianca, lido_por: 'ocr', totais_declarados: {} }),
});
const gravidade = (confianca, codigo) =>
  conferir(relatorio(confianca), linhas, anexos, 0.9, null, 'DISO', 'Vendedor')
    .achados.filter((a) => a.codigo === codigo).map((a) => a.gravidade);

for (const codigo of ['odometro_fora_do_rdv', 'foto_nao_bate_com_o_dia']) {
  assert.deepEqual(gravidade('baixa', codigo), ['aviso'], `${codigo} com leitura duvidosa`);
  assert.deepEqual(gravidade('alta', codigo), ['erro'], `${codigo} com leitura boa`);
}
console.log('odometro-leitura-duvidosa OK');
