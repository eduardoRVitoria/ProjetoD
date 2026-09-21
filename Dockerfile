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

# O semear.js roda antes e so age se o disco estiver vazio (primeira subida num
# volume novo). Com o banco ja no lugar, ele nao faz nada.
CMD ["sh", "-c", "node src/semear.js && node servidor.js"]
