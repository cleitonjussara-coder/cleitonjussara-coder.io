/* ─────────────────────────────────────────────────────────────
   Service Worker — Petermann App
   Estratégia:
     • Shell (HTML/JS/CSS locais) → Cache First
     • CDN externos (Supabase, Tesseract, SheetJS, jsQR) → Stale-While-Revalidate
     • Supabase API → Network Only (não faz sentido cachear)
───────────────────────────────────────────────────────────── */
const CACHE   = 'petermann-v39';
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

  // Shell (HTML/JS/CSS locais) → NETWORK FIRST
  // Sempre tenta a rede (pega código novo na hora); cache só como reserva offline.
  e.respondWith(
    fetch(e.request)
      .then(r => {
        // guarda uma cópia fresca p/ uso offline
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});
