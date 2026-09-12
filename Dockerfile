# multiplay-saas — 범용 멀티플레이 서버 런타임
# 빌드: docker build -t multiplay-saas:latest .
# 실행: docker run -e PORT=8791 -p 8791:8791 multiplay-saas:latest

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8791
# /health 엔드포인트: { ok, rooms, connections, games }
CMD ["node", "dist/index.js"]
