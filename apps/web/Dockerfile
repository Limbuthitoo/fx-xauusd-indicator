FROM node:24-alpine
WORKDIR /app
ARG VITE_API_BASE_URL=http://localhost:7070
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages packages
RUN npm ci
COPY apps/web apps/web
RUN npm run build -w @orb-guide/web
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npm", "run", "preview"]
