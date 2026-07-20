FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    CRON_SECRET=alertproof-build-secret \
    ALERTPROOF_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    npm run build

CMD ["npm", "run", "docker-start"]
