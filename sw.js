/* Koris — fonctionnement hors ligne + notifications sur le téléphone */
const CACHE='koris-v17';
const SHELL=['/','/index.html','/manifest.webmanifest','/icon-192-v2.png','/icon-512-v2.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(u.origin!==location.origin)return;
  const page=r.mode==='navigate'||u.pathname==='/'||u.pathname.endsWith('.html');
  e.respondWith(fetch(page?new Request(r.url,{cache:'no-cache',credentials:'same-origin'}):r).then(res=>{if(res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put(r,cp))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match('/index.html'))))});

/* Notification envoyée par le serveur Koris (nouveau message, commentaire…) */
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data&&e.data.text()}}
  const title=d.title||'Koris';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const visible=list.some(c=>c.visibilityState==='visible'&&c.focused);
    if(visible)return; /* Koris est déjà ouvert à l'écran : la notification apparaît dans l'app */
    return self.registration.showNotification(title,{body:d.body||'',tag:d.tag||'koris',renotify:true,icon:'/icon-192-v2.png',badge:'/badge-96.png',vibrate:[80,40,80],data:{url:d.url||'/'}})}))});

/* Toucher la notification : ouvre Koris sur la bonne conversation */
self.addEventListener('notificationclick',e=>{e.notification.close();const url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if(new URL(c.url).origin===location.origin){c.postMessage({open:url});return c.focus()}}
    return self.clients.openWindow(url)}))});
