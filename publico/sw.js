// Service worker minimo: existe para o site poder ser instalado como app na
// tela de inicio. NAO serve para acelerar nada.
//
// Historia: a primeira versao guardava HTML, CSS e JS no cache e servia do
// cache quando a rede falhava. Resultado: o navegador do usuario ficou com o
// HTML antigo e o JS novo ao mesmo tempo. O JS procurava campos que o HTML
// velho nao tinha, quebrava, e a lista de colaboradores nunca era desenhada.
//
// Agora a regra e simples: HTML, CSS e JS vem SEMPRE da rede. O cache guarda
// so o icone e o manifest, que nunca mudam de forma.

const CACHE = 'portal-rdv-v3';
const SO_ESTES = ['/icone.svg', '/manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SO_ESTES))
      .then(() => self.skipWaiting()),
  );
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

  if (ev.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Codigo e paginas: sempre da rede, sem cache nenhum no meio.
  const ehCodigo = /\.(html|js|css)$/.test(url.pathname) || url.pathname === '/' ||
    ev.request.mode === 'navigate';
  if (ehCodigo) return;

  // O resto (icone, manifest): cache primeiro, com atualizacao por tras.
  ev.respondWith(
    caches.match(ev.request).then((doCache) => {
      const daRede = fetch(ev.request)
        .then((resposta) => {
          if (resposta.ok) {
            const copia = resposta.clone();
            caches.open(CACHE).then((c) => c.put(ev.request, copia));
          }
          return resposta;
        })
        .catch(() => doCache);
      return doCache || daRede;
    }),
  );
});
