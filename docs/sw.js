// Uygulama kabuğunu önbelleğe alır; uygulama internetsiz açılır.
// Tarifeler bu önbellekte değil, cihazdaki localStorage'da tutulur (js/data.js).
// Dosyalardan birini değiştirdiğinde VERSION'ı artır ki telefonlar yeni sürümü alsın.
const VERSION = '1.7.0';
const CACHE = 'sonraki-tren-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './manifest.webmanifest',
  './js/app.js',
  './js/core.js',
  './js/data.js',
  './data/stations.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './fonts/overpass-latin-400-normal.woff2',
  './fonts/overpass-latin-600-normal.woff2',
  './fonts/overpass-latin-800-normal.woff2',
  './fonts/overpass-latin-ext-400-normal.woff2',
  './fonts/overpass-latin-ext-600-normal.woff2',
  './fonts/overpass-latin-ext-800-normal.woff2',
];

self.addEventListener('install', (e) => {
  // GitHub Pages her dosyayı 10 dk tarayıcı önbelleğine aldırıyor; yeni sürüm kurulurken
  // eski dosyalar önbellekten gelmesin diye ağa doğrudan git
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sonraki-tren-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API ve arıza dosyası gibi dış adreslere dokunma; onları uygulama kendisi yönetiyor
  if (url.origin !== self.location.origin) return;


  // Sayfa gezintisi: önce önbellek, yoksa ağ, o da yoksa ana sayfa
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req)).catch(() => caches.match('./')),
    );
    return;
  }

  // Diğer kabuk dosyaları: önce önbellek
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
