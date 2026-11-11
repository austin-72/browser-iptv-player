# Superstation IPTV — Node.js + ffmpeg, nothing else.
FROM node:22-alpine

# (What a registry shows beside the image.)
LABEL org.opencontainers.image.title="Superstation IPTV" \
      org.opencontainers.image.description="Self-hosted IPTV player, TV guide and DVR for your household, in any browser. M3U and Xtream Codes lists, profiles, no app to install." \
      org.opencontainers.image.source="https://github.com/austin-72/superstation-iptv" \
      org.opencontainers.image.licenses="MIT"

# ffmpeg converts formats browsers can't play; tini forwards stop signals; su-exec drops root after fixing the
# data folder's owner. The VAAPI drivers are for optional Intel/AMD hardware transcoding (pass /dev/dri through).
RUN apk add --no-cache ffmpeg tini su-exec tzdata \
 && (apk add --no-cache mesa-va-gallium libva-intel-driver 2>/dev/null || true)

WORKDIR /app
COPY package.json server.js defaults*.json ./
COPY lib ./lib
COPY web ./web
COPY public ./public
COPY extension ./extension
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

# The port comes from PORT (docker-compose), else "port" in defaults.json, else 8080.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+require('/app/lib/config').port+'/icon.svg',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "server.js"]
