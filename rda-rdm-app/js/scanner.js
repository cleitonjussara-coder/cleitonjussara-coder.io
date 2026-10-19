'use strict';
/* ─────────────────────────────────────────────────────────────
   SCANNER.js — "digitalizar documento" na câmera da nota (19/10/2026)

   Modelo: o scanner de documentos do celular (contorno azul sobre a nota ao
   vivo, disparo quando a imagem estabiliza, página endireitada no final).

   Três partes, todas em JS puro (sem biblioteca, sem WebAssembly) para
   rodar igual em qualquer aparelho com getUserMedia — Android, iPhone, PC:
   1. achar()      — acha o papel num quadro (claro e neutro, maior bloco
                     conectado) e devolve os 4 cantos. Roda em ~3 ms numa
                     miniatura de 240 px, então cabe até em celular modesto.
   2. aoVivo()     — desenha o contorno sobre o vídeo e avisa quando os
                     cantos ficaram parados (disparo automático).
   3. endireitar() — na foto final, acha os cantos de novo e corrige a
                     perspectiva (homografia) + clareia o fundo do papel.

   REGRA DE OURO: nunca piorar a foto. Qualquer dúvida (sem papel, papel
   cortado pela borda, quadrilátero torto, falta de memória, erro) devolve a
   foto original intacta. O contorno ainda ganha folga de ~1,5% para a letra
   da borda não encostar no corte.
───────────────────────────────────────────────────────────── */
window.Scanner = (() => {

  const CROMA_MAX = 55;          // papel e tinta são neutros; tecido colorido não
  const AREA_MIN  = 0.10;        // menor fração do quadro que vale como "a nota"
  const AREA_MAX  = 0.95;        // acima disso o "papel" é o fundo (mesa branca)
  const PREENCHE  = 0.80;        // quanto do quadrilátero tem que ser papel (letra e QR são buracos, mas poucos)
  const FOLGA     = 0.015;       // folga do contorno, fração do lado médio do papel
  const MAX_SAIDA = 3000;        // maior lado da página endireitada
  const GRAD_BORDA = 22;         // degrau de brilho (0..255, entre vizinhos a 2 px) que já é borda do papel e barra o crescimento
  const BORDA     = 0.012;       // canto a menos que isto da borda do quadro = papel cortado

  function _otsu(h, de) {
    let tot = 0, soma = 0;
    for (let t = de; t < 256; t++) { tot += h[t]; soma += t * h[t]; }
    if (!tot) return 128;
    let somaB = 0, pesoB = 0, melhor = -1, limiar = 128;
    for (let t = de; t < 256; t++) {
      pesoB += h[t];
      if (!pesoB) continue;
      const pesoF = tot - pesoB;
      if (!pesoF) break;
      somaB += t * h[t];
      const mB = somaB / pesoB, mF = (soma - somaB) / pesoF;
      const e = pesoB * pesoF * (mB - mF) * (mB - mF);
      if (e > melhor) { melhor = e; limiar = t; }
    }
    return limiar;
  }

  /* Área de polígono (shoelace), frações ou px — o chamador sabe. */
  function _area(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2;
  }
  function _convexo(q) {
    let sinal = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (!z) return false;
      const s = z > 0 ? 1 : -1;
      if (sinal && s !== sinal) return false;
      sinal = s;
    }
    return true;
  }
  const _dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /* ── 1. Achar o papel ───────────────────────────────────────
     d = RGBA (ImageData.data) de W×H. Devolve
       { quad: [TL, TR, BR, BL] em frações 0..1, area, cortada }  ou null. */
  function achar(d, W, H) {
    const n = W * H;
    const cinza = new Uint8Array(n), croma = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const y = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
      cinza[p] = y; hist[y]++;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      croma[p] = mx - mn;
    }
    // 1º Otsu separa o escuro; se o que sobra ainda tem dois grupos (tecido médio × papel claro), o 2º separa de novo
    const t1 = _otsu(hist, 0);
    const t2 = _otsu(hist, t1 + 1);
    let nLo = 0, sLo = 0, nHi = 0, sHi = 0;
    for (let v = t1 + 1; v < 256; v++) {
      if (v <= t2) { nLo += hist[v]; sLo += v * hist[v]; } else { nHi += hist[v]; sHi += v * hist[v]; }
    }
    const separa = nLo > 0 && nHi > 0 && (sHi / nHi - sLo / nLo) >= 30 && Math.min(nLo, nHi) / (nLo + nHi) >= 0.12;
    const thr = separa ? t2 : t1;

    const M = new Uint8Array(n);
    for (let p = 0; p < n; p++) M[p] = (cinza[p] > thr && croma[p] < CROMA_MAX) ? 1 : 0;

    // erosão 3×3: solta pontes finas entre o papel e manchas claras
    const E = new Uint8Array(n);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (M[i] && M[i - 1] && M[i + 1] && M[i - W] && M[i + W] && M[i - W - 1] && M[i - W + 1] && M[i + W - 1] && M[i + W + 1]) E[i] = 1;
      }
    }

    // maior componente conectado (8 vizinhos)
    const rot = new Int32Array(n), pilha = new Int32Array(n);
    let melhorN = 0, melhorId = 0, id = 0;
    for (let p0 = 0; p0 < n; p0++) {
      if (!E[p0] || rot[p0]) continue;
      id++;
      let topo = 0, cont = 0;
      pilha[topo++] = p0; rot[p0] = id;
      while (topo) {
        const p = pilha[--topo]; cont++;
        const x = p % W, y = (p - x) / W;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            if (E[q] && !rot[q]) { rot[q] = id; pilha[topo++] = q; }
          }
        }
      }
      if (cont > melhorN) { melhorN = cont; melhorId = id; }
    }
    if (!melhorId || melhorN < n * AREA_MIN * 0.5) return null;

    /* 19/10/2026 — o contorno cortava o cupom em dois casos reais: (1) sombra no pé/topo da nota: o papel sombreado fica
       abaixo do limiar de brilho e some da máscara; (2) borda curva/enrolada do papel: os 4 cantos formam um quadrilátero
       que fica por dentro do papel no meio dos lados. Agora: (1) o miolo CLARO cresce para dentro da sombra (histerese:
       pixels neutros acima de uma fração do brilho do papel e CONECTADOS ao miolo); (2) cada lado do quadrilátero é
       empurrado para fora até envolver todo o papel achado. */
    const sel = new Uint8Array(n);
    let selN = 0;
    for (let p = 0; p < n; p++) if (rot[p] === melhorId) { sel[p] = 1; selN++; }
    {
      const gh = new Uint32Array(256);
      for (let p = 0; p < n; p++) if (sel[p]) gh[cinza[p]]++;
      let c = 0, P = 255;
      for (let v = 0; v < 256; v++) { c += gh[v]; if (c >= selN * 0.8) { P = v; break; } }
      for (const k of [0.45, 0.6]) {
        const thr2 = P * k;
        if (thr2 >= thr) continue;                         // não é mais baixo que o limiar do miolo: nada a ganhar
        const M2 = new Uint8Array(n);
        for (let p = 0; p < n; p++) M2[p] = (cinza[p] > thr2 && croma[p] < CROMA_MAX) ? 1 : 0;
        /* a sombra muda de brilho aos poucos; a borda do papel (contra mesa, tecido, volante) é um degrau. Pixels de borda
           forte não entram no crescimento — ele para na borda em vez de vazar para o fundo escuro. Letra também é borda
           forte, mas é ilha dentro do papel: o crescimento a contorna. */
        const E2 = M2;
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            if (!M2[i]) continue;
            const gx = cinza[i + 1] - cinza[i - 1], gy = cinza[i + W] - cinza[i - W];
            if ((gx < 0 ? -gx : gx) > GRAD_BORDA || (gy < 0 ? -gy : gy) > GRAD_BORDA) E2[i] = 0;
          }
        }
        for (let p = 0; p < n; p++) if (sel[p]) E2[p] = 1;      // o miolo claro nunca sai
        const alc = new Uint8Array(n); let topo = 0, cont = 0;
        for (let p = 0; p < n; p++) if (sel[p] && E2[p]) { alc[p] = 1; pilha[topo++] = p; cont++; }
        while (topo) {
          const p = pilha[--topo];
          const x = p % W, y = (p - x) / W;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= W) continue;
              const q = yy * W + xx;
              if (E2[q] && !alc[q]) { alc[q] = 1; pilha[topo++] = q; cont++; }
            }
          }
        }
        const preenchida = m => {                           // área do bloco preenchido linha a linha (texto e QR não contam como buraco)
          let t = 0;
          for (let y = 0; y < H; y++) {
            let a = -1, b = -1;
            for (let x = 0; x < W; x++) if (m[y * W + x]) { if (a < 0) a = x; b = x; }
            if (a >= 0) t += b - a + 1;
          }
          return t;
        };
        const antes = preenchida(sel), depois = preenchida(alc);
        if (depois > antes * 1.6 || depois > n * AREA_MAX) continue;   // vazou para o fundo (mesa clara): tenta um limiar mais exigente
        for (let p = 0; p < n; p++) sel[p] = alc[p];
        selN = cont;
        break;
      }
    }

    /* cantos do convexo pelos extremos: x+y mínimo = canto superior esquerdo, x+y máximo = inferior direito,
       x−y máximo = superior direito, x−y mínimo = inferior esquerdo. Vale para nota torta e em perspectiva. */
    let tl = null, tr = null, br = null, bl = null;
    let sMin = Infinity, sMax = -Infinity, dMax = -Infinity, dMin = Infinity;
    const lmin = new Int16Array(H).fill(W), lmax = new Int16Array(H).fill(-1);
    for (let p = 0; p < n; p++) {
      if (!sel[p]) continue;
      const y = (p / W) | 0, x = p - y * W;
      if (x < lmin[y]) lmin[y] = x;
      if (x > lmax[y]) lmax[y] = x;
      const s = x + y, df = x - y;
      if (s < sMin)  { sMin = s;  tl = { x, y }; }
      if (s > sMax)  { sMax = s;  br = { x, y }; }
      if (df > dMax) { dMax = df; tr = { x, y }; }
      if (df < dMin) { dMin = df; bl = { x, y }; }
    }
    if (!tl || !tr || !br || !bl) return null;

    const px = [tl, tr, br, bl].map(c => ({ x: c.x + 0.5, y: c.y + 0.5 }));
    const areaPx = _area(px);
    if (areaPx < n * AREA_MIN || areaPx > n * AREA_MAX) return null;
    if (!_convexo(px)) return null;

    // o quadrilátero tem que ser PAPEL: letras e QR são buracos pequenos, mas um "L" ou um bloco irregular não passa
    let cheio = 0;
    for (let y = 0; y < H; y++) if (lmax[y] >= lmin[y]) cheio += lmax[y] - lmin[y] + 1;
    if (cheio < areaPx * PREENCHE) return null;

    const lados = [_dist(px[0], px[1]), _dist(px[1], px[2]), _dist(px[2], px[3]), _dist(px[3], px[0])];
    const piso = Math.min(W, H) * 0.12;
    if (Math.min(...lados) < piso) return null;
    // lados opostos muito diferentes = não é papel retangular visto de frente (é o mapa de claro pegando outra coisa)
    if (Math.max(lados[0], lados[2]) / Math.min(lados[0], lados[2]) > 2.2 || Math.max(lados[1], lados[3]) / Math.min(lados[1], lados[3]) > 2.2) return null;

    /* envolve o papel: cada lado vai para fora até o ponto mais distante do papel achado (laterais curvas, canto
       dobrado), mais a folga (1 px da erosão + FOLGA do tamanho do papel) para a letra da borda não encostar no corte */
    const cx = (px[0].x + px[1].x + px[2].x + px[3].x) / 4, cy = (px[0].y + px[1].y + px[2].y + px[3].y) / 4;
    const lado = (lados[0] + lados[1] + lados[2] + lados[3]) / 4;
    const margem = 2 + lado * FOLGA;                  // 2 px: a erosão e a borda excluída do crescimento
    const retas = [];
    for (let i = 0; i < 4; i++) {
      const a = px[i], b = px[(i + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      let nx = dy / l, ny = -dx / l;
      if (nx * (a.x - cx) + ny * (a.y - cy) < 0) { nx = -nx; ny = -ny; }
      let maxd = 0;
      for (let y = 0; y < H; y++) {
        if (lmax[y] < lmin[y]) continue;
        for (const X of [lmin[y], lmax[y] + 1]) {
          for (const Y of [y, y + 1]) { const d = nx * (X - a.x) + ny * (Y - a.y); if (d > maxd) maxd = d; }
        }
      }
      retas.push({ nx, ny, c: nx * a.x + ny * a.y + maxd + margem });
    }
    const quad = [];
    for (let i = 0; i < 4; i++) {
      const r1 = retas[(i + 3) % 4], r2 = retas[i];                 // o canto i é o encontro do lado anterior com o lado i
      const det = r1.nx * r2.ny - r1.ny * r2.nx;
      let X, Y;
      if (Math.abs(det) < 1e-6) {                                    // lados paralelos (degenerado): empurra o canto pelo centro
        const dx = px[i].x - cx, dy = px[i].y - cy, l = Math.hypot(dx, dy) || 1;
        X = px[i].x + dx / l * margem; Y = px[i].y + dy / l * margem;
      } else {
        X = (r1.c * r2.ny - r1.ny * r2.c) / det;
        Y = (r1.nx * r2.c - r1.c * r2.nx) / det;
      }
      quad.push({ x: Math.max(0, Math.min(1, X / W)), y: Math.max(0, Math.min(1, Y / H)) });
    }
    if (!_convexo(quad.map(c => ({ x: c.x * W, y: c.y * H }))) || _area(quad) * n > n * AREA_MAX) return null;
    const cortada = quad.some(c => c.x < BORDA || c.x > 1 - BORDA || c.y < BORDA || c.y > 1 - BORDA);
    return { quad, area: areaPx / n, cortada };
  }

  /* ── 2. Ao vivo ─────────────────────────────────────────────
     Desenha o contorno sobre o <video> (object-fit: cover) e chama
     aoEstabilizar() uma vez quando o contorno fica parado por ~1,1 s.
     opts: { aoEstado(estado) com 'procura'|'achou'|'parado'|'cortada' , aoEstabilizar() , automatico }.
     Devolve { parar(), setAutomatico(b), liberar() }. */
  const LARG_VIVO = 240;
  const PARADO_MS = 1100;
  const MOVE_MAX  = 0.025;       // quanto o canto pode andar (fração do quadro) e ainda contar como parado
  function aoVivo(video, canvas, opts = {}) {
    const mini = document.createElement('canvas');
    const mctx = mini.getContext('2d', { willReadFrequently: true });
    let ativo = true, timer = null, ultimo = null, desde = 0, estado = '', disparou = false, auto = opts.automatico !== false, liberaEm = 0;

    function _estado(e) { if (e !== estado) { estado = e; try { opts.aoEstado && opts.aoEstado(e); } catch (_) {} } }

    function _desenhar(quad, cor) {
      const g = canvas.getContext('2d');
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      g.clearRect(0, 0, cw, ch);
      if (!quad) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      const k = Math.max(cw / vw, ch / vh);                  // object-fit: cover
      const ox = (cw - vw * k) / 2, oy = (ch - vh * k) / 2;
      g.beginPath();
      quad.forEach((c, i) => { const X = ox + c.x * vw * k, Y = oy + c.y * vh * k; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.closePath();
      g.fillStyle = cor === 'verde' ? 'rgba(46,204,113,.30)' : 'rgba(30,120,255,.32)';
      g.fill();
      g.lineWidth = 3; g.lineJoin = 'round';
      g.strokeStyle = cor === 'verde' ? 'rgba(46,204,113,.95)' : 'rgba(80,160,255,.95)';
      g.stroke();
    }

    function _passo() {
      if (!ativo) return;
      try {
        if (!video.videoWidth || video.readyState < 2) return;
        const W = LARG_VIVO, H = Math.max(1, Math.round(video.videoHeight * W / video.videoWidth));
        if (mini.width !== W || mini.height !== H) { mini.width = W; mini.height = H; }
        mctx.drawImage(video, 0, 0, W, H);
        const r = achar(mctx.getImageData(0, 0, W, H).data, W, H);
        if (!r) { ultimo = null; desde = 0; _desenhar(null); _estado('procura'); return; }
        const agora = Date.now();
        const parou = ultimo && r.quad.every((c, i) => Math.hypot(c.x - ultimo[i].x, c.y - ultimo[i].y) < MOVE_MAX);
        if (!parou) { desde = agora; }
        ultimo = r.quad;
        if (r.cortada) { desde = agora; _desenhar(r.quad, 'azul'); _estado('cortada'); return; }
        const firme = parou && agora - desde >= PARADO_MS;
        _desenhar(r.quad, firme ? 'verde' : 'azul');
        _estado(firme ? 'parado' : 'achou');
        if (firme && auto && !disparou && agora >= liberaEm) { disparou = true; try { opts.aoEstabilizar && opts.aoEstabilizar(); } catch (_) {} }
      } catch (_) { /* quadro falhou (vídeo trocando de resolução, memória): tenta no próximo */ }
    }
    /* cadência adaptativa: celular lento gasta mais por quadro; o intervalo cresce com o custo (4× o tempo medido, mínimo
       220 ms) para a câmera e os toques nunca ficarem travados esperando o scanner */
    function _agendar() {
      timer = setTimeout(() => {
        const t0 = performance.now();
        _passo();
        if (ativo) { espera = Math.max(220, Math.min(1500, (performance.now() - t0) * 4)); _agendar(); }
      }, espera);
    }
    let espera = 220;
    _agendar();
    return {
      parar() { ativo = false; clearTimeout(timer); try { const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {} },
      setAutomatico(b) { auto = !!b; },
      /* depois de um disparo que a pessoa recusou (foto borrada): espera um tempo antes de poder disparar sozinho de novo */
      liberar(msEspera = 2500) { disparou = false; desde = Date.now(); ultimo = null; liberaEm = Date.now() + msEspera; },
    };
  }

  /* ── 3. Endireitar ──────────────────────────────────────────
     Homografia: mapeia cada pixel da página de saída (u,v) no quadro de
     origem (x,y). Resolve o sistema 8×8 pelos 4 cantos. */
  function _homografia(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x: u, y: v } = dst[i], { x, y } = src[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    const N = 8;
    for (let c = 0; c < N; c++) {
      let m = c;
      for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
      if (Math.abs(A[m][c]) < 1e-12) return null;
      [A[c], A[m]] = [A[m], A[c]]; [b[c], b[m]] = [b[m], b[c]];
      for (let r = c + 1; r < N; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < N; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = new Array(N);
    for (let r = N - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < N; k++) s -= A[r][k] * h[k];
      h[r] = s / A[r][r];
    }
    return h;
  }

  /* Recorta e endireita `quad` (px do quadro de origem) de src (RGBA, sw×sh) numa página dw×dh. */
  function aplanar(src, sw, sh, quad, dw, dh) {
    const h = _homografia([{ x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: dh }, { x: 0, y: dh }], quad);
    if (!h) return null;
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let v = 0; v < dh; v++) {
      for (let u = 0; u < dw; u++) {
        const w = h[6] * (u + 0.5) + h[7] * (v + 0.5) + 1;
        const x = (h[0] * (u + 0.5) + h[1] * (v + 0.5) + h[2]) / w - 0.5;
        const y = (h[3] * (u + 0.5) + h[4] * (v + 0.5) + h[5]) / w - 0.5;
        const o = (v * dw + u) * 4;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {       // fora da foto (ou na última linha): vizinho mais próximo, ou branco
          const xi = Math.min(sw - 1, Math.max(0, Math.round(x))), yi = Math.min(sh - 1, Math.max(0, Math.round(y))), s = (yi * sw + xi) * 4;
          out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = 255;
          continue;
        }
        const fx = x - x0, fy = y - y0, s = (y0 * sw + x0) * 4, s2 = s + sw * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o]     = src[s]     * w00 + src[s + 4] * w10 + src[s2]     * w01 + src[s2 + 4] * w11;
        out[o + 1] = src[s + 1] * w00 + src[s + 5] * w10 + src[s2 + 1] * w01 + src[s2 + 5] * w11;
        out[o + 2] = src[s + 2] * w00 + src[s + 6] * w10 + src[s2 + 2] * w01 + src[s2 + 6] * w11;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  /* Clareia o papel: estica o brilho para que o papel (a maioria dos pixels) vire quase branco e a tinta continue
     escura. Só quando há folga para esticar; cor e proporção ficam como estão. */
  function clarear(px) {
    const hist = new Uint32Array(256), n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) hist[(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0]++;
    let c = 0, lo = 0, hi = 255, achouLo = false;
    for (let v = 0; v < 256; v++) {
      c += hist[v];
      if (!achouLo && c >= n * 0.01) { lo = v; achouLo = true; }
      if (c >= n * 0.85) { hi = v; break; }
    }
    if (hi - lo < 40 || hi > 250) return;                  // já está claro, ou contraste baixo demais para esticar sem inventar
    const k = 255 / (hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      px[i]     = (px[i]     - lo) * k;
      px[i + 1] = (px[i + 1] - lo) * k;
      px[i + 2] = (px[i + 2] - lo) * k;
    }
  }

  async function _carregar(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (_) {}
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('imagem')); };
      im.src = url;
    });
  }
  const _larg = im => im.naturalWidth || im.width, _alt = im => im.naturalHeight || im.height;

  /* blob (foto) → { blob, endireitou }. Nunca lança: em qualquer dúvida devolve a foto original. */
  async function endireitar(blob) {
    try {
      if (!blob || !/^image\//i.test(blob.type || '')) return { blob, endireitou: false };
      const im = await _carregar(blob);
      const W0 = _larg(im), H0 = _alt(im);
      if (!W0 || !H0) return { blob, endireitou: false };

      const mw = 320, mh = Math.max(1, Math.round(H0 * mw / W0));
      const mini = document.createElement('canvas'); mini.width = mw; mini.height = mh;
      const mg = mini.getContext('2d', { willReadFrequently: true });
      mg.drawImage(im, 0, 0, mw, mh);
      const r = achar(mg.getImageData(0, 0, mw, mh).data, mw, mh);
      // papel cortado pela borda da foto: a página endireitada perderia o que já faltava e ainda daria falsa sensação de nota inteira
      if (!r || r.cortada) { try { im.close && im.close(); } catch (_) {} return { blob, endireitou: false }; }

      // origem: no máximo 4096 px no maior lado (memória de celular modesto; a foto da câmera já vem limitada a isso)
      const k0 = Math.min(1, 4096 / Math.max(W0, H0));
      const sw = Math.round(W0 * k0), sh = Math.round(H0 * k0);
      const orig = document.createElement('canvas'); orig.width = sw; orig.height = sh;
      const og = orig.getContext('2d', { willReadFrequently: true });
      og.drawImage(im, 0, 0, sw, sh);
      try { im.close && im.close(); } catch (_) {}
      const src = og.getImageData(0, 0, sw, sh).data;

      const q = r.quad.map(c => ({ x: c.x * sw, y: c.y * sh }));
      const topo = _dist(q[0], q[1]), base = _dist(q[3], q[2]), esq = _dist(q[0], q[3]), dir = _dist(q[1], q[2]);
      let dw = Math.round((topo + base) / 2), dh = Math.round((esq + dir) / 2);
      const esc = Math.min(1, MAX_SAIDA / Math.max(dw, dh));
      dw = Math.max(1, Math.round(dw * esc)); dh = Math.max(1, Math.round(dh * esc));
      if (dw < 200 || dh < 200) return { blob, endireitou: false };

      const px = aplanar(src, sw, sh, q, dw, dh);
      if (!px) return { blob, endireitou: false };
      clarear(px);
      const cv = document.createElement('canvas'); cv.width = dw; cv.height = dh;
      cv.getContext('2d').putImageData(new ImageData(px, dw, dh), 0, 0);
      const out = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.92));
      if (!out || out.size < 5000) return { blob, endireitou: false };
      return { blob: out, endireitou: true };
    } catch (_) {
      return { blob, endireitou: false };
    }
  }

  return { achar, aoVivo, aplanar, clarear, endireitar, _homografia };
})();
