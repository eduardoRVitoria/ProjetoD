# Portal RDV — DISO Comércio de Alimentos

Sistema para os vendedores e supervisores enviarem o Relatório de Despesas de
Viagem pelo celular, e para a conferência acontecer de uma vez só, com IA lendo
os comprovantes.

---

## Como ligar

Dois cliques em **`iniciar.cmd`**. Uma janela preta abre e mostra os endereços.
Deixe a janela aberta — fechar ela desliga o portal.

| Onde | Endereço |
|---|---|
| Neste PC | http://localhost:3000 |
| Celular na mesma rede | o `http://192.168.x.x:3000` que aparece na janela |

Primeiro acesso: usuário **`admin`**, senha **`rdv2026`**. Troque no primeiro login.

---

## Como funciona

### Para o vendedor / supervisor

1. Entra com o login dele.
2. Escolhe o mês e preenche o dia a dia: km inicial, km final, itinerário,
   pedágio e estacionamento. **O total e o valor são calculados sozinhos** —
   ninguém soma nada, e por isso não existe mais erro de conta.
3. Anexa os comprovantes: nota de abastecimento, extrato da tag de pedágio e as
   fotos do odômetro (tira direto pela câmera do celular).
4. A aba **Conferência** mostra as pendências enquanto ele preenche. O que está
   em vermelho **trava o envio** — ele corrige antes, não depois.
5. Envia. Depois de enviado, o relatório fica travado até sair o resultado.
6. Se reprovar, ele vê exatamente **o que precisa fazer** e reenvia corrigido.

### Para você (administrador)

1. Aba **Painel do mês**: quem enviou, quem não enviou, e os números lado a lado.
2. Botão **Conferir os pendentes com IA**: roda todo mundo de uma vez.
3. Abre cada relatório e vê o parecer, os comprovantes e o dia a dia.
4. Pode confirmar o que a IA decidiu ou mudar na mão (Aprovar / Só falta DANFE /
   Reprovar), escrevendo o recado que a pessoa vai ler.
5. **Baixar planilha** exporta o mês em CSV, que o Excel abre direto.

---

## O que é conferido

**Por regra, de graça e na hora** — roda sem IA e sem custo nenhum:

| # | Verificação |
|---|---|
| 1 | Lançamento em sábado ou domingo |
| 2 | Feriado nacional e o estadual de SP (09/07) calculados automaticamente |
| 3 | Km final menor que o inicial |
| 4 | Km lançado sem itinerário |
| 5 | Itinerário preenchido com 0 km |
| 6 | Odômetro andando para trás (2º veículo) ou com km faltando entre dois dias |
| 7 | Soma dos km × valor do km |
| 8 | Pedágio declarado sem nenhum comprovante anexado |
| 9 | Ausência da nota de abastecimento |
| 10 | Quantidade de fotos de odômetro por semana trabalhada |

**Pela IA** — precisa da chave de API, e é o que exige abrir documento:

| # | Verificação |
|---|---|
| 11 | Soma o extrato da tag e compara com o declarado |
| 12 | Descarta o que não é despesa de viagem: mensalidade do plano, IOF, "dias de uso da tag", recarga, negociação de dívida, taxa de envio |
| 13 | Abre a nota de abastecimento e confirma se é mesmo nota de combustível — nome de arquivo não vale como prova |
| 14 | Lê o número do painel nas fotos de odômetro e compara com o km do relatório |
| 15 | Avalia se a distância faz sentido para o itinerário descrito |

**Sem a chave configurada o sistema continua funcionando** — só faz de 1 a 10, e
avisa no painel que os comprovantes não foram lidos.

### Os três status

| Status | Cor | Significa |
|---|---|---|
| **Aprovado** | verde | Nada a fazer. |
| **Só falta a nota de abastecimento** | amarelo | Reprovou *unicamente* por causa da DANFE. |
| **Reprovado** | vermelho | Tem divergência de km, pedágio, itinerário ou documento. |

Quem tem falta de DANFE **junto com outro erro** continua Reprovado — o amarelo é
só para o caso isolado.

---

## Cadastrar os colaboradores

Um por um pela aba **Colaboradores**, ou todos de uma vez a partir das pastas da
conferência de julho:

```
node src\criar-usuarios.js            (mostra a prévia, não grava nada)
node src\criar-usuarios.js --gravar   (cadastra de verdade)
```

Ele lê os nomes das pastas `CERTAS`, `FALTA DANFE` e `ERRADAS`, monta o login
(`anderson.calumby`) e sorteia uma senha provisória legível ao telefone. A lista
sai na tela e em `dados\senhas-iniciais.csv`. Cada pessoa troca a senha no
primeiro acesso.

---

## Instalar no celular

Abra o endereço no navegador do celular e escolha:

- **Android (Chrome)** — menu ⋮ → *Instalar aplicativo*
- **iPhone (Safari)** — botão compartilhar → *Adicionar à Tela de Início*

Vira um ícone igual a qualquer app, abre em tela cheia, sem barra de navegador.

---

## Configurar a IA

Aba **Configurações** → cole a chave da API da Anthropic (começa com `sk-ant-`).
Ela fica guardada no banco local e nunca é devolvida inteira para a tela.

Alternativa sem passar pela tela: defina a variável de ambiente
`ANTHROPIC_API_KEY` antes de ligar o servidor — ela tem prioridade.

O modelo usado é o `claude-opus-5`. Cada relatório conferido consome créditos
proporcionais ao tamanho dos comprovantes anexados.

---

## Para os vendedores acessarem de fora da empresa

Hoje o portal só responde na rede local. Para funcionar na rua, com o vendedor
em campo, há três caminhos:

1. **Túnel** (Cloudflare Tunnel, ngrok) — o PC continua sendo o servidor e ganha
   um endereço público. Rápido de montar, mas exige o PC ligado.
2. **Liberar a porta no firewall e publicar pelo IP da empresa** — precisa do TI.
3. **Subir numa hospedagem** (Railway, Render, uma VM) — o portal fica no ar
   sozinho, sem depender do PC.

O código já está preparado: ele lê a porta da variável `PORT` e marca o cookie de
sessão como `Secure` quando está atrás de um proxy HTTPS.

---

## Estrutura

```
rdv-app/
  iniciar.cmd            liga o servidor
  servidor.js            HTTP, arquivos estáticos e sessão nas páginas
  src/
    banco.js             SQLite embutido do Node + configuração
    auth.js              senha (scrypt), sessão e cookie
    rotas.js             todas as rotas /api
    conferencia.js       as 10 regras automáticas
    ia.js                leitura dos comprovantes pelo Claude
    feriados.js          feriados nacionais e de SP, calculados
    criar-usuarios.js    cadastro em lote
  publico/               a interface (login, colaborador, admin, PWA)
  dados/                 banco, anexos e logs  — NÃO versionar, NÃO apagar
```

**A pasta `dados/` é o sistema inteiro**: banco, comprovantes e senhas. Fazer
cópia dela é o backup.

---

## Detalhes técnicos

- Node 24 portátil, em `%USERPROFILE%\Tools\`. Não precisa de administrador.
- Banco: `node:sqlite`, embutido no Node — nada para instalar.
- Uma única dependência: `@anthropic-ai/sdk`. Sem framework, sem build.
- Senhas com `scrypt` e salt por usuário; comparação em tempo constante.
- Sessão de 30 dias em cookie `HttpOnly` + `SameSite=Lax`.
- Anexo nunca é servido do disco por caminho vindo do navegador — sempre pelo id
  no banco, e só para o dono do relatório ou o administrador.
