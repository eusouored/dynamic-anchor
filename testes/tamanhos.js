'use strict';
// Testa o painel numa grade de tamanhos e mede o alinhamento.
// Por tamanho: rolagem lateral, margens (16 px; 12 px abaixo de 360 de largura), bordas "quase" alinhadas
// (1 a 6 px fora da margem), centro vertical das linhas, sobreposição de controles, texto cortado e
// encaixe da área rolável entre a faixa do take e o rodapé.
const fs = require('fs'), path = require('path');
const { launch, open } = require('./harness');
const OUT = path.join(__dirname, 'out', 'tamanhos'); fs.mkdirSync(OUT, { recursive: true });
const WIDTHS = [280, 300, 320, 340, 359, 360, 390, 420, 480, 560, 640, 800, 1000];
const HEIGHTS = [300, 360, 361, 480, 620, 760, 900, 1200];
const SHOTS = new Set(['280x300', '280x620', '320x760', '359x760', '360x760', '390x760', '480x900', '640x900', '800x1200', '1000x760']);

function measure() {
  const P = document.getElementById('bancada'), W = P.clientWidth, H = P.clientHeight;
  const narrow = P.classList.contains('narrow'), g = narrow ? 12 : 16, issues = [];
  const R = el => el.getBoundingClientRect();
  const shown = el => { if (!el.isConnected) return false; const r = R(el); if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e && e !== P; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; if (e.classList.contains('b-backstage') || e.classList.contains('b-dd-menu')) return false; } return true; };
  const name = el => el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase()) + (el.textContent ? ' "' + el.textContent.trim().slice(0, 24) + '"' : '');
  const sc = document.getElementById('scroller');
  if (sc.scrollWidth > sc.clientWidth + 1) issues.push('rolagem lateral na área rolável (' + sc.scrollWidth + ' > ' + sc.clientWidth + ')');
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('rolagem lateral na página');
  const take = document.getElementById('takeCard'), foot = P.querySelector('footer');
  const st = R(sc), tk = R(take), ft = R(foot);
  if (Math.abs(st.top - tk.bottom) > 1) issues.push('área rolável não encosta na faixa do take (' + Math.round(st.top - tk.bottom) + ' px)');
  if (Math.abs(st.bottom - ft.top) > 1) issues.push('área rolável não encosta no rodapé (' + Math.round(ft.top - st.bottom) + ' px)');
  // margens e quase-alinhamentos
  const SEL = '[role=button],[role=slider],[role=checkbox],[role=radio],.b-dd,.b-seg,.number-field,#targetFrame,#bFirstFrame,h2,h3,p,.b-caption,.da-idx,.take-chip,.take-name,.b-axis-value,.da-lockup,.b-header-version';
  // botão interno do seletor fica 1 px dentro da caixa pintada (a caixa é que é medida)
  const items = [...P.querySelectorAll(SEL)].filter(shown).filter(el => !el.closest('.b-seg-item') && !el.closest('.slider-thumb') && !el.classList.contains('b-dd-btn') && !(el.parentElement && el.parentElement.closest('.b-seg')));
  for (const el of items) {
    const r = R(el), left = r.left, right = W - r.right;
    if (left < g - 0.5 || right < g - 0.5) issues.push('fora da margem: ' + name(el) + ' (esq ' + left.toFixed(1) + ', dir ' + right.toFixed(1) + ')');
    else {
      if (left - g > 0.5 && left - g <= 6 && !el.closest('.b-advanced-row,.b-more,.b-axes,.b-heading')) issues.push('quase na margem esquerda: ' + name(el) + ' (' + (left - g).toFixed(1) + ' px)');
      if (right - g > 0.5 && right - g <= 6) issues.push('quase na margem direita: ' + name(el) + ' (' + (right - g).toFixed(1) + ' px)');
    }
  }
  // centro vertical das linhas de cabeçalho e da linha de análise
  for (const row of [...P.querySelectorAll('.b-heading,.b-analysis,.take-row,.b-header')].filter(shown)) {
    const kids = [...row.children].filter(shown).filter(k => getComputedStyle(k).position !== 'absolute');
    const lines = [];
    for (const k of kids) { const r = R(k); let line = lines.find(l => r.top < l.bottom - 2 && r.bottom > l.top + 2); if (!line) lines.push(line = { top: r.top, bottom: r.bottom, items: [] }); line.items.push([k, (r.top + r.bottom) / 2]); line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom); }
    for (const l of lines) { const cs = l.items.map(i => i[1]); if (Math.max(...cs) - Math.min(...cs) > 1.5) issues.push('linha desalinhada em ' + name(row) + ': ' + l.items.map(i => name(i[0]) + '@' + i[1].toFixed(1)).join(', ')); }
  }
  // sobreposição de controles (o que está dentro da área rolável só conta na parte visível dela)
  const clip = el => { const r = R(el); if (!sc.contains(el)) return r; const v = R(sc); return { left: r.left, right: r.right, top: Math.max(r.top, v.top), bottom: Math.min(r.bottom, v.bottom) }; };
  const ctl = [...P.querySelectorAll('[role=button],[role=slider],[role=checkbox],.b-dd,.b-seg,.number-field,#targetFrame')].filter(shown).filter(el => !el.classList.contains('b-dd-btn'));
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], b = ctl[j]; if (a.contains(b) || b.contains(a)) continue;
    const r1 = clip(a), r2 = clip(b); if (r1.bottom <= r1.top || r2.bottom <= r2.top) continue;
    const ox = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left), oy = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
    if (ox > 1 && oy > 1) issues.push('sobreposição: ' + name(a) + ' × ' + name(b));
  }
  // texto cortado (reticências ou overflow escondido)
  for (const el of [...P.querySelectorAll('.take-name,.take-chip,.b-dd-text,h2,.b-seg-item,.file-title,#applyLabel,.check-label,.b-option-name,.b-caption')].filter(shown)) {
    if (el.scrollWidth > el.clientWidth + 1) issues.push('texto cortado: ' + name(el) + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
  }
  return { W, H, narrow, low: P.classList.contains('low'), issues: [...new Set(issues)] };
}

(async () => {
  const browser = await launch(); const results = []; const errs = [];
  try {
    for (const [state, sel, status, traj] of [['pronto', 'single', 'ready', true], ['sem-motor', 'single', 'offline', false]]) {
      for (const w of WIDTHS) for (const h of HEIGHTS) {
        if (state === 'sem-motor' && ![280, 359, 390, 640].includes(w)) continue;
        const { page, errors } = await open(browser, { width: w, height: h, theme: 'dark', selection: sel, status, trajectory: traj });
        await page.evaluate(() => { document.getElementById('bAdvancedToggle').click(); });
        await page.waitForTimeout(40);
        await page.evaluate(() => { document.getElementById('foldQuality').click(); window.AnchorBancada.reflow(); });
        await page.waitForTimeout(60);
        const m = await page.evaluate(measure);
        m.state = state; m.size = w + 'x' + h; m.pageErrors = errors; results.push(m);
        if (state === 'pronto' && SHOTS.has(m.size)) {
          await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
          await page.screenshot({ path: path.join(OUT, `${m.size}-escuro.png`) });
          await page.evaluate(() => window.__test.setTheme('light')); await page.waitForTimeout(60);
          await page.screenshot({ path: path.join(OUT, `${m.size}-claro.png`) });
        }
        await page.close();
      }
    }
  } catch (e) { errs.push(String(e.stack || e)); } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, 'tamanhos.json'), JSON.stringify(results, null, 1));
  const bad = results.filter(r => r.issues.length || r.pageErrors.length);
  const tally = {}; for (const r of bad) for (const i of r.issues) { const k = i.replace(/\(.*?\)/g, '').replace(/@[\d.]+/g, '').trim(); (tally[k] = tally[k] || []).push(r.state + ' ' + r.size); }
  console.log(JSON.stringify({ testados: results.length, comProblema: bad.length, errosDeExecucao: errs, problemas: Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, v.length + ' tamanhos: ' + v.slice(0, 6).join(', ') + (v.length > 6 ? '…' : '')])) }, null, 1));
})();
