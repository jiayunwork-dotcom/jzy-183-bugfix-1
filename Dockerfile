# syntax=docker/dockerfile:1

# ---- 单一依赖安装层（workspace 需要全部 package.json 在场） ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm install

# ---- 构建层 ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- 运行镜像 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# 只装生产依赖（web 包在运行时不需要，但 workspace 软链需要其 package.json 在场）
COPY packages/web/package.json packages/web/
RUN npm install --omit=dev --workspaces --include-workspace-root && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/server/public
EXPOSE 3000
CMD ["node", "packages/server/dist/server.js"]
