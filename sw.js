// 나만의 라디오 service worker: 앱 화면은 캐시해서 빨리 뜨고 오프라인에서도 열리게,
// 방송 스트림·방송사 API는 절대 캐시하지 않음.
const CACHE = 'my-radio-v21';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  const isShellCdn = url.href.startsWith('https://cdn.jsdelivr.net/npm/hls.js') || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  if (same && url.pathname.endsWith('/mbc')) return;          // MBC 주소 풀기: 항상 새로
  if (!same && !isShellCdn) return;                            // 방송 스트림·API: 브라우저에 맡김
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    // 화면: 네트워크 먼저(업데이트 반영), 안 되면 캐시
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }
  // 아이콘·라이브러리·글꼴: 캐시 먼저
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return res;
  })));
});
