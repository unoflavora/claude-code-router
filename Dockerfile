FROM node:22-slim

RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install all deps (including devDeps for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsup src/index.ts --format esm

# Prune devDeps after build
RUN npm prune --omit=dev

# Copy runtime files
COPY claude-settings.json ./
COPY scripts/ ./scripts/
RUN chmod +x scripts/*.sh

ENV PORT=4141
ENV HOST=0.0.0.0
ENV CLAUDE_MODE=lean

EXPOSE 4141

CMD ["node", "dist/index.js"]
