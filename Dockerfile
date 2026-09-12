# selver-mcp over HTTP. Runs anywhere that takes a container: Fly, Railway,
# Render, Cloud Run, your own box.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Never run as root.
USER node
EXPOSE 8080
# SELVER_MCP_TOKEN must be supplied at runtime. Unset => the server answers
# 503 to everything rather than serving unauthenticated requests.
CMD ["node", "dist/http.js"]
