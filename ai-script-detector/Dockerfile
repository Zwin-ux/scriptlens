FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

RUN pip3 install --no-cache-dir faster-whisper==1.2.1

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

COPY . .

ENV NODE_ENV=production \
    SCRIPTLENS_BACKEND_ENABLE_ASR=false \
    SCRIPTLENS_BACKEND_ASR_MODEL=tiny.en \
    SCRIPTLENS_BACKEND_ASR_DEVICE=cpu \
    SCRIPTLENS_BACKEND_ASR_COMPUTE_TYPE=int8 \
    SCRIPTLENS_BACKEND_ASR_BEAM_SIZE=1 \
    SCRIPTLENS_BACKEND_ASR_VAD_FILTER=true \
    SCRIPTLENS_YTDLP_COMMAND=/usr/local/bin/yt-dlp

EXPOSE 8080

CMD ["node", "backend/server.js"]
