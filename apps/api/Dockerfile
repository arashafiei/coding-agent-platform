FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm install --workspace apps/api
COPY apps/api apps/api
CMD ["npm", "run", "start", "--workspace", "apps/api"]
