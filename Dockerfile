# Agente SDR. Imagem enxuta: o codigo e Node puro, sem build.
FROM node:22-alpine
WORKDIR /app

# ffmpeg para a transcricao de audio do WhatsApp (a Meta entrega em ogg/opus).
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src src
COPY knowledge knowledge
COPY assets assets

ENV NODE_ENV=production
EXPOSE 8080

# O healthcheck bate no /status, que so responde com o servidor de pe. Se o processo travar,
# o Docker reinicia sozinho — e o combinado foi que este servico nao pode ficar fora do ar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/status',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/cloud-api.js"]
