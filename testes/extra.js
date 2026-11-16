'use strict';
// Telas que o capture.js não cobre: Outros métodos aberto, origem Máscara e destino Transformar (desfoque).
const path = require('path');
const { launch, open } = require('./harness');
const OUT = path.join(__dirname, 'out');
(async () => {
  const browser = await launch(); const errors = [];
  try {
    for (const theme of ['dark', 'light']) {
      const { page, errors: e1 } = await open(browser, { theme, selection: 'single', status: 'ready', trajectory: true, height: 1400 });
      await page.evaluate(() => { document.getElementById('bAdvancedToggle').click(); });
      await page.waitForTimeout(60);
      await page.evaluate(() => { document.getElementById('foldQuality').click(); });
      await page.waitForTimeout(60);
      await page.evaluate(() => { document.getElementById('qualityAdaptive').click(); });
      await page.waitForTimeout(60);
      await page.locator('#bAdvancedBody').screenshot({ path: path.join(OUT, `10-outros-metodos-${theme}.png`) });
      // destino Transformar mostra o desfoque de movimento
      await page.evaluate(() => { const d = document.getElementById('bDestination'); d.selectedIndex = 1; d.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForTimeout(80);
      await page.locator('#taskFrame').screenshot({ path: path.join(OUT, `11-destino-transformar-${theme}.png`) });
      // origem Máscara
      await page.evaluate(() => { const d = document.getElementById('bSource'); d.selectedIndex = 1; d.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForTimeout(120);
      await page.locator('#taskTrack').screenshot({ path: path.join(OUT, `12-origem-mascara-${theme}.png`) });
      // lista do seletor aberta
      await page.evaluate(() => { document.querySelector('#bZoomBox .b-dd-btn').click(); });
      await page.waitForTimeout(60);
      await page.locator('#taskFrame').screenshot({ path: path.join(OUT, `13-seletor-aberto-${theme}.png`) });
      errors.push(...e1); await page.close();
    }
  } catch (e) { errors.push(String(e.stack || e)); } finally { await browser.close(); }
  console.log(JSON.stringify({ errors }));
})();
