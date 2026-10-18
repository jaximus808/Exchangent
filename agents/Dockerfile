# Agent runner sandbox (doc/hardening-contract.md, "Agent sandbox"): the runner and the `claude` CLI run in a
# container that sees none of the host's files. Only agents/.state (identities, Inkbox keys) and the principals
# file (read-only) are mounted, and Claude is logged in with CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`),
# not the host's ~/.claude. Inside, every turn is still locked down by the flags in src/brains/claude.ts.
#   npm run start:sandboxed
FROM node:24-slim

# The Claude Code CLI the brain runs for each turn (one `claude -p` per turn).
RUN npm install -g @anthropic-ai/claude-code@latest && npm cache clean --force

# Unprivileged user; the runner never runs as root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin agent
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    STATE_DIR=/state \
    PRINCIPALS_FILE=/run/exchangent/principals.json \
    HOME=/home/agent
USER agent
ENTRYPOINT ["node", "src/main.ts"]
