/* ─────────────────────────────────────────────────────────────
   Service Worker — Petermann App
   Estratégia:
     • Shell (HTML/JS/CSS locais) → Network First (cache só como reserva offline)
     • CDN externos (Supabase, Tesseract, SheetJS, jsQR) → Stale-While-Revalidate
     • Supabase API → Network Only (não faz sentido cachear)
───────────────────────────────────────────────────────────── */
const CACHE   = 'petermann-v92';
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
  './logo.jpg',
  './icon-192.png',
  './icon-512.png',
  './js/app.js',
  './js/db.js',
  './js/nfce.js',
  './js/sefaz.js',
  './js/brasilapi.js',
  './js/ocr.js',
  './js/recorte.js',
  './js/excel.js',
  './js/gestor.js',
  './js/gdrive.js',
  './js/gsheets.js',
];

const RUNTIME_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './logo.jpg',
  './icon-192.png',
  './icon-512.png',
];
const LOCAL_ASSET_PATHS = RUNTIME_CACHE.map(path => path.replace('./', '/'));
  
const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
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

// ── Fetch ────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Supabase API → sempre rede
  if (url.includes('.supabase.co')) return;

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

  // Shell + assets estáticos locais → network first, com fallback para cache.
  const requestUrl = new URL(e.request.url);
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
