FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
# The data volume must belong to the unprivileged user the server runs as.
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server.js"]
