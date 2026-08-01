FROM node:20-slim

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  wget \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

# Apply open-wa v4.76.0 compatibility patch (window.Debug no longer exists in modern WhatsApp Web)
COPY patches/initializer.js node_modules/@open-wa/wa-automate/dist/controllers/initializer.js
COPY patches/config/puppeteer.config.js node_modules/@open-wa/wa-automate/dist/config/puppeteer.config.js

EXPOSE 8080

ENV HOST=0.0.0.0

CMD ["node", "launcher.mjs"]