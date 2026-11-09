/* Interface CLIENT : landing, menu, panier, commande, suivi temps réel. */
(function () {
  const {
    Auth, api, toast, connectRealtime, Brand, isSafeImage, productPhoto, categoryPhoto, fmtMoney, fmtDate, fmtTime, mapUrl, badge, escapeHtml,
    STATUS_LABELS, FINAL_STATUSES, FLOWS, FULFILLMENT_LABELS,
  } = App;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let menu = [];          // catégories + produits
  let activeCat = null;
  let cart = [];          // { product, qty }
  let myOrders = [];
  let myTickets = [];
  let eventsList = [];
  let currentVenueFilter = 'all';
  let eventSearchTerm = '';
  let rt = null;
  let pendingAfterLogin = null;   // action à exécuter après connexion

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function isClient() {
    const u = Auth.user;
    return Auth.isLogged() && u && u.role === 'client';
  }
  const settings = () => Brand.settings || {};

  /* ---------- Démarrage ---------- */
  async function boot() {
    if (!location.hash) window.scrollTo(0, 0);
    loadCart();
    refreshAuthUI();
    await Brand.load();
    applyHome();
    await loadMenu();
    await loadEvents();
    startRealtime();
    if (isClient()) { refreshProfile(); loadOrders(); loadMyTickets(); }
  }

  /** Recharge le profil mémorisé (adresse, position, mode préféré) depuis le serveur. */
  async function refreshProfile() {
    try {
      const { user } = await api('/auth/me');
      if (user && user.role === 'client') { Auth.set(Auth.token, user); refreshAuthUI(); }
    } catch (err) { if (err.status === 401) { Auth.clear(); refreshAuthUI(); } }
  }

  /* ---------- Page d'accueil personnalisée ---------- */
  function applyHome() {
    const s = settings();
    if (s.hero_title || s.hero_accent) {
      $('#heroTitle').innerHTML = escapeHtml(s.hero_title || '') +
        (s.hero_accent ? `<br/><em>${escapeHtml(s.hero_accent)}</em>` : '');
    }
    const hero = $('.hero');
    if (isSafeImage(s.hero_image_url)) hero.style.setProperty('--hero-photo', `url("${s.hero_image_url.replace(/["\\\n]/g, '')}")`);
    else if (s.hero_image_url === '') hero.style.setProperty('--hero-photo', 'none');

    const modes = [s.delivery_enabled !== '0' && 'Livraison', s.pickup_enabled !== '0' && 'retrait'].filter(Boolean);
    $('#heroModes').textContent = modes.length === 2 ? 'Livraison ou retrait'
      : (s.pickup_enabled !== '0' ? 'Retrait sur place' : 'Livraison');
  }

  /* ---------- Auth UI (navbar) ---------- */
  function refreshAuthUI() {
    const logged = isClient();
    $('#loginBtn').classList.toggle('hidden', logged);
    $('#logoutBtn').classList.toggle('hidden', !logged);
    $('#userChip').classList.toggle('hidden', !logged);
    $('#navOrders').classList.toggle('hidden', !logged);
    if ($('#navTickets')) $('#navTickets').classList.toggle('hidden', !logged);
    if (logged) $('#userName').textContent = Auth.user.name;
  }

  /* ---------- Modale de connexion ---------- */
  function openLogin(opts = {}) {
    $('#loginTitle').textContent = opts.title || 'Bienvenue !';
    $('#loginSub').textContent = opts.sub ||
      'Entrez votre nom et votre numéro pour commander et suivre votre commande en temps réel.';
    $('#loginOverlay').classList.add('open');
    $('#loginOverlay').setAttribute('aria-hidden', 'false');
    setTimeout(() => $('#cName').focus(), 50);
  }
  function closeLogin() { $('#loginOverlay').classList.remove('open'); $('#loginOverlay').setAttribute('aria-hidden', 'true'); pendingAfterLogin = null; }
  $('#loginBtn').addEventListener('click', () => openLogin());
  $('#loginClose').addEventListener('click', closeLogin);
  $('#loginOverlay').addEventListener('click', (e) => { if (e.target === $('#loginOverlay')) closeLogin(); });

  $('#clientLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#cName').value.trim();
    const phone = $('#cPhone').value.trim();
    if (!name || !phone) { toast('Nom et téléphone requis', 'error'); return; }
    try {
      const { token, user } = await api('/auth/client-login', { method: 'POST', body: { name, phone } });
      const next = pendingAfterLogin;
      pendingAfterLogin = null;
      Auth.set(token, user);
      closeLogin();
      refreshAuthUI();
      startRealtime();       // reconnexion authentifiée (suivi ciblé)
      loadOrders();
      toast('Bienvenue ' + user.name + ' !', 'success');
      if (typeof next === 'function') next();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#logoutBtn').addEventListener('click', () => {
    Auth.clear();
    if (rt) rt.close();
    refreshAuthUI();
    setView('home');
    startRealtime();
    toast('À bientôt !');
  });

  /* ---------- Navigation ---------- */
  function setView(view) {
    $('#viewHome').classList.toggle('hidden', view !== 'home');
    $('#viewOrders').classList.toggle('hidden', view !== 'orders');
    if ($('#viewTickets')) $('#viewTickets').classList.toggle('hidden', view !== 'tickets');
    if (view === 'orders') loadOrders();
    if (view === 'tickets') loadMyTickets();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('[data-view]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const v = b.dataset.view;
    if (v === 'orders' && !isClient()) {
      pendingAfterLogin = () => setView('orders');
      openLogin({ title: 'Vos commandes', sub: 'Connectez-vous pour retrouver et suivre vos commandes.' });
      return;
    }
    if (v === 'tickets' && !isClient()) {
      pendingAfterLogin = () => setView('tickets');
      openLogin({ title: 'Vos billets', sub: 'Connectez-vous pour retrouver vos billets électroniques et QR codes.' });
      return;
    }
    setView(v);
  }));
  $('#mobileNavToggle').addEventListener('click', () => {
    const open = $('#navLinks').classList.toggle('mobile-open');
    $('#mobileNavToggle').setAttribute('aria-expanded', String(open));
    $('#mobileNavToggle').textContent = open ? 'Fermer' : 'Menu';
  });

  // Défilement doux (liens ancre + boutons data-scroll)
  function smoothTo(sel) {
    setView('home');
    const el = document.querySelector(sel);
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  $$('[data-scroll]').forEach((b) => b.addEventListener('click', () => smoothTo(b.dataset.scroll)));
  $$('.nav-links a[data-nav]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); smoothTo(a.getAttribute('href'));
    $('#navLinks').classList.remove('mobile-open');
    $('#mobileNavToggle').setAttribute('aria-expanded', 'false');
    $('#mobileNavToggle').textContent = 'Menu';
  }));

  // Navbar ombrée au défilement
  window.addEventListener('scroll', () => {
    $('#navbar').classList.toggle('scrolled', window.scrollY > 20);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#loginOverlay').classList.contains('open')) closeLogin();
    else if (drawerOpen) closeDrawer();
  });

  /* ---------- Menu ---------- */
  async function loadMenu() {
    try {
      const { categories } = await api('/menu');
      menu = categories.filter((c) => c.products.length);
      menu.forEach((c) => c.products.forEach((p) => { p.category_name = c.name; }));
      if (!activeCat && menu.length) activeCat = menu[0].id;
      renderCatCards();
      renderFeatured();
      renderHeroMenu();
      renderCatTabs();
      renderProducts();
    } catch (err) { toast('Impossible de charger le menu', 'error'); }
  }

  function renderCatCards() {
    $('#catCards').innerHTML = menu.map((c, i) => `
      <button class="cat-card" data-gocat="${c.id}">
        <img class="cc-photo" src="${escapeHtml(categoryPhoto(c.name, 500))}" alt="" loading="lazy" onerror="this.remove()" />
        <span class="cc-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="cc-text">
          <span class="cc-name">${escapeHtml(c.name)}</span>
          <span class="cc-count">${c.products.length} plat${c.products.length > 1 ? 's' : ''}</span>
        </span>
        <span class="cc-go" aria-hidden="true">→</span>
      </button>`).join('');
    $$('#catCards [data-gocat]').forEach((b) => b.addEventListener('click', () => {
      activeCat = parseInt(b.dataset.gocat, 10);
      renderCatTabs(); renderProducts();
      smoothTo('#menu');
    }));
  }

  /** Plats mis en avant par le restaurant (catalogue) ; à défaut, un plat par catégorie. */
  function featuredProducts() {
    const chosen = menu.flatMap((c) => c.products.filter((p) => p.featured));
    if (chosen.length) return chosen.slice(0, 5);
    const picks = [];
    for (const c of menu) { if (c.products[0]) picks.push(c.products[0]); }
    return picks.slice(0, 5);
  }

  function renderFeatured() {
    $('#featured').innerHTML = featuredProducts().map((p) => productCard(p, 'feature')).join('');
    bindProductButtons('#featured');
  }

  function renderHeroMenu() {
    const items = featuredProducts().slice(0, 4);
    if (!items.length) return;
    $('#heroMenuLines').innerHTML = items.map((p) => `
      <div class="mc-line"><span class="n">${escapeHtml(p.name)}</span><span class="d"></span><span class="p">${(p.price || 0).toLocaleString('fr-FR')}</span></div>`).join('');
  }

  /** Carte produit : ligne de menu (par défaut) ou grande carte « incontournable » (variant = 'feature'). */
  function productCard(p, variant) {
    const inCart = cart.find((c) => c.product.id === p.id);
    const feature = variant === 'feature';
    // Photo du restaurant si elle existe, sinon photo d'illustration ; si elle
    // casse au chargement, on retombe proprement sur la mise en page sans photo.
    const img = productPhoto(p, p.category_name, feature ? 900 : 360);
    return `
      <article class="product${feature ? ' product--feature' : ''}">
        <div class="thumb"><img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" loading="lazy"
           onerror="this.closest('.product').classList.add('no-img')" /></div>
        <div class="body">
          ${feature && p.category_name ? `<span class="p-cat">${escapeHtml(p.category_name)}</span>` : ''}
          <div class="p-head">
            <h3>${escapeHtml(p.name)}</h3>
            <span class="leader"></span>
            <span class="price">${(p.price || 0).toLocaleString('fr-FR')}<small>FCFA</small></span>
          </div>
          ${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ''}
          <div class="actions">
            ${inCart
              ? `<div class="qty">
                   <button data-dec="${p.id}" aria-label="Retirer un ${escapeHtml(p.name)}">−</button>
                   <span>${inCart.qty}</span>
                   <button data-inc="${p.id}" aria-label="Ajouter un ${escapeHtml(p.name)}">+</button>
                 </div>`
              : `<button class="add-btn" data-add="${p.id}"><span aria-hidden="true">+</span> Ajouter</button>`}
          </div>
        </div>
      </article>`;
  }

  function bindProductButtons(scope) {
    $$(`${scope} [data-add]`).forEach((b) =>
      b.addEventListener('click', () => addToCart(parseInt(b.dataset.add, 10))));
    $$(`${scope} [data-inc]`).forEach((b) =>
      b.addEventListener('click', () => changeQty(parseInt(b.dataset.inc, 10), 1)));
    $$(`${scope} [data-dec]`).forEach((b) =>
      b.addEventListener('click', () => changeQty(parseInt(b.dataset.dec, 10), -1)));
  }

  function renderCatTabs() {
    $('#catTabs').innerHTML = menu.map((c) =>
      `<button class="${c.id === activeCat ? 'active' : ''}" data-cat="${c.id}" aria-pressed="${c.id === activeCat}">
        <span>${escapeHtml(c.name)}</span><span class="ct-n">${c.products.length}</span></button>`
    ).join('');
    $$('#catTabs button').forEach((b) =>
      b.addEventListener('click', () => { activeCat = parseInt(b.dataset.cat, 10); renderCatTabs(); renderProducts(); }));
  }

  function renderProducts() {
    const cat = menu.find((c) => c.id === activeCat);
    if (!cat) { $('#products').innerHTML = '<div class="empty">Aucun produit.</div>'; return; }
    $('#products').innerHTML = cat.products.map(productCard).join('');
    bindProductButtons('#products');
    // rafraîchir aussi la section vedette (états +/-)
    renderFeatured();
  }

  function findProduct(id) {
    for (const c of menu) { const p = c.products.find((x) => x.id === id); if (p) return p; }
    return null;
  }

  /* ---------- Panier ---------- */
  function loadCart() {
    try { cart = JSON.parse(localStorage.getItem('resto_cart') || '[]'); }
    catch (e) { cart = []; }
    updateCartUI();
  }
  function saveCart() { localStorage.setItem('resto_cart', JSON.stringify(cart)); }

  function addToCart(id) {
    const product = findProduct(id);
    if (!product) return;
    const line = cart.find((c) => c.product.id === id);
    if (line) line.qty++; else cart.push({ product, qty: 1 });
    saveCart(); updateCartUI(); renderProducts();
    toast(product.name + ' ajouté au panier', 'success');
    bumpCart();
  }
  function changeQty(id, delta) {
    const line = cart.find((c) => c.product.id === id);
    if (!line) return;
    line.qty += delta;
    if (line.qty <= 0) cart = cart.filter((c) => c.product.id !== id);
    saveCart(); updateCartUI(); renderProducts();
    if (drawerOpen) renderCart();
  }
  function cartTotal() { return cart.reduce((s, c) => s + c.product.price * c.qty, 0); }
  function cartCount() { return cart.reduce((s, c) => s + c.qty, 0); }
  function updateCartUI() {
    const n = cartCount();
    $('#cartCount').textContent = n;
    $('#cartFab').classList.toggle('has-items', n > 0);
  }
  function bumpCart() {
    const fab = $('#cartFab');
    fab.classList.remove('bump'); void fab.offsetWidth; fab.classList.add('bump');
  }

  /* ---------- Tiroir ---------- */
  let drawerOpen = false;
  let payMethod = 'cash';
  let fulfillment = null;   // 'delivery' | 'pickup'
  let pickupAsap = true;
  let geo = null;           // { lat, lng, accuracy }

  function openDrawer() { drawerOpen = true; $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#drawerOverlay').classList.add('open'); $('#drawerOverlay').setAttribute('aria-hidden', 'false'); }
  function closeDrawer() { drawerOpen = false; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#drawerOverlay').classList.remove('open'); $('#drawerOverlay').setAttribute('aria-hidden', 'true'); }
  $('#cartFab').addEventListener('click', () => { renderCart(); openDrawer(); });
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerOverlay').addEventListener('click', closeDrawer);

  function renderCart() {
    $('#drawerTitle').textContent = 'Votre panier';
    if (!cart.length) {
      $('#drawerContent').innerHTML = `
        <div class="empty">
          <div class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 1.9-1.4L21 8H6M10 20h.01M18 20h.01"/></svg></div>
          <p>Votre panier est vide.</p>
          <button class="btn secondary small" id="emptyBrowse">Parcourir le menu</button>
        </div>`;
      $('#drawerFooter').innerHTML = '';
      const b = $('#emptyBrowse'); if (b) b.addEventListener('click', () => { closeDrawer(); smoothTo('#menu'); });
      return;
    }
    $('#drawerContent').innerHTML = cart.map((c) => `
      <div class="cart-line">
        <img class="cl-thumb" src="${escapeHtml(productPhoto(c.product, c.product.category_name, 160))}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="info">
          <strong>${escapeHtml(c.product.name)}</strong><br/>
          <span class="muted">${fmtMoney(c.product.price)}</span>
        </div>
        <div class="qty">
          <button data-dec="${c.product.id}">−</button>
          <span>${c.qty}</span>
          <button data-inc="${c.product.id}">+</button>
        </div>
      </div>`).join('');
    bindProductButtons('#drawerContent');

    $('#drawerFooter').innerHTML = `
      <div class="cart-total"><span>Total</span><span>${fmtMoney(cartTotal())}</span></div>
      <button class="btn block" id="toCheckout">Commander →</button>`;
    $('#toCheckout').addEventListener('click', goCheckout);
  }

  function goCheckout() {
    if (!isClient()) {
      pendingAfterLogin = () => { openDrawer(); renderCheckout(); };
      $('#drawer').classList.remove('open'); // laisse l'overlay pour la modale
      openLogin({ title: 'Presque prêt !', sub: 'Entrez votre nom et votre contact pour finaliser la commande.' });
      return;
    }
    renderCheckout();
  }

  /** Modes de réception proposés par le restaurant. */
  function availableModes() {
    const s = settings();
    return ['delivery', 'pickup'].filter((m) => s[m + '_enabled'] !== '0');
  }

  /** Valeur par défaut d'un champ datetime-local : maintenant + 30 min, arrondi au quart d'heure. */
  function defaultPickupValue() {
    const d = new Date(Date.now() + 30 * 60000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return toLocalInput(d);
  }
  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const ICONS = {
    delivery: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7M3 12h9l2-5h3l3 7.5M12 12v5"/></svg>',
    pickup: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v10h16V10M3 10l2-6h14l2 6H3ZM9 20v-5h6v5"/></svg>',
    pin: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  };

  function renderCheckout() {
    payMethod = 'cash';
    pickupAsap = true;
    $('#drawerTitle').textContent = 'Finaliser la commande';
    const u = Auth.user || {};
    const s = settings();
    const modes = availableModes();
    if (!modes.includes(fulfillment)) fulfillment = modes.includes(u.fulfillment) ? u.fulfillment : modes[0];
    geo = u.latitude != null && u.longitude != null ? { lat: u.latitude, lng: u.longitude, accuracy: null, saved: true } : null;
    const hasSavedInfo = !!(u.name && u.phone);
    const hold = parseInt(s.pickup_hold_minutes, 10) || 0;

    $('#drawerContent').innerHTML = `
      <div class="field">
        <label>Mode de réception</label>
        <div class="radio-row" role="radiogroup" aria-label="Mode de réception">
          ${modes.includes('delivery') ? `<div class="radio-card" role="radio" tabindex="0" data-mode="delivery">${ICONS.delivery} Livraison<small>À l'adresse de votre choix</small></div>` : ''}
          ${modes.includes('pickup') ? `<div class="radio-card" role="radio" tabindex="0" data-mode="pickup">${ICONS.pickup} Retrait sur place<small>Au restaurant</small></div>` : ''}
        </div>
      </div>

      <div id="deliveryFields">
        <div class="field">
          <label for="coAddress">Adresse de livraison</label>
          <textarea id="coAddress" placeholder="Quartier, rue, repères (ex. Akpakpa, face à la pharmacie, portail bleu)">${escapeHtml(u.address || '')}</textarea>
        </div>
        <div class="geo-box">
          <button class="btn secondary small" type="button" id="geoBtn">${ICONS.pin} Utiliser ma position actuelle</button>
          <div id="geoStatus" class="geo-status" aria-live="polite"></div>
        </div>
      </div>

      <div id="pickupFields">
        <div class="info-box">
          <strong>Retrait au restaurant</strong>
          ${s.address ? `<div>${escapeHtml(s.address)}</div>` : ''}
          ${s.hours ? `<div class="muted">${escapeHtml(s.hours)}</div>` : ''}
          ${s.pickup_instructions ? `<div class="mt-s">${escapeHtml(s.pickup_instructions)}</div>` : ''}
        </div>
        <div class="field">
          <label>Heure de retrait</label>
          <div class="radio-row">
            <div class="radio-card active" role="radio" tabindex="0" data-when="asap">Dès que possible<small>Nous vous prévenons quand c'est prêt</small></div>
            <div class="radio-card" role="radio" tabindex="0" data-when="later">À une heure précise<small>Commande à l'avance</small></div>
          </div>
          <input id="coPickupTime" type="datetime-local" class="hidden mt-s" value="${defaultPickupValue()}" min="${toLocalInput(new Date())}" aria-label="Date et heure de retrait" />
        </div>
        ${s.no_show_policy ? `<p class="policy-note">${hold ? `Votre commande sera conservée <strong>${hold} min</strong> après avoir été prête. ` : ''}${escapeHtml(s.no_show_policy)}</p>` : ''}
      </div>

      <div class="${hasSavedInfo ? 'saved-contact' : ''}" id="contactBlock">
        ${hasSavedInfo ? `<div class="between flex"><span><strong>${escapeHtml(u.name)}</strong> · ${escapeHtml(u.phone)}</span>
          <button class="link-btn small-link" type="button" id="editContact">Modifier</button></div>` : ''}
        <div id="contactFields" class="${hasSavedInfo ? 'hidden' : ''}">
          <div class="field">
            <label for="coName">Nom</label>
            <input id="coName" type="text" value="${escapeHtml(u.name || '')}" />
          </div>
          <div class="field">
            <label for="coPhone">Téléphone / contact</label>
            <input id="coPhone" type="tel" value="${escapeHtml(u.phone || '')}" placeholder="Ex. 90 00 00 00" />
          </div>
        </div>
      </div>

      <div class="field">
        <label for="coComment">Commentaire (optionnel)</label>
        <textarea id="coComment" placeholder="Ex. sans oignons, sonner à l'interphone…"></textarea>
      </div>
      <div class="field">
        <label>Mode de paiement</label>
        <div class="radio-row">
          <div class="radio-card active" data-pay="cash"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10h.01M18 14h.01"/></svg> Cash<small id="cashWhen">À la livraison</small></div>
          <div class="radio-card" data-pay="mobile_money"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M10 6h4M11 18h2"/></svg> Mobile Money<small>Bientôt disponible</small></div>
        </div>
      </div>
      <label class="check-line"><input type="checkbox" id="coRemember" checked /> Mémoriser mes informations pour mes prochaines commandes</label>
      <div class="checkout-sum">
        <div class="between flex"><span class="muted">Articles</span><span>${cartCount()}</span></div>
        <div class="cart-total" style="margin:6px 0 0"><span>Total</span><span>${fmtMoney(cartTotal())}</span></div>
      </div>
      <p class="muted" style="font-size:.8rem;margin-top:10px" id="payNote"></p>`;

    $$('#drawerContent [data-mode]').forEach((el) => {
      const pick = () => { fulfillment = el.dataset.mode; applyMode(); };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    $$('#drawerContent [data-when]').forEach((el) => {
      const pick = () => {
        pickupAsap = el.dataset.when === 'asap';
        $$('#drawerContent [data-when]').forEach((x) => x.classList.toggle('active', x === el));
        $('#coPickupTime').classList.toggle('hidden', pickupAsap);
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    $$('#drawerContent [data-pay]').forEach((el) =>
      el.addEventListener('click', () => {
        payMethod = el.dataset.pay;
        $$('#drawerContent [data-pay]').forEach((x) => x.classList.toggle('active', x === el));
      }));
    const edit = $('#editContact');
    if (edit) edit.addEventListener('click', () => { $('#contactFields').classList.remove('hidden'); edit.remove(); });
    $('#geoBtn').addEventListener('click', locate);

    applyMode();
    renderGeoStatus();

    $('#drawerFooter').innerHTML = `
      <button class="btn secondary" id="backCart" style="margin-bottom:8px">← Retour au panier</button>
      <button class="btn block success" id="placeOrder">Valider la commande</button>`;
    $('#backCart').addEventListener('click', renderCart);
    $('#placeOrder').addEventListener('click', placeOrder);
  }

  function applyMode() {
    const pickup = fulfillment === 'pickup';
    $$('#drawerContent [data-mode]').forEach((x) => {
      const on = x.dataset.mode === fulfillment;
      x.classList.toggle('active', on);
      x.setAttribute('aria-checked', String(on));
    });
    $('#deliveryFields').classList.toggle('hidden', pickup);
    $('#pickupFields').classList.toggle('hidden', !pickup);
    $('#cashWhen').textContent = pickup ? 'Au retrait' : 'À la livraison';
    $('#payNote').textContent = (pickup ? 'Le paiement se fait au retrait.' : 'Le paiement se fait à la livraison.') +
      ' Le paiement Mobile Money sera disponible prochainement.';
  }

  /* ---------- Géolocalisation du lieu de livraison ---------- */
  function renderGeoStatus(message, isError) {
    const box = $('#geoStatus');
    if (!box) return;
    if (message) { box.innerHTML = `<span class="${isError ? 'geo-error' : 'muted'}">${escapeHtml(message)}</span>`; return; }
    if (!geo) { box.innerHTML = '<span class="muted">Facultatif : aide le livreur à vous trouver plus facilement.</span>'; return; }
    box.innerHTML = `
      <span class="geo-ok">✓ ${geo.saved ? 'Position mémorisée' : 'Position enregistrée'}${geo.accuracy ? ` (précision ±${geo.accuracy} m)` : ''}</span>
      · <a href="${mapUrl(geo.lat, geo.lng)}" target="_blank" rel="noopener">Voir sur la carte</a>
      · <button type="button" class="link-btn small-link" id="geoClear">Retirer</button>`;
    $('#geoClear').addEventListener('click', () => { geo = null; renderGeoStatus(); });
  }

  function locate() {
    if (!('geolocation' in navigator)) { renderGeoStatus('La géolocalisation n\'est pas disponible sur cet appareil.', true); return; }
    if (!window.isSecureContext) { renderGeoStatus('La géolocalisation nécessite une connexion sécurisée (https).', true); return; }
    const btn = $('#geoBtn');
    btn.disabled = true;
    renderGeoStatus('Localisation en cours…');
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.disabled = false;
      geo = {
        lat: +pos.coords.latitude.toFixed(6),
        lng: +pos.coords.longitude.toFixed(6),
        accuracy: Math.round(pos.coords.accuracy),
      };
      renderGeoStatus();
    }, (err) => {
      btn.disabled = false;
      const msg = {
        1: 'Autorisation refusée. Activez la localisation pour ce site, ou saisissez simplement votre adresse.',
        2: 'Position introuvable pour le moment. Saisissez votre adresse.',
        3: 'La localisation a pris trop de temps. Réessayez ou saisissez votre adresse.',
      }[err.code] || 'Impossible d\'obtenir votre position.';
      renderGeoStatus(msg, true);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  async function placeOrder() {
    const name = $('#coName').value.trim();
    const phone = $('#coPhone').value.trim();
    const comment = $('#coComment').value.trim();
    const remember = $('#coRemember').checked;
    if (!name || !phone) {
      $('#contactFields').classList.remove('hidden');
      toast('Nom et contact requis', 'error'); return;
    }

    const body = {
      items: cart.map((c) => ({ product_id: c.product.id, quantity: c.qty })),
      comment, payment_method: payMethod, customer_name: name, customer_phone: phone,
      fulfillment, remember,
    };
    if (fulfillment === 'delivery') {
      body.delivery_address = $('#coAddress').value.trim();
      if (geo) { body.latitude = geo.lat; body.longitude = geo.lng; body.location_accuracy = geo.accuracy; }
      if (!body.delivery_address && !geo) {
        toast('Indiquez votre adresse ou utilisez votre position', 'error');
        $('#coAddress').focus(); return;
      }
    } else if (!pickupAsap) {
      const v = $('#coPickupTime').value;
      const when = v ? new Date(v) : null;
      if (!when || Number.isNaN(when.getTime())) { toast('Choisissez une heure de retrait', 'error'); return; }
      if (when.getTime() < Date.now()) { toast('Cette heure est déjà passée', 'error'); return; }
      body.pickup_time = when.toISOString();
    }

    $('#placeOrder').disabled = true;
    try {
      const { order } = await api('/orders', { method: 'POST', body });
      cart = []; saveCart(); updateCartUI(); renderProducts();
      closeDrawer();
      toast('Commande #' + order.id + ' envoyée ! Suivez-la dans « Mes commandes ».', 'success');
      if (remember) refreshProfile();
      await loadOrders();
      setView('orders');
    } catch (err) {
      toast(err.message, 'error');
    } finally { const b = $('#placeOrder'); if (b) b.disabled = false; }
  }

  /* ---------- Mes commandes + suivi ---------- */
  async function loadOrders() {
    if (!isClient()) return;
    try {
      const { orders } = await api('/orders/mine');
      myOrders = orders;
      renderOrders();
      const attention = orders.filter((o) => !FINAL_STATUSES.includes(o.status) || o.client_ack === 0).length;
      $('#ordersDot').innerHTML = attention ? `<span class="cart-badge">${attention}</span>` : '';
    } catch (err) { /* non connecté */ }
  }

  function renderTimeline(o) {
    if (o.status === 'cancelled') {
      return `<div class="badge st-cancelled" style="margin:8px 0">Commande annulée</div>`;
    }
    if (o.status === 'no_show') {
      return `<div class="badge st-cancelled" style="margin:8px 0">Commande non récupérée</div>`;
    }
    const flow = FLOWS[o.fulfillment] || FLOWS.delivery;
    const idx = flow.indexOf(o.status);
    return `<div class="timeline">` + flow.map((st, i) => {
      const cls = i < idx ? 'done' : (i === idx ? 'current' : '');
      return `<div class="tl-step ${cls}">
        <div class="dot-col"><div class="dot"></div>${i < flow.length - 1 ? '<div class="bar"></div>' : ''}</div>
        <div class="label"><div class="t">${STATUS_LABELS[st]}</div></div>
      </div>`;
    }).join('') + `</div>`;
  }

  function receptionInfo(o) {
    if (o.fulfillment === 'pickup') {
      return `<div class="order-meta"><span class="mode-pill pickup">${ICONS.pickup} ${FULFILLMENT_LABELS.pickup}</span>
        <span class="muted">${o.pickup_time ? 'Prévu ' + fmtTime(o.pickup_time) : 'Dès que possible'}</span></div>`;
    }
    return `<div class="order-meta"><span class="mode-pill delivery">${ICONS.delivery} ${FULFILLMENT_LABELS.delivery}</span>
      <span class="muted">${o.delivery_address ? escapeHtml(o.delivery_address) : 'Position GPS partagée'}</span>
      ${o.latitude != null ? `<a href="${mapUrl(o.latitude, o.longitude)}" target="_blank" rel="noopener">Carte</a>` : ''}</div>`;
  }

  /** Bandeau d'information lorsque le centre d'appels a modifié la commande. */
  function modificationNotice(o) {
    const mods = o.modifications || [];
    if (!mods.length) return '';
    const last = mods[0];
    const lines = last.summary.split('\n').map((l) => `<li>${escapeHtml(l)}</li>`).join('');
    if (o.client_ack === 0) {
      return `<div class="mod-alert" role="alert">
        <strong>Votre commande a été modifiée</strong>
        <div class="muted" style="font-size:.85rem">Suite à notre échange, le ${fmtDate(last.created_at)} :</div>
        <ul>${lines}</ul>
        ${last.note ? `<div style="font-size:.88rem">Motif : ${escapeHtml(last.note)}</div>` : ''}
        <div class="mod-total">Nouveau total : <s>${fmtMoney(last.old_total)}</s> <strong>${fmtMoney(last.new_total)}</strong></div>
        <button class="btn small" data-ack="${o.id}">J'ai pris connaissance</button>
      </div>`;
    }
    return `<details class="mod-history"><summary>Commande modifiée (${mods.length}) — voir le détail</summary>
      ${mods.map((m) => `<div class="mod-entry"><span class="muted">${fmtDate(m.created_at)}</span>
        <ul>${m.summary.split('\n').map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
        <span class="muted">Total : ${fmtMoney(m.old_total)} → ${fmtMoney(m.new_total)}</span></div>`).join('')}
    </details>`;
  }

  function readyNotice(o) {
    if (o.status !== 'ready') return '';
    const s = settings();
    const hold = parseInt(s.pickup_hold_minutes, 10) || 0;
    return `<div class="ready-alert" role="status">
      <strong>Votre commande est prête !</strong>
      <div>${escapeHtml(s.pickup_instructions || 'Vous pouvez venir la récupérer au restaurant.')}</div>
      ${s.address ? `<div class="muted">${escapeHtml(s.address)}</div>` : ''}
      ${hold ? `<div class="muted" style="font-size:.85rem">Conservée ${hold} min${o.ready_at ? ' (prête ' + fmtTime(o.ready_at) + ')' : ''}.</div>` : ''}
    </div>`;
  }

  function renderOrders() {
    if (!myOrders.length) {
      $('#ordersList').innerHTML = `
        <div class="empty">
          <div class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3v7M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3v18M17 3c2 2 3 4 3 7h-3"/></svg></div>
          <p>Vous n'avez pas encore de commande.</p>
          <button class="btn small" data-scroll="#menu">Découvrir le menu</button>
        </div>`;
      const b = $('#ordersList [data-scroll]');
      if (b) b.addEventListener('click', () => smoothTo('#menu'));
      return;
    }
    $('#ordersList').innerHTML = myOrders.map((o) => `
      <div class="card order-card${o.client_ack === 0 ? ' needs-attention' : ''}">
        <div class="head">
          <div>
            <div class="oid">Commande #${o.id}</div>
            <div class="muted" style="font-size:.85rem">${fmtDate(o.created_at)}</div>
          </div>
          ${badge(o.status)}
        </div>
        ${receptionInfo(o)}
        ${modificationNotice(o)}
        ${readyNotice(o)}
        <ul>${o.items.map((it) => `<li>${it.quantity} × ${escapeHtml(it.product_name)} — ${fmtMoney(it.unit_price * it.quantity)}</li>`).join('')}</ul>
        ${o.comment ? `<div class="muted" style="font-size:.85rem"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/></svg> ${escapeHtml(o.comment)}</div>` : ''}
        <div class="between flex mt">
          <span class="muted">Paiement : ${o.payment_method === 'mobile_money' ? 'Mobile Money' : (o.fulfillment === 'pickup' ? 'Cash au retrait' : 'Cash à la livraison')}</span>
          <strong>${fmtMoney(o.total)}</strong>
        </div>
        ${['cancelled', 'no_show'].includes(o.status) && o.cancel_reason ? `<div class="muted mt" style="font-size:.85rem">Motif : ${escapeHtml(o.cancel_reason)}</div>` : ''}
        ${renderTimeline(o)}
      </div>`).join('');

    $$('#ordersList [data-ack]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/orders/' + b.dataset.ack + '/ack', { method: 'POST' });
        toast('Merci, modification confirmée.', 'success');
        loadOrders();
      } catch (err) { toast(err.message, 'error'); b.disabled = false; }
    }));
  }

  /* ============================================================
     ÉVÉNEMENTS & BILLETTERIE (Restaurant, Boîte de nuit, Hôtel)
     ============================================================ */

  const VENUE_CONFIG = {
    restaurant: { label: '🍽️ Restaurant & Live', icon: '🍽️', tag: 'Restaurant & Gastronomie' },
    nightclub: { label: '🪩 Boîte de nuit', icon: '🪩', tag: 'Clubbing & Nightlife' },
    hotel: { label: '🏨 Événement Hôtel', icon: '🏨', tag: 'Hôtel & Villa Prestige' },
    lounge: { label: '🍸 Bar-Lounge', icon: '🍸', tag: 'Lounge & Rooftop' },
  };

  function formatEventDate(dateStr, timeStr) {
    if (!dateStr) return timeStr || '';
    try {
      const parts = dateStr.split('-');
      if (parts.length !== 3) return `${dateStr} · ${timeStr}`;
      const [y, m, d] = parts;
      const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
      const monthName = months[parseInt(m, 10) - 1] || m;
      return `${parseInt(d, 10)} ${monthName} ${y}${timeStr ? ' · ' + timeStr : ''}`;
    } catch (e) {
      return `${dateStr} · ${timeStr}`;
    }
  }

  async function loadEvents() {
    const grid = $('#eventsGrid');
    if (!grid) return;
    try {
      let query = '?status=published';
      if (currentVenueFilter && currentVenueFilter !== 'all') {
        query += '&venue_type=' + encodeURIComponent(currentVenueFilter);
      }
      if (eventSearchTerm && eventSearchTerm.trim()) {
        query += '&search=' + encodeURIComponent(eventSearchTerm.trim());
      }
      const data = await api('/evenements' + query);
      eventsList = data.events || [];
      renderEvents();
    } catch (err) {
      grid.innerHTML = `<p class="muted" style="grid-column:1/-1;text-align:center;padding:30px 0">Impossible de charger les événements actuellement.</p>`;
    }
  }

  function renderEvents() {
    const grid = $('#eventsGrid');
    if (!grid) return;
    if (!eventsList.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:48px 20px;background:var(--card);border-radius:18px;border:1px solid var(--line)">
          <div style="font-size:2.4rem;margin-bottom:12px">🎭</div>
          <h3 style="margin:0 0 8px">Aucun événement ne correspond à votre recherche</h3>
          <p class="muted" style="margin:0 0 16px">Essayez un autre mot-clé ou réinitialisez les filtres.</p>
          <button class="btn small secondary" id="resetEventFilters">Voir tous les événements</button>
        </div>`;
      const r = $('#resetEventFilters');
      if (r) r.addEventListener('click', () => {
        currentVenueFilter = 'all';
        eventSearchTerm = '';
        if ($('#eventSearchInput')) $('#eventSearchInput').value = '';
        $$('.venue-filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.venue === 'all'));
        loadEvents();
      });
      return;
    }

    grid.innerHTML = eventsList.map((ev) => {
      const venue = VENUE_CONFIG[ev.venue_type] || VENUE_CONFIG.restaurant;
      const fallbackImg = ev.venue_type === 'nightclub'
        ? 'https://images.unsplash.com/photo-1545128485-c400e7702796?auto=format&fit=crop&w=800&q=70'
        : (ev.venue_type === 'hotel'
          ? 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=800&q=70'
          : 'https://images.unsplash.com/photo-1555244162-803834f70033?auto=format&fit=crop&w=800&q=70');

      const img = isSafeImage(ev.image_url) ? ev.image_url : fallbackImg;
      const isSoldOut = ev.is_sold_out;

      return `
        <article class="event-card-dark" data-card-event="${ev.id}">
          <div class="event-card-image-wrap">
            <img src="${escapeHtml(img)}" alt="${escapeHtml(ev.title)}" loading="lazy" />
            <div class="event-card-overlay"></div>
            <span class="event-venue-type-tag">${venue.icon} ${venue.tag}</span>
            ${ev.badge ? `<span class="event-badge-glow">${escapeHtml(ev.badge)}</span>` : ''}
          </div>
          <div class="event-card-body">
            <div class="event-brands-row">
              <span>★ ${escapeHtml(ev.organizer || 'LE BON PLAT')}</span>
              <span>•</span>
              <span>${venue.icon} ${escapeHtml(ev.venue_name)}</span>
            </div>
            <h3 class="event-card-title">${escapeHtml(ev.title)}</h3>
            ${ev.subtitle ? `<div class="event-card-subtitle">${escapeHtml(ev.subtitle)}</div>` : ''}
            
            <div class="event-meta-list">
              <div class="event-meta-item">
                <span class="event-meta-icon">📍</span>
                <span>${escapeHtml(ev.venue_name)} · <strong>${escapeHtml(ev.location)}</strong></span>
              </div>
              <div class="event-meta-item">
                <span class="event-meta-icon">📅</span>
                <span>${formatEventDate(ev.event_date, ev.event_time)}</span>
              </div>
            </div>

            <p class="event-card-desc">${escapeHtml(ev.description || '')}</p>

            <div class="event-card-foot">
              <div class="event-price-box">
                <span class="event-price-label">${isSoldOut ? 'Statut' : 'Tarif'}</span>
                <span class="event-price-amount">${isSoldOut ? 'COMPLET' : (ev.min_price ? 'À partir de ' + fmtMoney(ev.min_price) : 'Entrée libre')}</span>
              </div>
              <button class="btn-book-ticket" data-book-event="${ev.id}" ${isSoldOut ? 'disabled' : ''}>
                ${isSoldOut ? 'Complet' : '🎫 Réserver maintenant'}
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    $$('[data-book-event]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const evId = parseInt(btn.dataset.bookEvent, 10);
        openTicketModal(evId);
      });
    });
  }

  // Recherche d'événement
  const searchForm = $('#eventSearchForm');
  if (searchForm) {
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      eventSearchTerm = ($('#eventSearchInput').value || '').trim();
      loadEvents();
    });
  }

  // Filtres par type d'espace (Boîte de nuit, Restaurant, Hôtel...)
  $$('#venueFilters .venue-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#venueFilters .venue-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentVenueFilter = btn.dataset.venue || 'all';
      loadEvents();
    });
  });

  /* ---------- Modale de réservation de billets ---------- */
  function openTicketModal(eventId) {
    const ev = eventsList.find((x) => x.id === eventId);
    if (!ev) return;

    const overlay = $('#ticketModalOverlay');
    const container = $('#ticketModalContent');
    if (!overlay || !container) return;

    const tickets = ev.ticket_types || [];
    if (!tickets.length) {
      toast('Aucun billet configuré pour cet événement.', 'error');
      return;
    }

    const u = Auth.user || {};
    let selectedTicketId = tickets[0].id;

    function renderModalForm() {
      const selectedTicket = tickets.find((t) => t.id === selectedTicketId) || tickets[0];
      const maxQty = Math.max(1, Math.min(10, selectedTicket.available_left || 10));

      container.innerHTML = `
        <div style="margin-bottom:18px">
          <span class="badge" style="background:#059669;color:#ffffff;margin-bottom:8px">Billetterie officielle</span>
          <h2 id="tktModalTitle" style="margin:4px 0 6px;font-size:1.35rem">${escapeHtml(ev.title)}</h2>
          <div class="muted" style="font-size:.88rem">📍 ${escapeHtml(ev.venue_name)} (${escapeHtml(ev.location)}) · 📅 ${formatEventDate(ev.event_date, ev.event_time)}</div>
        </div>

        <form id="ticketBookingForm">
          <label style="display:block;font-weight:700;margin-bottom:8px">1. Choisissez votre type de billet :</label>
          <div style="margin-bottom:18px">
            ${tickets.map((t) => {
              const sel = t.id === selectedTicketId;
              const soldOut = t.available_left <= 0;
              return `
                <div class="ticket-type-option ${sel ? 'selected' : ''}" data-tkt-id="${t.id}" style="${soldOut ? 'opacity:.5;cursor:not-allowed' : ''}">
                  <div style="display:flex;align-items:center;gap:12px">
                    <input type="radio" name="ticket_choice" value="${t.id}" ${sel ? 'checked' : ''} ${soldOut ? 'disabled' : ''} />
                    <div>
                      <strong style="color:var(--ink);font-size:1rem">${escapeHtml(t.name)}</strong>
                      ${t.description ? `<div class="muted" style="font-size:.82rem">${escapeHtml(t.description)}</div>` : ''}
                      <div style="font-size:.76rem;color:#059669;font-weight:600;margin-top:2px">
                        ${soldOut ? 'Complet' : `${t.available_left} places disponibles`}
                      </div>
                    </div>
                  </div>
                  <div style="font-family:var(--mono);font-weight:700;font-size:1.1rem;color:#059669">
                    ${fmtMoney(t.price)}
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <div class="field" style="margin-bottom:16px">
            <label for="modalTktQty" style="font-weight:700">2. Nombre de places :</label>
            <div style="display:flex;align-items:center;gap:12px">
              <input id="modalTktQty" type="number" min="1" max="${maxQty}" value="1" style="width:100px;font-family:var(--mono);font-size:1.1rem;font-weight:700;padding:8px" />
              <span class="muted" style="font-size:.85rem">Max ${maxQty} billet(s) par réservation</span>
            </div>
          </div>

          <div style="margin-bottom:18px;background:var(--card);padding:14px;border-radius:12px;border:1px solid var(--line)">
            <label style="display:block;font-weight:700;margin-bottom:10px">3. Coordonnées de l'acheteur :</label>
            <div class="field" style="margin-bottom:10px">
              <label for="modalTktName">Nom complet *</label>
              <input id="modalTktName" type="text" value="${escapeHtml(u.name || '')}" placeholder="Ex. Marc Houessou" required />
            </div>
            <div class="field" style="margin-bottom:10px">
              <label for="modalTktPhone">Numéro de téléphone (Mobile Money / SMS) *</label>
              <input id="modalTktPhone" type="tel" value="${escapeHtml(u.phone || '')}" placeholder="Ex. 97 00 00 00" required />
            </div>
            <div class="field">
              <label for="modalTktEmail">Email (optionnel, pour recevoir le e-ticket)</label>
              <input id="modalTktEmail" type="email" placeholder="Ex. marc@example.com" />
            </div>
          </div>

          <div style="margin-bottom:20px">
            <label style="display:block;font-weight:700;margin-bottom:8px">4. Mode de paiement :</label>
            <div class="radio-row">
              <div class="radio-card active" data-tkt-pay="momo_mtn">
                <span style="font-size:1.3rem">🟡</span> MTN MoMo
                <small>Paiement sécurisé</small>
              </div>
              <div class="radio-card" data-tkt-pay="momo_moov">
                <span style="font-size:1.3rem">🔵</span> Moov Money
                <small>Paiement sécurisé</small>
              </div>
              <div class="radio-card" data-tkt-pay="cash">
                <span style="font-size:1.3rem">💵</span> À l'entrée
                <small>Paiement sur place</small>
              </div>
            </div>
          </div>

          <div style="background:#ecfdf5;border:1.5px solid #a7f3d0;padding:14px 18px;border-radius:14px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-size:.82rem;text-transform:uppercase;color:#047857;font-weight:700">Total à payer</div>
              <div class="muted" style="font-size:.82rem" id="modalTktSummary">1 × ${escapeHtml(selectedTicket.name)}</div>
            </div>
            <div style="font-family:var(--mono);font-size:1.35rem;font-weight:800;color:#059669" id="modalTktTotal">
              ${fmtMoney(selectedTicket.price)}
            </div>
          </div>

          <button class="btn block success" id="submitTicketBtn" type="submit" style="padding:14px;font-size:1.05rem">
            🎟️ Confirmer &amp; Obtenir mon billet
          </button>
        </form>
      `;

      // Clic sur option de billet
      $$('.ticket-type-option').forEach((opt) => {
        opt.addEventListener('click', () => {
          const tId = parseInt(opt.dataset.tktId, 10);
          const target = tickets.find((x) => x.id === tId);
          if (!target || target.available_left <= 0) return;
          selectedTicketId = tId;
          renderModalForm();
        });
      });

      // Calcul dynamique sur changement de quantité
      const qtyInput = $('#modalTktQty');
      const updateTotalDisplay = () => {
        const q = Math.max(1, Math.min(maxQty, parseInt(qtyInput.value, 10) || 1));
        const tRow = tickets.find((x) => x.id === selectedTicketId) || tickets[0];
        $('#modalTktTotal').textContent = fmtMoney(tRow.price * q);
        $('#modalTktSummary').textContent = `${q} × ${tRow.name}`;
      };
      qtyInput.addEventListener('input', updateTotalDisplay);
      qtyInput.addEventListener('change', updateTotalDisplay);

      // Sélection paiement
      $$('[data-tkt-pay]').forEach((card) => {
        card.addEventListener('click', () => {
          $$('[data-tkt-pay]').forEach((c) => c.classList.remove('active'));
          card.classList.add('active');
        });
      });

      // Soumission formulaire de réservation
      $('#ticketBookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = $('#submitTicketBtn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Génération de votre billet...';

        const name = ($('#modalTktName').value || '').trim();
        const phone = ($('#modalTktPhone').value || '').trim();
        const email = ($('#modalTktEmail').value || '').trim();
        const qty = parseInt($('#modalTktQty').value, 10) || 1;
        const activePayCard = document.querySelector('[data-tkt-pay].active');
        const payMethod = activePayCard ? activePayCard.dataset.tktPay : 'momo_mtn';

        try {
          const bookingResult = await api('/tickets/book', {
            method: 'POST',
            body: {
              event_id: ev.id,
              ticket_type_id: selectedTicketId,
              quantity: qty,
              customer_name: name,
              customer_phone: phone,
              customer_email: email,
              payment_method: payMethod,
            },
          });

          toast('Billet réservé avec succès !', 'success');
          renderTicketSuccess(bookingResult);
          loadEvents();
          if (isClient()) loadMyTickets();
        } catch (err) {
          toast(err.message || 'Échec de la réservation.', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = '🎟️ Confirmer & Obtenir mon billet';
        }
      });
    }

    renderModalForm();
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeTicketModal() {
    const overlay = $('#ticketModalOverlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  const tktCloseBtn = $('#ticketModalClose');
  if (tktCloseBtn) tktCloseBtn.addEventListener('click', closeTicketModal);

  const tktOverlay = $('#ticketModalOverlay');
  if (tktOverlay) {
    tktOverlay.addEventListener('click', (e) => {
      if (e.target === tktOverlay) closeTicketModal();
    });
  }

  function renderTicketSuccess(bookingResult) {
    const container = $('#ticketModalContent');
    const { ticket, event, ticket_type } = bookingResult;

    const qrSvg = QRCodeGen.generateSvg(ticket.ticket_code, { size: 190, fg: '#0f172a' });

    container.innerHTML = `
      <div style="text-align:center;margin-bottom:14px">
        <div style="font-size:2.8rem">🎉</div>
        <h2 style="margin:2px 0 4px;font-size:1.3rem">Félicitations ! Votre billet est prêt</h2>
        <p class="muted" style="margin:0 0 16px;font-size:.88rem">Conservez précieusement ce e-ticket pour votre accès.</p>
      </div>

      <div class="e-ticket-card">
        <div class="e-ticket-header">
          <div class="e-ticket-brand">★ BILLET OFFICIEL ÉLECTRONIQUE</div>
          <h3 class="e-ticket-title">${escapeHtml(event.title)}</h3>
          <div class="e-ticket-venue">📍 ${escapeHtml(event.venue_name)} · ${escapeHtml(event.location)}</div>
        </div>
        <div class="e-ticket-tear"></div>
        <div class="e-ticket-body">
          <div class="e-ticket-qr-wrap">
            ${qrSvg}
          </div>
          <div><span class="e-ticket-code">${escapeHtml(ticket.ticket_code)}</span></div>
          <div class="e-ticket-grid">
            <div>
              <dt>Titulaire</dt>
              <dd>${escapeHtml(ticket.customer_name)}</dd>
            </div>
            <div>
              <dt>Formule</dt>
              <dd>${escapeHtml(ticket_type.name)} (${ticket.quantity} pers.)</dd>
            </div>
            <div>
              <dt>Date &amp; Heure</dt>
              <dd>${formatEventDate(event.event_date, event.event_time)}</dd>
            </div>
            <div>
              <dt>Total Réglé</dt>
              <dd>${fmtMoney(ticket.total_price)}</dd>
            </div>
          </div>
          <div style="margin: 12px 0">
            <span class="e-ticket-status-pill e-ticket-status-valid">● Billet Valide (Entrée autorisée)</span>
          </div>
          <p class="muted" style="font-size:0.82rem;margin: 8px 0 16px">Présentez ce QR code à l'accueil pour être scanné et composté.</p>
          <div class="flex" style="gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn secondary small" id="printTicketBtn">🖨️ Imprimer / Enregistrer</button>
            <button class="btn small" id="viewAllMyTicketsBtn">Voir tous mes billets</button>
            <button class="btn secondary small" id="closeTicketModalDoneBtn">Terminer</button>
          </div>
        </div>
      </div>
    `;

    $('#printTicketBtn').addEventListener('click', () => window.print());
    $('#viewAllMyTicketsBtn').addEventListener('click', () => {
      closeTicketModal();
      setView('tickets');
    });
    $('#closeTicketModalDoneBtn').addEventListener('click', closeTicketModal);
  }

  /* ---------- Mes Billets (vue client) ---------- */
  async function loadMyTickets() {
    if (!isClient()) return;
    try {
      const { tickets } = await api('/tickets/my');
      myTickets = tickets || [];
      renderMyTickets();
      const validCount = myTickets.filter((t) => t.status === 'valid').length;
      const dot = $('#ticketsDot');
      if (dot) dot.innerHTML = validCount ? `<span class="cart-badge">${validCount}</span>` : '';
    } catch (e) {
      /* non connecté ou aucun billet */
    }
  }

  function renderMyTickets() {
    const list = $('#ticketsList');
    if (!list) return;
    if (!myTickets.length) {
      list.innerHTML = `
        <div class="card empty-orders" style="padding:48px 24px;text-align:center">
          <div style="font-size:2.8rem;margin-bottom:12px">🎟️</div>
          <h3>Vous n'avez aucun billet pour le moment</h3>
          <p class="muted" style="margin:0 0 20px">Découvrez nos soirées clubbing, dîners-concerts et événements exclusifs.</p>
          <button class="btn" data-scroll="#events">Parcourir les événements</button>
        </div>`;
      $$('#ticketsList [data-scroll]').forEach((b) => b.addEventListener('click', () => smoothTo(b.dataset.scroll)));
      return;
    }

    list.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:28px">
        ${myTickets.map((t) => {
          const qrSvg = QRCodeGen.generateSvg(t.ticket_code, { size: 170, fg: '#0f172a' });
          const isValid = t.status === 'valid';
          const isUsed = t.status === 'used';

          return `
            <div class="e-ticket-card" style="margin:0">
              <div class="e-ticket-header">
                <div class="e-ticket-brand">★ BILLET OFFICIEL ÉLECTRONIQUE</div>
                <h3 class="e-ticket-title">${escapeHtml(t.event_title)}</h3>
                <div class="e-ticket-venue">📍 ${escapeHtml(t.venue_name)} · ${escapeHtml(t.event_location)}</div>
              </div>
              <div class="e-ticket-tear"></div>
              <div class="e-ticket-body">
                <div class="e-ticket-qr-wrap" style="${isUsed ? 'opacity:.4' : ''}">
                  ${qrSvg}
                </div>
                <div><span class="e-ticket-code">${escapeHtml(t.ticket_code)}</span></div>
                <div class="e-ticket-grid">
                  <div>
                    <dt>Titulaire</dt>
                    <dd>${escapeHtml(t.customer_name)}</dd>
                  </div>
                  <div>
                    <dt>Formule</dt>
                    <dd>${escapeHtml(t.ticket_type_name)} (${t.quantity} pers.)</dd>
                  </div>
                  <div>
                    <dt>Date &amp; Heure</dt>
                    <dd>${formatEventDate(t.event_date, t.event_time)}</dd>
                  </div>
                  <div>
                    <dt>Montant</dt>
                    <dd>${fmtMoney(t.total_price)}</dd>
                  </div>
                </div>
                <div style="margin: 12px 0">
                  <span class="e-ticket-status-pill ${isValid ? 'e-ticket-status-valid' : 'e-ticket-status-used'}">
                    ${isValid ? '● Billet Valide (Entrée autorisée)' : `✕ Composté le ${t.used_at || 'antérieurement'}`}
                  </span>
                </div>
                <div class="flex" style="gap:10px;justify-content:center">
                  <button class="btn secondary small" onclick="window.print()">🖨️ Imprimer</button>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  /* ---------- Temps réel ---------- */
  function startRealtime() {
    if (rt) rt.close();
    rt = connectRealtime((ev) => {
      if (ev.type === 'settings:update') { Brand.load().then(applyHome); return; }
      if (ev.type && ev.type.startsWith('event:')) { loadEvents(); }
      if (ev.type && ev.type.startsWith('ticket:')) {
        if (isClient()) loadMyTickets();
      }
      if (ev.type === 'order:update' || ev.type === 'order:new') {
        if (isClient()) loadOrders();
        const mine = ev.order && Auth.user && ev.order.customer_id === Auth.user.id;
        if (ev.type === 'order:update' && mine && ev.by !== 'client') {
          if (ev.modified) {
            toast('Commande #' + ev.order.id + ' modifiée — nouveau total ' + fmtMoney(ev.order.total) + '. Consultez « Mes commandes ».', 'success');
          } else if (ev.order.status === 'ready') {
            toast('Commande #' + ev.order.id + ' prête ! Vous pouvez venir la récupérer.', 'success');
          } else {
            toast('Commande #' + ev.order.id + ' : ' + STATUS_LABELS[ev.order.status], 'success');
          }
        }
      }
    }, (live) => {
      $('#rtDot').classList.toggle('live', live);
      $('#rtWrap').setAttribute('aria-label', live ? 'Connexion temps réel active' : 'Connexion temps réel inactive');
    });
  }

  boot();
})();
