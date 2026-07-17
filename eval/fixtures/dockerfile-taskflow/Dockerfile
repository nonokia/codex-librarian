# API image: deps → build → runtime (multi-stage).

ARG NODE_VERSION=22
ARG APP_ENV=production

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM deps AS build
WORKDIR /app
COPY src/ ./src
RUN --mount=type=cache,from=deps,target=/app/node_modules npm run build

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=${APP_ENV}
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
