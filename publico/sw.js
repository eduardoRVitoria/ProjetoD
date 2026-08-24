// Service worker minimo: so o suficiente para o site poder ser instalado como
// app na tela de inicio. Nao guarda dado de RDV em cache - os numeros precisam
// vir sempre do servidor, senao alguem confere um relatorio desatualizado.

const CACHE = 'portal-rdv-v1';
const CASCA = ['/', '/css/estilo.css', '/js/comum.js', '/icone.svg', '/manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);

  // Nada de /api vai para o cache.
  if (url.pathname.startsWith('/api/') || ev.request.method !== 'GET') return;

  ev.respondWith(
    fetch(ev.request)
      .then((resposta) => {
        if (resposta.ok && url.origin === location.origin) {
          const copia = resposta.clone();
          caches.open(CACHE).then((c) => c.put(ev.request, copia));
        }
        return resposta;
      })
      .catch(() => caches.match(ev.request).then((r) => r || caches.match('/'))),
  );
});
