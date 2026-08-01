import('puppeteer').then(async (puppeteer) => {
  try {
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Users\\jhash\\.cache\\puppeteer\\chrome\\win64-131.0.6778.204\\chrome-win64\\chrome.exe',
      headless: true,
      args: ['--no-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText?.slice(0, 200) || '');
    console.log('TITLE:', title);
    console.log('BODY TEXT:', text);
    await browser.close();
  } catch (e) {
    console.error('check-wa error:', e.message);
  }
});