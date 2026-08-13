// Service worker de La Petite Parisienne.
//
// Objectif: pouvoir ouvrir l'app sur un evenement sans reseau. Avant, la page
// elle-meme venait du reseau (et Chart.js / jsPDF / Firebase des CDN), donc
// hors ligne l'app ne se chargeait pas du tout, meme avec les donnees en cache.
//
// Regle de prudence: le HTML passe TOUJOURS par le reseau en premier
// (network-first). Le site est publie directement en production sans staging:
// il ne faut jamais qu'une ancienne version reste collee dans le cache.
//
// Pour forcer la mise a jour du cache apres un changement de style.css ou des
// icones: incrementer CACHE_VERSION ci-dessous.
const CACHE_VERSION = 'lpp-v1';

const CORE_ASSETS = [
    './',
    './index.html',
    './style.css',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// Requetes qui ne doivent JAMAIS passer par le cache: Firestore fonctionne en
// streaming / long-polling et l'authentification doit rester temps reel.
// Les intercepter casserait la synchro.
const NETWORK_ONLY = [
    /firestore\.googleapis\.com/,
    /firebaseio\.com/,
    /identitytoolkit\.googleapis\.com/,
    /securetoken\.googleapis\.com/,
    /firebaseinstallations\.googleapis\.com/,
    /google-analytics\.com/,
    /googletagmanager\.com/
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            // addAll echoue en bloc si un seul fichier manque: on met en cache
            // fichier par fichier pour que l'installation aboutisse quand meme.
            .then(cache => Promise.all(CORE_ASSETS.map(url => cache.add(url).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = request.url;
    if (NETWORK_ONLY.some(re => re.test(url))) return;

    // Navigation (ouverture de l'app): reseau d'abord, cache en secours.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then(cache => cache.put('./index.html', copy));
                    return response;
                })
                .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
        );
        return;
    }

    const sameOrigin = url.startsWith(self.location.origin);

    if (sameOrigin) {
        // style.css, icones: on sert le cache tout de suite et on rafraichit derriere.
        event.respondWith(
            caches.match(request).then(cached => {
                const network = fetch(request).then(response => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
                    }
                    return response;
                }).catch(() => cached);
                return cached || network;
            })
        );
        return;
    }

    // CDN (Firebase SDK, Chart.js, jsPDF, pdf.js, Google Fonts): versions figees
    // par leur URL, donc cache d'abord.
    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;
            return fetch(request).then(response => {
                if (response && (response.status === 200 || response.type === 'opaque')) {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
                }
                return response;
            });
        })
    );
});
