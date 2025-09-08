# Build stage
LABEL version="1.0" \
        maintainer="Tamhid Chowdhury <tamhidchowdhury@gmail.com>" \
        description="Web Application for English Premier League Data Analytics"

FROM node:18-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
ARG VITE_BASE_URL
ARG VITE_API_TOKEN
ENV VITE_BASE_URL=$VITE_BASE_URL
ENV VITE_API_TOKEN=$VITE_API_TOKEN
RUN npm ci
COPY . .
RUN npm run build

# Runtime
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# vhost listens on 8080
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
