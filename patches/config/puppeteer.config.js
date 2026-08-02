"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.height = exports.width = exports.puppeteerConfig = exports.useragent = exports.createUserAgent = void 0;
const puppeteerConfig = {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    WAUrl: 'https://web.whatsapp.com',
    width: 1440,
    height: 900,
    chromiumArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--ignore-certificate-errors',
    ]
};
exports.puppeteerConfig = puppeteerConfig;
const createUserAgent = (waVersion) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36`;
exports.createUserAgent = createUserAgent;
exports.useragent = (0, exports.createUserAgent)('2.2147.16');
exports.width = puppeteerConfig.width;
exports.height = puppeteerConfig.height;
