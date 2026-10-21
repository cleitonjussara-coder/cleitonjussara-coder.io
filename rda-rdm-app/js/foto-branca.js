/* ═══════════════════════════════════════════════════════════
   Foto SEM DADOS de nota (21/10/2026)
   O colaborador anexou uma foto de papel liso e o app deixou lançar. Aqui se mede o "conteúdo" da imagem, sem ler
   nada: a foto vai a 640 px em cinza e cada pixel é comparado com a MÉDIA da vizinhança (janela 25×25). "Tinta" é a
   porcentagem de pixels que diferem mais de 20 níveis dessa média — degradê e sombra suave não contam, texto, borda
   de papel, dobra e rabisco contam. Em branco só abaixo de 0,01 %: nada além de poeira.

   Calibragem (mesma do servidor, api/app/Services/FotoEmBranco.php — mantenha as duas regras iguais): foto real do
   caso = 0 %; papel liso com sombra/ruído, lente tampada, parede lisa = 0 %; manuscrito curto "R$ 14,00" num papel
   enorme = 0,55 %; cupom desbotado = 1,1 %; 127 fotos reais de nota = no mínimo 6,7 %.
   Erra SEMPRE para o lado seguro: ruído, textura ou qualquer marca a mais contam como "tem conteúdo", e o que não
   dá para medir (HEIC no Chrome, imagem ilegível, erro) devolve null — que nunca barra.
═══════════════════════════════════════════════════════════ */
window.FotoBranca = (() => {
  const LADO = 640, RAIO = 12, DIFERENCA = 20, TINTA_MIN = 0.01;

  /* % de pixels com tinta. g = tons de cinza linha a linha (w*h valores). */
  function tintaDoCinza(g, w, h) {
    const W = w + 1;
    const S = new Float64Array(W * (h + 1));          // imagem integral: soma de qualquer janela em 4 leituras
    for (let y = 0; y < h; y++) {
      let lin = 0;
      for (let x = 0; x < w; x++) {
        lin += g[y * w + x];
        S[(y + 1) * W + x + 1] = S[y * W + x + 1] + lin;
      }
    }
    let com = 0;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - RAIO), y1 = Math.min(h, y + RAIO + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - RAIO), x1 = Math.min(w, x + RAIO + 1);
        const soma = S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
        const media = soma / ((x1 - x0) * (y1 - y0));
        if (Math.abs(g[y * w + x] - media) > DIFERENCA) com++;
      }
    }
    return com / (w * h) * 100;
  }

  /* Cinza a 640 px. Reduz em passos de METADE: um desenho só de 4000 px para 640 amostra poucos pixels da origem e o
     ruído de uma foto escura passaria por conteúdo (erra para o lado seguro, mas deixaria de pegar a foto em branco). */
  async function cinza(blob) {
    let url;
    try {
      url = URL.createObjectURL(blob);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img')); i.src = url; });
      const ow = img.naturalWidth, oh = img.naturalHeight;
      if (!ow || !oh) return null;
      const k = Math.min(1, LADO / Math.max(ow, oh));
      const w = Math.max(8, Math.round(ow * k)), h = Math.max(8, Math.round(oh * k));
      let fonte = img, fw = ow, fh = oh;
      while (fw >= 2 * w && fh >= 2 * h) {
        const nw = Math.ceil(fw / 2), nh = Math.ceil(fh / 2);
        const c = document.createElement('canvas'); c.width = nw; c.height = nh;
        const cx = c.getContext('2d');
        cx.imageSmoothingQuality = 'high';
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, nw, nh);     // PNG transparente → fundo branco
        cx.drawImage(fonte, 0, 0, nw, nh);
        fonte = c; fw = nw; fh = nh;
      }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      cx.drawImage(fonte, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data;
      const g = new Float64Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      return { g, w, h };
    } catch (_) { return null; }
    finally { if (url) URL.revokeObjectURL(url); }
  }

  /* % de pixels com tinta da imagem, ou null se não deu para medir. */
  async function tinta(blob) {
    const c = await cinza(blob);
    return c ? tintaDoCinza(c.g, c.w, c.h) : null;
  }

  /* true = em branco; false = tem conteúdo; null = não deu para medir (nunca barra). */
  async function emBranco(blob) {
    try {
      const t = await tinta(blob);
      return t === null ? null : t < TINTA_MIN;
    } catch (_) { return null; }
  }

  return { tintaDoCinza, cinza, tinta, emBranco, TINTA_MIN };
})();
