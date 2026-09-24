/* ─────────────────────────────────────────────────────────────
   Service Worker — Petermann App
   Estratégia:
     • Shell (HTML/JS/CSS locais) → Network First (cache só como reserva offline)
     • CDN externos (Tesseract, SheetJS, jsQR) → Stale-While-Revalidate
     • Petermann API (outra origem) → Network Only (não faz sentido cachear)
───────────────────────────────────────────────────────────── */
const CACHE   = 'petermann-v263';
/* Caminhos RELATIVOS ao sw.js — não comece com "/".
   Com "/index.html" o service worker procurava na raiz do domínio, mas o app
   é servido em /rda-rdm-app/: guardava a página de redirecionamento da raiz
   no lugar do app e o manifest/ícones davam 404 e ficavam de fora (o
   .catch() do install engolia o erro, então nada disso aparecia).
   Relativo funciona em qualquer pasta — e é o que faz o app continuar
   inteiro se um dia ele mudar de endereço ou de servidor. */
const SHELL   = [
  './',
  './index.html',
  './manifest.json',
  './logo.jpg?v=159',
  './icon-192.png?v=160',
  './icon-512.png?v=160',
  './js/app.js',
  './js/api.js',
  './js/db.js',
  './js/nfce.js',
  './js/sefaz.js',
  './js/brasilapi.js',
  './js/ocr.js',
  './js/recorte.js',
  './js/excel.js',
  './js/gestor.js',
  './js/frota.js',
  './js/ponto.js',
  './js/arquivos.js',
  './topo.png?v=188',
  './js/gdrive.js',
];

const RUNTIME_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './logo.jpg?v=159',
  './icon-192.png?v=160',
  './icon-512.png?v=160',
];
const LOCAL_ASSET_PATHS = RUNTIME_CACHE.map(path => path.replace('./', '/'));
  
const CDN = [
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
];

// ── Install: pré-cache do shell (resiliente: ignora arquivo que faltar) ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: limpa caches antigos ─────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Notificação vinda do servidor (Web Push, 24/09/2026) ──────
/* É isto que faz o número aparecer no ícone do app: o Android conta as
   notificações não lidas e desenha o contador sozinho. A carga vem do
   PushService como JSON { titulo, corpo, url, tag }. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { corpo: e.data ? e.data.text() : '' }; }

  const titulo = d.titulo || 'Petermann – Despesas';
  const opcoes = {
    body: d.corpo || '',
    icon: './icon-192.png?v=160',
    badge: './icon-192.png?v=160',
    lang: 'pt-BR',
    data: { url: d.url || './' },
    /* mesma tag = o aviso novo substitui o antigo, em vez de empilhar dois
       sobre o mesmo assunto (ex.: o mesmo cartão avisado de novo) */
    tag: d.tag || undefined,
    renotify: !!d.tag,
  };
  e.waitUntil(self.registration.showNotification(titulo, opcoes));
});

/* Tocar no aviso: traz a janela que já existe para a frente; se não houver
   nenhuma, abre o app. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const destino = new URL(e.notification.data && e.notification.data.url || './', self.location.href).href;
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const j of janelas) {
      if (j.url.indexOf(self.registration.scope) === 0) {
        await j.focus();
        return;
      }
    }
    await self.clients.openWindow(destino);
  })());
});

// ── Fetch ────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // CDN → stale-while-revalidate
  if (CDN.some(u => url.startsWith(u.split('?')[0]))) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const cached = await c.match(e.request);
        const fresh  = fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; }).catch(() => null);
        return cached || fresh;
      })
    );
    return;
  }

  // Petermann API e qualquer outra origem → sempre rede. Sem isto, a API
  // fora do ar devolveria o index.html do cache no lugar do JSON.
  const requestUrl = new URL(e.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Shell + assets estáticos locais → network first, com fallback para cache.
  const scopePrefix = (self.registration.scope || self.location.origin).replace(self.location.origin, '').replace(/\/$/, '');
  const pathWithoutScope = requestUrl.pathname.startsWith(scopePrefix + '/')
    ? requestUrl.pathname.slice(scopePrefix.length)
    : requestUrl.pathname;
  const isLocalAsset = LOCAL_ASSET_PATHS.includes(pathWithoutScope)
    || pathWithoutScope.startsWith('/js/');

  if (isLocalAsset) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          if (r.ok) {
            caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          }
          return r;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true })
          .then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Fallback padrão: tente rede e, se falhar, devolva o shell.
  e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
});
