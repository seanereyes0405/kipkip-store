/* ==========================================================
   Kipkip storefront logic (vanilla ES6, no dependencies)
   Sections: constants, storage, helpers, state, UI render,
   auth, cart, checkout, store settings, init.
   Everything is stored in this browser's localStorage.
   ========================================================== */
(() => {
  'use strict';

  /* ---------- Constants ---------- */
  const KEYS = {
    settings: 'kipkip.settings.v1',
    users: 'kipkip.users.v1',
    session: 'kipkip.session.v1',
    cart: 'kipkip.cart.v1',
    orders: 'kipkip.orders.v1',
  };

  const DEFAULTS = Object.freeze({
    price: 174.96,
    colors: [
      { id: 'navy-blue', name: 'Navy Blue', hex: '#1B2A4A' },
      { id: 'sage-green', name: 'Sage Green', hex: '#9CAF88' },
      { id: 'cream-white', name: 'Cream White', hex: '#FDFBF7' },
      { id: 'lilac', name: 'Lilac', hex: '#C8A2C8' },
      { id: 'dark-brown', name: 'Dark Brown', hex: '#4A2E1B' },
      { id: 'gray', name: 'Gray', hex: '#808080' },
      { id: 'black', name: 'Black', hex: '#1F1F1F' },
    ],
  });

  const MAX_QTY = 20;
  const PESO = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  const money = (cents) => PESO.format(cents / 100);
  const toCents = (price) => Math.round(price * 100);

  /* ---------- Storage helpers ---------- */
  const load = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ---------- Validation / sanitizing ---------- */
  function normalizeHex(value) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!m) return null;
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return '#' + hex.toUpperCase();
  }

  function sanitizeSettings(raw) {
    const out = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    const p = Number(raw.price);
    if (Number.isFinite(p) && p > 0 && p <= 1e6) out.price = Math.round(p * 100) / 100;
    if (Array.isArray(raw.colors)) {
      const seen = new Set();
      const colors = [];
      for (const c of raw.colors) {
        if (!c || typeof c.name !== 'string') continue;
        const hex = normalizeHex(c.hex);
        const name = c.name.trim().slice(0, 24);
        const id = String(c.id || '').slice(0, 40);
        if (!hex || !name || !id || seen.has(id)) continue;
        seen.add(id);
        colors.push({ id, name, hex });
      }
      if (colors.length) out.colors = colors;
    }
    return out;
  }

  function sanitizeCart(raw, colors) {
    if (!Array.isArray(raw)) return [];
    const ids = new Set(colors.map((c) => c.id));
    return raw
      .filter((i) => i && ids.has(i.colorId) && Number.isInteger(i.qty) && i.qty > 0)
      .map((i) => ({ colorId: i.colorId, qty: Math.min(i.qty, MAX_QTY) }));
  }

  const isLight = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 200;
  };
  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'color';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* ---------- DOM helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Build elements without innerHTML so user-supplied text can never inject markup.
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  let toastTimer;
  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const setMsg = (el, text, ok = false) => {
    el.textContent = text || '';
    el.classList.toggle('ok', ok);
  };

  const openDialog = (dlg) => { if (!dlg.open) dlg.showModal(); };
  const closeDialog = (dlg) => { if (dlg.open) dlg.close(); };

  /* ---------- State ---------- */
  const state = {
    settings: sanitizeSettings(load(KEYS.settings, null)),
    cart: [],
    userEmail: load(KEYS.session, null),
    colorId: null,
    qty: 1,
    mode: 'bag',
    pending: null,          // action to resume after sign-in
    checkoutItems: [],      // items being checked out
    checkoutFromCart: false,
  };
  state.cart = sanitizeCart(load(KEYS.cart, []), state.settings.colors);
  state.colorId = state.settings.colors[0].id;

  const getUsers = () => { const u = load(KEYS.users, []); return Array.isArray(u) ? u : []; };
  const currentUser = () => getUsers().find((u) => u.email === state.userEmail) || null;
  if (state.userEmail && !currentUser()) { state.userEmail = null; localStorage.removeItem(KEYS.session); }

  const colorById = (id) => state.settings.colors.find((c) => c.id === id);
  const unitCents = () => toCents(state.settings.price);
  const cartCount = () => state.cart.reduce((n, i) => n + i.qty, 0);

  /* ---------- Element refs ---------- */
  const els = {
    preview: $('#bagPreview'), bagGroup: $('#bagGroup'), pillowGroup: $('#pillowGroup'),
    modeBag: $('#modeBag'), modePillow: $('#modePillow'),
    colorName: $('#colorName'), swatches: $('#swatches'),
    qty: $('#qty'), qtyDec: $('#qtyDec'), qtyInc: $('#qtyInc'), subtotal: $('#subtotal'),
    addToCart: $('#addToCart'), buyNow: $('#buyNow'),
    cartBtn: $('#cartBtn'), cartCount: $('#cartCount'), authArea: $('#authArea'),
    authDialog: $('#authDialog'), tabSignup: $('#tabSignup'), tabLogin: $('#tabLogin'),
    signupForm: $('#signupForm'), loginForm: $('#loginForm'), authMsg: $('#authMsg'),
    cartDialog: $('#cartDialog'), cartItems: $('#cartItems'), cartTotal: $('#cartTotal'), checkoutBtn: $('#checkoutBtn'),
    checkoutDialog: $('#checkoutDialog'), checkoutForm: $('#checkoutForm'), checkoutSummary: $('#checkoutSummary'), checkoutMsg: $('#checkoutMsg'),
    confirmDialog: $('#confirmDialog'), confirmBody: $('#confirmBody'),
    settingsDialog: $('#settingsDialog'), priceForm: $('#priceForm'), priceInput: $('#priceInput'),
    colorList: $('#colorList'), colorForm: $('#colorForm'), newColorName: $('#newColorName'),
    newColorPicker: $('#newColorPicker'), newColorHex: $('#newColorHex'),
    settingsMsg: $('#settingsMsg'), resetBtn: $('#resetBtn'),
  };

  /* ==========================================================
     Rendering
     ========================================================== */
  function renderPrices() {
    $$('[data-price]').forEach((el) => { el.textContent = PESO.format(state.settings.price); });
    renderSubtotal();
  }

  function renderSubtotal() {
    els.subtotal.textContent = money(unitCents() * state.qty);
  }

  function renderSwatches() {
    els.swatches.replaceChildren();
    state.settings.colors.forEach((c) => {
      const selected = c.id === state.colorId;
      const btn = h('button', {
        type: 'button',
        class: 'swatch' + (isLight(c.hex) ? ' light' : ''),
        role: 'radio',
        'aria-checked': String(selected),
        'aria-label': c.name,
        title: c.name,
        tabindex: selected ? '0' : '-1',
        'data-id': c.id,
        onclick: () => selectColor(c.id),
      });
      btn.style.setProperty('--sw', c.hex);
      els.swatches.append(btn);
    });
  }

  function renderPreview() {
    const c = colorById(state.colorId) || state.settings.colors[0];
    els.preview.style.setProperty('--bag', c.hex);
    els.preview.setAttribute('aria-label', `Kipkip ${state.mode} preview in ${c.name}`);
    els.colorName.textContent = c.name;
    const bag = state.mode === 'bag';
    els.bagGroup.hidden = !bag;
    els.pillowGroup.hidden = bag;
    els.modeBag.setAttribute('aria-pressed', String(bag));
    els.modePillow.setAttribute('aria-pressed', String(!bag));
  }

  function selectColor(id, focus = false) {
    state.colorId = id;
    renderSwatches();
    renderPreview();
    if (focus) $(`.swatch[data-id="${CSS.escape(id)}"]`, els.swatches)?.focus();
  }

  function setQty(n) {
    const v = Math.max(1, Math.min(MAX_QTY, Number.isFinite(n) ? Math.floor(n) : 1));
    state.qty = v;
    els.qty.value = String(v);
    renderSubtotal();
  }

  function renderCartBadge() {
    const n = cartCount();
    els.cartCount.textContent = String(n);
    els.cartCount.hidden = n === 0;
  }

  function renderAuth() {
    els.authArea.replaceChildren();
    const user = currentUser();
    if (user) {
      els.authArea.append(
        h('span', { class: 'auth-greet', text: `Hi, ${user.name.split(' ')[0]}` }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Logout', onclick: logout })
      );
    } else {
      els.authArea.append(
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Sign In / Sign Up', onclick: () => openAuth('signup') })
      );
    }
  }

  function cartLines() {
    return state.cart
      .map((i) => ({ ...i, color: colorById(i.colorId) }))
      .filter((i) => i.color);
  }

  function renderCart() {
    const lines = cartLines();
    els.cartItems.replaceChildren();
    if (!lines.length) {
      els.cartItems.append(h('p', { class: 'empty', text: 'Your cart is empty. Pick a color and add a Kipkip.' }));
    }
    lines.forEach((l) => {
      const thumb = h('div', { class: 'cart-thumb', 'aria-hidden': 'true' });
      thumb.style.setProperty('--sw', l.color.hex);
      const input = h('input', {
        type: 'number', min: '1', max: String(MAX_QTY), value: String(l.qty), 'aria-label': `Quantity for ${l.color.name}`,
        onchange: (e) => updateCartQty(l.colorId, parseInt(e.target.value, 10)),
      });
      els.cartItems.append(
        h('div', { class: 'cart-line' },
          thumb,
          h('div', {},
            h('h4', { text: 'Kipkip Bag Pillow' }),
            h('small', { text: `${l.color.name} · ${PESO.format(state.settings.price)} each` }),
            h('div', { class: 'qty' },
              h('button', { type: 'button', 'aria-label': 'Decrease quantity', text: '−', onclick: () => updateCartQty(l.colorId, l.qty - 1) }),
              input,
              h('button', { type: 'button', 'aria-label': 'Increase quantity', text: '+', onclick: () => updateCartQty(l.colorId, l.qty + 1) })
            )
          ),
          h('div', { class: 'line-total' },
            h('div', { text: money(unitCents() * l.qty) }),
            h('button', { class: 'remove', type: 'button', text: 'Remove', onclick: () => removeFromCart(l.colorId) })
          )
        )
      );
    });
    const total = lines.reduce((s, l) => s + unitCents() * l.qty, 0);
    els.cartTotal.textContent = money(total);
    els.checkoutBtn.disabled = lines.length === 0;
    renderCartBadge();
  }

  function renderAll() {
    renderPrices();
    renderSwatches();
    renderPreview();
    renderAuth();
    renderCart();
    renderSettingsPanel();
  }

  /* ==========================================================
     Auth (accounts are stored locally in this browser)
     ========================================================== */
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function hashPassword(password, saltB64) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('A secure browser context is required (use https:// or localhost).');
    }
    const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
    return { salt: b64(salt), hash: b64(bits) };
  }

  const safeEqual = (a, b) => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };

  function openAuth(tab = 'signup') {
    setAuthTab(tab);
    setMsg(els.authMsg, '');
    openDialog(els.authDialog);
  }

  function setAuthTab(tab) {
    const signup = tab === 'signup';
    els.tabSignup.setAttribute('aria-selected', String(signup));
    els.tabLogin.setAttribute('aria-selected', String(!signup));
    els.signupForm.hidden = !signup;
    els.loginForm.hidden = signup;
    setMsg(els.authMsg, '');
  }

  function startSession(email) {
    state.userEmail = email;
    save(KEYS.session, email);
    renderAuth();
    closeDialog(els.authDialog);
    toast(`Welcome, ${currentUser().name.split(' ')[0]}!`);
    const action = state.pending;
    state.pending = null;
    if (typeof action === 'function') action();
  }

  async function onSignup(e) {
    e.preventDefault();
    const f = new FormData(els.signupForm);
    const name = String(f.get('name') || '').trim().replace(/\s+/g, ' ');
    const email = String(f.get('email') || '').trim().toLowerCase();
    const password = String(f.get('password') || '');
    if (!name) return setMsg(els.authMsg, 'Please enter your name.');
    if (!EMAIL_RE.test(email)) return setMsg(els.authMsg, 'Please enter a valid email address.');
    if (password.length < 8) return setMsg(els.authMsg, 'Password must be at least 8 characters.');
    const users = getUsers();
    if (users.some((u) => u.email === email)) {
      setAuthTab('login');
      return setMsg(els.authMsg, 'That email is already registered. Please sign in.');
    }
    try {
      const { salt, hash } = await hashPassword(password);
      users.push({ name, email, salt, hash, createdAt: new Date().toISOString() });
      if (!save(KEYS.users, users)) return setMsg(els.authMsg, 'Could not save your account. Is browser storage disabled?');
      els.signupForm.reset();
      startSession(email);
    } catch (err) {
      setMsg(els.authMsg, err.message);
    }
  }

  async function onLogin(e) {
    e.preventDefault();
    const f = new FormData(els.loginForm);
    const email = String(f.get('email') || '').trim().toLowerCase();
    const password = String(f.get('password') || '');
    if (!EMAIL_RE.test(email) || !password) return setMsg(els.authMsg, 'Enter your email and password.');
    const users = getUsers();
    if (!users.length) {
      setAuthTab('signup');
      return setMsg(els.authMsg, 'No accounts yet. Please sign up first.');
    }
    const user = users.find((u) => u.email === email);
    if (!user) return setMsg(els.authMsg, 'No account found for that email. Please sign up first.');
    try {
      const { hash } = await hashPassword(password, user.salt);
      if (!safeEqual(hash, user.hash)) return setMsg(els.authMsg, 'Incorrect password.');
      els.loginForm.reset();
      startSession(email);
    } catch (err) {
      setMsg(els.authMsg, err.message);
    }
  }

  function logout() {
    state.userEmail = null;
    state.pending = null;
    localStorage.removeItem(KEYS.session);
    renderAuth();
    toast('You have been signed out.');
  }

  function requireAuth(action) {
    if (currentUser()) return action();
    state.pending = action;
    openAuth('signup');
    setMsg(els.authMsg, 'Please sign up or sign in to continue.');
  }

  /* ==========================================================
     Cart
     ========================================================== */
  function persistCart() { save(KEYS.cart, state.cart); renderCart(); }

  function addToCart(colorId, qty) {
    const existing = state.cart.find((i) => i.colorId === colorId);
    if (existing) existing.qty = Math.min(MAX_QTY, existing.qty + qty);
    else state.cart.push({ colorId, qty: Math.min(MAX_QTY, qty) });
    persistCart();
    els.cartCount.classList.remove('bump');
    void els.cartCount.offsetWidth; // restart animation
    els.cartCount.classList.add('bump');
    toast(`Added ${qty} × ${colorById(colorId).name} to your cart`);
  }

  function updateCartQty(colorId, qty) {
    if (!Number.isFinite(qty) || qty < 1) return removeFromCart(colorId);
    const item = state.cart.find((i) => i.colorId === colorId);
    if (item) item.qty = Math.min(MAX_QTY, Math.floor(qty));
    persistCart();
  }

  function removeFromCart(colorId) {
    state.cart = state.cart.filter((i) => i.colorId !== colorId);
    persistCart();
  }

  /* ==========================================================
     Checkout (simulated; no payment taken)
     ========================================================== */
  function openCheckout(items, fromCart) {
    const lines = items.map((i) => ({ ...i, color: colorById(i.colorId) })).filter((l) => l.color);
    if (!lines.length) return toast('Nothing to check out yet.');
    state.checkoutItems = lines.map(({ colorId, qty }) => ({ colorId, qty }));
    state.checkoutFromCart = fromCart;

    els.checkoutSummary.replaceChildren(
      ...lines.map((l) => h('div', { class: 'summary-line' },
        h('span', { text: `Kipkip Bag Pillow, ${l.color.name} × ${l.qty}` }),
        h('span', { text: money(unitCents() * l.qty) })
      )),
      h('div', { class: 'summary-line' },
        h('span', { text: 'Total' }),
        h('span', { text: money(lines.reduce((s, l) => s + unitCents() * l.qty, 0)) })
      )
    );
    const user = currentUser();
    if (user && !els.checkoutForm.elements.fullName.value) els.checkoutForm.elements.fullName.value = user.name;
    setMsg(els.checkoutMsg, '');
    closeDialog(els.cartDialog);
    openDialog(els.checkoutDialog);
  }

  function onCheckoutSubmit(e) {
    e.preventDefault();
    const f = new FormData(els.checkoutForm);
    const fullName = String(f.get('fullName') || '').trim();
    const phone = String(f.get('phone') || '').replace(/[\s-]/g, '');
    const payment = String(f.get('payment') || '');
    const address = String(f.get('address') || '').trim();
    const notes = String(f.get('notes') || '').trim();

    if (!fullName) return setMsg(els.checkoutMsg, 'Please enter your name.');
    if (!/^(09|\+639)\d{9}$/.test(phone)) return setMsg(els.checkoutMsg, 'Enter a valid PH mobile number, e.g. 09XX XXX XXXX.');
    if (payment !== 'Studio pickup' && address.length < 8) return setMsg(els.checkoutMsg, 'Please enter your full delivery address.');

    const lines = state.checkoutItems
      .map((i) => ({ ...i, color: colorById(i.colorId) }))
      .filter((l) => l.color);
    if (!lines.length) return setMsg(els.checkoutMsg, 'Your items are no longer available. Please re-add them.');

    const total = lines.reduce((s, l) => s + unitCents() * l.qty, 0);
    const order = {
      id: 'KIP-' + Date.now().toString(36).toUpperCase(),
      placedAt: new Date().toISOString(),
      customerEmail: state.userEmail,
      fullName, phone, payment,
      address: payment === 'Studio pickup' ? 'Pickup at studio' : address,
      notes,
      items: lines.map((l) => ({ color: l.color.name, qty: l.qty, unitCents: unitCents() })),
      totalCents: total,
    };
    const orders = load(KEYS.orders, []);
    orders.push(order);
    save(KEYS.orders, orders);

    if (state.checkoutFromCart) { state.cart = []; persistCart(); }
    els.checkoutForm.reset();
    closeDialog(els.checkoutDialog);
    showConfirmation(order);
  }

  function showConfirmation(order) {
    els.confirmBody.replaceChildren(
      h('p', {}, 'Thank you, ', h('strong', { text: order.fullName }), '. Your order reference is ', h('strong', { text: order.id }), '.'),
      h('div', { class: 'summary' },
        ...order.items.map((i) => h('div', { class: 'summary-line' },
          h('span', { text: `Kipkip Bag Pillow, ${i.color} × ${i.qty}` }),
          h('span', { text: money(i.unitCents * i.qty) })
        )),
        h('div', { class: 'summary-line' }, h('span', { text: 'Total' }), h('span', { text: money(order.totalCents) }))
      ),
      h('p', { class: 'muted', text: `${order.payment}${order.payment === 'Studio pickup' ? '' : ' to: ' + order.address}` }),
      h('p', { class: 'muted', text: 'This is a demo checkout. The Kipkip team will confirm real orders by phone or message.' })
    );
    openDialog(els.confirmDialog);
  }

  function syncAddressRequirement() {
    const pickup = els.checkoutForm.elements.payment.value === 'Studio pickup';
    els.checkoutForm.elements.address.disabled = pickup;
    els.checkoutForm.elements.address.placeholder = pickup ? 'Not needed for pickup' : 'House no., street, barangay, city';
  }

  /* ==========================================================
     Store settings / customizer
     ========================================================== */
  function persistSettings() {
    const ok = save(KEYS.settings, state.settings);
    if (!ok) setMsg(els.settingsMsg, 'Could not save settings (browser storage unavailable).');
    state.cart = sanitizeCart(state.cart, state.settings.colors);
    save(KEYS.cart, state.cart);
    if (!colorById(state.colorId)) state.colorId = state.settings.colors[0].id;
    renderAll();
    return ok;
  }

  function renderSettingsPanel() {
    els.priceInput.value = state.settings.price.toFixed(2);
    els.colorList.replaceChildren();
    const only = state.settings.colors.length <= 1;
    state.settings.colors.forEach((c) => {
      const dot = h('span', { class: 'cart-thumb', style: 'width:26px;height:26px;border-radius:50%', 'aria-hidden': 'true' });
      dot.style.setProperty('--sw', c.hex);
      els.colorList.append(
        h('li', {},
          dot,
          h('span', { text: c.name }),
          h('code', { text: c.hex }),
          h('button', {
            class: 'remove', type: 'button', text: 'Remove', disabled: only,
            'aria-label': `Remove ${c.name}`, onclick: () => removeColor(c.id),
          })
        )
      );
    });
  }

  function onPriceSubmit(e) {
    e.preventDefault();
    const value = Number(els.priceInput.value);
    if (!Number.isFinite(value) || value <= 0 || value > 1e6) {
      return setMsg(els.settingsMsg, 'Enter a price greater than 0.');
    }
    state.settings.price = Math.round(value * 100) / 100;
    if (persistSettings()) setMsg(els.settingsMsg, `Price updated to ${PESO.format(state.settings.price)}.`, true);
  }

  function onColorSubmit(e) {
    e.preventDefault();
    const name = els.newColorName.value.trim().replace(/\s+/g, ' ').slice(0, 24);
    const hex = normalizeHex(els.newColorHex.value);
    if (!name) return setMsg(els.settingsMsg, 'Please enter a color name.');
    if (!hex) return setMsg(els.settingsMsg, 'Enter a valid hex code like #B5651D.');
    if (state.settings.colors.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return setMsg(els.settingsMsg, 'A color with that name already exists.');
    }
    let id = slugify(name), n = 2;
    while (colorById(id)) id = `${slugify(name)}-${n++}`;
    state.settings.colors.push({ id, name, hex });
    if (persistSettings()) {
      setMsg(els.settingsMsg, `Added ${name}.`, true);
      els.newColorName.value = '';
    }
  }

  function removeColor(id) {
    if (state.settings.colors.length <= 1) return setMsg(els.settingsMsg, 'Keep at least one color.');
    const c = colorById(id);
    state.settings.colors = state.settings.colors.filter((x) => x.id !== id);
    if (persistSettings()) setMsg(els.settingsMsg, `Removed ${c.name}.`, true);
  }

  function resetSettings() {
    if (!window.confirm('Reset price and colors to the Kipkip defaults?')) return;
    state.settings = clone(DEFAULTS);
    localStorage.removeItem(KEYS.settings);
    state.cart = sanitizeCart(state.cart, state.settings.colors);
    save(KEYS.cart, state.cart);
    state.colorId = state.settings.colors[0].id;
    renderAll();
    setMsg(els.settingsMsg, 'Defaults restored.', true);
  }

  /* ==========================================================
     Open / closed indicator (Philippine time)
     ========================================================== */
  function renderOpenStatus() {
    const el = $('#openStatus');
    if (!el) return;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    const day = get('weekday');
    const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
    const open = day !== 'Sun' && mins >= 8 * 60 && mins < 17 * 60;
    el.classList.toggle('open', open);
    el.classList.toggle('closed', !open);
    if (open) { el.textContent = 'Open now'; return; }
    const names = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
    const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let label = 'today';
    if (day === 'Sun' || mins >= 17 * 60) {
      let idx = order.indexOf(day);
      do { idx = (idx + 1) % 7; } while (order[idx] === 'Sun');
      label = idx === (order.indexOf(day) + 1) % 7 ? 'tomorrow' : names[order[idx]];
    }
    el.textContent = `Closed · opens ${label} 8:00 AM`;
  }

  /* ==========================================================
     Init & event wiring
     ========================================================== */
  function bind() {
    // Preview mode
    els.modeBag.addEventListener('click', () => { state.mode = 'bag'; renderPreview(); });
    els.modePillow.addEventListener('click', () => { state.mode = 'pillow'; renderPreview(); });

    // Swatch keyboard navigation (radio-group pattern)
    els.swatches.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const list = state.settings.colors;
      const i = list.findIndex((c) => c.id === state.colorId);
      selectColor(list[(i + keys[e.key] + list.length) % list.length].id, true);
    });

    // Quantity
    els.qtyDec.addEventListener('click', () => setQty(state.qty - 1));
    els.qtyInc.addEventListener('click', () => setQty(state.qty + 1));
    els.qty.addEventListener('change', () => setQty(parseInt(els.qty.value, 10)));

    // Product actions
    els.addToCart.addEventListener('click', () => {
      const colorId = state.colorId, qty = state.qty;
      requireAuth(() => addToCart(colorId, qty));
    });
    els.buyNow.addEventListener('click', () => {
      const colorId = state.colorId, qty = state.qty;
      requireAuth(() => openCheckout([{ colorId, qty }], false));
    });

    // Cart
    els.cartBtn.addEventListener('click', () => { renderCart(); openDialog(els.cartDialog); });
    els.checkoutBtn.addEventListener('click', () => {
      const items = state.cart.slice();
      requireAuth(() => openCheckout(items, true));
    });

    // Auth
    els.tabSignup.addEventListener('click', () => setAuthTab('signup'));
    els.tabLogin.addEventListener('click', () => setAuthTab('login'));
    els.signupForm.addEventListener('submit', onSignup);
    els.loginForm.addEventListener('submit', onLogin);

    // Checkout
    els.checkoutForm.addEventListener('submit', onCheckoutSubmit);
    $$('input[name="payment"]', els.checkoutForm).forEach((r) => r.addEventListener('change', syncAddressRequirement));
    syncAddressRequirement();

    // Settings
    $$('[data-open-settings]').forEach((b) => b.addEventListener('click', () => {
      setMsg(els.settingsMsg, '');
      renderSettingsPanel();
      openDialog(els.settingsDialog);
    }));
    els.priceForm.addEventListener('submit', onPriceSubmit);
    els.colorForm.addEventListener('submit', onColorSubmit);
    els.resetBtn.addEventListener('click', resetSettings);
    els.newColorPicker.addEventListener('input', () => { els.newColorHex.value = els.newColorPicker.value.toUpperCase(); });
    els.newColorHex.addEventListener('input', () => {
      const hex = normalizeHex(els.newColorHex.value);
      if (hex) els.newColorPicker.value = hex.toLowerCase();
    });

    // Dialog close buttons + backdrop click
    $$('dialog').forEach((dlg) => {
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
    });
    els.authDialog.addEventListener('close', () => { if (!currentUser()) state.pending = null; });

    // Mobile nav
    const toggle = $('#menuToggle'), nav = $('#siteNav');
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
    });

    // Contact form: opens the visitor's email app (no backend needed)
    const cf = $('#contactForm'), cmsg = $('#contactMsg');
    cf.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(cf);
      const name = String(f.get('name') || '').trim();
      const email = String(f.get('email') || '').trim();
      const message = String(f.get('message') || '').trim();
      if (!name || !EMAIL_RE.test(email) || !message) return setMsg(cmsg, 'Please complete all fields with a valid email.');
      const subject = encodeURIComponent(`Kipkip inquiry from ${name}`);
      const body = encodeURIComponent(`${message}\n\nFrom: ${name} <${email}>`);
      setMsg(cmsg, 'Opening your email app…', true);
      window.location.href = `mailto:officialkipkipph@gmail.com?subject=${subject}&body=${body}`;
    });

    // Keep tabs in sync (price/color/cart/session changes made in another tab)
    window.addEventListener('storage', (e) => {
      if (!Object.values(KEYS).includes(e.key) && e.key !== null) return;
      state.settings = sanitizeSettings(load(KEYS.settings, null));
      state.cart = sanitizeCart(load(KEYS.cart, []), state.settings.colors);
      state.userEmail = load(KEYS.session, null);
      if (!colorById(state.colorId)) state.colorId = state.settings.colors[0].id;
      renderAll();
    });
  }

  function init() {
    $('#year').textContent = String(new Date().getFullYear());
    bind();
    setQty(1);
    renderAll();
    renderOpenStatus();
    setInterval(renderOpenStatus, 60 * 1000);
  }

  init();
})();
