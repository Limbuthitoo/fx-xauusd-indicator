FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages packages
RUN npm ci
COPY apps/api apps/api
COPY db db
RUN npm run build:api
WORKDIR /app/apps/api
EXPOSE 7070
CMD ["npm", "run", "start"]
