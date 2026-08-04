FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages packages
RUN pip install --no-cache-dir "psycopg[binary]==3.2.13"
RUN npm ci
COPY apps/api apps/api
COPY apps/quant apps/quant
COPY db db
COPY scripts scripts
RUN npm run build:api
WORKDIR /app/apps/api
EXPOSE 7070
CMD ["npm", "run", "start"]
