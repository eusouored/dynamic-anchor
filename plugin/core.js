// core.js — matemática do Dynamic Anchor (sem dependência do Premiere; roda no painel UXP e no Node).
// Convenção (igual ao Premiere): origem no canto superior esquerdo, Y cresce para baixo,
// ângulo positivo = sentido horário na tela. Unidades: pixels do quadro do clipe.

const DEG = Math.PI / 180;

function rot(v, a) {
  return {
    x: Math.cos(a * DEG) * v.x - Math.sin(a * DEG) * v.y,
    y: Math.sin(a * DEG) * v.x + Math.cos(a * DEG) * v.y,
  };
}

function centroid(pts) {
  const n = pts.length;
  return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
}

// Rotação (graus) que leva refPts -> pts (Procrustes 2D, sem escala)
function relativeAngle(refPts, pts) {
  const ca = centroid(refPts), cb = centroid(pts);
  let dot = 0, cross = 0;
  for (let i = 0; i < refPts.length; i++) {
    const a = { x: refPts[i].x - ca.x, y: refPts[i].y - ca.y };
    const b = { x: pts[i].x - cb.x, y: pts[i].y - cb.y };
    dot += a.x * b.x + a.y * b.y;
    cross += a.x * b.y - a.y * b.x;
  }
  return Math.atan2(cross, dot) / DEG;
}

// Vértices de máscara por quadro -> [{x, y, angle}] (ângulo relativo ao quadro de referência)
function measure(maskFrames, refIndex) {
  const refPts = maskFrames[refIndex];
  return maskFrames.map(pts => ({ ...centroid(pts), angle: relativeAngle(refPts, pts) }));
}

// Evita saltos de 360° em ângulos vindos de fora
function unwrapAngles(frames) {
  let prev = null, offset = 0;
  return frames.map(f => {
    let a = f.angle + offset;
    if (prev !== null) {
      while (a - prev > 180) { a -= 360; offset -= 360; }
      while (a - prev < -180) { a += 360; offset += 360; }
    }
    prev = a;
    return { ...f, angle: a };
  });
}

// Média móvel centrada. Nas bordas a janela é completada por reflexão ímpar (2·borda − espelho):
// uma tendência linear continua exata até o primeiro e o último quadro, sem puxar a trajetória
// para dentro (a janela truncada deslocava até 150 px com 100 % de suavização).
function smooth(frames, win) {
  if (!win || win < 2) return frames;
  const h = Math.floor(win / 2), last = frames.length - 1;
  if (last < 1) return frames;
  const at = (i, key) => {
    if (i >= 0 && i <= last) return frames[i][key];
    const edge = i < 0 ? 0 : last;
    let m = i < 0 ? -i : 2 * last - i;
    m = Math.max(0, Math.min(last, m));
    return 2 * frames[edge][key] - frames[m][key];
  };
  return frames.map((f, i) => {
    let sx = 0, sy = 0, sa = 0, n = 0;
    for (let k = i - h; k <= i + h; k++) { sx += at(k, 'x'); sy += at(k, 'y'); sa += at(k, 'angle'); n++; }
    return { ...f, x: sx / n, y: sy / n, angle: sa / n };
  });
}

// ---------- Reduzir tremor (EXPERIMENTAL, desligado por padrão) ----------
// reports/30 (bancada) e reports/31 (esta implementação). Só entra quando opt.tremor existe;
// sem ele, anchorFraming é exatamente o de antes (média móvel smoothWin, inclusive em 0 %).
//
// One Euro (Casiez et al.) nas duas direções, com a média das passadas: o corte sobe com a
// velocidade (suaviza forte parado, quase nada em movimento) e o atraso de uma passada
// cancela o adiantamento da outra. É o candidato oe-ab(1, 0,05) da bancada.
//
// Unidades: posição normalizada pela ALTURA DO QUADRO em que as linhas estão (frameHeight),
// para o mesmo movimento na tela dar o mesmo filtro em 4K e em 1080p. beta em Hz por
// (alturas do quadro/s): 108 = 0,05 Hz/(px/s) em 2160 px (o valor da bancada).
// fps explícito (o da sequência, em que as linhas estão). Nunca atravessa: recomeça a cada
// quebra de tempo (segmento/lacuna) e não altera linhas interpoladas pelo motor (perdas
// curtas preenchidas): elas ficam exatamente como vieram.
const TREMOR_PADRAO = Object.freeze({ method: 'one-euro-ida-volta', minCutoff: 1, beta: 108, dCutoff: 1 });

function oneEuro(v, fps, minCutoff, beta, dCutoff) {
  const n = v.length, out = new Array(n);
  if (!n) return out;
  const te = 1 / fps, alfa = c => 1 / (1 + 1 / (2 * Math.PI * c) / te);
  let xh = v[0], dxh = 0;
  out[0] = v[0];
  for (let i = 1; i < n; i++) {
    const dx = (v[i] - xh) * fps;
    dxh += alfa(dCutoff) * (dx - dxh);
    xh += alfa(minCutoff + beta * Math.abs(dxh)) * (v[i] - xh);
    out[i] = xh;
  }
  return out;
}
function oneEuroZeroLag(v, fps, minCutoff, beta, dCutoff) {
  const f = oneEuro(v, fps, minCutoff, beta, dCutoff), b = oneEuro(v.slice().reverse(), fps, minCutoff, beta, dCutoff).reverse();
  return f.map((x, i) => (x + b[i]) / 2);
}
// Índices onde começa um novo trecho contínuo: intervalo entre tempos > 1,5 quadro
// (mesma regra de quality.js e editing.js).
function tremorBreaks(times, fps) {
  if (!Array.isArray(times) || !(fps > 0)) throw new Error('Filtro de tremor: tempos ou FPS inválidos.');
  const out = [];
  for (let i = 1; i < times.length; i++) if (!(times[i] - times[i - 1] <= 1.5 / fps)) out.push(i);
  return out;
}
// Opções completas (para o painel): fps e altura do quadro explícitos, quebras pelos tempos.
function tremorOptions({ fps, frameHeight, times, sampling }) {
  const t = { ...TREMOR_PADRAO, fps, frameHeight, breaks: tremorBreaks(times, fps) };
  const bridges = require('./smoothing-sampling.js').bridges(sampling);
  if (bridges.length) t.samplingBridges = bridges;
  validateTremor(t, times.length);
  return t;
}
function validateTremor(t, n) {
  if (!t || t.method !== 'one-euro-ida-volta' || !(t.fps > 0) || !Number.isFinite(t.fps) || !(t.frameHeight > 0) || !Number.isFinite(t.frameHeight) ||
    !(t.minCutoff > 0) || !Number.isFinite(t.minCutoff) || !(t.beta >= 0) || !Number.isFinite(t.beta) || !(t.dCutoff > 0) || !Number.isFinite(t.dCutoff) ||
    !Array.isArray(t.breaks) || t.breaks.some((b, i) => !Number.isInteger(b) || b <= 0 || b >= n || (i && b <= t.breaks[i - 1])) ||
    (t.samplingBridges!==undefined&&(!Array.isArray(t.samplingBridges)||t.samplingBridges.some((b,i)=>!Number.isInteger(b)||b<=0||b>=n-1||(i&&b<=t.samplingBridges[i-1])))))
    throw new Error('Filtro de tremor: opções inválidas (método, FPS, altura do quadro, parâmetros ou quebras).');
}
// Trechos filtrados: contínuos no tempo E sem linha interpolada pelo motor.
function tremorRuns(frames, breaks, samplingBridges) {
  const runs = [], quebra = new Set(breaks);
  const sampled = new Set(samplingBridges||[]);
  const gap = i => frames[i].interpolated === true && !sampled.has(i);
  let a = -1;
  for (let i = 0; i <= frames.length; i++) {
    const fim = i === frames.length || gap(i) || quebra.has(i) ||
      (i>0&&frames[i].trackingSegment!==frames[i-1].trackingSegment);
    if (fim && a >= 0) { runs.push([a, i]); a = -1; }
    if (i < frames.length && !gap(i) && a < 0) a = i;
  }
  return runs;
}
function tremorFilter(frames, t) {
  validateTremor(t, frames.length);
  // beta / altura = Hz por (px/s): idêntico a normalizar a posição, sem arredondar trechos parados.
  const out = frames.map(f => ({ ...f })), betaPx = t.beta / t.frameHeight, bridgeBreaks = new Set(t.breaks);
  const sampled = new Set(t.samplingBridges||[]);
  const gap = i => frames[i].interpolated === true && !sampled.has(i);
  for (const [a, b] of tremorRuns(frames, t.breaks, t.samplingBridges)) {
    if (b - a < 2) continue;
    for (const k of ['x', 'y']) {
      const v = [];
      for (let i = a; i < b; i++) v.push(frames[i][k]);
      const f = oneEuroZeroLag(v, t.fps, t.minCutoff, betaPx, t.dCutoff);
      // A ponte interpolada conserva suas posições originais. Fixar suas
      // bordas evita criar um salto ao ligar o trecho filtrado à ponte bruta.
      // Uma transição curta distribui a correção sem apenas mover o tranco.
      const leftGap = a > 0 && gap(a - 1) &&
        frames[a - 1].held !== true &&
        frames[a - 1].trackingSegment === frames[a].trackingSegment && !bridgeBreaks.has(a);
      const rightGap = b < frames.length && gap(b) &&
        frames[b].held !== true &&
        frames[b - 1].trackingSegment === frames[b].trackingSegment && !bridgeBreaks.has(b);
      if (leftGap || rightGap) {
        const last = f.length - 1;
        const halo = Math.min(Math.max(1, Math.round(t.fps * 0.15)), last / 2);
        const fade = distance => {
          const u = Math.min(1, distance / halo);
          return 1 - u * u * (3 - 2 * u);
        };
        const leftError = v[0] - f[0], rightError = v[last] - f[last];
        for (let j = 0; j <= last; j++) {
          f[j] += (leftGap ? leftError * fade(j) : 0) +
            (rightGap ? rightError * fade(last - j) : 0);
        }
        if (leftGap) f[0] = v[0];
        if (rightGap) f[last] = v[last];
      }
      for (let i = a; i < b; i++) out[i][k] = f[i - a];
    }
  }
  return out;
}
// Suavização usada no cálculo: sem opt.tremor, a média móvel de sempre; com ele, filtro de
// tremor na posição e a média móvel smoothWin só no ângulo (rotação), como hoje.
function motionRows(frames) {
  if(!frames.some(f=>f&&f.trackingPoint!==undefined))return frames;
  return frames.map(f=>{
    if(!f||!f.trackingPoint||![f.trackingPoint.x,f.trackingPoint.y].every(Number.isFinite))throw Error('Referência de movimento facial incompleta.');
    const {trackingPoint,...row}=f;
    return {...row,x:trackingPoint.x,y:trackingPoint.y};
  });
}
function smoothTrack(frames, opt = {}) {
  frames=motionRows(frames);
  // Trechos recuperados trazem a identidade de cada segmento. A média móvel
  // não pode antecipar um reencontro nem misturar o rosto com quadros mantidos.
  const average = () => {
    // A trajetória já vem preenchida (pontes incluídas) e é suavizada como uma série só: separar por
    // segmento criava trancos de 100 a 300 px na retomada. Só quadros mantidos (held) ficam de fora,
    // para a média não misturar o rosto com um valor repetido.
    if (!frames.some(f => f.held === true)) return smooth(frames, opt.smoothWin);
    const out=[];let a=0;
    for(let b=1;b<=frames.length;b++)if(b===frames.length||(frames[b].held===true)!==(frames[a].held===true)){for(const row of smooth(frames.slice(a,b),opt.smoothWin))out.push(row);a=b;}
    return out;
  };
  const hold = out => {
    if(!out.some(r=>r.held===true))return out;
    out=out.slice();
    for(let i=1;i<out.length;i++)if(out[i].held===true)out[i]={...out[i],x:out[i-1].x,y:out[i-1].y,angle:out[i-1].angle};
    return out;
  };
  if (!opt.tremor) return hold(average());
  const pos = tremorFilter(frames, opt.tremor), ang = average();
  return hold(pos.map((f, i) => ({ ...f, angle: ang[i].angle })));
}

// Escala mínima (constante) para o quadro transformado cobrir todo o quadro de saída (sem áreas pretas).
// Modelo do Premiere:  p' = P + s·R(r)·(p − A)   com   P = ref + s·R(r)·(A − ct)
// => o ponto de origem que cai no canto de saída q é   p = ct + R(−r)(q − ref)/s ,  que deve ficar em [0,W]×[0,H].
// frame = quadro de saída (sequência); source = quadro do vídeo em que o rastreio está (padrão: o próprio frame).
function requiredScale(per, ref, frame, sourceTransform, source) {
  const { w: OW, h: OH } = frame;
  const { w: W, h: H } = source || frame;
  const corners = [{ x: 0, y: 0 }, { x: OW, y: 0 }, { x: OW, y: OH }, { x: 0, y: OH }];
  let need = 1;
  for (let i=0;i<per.length;i++) {
    const { ct, r } = per[i], motion=sourceTransform&&sourceTransform[i];
    for (const q of corners) {
      let w = rot({ x: q.x - ref.x, y: q.y - ref.y }, -r),center=ct;
      if(motion){
        center={x:motion.anchor.x+rot({x:ct.x-motion.position.x,y:ct.y-motion.position.y},-motion.rotation).x/motion.scale,
          y:motion.anchor.y+rot({x:ct.x-motion.position.x,y:ct.y-motion.position.y},-motion.rotation).y/motion.scale};
        w=rot(w,-motion.rotation);w={x:w.x/motion.scale,y:w.y/motion.scale};
      }
      const axis = (wv, c, size) => {
        if (wv > 1e-12) return size - c > 0 ? wv / (size - c) : Infinity;
        if (wv < -1e-12) return c > 0 ? -wv / c : Infinity;
        return 1;
      };
      need = Math.max(need, axis(w.x, center.x, W), axis(w.y, center.y, H));
    }
  }
  return need;
}

// Dynamic Anchor.
//   measured: [{x, y, angle}]
//   opt: { useX, useY, rotation (padrão false), maxRot, deadzone, smoothWin, anchor:{x,y}|null,
//          scaleMode: 'none'|'fixed'|'auto', zoomProtection (per-frame scale, only with auto),
//          scalePercent (aumento em %, ex.: 20 => 120%),
//          frame:{w,h} (obrigatório p/ 'auto'), maxScale, margin }
// Modelo: p' = Position + s·R(rot)·(p − Anchor).  Queremos  M(p) = ref + s·R(p − c_t),  logo
//   Position = ref + s·R(Anchor − c_t).   Anchor padrão = ref (o que a rotação precisa).
// O resultado traz .meta = { scale, needed, clamped }.
function anchorFraming(measured, refIndex, opt = {}) {
  if(!Array.isArray(measured)||measured.length<2||!Number.isInteger(refIndex)||refIndex<0||refIndex>=measured.length||
    !measured.every(f=>f&&[f.x,f.y,f.angle].every(Number.isFinite)))throw new Error('Dados de rastreamento inválidos.');
  const o = { useX: true, useY: true, rotation: false, maxRot: Infinity, deadzone: 0, smoothWin: 0, anchor: null,
              scaleMode: 'none', scalePercent: 20, frame: null, maxScale: 3, margin: 0.01, ...opt };
  if(o.zoomProtection===true&&(o.scaleMode!=='auto'||o.scaleOverride!==undefined))
    throw new Error("zoomProtection precisa de scaleMode 'auto' e não aceita scaleOverride.");
  if(o.zoomProtection!==undefined&&typeof o.zoomProtection!=='boolean')
    throw new Error('zoomProtection deve ser booleano.');
  const m = smoothTrack(unwrapAngles(measured), o);
  const ref = m[refIndex];
  const baseTarget = o.target || ref, offset = o.targetOffset || {x:0,y:0};
  if(!Number.isFinite(offset.x)||!Number.isFinite(offset.y))throw new Error('Deslocamento do centro inválido.');
  const target = {x:o.useX ? baseTarget.x+offset.x : ref.x, y:o.useY ? baseTarget.y+offset.y : ref.y};
  const anchor = o.anchor ? { x: o.anchor.x, y: o.anchor.y } : { x: ref.x, y: ref.y };

  // 1) por quadro: ponto efetivo (eixo desligado = "sem movimento") e rotação
  const per = m.map(f => {
    const ct = { x: o.useX ? f.x : ref.x, y: o.useY ? f.y : ref.y };
    let r = 0; // a rotação só entra se o usuário habilitar
    if (o.rotation) {
      r = -(f.angle - ref.angle);
      // Zona morta suave: abaixo dela nada; acima, só o excesso (sem salto ao cruzar o limite).
      if (o.deadzone > 0) r = Math.abs(r) <= o.deadzone ? 0 : Math.sign(r) * (Math.abs(r) - o.deadzone);
      r = Math.max(-o.maxRot, Math.min(o.maxRot, r));
    }
    return { ct, r };
  });

  // 2) escala constante, exceto na proteção responsiva, que mantém o piso
  // do quadro de referência e só amplia quando a necessidade de cobertura sobe.
  let scale = 1, needed = 1, clamped = false;
  let protectedScales = null, perFrameNeeded = null, minScale = null, requiredProtectedScale = null;
  if (o.scaleMode === 'fixed') {
    scale = 1 + Math.max(0, o.scalePercent) / 100;
  } else if (o.scaleMode === 'auto') {
    if (!o.frame) throw new Error("scaleMode 'auto' precisa de frame:{w,h}");
    if(o.zoomProtection===true){
      if(![o.frame.w,o.frame.h,o.margin,o.maxScale].every(Number.isFinite)||o.frame.w<=0||o.frame.h<=0||o.margin<0||o.maxScale<1)
        throw new Error('Opções inválidas para zoomProtection.');
      perFrameNeeded=new Array(per.length);
      for(let i=0;i<per.length;i++){
        perFrameNeeded[i]=requiredScale([per[i]],target,o.frame,o.sourceTransform?[o.sourceTransform[i]]:null,o.source);
        if(perFrameNeeded[i]>needed)needed=perFrameNeeded[i];
      }
      const withMargin=n=>n>1?n*(1+o.margin):1;
      const referenceScale=withMargin(perFrameNeeded[refIndex]);
      protectedScales=new Array(perFrameNeeded.length);
      requiredProtectedScale=1;scale=0;minScale=Infinity;
      for(let i=0;i<perFrameNeeded.length;i++){
        const required=Math.max(referenceScale,withMargin(perFrameNeeded[i]));
        if(required>requiredProtectedScale)requiredProtectedScale=required;
        const applied=Math.min(required,o.maxScale);
        if(applied+1e-12<required)clamped=true;
        protectedScales[i]=applied;
        if(applied>scale)scale=applied;
        if(applied<minScale)minScale=applied;
      }
    }else{
      needed = requiredScale(per, target, o.frame, o.sourceTransform, o.source);
      if(o.minimumCover && !Number.isFinite(needed))throw Error('Nenhum zoom finito cobre este enquadramento. Ajuste a posição do alvo.');
      scale = o.minimumCover ? needed : needed > 1 ? needed * (1 + o.margin) : 1;
    }
  }
  if (o.zoomProtection!==true&&o.scaleOverride !== undefined) {
    if (!Number.isFinite(o.scaleOverride) || o.scaleOverride <= 0) throw new Error('Escala atual inválida.');
    scale = o.scaleOverride;
  } else if (!(o.scaleMode==='auto'&&o.minimumCover)&&o.zoomProtection!==true&&scale > o.maxScale) { scale = o.maxScale; clamped = true; }
  // Zoom Auto cobre o quadro sem bordas pretas; o "Limite" da interface não pode ser ignorado em silêncio:
  // se a cobertura exige mais do que o limite, recusa antes de gravar.
  if (o.scaleMode==='auto'&&o.minimumCover&&o.autoLimit===true&&Number.isFinite(o.maxScale)&&scale>o.maxScale+1e-9) {
    const error=new Error('O zoom necessário para cobrir o quadro ('+(scale*100).toFixed(0)+'%) passa do limite de '+(o.maxScale*100).toFixed(0)+'%. Aumente o limite ou mude o enquadramento. Nada foi gravado.');
    error.code='ANCHOR_AUTO_LIMIT';throw error;
  }

  // 3) posição com a escala aplicada em torno do Anchor
  const keys = per.map(({ ct, r },i) => {
    const keyScale=protectedScales?protectedScales[i]:scale;
    const v = rot({ x: anchor.x - ct.x, y: anchor.y - ct.y }, r);
    return { px: target.x + keyScale * v.x, py: target.y + keyScale * v.y, rotation: r, scale:keyScale, anchor };
  });
  keys.meta = { scale, needed, clamped, target };
  if(o.zoomProtection===true)Object.assign(keys.meta,{variableScale:true,minScale,referenceScaleIndex:refIndex,referenceScale:protectedScales[refIndex],perFrameNeeded,requiredProtectedScale});
  return keys;
}

// Aplica a transformação do Premiere a pontos (usado nos testes)
function applyTransform(pts, k) {
  const s = k.scale === undefined ? 1 : k.scale;
  return pts.map(p => {
    const v = rot({ x: p.x - k.anchor.x, y: p.y - k.anchor.y }, k.rotation);
    return { x: k.px + s * v.x, y: k.py + s * v.y };
  });
}

// ---------- Entrada de dados ----------
// Aceita CSV/TSV/;  "quadro,x,y[,ângulo]"  (linhas começando com # ou texto são ignoradas)
// ou JSON: [{frame,x,y,angle}, ...]
function parseTracking(text) {
  const t = (text || '').trim();
  if (!t) return [];
  if (t[0] === '[' || t[0] === '{') {
    let arr = JSON.parse(t);
    if (!Array.isArray(arr)) arr = arr.frames || arr.points || [];
    if (!Array.isArray(arr)) throw new Error('JSON: use uma lista de quadros.');
    return validateTracking(arr.map((r, i) => {
      if (!r || r.x === null || r.y === null || r.x === '' || r.y === '' || r.x === undefined || r.y === undefined)
        throw new Error('JSON: coordenadas ausentes no quadro ' + i + '.');
      return { frame: +(r.frame ?? i), x: +r.x, y: +r.y, angle: +(r.angle ?? 0) };
    }));
  }
  const out = [];
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line) || /^\s*(frame|quadro)[,;\t ]/i.test(line)) continue;
    const parts = line.trim().split(/[,;\t ]+/).map(Number);
    if (parts.length < 3 || parts.length > 4 || parts.some(n => !Number.isFinite(n))) throw new Error('Linha de tracking inválida: ' + line.slice(0,80));
    out.push({ frame: parts[0], x: parts[1], y: parts[2], angle: parts[3] === undefined ? 0 : parts[3] });
  }
  return validateTracking(out);
}

function validateTracking(rows) {
  rows.sort((a,b) => a.frame-b.frame);
  rows.forEach((r,i) => {
    if (![r.frame,r.x,r.y,r.angle].every(Number.isFinite) || !Number.isInteger(r.frame) || r.frame<0)
      throw new Error('Tracking: quadro ou coordenada inválida na linha ' + (i+1) + '.');
    if (i && rows[i-1].frame === r.frame) throw new Error('Tracking: quadro duplicado ' + r.frame + '.');
  });
  return rows;
}

// Dados de exemplo para testar a ESCRITA de keyframes sem depender da leitura da máscara
function exampleTracking(n = 90, w = 1920, h = 1080) {
  return Array.from({ length: n }, (_, t) => ({
    frame: t,
    x: w / 2 + 80 * Math.sin(t / 15),
    y: h / 2 + 40 * Math.sin(t / 9),
    angle: t === 0 ? 0 : 12 * Math.sin(t / 11),
  }));
}

function toCSV(rows) {
  return rows.map(r => `${r.frame},${r.x.toFixed(2)},${r.y.toFixed(2)},${r.angle.toFixed(3)}`).join('\n');
}

// "Suavização %" vale uma DURAÇÃO (a janela em quadros a 30 fps), não uma contagem de quadros:
// o mesmo valor suaviza o mesmo número de segundos a 23,976, 29,97 ou 59,94 fps.
function smoothWindow(percent, fps) {
  if (!(percent > 0)) return 0;
  const at30 = 2 * Math.max(1, Math.round(percent / 2)) + 1;
  if (!(fps > 0)) return at30;
  const frames = Math.round(at30 / 30 * fps);
  return Math.max(3, frames % 2 === 0 ? frames + 1 : frames);
}
const api = { smoothWindow, rot, centroid, relativeAngle, measure, unwrapAngles, smooth, smoothTrack, motionRows, tremorFilter, tremorOptions, tremorBreaks, TREMOR_PADRAO, anchorFraming, requiredScale, applyTransform, parseTracking, exampleTracking, toCSV };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AnchorCore = api;
