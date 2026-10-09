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
  let _origem = null;        // 'papel' | 'texto' | null — qual detector enquadrou (a garantia usa a mesma régua)
  let _alvo = null;          // o que o recorte não deve cortar sem avisar (px do mapa): o papel ou o miolo de texto

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
    const croma = new Uint8Array(W * H);          // máx−mín dos canais: papel/tinta são neutros, tecido colorido não
    const hist  = new Uint32Array(256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const g = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0;
      cinza[p] = g; hist[g]++;
      const mx = d[i] > d[i+1] ? (d[i] > d[i+2] ? d[i] : d[i+2]) : (d[i+1] > d[i+2] ? d[i+1] : d[i+2]);
      const mn = d[i] < d[i+1] ? (d[i] < d[i+2] ? d[i] : d[i+2]) : (d[i+1] < d[i+2] ? d[i+1] : d[i+2]);
      croma[p] = mx - mn;
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
    return { W, H, cinza, croma, hist, limiar };
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

  /* ── Detecção pelo TEXTO (01/10/2026) ───────────────────────
     O detector antigo achava o papel pelo CLARO contra o ESCURO (Otsu). Com
     fundo também claro — tecido, madeira clara, outra folha — o fundo entrava
     como papel: a caixa nascia larga demais nos lados, e a sombra no pé da
     nota cortava o rodapé. Caso real: cupom sobre lençol azul-acinzentado.

     Agora a âncora é o que só a nota tem: TEXTO. Bordas fortes e densas
     (letra, QR) formam o miolo; a partir dele, cada lado procura a borda do
     papel — o maior degrau de brilho (claro por dentro, mais escuro por
     fora) até 25% da foto adiante. Sombra e fundo claro deixam de enganar
     porque se mede o DEGRAU, não "ser claro". Se não há degrau (papel branco
     sobre mesa branca), fica o miolo de texto com folga. */
  const STEP_MIN  = 14;    // degrau mínimo de brilho (0..255) para contar como borda do papel
  const BANDA     = 6;     // largura (px do mapa) das faixas comparadas de cada lado da borda
  const FOLGA_TXT = 0.03;  // folga em volta do miolo de texto, fração do tamanho dele

  /* Estende [ay, by] para cima/baixo enquanto houver texto de contraste
     RELATIVO ao brilho local dentro das colunas [ax, bx]. Devolve [ay, by]. */
  function _estenderLinhas(mapa, ax, bx, ay, by) {
    const { W, H, cinza } = mapa;
    const R = 4;
    /* 2ª camada: contraste RELATIVO ao brilho local (borda ÷ brilho médio).
       Texto na sombra tem borda fraca em valor absoluto, mas proporcional ao
       fundo dele igual ao texto iluminado — era o rodapé do cupom, em sombra,
       que ficava de fora. Só estende para cima/baixo e só dentro das colunas
       do miolo, para o tecido dos lados não entrar. */
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = 0; x < W; x++) { s += cinza[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; }
    }
    const media = (x, y, r) => {
      const a = Math.max(0, x - r), b = Math.min(W, x + r + 1), c = Math.max(0, y - r), d = Math.min(H, y + r + 1);
      return (I[d * (W + 1) + b] - I[c * (W + 1) + b] - I[d * (W + 1) + a] + I[c * (W + 1) + a]) / ((b - a) * (d - c));
    };
    const S2 = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let linha = 0;
      for (let x = 0; x < W; x++) {
        if (y > 0 && y < H - 1 && x > 0 && x < W - 1) {
          const i = y * W + x;
          const gx = Math.abs(cinza[i + 1] - cinza[i - 1]), gy = Math.abs(cinza[i + W] - cinza[i - W]);
          if ((gx > gy ? gx : gy) / (media(x, y, 7) + 20) > 0.28) linha++;
        }
        S2[(y + 1) * (W + 1) + x + 1] = S2[y * (W + 1) + x + 1] + linha;
      }
    }
    const massa = y => {
      let c = 0;
      for (let x = Math.max(R, ax); x < Math.min(W - R, bx + 1); x++) {
        const n = S2[(y + R + 1) * (W + 1) + x + R + 1] - S2[(y - R) * (W + 1) + x + R + 1]
                - S2[(y + R + 1) * (W + 1) + x - R] + S2[(y - R) * (W + 1) + x - R];
        if (n >= 16) c++;
      }
      return c;
    };
    const minMassa = Math.max(4, (bx - ax) * 0.06), folgaLinhas = Math.round(H * 0.06), maxExt = Math.round(H * MAX_CRESC);
    const by0 = by, ay0 = ay;
    let gap = 0;
    for (let y = by0 + 1; y < H - R && y - by0 <= maxExt; y++) {
      if (massa(y) >= minMassa) { by = y; gap = 0; } else if (++gap > folgaLinhas) break;
    }
    gap = 0;
    for (let y = ay0 - 1; y >= R && ay0 - y <= maxExt; y--) {
      if (massa(y) >= minMassa) { ay = y; gap = 0; } else if (++gap > folgaLinhas) break;
    }
    return [ay, by];
  }

  function _limiteTexto(mapa) {
    const { W, H, cinza } = mapa;
    const E = new Uint8Array(W * H);
    const hist = new Uint32Array(256);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = Math.abs(cinza[i + 1] - cinza[i - 1]);
        const gy = Math.abs(cinza[i + W] - cinza[i - W]);
        const e = Math.min(255, gx > gy ? gx : gy);
        E[i] = e; hist[e]++;
      }
    }
    // limiar relativo à força do texto da própria foto (p99), com piso
    const alvo = (W - 2) * (H - 2) * 0.99;
    let acum = 0, p99 = 0;
    for (let v = 0; v < 256; v++) { acum += hist[v]; if (acum >= alvo) { p99 = v; break; } }
    const T = Math.max(32, Math.round(p99 * 0.5));

    // densidade de bordas fortes em janelas 9×9 (imagem integral)
    const S = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let linha = 0;
      for (let x = 0; x < W; x++) {
        if (E[y * W + x] > T) linha++;
        S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + linha;
      }
    }
    const R = 4;
    const cols = new Uint32Array(W), rows = new Uint32Array(H);
    let total = 0;
    for (let y = R; y < H - R; y++) {
      for (let x = R; x < W - R; x++) {
        const n = S[(y + R + 1) * (W + 1) + x + R + 1] - S[(y - R) * (W + 1) + x + R + 1]
                - S[(y + R + 1) * (W + 1) + x - R] + S[(y - R) * (W + 1) + x - R];
        if (n >= 16) { cols[x]++; rows[y]++; total++; }   // ≥ ~20% da janela
      }
    }
    if (total < W * H * 0.004) return null;               // quase sem texto: não dá para ancorar

    const faixa = (arr, lo, hi) => {
      let soma = 0; for (let i = 0; i < arr.length; i++) soma += arr[i];
      let c = 0, a = 0, b = arr.length - 1, achouA = false;
      for (let i = 0; i < arr.length; i++) {
        c += arr[i];
        if (!achouA && c >= soma * lo) { a = i; achouA = true; }
        if (c >= soma * hi) { b = i; break; }
      }
      return [a, b];
    };
    const [ax, bx] = faixa(cols, 0.005, 0.995);
    let [ay, by] = faixa(rows, 0.005, 0.995);
    if (bx - ax < W * 0.08 || by - ay < H * 0.08) return null;

    [ay, by] = _estenderLinhas(mapa, ax, bx, ay, by);
    return { x0: ax, y0: ay, x1: bx + 1, y1: by + 1 };
  }

  /* ── Detecção do PAPEL por brilho e cor (01/10/2026) ───────
     Segundo caso real: cupom branco sobre tecido azul com manchas claras. O
     tecido tem bordas tão fortes quanto o texto, então "achar o texto" pegava
     o tecido. O que distingue o papel é ser a região MAIS CLARA e NEUTRA da
     foto. Dois níveis de Otsu: o 1º separa o escuro; se o que sobra ainda
     mistura dois grupos bem distintos (tecido médio × papel claro), o 2º
     separa de novo. Ficam os pixels acima do limiar e pouco coloridos, uma
     erosão solta pontes finas, e o maior bloco conectado é o papel. */
  const CROMA_MAX = 55;
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
      const entre = pesoB * pesoF * (mB - mF) * (mB - mF);
      if (entre > melhor) { melhor = entre; limiar = t; }
    }
    return limiar;
  }

  function _papelPorCor(mapa) {
    const { W, H, cinza, croma, hist, limiar } = mapa;
    // 2º nível: só vale se o que está acima do 1º limiar são dois grupos distintos
    const t2 = _otsu(hist, limiar + 1);
    let nLo = 0, sLo = 0, nHi = 0, sHi = 0;
    for (let v = limiar + 1; v < 256; v++) {
      if (v <= t2) { nLo += hist[v]; sLo += v * hist[v]; } else { nHi += hist[v]; sHi += v * hist[v]; }
    }
    const nAcima = nLo + nHi;
    const separa = nLo > 0 && nHi > 0 && (sHi / nHi - sLo / nLo) >= 30 && Math.min(nLo, nHi) / nAcima >= 0.12;
    const thr = separa ? t2 : limiar;

    const M = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) M[p] = (cinza[p] > thr && croma[p] < CROMA_MAX) ? 1 : 0;

    // erosão 5×5 (imagem integral): solta pontes finas entre o papel e manchas claras
    const S = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let linha = 0;
      for (let x = 0; x < W; x++) { linha += M[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + linha; }
    }
    const R = 2, janela = (2 * R + 1) * (2 * R + 1);
    const E = new Uint8Array(W * H);
    for (let y = R; y < H - R; y++) {
      for (let x = R; x < W - R; x++) {
        const n = S[(y + R + 1) * (W + 1) + x + R + 1] - S[(y - R) * (W + 1) + x + R + 1]
                - S[(y + R + 1) * (W + 1) + x - R] + S[(y - R) * (W + 1) + x - R];
        if (n === janela) E[y * W + x] = 1;
      }
    }

    // maior componente conectado (8 vizinhos)
    const rot = new Int32Array(W * H);
    const pilha = new Int32Array(W * H);
    let melhorN = 0, melhorId = 0, id = 0;
    for (let p0 = 0; p0 < W * H; p0++) {
      if (!E[p0] || rot[p0]) continue;
      id++;
      let topo = 0, n = 0;
      pilha[topo++] = p0; rot[p0] = id;
      while (topo) {
        const p = pilha[--topo]; n++;
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
      if (n > melhorN) { melhorN = n; melhorId = id; }
    }
    if (!melhorId || melhorN < W * H * 0.04) return null;

    const cols = new Uint32Array(W), rows = new Uint32Array(H);
    for (let p = 0; p < W * H; p++) if (rot[p] === melhorId) { cols[p % W]++; rows[(p / W) | 0]++; }
    const faixa = (arr, lo, hi) => {
      let soma = 0; for (let i = 0; i < arr.length; i++) soma += arr[i];
      let c = 0, a = 0, b = arr.length - 1, achou = false;
      for (let i = 0; i < arr.length; i++) {
        c += arr[i];
        if (!achou && c >= soma * lo) { a = i; achou = true; }
        if (c >= soma * hi) { b = i; break; }
      }
      return [a, b];
    };
    const [ax, bx] = faixa(cols, 0.005, 0.995), [ay, by] = faixa(rows, 0.005, 0.995);
    // desfaz a erosão (R de cada lado)
    const r = { x0: Math.max(0, ax - R), y0: Math.max(0, ay - R), x1: Math.min(W, bx + R + 1), y1: Math.min(H, by + R + 1) };
    const area = (r.x1 - r.x0) * (r.y1 - r.y0) / (W * H);
    // quase a foto toda = o "papel" é o fundo (mesa branca): não serve de âncora
    return area < 0.06 || area > 0.93 ? null : r;
  }

  /* Brilho do papel: percentil 80 do cinza dentro do miolo (o texto escuro
     fica abaixo, o papel claro em cima). */
  function _brilhoPapel(mapa, r) {
    const { W, cinza } = mapa;
    const h = new Uint32Array(256); let n = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { h[cinza[y * W + x]]++; n++; }
    let c = 0;
    for (let v = 0; v < 256; v++) { c += h[v]; if (c >= n * 0.8) return v; }
    return 255;
  }

  /* Perfil de brilho (mediana) ao longo de um eixo, só na faixa [ini, fim)
     do outro eixo — a mediana ignora texto, QR e dobras. horizontal=true
     devolve um valor por COLUNA (acha bordas esquerda/direita), com as
     linhas ini..fim; false devolve um por LINHA, com as colunas ini..fim. */
  function _perfil(mapa, horizontal, ini, fim) {
    const { W, H, cinza } = mapa;
    const n = horizontal ? W : H;
    const out = new Float32Array(n);
    const passo = Math.max(1, Math.floor((fim - ini) / 48));
    const buf = [];
    for (let k = 0; k < n; k++) {
      buf.length = 0;
      for (let t = ini; t < fim; t += passo) buf.push(horizontal ? cinza[t * W + k] : cinza[k * W + t]);
      buf.sort((p, q) => p - q);
      out[k] = buf.length ? buf[buf.length >> 1] : 0;
    }
    return out;
  }

  /* Procura a borda do papel andando da posição `pos` para fora (dir = -1
     esquerda/cima, +1 direita/baixo), até `lim` posições. Devolve a posição
     da borda, ou null se não há degrau convincente. */
  function _acharBorda(prof, pos, dir, lim, P) {
    const n = prof.length;
    const media = (a, b) => {
      let s = 0, c = 0;
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) { s += prof[i]; c++; }
      return c ? s / c : 0;
    };
    let melhor = null, melhorStep = Math.max(STEP_MIN, P * 0.10);
    for (let d = 0; d <= lim; d++) {
      const b = pos + dir * d;                           // candidata: 1ª posição FORA do papel
      if (b < BANDA || b > n - BANDA) break;
      const dentro = dir < 0 ? media(b + 1, b + 1 + BANDA) : media(b - BANDA, b);
      const fora   = dir < 0 ? media(b - BANDA, b)         : media(b + 1, b + 1 + BANDA);
      const step = dentro - fora;
      // por dentro tem que ser PAPEL (tão claro quanto o miolo): um degrau
      // tecido→sombra/vinheta da foto não é borda de papel
      if (step > melhorStep && dentro >= P * 0.85) { melhorStep = step; melhor = b; }
    }
    return melhor;
  }

  /* Anda cada lado do retângulo (px do mapa) até a borda do papel, quando
     ela existe e fica mais longe que o lado atual. Se o papel segue até a
     borda da FOTO (cupom cortado pelo enquadramento), vai até lá. */
  function _expandirAoPapel(r, mapa) {
    const { W, H } = mapa;
    const P = _brilhoPapel(mapa, r);
    const limX = Math.round(W * MAX_CRESC), limY = Math.round(H * MAX_CRESC);
    const out = { ...r };
    const alt = r.y1 - r.y0, larg = r.x1 - r.x0;
    // esquerda/direita: perfil por coluna nas linhas centrais; cima/baixo: por linha nas colunas centrais
    const yA = r.y0 + Math.round(alt * 0.1), yB = r.y1 - Math.round(alt * 0.1);
    const xA = r.x0 + Math.round(larg * 0.1), xB = r.x1 - Math.round(larg * 0.1);
    const pc = _perfil(mapa, true,  yA, Math.max(yA + 1, yB));
    const pl = _perfil(mapa, false, xA, Math.max(xA + 1, xB));

    const tentar = (prof, pos, dir, lim, limite) => {
      const b = _acharBorda(prof, pos, dir, lim, P);
      if (b !== null) return b;
      // sem degrau: o papel segue até a borda da foto? (faixa inteira ainda clara)
      if (Math.abs(limite - pos) > lim) return null;
      let s = 0, c = 0;
      for (let i = Math.min(pos, limite); i < Math.max(pos, limite); i++) { s += prof[Math.min(i, prof.length - 1)]; c++; }
      return c && s / c >= P * 0.88 ? limite : null;
    };
    const bE = tentar(pc, r.x0, -1, limX, 0), bD = tentar(pc, r.x1, +1, limX, W);
    const bC = tentar(pl, r.y0, -1, limY, 0), bB = tentar(pl, r.y1, +1, limY, H);
    if (bE !== null && bE < r.x0) out.x0 = bE;
    if (bD !== null && bD > r.x1) out.x1 = bD;
    if (bC !== null && bC < r.y0) out.y0 = bC;
    if (bB !== null && bB > r.y1) out.y1 = bB;
    return out;
  }

  /* Sugestão inicial. 1º o papel por brilho e cor (+ texto na sombra abaixo
     dele); sem isso, o miolo de texto + folga + borda do papel; sem texto, o
     detector antigo. Devolve { f (frações 0..1), origem, alvo (px do mapa:
     o que o recorte não deve cortar) } ou null. */
  function _sugerir(mapa) {
    const { W, H } = mapa;
    const fr = r => ({ x: r.x0 / W, y: r.y0 / H, w: (r.x1 - r.x0) / W, h: (r.y1 - r.y0) / H });
    const respiro = r => {
      const rx = Math.round(W * 0.01), ry = Math.round(H * 0.01);
      return { x0: Math.max(0, r.x0 - rx), y0: Math.max(0, r.y0 - ry), x1: Math.min(W, r.x1 + rx), y1: Math.min(H, r.y1 + ry) };
    };
    const pc = _papelPorCor(mapa);
    if (pc) {
      // texto na sombra do pé (ou do topo) da nota: papel escuro demais para o limiar de brilho
      const [ay, by] = _estenderLinhas(mapa, pc.x0, pc.x1 - 1, pc.y0, pc.y1 - 1);
      // se o texto passou do papel claro (sombra), as últimas linhas costumam ser fracas: folga extra
      const extra = Math.round(H * 0.03);
      const alvo = respiro({ x0: pc.x0, y0: ay < pc.y0 ? Math.max(0, ay - extra) : ay,
                             x1: pc.x1, y1: by > pc.y1 - 1 ? Math.min(H, by + 1 + extra) : by + 1 });
      return { f: fr(alvo), origem: 'papel', alvo };
    }
    const t = _limiteTexto(mapa);
    const ft = t && _sugerirPorTexto(mapa, t);
    if (ft) {
      const fx = Math.round((t.x1 - t.x0) * FOLGA_TXT), fy = Math.round((t.y1 - t.y0) * FOLGA_TXT);
      return { f: ft, origem: 'texto', alvo: { x0: Math.max(0, t.x0 - fx), y0: Math.max(0, t.y0 - fy), x1: Math.min(W, t.x1 + fx), y1: Math.min(H, t.y1 + fy) } };
    }
    return null;
  }

  /* Sugestão por texto: miolo de texto + folga + borda do papel. Devolve
     frações 0..1, ou null (sem texto suficiente → cai no detector antigo). */
  function _sugerirPorTexto(mapa, pronto) {
    const t = pronto || _limiteTexto(mapa);
    if (!t) return null;
    const { W, H } = mapa;
    const fx = Math.round((t.x1 - t.x0) * FOLGA_TXT), fy = Math.round((t.y1 - t.y0) * FOLGA_TXT);
    let r = { x0: Math.max(0, t.x0 - fx), y0: Math.max(0, t.y0 - fy), x1: Math.min(W, t.x1 + fx), y1: Math.min(H, t.y1 + fy) };
    r = _expandirAoPapel(r, mapa);
    // respiro de 1% além da borda achada: a borda do papel não encosta no corte
    const rx = Math.round(W * 0.01), ry = Math.round(H * 0.01);
    r = { x0: Math.max(0, r.x0 - rx), y0: Math.max(0, r.y0 - ry), x1: Math.min(W, r.x1 + rx), y1: Math.min(H, r.y1 + ry) };
    const f = { x: r.x0 / W, y: r.y0 / H, w: (r.x1 - r.x0) / W, h: (r.y1 - r.y0) / H };
    return f.w * f.h < 0.04 ? null : f;
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

  /* Garantia do "Usar recorte" na régua nova: se o papel continua além de
     algum lado (degrau de brilho mais adiante), amplia até ele. */
  function _conferirPapel(f, mapa) {
    const { W, H } = mapa;
    const r = { x0: Math.round(f.x * W), y0: Math.round(f.y * H), x1: Math.round((f.x + f.w) * W), y1: Math.round((f.y + f.h) * H) };
    const e = _origem === 'papel' ? { ...r } : _expandirAoPapel(r, mapa);
    /* o que a detecção achou (papel ou texto) e ficou de fora do retângulo
       conta como "continua": sombra no pé da nota esconde a borda, não o texto */
    if (_alvo) {
      e.x0 = Math.min(e.x0, _alvo.x0); e.y0 = Math.min(e.y0, _alvo.y0);
      e.x1 = Math.max(e.x1, _alvo.x1); e.y1 = Math.max(e.y1, _alvo.y1);
    }
    const rx = Math.round(W * 0.01), ry = Math.round(H * 0.01);
    const cresceu = (a, b) => a !== b;
    const mudou = cresceu(e.x0, r.x0) || cresceu(e.y0, r.y0) || cresceu(e.x1, r.x1) || cresceu(e.y1, r.y1);
    const g = { x0: Math.max(0, e.x0 - (e.x0 !== r.x0 ? rx : 0)), y0: Math.max(0, e.y0 - (e.y0 !== r.y0 ? ry : 0)),
                x1: Math.min(W, e.x1 + (e.x1 !== r.x1 ? rx : 0)), y1: Math.min(H, e.y1 + (e.y1 !== r.y1 ? ry : 0)) };
    const rect = { x: g.x0 / W, y: g.y0 / H, w: (g.x1 - g.x0) / W, h: (g.y1 - g.y0) / H };
    const grande = Math.abs(rect.x - f.x) > 0.01 || Math.abs(rect.y - f.y) > 0.01
                || Math.abs(rect.x + rect.w - f.x - f.w) > 0.01 || Math.abs(rect.y + rect.h - f.y - f.h) > 0.01;
    return { rect, mudou: mudou && grande };
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
  function _cortar(maxAnexo = MAX_ANEXO) {
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

    const escala = Math.min(1, maxAnexo / Math.max(sw, sh));
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
        try { ajuste = _origem ? _conferirPapel(_fracoes(), _mapa) : _crescerAtePapel(_fracoes(), _mapa); } catch (_) {}
        if (ajuste?.mudou) {
          _rect = _limitar(_deFracoes(ajuste.rect));
          _aplicarRect();
          $('crop-dica').textContent = 'Ampliei para não cortar a nota — confira e toque em Usar recorte de novo';
          return;
        }
      }
      /* 01/10/2026: se o corte falhava (canvas sem memória no celular,
         toBlob vazio), `out` ficava null e a foto ORIGINAL era salva sem
         avisar — a pessoa achava que tinha recortado. Agora tenta de novo em
         resolução menor (o motivo mais comum é memória) e, se ainda assim
         não sair, avisa e deixa a tela aberta: ou tenta de novo, ou escolhe
         "Foto inteira" sabendo o que está fazendo. */
      let out = null;
      for (const max of [MAX_ANEXO, 2000, 1400]) {
        try { out = await _cortar(max); } catch (_) { out = null; }
        if (out && out.size > 1000) break;
        out = null;
      }
      if (!out) {
        $('crop-dica').textContent = '⚠️ Não consegui recortar esta foto. Toque em Usar recorte de novo ou em Foto inteira para salvar sem recorte.';
        if (typeof toast === 'function') toast('Não consegui recortar a foto — tente de novo ou use "Foto inteira"', 'err');
        return;
      }
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
  async function abrir(blob, opts = {}) {
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
    _mapa = null; _conferido = !!opts.odometro;   // odômetro: não é papel, sem a garantia de "não cortar a nota"
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
    _origem = null; _alvo = null;
    let detalhe = null;
    /* rosto (foto de perfil) não tem papel nem texto: usa só o detector antigo */
    if (!opts.semTexto && !opts.odometro) {
      try {
        detalhe = _mapa && _sugerir(_mapa);
        if (detalhe) { sugestao = detalhe.f; _origem = detalhe.origem; _alvo = detalhe.alvo; }
      } catch (_) { sugestao = null; }
    }
    if (!sugestao && !opts.odometro) {     // sem texto suficiente: o detector antigo (claro × escuro)
      try {
        sugestao = _mapa && _detectar(_mapa);
        if (sugestao) sugestao = _crescerAtePapel(sugestao, _mapa).rect;
      } catch (_) { sugestao = null; }
    }
    /* odômetro (09/10/2026): caixa larga e baixa no meio da foto — o número é
       uma faixa estreita, e o colaborador só ajusta em volta dele */
    const f = sugestao || (opts.odometro ? { x: 0.12, y: 0.36, w: 0.76, h: 0.28 } : { x: 0.05, y: 0.05, w: 0.90, h: 0.90 });
    _rect = _limitar(_deFracoes(f));
    _aplicarRect();
    /* o texto diz QUAL detector enquadrou — facilita conferir em campo se o
       aparelho está com a versão nova e o que ele fez com a foto */
    $('crop-dica').textContent = opts.odometro ? 'Ajuste a caixa só em volta do número do odômetro'
      : sugestao
      ? (_origem === 'papel' ? 'Enquadrei a nota pelo papel — arraste os cantos para ajustar'
        : _origem === 'texto' ? 'Enquadrei a nota pelo texto — arraste os cantos para ajustar'
        : 'Enquadrei a nota (modo simples) — arraste os cantos para ajustar')
      : 'Não achei a nota — arraste os cantos para enquadrar';
    window.__recorteDiag = { metodo: _origem || (sugestao ? 'simples' : 'nenhum'), mapa: _mapa && [_mapa.W, _mapa.H],
                             alvo: _alvo, caixa: f, foto: [img.naturalWidth, img.naturalHeight] };

    return new Promise(res => { _resolver = res; });
  }

  return { abrir, _detectar, _analisar, _crescerAtePapel, _sugerir, _sugerirPorTexto, _limiteTexto, _papelPorCor, _expandirAoPapel };
})();
