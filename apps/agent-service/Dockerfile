FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/llm/package.json packages/llm/package.json
COPY apps/agent-service/package.json apps/agent-service/package.json
RUN npm install --workspace apps/agent-service --workspace packages/llm
COPY packages/llm packages/llm
COPY apps/agent-service apps/agent-service
CMD ["npm", "run", "start", "--workspace", "apps/agent-service"]
