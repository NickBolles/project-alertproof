FROM node:20-alpine AS build

RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    CRON_SECRET=alertproof-build-secret \
    ALERTPROOF_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    npm run build

FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/build ./build

EXPOSE 3000
CMD ["npm", "run", "docker-start"]
