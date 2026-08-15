FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm install --workspace apps/dashboard
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace apps/dashboard
CMD ["npm","run","start","--workspace","apps/dashboard"]
