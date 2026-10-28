/* Ajuda a instalar o app (28/10/2026): colaboradores não achavam a opção de instalar. Faixa discreta no rodapé, só
   enquanto o app roda no navegador (fora do modo instalado). Android/PC: botão que abre a instalação do navegador;
   iPhone: passo a passo do Safari; WhatsApp/Instagram/Facebook: manda abrir no Chrome/Safari (o navegador embutido
   deles não instala). "Agora não" esconde por 7 dias. */
(function () {
  const CHAVE = 'instalar_oculto_ate';
  const ua = navigator.userAgent || '';
  const instalado = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (instalado) return;
  try { if (Number(localStorage.getItem(CHAVE)) > Date.now()) return; } catch (_) {}

  const emb = /FBAN|FBAV|Instagram|WhatsApp|Line\/|MicroMessenger|; wv\)/i.test(ua);
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const movel = ios || /Android/i.test(ua);
  let evento = null;

  function esconder() {
    document.getElementById('instalar-faixa')?.remove();
    try { localStorage.setItem(CHAVE, String(Date.now() + 7 * 864e5)); } catch (_) {}
  }

  function conteudo() {
    if (emb) return { t: 'Abra no navegador para instalar', d: 'O link aberto dentro do WhatsApp/Instagram não instala. Toque em ⋮ ou “Abrir no navegador” e escolha ' + (ios ? 'o Safari.' : 'o Chrome.'), b: 'Copiar endereço', f: copiar };
    if (ios) return safari
      ? { t: 'Instalar o app no iPhone', d: 'Toque em Compartilhar (quadrado com seta) → “Adicionar à Tela de Início”.' }
      : { t: 'Instalar o app no iPhone', d: 'Só o Safari instala no iPhone. Copie o endereço e abra no Safari.', b: 'Copiar endereço', f: copiar };
    if (evento) return { t: 'Instalar o app', d: 'Fica na tela inicial e funciona sem internet.', b: 'Instalar', f: instalar };
    if (movel) return { t: 'Instalar o app', d: 'No Chrome: menu ⋮ → “Instalar app” ou “Adicionar à tela inicial” (se não aparecer, use Compartilhar e arraste os ícones). Em outro navegador, abra no Chrome.' };
    return { t: 'Instalar o app', d: 'No Chrome ou Edge, clique no ícone de instalar na barra de endereço (ou menu ⋮ → Instalar).' };
  }

  async function instalar() {
    if (!evento) return;
    evento.prompt();
    try { await evento.userChoice; } catch (_) {}
    evento = null;
    document.getElementById('instalar-faixa')?.remove();
  }
  async function copiar() {
    const url = location.origin + location.pathname;
    try { await navigator.clipboard.writeText(url); } catch (_) {}
    if (typeof toast === 'function') toast('Endereço copiado: cole no ' + (ios ? 'Safari' : 'Chrome'));
  }

  function pintar() {
    document.getElementById('instalar-faixa')?.remove();
    const c = conteudo();
    const el = document.createElement('div');
    el.id = 'instalar-faixa';
    el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:calc(72px + env(safe-area-inset-bottom,0px));z-index:900;background:#fff;color:#1b1b1b;border:1px solid var(--primary,#2D6A4F);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25);padding:10px 12px;font-size:14px;line-height:1.35';
    el.innerHTML = `<div style="font-weight:700;margin-bottom:2px">📲 ${c.t}</div><div>${c.d}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button type="button" class="btn btn-outline btn-sm" data-a="n">Agora não</button>
        ${c.b ? `<button type="button" class="btn btn-primary btn-sm" data-a="s">${c.b}</button>` : ''}
      </div>`;
    el.querySelector('[data-a="n"]').onclick = esconder;
    el.querySelector('[data-a="s"]')?.addEventListener('click', c.f);
    document.body.appendChild(el);
  }

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); evento = e; if (document.getElementById('instalar-faixa')) pintar(); });
  window.addEventListener('appinstalled', () => { evento = null; document.getElementById('instalar-faixa')?.remove(); });
  /* só depois de logado e com a tela montada: espera um pouco para não competir com o carregamento */
  setTimeout(pintar, 6000);
})();
