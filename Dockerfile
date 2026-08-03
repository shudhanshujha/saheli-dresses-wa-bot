FROM node:20-slim

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  fonts-ipafont-gothic \
  fonts-wqy-zenhei \
  fonts-thai-tlwg \
  fonts-kacst \
  fonts-freefont-ttf \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  libxss1 \
  libwayland-client0 \
  xdg-utils \
  wget \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV WA_USER_DATA_DIR=/app/session-data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

# Apply open-wa v4.76.0 compatibility patch (window.Debug no longer exists in modern WhatsApp Web)
COPY patches/initializer.js node_modules/@open-wa/wa-automate/dist/controllers/initializer.js
COPY patches/config/puppeteer.config.js node_modules/@open-wa/wa-automate/dist/config/puppeteer.config.js
COPY patches/browser.js node_modules/@open-wa/wa-automate/dist/controllers/browser.js

VOLUME ["/app/session-data"]

EXPOSE 8080

ENV HOST=0.0.0.0

CMD ["node", "src/main.mjs"]