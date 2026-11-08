/* Interface STAFF : call center, gérant, admin, développeur. */
(function () {
  const {
    Auth, api, toast, connectRealtime, Brand, applyBrand, isSafeImage, fmtMoney, fmtDate, fmtTime, mapUrl, badge, escapeHtml,
    STATUS_LABELS, FINAL_STATUSES, FULFILLMENT_LABELS,
  } = App;
  const $ = (s) => document.querySelector(s);

  // Onglets autorisés par rôle.
  const TABS_BY_ROLE = {
    callcenter: [{ id: 'orders', label: 'Commandes' }],
    manager:    [{ id: 'orders', label: 'Commandes' }, { id: 'dash', label: 'Tableau de bord' }],
    admin:      [{ id: 'orders', label: 'Commandes' }, { id: 'dash', label: 'Tableau de bord' }, { id: 'catalog', label: 'Catalogue' }, { id: 'brand', label: 'Personnalisation' }],
    developer:  [{ id: 'catalog', label: 'Catalogue' }, { id: 'brand', label: 'Personnalisation' }],
  };
  // Rôles qui reçoivent les alertes de nouvelles commandes et peuvent modifier une commande.
  const ALERT_ROLES = ['callcenter', 'manager', 'admin'];
  const EDIT_ROLES = ['callcenter', 'manager', 'admin'];
  const EDITABLE_STATUSES = ['pending', 'accepted', 'preparing'];

  let orders = [];
  let catalog = { categories: [], products: [] };
  let rt = null;
  let currentTab = null;

  Brand.load();

  function boot() {
    const user = Auth.user;
    if (!Auth.isLogged() || !user || user.role === 'client') { showLogin(); return; }
    showApp();
  }

  function showLogin() { $('#loginScreen').classList.remove('hidden'); $('#app').classList.add('hidden'); }

  async function showApp() {
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const user = Auth.user;
    $('#roleLabel').textContent = user.roleLabel || user.role;

    const tabs = TABS_BY_ROLE[user.role] || [];
    $('#staffNav').innerHTML = tabs.map((t, i) =>
      `<button data-tab="${t.id}" class="${i === 0 ? 'active' : ''}">${t.label}</button>`).join('');
    $('#staffNav').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => setTab(b.dataset.tab)));

    startRealtime();
    setTab(tabs[0] ? tabs[0].id : 'orders');
    if (ALERT_ROLES.includes(user.role)) initAlerts();
  }

  $('#staffLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token, user } = await api('/auth/login', {
        method: 'POST',
        body: { username: $('#username').value.trim(), password: $('#password').value },
      });
      Auth.set(token, user);
      unlockAudio();   // la connexion est un geste utilisateur : le son est autorisé
      showApp();
      toast('Connecté — ' + (user.roleLabel || user.role), 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#logoutBtn').addEventListener('click', () => { Auth.clear(); if (rt) rt.close(); location.reload(); });

  function setTab(tab) {
    currentTab = tab;
    $('#staffNav').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#viewOrders').classList.toggle('hidden', tab !== 'orders');
    $('#viewDash').classList.toggle('hidden', tab !== 'dash');
    $('#viewCatalog').classList.toggle('hidden', tab !== 'catalog');
    $('#viewBrand').classList.toggle('hidden', tab !== 'brand');
    if (tab === 'orders') loadOrders();
    if (tab === 'dash') loadStats();
    if (tab === 'catalog') loadCatalog();
    if (tab === 'brand') loadBrandForm();
  }

  /* =========================================================
     Alertes des nouvelles commandes : son répété + bandeau
     clignotant + titre d'onglet + notification du navigateur.
     L'alerte se répète tant qu'une nouvelle commande n'a pas
     été prise en charge (acceptée / annulée) ou vue.
     ========================================================= */
  const REPEAT_MS = 20000;
  const Alerts = {
    ctx: null,
    soundOn: localStorage.getItem('resto_sound') !== 'off',
    waiting: new Map(),   // id -> commande en attente non encore vue
    repeatTimer: null,
    titleTimer: null,
  };

  function audioCtx() {
    if (!Alerts.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      Alerts.ctx = new Ctx();
    }
    return Alerts.ctx;
  }

  function unlockAudio() {
    const ctx = audioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().then(updateAudioHint).catch(() => {});
    else updateAudioHint();
  }
  // Les navigateurs bloquent le son tant que l'utilisateur n'a pas interagi avec la page.
  ['pointerdown', 'keydown'].forEach((evt) => document.addEventListener(evt, unlockAudio, { capture: true }));

  function audioReady() {
    const ctx = Alerts.ctx;
    return !!ctx && ctx.state === 'running';
  }

  function updateAudioHint() {
    const relevant = Auth.user && ALERT_ROLES.includes(Auth.user.role);
    const needsClick = relevant && Alerts.soundOn && !audioReady();
    const canAskNotif = relevant && 'Notification' in window && Notification.permission === 'default';
    $('#audioHint').classList.toggle('hidden', !needsClick && !canAskNotif);
    $('#audioHint').firstElementChild.firstChild.textContent = needsClick
      ? "Cliquez n'importe où sur la page pour activer l'alerte sonore des nouvelles commandes. "
      : '';
    $('#notifPermBtn').classList.toggle('hidden', !canAskNotif);
  }

  /** Carillon de 3 notes généré (aucun fichier audio requis), joué deux fois. */
  function playChime() {
    if (!Alerts.soundOn) return;
    const ctx = audioCtx();
    if (!ctx || ctx.state !== 'running') { updateAudioHint(); return; }
    const t0 = ctx.currentTime + 0.02;
    const notes = [880, 1175, 1568];
    [0, 0.75].forEach((offset) => {
      notes.forEach((freq, i) => {
        const start = t0 + offset + i * 0.16;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.45, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.45);
      });
    });
  }

  function renderSoundToggle() {
    const b = $('#soundToggle');
    b.classList.remove('hidden');
    b.setAttribute('aria-pressed', String(Alerts.soundOn));
    b.classList.toggle('off', !Alerts.soundOn);
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>${Alerts.soundOn ? '' : '<path d="M3 3l18 18"/>'}</svg> Son ${Alerts.soundOn ? 'activé' : 'coupé'}`;
  }
  $('#soundToggle').addEventListener('click', () => {
    Alerts.soundOn = !Alerts.soundOn;
    localStorage.setItem('resto_sound', Alerts.soundOn ? 'on' : 'off');
    renderSoundToggle();
    updateAudioHint();
    if (Alerts.soundOn) { unlockAudio(); setTimeout(playChime, 50); }   // test immédiat du son
  });

  $('#notifPermBtn').addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch (e) {}
    updateAudioHint();
  });

  function desktopNotify(order) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      const n = new Notification('Nouvelle commande #' + order.id, {
        body: `${order.customer_name} · ${FULFILLMENT_LABELS[order.fulfillment] || ''} · ${fmtMoney(order.total)}`,
        tag: 'order-' + order.id,
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); showWaitingOrders(); n.close(); };
    } catch (e) { /* certains navigateurs refusent hors service worker */ }
  }

  function renderAlertBanner() {
    const n = Alerts.waiting.size;
    if (!n) { $('#orderAlert').classList.add('hidden'); return; }
    const list = [...Alerts.waiting.values()];
    const last = list[list.length - 1];
    $('#orderAlertTitle').textContent = n > 1 ? `${n} nouvelles commandes en attente` : `Nouvelle commande #${last.id}`;
    $('#orderAlertSub').textContent = n > 1
      ? ' — dernière : #' + last.id + ' · ' + last.customer_name
      : ` — ${last.customer_name} · ${FULFILLMENT_LABELS[last.fulfillment] || ''} · ${fmtMoney(last.total)}`;
    $('#orderAlert').classList.remove('hidden');
  }

  function flashTitle() {
    clearInterval(Alerts.titleTimer);
    let on = false;
    Alerts.titleTimer = setInterval(() => {
      on = !on;
      const base = (Brand.settings && Brand.settings.name ? Brand.settings.name : 'Staff') + ' — Espace Staff';
      document.title = on ? `(${Alerts.waiting.size}) Nouvelle commande !` : base;
    }, 1000);
  }

  function startAlert() {
    renderAlertBanner();
    playChime();
    flashTitle();
    clearInterval(Alerts.repeatTimer);
    Alerts.repeatTimer = setInterval(() => {
      if (!Alerts.waiting.size) return stopAlert();
      playChime();
    }, REPEAT_MS);
    if (currentTab === 'orders') renderOrders();
  }

  function stopAlert() {
    Alerts.waiting.clear();
    clearInterval(Alerts.repeatTimer);
    clearInterval(Alerts.titleTimer);
    Alerts.repeatTimer = Alerts.titleTimer = null;
    if (Brand.settings) applyBrand(Brand.settings); else document.title = 'Espace Staff';
    renderAlertBanner();
    if (currentTab === 'orders') renderOrders();
  }

  /** Une commande a changé : si elle n'est plus en attente, l'alerte la concernant s'arrête. */
  function alertOrderChanged(order) {
    if (!Alerts.waiting.has(order.id) || order.status === 'pending') return;
    Alerts.waiting.delete(order.id);
    if (!Alerts.waiting.size) stopAlert(); else renderAlertBanner();
  }

  function newOrderAlert(order) {
    Alerts.waiting.set(order.id, order);
    desktopNotify(order);
    startAlert();
  }

  function showWaitingOrders() {
    const first = [...Alerts.waiting.keys()][0];
    $('#statusFilter').value = '';
    $('#modeFilter').value = '';
    stopAlert();
    setTab('orders');
    setTimeout(() => {
      const el = document.querySelector(`[data-order="${first}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('is-new'); }
    }, 400);
  }
  $('#orderAlertShow').addEventListener('click', showWaitingOrders);
  $('#orderAlertMute').addEventListener('click', stopAlert);

  /** À la connexion : signaler les commandes arrivées pendant que personne n'était connecté. */
  async function initAlerts() {
    renderSoundToggle();
    updateAudioHint();
    try {
      const { orders: waiting } = await api('/orders?status=pending');
      if (waiting.length) {
        waiting.reverse().forEach((o) => Alerts.waiting.set(o.id, o));
        startAlert();
      }
    } catch (e) {}
  }

  /* ---------- Commandes ---------- */
  $('#refreshOrders').addEventListener('click', () => loadOrders());
  $('#statusFilter').addEventListener('change', () => loadOrders());
  $('#modeFilter').addEventListener('change', () => loadOrders());

  async function loadOrders() {
    if (!orders.length) $('#ordersContainer').innerHTML = '<div class="empty" aria-live="polite">Chargement des commandes…</div>';
    $('#refreshOrders').disabled = true;
    try {
      const qs = new URLSearchParams();
      if ($('#statusFilter').value) qs.set('status', $('#statusFilter').value);
      if ($('#modeFilter').value) qs.set('fulfillment', $('#modeFilter').value);
      const { orders: list } = await api('/orders' + (qs.toString() ? '?' + qs : ''));
      orders = list;
      renderOrders();
      renderStatBar();
    } catch (err) {
      toast(err.message, 'error');
      $('#ordersContainer').innerHTML = '<div class="empty">Impossible de charger les commandes.</div>';
    } finally {
      $('#refreshOrders').disabled = false;
    }
  }

  function renderStatBar() {
    // Barre de compteurs basée sur les commandes affichées (selon les filtres).
    const counts = {};
    orders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
    const cells = [
      ['En attente', counts.pending || 0],
      ['Acceptées', counts.accepted || 0],
      ['En préparation', counts.preparing || 0],
      ['En livraison', counts.delivering || 0],
      ['Prêtes à retirer', counts.ready || 0],
      ['Livrées / retirées', (counts.delivered || 0) + (counts.picked_up || 0)],
    ];
    $('#statBar').innerHTML = cells.map(([l, n]) =>
      `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  }

  const role = () => Auth.user.role;

  const NEXT_STATUS = {
    delivery: { pending: 'preparing', accepted: 'preparing', preparing: 'delivering', delivering: 'delivered' },
    pickup:   { pending: 'preparing', accepted: 'preparing', preparing: 'ready', ready: 'picked_up' },
  };

  function actionButtons(o) {
    const r = role();
    const btns = [];
    if (FINAL_STATUSES.includes(o.status)) return '';

    // Call center : accepter / annuler une commande en attente.
    if (r === 'callcenter') {
      if (o.status === 'pending') {
        btns.push(`<button class="btn success small" data-act="accepted" data-id="${o.id}">✓ Accepter</button>`);
        btns.push(`<button class="btn danger small" data-act="cancel" data-id="${o.id}">✕ Annuler</button>`);
      }
    }

    // Gérant / Admin : faire avancer la commande selon son mode de réception.
    if (r === 'manager' || r === 'admin') {
      const next = (NEXT_STATUS[o.fulfillment] || NEXT_STATUS.delivery)[o.status];
      if (next) {
        btns.push(`<button class="btn small" data-act="${next}" data-id="${o.id}">→ ${STATUS_LABELS[next]}</button>`);
      }
      if (o.status === 'ready') {
        btns.push(`<button class="btn secondary small" data-act="no_show" data-id="${o.id}">Non récupérée</button>`);
      }
      btns.push(`<button class="btn danger small" data-act="cancel" data-id="${o.id}">Annuler</button>`);
    }

    // Modification après échange avec le client.
    if (EDIT_ROLES.includes(r) && EDITABLE_STATUSES.includes(o.status)) {
      btns.push(`<button class="btn secondary small" data-edit-order="${o.id}">Modifier la commande</button>`);
    }
    return btns.length ? `<div class="actions">${btns.join('')}</div>` : '';
  }

  const PIN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>';

  function receptionBlock(o) {
    if (o.fulfillment === 'pickup') {
      const hold = parseInt((Brand.settings || {}).pickup_hold_minutes, 10) || 0;
      const overdue = o.status === 'ready' && o.ready_at && hold &&
        Date.now() - new Date(o.ready_at.replace(' ', 'T') + 'Z').getTime() > hold * 60000;
      return `<div class="order-meta">
        <span class="mode-pill pickup">${FULFILLMENT_LABELS.pickup}</span>
        <span>${o.pickup_time ? '<strong>Retrait prévu ' + fmtTime(o.pickup_time) + '</strong>' : 'Retrait dès que possible'}</span>
        ${o.status === 'ready' && o.ready_at ? `<span class="muted">· prête ${fmtTime(o.ready_at)}</span>` : ''}
        ${overdue ? '<span class="warn-pill">Délai de conservation dépassé</span>' : ''}
      </div>`;
    }
    return `<div class="order-meta">
      <span class="mode-pill delivery">${FULFILLMENT_LABELS.delivery}</span>
      <span>${PIN} ${o.delivery_address ? escapeHtml(o.delivery_address) : '<em>Adresse non saisie — position GPS</em>'}</span>
      ${o.latitude != null ? `<a href="${mapUrl(o.latitude, o.longitude)}" target="_blank" rel="noopener">Voir sur la carte${o.location_accuracy ? ' (±' + Math.round(o.location_accuracy) + ' m)' : ''}</a>` : ''}
    </div>`;
  }

  function modificationBlock(o) {
    const mods = o.modifications || [];
    if (!mods.length) return '';
    const last = mods[0];
    return `<div class="mod-staff">
      <div><strong>Modifiée</strong> par ${escapeHtml(last.user_name || 'le staff')} · ${fmtDate(last.created_at)}
        ${o.client_ack === 0
          ? '<span class="warn-pill">Client pas encore informé dans l\'appli</span>'
          : '<span class="ok-pill">Client a pris connaissance</span>'}</div>
      <ul>${last.summary.split('\n').map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      ${last.note ? `<div class="muted">Motif : ${escapeHtml(last.note)}</div>` : ''}
      <div class="muted">Total : ${fmtMoney(last.old_total)} → <strong>${fmtMoney(last.new_total)}</strong>${mods.length > 1 ? ` · ${mods.length} modifications au total` : ''}</div>
    </div>`;
  }

  function renderOrders() {
    if (!orders.length) {
      $('#ordersContainer').innerHTML = '<div class="empty">Aucune commande.</div>';
      return;
    }
    $('#ordersContainer').innerHTML = orders.map((o) => `
      <div class="card order-card${Alerts.waiting.has(o.id) ? ' is-new' : ''}" data-order="${o.id}">
        <div class="head">
          <div>
            <span class="oid">Commande #${o.id}</span>
            <span class="muted"> · ${fmtDate(o.created_at)}</span><br/>
            <span class="muted"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5 20c.8-3.2 3-5 7-5s6.2 1.8 7 5"/></svg> ${escapeHtml(o.customer_name)} · <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h3l2 5-2 1.5a14 14 0 0 0 5.5 5.5L16 13l5 2v3c0 1.1-.9 2-2 2C10.7 20 4 13.3 4 5a2 2 0 0 1 2-2Z"/></svg> <a href="tel:${escapeHtml(o.customer_phone)}">${escapeHtml(o.customer_phone)}</a></span>
          </div>
          ${badge(o.status)}
        </div>
        ${receptionBlock(o)}
        <ul>${o.items.map((it) => `<li>${it.quantity} × ${escapeHtml(it.product_name)} — ${fmtMoney(it.unit_price * it.quantity)}</li>`).join('')}</ul>
        ${o.comment ? `<div class="muted" style="font-size:.86rem"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/></svg> ${escapeHtml(o.comment)}</div>` : ''}
        ${modificationBlock(o)}
        <div class="between flex mt">
          <span class="muted">${o.payment_method === 'mobile_money' ? 'Mobile Money' : (o.fulfillment === 'pickup' ? 'Cash au retrait' : 'Cash à la livraison')}</span>
          <strong>${fmtMoney(o.total)}</strong>
        </div>
        ${['cancelled', 'no_show'].includes(o.status) && o.cancel_reason ? `<div class="muted mt" style="font-size:.85rem">Motif : ${escapeHtml(o.cancel_reason)}</div>` : ''}
        ${actionButtons(o)}
      </div>`).join('');

    $('#ordersContainer').querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => handleAction(parseInt(b.dataset.id, 10), b.dataset.act)));
    $('#ordersContainer').querySelectorAll('[data-edit-order]').forEach((b) =>
      b.addEventListener('click', () => openOrderEditor(parseInt(b.dataset.editOrder, 10))));
  }

  async function handleAction(id, act) {
    let body;
    if (act === 'cancel') {
      const reason = prompt('Motif de l\'annulation (optionnel) :');
      if (reason === null) return;
      body = { status: 'cancelled', cancel_reason: reason };
    } else if (act === 'no_show') {
      const reason = prompt('Le client n\'est pas venu récupérer sa commande.\nCommentaire (optionnel) :', 'Commande non récupérée par le client.');
      if (reason === null) return;
      body = { status: 'no_show', cancel_reason: reason };
    } else {
      body = { status: act };
    }
    try {
      await api('/orders/' + id + '/status', { method: 'PATCH', body });
      toast('Commande #' + id + ' → ' + STATUS_LABELS[body.status], 'success');
      loadOrders();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* =========================================================
     Modification d'une commande (centre d'appels) :
     remplacement d'un produit indisponible, ajout, retrait,
     quantités — avec recalcul du total et accord du client.
     ========================================================= */
  let editor = null;   // { order, lines: [{ product_id, product_name, unit_price, quantity, replaces, origin }], menu }

  async function openOrderEditor(id) {
    const order = orders.find((o) => o.id === id);
    if (!order) return;
    let menu;
    try { menu = (await api('/menu')).categories; }
    catch (err) { toast('Impossible de charger les produits disponibles', 'error'); return; }

    const available = new Set(menu.flatMap((c) => c.products.map((p) => p.id)));
    const lines = [];
    order.items.forEach((it) => {
      const existing = lines.find((l) => l.product_id === it.product_id);
      if (existing) { existing.quantity += it.quantity; return; }
      lines.push({
        product_id: it.product_id, product_name: it.product_name, unit_price: it.unit_price,
        quantity: it.quantity, replaces: null, origin: true, unavailable: !available.has(it.product_id),
      });
    });
    editor = { order, lines, menu };
    renderOrderEditor();
    openDrawer();
  }

  function editorProduct(pid) {
    for (const c of editor.menu) { const p = c.products.find((x) => x.id === pid); if (p) return p; }
    return null;
  }
  function productOptions(excludeIds) {
    return editor.menu.map((c) => {
      const opts = c.products.filter((p) => !excludeIds.includes(p.id))
        .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} — ${fmtMoney(p.price)}</option>`).join('');
      return opts ? `<optgroup label="${escapeHtml(c.name)}">${opts}</optgroup>` : '';
    }).join('');
  }
  const editorTotal = () => editor.lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);

  function renderOrderEditor() {
    const { order, lines } = editor;
    const used = lines.map((l) => l.product_id);
    const newTotal = editorTotal();
    const diff = newTotal - order.total;
    $('#drawerTitle').textContent = 'Modifier la commande #' + order.id;
    $('#drawerContent').innerHTML = `
      <p class="muted" style="margin-top:0;font-size:.88rem">
        Client : <strong>${escapeHtml(order.customer_name)}</strong> · <a href="tel:${escapeHtml(order.customer_phone)}">${escapeHtml(order.customer_phone)}</a><br/>
        Appelez le client et obtenez son accord avant d'enregistrer. Un produit de remplacement est facturé à son propre prix.
      </p>
      <div class="edit-lines">
        ${lines.map((l, i) => {
          const replaced = l.replaces != null ? order.items.find((it) => it.product_id === l.replaces) : null;
          return `<div class="edit-line${l.unavailable ? ' unavailable' : ''}">
            <div class="el-info">
              <strong>${escapeHtml(l.product_name)}</strong>
              ${l.unavailable ? '<span class="warn-pill">Indisponible</span>' : ''}
              ${replaced ? `<span class="ok-pill">remplace ${escapeHtml(replaced.product_name)}</span>` : ''}
              ${!l.origin && !replaced ? '<span class="ok-pill">ajouté</span>' : ''}
              <div class="muted" style="font-size:.84rem">${fmtMoney(l.unit_price)} l'unité · ${fmtMoney(l.unit_price * l.quantity)}</div>
            </div>
            <div class="qty">
              <button type="button" data-eq="${i}" data-d="-1" aria-label="Diminuer">−</button>
              <span>${l.quantity}</span>
              <button type="button" data-eq="${i}" data-d="1" aria-label="Augmenter">+</button>
            </div>
            <div class="el-actions">
              <select data-replace="${i}" aria-label="Remplacer ${escapeHtml(l.product_name)} par">
                <option value="">Remplacer par…</option>${productOptions(used)}
              </select>
              <button type="button" class="link-btn small-link danger-link" data-remove="${i}">Retirer</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="field mt">
        <label for="editAdd">Ajouter un article</label>
        <div class="flex">
          <select id="editAdd"><option value="">Choisir un produit…</option>${productOptions(used)}</select>
          <button type="button" class="btn secondary small" id="editAddBtn">Ajouter</button>
        </div>
      </div>
      <div class="card edit-total">
        <div class="between flex"><span class="muted">Total initial</span><span>${fmtMoney(order.total)}</span></div>
        <div class="cart-total" style="margin:4px 0 0"><span>Nouveau total</span><span>${fmtMoney(newTotal)}</span></div>
        ${diff ? `<div class="muted" style="text-align:right;font-size:.85rem">${diff > 0 ? '+' : '−'} ${fmtMoney(Math.abs(diff))}</div>` : ''}
      </div>
      <div class="field mt">
        <label for="editNote">Motif (communiqué au client)</label>
        <textarea id="editNote" placeholder="Ex. Coca-Cola indisponible, remplacé par un Panta avec l'accord du client.">${escapeHtml(editor.note || '')}</textarea>
      </div>
      <label class="check-line strong"><input type="checkbox" id="editAgreed" ${editor.agreed ? 'checked' : ''} /> Le client a donné son accord pour ces modifications</label>`;

    const keepNote = () => { editor.note = $('#editNote').value; editor.agreed = $('#editAgreed').checked; };
    $('#drawerContent').querySelectorAll('[data-eq]').forEach((b) => b.addEventListener('click', () => {
      keepNote();
      const l = editor.lines[parseInt(b.dataset.eq, 10)];
      l.quantity = Math.max(1, Math.min(99, l.quantity + parseInt(b.dataset.d, 10)));
      renderOrderEditor();
    }));
    $('#drawerContent').querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      keepNote();
      if (editor.lines.length === 1) { toast('Une commande doit garder au moins un article. Pour tout retirer, annulez-la.', 'error'); return; }
      editor.lines.splice(parseInt(b.dataset.remove, 10), 1);
      renderOrderEditor();
    }));
    $('#drawerContent').querySelectorAll('[data-replace]').forEach((sel) => sel.addEventListener('change', () => {
      if (!sel.value) return;
      keepNote();
      const i = parseInt(sel.dataset.replace, 10);
      const old = editor.lines[i];
      const p = editorProduct(parseInt(sel.value, 10));
      editor.lines[i] = {
        product_id: p.id, product_name: p.name, unit_price: p.price, quantity: old.quantity,
        replaces: old.origin ? old.product_id : old.replaces, origin: false, unavailable: false,
      };
      if (!$('#editNote').value.trim() && old.origin) {
        editor.note = `${old.product_name}${old.unavailable ? ' indisponible,' : ''} remplacé par ${p.name}.`;
      }
      renderOrderEditor();
    }));
    $('#editAddBtn').addEventListener('click', () => {
      const pid = parseInt($('#editAdd').value, 10);
      if (!pid) return;
      keepNote();
      const p = editorProduct(pid);
      editor.lines.push({ product_id: p.id, product_name: p.name, unit_price: p.price, quantity: 1, replaces: null, origin: false, unavailable: false });
      renderOrderEditor();
    });

    $('#drawerFooter').innerHTML = `
      <button class="btn secondary" type="button" id="editCancel" style="margin-bottom:8px">Fermer sans enregistrer</button>
      <button class="btn block" type="button" id="editSave">Enregistrer et informer le client</button>`;
    $('#editCancel').addEventListener('click', closeDrawer);
    $('#editSave').addEventListener('click', saveOrderEdit);
  }

  async function saveOrderEdit() {
    if (!$('#editAgreed').checked) {
      toast('Cochez la case confirmant l\'accord du client.', 'error');
      $('#editAgreed').focus();
      return;
    }
    const body = {
      items: editor.lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, replaces: l.replaces })),
      note: $('#editNote').value.trim(),
      client_agreed: true,
    };
    $('#editSave').disabled = true;
    try {
      const { order } = await api('/orders/' + editor.order.id + '/items', { method: 'PUT', body });
      toast(`Commande #${order.id} modifiée — nouveau total ${fmtMoney(order.total)}. Le client est notifié.`, 'success');
      closeDrawer();
      editor = null;
      loadOrders();
    } catch (err) {
      toast(err.message, 'error');
      $('#editSave').disabled = false;
    }
  }

  /* ---------- Tableau de bord (statistiques par journée) ---------- */
  const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('#dashDate').value = localISO(new Date());
  $('#dashDate').max = localISO(new Date());
  $('#dashDate').addEventListener('change', loadStats);
  $('#dayToday').addEventListener('click', () => { $('#dashDate').value = localISO(new Date()); loadStats(); });
  function shiftDay(delta) {
    const d = new Date($('#dashDate').value + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    if (d > new Date()) return;
    $('#dashDate').value = localISO(d);
    loadStats();
  }
  $('#dayPrev').addEventListener('click', () => shiftDay(-1));
  $('#dayNext').addEventListener('click', () => shiftDay(1));

  async function loadStats() {
    const date = $('#dashDate').value || localISO(new Date());
    const tz = -new Date(date + 'T12:00:00').getTimezoneOffset();
    $('#dayNext').disabled = date >= localISO(new Date());
    try {
      const data = await api(`/orders/stats?date=${date}&tz=${tz}`);
      renderDash(data);
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderDash({ day, history, top, in_progress: inProgress }) {
    const isToday = day.date === localISO(new Date());
    const label = new Date(day.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('#dashDayLabel').textContent = (isToday ? "Aujourd'hui — " : '') + label;

    const cells = [
      ['Commandes livrées', day.delivered, 'accent', fmtMoney(day.revenue_delivery)],
      ['Retirées sur place', day.picked_up, 'accent', fmtMoney(day.revenue_pickup)],
      ['Recettes du jour', fmtMoney(day.revenue), '', 'livrées + retirées'],
      ['Commandes reçues', day.created_total, '', `${day.created_delivery} livraison · ${day.created_pickup} retrait`],
      ['Non récupérées', day.no_show, day.no_show ? 'warn' : '', ''],
      ['Annulées', day.cancelled, '', ''],
    ];
    if (isToday) cells.push(['En cours (maintenant)', inProgress, '', '']);
    $('#dashStats').innerHTML = cells.map(([l, n, cls, sub]) =>
      `<div class="card stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`).join('');

    const max = Math.max(1, ...history.map((h) => h.delivered + h.picked_up));
    $('#dashHistory').innerHTML = `
      <div class="legend"><span class="sw del"></span> Livrées <span class="sw pick"></span> Retirées</div>
      <div class="hist">${history.map((h) => {
        const d = new Date(h.date + 'T12:00:00');
        return `<button type="button" class="hist-row${h.date === day.date ? ' current' : ''}" data-day="${h.date}">
          <span class="hd">${d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
          <span class="hb">
            <span class="bar del" style="width:${(h.delivered / max) * 100}%"></span><span class="bar pick" style="width:${(h.picked_up / max) * 100}%"></span>
          </span>
          <span class="hn">${h.delivered} · ${h.picked_up}</span>
        </button>`;
      }).join('')}</div>`;
    $('#dashHistory').querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      $('#dashDate').value = b.dataset.day; loadStats();
    }));

    $('#dashDetail').innerHTML = top.length
      ? '<ul>' + top.map((t) => `<li>${escapeHtml(t.name)} — ${t.qty} commandé(s)</li>`).join('') + '</ul>'
      : '<p class="muted">Aucune commande ce jour-là.</p>';
  }

  /* ---------- Catalogue (développeur / admin) ---------- */
  async function loadCatalog() {
    try {
      catalog = await api('/products');
      renderCatalog();
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderCatalog() {
    $('#catManage').innerHTML = catalog.categories.map((c) =>
      `<span class="badge" style="background:#efe8df;color:#2b2118">${escapeHtml(c.name)}
        <button class="close-x" style="font-size:1rem" data-delcat="${c.id}" title="Supprimer">×</button></span>`).join('') ||
      '<span class="muted">Aucune catégorie</span>';
    $('#catManage').querySelectorAll('[data-delcat]').forEach((b) =>
      b.addEventListener('click', () => deleteCategory(parseInt(b.dataset.delcat, 10))));

    const catName = (id) => (catalog.categories.find((c) => c.id === id) || {}).name || '—';
    $('#productRows').innerHTML = catalog.products.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong><br/><span class="muted" style="font-size:.82rem">${escapeHtml(p.description || '')}</span></td>
        <td>${escapeHtml(catName(p.category_id))}</td>
        <td>${fmtMoney(p.price)}</td>
        <td><button type="button" class="availability as-btn ${p.available ? 'is-available' : 'is-unavailable'}" data-toggle-avail="${p.id}" title="Cliquer pour changer">${p.available ? 'Disponible' : 'Indisponible'}</button></td>
        <td>${p.featured ? '<span class="ok-pill">En vedette</span>' : '<span class="muted">—</span>'}</td>
        <td class="flex">
          <button class="btn secondary small" data-edit="${p.id}">Modifier</button>
          <button class="btn danger small" data-del="${p.id}">Suppr.</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">Aucun produit.</td></tr>';

    $('#productRows').querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => openProductForm(parseInt(b.dataset.edit, 10))));
    $('#productRows').querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => deleteProduct(parseInt(b.dataset.del, 10))));
    $('#productRows').querySelectorAll('[data-toggle-avail]').forEach((b) =>
      b.addEventListener('click', () => toggleAvailability(parseInt(b.dataset.toggleAvail, 10))));
  }

  async function toggleAvailability(id) {
    const p = catalog.products.find((x) => x.id === id);
    try {
      await api('/products/' + id, { method: 'PUT', body: { available: !p.available } });
      toast(`${p.name} : ${p.available ? 'indisponible' : 'disponible'}`, 'success');
      loadCatalog();
    } catch (err) { toast(err.message, 'error'); }
  }

  $('#addCatBtn').addEventListener('click', async () => {
    const name = $('#newCatName').value.trim();
    if (!name) return;
    try { await api('/products/categories', { method: 'POST', body: { name } }); $('#newCatName').value = ''; loadCatalog(); }
    catch (err) { toast(err.message, 'error'); }
  });

  async function deleteCategory(id) {
    if (!confirm('Supprimer cette catégorie et tous ses produits ?')) return;
    try { await api('/products/categories/' + id, { method: 'DELETE' }); loadCatalog(); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function deleteProduct(id) {
    if (!confirm('Supprimer ce produit ?')) return;
    try { await api('/products/' + id, { method: 'DELETE' }); loadCatalog(); toast('Produit supprimé', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  }

  $('#newProductBtn').addEventListener('click', () => openProductForm(null));

  function openProductForm(id) {
    const p = id ? catalog.products.find((x) => x.id === id) : null;
    $('#drawerTitle').textContent = p ? 'Modifier le produit' : 'Nouveau produit';
    $('#drawerContent').innerHTML = `
      <div class="field"><label>Nom</label><input id="pName" value="${escapeHtml(p ? p.name : '')}" /></div>
      <div class="field"><label>Catégorie</label>
        <select id="pCat">${catalog.categories.map((c) =>
          `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Prix (FCFA)</label><input id="pPrice" type="number" min="0" value="${p ? p.price : 0}" /></div>
      <div class="field"><label>Description</label><textarea id="pDesc">${escapeHtml(p ? (p.description || '') : '')}</textarea></div>
      <div class="field"><label>Image (URL, optionnel)</label><input id="pImg" value="${escapeHtml(p ? (p.image_url || '') : '')}" placeholder="https://…" /></div>
      <div class="field"><label><input id="pAvail" type="checkbox" ${!p || p.available ? 'checked' : ''} style="width:auto"/> Disponible à la vente</label></div>
      <div class="field"><label><input id="pFeat" type="checkbox" ${p && p.featured ? 'checked' : ''} style="width:auto"/> Mettre en avant sur la page d'accueil</label></div>`;
    $('#drawerFooter').innerHTML = `<button class="btn block" id="saveProduct">${p ? 'Enregistrer' : 'Créer'}</button>`;
    $('#saveProduct').addEventListener('click', () => saveProduct(id));
    openDrawer();
  }

  async function saveProduct(id) {
    const body = {
      name: $('#pName').value.trim(),
      category_id: parseInt($('#pCat').value, 10),
      price: parseInt($('#pPrice').value, 10) || 0,
      description: $('#pDesc').value.trim(),
      image_url: $('#pImg').value.trim(),
      available: $('#pAvail').checked,
      featured: $('#pFeat').checked,
    };
    if (!body.name || !body.category_id) { toast('Nom et catégorie requis', 'error'); return; }
    try {
      if (id) await api('/products/' + id, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body });
      closeDrawer(); loadCatalog(); toast('Enregistré', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------- Personnalisation du restaurant (admin / développeur) ---------- */
  const form = $('#brandForm');

  async function loadBrandForm() {
    const s = await Brand.load();
    if (!s) { toast('Impossible de charger les paramètres', 'error'); return; }
    form.querySelectorAll('[name]').forEach((el) => {
      if (el.type === 'checkbox') el.checked = s[el.name] === '1';
      else el.value = s[el.name] != null ? s[el.name] : '';
    });
    $('#bColorHex').textContent = s.primary_color;
    renderLogoPreview();
  }

  function renderLogoPreview() {
    const url = $('#bLogo').value.trim();
    $('#logoPreview').innerHTML = isSafeImage(url)
      ? `<img src="${escapeHtml(url)}" alt="Aperçu du logo" />`
      : '<span class="muted" style="font-size:.78rem">Aucun logo</span>';
  }
  $('#bLogo').addEventListener('input', renderLogoPreview);
  $('#bColor').addEventListener('input', () => { $('#bColorHex').textContent = $('#bColor').value; });
  $('#logoClear').addEventListener('click', () => { $('#bLogo').value = ''; $('#bLogoFile').value = ''; renderLogoPreview(); });

  /** Import d'un logo : redimensionné à 256 px max et stocké directement (pas d'hébergement externe). */
  $('#bLogoFile').addEventListener('change', () => {
    const file = $('#bLogoFile').files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Fichier trop lourd (5 Mo maximum).', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (file.type === 'image/svg+xml') {
        if (reader.result.length > 500000) { toast('Logo SVG trop lourd.', 'error'); return; }
        $('#bLogo').value = reader.result; renderLogoPreview(); return;
      }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 256 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        $('#bLogo').value = c.toDataURL('image/png');
        renderLogoPreview();
      };
      img.onerror = () => toast('Image illisible.', 'error');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    form.querySelectorAll('[name]').forEach((el) => {
      body[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    });
    $('#brandSave').disabled = true;
    try {
      const { settings } = await api('/settings', { method: 'PUT', body });
      Brand.settings = settings;
      applyBrand(settings);
      toast('Personnalisation enregistrée', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { $('#brandSave').disabled = false; }
  });

  /* ---------- Tiroir ---------- */
  function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#drawerOverlay').classList.add('open'); $('#drawerOverlay').setAttribute('aria-hidden', 'false'); }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#drawerOverlay').classList.remove('open'); $('#drawerOverlay').setAttribute('aria-hidden', 'true'); }
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerOverlay').addEventListener('click', closeDrawer);

  /* ---------- Temps réel ---------- */
  function startRealtime() {
    if (rt) rt.close();
    rt = connectRealtime((ev) => {
      if (ev.type === 'settings:update') { Brand.load(); return; }
      if (ev.type === 'order:new') {
        toast('Nouvelle commande #' + ev.order.id + ' — ' + ev.order.customer_name, 'success');
        if (ALERT_ROLES.includes(role())) newOrderAlert(ev.order);
        if (currentTab === 'orders') loadOrders();
        if (currentTab === 'dash') loadStats();
      } else if (ev.type === 'order:update') {
        alertOrderChanged(ev.order);
        if (ev.by === 'client' && ev.order.client_ack === 1) {
          toast('Commande #' + ev.order.id + ' : le client a pris connaissance de la modification.', 'success');
        }
        if (currentTab === 'orders') loadOrders();
        if (currentTab === 'dash') loadStats();
      }
    }, (live) => { $('#rtDot').classList.toggle('live', live); });
  }

  boot();
})();
