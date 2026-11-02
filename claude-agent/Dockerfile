# Generischer Claude-Agent: claude-api-server + Claude Code CLI.
# Die Persönlichkeit kommt aus dem gemounteten Ordner /agent (agents/<name>/).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl iputils-ping \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code

WORKDIR /opt/claude-api-server
COPY claude-api-server/package.json ./
RUN npm install --omit=dev
COPY claude-api-server/ ./

# Claude Code verweigert --dangerously-skip-permissions als root
USER node
ENV HOME=/home/node \
    CLAUDE_WORKDIR=/agent \
    PORT=3333
WORKDIR /agent

EXPOSE 3333
CMD ["node", "/opt/claude-api-server/server.js"]
