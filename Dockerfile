# Portal RDV — imagem de producao.
# Node 24 porque o banco usa o SQLite embutido (node:sqlite), que exige 22.5+.

FROM node:24-slim

WORKDIR /app

# As dependencias primeiro, para o cache da camada aproveitar entre deploys.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# O disco persistente e montado aqui. Sem ele os dados somem a cada deploy.
ENV DADOS_DIR=/dados
ENV NODE_ENV=production
ENV PORT=3000

RUN mkdir -p /dados/anexos

EXPOSE 3000

CMD ["node", "servidor.js"]
