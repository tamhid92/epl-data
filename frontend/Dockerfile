# # Build stage
# FROM node:18-alpine AS build
# WORKDIR /app
# COPY package.json package-lock.json* ./
# ARG VITE_BASE_URL
# ARG VITE_API_TOKEN
# ENV VITE_BASE_URL=$VITE_BASE_URL
# ENV VITE_API_TOKEN=$VITE_API_TOKEN
# RUN npm ci
# COPY . .
# RUN npm run build

# # Runtime
# FROM nginx:alpine
# LABEL version="1.0" \
#       maintainer="Tamhid Chowdhury <tamhidchowdhury@gmail.com>" \
#       description="Web Application for English Premier League Data Analytics"
# LABEL org.opencontainers.image.source https://github.com/tamhid92/epl-data
# COPY --from=build /app/dist /usr/share/nginx/html
# COPY nginx.conf /etc/nginx/conf.d/default.conf
# EXPOSE 8080
# CMD ["nginx", "-g", "daemon off;"]


# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

# ---------- Build stage ----------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS build
WORKDIR /app

# Leverage cache for deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Build-time env for Vite (these are baked into the bundle)
ARG VITE_BASE_URL
ARG VITE_API_TOKEN
ENV VITE_BASE_URL=$VITE_BASE_URL
ENV VITE_API_TOKEN=$VITE_API_TOKEN

COPY . .
RUN npm run build

# ---------- Runtime stage ----------
FROM --platform=$TARGETPLATFORM ${NGINX_IMAGE}
LABEL version="1.0" \
      maintainer="Tamhid Chowdhury <tamhidchowdhury@gmail.com>" \
      description="Web Application for English Premier League Data Analytics" \
      org.opencontainers.image.source="https://github.com/tamhid92/epl-data"

# If your nginx.conf listens on 80 (default), expose 80. If you keep 8080, change listen in nginx.conf too.
EXPOSE 8080

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

CMD ["nginx", "-g", "daemon off;"]
