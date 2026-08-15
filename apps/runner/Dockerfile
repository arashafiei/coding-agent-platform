FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/runner/package.json apps/runner/package.json
RUN npm install --workspace apps/runner
COPY apps/runner apps/runner
CMD ["npm","run","start","--workspace","apps/runner"]
