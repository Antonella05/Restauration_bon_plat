/* Helpers partagés: stockage auth, appels API, synchronisation des événements, toasts. */
(function () {
  const TOKEN_KEY = 'resto_token';
  const USER_KEY = 'resto_user';

  const Auth = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    get user() {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
      catch (e) { return null; }
    },
    set(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
    isLogged() { return !!this.token; },
  };

  async function api(path, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (Auth.token) opts.headers['Authorization'] = 'Bearer ' + Auth.token;
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);

    const res = await fetch('/api' + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Erreur serveur');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, type = '') {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  /* --- Synchronisation des événements compatible avec les fonctions serverless --- */
  function connectRealtime(onEvent, onStatus) {
    let timer = null;
    let lastEventId = null;
    let retry = 0;
    let closed = false;
    let connected = false;

    function setConnected(value) {
      if (connected === value) return;
      connected = value;
      if (onStatus) onStatus(value);
    }

    async function poll() {
      if (closed) return;
      try {
        const query = lastEventId === null ? '' : '?after=' + encodeURIComponent(lastEventId);
        const data = await api('/events' + query);
        if (lastEventId === null) {
          lastEventId = data.cursor;
        } else {
          for (const entry of data.events) {
            onEvent(entry.event);
            lastEventId = entry.id;
          }
          lastEventId = Math.max(lastEventId, data.cursor);
        }
        retry = 0;
        setConnected(true);
        timer = setTimeout(poll, 2500);
      } catch (error) {
        setConnected(false);
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(poll, Math.min(30000, 1000 * (2 ** retry)));
      }
    }

    poll();
    return {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        setConnected(false);
      },
    };
  }

  const STATUS_LABELS = {
    pending: 'En attente', accepted: 'Acceptée', preparing: 'En préparation',
    delivering: 'En livraison', delivered: 'Livrée',
    ready: 'Prête à retirer', picked_up: 'Retirée', no_show: 'Non récupérée',
    cancelled: 'Annulée',
  };
  const STATUS_CLASS = {
    pending: 'st-pending', accepted: 'st-accepted', preparing: 'st-preparing',
    delivering: 'st-delivering', delivered: 'st-delivered',
    ready: 'st-ready', picked_up: 'st-delivered', no_show: 'st-cancelled',
    cancelled: 'st-cancelled',
  };
  const FINAL_STATUSES = ['delivered', 'picked_up', 'no_show', 'cancelled'];
  // Étapes de suivi selon le mode de réception.
  const FLOWS = {
    delivery: ['pending', 'accepted', 'preparing', 'delivering', 'delivered'],
    pickup:   ['pending', 'accepted', 'preparing', 'ready', 'picked_up'],
  };
  const FULFILLMENT_LABELS = { delivery: 'Livraison', pickup: 'Retrait sur place' };

  function fmtMoney(n) { return (n || 0).toLocaleString('fr-FR') + ' FCFA'; }
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtTime(s) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    const today = new Date().toDateString() === d.toDateString();
    return (today ? "aujourd'hui" : d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })) +
      ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  /** Lien carte (OpenStreetMap) vers une position GPS. */
  function mapUrl(lat, lng) {
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
  }
  function badge(status) {
    return `<span class="badge ${STATUS_CLASS[status] || ''}">${STATUS_LABELS[status] || status}</span>`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* --- Identité du restaurant (nom, logo, couleur) — personnalisable depuis l'espace staff --- */
  function isSafeImage(url) {
    return typeof url === 'string' && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url));
  }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function applyBrand(s) {
    document.querySelectorAll('[data-brand]').forEach((el) => {
      const v = s[el.dataset.brand];
      if (v != null && v !== '') el.textContent = v;
    });
    document.querySelectorAll('[data-brand-logo]').forEach((el) => {
      if (el.dataset.defaultLogo == null) el.dataset.defaultLogo = el.innerHTML;
      if (isSafeImage(s.logo_url)) {
        el.innerHTML = `<img src="${escapeHtml(s.logo_url)}" alt="" />`;
        el.classList.add('has-img');
      } else {
        el.innerHTML = el.dataset.defaultLogo;
        el.classList.remove('has-img');
      }
    });
    // La couleur principale remplace l'accent ; l'ocre secondaire reste celui de la charte.
    if (/^#[0-9a-f]{6}$/i.test(s.primary_color || '')) {
      const root = document.documentElement.style;
      root.setProperty('--accent', s.primary_color);
      root.setProperty('--accent-dark', shade(s.primary_color, 0.78));
    }
    const suffix = document.body.dataset.titleSuffix;
    if (s.name && suffix) document.title = s.name + suffix;
  }
  const Brand = {
    settings: null,
    async load() {
      try {
        const { settings } = await api('/settings');
        Brand.settings = settings;
        applyBrand(settings);
      } catch (e) { /* on garde l'identité par défaut */ }
      return Brand.settings;
    },
  };

  /* --- Photos provisoires (Unsplash, licence libre) ---
     Utilisées tant que le restaurant n'a pas renseigné ses propres photos
     (champ « Image » du catalogue). Une vraie photo http(s) est toujours prioritaire. */
  const unsplash = (id, w = 800) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;
  const DISH_PHOTOS = [
    [/bouillie|porridge|mil\b/i, '1571748982800-fa51082c2224'],
    [/omelette|(?<!b)(œuf|oeuf)/i, '1510693206972-df098062cb71'],   // « bœuf » ne doit pas tomber ici
    [/croissant|caf[ée]/i,       '1555507036-ab1f4038808a'],
    [/c[ée]sar/i,                '1550304943-4f24f54ddde9'],
    [/crevette|avocat/i,         '1565680018434-b513d5e5fd47'],
    [/margherita/i,              '1574071318508-1cdbab80d002'],
    [/fromage/i,                 '1593560708920-61dd98c46a4e'],
    [/pizza/i,                   '1513104890138-7c749659a591'],
    [/shawarma|kebab|wrap/i,     '1529006557810-274b9b2fc783'],
    [/sandwich|panini/i,         '1528735602780-2552fd46c7af'],
    [/brochette/i,               '1555939594-58d7cb561ad1'],
    [/poisson|thiof|bar\b/i,     '1519708227418-c8fd9a32b7a2'],
    [/poulet/i,                  '1532550907401-a500c9a57435'],
    [/b[œo]euf|steak|viande/i,   '1600891964092-4316c288032e'],
    [/chocolat/i,                '1563805042-7684c019e1cb'],
    [/fruit/i,                   '1490474418585-ba9bad8fd0ea'],
    [/glace|vanille/i,           '1497034825429-c343d7c6a68f'],
    [/coca|cola/i,               '1554866585-cd94860890b7'],
    [/panta|fanta|orange/i,      '1600271886742-f049cd451bba'],
    [/eau/i,                     '1548839140-29a749e1cf4d'],
    [/bissap|jus|hibiscus/i,     '1595981267035-7b04ca84a82d'],
  ];
  const CATEGORY_PHOTOS = [
    [/petit|d[ée]jeuner|matin/i, '1525351484163-7529414344d8'],
    [/entr[ée]e|salade/i,        '1512621776951-a57141f2eefd'],
    [/pizza/i,                   '1600628421055-4d30de868b8f'],
    [/sandwich|burger/i,         '1528735602780-2552fd46c7af'],
    [/viande|grill/i,            '1555939594-58d7cb561ad1'],
    [/glace|dessert/i,           '1488900128323-21503983a07e'],
    [/boisson/i,                 '1595981267035-7b04ca84a82d'],
  ];
  const GENERIC_PHOTOS = ['1504674900247-0877df9cc836', '1490645935967-10de6ba17061', '1546069901-ba9599a7e63c', '1467003909585-2f8a72700288'];
  const AMBIENT_PHOTOS = {
    chef: '1581349485608-9469926a8e5e',
    room: '1517248135467-4c7edcad34c4',
    kitchen: '1556910103-1c02745aae4d',
  };

  function pick(rules, text) {
    const hit = rules.find(([re]) => re.test(text || ''));
    return hit ? hit[1] : null;
  }
  /** Photo d'une catégorie (par son nom). */
  function categoryPhoto(name, w) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return unsplash(pick(CATEGORY_PHOTOS, name) || GENERIC_PHOTOS[h % GENERIC_PHOTOS.length], w);
  }
  /** Photo d'un produit : la sienne si elle existe, sinon une photo provisoire cohérente. */
  function productPhoto(p, categoryName, w) {
    if (p && p.image_url && /^https?:/i.test(p.image_url)) return p.image_url;
    const id = pick(DISH_PHOTOS, p && p.name);
    return id ? unsplash(id, w) : categoryPhoto(categoryName, w);
  }
  function ambientPhoto(key, w) { return unsplash(AMBIENT_PHOTOS[key] || GENERIC_PHOTOS[0], w); }

  window.App = {
    Auth, api, toast, connectRealtime, Brand, applyBrand, isSafeImage,
    productPhoto, categoryPhoto, ambientPhoto,
    STATUS_LABELS, STATUS_CLASS, FINAL_STATUSES, FLOWS, FULFILLMENT_LABELS,
    fmtMoney, fmtDate, fmtTime, mapUrl, badge, escapeHtml,
  };
})();
