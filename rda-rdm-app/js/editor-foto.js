/* ─── Editor da foto da nota (13/11/2026, pedido do Cleiton) ─────────────────────────────────────────────────────────
   Corrige a foto do comprovante à mão: girar 90°/180°, endireitar alguns graus, recortar e melhorar (brilho, contraste,
   nitidez e "Melhorar automático", o mesmo realce do scanner). Desfazer volta um passo; Original descarta os ajustes.

   window.EditorFoto.abrir(blob) → Promise<Blob|null>: a foto nova (JPEG) ou null se cancelou / não mudou nada.

   Como funciona: a tela trabalha numa cópia reduzida (rápida no celular); ao salvar, tudo é refeito sobre a foto em
   resolução original, numa tela só (giro + recorte no mesmo desenho, sem cópia intermediária da foto inteira). O giro
   fino corta sozinho as quinas que sobrariam (maior retângulo de mesma proporção dentro da foto girada). Não depende de
   nada do app.js: só do Scanner (opcional, para o realce automático e para os cantos livres).

   Cantos livres (13/11/2026, print da nota torta da Inova Celulares): além do recorte reto, cada um dos 4 cantos se arrasta
   sozinho até a ponta da nota, e ao salvar a nota é esticada para um retângulo (Scanner.aplanar, a mesma homografia do
   scanner da câmera). "Achar a nota" põe os cantos com o Scanner.achar. Os cantos ficam em frações do quadro já girado. */
window.EditorFoto = (() => {
  const PREVIA_MAX = 1400;          // lado maior da cópia de trabalho
  const SAIDA_MAX_PX = 16e6;        // teto de área do canvas (Safari do iPhone recusa acima de ~16,7 MP)
  const FINO_MAX = 15;              // graus para cada lado no "Endireitar"
  const QUAD_INICIAL = () => [{ x: 0.06, y: 0.06 }, { x: 0.94, y: 0.06 }, { x: 0.94, y: 0.94 }, { x: 0.06, y: 0.94 }];
  const INICIAL = () => ({ rot: 0, fino: 0, corte: { x: 0, y: 0, w: 1, h: 1 }, modo: 'ret', quad: QUAD_INICIAL(),
    brilho: 0, contraste: 0, nitidez: 0, auto: false });
  const temCantos = () => !!(window.Scanner?.aplanar);

  let ov = null, est = null, hist = [], fonte = null, previa = null, resolver = null, quadroPrevia = null, timerPrevia = 0;

  /* ── geometria ─────────────────────────────────────────── */
  /* tamanho do quadro depois do giro de 90° em 90° e do giro fino (quinas cortadas) */
  function quadro(W, H, st) {
    const giro = st.rot % 180 !== 0;
    const w = giro ? H : W, h = giro ? W : H;
    const t = Math.abs(st.fino) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const k = Math.min(w / (w * c + h * s), h / (w * s + h * c));
    return { w: w * k, h: h * k };
  }

  /* desenha a fonte (W×H) já girada e recortada; escala = pixels de saída por pixel da fonte */
  function desenhar(src, W, H, st, escala) {
    const q = quadro(W, H, st);
    const cx = st.corte.x * q.w, cy = st.corte.y * q.h, cw = st.corte.w * q.w, ch = st.corte.h * q.h;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(cw * escala));
    cv.height = Math.max(1, Math.round(ch * escala));
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.scale(escala, escala);
    g.translate(q.w / 2 - cx, q.h / 2 - cy);
    g.rotate((st.rot + st.fino) * Math.PI / 180);
    g.drawImage(src, -W / 2, -H / 2, W, H);
    return cv;
  }

  /* ── cantos livres ─────────────────────────────────────── */
  /* ordem que o aplanar espera: topo-esq, topo-dir, baixo-dir, baixo-esq (depois de um giro, a ordem se refaz) */
  function ordenarQuad(q) {
    const porSoma = [...q].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = porSoma[0], br = porSoma[3];
    const [m1, m2] = [porSoma[1], porSoma[2]];
    const tr = (m1.x - m1.y) > (m2.x - m2.y) ? m1 : m2, bl = tr === m1 ? m2 : m1;
    return [tl, tr, br, bl].map(c => ({ x: c.x, y: c.y }));
  }
  function girarQuad(q, a) {
    const f = a === '180' ? c => ({ x: 1 - c.x, y: 1 - c.y }) : a === 'dir' ? c => ({ x: 1 - c.y, y: c.x }) : c => ({ x: c.y, y: 1 - c.x });
    return ordenarQuad(q.map(f));
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /* estica o pedaço marcado do quadro (canvas) para um retângulo; mesmo cálculo de tamanho do Scanner.endireitar */
  function aplanarQuadro(cv, quadN) {
    const sw = cv.width, sh = cv.height;
    const q = ordenarQuad(quadN).map(c => ({ x: c.x * sw, y: c.y * sh }));
    const topo = dist(q[0], q[1]), base = dist(q[3], q[2]), esq = dist(q[0], q[3]), dir = dist(q[1], q[2]);
    const amplia = Math.max(2 * Math.max(topo, base) / (topo + base || 1), 2 * Math.max(esq, dir) / (esq + dir || 1));
    let dw = Math.round((topo + base) / 2 * amplia), dh = Math.round((esq + dir) / 2 * amplia);
    const k = Math.min(1, Math.sqrt(SAIDA_MAX_PX / Math.max(1, dw * dh)));
    dw = Math.max(1, Math.round(dw * k)); dh = Math.max(1, Math.round(dh * k));
    const src = cv.getContext('2d').getImageData(0, 0, sw, sh).data;
    const px = Scanner.aplanar(src, sw, sh, q, dw, dh);
    if (!px) throw new Error('aplanar falhou');
    const out = document.createElement('canvas'); out.width = dw; out.height = dh;
    out.getContext('2d').putImageData(new ImageData(px, dw, dh), 0, 0);
    return out;
  }

  /* ── ajustes de imagem ─────────────────────────────────── */
  const temAjuste = st => st.auto || st.brilho || st.contraste || st.nitidez;
  function ajustar(cv, st) {
    if (!temAjuste(st)) return cv;
    const g = cv.getContext('2d'), w = cv.width, h = cv.height;
    const im = g.getImageData(0, 0, w, h), px = im.data;
    if (st.auto && window.Scanner?.realcar) { try { Scanner.realcar(px, w, h); } catch (_) {} }
    if (st.brilho || st.contraste) {
      const k = 1 + st.contraste / 100, b = st.brilho * 1.6, lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) lut[v] = (v - 128) * k + 128 + b;
      for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
    }
    if (st.nitidez) nitidez(px, w, h, st.nitidez / 100 * 1.5);
    g.putImageData(im, 0, 0);
    return cv;
  }

  /* máscara de nitidez: v + a·(v − média 3×3), em duas passadas (linha e coluna) */
  function nitidez(px, w, h, a) {
    const n = w * h, tmp = new Uint16Array(n), bl = new Uint16Array(n);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const xa = x > 0 ? x - 1 : x, xb = x < w - 1 ? x + 1 : x;
          tmp[o + x] = px[(o + xa) * 4 + c] + px[(o + x) * 4 + c] + px[(o + xb) * 4 + c];
        }
      }
      for (let y = 0; y < h; y++) {
        const ya = (y > 0 ? y - 1 : y) * w, yb = (y < h - 1 ? y + 1 : y) * w, o = y * w;
        for (let x = 0; x < w; x++) bl[o + x] = tmp[ya + x] + tmp[o + x] + tmp[yb + x];
      }
      for (let i = 0; i < n; i++) {
        const v = px[i * 4 + c];
        px[i * 4 + c] = v + a * (v - bl[i] / 9);
      }
    }
  }

  /* ── tela ──────────────────────────────────────────────── */
  const CSS = `
#ef-ov{position:fixed;inset:0;z-index:115;background:#111;color:#fff;display:flex;flex-direction:column;gap:8px;
  padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));padding-top:calc(10px + env(safe-area-inset-top,0px));
  font-family:inherit;-webkit-user-select:none;user-select:none}
#ef-ov .ef-hd{display:flex;align-items:center;gap:8px;flex-shrink:0}
#ef-ov .ef-tit{flex:1;font-size:17px;font-weight:800}
#ef-ov .ef-x{width:42px;height:42px;border:none;border-radius:50%;background:rgba(255,255,255,.18);color:#fff;font-size:22px;cursor:pointer}
#ef-ov .ef-palco{flex:1;min-height:120px;position:relative;padding:14px;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
#ef-ov canvas.ef-img{max-width:100%;max-height:100%;display:block}
#ef-ov .ef-rect{position:absolute;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:move;touch-action:none}
#ef-ov .ef-rect::before,#ef-ov .ef-rect::after{content:"";position:absolute;inset:0;pointer-events:none;
  border:1px solid rgba(255,255,255,.35);border-left:none;border-right:none;top:33.3%;bottom:33.3%}
#ef-ov .ef-rect::after{border:1px solid rgba(255,255,255,.35);border-top:none;border-bottom:none;top:0;bottom:0;left:33.3%;right:33.3%}
#ef-ov .ef-alca{position:absolute;width:26px;height:26px;background:#fff;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,.5);touch-action:none}
#ef-ov .ef-alca.nw{left:-13px;top:-13px;cursor:nwse-resize}#ef-ov .ef-alca.ne{right:-13px;top:-13px;cursor:nesw-resize}
#ef-ov .ef-alca.sw{left:-13px;bottom:-13px;cursor:nesw-resize}#ef-ov .ef-alca.se{right:-13px;bottom:-13px;cursor:nwse-resize}
#ef-ov svg.ef-quad{position:absolute;pointer-events:none;overflow:visible}
#ef-ov .ef-pt{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:#fff;
  border:3px solid #4ade80;box-shadow:0 1px 6px rgba(0,0,0,.6);touch-action:none;cursor:grab;z-index:1}
#ef-ov .ef-ferr{flex-shrink:0;display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow-y:auto}
#ef-ov .ef-lin{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
#ef-ov .ef-lin.dois{grid-template-columns:repeat(2,minmax(0,1fr))}
#ef-ov .ef-b{min-height:40px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;border-radius:10px;
  font-size:14px;font-weight:700;cursor:pointer;padding:4px 6px;line-height:1.15}
#ef-ov .ef-b.on{background:#2e7d32;border-color:#2e7d32}
#ef-ov .ef-b:disabled{opacity:.4}
#ef-ov .ef-reg{display:grid;grid-template-columns:86px minmax(0,1fr) 40px;align-items:center;gap:8px;font-size:13.5px}
#ef-ov .ef-reg input{width:100%;accent-color:#7bd88f}
#ef-ov .ef-reg output{text-align:right;opacity:.8;font-variant-numeric:tabular-nums}
#ef-ov .ef-ft{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;flex-shrink:0}
#ef-ov .ef-ft .ef-b{min-height:46px;font-size:15.5px}
#ef-ov .ef-salvar{background:#2e7d32;border-color:#2e7d32}
body.ef-aberto #instalar-faixa{display:none!important}   /* a faixa de instalar (z 900) cobria as réguas */
#ef-ov .ef-msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font-size:16px;font-weight:700;z-index:2}`;

  const REGUAS = [
    ['fino', '📐 Endireitar', -FINO_MAX, FINO_MAX, 0.5, v => (v > 0 ? '+' : '') + v + '°'],
    ['brilho', '☀️ Brilho', -50, 50, 1, v => (v > 0 ? '+' : '') + v],
    ['contraste', '◐ Contraste', -50, 50, 1, v => (v > 0 ? '+' : '') + v],
    ['nitidez', '🔍 Nitidez', 0, 100, 1, v => String(v)],
  ];

  function montar() {
    if (!document.getElementById('ef-css')) {
      const s = document.createElement('style'); s.id = 'ef-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    ov = document.createElement('div');
    ov.id = 'ef-ov';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Ajustar a foto da nota');
    ov.innerHTML = `
      <div class="ef-hd"><span class="ef-tit">Ajustar foto</span>
        <button type="button" class="ef-x" data-ef="cancelar" aria-label="Cancelar sem salvar">✕</button></div>
      <div class="ef-palco"><canvas class="ef-img"></canvas>
        <div class="ef-rect"><span class="ef-alca nw" data-alca="nw"></span><span class="ef-alca ne" data-alca="ne"></span>
          <span class="ef-alca sw" data-alca="sw"></span><span class="ef-alca se" data-alca="se"></span></div>
        <svg class="ef-quad" style="display:none"><path class="ef-masc" fill="rgba(0,0,0,.55)" fill-rule="evenodd"></path>
          <polygon class="ef-pol" fill="none" stroke="#4ade80" stroke-width="2.5"></polygon></svg>
        ${[0, 1, 2, 3].map(i => `<span class="ef-pt" data-pt="${i}" style="display:none" aria-label="Canto ${i + 1} da nota"></span>`).join('')}
        <div class="ef-msg">Salvando a foto…</div></div>
      <div class="ef-ferr">
        <div class="ef-lin">
          <button type="button" class="ef-b" data-ef="esq">⟲ 90°</button>
          <button type="button" class="ef-b" data-ef="180">🔃 Cabeça p/ baixo</button>
          <button type="button" class="ef-b" data-ef="dir">⟳ 90°</button></div>
        ${temCantos() ? `<div class="ef-lin">
          <button type="button" class="ef-b" data-ef="modo-ret">▭ Recorte reto</button>
          <button type="button" class="ef-b" data-ef="modo-cantos">⬚ Cantos livres</button>
          <button type="button" class="ef-b" data-ef="achar">🎯 Achar a nota</button></div>` : ''}
        ${REGUAS.map(([k, rot, min, max, passo]) => `
        <label class="ef-reg"><span>${rot}</span><input type="range" data-reg="${k}" min="${min}" max="${max}" step="${passo}" value="0"><output data-out="${k}"></output></label>`).join('')}
        <div class="ef-lin">
          <button type="button" class="ef-b" data-ef="auto">✨ Melhorar automático</button>
          <button type="button" class="ef-b" data-ef="desfazer">↶ Desfazer</button>
          <button type="button" class="ef-b" data-ef="original">⟲ Original</button></div>
      </div>
      <div class="ef-ft">
        <button type="button" class="ef-b" data-ef="cancelar">Cancelar</button>
        <button type="button" class="ef-b ef-salvar" data-ef="salvar">✔ Salvar foto</button></div>`;
    document.body.appendChild(ov);
    document.body.classList.add('ef-aberto');

    ov.addEventListener('click', e => {
      const b = e.target.closest('[data-ef]'); if (!b || b.disabled) return;
      const a = b.dataset.ef;
      if (a === 'cancelar') return fechar(null);
      if (a === 'salvar') return salvar();
      if (a === 'desfazer') { if (hist.length) { est = hist.pop(); pintar(true); } return; }
      if (a === 'original') { if (mudou()) { guardar(); est = INICIAL(); pintar(true); } return; }
      guardar();
      if (a === 'esq' || a === 'dir' || a === '180') {
        est.rot = (est.rot + (a === 'esq' ? 270 : a === 'dir' ? 90 : 180)) % 360;
        est.corte = girarCorte(est.corte, a);
        est.quad = girarQuad(est.quad, a);
        return pintar(true);
      }
      if (a === 'auto') { est.auto = !est.auto; return pintar(true); }
      if (a === 'modo-ret' || a === 'modo-cantos') {
        const m = a === 'modo-ret' ? 'ret' : 'cantos';
        if (est.modo === m) { hist.pop(); return; }
        est.modo = m; return pintar(true);
      }
      if (a === 'achar') {
        const q = acharNota();
        if (!q) { hist.pop(); if (window.toast) toast('Não achei a nota sozinho: arraste os cantos até as pontas dela.', 'err'); return; }
        est.modo = 'cantos'; est.quad = q; return pintar(true);
      }
    });
    ov.querySelectorAll('input[data-reg]').forEach(inp => {
      let guardou = false;
      inp.addEventListener('input', () => {
        if (!guardou) { guardar(); guardou = true; }
        est[inp.dataset.reg] = Number(inp.value);
        pintar(inp.dataset.reg === 'fino');
      });
      inp.addEventListener('change', () => { guardou = false; });
    });
    ligarCorte();
    window.addEventListener('resize', posicionarRect);
  }

  /* o recorte acompanha o giro de 90°: o mesmo pedaço da nota continua selecionado */
  function girarCorte(c, a) {
    if (a === '180') return { x: 1 - c.x - c.w, y: 1 - c.y - c.h, w: c.w, h: c.h };
    if (a === 'dir') return { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
    return { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
  }

  const guardar = () => { hist.push(JSON.parse(JSON.stringify(est))); if (hist.length > 40) hist.shift(); };
  const mudou = () => JSON.stringify(est) !== JSON.stringify(INICIAL());

  /* pinta a cópia de trabalho: o quadro inteiro (giro + ajustes) com a caixa do recorte por cima */
  function pintar(geometria) {
    REGUAS.forEach(([k, , , , , fmt]) => {
      const inp = ov.querySelector(`input[data-reg="${k}"]`); if (Number(inp.value) !== est[k]) inp.value = est[k];
      ov.querySelector(`output[data-out="${k}"]`).textContent = fmt(est[k]);
    });
    ov.querySelector('[data-ef="auto"]').classList.toggle('on', est.auto);
    ov.querySelector('[data-ef="modo-ret"]')?.classList.toggle('on', est.modo === 'ret');
    ov.querySelector('[data-ef="modo-cantos"]')?.classList.toggle('on', est.modo === 'cantos');
    ov.querySelector('[data-ef="desfazer"]').disabled = !hist.length;
    ov.querySelector('[data-ef="original"]').disabled = !mudou();
    clearTimeout(timerPrevia);
    const fazer = () => {
      const inteiro = { ...est, corte: { x: 0, y: 0, w: 1, h: 1 } };
      if (geometria || !quadroPrevia) quadroPrevia = desenhar(previa, previa.width, previa.height, inteiro, 1);
      const cv = ov.querySelector('canvas.ef-img');
      const tela = temAjuste(est) ? ajustar(clonar(quadroPrevia), est) : quadroPrevia;
      cv.width = tela.width; cv.height = tela.height;
      cv.getContext('2d').drawImage(tela, 0, 0);
      posicionarRect();
    };
    if (geometria) fazer(); else timerPrevia = setTimeout(fazer, 60);   // réguas de cor: junta os movimentos rápidos
  }
  function clonar(cv) {
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0); return c;
  }

  function posicionarRect() {
    if (!ov) return;
    const cv = ov.querySelector('canvas.ef-img'), palco = ov.querySelector('.ef-palco'), r = ov.querySelector('.ef-rect');
    const a = cv.getBoundingClientRect(), p = palco.getBoundingClientRect(), c = est.corte;
    const cantos = est.modo === 'cantos', svg = ov.querySelector('svg.ef-quad');
    r.style.display = cantos ? 'none' : '';
    svg.style.display = cantos ? '' : 'none';
    ov.querySelectorAll('.ef-pt').forEach(pt => { pt.style.display = cantos ? '' : 'none'; });
    if (cantos) {
      const x0 = a.left - p.left, y0 = a.top - p.top;
      Object.assign(svg.style, { left: x0 + 'px', top: y0 + 'px', width: a.width + 'px', height: a.height + 'px' });
      svg.setAttribute('viewBox', `0 0 ${a.width} ${a.height}`);
      const pts = est.quad.map(q => [q.x * a.width, q.y * a.height]);
      svg.querySelector('.ef-pol').setAttribute('points', pts.map(v => v.join(',')).join(' '));
      svg.querySelector('.ef-masc').setAttribute('d', `M0,0H${a.width}V${a.height}H0Z M${pts.map(v => v.join(',')).join(' L')}Z`);
      ov.querySelectorAll('.ef-pt').forEach(pt => {
        const [x, y] = pts[Number(pt.dataset.pt)];
        pt.style.left = (x0 + x) + 'px'; pt.style.top = (y0 + y) + 'px';
      });
      return;
    }
    r.style.left = (a.left - p.left + c.x * a.width) + 'px';
    r.style.top = (a.top - p.top + c.y * a.height) + 'px';
    r.style.width = (c.w * a.width) + 'px';
    r.style.height = (c.h * a.height) + 'px';
  }

  /* arrastar a caixa (mover) ou uma alça (redimensionar), em frações do quadro */
  function ligarCorte() {
    const r = ov.querySelector('.ef-rect'), cv = ov.querySelector('canvas.ef-img');
    let arr = null;
    r.addEventListener('pointerdown', e => {
      e.preventDefault();
      const a = cv.getBoundingClientRect();
      arr = { alca: e.target.dataset.alca || 'mover', x0: e.clientX, y0: e.clientY, c0: { ...est.corte }, W: a.width, H: a.height, guardou: false, id: e.pointerId };
      try { r.setPointerCapture(e.pointerId); } catch (_) {}
    });
    r.addEventListener('pointermove', e => {
      if (!arr || e.pointerId !== arr.id) return;
      if (!arr.guardou) { guardar(); arr.guardou = true; }
      const dx = (e.clientX - arr.x0) / arr.W, dy = (e.clientY - arr.y0) / arr.H, c0 = arr.c0, MIN = 0.06;
      let { x, y, w, h } = c0;
      if (arr.alca === 'mover') {
        x = Math.min(1 - w, Math.max(0, c0.x + dx)); y = Math.min(1 - h, Math.max(0, c0.y + dy));
      } else {
        let x1 = c0.x + c0.w, y1 = c0.y + c0.h;
        if (arr.alca.includes('w')) x = Math.min(x1 - MIN, Math.max(0, c0.x + dx));
        if (arr.alca.includes('e')) x1 = Math.max(x + MIN, Math.min(1, x1 + dx));
        if (arr.alca.includes('n')) y = Math.min(y1 - MIN, Math.max(0, c0.y + dy));
        if (arr.alca.includes('s')) y1 = Math.max(y + MIN, Math.min(1, y1 + dy));
        w = x1 - x; h = y1 - y;
      }
      est.corte = { x, y, w, h };
      posicionarRect();
      ov.querySelector('[data-ef="desfazer"]').disabled = false;
      ov.querySelector('[data-ef="original"]').disabled = !mudou();
    });
    const soltar = e => { if (arr && e.pointerId === arr.id) arr = null; };
    r.addEventListener('pointerup', soltar);
    r.addEventListener('pointercancel', soltar);

    /* cantos livres: cada ponto anda sozinho, preso dentro do quadro */
    ov.querySelectorAll('.ef-pt').forEach(pt => {
      let mv = null;
      pt.addEventListener('pointerdown', e => {
        e.preventDefault();
        const a = cv.getBoundingClientRect();
        mv = { i: Number(pt.dataset.pt), a, guardou: false, id: e.pointerId };
        try { pt.setPointerCapture(e.pointerId); } catch (_) {}
      });
      pt.addEventListener('pointermove', e => {
        if (!mv || e.pointerId !== mv.id) return;
        if (!mv.guardou) { guardar(); mv.guardou = true; }
        const x = Math.min(1, Math.max(0, (e.clientX - mv.a.left) / mv.a.width));
        const y = Math.min(1, Math.max(0, (e.clientY - mv.a.top) / mv.a.height));
        est.quad = est.quad.map((q, k) => (k === mv.i ? { x, y } : q));
        posicionarRect();
        ov.querySelector('[data-ef="desfazer"]').disabled = false;
        ov.querySelector('[data-ef="original"]').disabled = !mudou();
      });
      const fim = e => { if (mv && e.pointerId === mv.id) { mv = null; est.quad = ordenarQuad(est.quad); posicionarRect(); } };
      pt.addEventListener('pointerup', fim);
      pt.addEventListener('pointercancel', fim);
    });
  }

  /* "Achar a nota": o mesmo detector do scanner da câmera, numa cópia pequena do quadro girado */
  function acharNota() {
    if (!window.Scanner?.achar || !quadroPrevia) return null;
    try {
      const mw = 320, mh = Math.max(1, Math.round(quadroPrevia.height * mw / quadroPrevia.width));
      const c = document.createElement('canvas'); c.width = mw; c.height = mh;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(quadroPrevia, 0, 0, mw, mh);
      const r = Scanner.achar(g.getImageData(0, 0, mw, mh).data, mw, mh);
      if (!r?.quad || r.quad.length !== 4) return null;
      return ordenarQuad(r.quad.map(q => ({ x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) })));
    } catch (_) { return null; }
  }

  /* refaz tudo na foto em resolução original */
  async function salvar() {
    if (!mudou()) return fechar(null);
    const msg = ov.querySelector('.ef-msg');
    msg.style.display = 'flex';
    ov.querySelectorAll('button').forEach(b => { b.disabled = true; });
    await new Promise(r => setTimeout(r, 30));   // deixa o aviso aparecer antes da conta pesada
    try {
      const W = fonte.width, H = fonte.height, q = quadro(W, H, est);
      let cv;
      if (est.modo === 'cantos' && temCantos()) {
        /* quadro inteiro (girado), depois a nota esticada para um retângulo; teto de área nos dois passos */
        const inteiro = { ...est, corte: { x: 0, y: 0, w: 1, h: 1 } };
        const escala = Math.min(1, Math.sqrt(12e6 / Math.max(1, q.w * q.h)));
        const quadroCv = desenhar(fonte, W, H, inteiro, escala);
        cv = ajustar(aplanarQuadro(quadroCv, est.quad), est);
        quadroCv.width = quadroCv.height = 0;
      } else {
        const area = q.w * est.corte.w * q.h * est.corte.h;
        const escala = Math.min(1, Math.sqrt(SAIDA_MAX_PX / Math.max(1, area)));
        cv = ajustar(desenhar(fonte, W, H, est, escala), est);
      }
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
      cv.width = cv.height = 0;
      fechar(blob && blob.size > 2000 ? blob : null, !blob);
    } catch (err) {
      console.error('EditorFoto: não salvou', err);
      fechar(null, true);
    }
  }

  function fechar(blob, falhou = false) {
    clearTimeout(timerPrevia);
    window.removeEventListener('resize', posicionarRect);
    ov?.remove(); ov = null;
    document.body.classList.remove('ef-aberto');
    try { fonte?.close?.(); } catch (_) {}
    fonte = previa = quadroPrevia = null; hist = [];
    const r = resolver; resolver = null;
    if (falhou && window.toast) toast('Não deu para salvar o ajuste — a foto ficou como estava.', 'err');
    r?.(blob);
  }

  async function carregar(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (_) {
      const url = URL.createObjectURL(blob);
      try {
        const im = new Image();
        await new Promise((ok, erro) => { im.onload = ok; im.onerror = erro; im.src = url; });
        return im;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }

  async function abrir(blob) {
    if (resolver) fechar(null);
    if (!blob || !/^image\//i.test(blob.type || 'image/jpeg')) return null;
    try { fonte = await carregar(blob); } catch (_) { if (window.toast) toast('Não deu para abrir esta foto para ajuste.', 'err'); return null; }
    const W = fonte.width || fonte.naturalWidth, H = fonte.height || fonte.naturalHeight;
    if (!W || !H) return null;
    const k = Math.min(1, PREVIA_MAX / Math.max(W, H));
    previa = document.createElement('canvas');
    previa.width = Math.round(W * k); previa.height = Math.round(H * k);
    previa.getContext('2d').drawImage(fonte, 0, 0, previa.width, previa.height);
    est = INICIAL(); hist = [];
    montar();
    pintar(true);
    requestAnimationFrame(posicionarRect);
    return new Promise(r => { resolver = r; });
  }

  return { abrir, _quadro: quadro, _girarCorte: girarCorte };
})();
