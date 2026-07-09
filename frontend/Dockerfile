# Build stage
FROM node:20-alpine AS builder

WORKDIR /app/frontend

# Copy package files first for better caching
COPY frontend/package*.json ./

# Install dependencies
RUN npm ci && npm cache clean --force

# Copy source code and config files
COPY frontend/ ./
COPY VERSION ../VERSION

# Build arguments
ARG VITE_APP_VERSION
ARG VITE_APP_BUILD_LABEL
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_BUILD_LABEL=$VITE_APP_BUILD_LABEL

# Deploy commit SHA — baked into the bundle AND written to dist/version.json so
# a running tab can detect a newer frontend deploy (see vite.config.ts). No
# `.git` is copied into this stage, so the build reads the SHA from this env.
# Zeabur injects ZEABUR_GIT_COMMIT_SHA for git-source builds; if absent the
# build falls back to a unique build-<timestamp>, which still changes per deploy.
ARG ZEABUR_GIT_COMMIT_SHA
ARG VITE_BUILD_HASH
ENV ZEABUR_GIT_COMMIT_SHA=$ZEABUR_GIT_COMMIT_SHA
ENV VITE_BUILD_HASH=$VITE_BUILD_HASH

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy nginx config template (will be processed at runtime)
COPY frontend/nginx.conf.template /etc/nginx/nginx.conf.template

# Copy entrypoint script
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Copy built application from builder
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

# Use custom entrypoint to process nginx config template
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
