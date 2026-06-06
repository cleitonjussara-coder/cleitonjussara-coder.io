/* ─────────────────────────────────────────────────────────────
   Service Worker — Petermann App
   Estratégia:
     • Shell (HTML/JS/CSS locais) → Cache First
     • CDN externos (Supabase, Tesseract, SheetJS, jsQR) → Stale-While-Revalidate
     • Supabase API → Network Only (não faz sentido cachear)
───────────────────────────────────────────────────────────── */
const CACHE   = 'petermann-v22';
const SHELL   = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.jpg',
  '/icon-192.png',
  '/icon-512.png',
  '/js/app.js',
  '/js/db.js',
  '/js/nfce.js',
  '/js/sefaz.js',
  '/js/brasilapi.js',
  '/js/ocr.js',
  '/js/excel.js',
  '/js/gestor.js',
  '/js/gdrive.js',
];

const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
];

// ── Install: pré-cache do shell ─────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
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

  // Shell → cache first, fallback index.html
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('/index.html')))
  );
});
