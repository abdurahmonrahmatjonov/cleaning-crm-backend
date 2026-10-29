FROM node:22-slim
ARG TARGETARCH
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${TARGETARCH}.tar.gz /tmp/ls.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/ls.tar.gz && rm /tmp/ls.tar.gz
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DB_PATH=/data/crm.db
RUN mkdir -p /data
EXPOSE 3000
CMD ["./start.sh"]
