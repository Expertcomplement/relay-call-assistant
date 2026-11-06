FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY public ./public
EXPOSE 3030
CMD ["node", "server.mjs"]
