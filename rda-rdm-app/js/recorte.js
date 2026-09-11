'use strict';
/* ─────────────────────────────────────────────────────────────
   RECORTE.js — enquadra a nota antes do OCR

   O que resolve: o OCR lê a foto inteira, então mesa, mão, chão e a nota
   do lado entram no texto e viram valor/CNPJ errado. Recortando só o
   cupom, o Tesseract trabalha com muito menos ruído.

   ESCOPO: desde o build 111 o recorte É o anexo salvo (em resolução
   original), exceto no fluxo do QR, que guarda a foto inteira. Como o
   anexo é a evidência fiscal, cortar texto é inaceitável — daí a garantia
   de _crescerAtePapel: a sugestão automática já nasce contendo o papel
   inteiro, e o "Usar recorte" confere as bordas antes de salvar; se o
   papel continua para fora, amplia, mostra e pede um segundo toque.

   DETECÇÃO: feita em canvas puro (Otsu + projeção de linhas/colunas), sem
   biblioteca. Um detector de bordas de verdade (OpenCV.js) custaria ~8 MB
   de download num app que roda em campo, e aqui o resultado é só o
   retângulo INICIAL — o usuário ajusta arrastando, então precisão de
   sub-pixel não muda nada.
───────────────────────────────────────────────────────────── */
window.Recorte = (() => {

  const $ = id => document.getElementById(id);

  let _resolver = null;      // resolve da Promise aberta
  let _trabalho = null;      // canvas reduzido: base da detecção e do corte
  let _rect = null;          // { x, y, w, h } em px do palco
  let _caixaImg = null;      // onde a <img> está desenhada dentro do palco
  let _arraste = null;       // { modo, x0, y0, rect0 }
  let _mapa = null;          // análise da foto (cinza + limiar), feita uma vez
  let _conferido = false;    // "Usar recorte" já passou pela garantia de não cortar

  const MIN = 36;            // menor recorte aceitável, em px de tela

  /* Foto de celular tem 12 MP e ler tudo isso duas vezes (detectar + cortar)
     custava ~330 ms. Reduzindo UMA vez e reaproveitando, cai para ~68 ms com
     o mesmo retângulo detectado. 2400 px porque o OCR reduz para 1200 de
     qualquer forma: mesmo um recorte de metade da largura ainda chega lá. */
  const MAX_TRABALHO = 2400;

  function _prepararTrabalho(img) {
    const escala = Math.min(1, MAX_TRABALHO / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth  * escala));
    const h = Math.max(1, Math.round(img.naturalHeight * escala));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }

  /* ── Detecção automática ────────────────────────────────────
     Cupom é papel claro sobre fundo mais escuro. Binariza por Otsu, conta
     pixels claros por linha e por coluna e pega a faixa onde a contagem
     passa de 35% do pico. Devolve frações (0..1) da imagem, ou null se o
     resultado não fizer sentido. */
  function _analisar(img) {
    const W = 400;
    const H = Math.max(1, Math.round(img.height * W / img.width));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);

    const d = ctx.getImageData(0, 0, W, H).data;
    const cinza = new Uint8Array(W * H);
    const hist  = new Uint32Array(256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const g = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0;
      cinza[p] = g; hist[g]++;
    }

    // limiar de Otsu
    const total = W * H;
    let soma = 0;
    for (let t = 0; t < 256; t++) soma += t * hist[t];
    let somaB = 0, pesoB = 0, melhor = -1, limiar = 128;
    for (let t = 0; t < 256; t++) {
      pesoB += hist[t];
      if (!pesoB) continue;
      const pesoF = total - pesoB;
      if (!pesoF) break;
      somaB += t * hist[t];
      const mB = somaB / pesoB, mF = (soma - somaB) / pesoF;
      const entre = pesoB * pesoF * (mB - mF) * (mB - mF);
      if (entre > melhor) { melhor = entre; limiar = t; }
    }
    return { W, H, cinza, limiar };
  }

  function _detectar(mapa) {
    const { W, H, cinza, limiar } = mapa;
    const linhas = new Uint32Array(H), colunas = new Uint32Array(W);
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) {
        if (cinza[base + x] > limiar) { linhas[y]++; colunas[x]++; }
      }
    }

    const faixa = arr => {
      let max = 0;
      for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
      if (!max) return null;
      const corte = max * 0.35;
      let ini = 0, fim = arr.length - 1;
      while (ini < arr.length && arr[ini] < corte) ini++;
      while (fim > ini && arr[fim] < corte) fim--;
      return fim > ini ? [ini, fim] : null;
    };

    const fx = faixa(colunas), fy = faixa(linhas);
    if (!fx || !fy) return null;

    const r = {
      x: fx[0] / W,
      y: fy[0] / H,
      w: (fx[1] - fx[0]) / W,
      h: (fy[1] - fy[0]) / H,
    };

    // área implausível (quase tudo ou quase nada) → não vale a pena sugerir
    const area = r.w * r.h;
    if (area < 0.06 || area > 0.97) return null;
    return r;
  }

  /* ── Garantia de não cortar a nota ──────────────────────────
     Recebe um retângulo em frações (0..1) e devolve outro que contém o
     papel inteiro: cada borda anda para fora enquanto a linha/coluna logo
     além dela ainda for majoritariamente clara (papel continua), até um
     limite de 25% da imagem — se o fundo também é claro, isso vira a foto
     quase inteira, e é o resultado seguro. Por fim, folga de 2,5% para a
     borda do texto não encostar no corte. `mudou` diz se alguma borda andou
     mais que 1% — é o que decide se o usuário precisa ver o ajuste. */
  const PAPEL    = 0.35;  // fração de pixels claros para a faixa contar como papel
  const JANELA   = 8;     // linhas/colunas olhadas de cada vez (texto denso não é borda)
  const MAX_CRESC = 0.25; // quanto cada borda pode andar, em fração da imagem
  const FOLGA    = 0.025;
  function _crescerAtePapel(f, mapa) {
    const { W, H, cinza, limiar } = mapa;
    let x0 = Math.max(0, Math.round(f.x * W));
    let y0 = Math.max(0, Math.round(f.y * H));
    let x1 = Math.min(W, Math.round((f.x + f.w) * W));
    let y1 = Math.min(H, Math.round((f.y + f.h) * H));
    const orig = { x0, y0, x1, y1 };

    /* Média de pixels claros numa janela de linhas [ya, yb) × colunas [a, b).
       Uma linha só engana: texto denso ou uma dobra escura parecem "fim do
       papel". Oito linhas juntas não. */
    const faixaClara = (ya, yb, a, b) => {
      ya = Math.max(0, ya); yb = Math.min(H, yb);
      if (yb <= ya || b <= a) return false;
      let n = 0;
      for (let y = ya; y < yb; y++) {
        const base = y * W;
        for (let x = a; x < b; x++) if (cinza[base + x] > limiar) n++;
      }
      return n >= (yb - ya) * (b - a) * PAPEL;
    };
    const colunaClara = (xa, xb, a, b) => {
      xa = Math.max(0, xa); xb = Math.min(W, xb);
      if (xb <= xa || b <= a) return false;
      let n = 0;
      for (let y = a; y < b; y++) {
        const base = y * W;
        for (let x = xa; x < xb; x++) if (cinza[base + x] > limiar) n++;
      }
      return n >= (xb - xa) * (b - a) * PAPEL;
    };

    const limY = Math.round(H * MAX_CRESC), limX = Math.round(W * MAX_CRESC);
    while (y0 > 0 && orig.y0 - y0 < limY && faixaClara(y0 - JANELA, y0, x0, x1)) y0--;
    while (y1 < H && y1 - orig.y1 < limY && faixaClara(y1, y1 + JANELA, x0, x1)) y1++;
    while (x0 > 0 && orig.x0 - x0 < limX && colunaClara(x0 - JANELA, x0, y0, y1)) x0--;
    while (x1 < W && x1 - orig.x1 < limX && colunaClara(x1, x1 + JANELA, y0, y1)) x1++;

    /* Folga só na borda que encosta no papel (a faixa logo por dentro é
       clara). Borda que já está sobre o fundo não precisa — e somar folga
       nela fazia um recorte já largo contar como "ajustado". */
    const fx = (x1 - x0) * FOLGA, fy = (y1 - y0) * FOLGA;
    const fTop = faixaClara(y0, y0 + JANELA, x0, x1) ? fy : 0;
    const fBot = faixaClara(y1 - JANELA, y1, x0, x1) ? fy : 0;
    const fEsq = colunaClara(x0, x0 + JANELA, y0, y1) ? fx : 0;
    const fDir = colunaClara(x1 - JANELA, x1, y0, y1) ? fx : 0;

    const r = {
      x: Math.max(0, (x0 - fEsq) / W),
      y: Math.max(0, (y0 - fTop) / H),
    };
    r.w = Math.min(1 - r.x, (x1 + fDir) / W - r.x);
    r.h = Math.min(1 - r.y, (y1 + fBot) / H - r.y);

    const mudou = Math.abs(r.x - f.x) > 0.01 || Math.abs(r.y - f.y) > 0.01
               || Math.abs(r.x + r.w - f.x - f.w) > 0.01
               || Math.abs(r.y + r.h - f.y - f.h) > 0.01;
    return { rect: r, mudou };
  }

  /* ── Geometria do palco ─────────────────────────────────── */
  /* Retângulo em frações (0..1) da imagem ↔ px do palco */
  function _fracoes() {
    const c = _caixaImg;
    return { x: (_rect.x - c.x) / c.w, y: (_rect.y - c.y) / c.h, w: _rect.w / c.w, h: _rect.h / c.h };
  }
  function _deFracoes(f) {
    const c = _caixaImg;
    return { x: c.x + f.x * c.w, y: c.y + f.y * c.h, w: f.w * c.w, h: f.h * c.h };
  }

  function _medirImagem() {
    const palco = $('crop-palco').getBoundingClientRect();
    const img   = $('crop-img').getBoundingClientRect();
    _caixaImg = {
      x: img.left - palco.left,
      y: img.top  - palco.top,
      w: img.width,
      h: img.height,
    };
  }

  function _aplicarRect() {
    const el = $('crop-rect');
    el.style.left   = _rect.x + 'px';
    el.style.top    = _rect.y + 'px';
    el.style.width  = _rect.w + 'px';
    el.style.height = _rect.h + 'px';
  }

  function _limitar(r) {
    const c = _caixaImg;
    r.w = Math.max(MIN, Math.min(r.w, c.w));
    r.h = Math.max(MIN, Math.min(r.h, c.h));
    r.x = Math.max(c.x, Math.min(r.x, c.x + c.w - r.w));
    r.y = Math.max(c.y, Math.min(r.y, c.y + c.h - r.h));
    return r;
  }

  /* ── Arraste (mouse e toque, via pointer events) ────────── */
  function _aoPressionar(e) {
    const modo = e.target.dataset?.alca || 'mover';
    _arraste = { modo, x0: e.clientX, y0: e.clientY, rect0: { ..._rect } };
    e.target.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function _aoMover(e) {
    if (!_arraste) return;
    const dx = e.clientX - _arraste.x0, dy = e.clientY - _arraste.y0;
    const r0 = _arraste.rect0;
    const c  = _caixaImg;
    let r;
    if (_arraste.modo === 'mover') {
      r = { x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h };
    } else {
      // cada alça move dois lados; os outros dois ficam ancorados
      const oeste = _arraste.modo.includes('w'), norte = _arraste.modo.includes('n');
      const dirX = oeste ? r0.x + r0.w : r0.x;          // borda ancorada em x
      const dirY = norte ? r0.y + r0.h : r0.y;          // borda ancorada em y
      let nx = oeste ? r0.x + dx : dirX;
      let ny = norte ? r0.y + dy : dirY;
      nx = Math.max(c.x, Math.min(nx, c.x + c.w));
      ny = Math.max(c.y, Math.min(ny, c.y + c.h));
      let nw = oeste ? dirX - nx : (r0.x + r0.w + dx) - dirX;
      let nh = norte ? dirY - ny : (r0.y + r0.h + dy) - dirY;
      if (nw < MIN) { nw = MIN; if (oeste) nx = dirX - MIN; }
      if (nh < MIN) { nh = MIN; if (norte) ny = dirY - MIN; }
      if (!oeste) nw = Math.min(nw, c.x + c.w - nx);
      if (!norte) nh = Math.min(nh, c.y + c.h - ny);
      r = { x: nx, y: ny, w: nw, h: nh };
    }
    _rect = _limitar(r);
    _aplicarRect();
    e.preventDefault();
  }

  function _aoSoltar() { _arraste = null; }

  /* ── Recorte final, na resolução original ───────────────── */
  /* Corta da <img> ORIGINAL, em resolução total: o recorte agora vira o
     anexo salvo, não só a entrada do OCR. Do canvas reduzido sairia uma foto
     de 2400 px, e comprovante fiscal não pode perder definição.
     Limita a 3000 px na maior dimensão — acima disso o ganho é nulo e um
     celular modesto pode não ter memória para o canvas. O canvas reduzido
     (_trabalho) continua servindo à detecção automática, que é onde o custo
     importa. */
  const MAX_ANEXO = 3000;
  function _cortar() {
    const c = _caixaImg;
    const fx = (_rect.x - c.x) / c.w;
    const fy = (_rect.y - c.y) / c.h;
    const fw = _rect.w / c.w;
    const fh = _rect.h / c.h;

    const img = $('crop-img');
    const W = img.naturalWidth, H = img.naturalHeight;
    const sx = Math.round(fx * W);
    const sy = Math.round(fy * H);
    const sw = Math.max(1, Math.round(fw * W));
    const sh = Math.max(1, Math.round(fh * H));

    const escala = Math.min(1, MAX_ANEXO / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * escala));
    const dh = Math.max(1, Math.round(sh * escala));

    const cv = document.createElement('canvas');
    cv.width = dw; cv.height = dh;
    cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    return new Promise(res => cv.toBlob(b => res(b), 'image/jpeg', 0.92));
  }

  function _fechar(valor) {
    $('crop-overlay').style.display = 'none';
    const url = $('crop-img').dataset.url;
    if (url) { try { URL.revokeObjectURL(url); } catch (_) {} }
    $('crop-img').src = ''; delete $('crop-img').dataset.url;
    _trabalho = null;                       // libera o canvas reduzido
    _mapa = null;
    const r = _resolver; _resolver = null;
    if (r) r(valor);
  }

  let _ligado = false;
  function _ligarEventos() {
    if (_ligado) return;
    _ligado = true;
    const rect = $('crop-rect');
    rect.addEventListener('pointerdown', _aoPressionar);
    rect.querySelectorAll('.crop-alca').forEach(a =>
      a.addEventListener('pointerdown', _aoPressionar));
    window.addEventListener('pointermove', _aoMover);
    window.addEventListener('pointerup',   _aoSoltar);
    window.addEventListener('pointercancel', _aoSoltar);
    $('crop-usar').addEventListener('click', async () => {
      /* Antes de salvar, confere se o papel continua para fora do
         retângulo. Se continuar, amplia, mostra e espera um segundo toque —
         o usuário vê o que vai ser salvo. Uma vez por foto: se ele encolher
         de propósito depois disso (nota vizinha, por exemplo), vale o dele. */
      if (!_conferido && _mapa) {
        _conferido = true;
        let ajuste = null;
        try { ajuste = _crescerAtePapel(_fracoes(), _mapa); } catch (_) {}
        if (ajuste?.mudou) {
          _rect = _limitar(_deFracoes(ajuste.rect));
          _aplicarRect();
          $('crop-dica').textContent = 'Ampliei para não cortar a nota — confira e toque em Usar recorte de novo';
          return;
        }
      }
      let out = null;
      try { out = await _cortar(); } catch (_) {}
      _fechar(out);
    });
    $('crop-inteira').addEventListener('click', () => _fechar(null));
    window.addEventListener('resize', () => {
      if ($('crop-overlay').style.display !== 'flex') return;
      _medirImagem(); _rect = _limitar(_rect); _aplicarRect();
    });
  }

  /* ── API ─────────────────────────────────────────────────
     abrir(blob) → Promise<Blob|null>
       Blob → usuário confirmou o recorte
       null → "Foto inteira", falha de carregamento, ou tipo não-imagem */
  async function abrir(blob) {
    if (!blob || !/^image\//i.test(blob.type || '')) return null;
    if (!$('crop-overlay')) return null;          // markup ausente → segue sem recorte
    _ligarEventos();

    const url = URL.createObjectURL(blob);
    const img = $('crop-img');
    img.dataset.url = url;

    const carregou = await new Promise(res => {
      img.onload  = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    if (!carregou) { try { URL.revokeObjectURL(url); } catch (_) {} return null; }

    _trabalho = _prepararTrabalho(img);
    _mapa = null; _conferido = false;
    try { _mapa = _analisar(_trabalho); } catch (_) {}
    $('crop-overlay').style.display = 'flex';

    /* Medir direto: getBoundingClientRect força o layout, então logo após
       trocar o display o tamanho já é o real. NÃO usar requestAnimationFrame
       aqui — ele não dispara com a aba em segundo plano, e a tela de recorte
       ficaria travada se o usuário trocasse de app no meio. */
    _medirImagem();

    /* A sugestão já nasce crescida até a borda do papel: a projeção corta
       onde o papel fica estreito (sombra, canto enrolado), e o texto do
       topo ou do rodapé ficava de fora. */
    let sugestao = null;
    try {
      sugestao = _mapa && _detectar(_mapa);
      if (sugestao) sugestao = _crescerAtePapel(sugestao, _mapa).rect;
    } catch (_) { sugestao = null; }
    const f = sugestao || { x: 0.05, y: 0.05, w: 0.90, h: 0.90 };
    _rect = _limitar(_deFracoes(f));
    _aplicarRect();
    $('crop-dica').textContent = sugestao
      ? 'Enquadrei a nota — arraste os cantos para ajustar'
      : 'Arraste os cantos para enquadrar a nota';

    return new Promise(res => { _resolver = res; });
  }

  return { abrir, _detectar, _analisar, _crescerAtePapel };
})();
