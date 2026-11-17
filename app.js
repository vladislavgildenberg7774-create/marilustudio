import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js?v=4';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

/* ================= УТИЛИТЫ ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (Math.round(+n || 0)).toLocaleString('ru-RU') + ' ₽';
const pad = n => String(n).padStart(2, '0');
const hm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseISO = s => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const monday = s => { const d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const fmtLong = s => parseISO(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const fmtShort = s => parseISO(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const COLORS = ['#7c6cf2', '#ec4899', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#14b8a6', '#64748b'];
const STATUSES = { booked: 'Ожидание', confirmed: 'Подтвердил', done: 'Пришёл', noshow: 'Не пришёл', cancelled: 'Отменена' };
const ROLES = { owner: 'Главный', smm: 'СММ-менеджер', master: 'Мастер' };
const DOWS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const PPM = 1.8; // пикселей на минуту в журнале
const LS = 'marilu-';
const lsGet = k => { try { return localStorage.getItem(LS + k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, v); } catch (e) { } };

let tt;
function toast(t) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = t; clearTimeout(tt); tt = setTimeout(() => el.remove(), 3200);
}
function errText(e) {
  const m = (e && (e.message || e.error_description)) || 'Ошибка';
  if (/row-level security|permission denied/i.test(m)) return 'Нет прав на это действие или подписка студии неактивна';
  if (/Invalid login credentials/i.test(m)) return 'Неверный email или пароль';
  if (/User already registered/i.test(m)) return 'Этот email уже зарегистрирован — войдите';
  if (/Password should be at least/i.test(m)) return 'Пароль должен быть не короче 6 символов';
  if (/Email not confirmed/i.test(m)) return 'Email не подтверждён — проверьте почту';
  if (/duplicate key.*members_studio_id_email/i.test(m)) return 'Сотрудник с таким email уже есть в студии';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Нет связи с сервером';
  return m;
}
async function run(promise) {
  const { data, error } = await promise;
  if (error) { toast(errText(error)); throw error; }
  return data;
}

/* ================= СОСТОЯНИЕ ================= */
const A = { user: null, profile: null, memberships: [], studio: null, role: null, me: null, view: 'loading' };
const D = { members: {}, services: {}, clients: {}, appts: {}, range: null, returning: new Set() };
const UI = { tab: 'journal', date: today(), q: '', period: 'month', mf: 'all', showC: false, sx: 0, sy: null, authMode: 'login', authMsg: '', authErr: '' };
let channel = null;
const arr = c => Object.values(D[c]);
const isSuper = () => !!A.profile?.is_superadmin;
const subOk = s => s && !s.blocked && (!s.sub_until || s.sub_until >= today());
const canBook = () => isSuper() || (['owner', 'smm'].includes(A.role) && subOk(A.studio));
const canManage = () => isSuper() || (A.role === 'owner' && subOk(A.studio));
const isMaster = () => A.role === 'master' && !isSuper();
const membersSorted = () => arr('members').sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
const journalMembers = () => {
  let ms = membersSorted().filter(m => m.in_journal);
  if (isMaster()) ms = membersSorted().filter(m => m.id === A.me?.id);
  return ms;
};

/* ================= АВТОРИЗАЦИЯ ================= */
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { setTimeout(newPasswordForm, 300); }
  const uid = session?.user?.id || null;
  if (uid !== (A.user?.id || null)) { A.user = session?.user || null; setTimeout(loadAccount, 0); }
});
(async () => {
  const { data } = await sb.auth.getSession();
  A.user = data.session?.user || null;
  loadAccount();
})();

async function loadAccount() {
  closeChannel();
  if (!A.user) { A.view = 'auth'; A.profile = null; A.studio = null; render(); return; }
  A.view = 'loading'; render();
  try {
    const { data: prof, error: e1 } = await sb.from('profiles').select('*').eq('id', A.user.id).maybeSingle();
    if (e1) throw e1;
    A.profile = prof || { id: A.user.id, email: A.user.email, full_name: '', is_superadmin: false };
    const { data: mem, error: e2 } = await sb.from('members').select('*, studio:studios(*)').eq('user_id', A.user.id);
    if (e2) throw e2;
    A.memberships = (mem || []).filter(m => m.studio);
  } catch (e) {
    A.view = 'error'; A.err = errText(e); render(); return;
  }
  const last = lsGet('studio');
  if (last && A.memberships.some(m => m.studio_id === last)) return openStudio(last);
  if (isSuper()) { A.view = 'admin'; render(); return; }
  if (A.memberships.length === 1) return openStudio(A.memberships[0].studio_id);
  A.view = A.memberships.length ? 'pick' : 'waiting'; render();
}

async function openStudio(id) {
  closeChannel();
  A.view = 'loading'; render();
  try {
    const st = await run(sb.from('studios').select('*').eq('id', id).single());
    A.studio = st;
    A.me = A.memberships.find(m => m.studio_id === id) || null;
    A.role = A.me?.role || (isSuper() ? 'owner' : null);
    lsSet('studio', id);
    UI.tab = 'journal'; UI.mf = 'all'; UI.sy = null; UI.date = today();
    D.members = {}; D.services = {}; D.clients = {}; D.appts = {}; D.range = null;
    const [ms, sv, cl] = await Promise.all([
      run(sb.from('members').select('*').eq('studio_id', id)),
      run(sb.from('services').select('*').eq('studio_id', id)),
      run(sb.from('clients').select('*').eq('studio_id', id).order('name').limit(5000)),
    ]);
    ms.forEach(r => D.members[r.id] = r); sv.forEach(r => D.services[r.id] = r); cl.forEach(r => D.clients[r.id] = r);
    await loadWeek(true);
    subscribe(id);
    A.view = 'studio'; render();
  } catch (e) {
    A.view = isSuper() ? 'admin' : 'error'; A.err = errText(e); render();
  }
}

async function loadWeek(force) {
  const from = monday(UI.date), to = addDays(from, 6);
  if (!force && D.range === from) return;
  D.range = from;
  const rows = await run(sb.from('appointments').select('*').eq('studio_id', A.studio.id).gte('day', from).lte('day', to));
  if (D.range !== from) return;
  D.appts = {}; rows.forEach(r => D.appts[r.id] = r);
  // клиенты, у которых уже были визиты до этой недели (для метки New)
  const ids = [...new Set(rows.map(r => r.client_id).filter(Boolean))];
  D.returning = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const prev = await run(sb.from('appointments').select('client_id').eq('studio_id', A.studio.id).in('client_id', part).lt('day', from).neq('status', 'cancelled').limit(1000));
    prev.forEach(p => D.returning.add(p.client_id));
  }
}

function subscribe(id) {
  const apply = (table, key) => p => {
    if (p.eventType === 'DELETE') { delete D[key][p.old.id]; }
    else {
      const r = p.new;
      if (key === 'appts') { const from = D.range, to = addDays(from, 6); if (r.day < from || r.day > to) { delete D[key][r.id]; } else D[key][r.id] = r; }
      else D[key][r.id] = r;
      if (key === 'members' && r.id === A.me?.id) A.me = r;
    }
    if (!document.querySelector('#modal .ov')) render(); else renderNav();
  };
  channel = sb.channel('studio-' + id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: 'studio_id=eq.' + id }, apply('appointments', 'appts'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clients', filter: 'studio_id=eq.' + id }, apply('clients', 'clients'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'members', filter: 'studio_id=eq.' + id }, apply('members', 'members'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'services', filter: 'studio_id=eq.' + id }, apply('services', 'services'))
    .subscribe();
}
function closeChannel() { if (channel) { sb.removeChannel(channel); channel = null; } }

/* ================= ЭКРАНЫ ВНЕ СТУДИИ ================= */
function vAuth() {
  const reg = UI.authMode === 'reg';
  return `<div class="auth"><form class="box" id="authForm">
    <div class="brand"><div class="lg">M</div><div><b>MariluStudio</b><small>Журнал записи для студий красоты</small></div></div>
    <div class="seg"><button type="button" data-auth="login" class="${reg ? '' : 'on'}">Вход</button><button type="button" data-auth="reg" class="${reg ? 'on' : ''}">Регистрация</button></div>
    ${UI.authErr ? `<div class="err">${esc(UI.authErr)}</div>` : ''}${UI.authMsg ? `<div class="okbox">${esc(UI.authMsg)}</div>` : ''}
    ${reg ? `<div class="f"><label>Ваше имя</label><input id="aName" autocomplete="name" required></div>` : ''}
    <div class="f"><label>Email</label><input id="aEmail" type="email" autocomplete="email" required></div>
    <div class="f"><label>Пароль</label><input id="aPass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="6" required></div>
    <button class="btn pri wide" id="aGo">${reg ? 'Зарегистрироваться' : 'Войти'}</button>
    ${reg ? '<p class="muted" style="font-size:13px">Сотрудники регистрируются с тем email, который указал руководитель студии, — и сразу попадают в свою студию.</p>'
      : '<p style="text-align:center;margin:14px 0 0"><button type="button" class="link" id="aForgot">Забыли пароль?</button></p>'}
    ${isStandalone() ? '' : '<button type="button" class="btn wide" data-act="install" style="margin-top:14px">📲 Установить приложение</button>'}
  </form></div>`;
}
async function authSubmit(e) {
  e.preventDefault();
  const email = $('aEmail').value.trim(), pass = $('aPass').value;
  UI.authErr = ''; UI.authMsg = ''; $('aGo').disabled = true;
  try {
    if (UI.authMode === 'reg') {
      const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: $('aName').value.trim() }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { UI.authMsg = 'Почти готово! Мы отправили письмо на ' + email + ' — подтвердите email и войдите.'; UI.authMode = 'login'; render(); }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
    }
  } catch (err) { UI.authErr = errText(err); render(); }
}
async function forgot() {
  const email = $('aEmail').value.trim();
  if (!email) { UI.authErr = 'Введите email, а потом нажмите «Забыли пароль?»'; render(); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  UI.authErr = error ? errText(error) : ''; UI.authMsg = error ? '' : 'Ссылка для смены пароля отправлена на ' + email; render();
}
function newPasswordForm() {
  openModal(`<h3>Новый пароль</h3><div class="f"><label>Пароль (не короче 6 символов)</label><input id="np" type="password" minlength="6"></div>
    <div class="actions"><span class="sp"></span><button class="btn pri" id="npS">Сохранить</button></div>`);
  $('npS').onclick = async () => { await run(sb.auth.updateUser({ password: $('np').value })); closeModal(); toast('Пароль изменён'); };
}

function vWaiting() {
  return `<div class="auth"><div class="box">
    <div class="brand"><div class="lg">M</div><div><b>MariluStudio</b><small>${esc(A.user?.email)}</small></div></div>
    <p><b>Вы ещё не добавлены в студию.</b></p>
    <p class="muted">Попросите руководителя студии добавить вас в команду по email <b>${esc(A.user?.email)}</b>. После этого нажмите «Обновить».</p>
    <div class="actions"><button class="btn pri" data-act="reload">Обновить</button><button class="btn" data-act="logout">Выйти</button></div>
  </div></div>`;
}
function vPick() {
  return `<div class="auth"><div class="box">
    <div class="brand"><div class="lg">M</div><div><b>Выберите студию</b><small>${esc(A.user?.email)}</small></div></div>
    <div class="list">${A.memberships.map(m => `<div class="li" data-studio="${m.studio_id}"><div class="main"><b>${esc(m.studio.name)}</b><small>${ROLES[m.role]}</small></div><span class="muted">›</span></div>`).join('')}</div>
    <div class="actions">${isSuper() ? '<button class="btn" data-act="admin">Админ-панель</button>' : ''}<span class="sp"></span><button class="btn ghost" data-act="logout">Выйти</button></div>
  </div></div>`;
}
function vError() {
  return `<div class="auth"><div class="box"><div class="brand"><div class="lg">M</div><div><b>MariluStudio</b></div></div>
    <div class="err">${esc(A.err || 'Ошибка')}</div><div class="actions"><button class="btn pri" data-act="reload">Повторить</button><button class="btn" data-act="logout">Выйти</button></div></div></div>`;
}

/* ================= АДМИН-ПАНЕЛЬ ================= */
let adminRows = null;
function subBadge(s) {
  if (s.blocked) return '<span class="sub off">Заблокирована</span>';
  if (!s.sub_until) return '<span class="sub ok">Бессрочно</span>';
  const days = Math.round((parseISO(s.sub_until) - parseISO(today())) / 864e5);
  if (days < 0) return `<span class="sub bad">Истекла ${fmtShort(s.sub_until)}</span>`;
  if (days <= 7) return `<span class="sub soon">До ${fmtShort(s.sub_until)} · ${days} дн.</span>`;
  return `<span class="sub ok">До ${parseISO(s.sub_until).toLocaleDateString('ru-RU')}</span>`;
}
function vAdmin() {
  if (!adminRows) { loadAdmin(); return `<div class="empty">Загрузка…</div>`; }
  const t = today();
  const active = adminRows.filter(s => subOk(s)).length;
  const soon = adminRows.filter(s => subOk(s) && s.sub_until && (parseISO(s.sub_until) - parseISO(t)) / 864e5 <= 7).length;
  const q = UI.q.trim().toLowerCase();
  const list = adminRows.filter(s => !q || s.name.toLowerCase().includes(q) || (s.owner_email || '').includes(q) || (s.owner_name || '').toLowerCase().includes(q));
  return `<div class="topline"><h2>Админ-панель</h2><button class="btn pri sm" data-act="newStudio">+ Студия</button></div>
    <div class="stats">
      <div class="stat"><small>Студий</small><b>${adminRows.length}</b></div>
      <div class="stat"><small>Подписка активна</small><b style="color:#1f7a37">${active}</b></div>
      <div class="stat"><small>Истекает за 7 дней</small><b style="color:#8a5a00">${soon}</b></div>
      <div class="stat"><small>Неактивны</small><b style="color:#b42318">${adminRows.length - active}</b></div>
    </div>
    <input class="search" id="search" placeholder="Поиск студии, владельца, email" value="${esc(UI.q)}">
    ${list.length ? list.map(s => `<div class="scard">
      <h4>${esc(s.name)}</h4>
      <div class="meta">${subBadge(s)}<br>Главный: ${esc(s.owner_name || '—')} · ${esc(s.owner_email || '')} ${s.owner_joined ? '✓ вошёл' : '<span style="color:#8a5a00">ждёт регистрации</span>'}<br>
        Сотрудников: ${s.members_count} из ${s.max_members} · записей за 30 дней: ${s.appts_30d}</div>
      <div class="actions">
        <button class="btn pri sm" data-studio="${s.id}">Открыть</button>
        <button class="btn sm" data-sub="${s.id}|1">+1 мес</button>
        <button class="btn sm" data-sub="${s.id}|12">+1 год</button>
        <button class="btn sm" data-team="${s.id}">Сотрудники</button>
        <button class="btn sm" data-editstudio="${s.id}">Изменить</button>
      </div></div>`).join('') : '<div class="card empty"><b>Студий пока нет</b>Нажмите «+ Студия», чтобы добавить первую.</div>'}
    <p class="muted" style="font-size:13px;margin:16px 4px">Вы вошли как ${esc(A.user.email)} · суперадмин</p>`;
}
async function loadAdmin() {
  try { adminRows = await run(sb.rpc('admin_studio_list')); } catch (e) { adminRows = []; }
  if (A.view === 'admin') render();
}
function newStudioForm() {
  openModal(`<h3>Новая студия</h3>
    <div class="f"><label>Название студии</label><input id="nsN" placeholder="Например, Студия красоты Marilu"></div>
    <div class="f"><label>Имя главного (руководителя)</label><input id="nsO"></div>
    <div class="f"><label>Email главного</label><input id="nsE" type="email" placeholder="Под этим email он зарегистрируется"></div>
    <div class="f"><label>Подписка</label><select id="nsM"><option value="0">Пробный период: 14 дней</option><option value="1" selected>1 месяц</option><option value="3">3 месяца</option><option value="6">6 месяцев</option><option value="12">1 год</option></select></div>
    <div class="f"><label>Лимит сотрудников (1–30)</label><input id="nsL" type="number" min="1" max="30" value="6"></div>
    <div class="actions"><span class="sp"></span><button class="btn ghost" data-close>Отмена</button><button class="btn pri" id="nsS">Создать</button></div>`);
  $('nsS').onclick = async () => {
    const n = $('nsN').value.trim(), o = $('nsO').value.trim(), e = $('nsE').value.trim(), m = +$('nsM').value, mx = +$('nsL').value;
    if (!(mx >= 1 && mx <= 30)) { toast('Лимит сотрудников — от 1 до 30'); return; }
    if (!n || !o || !/^\S+@\S+\.\S+$/.test(e)) { toast('Заполните название, имя и корректный email'); return; }
    $('nsS').disabled = true;
    try {
      const id = await run(sb.rpc('admin_create_studio', { p_name: n, p_owner_name: o, p_owner_email: e, p_months: m, p_max: mx }));
      if (m === 0) await run(sb.from('studios').update({ sub_until: addDays(today(), 14) }).eq('id', id));
      closeModal(); toast('Студия создана. Главный регистрируется с email ' + e); loadAdmin();
    } catch (err) { $('nsS').disabled = false; }
  };
}
async function extendSub(id, months) {
  const s = adminRows.find(x => x.id === id);
  const base = s.sub_until && s.sub_until >= today() ? parseISO(s.sub_until) : new Date();
  base.setMonth(base.getMonth() + months);
  await run(sb.from('studios').update({ sub_until: iso(base), blocked: false }).eq('id', id));
  toast('Подписка продлена до ' + base.toLocaleDateString('ru-RU')); loadAdmin();
}
function editStudioForm(id) {
  const s = adminRows.find(x => x.id === id);
  openModal(`<h3>${esc(s.name)}</h3>
    <div class="f"><label>Название</label><input id="esN" value="${esc(s.name)}"></div>
    <div class="two"><div class="f"><label>Подписка до</label><input id="esU" type="date" value="${s.sub_until || ''}"></div>
    <div class="f"><label>Лимит сотрудников</label><input id="esL" type="number" min="1" max="30" value="${s.max_members}"></div></div>
    <label class="sw">Заблокировать студию<input type="checkbox" id="esB" ${s.blocked ? 'checked' : ''}></label>
    <p class="muted" style="font-size:13px">Если подписка истекла или студия заблокирована, сотрудники видят данные, но не могут ничего менять.</p>
    <div class="actions"><button class="btn danger" id="esD">Удалить</button><span class="sp"></span><button class="btn ghost" data-close>Отмена</button><button class="btn pri" id="esS">Сохранить</button></div>`);
  $('esS').onclick = async () => {
    const mx = +$('esL').value;
    if (!(mx >= 1 && mx <= 30)) { toast('Лимит сотрудников — от 1 до 30'); return; }
    if (mx < s.members_count) { toast(`В студии уже ${s.members_count} сотрудников — сначала удалите лишних`); return; }
    await run(sb.from('studios').update({ name: $('esN').value.trim() || s.name, sub_until: $('esU').value || null, max_members: mx, blocked: $('esB').checked }).eq('id', id));
    closeModal(); toast('Сохранено'); loadAdmin();
  };
  $('esD').onclick = () => confirmBox(`Удалить студию «${s.name}» со всеми записями, клиентами и сотрудниками? Это нельзя отменить.`, async () => {
    await run(sb.from('studios').delete().eq('id', id)); closeModal(); toast('Студия удалена'); loadAdmin();
  });
}

/* ================= ШАПКА И МЕНЮ СТУДИИ ================= */
const I = {
  journal: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 9h18M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01"/>',
  schedule: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 9h18M11 13l1.5-1v6"/>',
  clients: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14c2.8 0 4.5 2 4.5 5"/>',
  notif: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 20a2 2 0 0 1-3.4 0"/>',
  more: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  sliders: '<path d="M3 6h11M18 6h3M3 12h4M11 12h10M3 18h13M20 18h1"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  group: '<circle cx="12" cy="9" r="3"/><path d="M6.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="5.5" cy="10" r="2"/><circle cx="18.5" cy="10" r="2"/><path d="M2 17c0-2 1.3-3.3 3.5-3.3M22 17c0-2-1.3-3.3-3.5-3.3"/>',
  calplus: '<rect x="3" y="4" width="15" height="15" rx="3"/><path d="M7 2v4M14 2v4M3 9h15"/><circle cx="17.5" cy="17.5" r="4.5" fill="#fff"/><path d="M17.5 15.5v4M15.5 17.5h4"/>',
};
const ic = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
const clockSvg = c => `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><circle cx="12" cy="12" r="10" fill="#fff"/><path d="M12 7v5l3 2" stroke="${c}" stroke-width="2.4"/></svg>`;

function tabsFor() {
  const t = [['journal', 'Журнал'], ['schedule', 'График'], ['clients', 'Клиенты'], ['notif', 'Уведомления'], ['more', 'Ещё']];
  return t;
}
const navTab = () => ['services', 'team', 'report', 'settings', 'profile'].includes(UI.tab) ? 'more' : UI.tab;
function unseen() { const seen = +lsGet('seen-' + A.studio?.id) || 0; return seen ? arr('appts').filter(a => new Date(a.created_at).getTime() > seen && a.created_by !== A.user.id).length : 0; }
function markSeen() { lsSet('seen-' + A.studio.id, Date.now()); }

function renderNav() {
  const nav = $('nav');
  if (A.view !== 'studio') { nav.style.display = 'none'; return; }
  nav.style.display = '';
  const u = unseen();
  nav.innerHTML = tabsFor().map(([k, t]) => `<button class="${navTab() === k ? 'on' : ''}" data-tab="${k}">${ic(k)}<span>${t}</span>${k === 'notif' && u ? `<i class="dot">${u > 99 ? '99+' : u}</i>` : ''}</button>`).join('');
}
function renderHeader() {
  const h = $('hdr');
  if (A.view === 'admin') {
    h.style.display = '';
    h.innerHTML = `<h1>MariluStudio</h1>${A.memberships.length ? '<button class="btn sm" data-act="pick">Мои студии</button>' : ''}<button class="btn ghost sm" data-act="logout">Выйти</button>`;
    return;
  }
  if (A.view !== 'studio') { h.style.display = 'none'; return; }
  h.style.display = '';
  const banner = subOk(A.studio) ? '' : `<div class="banner" style="position:absolute;left:0;right:0;top:100%">${A.studio.blocked ? 'Студия заблокирована' : 'Подписка истекла'} — доступен только просмотр. Обратитесь к администратору MariluStudio.</div>`;
  if (UI.tab === 'journal') {
    const m = UI.mf === 'all' ? null : D.members[UI.mf];
    h.innerHTML = `<label class="dbtn">${fmtLong(UI.date)}${ic('chev', 2.4)}<input type="date" id="pick" value="${UI.date}"></label><span class="sp"></span>
      ${isMaster() ? '' : `<button class="allchip" data-act="mf">${m ? avatar(m, 30) : `<span class="gi"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">${I.group}</svg></span>`}<span>${m ? esc(m.name.split(' ')[0]) : 'Все'}</span></button>`}
      <button class="ficon" data-act="view" aria-label="Вид">${ic('sliders', 1.7)}</button>${banner}`;
  } else {
    const t = { schedule: 'График работы', clients: 'Клиенты', notif: 'Уведомления', more: esc(A.studio.name), services: 'Услуги', team: 'Команда', report: 'Отчёт', settings: 'Настройки студии', profile: 'Профиль' }[UI.tab];
    h.innerHTML = `<h1>${t}</h1>${banner}`;
  }
}
function measure() {
  const r = document.documentElement.style;
  r.setProperty('--hh', ($('hdr').style.display === 'none' ? 0 : $('hdr').offsetHeight) + 'px');
  r.setProperty('--nh', ($('nav').style.display === 'none' ? 0 : $('nav').offsetHeight) + 'px');
}

function render() {
  renderHeader(); renderNav();
  const app = $('app');
  const focused = document.activeElement && document.activeElement.id === 'search';
  let html;
  if (A.view === 'loading') html = '<div class="empty" style="padding-top:40vh">Загрузка…</div>';
  else if (A.view === 'auth') html = vAuth();
  else if (A.view === 'waiting') html = vWaiting();
  else if (A.view === 'pick') html = vPick();
  else if (A.view === 'error') html = vError();
  else if (A.view === 'admin') html = vAdmin();
  else html = ({ journal: vJournal, schedule: vSchedule, clients: vClients, notif: vNotif, more: vMore, services: vServices, team: vTeam, report: vReport, settings: vSettings, profile: vProfile })[UI.tab]();
  app.innerHTML = html;
  app.style.padding = ['auth', 'waiting', 'pick', 'error'].includes(A.view) ? '0' : '';
  $('fab').style.display = A.view === 'studio' && ((UI.tab === 'clients' && canBook()) || (['services', 'team'].includes(UI.tab) && canManage())) ? '' : 'none';
  measure();
  if (A.view === 'studio' && UI.tab === 'journal') afterJournal();
  if (A.view === 'auth') { $('authForm').onsubmit = authSubmit; const f = $('aForgot'); if (f) f.onclick = forgot; }
  if (focused) { const s = $('search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
}
window.addEventListener('resize', () => { if (A.view === 'studio') render(); });

/* ================= ЖУРНАЛ ================= */
function avatar(m, size) {
  const ph = typeof m.photo === 'string' && m.photo.startsWith('data:image/') ? m.photo : null;
  return `<span class="ava" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .38)}px;background:${esc(m.color || '#7c6cf2')}">${ph ? `<img src="${ph}" alt="">` : esc(initials(m.name))}</span>`;
}
function svcNames(a) { return (a.service_ids || []).map(id => D.services[id]?.name).filter(Boolean).join(', '); }
function isNewClient(a) {
  if (!a.client_id) return true;
  if (D.returning.has(a.client_id)) return false;
  return !arr('appts').some(o => o.id !== a.id && o.client_id === a.client_id && o.status !== 'cancelled' && (o.day + pad(o.start_min)) < (a.day + pad(a.start_min)));
}
function layout(list) {
  list.sort((a, b) => a.start_min - b.start_min);
  let cluster = [], end = -1; const out = [];
  const flush = () => { const lanes = []; cluster.forEach(a => { let i = lanes.findIndex(e => e <= a.start_min); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = a.start_min + a.duration; a._l = i; }); cluster.forEach(a => { a._n = lanes.length; out.push(a); }); cluster = []; };
  list.forEach(a => { if (a.start_min >= end && cluster.length) { flush(); end = -1; } cluster.push(a); end = Math.max(end, a.start_min + a.duration); });
  if (cluster.length) flush(); return out;
}
function vJournal() {
  const st = A.studio;
  let ms = journalMembers();
  if (UI.mf !== 'all') { const f = ms.filter(m => m.id === UI.mf); if (f.length) ms = f; else UI.mf = 'all'; }
  if (!ms.length) return `<div class="jempty"><div class="card empty"><b>${isMaster() ? 'Вас нет в журнале' : 'В журнале пока нет мастеров'}</b>${canManage() ? 'Добавьте сотрудников в разделе «Ещё» → «Команда».<div class="actions" style="justify-content:center"><button class="btn pri" data-act="go" data-v="team">Открыть команду</button></div>' : 'Обратитесь к руководителю студии.'}</div></div>` + weekStrip();
  const W = Math.min(window.innerWidth, 1400) - 48;
  const fit = Math.min(ms.length, Math.max(3, Math.floor(W / 200)));
  const cw = Math.max(104, Math.floor(W / fit));
  const H = (st.work_end - st.work_start) * 60 * PPM;
  const head = ms.map(m => `<div class="mh" style="width:${cw}px" data-mhead="${m.id}">${avatar(m, 46)}<div class="mn">${esc(m.name)}</div></div>`).join('');
  let tl = ''; for (let h = st.work_start; h < st.work_end; h++) { const y = (h - st.work_start) * 60 * PPM; tl += `<div class="tl" style="top:${h === st.work_start ? 2 : y - 10}px">${h}:00</div>`; }
  const list = arr('appts').filter(a => a.day === UI.date && (UI.showC || a.status !== 'cancelled'));
  const now = new Date(), nowY = (now.getHours() * 60 + now.getMinutes() - st.work_start * 60) * PPM;
  const hdrColor = s => ({ noshow: '#e2483c', done: '#7c8696', confirmed: '#3c9a55', cancelled: '#9aa0aa' }[s] || '#66c97b');
  const cols = ms.map(m => {
    const mine = layout(list.filter(a => a.member_id === m.id).map(a => ({ ...a })));
    const cards = mine.map(a => {
      const c = D.clients[a.client_id];
      const top = (a.start_min - st.work_start * 60) * PPM, w = 100 / a._n;
      // карточка раскрывается, чтобы были видны все строки (как в YClients), но не налезает на следующую запись
      const isNew = isNewClient(a) && a.status !== 'cancelled';
      const lines = 1 + (c?.phone ? 1 : 0) + (svcNames(a) ? 1 : 0) + (a.note ? 1 : 0);
      const need = 30 + (isNew ? 24 : 0) + lines * 17 + 8;
      const next = mine.filter(o => o.id !== a.id && o._l === a._l && o.start_min >= a.start_min + 1).reduce((m, o) => Math.min(m, o.start_min), st.work_end * 60);
      const room = (next - a.start_min) * PPM - 3;
      const h = Math.max(a.duration * PPM - 2, Math.min(need, room), 30);
      return `<div class="appt s-${a.status}" data-appt="${a.id}" style="top:${top}px;height:${h}px;left:calc(${w * a._l}% + 3px);width:calc(${w}% - 6px)">
        <div class="ah"><span>${hm(a.start_min)}&thinsp;–&thinsp;${hm(a.start_min + a.duration)}</span>${clockSvg(hdrColor(a.status))}</div>
        <div class="ab">${isNew ? '<span class="new">New</span>' : ''}
          <div>${esc(c?.name || 'Клиент')}</div>${c?.phone ? `<div>${esc(c.phone)}</div>` : ''}${svcNames(a) ? `<div>${esc(svcNames(a))}</div>` : ''}${a.note ? `<div>${esc(a.note)}</div>` : ''}</div></div>`;
    }).join('');
    const nl = UI.date === today() && nowY > 0 && nowY < H ? `<div class="nowline" style="top:${nowY}px"></div>` : '';
    return `<div class="mc" data-master="${m.id}" style="width:${cw}px;height:${H}px;--hp:${60 * PPM}px;${canBook() ? '' : 'cursor:default'}">${cards}${nl}</div>`;
  }).join('');
  return `<div class="jwrap"><div class="journal" id="jr">
      <div class="hrow"><div class="corner">${canBook() ? '<button class="plus" data-act="newAppt" aria-label="Новая запись">+</button>' : ''}</div>${head}</div>
      <div class="brow"><div class="tcol" style="height:${H}px">${tl}</div>${cols}</div>
      <div style="height:130px"></div>
    </div><div class="sbar" id="sbar"><i id="sth"></i></div></div>
    ${weekStrip()}
    ${canBook() ? `<button class="calplus" data-act="newNow" aria-label="Быстрая запись">${ic('calplus', 1.8)}</button>` : ''}`;
}
function afterJournal() {
  const j = $('jr'); if (!j) return;
  const st = A.studio;
  if (UI.sy === null) { const n = new Date(); UI.sy = UI.date === today() ? Math.max(0, (n.getHours() - st.work_start - 1) * 60 * PPM) : 0; }
  j.scrollLeft = UI.sx; j.scrollTop = UI.sy;
  const upd = () => {
    UI.sx = j.scrollLeft; UI.sy = j.scrollTop; const bar = $('sbar'), th = $('sth');
    const vis = j.clientWidth - 48, tot = j.scrollWidth - 48;
    if (tot <= vis + 2) { bar.style.display = 'none'; return; } bar.style.display = '';
    const bw = bar.clientWidth; th.style.width = Math.max(30, bw * vis / tot) + 'px'; th.style.left = (bw - th.offsetWidth) * (j.scrollLeft / (j.scrollWidth - j.clientWidth)) + 'px';
  };
  j.onscroll = upd; upd();
}
function weekStrip() {
  const mon = monday(UI.date);
  let h = ''; for (let i = 0; i < 7; i++) {
    const s = addDays(mon, i);
    h += `<button data-day="${s}" class="${s === UI.date ? 'sel' : ''} ${i === 6 && s !== UI.date ? 'sun' : ''} ${s === today() ? 'td' : ''}"><small>${DOWS[i]}</small><b>${parseISO(s).getDate()}</b></button>`;
  }
  return `<div class="week" id="week">${h}</div>`;
}
async function goDate(s) {
  UI.date = s;
  if (D.range !== monday(s)) { render(); try { await loadWeek(); } catch (e) { } }
  render();
}

/* ================= ОБРАБОТКА НАЖАТИЙ ================= */
let tx = null;
document.addEventListener('touchstart', e => { if (e.target.closest('#week')) tx = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', e => { if (tx === null) return; const dx = e.changedTouches[0].clientX - tx; tx = null; if (Math.abs(dx) > 50) goDate(addDays(UI.date, dx < 0 ? 7 : -7)); }, { passive: true });

document.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('#modal')) {
    if (t.classList.contains('ov') || t.closest('[data-close]')) { closeModal(); return; }
    const p = t.closest('[data-pick]'); if (p) { UI.mf = p.dataset.pick; closeModal(); render(); }
    return;
  }
  const au = t.closest('[data-auth]'); if (au) { UI.authMode = au.dataset.auth; UI.authErr = ''; UI.authMsg = ''; render(); return; }
  const tb = t.closest('[data-tab]'); if (tb) { UI.tab = tb.dataset.tab; UI.q = ''; if (UI.tab === 'notif') { markSeen(); notifRows = null; } if (UI.tab === 'report') reportRows = null; render(); window.scrollTo(0, 0); return; }
  const dy = t.closest('[data-day]'); if (dy) { goDate(dy.dataset.day); return; }
  const stu = t.closest('[data-studio]'); if (stu) { openStudio(stu.dataset.studio); return; }
  const sub = t.closest('[data-sub]'); if (sub) { const [id, m] = sub.dataset.sub.split('|'); extendSub(id, +m); return; }
  const tm = t.closest('[data-team]'); if (tm) { await openStudio(tm.dataset.team); UI.tab = 'team'; render(); return; }
  const es = t.closest('[data-editstudio]'); if (es) { editStudioForm(es.dataset.editstudio); return; }
  const actEl = t.closest('[data-act]'); const act = actEl?.dataset.act;
  if (act) {
    if (act === 'install') { installSheet(); return; }
    if (act === 'logout') { lsSet('studio', ''); closeChannel(); await unlinkPush(); await sb.auth.signOut(); return; }
    if (act === 'pushOn') { try { await enablePush(); } catch (e) { toast('Не удалось включить: ' + errText(e)); } return; }
    if (act === 'pushOff') { await disablePush(); return; }
    if (act === 'reload') { loadAccount(); return; }
    if (act === 'admin') { lsSet('studio', ''); closeChannel(); A.view = 'admin'; adminRows = null; UI.q = ''; render(); return; }
    if (act === 'pick') { lsSet('studio', ''); closeChannel(); A.view = A.memberships.length ? 'pick' : 'admin'; render(); return; }
    if (act === 'newStudio') return newStudioForm();
    if (act === 'newAppt') return apptForm({});
    if (act === 'newNow') {
      const st = A.studio; const n = new Date(); let m = Math.ceil((n.getHours() * 60 + n.getMinutes()) / 15) * 15;
      if (UI.date !== today() || m < st.work_start * 60 || m >= st.work_end * 60) m = st.work_start * 60;
      return apptForm({ start_min: m, member_id: UI.mf !== 'all' ? UI.mf : undefined });
    }
    if (act === 'mf') return masterPicker();
    if (act === 'view') return viewSheet();
    if (act === 'period') { UI.period = actEl.dataset.v; reportRows = null; render(); return; }
    if (act === 'go') { UI.tab = actEl.dataset.v; UI.q = ''; if (UI.tab === 'report') reportRows = null; render(); window.scrollTo(0, 0); return; }
    if (act === 'wk') { goDate(addDays(UI.date, +actEl.dataset.v)); return; }
    if (act === 'addService') return serviceForm({});
    if (act === 'addMember') return memberForm({});
  }
  const cell = t.closest('[data-cell]'); if (cell) { const [, d] = cell.dataset.cell.split('|'); UI.tab = 'journal'; UI.mf = 'all'; UI.sy = null; goDate(d); return; }
  const mh = t.closest('[data-mhead]'); if (mh && !isMaster()) { UI.mf = UI.mf === 'all' ? mh.dataset.mhead : 'all'; render(); return; }
  const ap = t.closest('[data-appt]'); if (ap) { const a = D.appts[ap.dataset.appt] || (notifRows || []).find(x => x.id === ap.dataset.appt); if (a) apptForm(a); return; }
  const col = t.closest('.mc');
  if (col && canBook()) {
    const st = A.studio; const r = col.getBoundingClientRect();
    const m = Math.floor((e.clientY - r.top) / PPM / 15) * 15 + st.work_start * 60;
    apptForm({ member_id: col.dataset.master, day: UI.date, start_min: Math.min(m, st.work_end * 60 - 15) }); return;
  }
  const li = t.closest('[data-open]');
  if (li) { const [c, id] = li.dataset.open.split(':'); ({ clients: () => clientCard(D.clients[id]), services: () => serviceForm(D.services[id]), members: () => memberForm(D.members[id]) })[c](); }
});
document.addEventListener('change', e => { if (e.target.id === 'pick' && e.target.value) { UI.sy = null; goDate(e.target.value); } });
document.addEventListener('input', e => { if (e.target.id === 'search') { UI.q = e.target.value; render(); } });
$('fab').onclick = e => { e.stopPropagation(); ({ clients: () => clientForm({}), services: () => serviceForm({}), team: () => memberForm({}) })[UI.tab]?.(); };

function masterPicker() {
  openModal(`<h3>Сотрудники</h3><div class="list">
    <div class="li" data-pick="all"><span class="ava" style="width:40px;height:40px;background:#dfe2e8;color:#8a8f98"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6">${I.group}</svg></span><div class="main"><b>Все сотрудники</b></div>${UI.mf === 'all' ? '✓' : ''}</div>
    ${journalMembers().map(m => `<div class="li" data-pick="${m.id}">${avatar(m, 40)}<div class="main"><b>${esc(m.name)}</b><small>${esc(m.position || ROLES[m.role])}</small></div>${UI.mf === m.id ? '✓' : ''}</div>`).join('')}
  </div><div class="actions"><span class="sp"></span><button class="btn ghost" data-close>Закрыть</button></div>`);
}
function hours(v) { let o = ''; for (let h = 0; h <= 24; h++) o += `<option value="${h}" ${h === v ? 'selected' : ''}>${pad(h)}:00</option>`; return o; }
function viewSheet() {
  openModal(`<h3>Вид журнала</h3>
    <label class="sw">Показывать отменённые записи<input type="checkbox" id="sc" ${UI.showC ? 'checked' : ''}></label>
    <p class="muted" style="font-size:13px">Рабочие часы студии: ${A.studio.work_start}:00–${A.studio.work_end}:00${canManage() ? ' (меняются в «Ещё» → «Настройки студии»)' : ''}</p>
    <div class="actions"><span class="sp"></span><button class="btn pri" id="vs">Применить</button></div>`);
  $('vs').onclick = () => { UI.showC = $('sc').checked; closeModal(); render(); };
}

/* ================= ЗАПИСЬ ================= */
function apptForm(a) {
  const isNew = !a.id, st = A.studio, edit = canBook();
  a = { status: 'booked', service_ids: [], duration: 60, price: 0, day: UI.date, start_min: st.work_start * 60, ...a };
  const masters = journalMembers().length ? membersSorted().filter(m => m.in_journal || m.id === a.member_id) : membersSorted();
  if (!a.member_id && masters[0]) a.member_id = UI.mf !== 'all' ? UI.mf : masters[0].id;
  const services = arr('services').sort((x, y) => x.name.localeCompare(y.name));
  const cl = D.clients[a.client_id];
  const sel = new Set(a.service_ids); let clientId = a.client_id || null;
  if (!edit) {
    // режим мастера: просмотр + статус и комментарий
    openModal(`<h3>Запись</h3>
      <p style="margin:0 0 6px"><b>${esc(cl?.name || 'Клиент')}</b> ${cl?.phone ? `· <a href="tel:${esc(cl.phone)}">${esc(cl.phone)}</a>` : ''}</p>
      <p class="muted" style="margin:0 0 12px">${fmtLong(a.day)}, ${hm(a.start_min)}–${hm(a.start_min + a.duration)} · ${esc(D.members[a.member_id]?.name || '')}<br>${esc(svcNames(a) || '')}${a.price ? ' · ' + money(a.price) : ''}</p>
      <div class="f"><label>Статус</label><select id="aS">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="f"><label>Комментарий</label><textarea id="aN">${esc(a.note || '')}</textarea></div>
      <div class="actions"><span class="sp"></span><button class="btn ghost" data-close>Закрыть</button>${subOk(st) && a.member_id === A.me?.id ? '<button class="btn pri" id="aSave">Сохранить</button>' : ''}</div>`);
    const s = $('aSave'); if (s) s.onclick = async () => { const r = await run(sb.from('appointments').update({ status: $('aS').value, note: $('aN').value.trim() }).eq('id', a.id).select().single()); D.appts[r.id] = r; closeModal(); render(); toast('Сохранено'); };
    return;
  }
  const times = []; for (let m = st.work_start * 60; m < st.work_end * 60; m += 15) times.push(m);
  if (!times.includes(a.start_min)) { times.push(a.start_min); times.sort((x, y) => x - y); }
  openModal(`<h3>${isNew ? 'Новая запись' : 'Запись'}</h3><div id="clash"></div>
    <div class="f"><label>Клиент</label><input id="cName" placeholder="Имя или телефон" value="${esc(cl?.name || '')}" autocomplete="off"><div id="sugg"></div></div>
    <div class="f"><label>Телефон</label><input id="cPhone" type="tel" placeholder="+7 900 000-00-00" value="${esc(cl?.phone || '')}"></div>
    <div class="two">
      <div class="f"><label>Сотрудник</label><select id="aM">${masters.map(m => `<option value="${m.id}" ${m.id === a.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="f"><label>Статус</label><select id="aS">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="two">
      <div class="f"><label>Дата</label><input id="aD" type="date" value="${a.day}"></div>
      <div class="f"><label>Время</label><select id="aT">${times.map(m => `<option value="${m}" ${m === a.start_min ? 'selected' : ''}>${hm(m)}</option>`).join('')}</select></div>
    </div>
    <div class="f"><label>Услуги</label><div class="chips" id="svc">${services.length ? services.map(s => `<span class="chip ${sel.has(s.id) ? 'on' : ''}" data-s="${s.id}">${esc(s.name)} · ${money(s.price)}</span>`).join('') : '<span class="muted" style="font-size:13px">Услуги добавляет главный: «Ещё» → «Услуги»</span>'}</div></div>
    <div class="two">
      <div class="f"><label>Длительность, мин</label><input id="aDur" type="number" min="5" step="5" value="${a.duration}"></div>
      <div class="f"><label>Стоимость, ₽</label><input id="aP" type="number" min="0" value="${a.price}"></div>
    </div>
    <div class="f"><label>Комментарий</label><textarea id="aN" placeholder="Например: Будет Нана">${esc(a.note || '')}</textarea></div>
    <div class="actions">${isNew ? '' : '<button class="btn danger" id="aDel">Удалить</button>'}<span class="sp"></span><button class="btn ghost" data-close>Отмена</button><button class="btn pri" id="aSave">Сохранить</button></div>`);
  const checkClash = () => {
    const m = $('aM').value, d = $('aD').value, s = +$('aT').value, du = +$('aDur').value || 30;
    const x = arr('appts').find(o => o.id !== a.id && o.member_id === m && o.day === d && o.status !== 'cancelled' && s < o.start_min + o.duration && o.start_min < s + du);
    $('clash').innerHTML = x ? `<div class="warnbox">⚠︎ У сотрудника уже есть запись ${hm(x.start_min)}–${hm(x.start_min + x.duration)} (${esc(D.clients[x.client_id]?.name || '')})</div>` : '';
  };
  const recalc = () => { const ss = [...sel].map(i => D.services[i]).filter(Boolean); if (ss.length) { $('aDur').value = ss.reduce((s, x) => s + (+x.duration || 0), 0) || 30; $('aP').value = ss.reduce((s, x) => s + (+x.price || 0), 0); } checkClash(); };
  $('svc').onclick = e => { const c = e.target.closest('[data-s]'); if (!c) return; const id = c.dataset.s; sel.has(id) ? sel.delete(id) : sel.add(id); c.classList.toggle('on'); recalc(); };
  ['aM', 'aD', 'aT', 'aDur'].forEach(i => $(i).addEventListener('change', checkClash)); checkClash();
  $('cName').oninput = () => {
    clientId = null; const q = $('cName').value.trim().toLowerCase(); if (!q) { $('sugg').innerHTML = ''; return; }
    const qd = q.replace(/\D/g, '');
    const res = arr('clients').filter(c => c.name.toLowerCase().includes(q) || (qd.length > 2 && (c.phone || '').replace(/\D/g, '').includes(qd))).slice(0, 6);
    $('sugg').innerHTML = res.length ? `<div class="sugg">${res.map(c => `<div data-c="${c.id}"><b>${esc(c.name)}</b> <span class="muted">${esc(c.phone || '')}</span></div>`).join('')}</div>` : '';
  };
  $('sugg').onclick = e => { const r = e.target.closest('[data-c]'); if (!r) return; const c = D.clients[r.dataset.c]; clientId = c.id; $('cName').value = c.name; $('cPhone').value = c.phone || ''; $('sugg').innerHTML = ''; };
  $('aSave').onclick = async () => {
    const name = $('cName').value.trim(), phone = $('cPhone').value.trim();
    if (!name && !phone) { toast('Укажите клиента'); return; }
    if (!$('aM').value) { toast('Сначала добавьте сотрудника'); return; }
    $('aSave').disabled = true;
    try {
      if (!clientId) {
        const pd = phone.replace(/\D/g, '');
        const ex = pd.length > 5 && arr('clients').find(c => (c.phone || '').replace(/\D/g, '') === pd);
        if (ex) clientId = ex.id;
        else { const c = await run(sb.from('clients').insert({ studio_id: st.id, name: name || phone, phone }).select().single()); D.clients[c.id] = c; clientId = c.id; }
      } else { const c = D.clients[clientId]; if (c && phone && c.phone !== phone) { const u = await run(sb.from('clients').update({ phone }).eq('id', c.id).select().single()); D.clients[u.id] = u; } }
      const row = { studio_id: st.id, client_id: clientId, member_id: $('aM').value, day: $('aD').value, start_min: +$('aT').value, duration: +$('aDur').value || 30, price: +$('aP').value || 0, service_ids: [...sel], status: $('aS').value, note: $('aN').value.trim() };
      const r = isNew ? await run(sb.from('appointments').insert(row).select().single()) : await run(sb.from('appointments').update(row).eq('id', a.id).select().single());
      if (r.day >= D.range && r.day <= addDays(D.range, 6)) D.appts[r.id] = r; else delete D.appts[r.id];
      closeModal(); render(); toast(isNew ? 'Клиент записан' : 'Сохранено');
    } catch (e) { const b = $('aSave'); if (b) b.disabled = false; }
  };
  if (!isNew) $('aDel').onclick = () => confirmBox('Удалить запись?', async () => { await run(sb.from('appointments').delete().eq('id', a.id)); delete D.appts[a.id]; closeModal(); render(); });
}

/* ================= ГРАФИК ================= */
function vSchedule() {
  const mon = monday(UI.date), days = [...Array(7)].map((_, i) => addDays(mon, i));
  const ms = journalMembers(), st = A.studio, dayMin = (st.work_end - st.work_start) * 60;
  if (D.range !== mon) { loadWeek().then(render).catch(() => { }); }
  let h = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><button class="icon-btn" data-act="wk" data-v="-7">‹</button><b style="flex:1;text-align:center">${fmtShort(days[0])} – ${fmtShort(days[6])}</b><button class="icon-btn" data-act="wk" data-v="7">›</button></div>`;
  if (!ms.length) return h + `<div class="card empty"><b>Нет сотрудников в журнале</b></div>`;
  h += `<div class="sched"><table><tr><th>Сотрудник</th>${days.map((x, i) => `<th class="${i === 6 ? 'sun' : ''} ${x === today() ? 'tdy' : ''}">${DOWS[i]}<br>${parseISO(x).getDate()}</th>`).join('')}</tr>`;
  ms.forEach(m => {
    h += `<tr><td>${esc(m.name.split(' ')[0])}</td>`;
    days.forEach(x => {
      const l = arr('appts').filter(a => a.member_id === m.id && a.day === x && a.status !== 'cancelled');
      const busy = l.reduce((t, a) => t + a.duration, 0);
      h += l.length ? `<td class="c" data-cell="${m.id}|${x}"><b>${l.length}</b><small>${Math.round(busy / dayMin * 100)}%</small></td>` : `<td class="c free" data-cell="${m.id}|${x}">—</td>`;
    });
    h += '</tr>';
  });
  return h + `</table></div><p class="muted" style="font-size:13px;margin:10px 4px">В ячейке: число записей и загрузка дня. Нажмите на ячейку, чтобы открыть журнал.</p>`;
}

/* ================= УВЕДОМЛЕНИЯ ================= */
let notifRows = null;
function vNotif() {
  if (!notifRows) {
    sb.from('appointments').select('*').eq('studio_id', A.studio.id).order('created_at', { ascending: false }).limit(50)
      .then(({ data, error }) => { notifRows = error ? [] : data; if (UI.tab === 'notif') render(); });
    return '<div class="empty">Загрузка…</div>';
  }
  if (!notifRows.length) return `<div class="card empty"><b>Пока пусто</b>Здесь появятся новые записи.</div>`;
  return `<div class="list">${notifRows.map(a => {
    const c = D.clients[a.client_id], m = D.members[a.member_id], cr = new Date(a.created_at);
    return `<div class="li" data-appt="${a.id}">${m ? avatar(m, 40) : ''}<div class="main"><b>${a.status === 'cancelled' ? 'Отмена' : 'Запись'}: ${esc(c?.name || 'Клиент')}</b><small>${fmtLong(a.day)}, ${hm(a.start_min)} · ${esc(m?.name || '')}</small></div><div class="end"><small>${cr.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${pad(cr.getHours())}:${pad(cr.getMinutes())}</small></div></div>`;
  }).join('')}</div>`;
}


/* ================= ПУШ-УВЕДОМЛЕНИЯ ================= */
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64u(s) { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); }
async function pushState() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'ios-browser' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}
async function enablePush() {
  if (isIOS() && !isStandalone()) { toast('Сначала добавьте приложение на экран «Домой» и откройте его оттуда'); return; }
  if (!pushSupported()) { toast('Этот браузер не поддерживает уведомления'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Уведомления запрещены. Разрешите их в настройках телефона'); render(); return; }
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  await run(sb.rpc('save_push_sub', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent.slice(0, 200) }));
  lsSet('push-asked', '1'); toast('Уведомления включены'); render();
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
  toast('Уведомления выключены'); render();
}
// при выходе отвязать устройство от аккаунта
async function unlinkPush() {
  try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription(); if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); } } catch (e) { }
}
function pushCard(id) {
  setTimeout(async () => {
    const el = $(id); if (!el) return;
    const st = await pushState();
    const txt = {
      on: ['🔔 Уведомления включены', 'Вы получаете пуши о новых, изменённых и отменённых записях.', '<button class="btn sm" data-act="pushOff">Выключить</button>'],
      off: ['🔔 Уведомления о записях', 'Получайте пуш, когда к вам записали клиента, перенесли или отменили запись.', '<button class="btn pri sm" data-act="pushOn">Включить уведомления</button>'],
      denied: ['🔕 Уведомления запрещены', 'Разрешите уведомления для MariluStudio в настройках телефона/браузера, затем обновите страницу.', ''],
      'ios-browser': ['🔔 Уведомления на iPhone', 'Добавьте приложение на экран «Домой»: «Поделиться» → «На экран „Домой“», откройте его с иконки и включите уведомления здесь.', ''],
      unsupported: ['🔕 Уведомления недоступны', 'Этот браузер не поддерживает пуш-уведомления. Попробуйте Chrome, Edge или Safari.', ''],
    }[st];
    const watcher = A.view === 'studio' && A.me && ['owner', 'smm'].includes(A.me.role);
    const allToggle = st === 'on' && watcher ? `<label class="sw" style="border-top:1px solid var(--line);margin-top:10px">Все записи студии<input type="checkbox" id="naT" ${A.me.notify_all !== false ? 'checked' : ''}></label>
      <div class="muted" style="font-size:12px">${A.me.notify_all !== false ? 'Вы получаете пуши обо всех записях студии.' : 'Вы получаете пуши только о записях к вам.'} Мастера всегда получают только свои.</div>` : '';
    el.innerHTML = `<b>${txt[0]}</b><div class="muted" style="font-size:13px;margin:4px 0 8px">${st === 'on' && !watcher ? 'Вы получаете пуши о своих записях: новая, изменена, отменена, передана другому мастеру.' : txt[1]}</div>${txt[2]}${allToggle}`;
    const t = $('naT');
    if (t) t.onchange = async () => {
      try { await run(sb.rpc('set_notify_all', { p_studio: A.studio.id, p_on: t.checked })); A.me.notify_all = t.checked; if (D.members[A.me.id]) D.members[A.me.id].notify_all = t.checked; toast(t.checked ? 'Будут приходить все записи студии' : 'Только записи к вам'); render(); }
      catch (e) { t.checked = !t.checked; }
    };
  });
  return `<div class="card" id="${id}" style="margin-bottom:12px"><b>🔔 Уведомления</b><div class="muted" style="font-size:13px">Проверяю…</div></div>`;
}
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'refresh' && A.view === 'studio') { loadWeek(true).then(render).catch(() => { }); } });


/* ================= УСТАНОВКА ПРИЛОЖЕНИЯ ================= */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Приложение установлено'); closeModal(); render(); });
const isAndroid = () => /Android/i.test(navigator.userAgent);
const shareIco = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#1d6ff2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-4px"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/></svg>';
const plusIco = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:inline;vertical-align:-4px"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const step = (n, html) => `<div style="display:flex;gap:12px;align-items:flex-start;margin:0 0 14px"><span style="flex:0 0 28px;height:28px;border-radius:50%;background:var(--yel);display:grid;place-items:center;font-weight:800">${n}</span><div style="padding-top:3px;line-height:1.45">${html}</div></div>`;
function installSheet(tab) {
  if (isStandalone()) { openModal('<h3>Приложение уже установлено ✓</h3><p class="muted">Вы открыли MariluStudio с экрана «Домой».</p><div class="actions"><span class="sp"></span><button class="btn pri" data-close>Понятно</button></div>'); return; }
  tab = tab || (isIOS() ? 'ios' : isAndroid() ? 'android' : 'pc');
  const inApp = /Telegram|Instagram|FBAN|FBAV|VKClient|WhatsApp|YaBrowser\/[\d.]+.*Mobile.*YaApp/i.test(navigator.userAgent);
  const url = location.origin + location.pathname.replace(/index\.html$/, '');
  const body = {
    android: `
      ${installPrompt ? `<button class="btn pri wide" id="doInstall" style="font-size:17px;padding:14px">📲 Установить MariluStudio</button>
        <p class="muted" style="font-size:13px;margin:8px 0 18px;text-align:center">Нажмите и подтвердите «Установить» — иконка появится на экране.</p>
        <p style="font-weight:700;margin:0 0 10px">Если кнопка не сработала:</p>` : ''}
      ${step(1, 'Откройте эту страницу в <b>Google Chrome</b>.')}
      ${step(2, 'Нажмите меню <b>⋮</b> справа вверху.')}
      ${step(3, 'Выберите <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b> → <b>«Установить»</b>.')}
      ${step(4, 'Откройте <b>MariluStudio</b> с иконки на экране и войдите.')}`,
    ios: `
      ${step(1, 'Откройте эту страницу в <b>Safari</b>.' + (inApp ? '<br><span style="color:#b42318">Сейчас она открыта внутри другого приложения — скопируйте ссылку ниже и вставьте в Safari.</span>' : ''))}
      ${step(2, `Нажмите <b>«Поделиться»</b> ${shareIco} внизу экрана (на новых iOS — в меню <b>«⋯»</b> у адресной строки).`)}
      ${step(3, `Пролистайте вниз и выберите <b>«На экран „Домой“»</b> ${plusIco}.`)}
      ${step(4, 'Нажмите <b>«Добавить»</b> — появится иконка <b>MariluStudio</b>.')}
      ${step(5, 'Откройте приложение <b>с иконки</b>, войдите и включите уведомления: <b>Ещё → Включить уведомления</b>.')}`,
    pc: `
      ${installPrompt ? '<button class="btn pri wide" id="doInstall" style="font-size:17px;padding:14px;margin-bottom:16px">💻 Установить на компьютер</button>' : ''}
      ${step(1, 'Откройте сайт в <b>Chrome</b> или <b>Edge</b>.')}
      ${step(2, 'Справа в адресной строке нажмите значок установки (монитор со стрелкой) или меню <b>⋮ → «Установить MariluStudio»</b>.')}
      ${step(3, 'Приложение появится в меню «Пуск» и на рабочем столе.')}`,
  }[tab];
  openModal(`<h3>Установить приложение</h3>
    <div class="seg">${[['ios', '📱 iPhone'], ['android', '🤖 Android'], ['pc', '💻 Компьютер']].map(([k, v]) => `<button data-itab="${k}" class="${k === tab ? 'on' : ''}">${v}</button>`).join('')}</div>
    <div style="margin-top:14px">${body}</div>
    <div class="f" style="margin-top:6px"><label>Ссылка на приложение</label><div style="display:flex;gap:8px"><input value="${esc(url)}" readonly id="instUrl"><button class="btn sm" id="instCopy">Копировать</button></div></div>
    <div class="actions"><span class="sp"></span><button class="btn ghost" data-close>Закрыть</button></div>`);
  document.querySelectorAll('[data-itab]').forEach(b => b.onclick = () => installSheet(b.dataset.itab));
  $('instCopy').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } catch (e) { $('instUrl').select(); } };
  const di = $('doInstall');
  if (di) di.onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); const r = await installPrompt.userChoice; installPrompt = null; if (r.outcome !== 'accepted') installSheet(tab); };
}

/* ================= ЕЩЁ ================= */
function vMore() {
  const it = [];
  it.push(['services', 'Услуги', canManage() ? 'Прайс, длительность, категории' : 'Список услуг и цены']);
  if (A.role === 'owner' || isSuper()) {
    it.push(['team', 'Команда', `Сотрудники и доступы · ${arr('members').length} из ${A.studio.max_members}`]);
    it.push(['report', 'Отчёт', 'Выручка, визиты, загрузка']);
    it.push(['settings', 'Настройки студии', 'Название, контакты, рабочие часы']);
  }
  it.push(['profile', 'Профиль', esc(A.user.email)]);
  const sub = subBadge(A.studio);
  return pushCard('pushMore') + `<div class="card" style="margin-bottom:12px"><b>${esc(A.studio.name)}</b><div class="muted" style="font-size:13px;margin-top:4px">Ваша роль: ${A.me ? ROLES[A.me.role] : 'Администратор MariluStudio'} · ${sub}</div></div>
    <div class="list">${it.map(([k, t, s]) => `<div class="li" data-act="go" data-v="${k}"><div class="main"><b>${t}</b><small>${s}</small></div><span class="muted">›</span></div>`).join('')}</div>
    ${isStandalone() ? '' : '<button class="btn wide" data-act="install" style="margin-top:12px">📲 Установить приложение на телефон</button>'}
    <div class="actions" style="margin-top:14px">${isSuper() ? '<button class="btn" data-act="admin">Админ-панель</button>' : ''}${A.memberships.length > 1 ? '<button class="btn" data-act="pick">Сменить студию</button>' : ''}<span class="sp"></span><button class="btn danger" data-act="logout">Выйти</button></div>`;
}
const backBtn = () => `<button class="back" data-act="go" data-v="more">‹ Ещё</button>`;

function vProfile() {
  setTimeout(() => {
    const s = $('prS'); if (!s) return;
    s.onclick = async () => {
      const name = $('prN').value.trim(), p = $('prP').value;
      if (name !== (A.profile.full_name || '')) { await run(sb.from('profiles').update({ full_name: name }).eq('id', A.user.id)); A.profile.full_name = name; }
      if (p) { if (p.length < 6) { toast('Пароль не короче 6 символов'); return; } await run(sb.auth.updateUser({ password: p })); $('prP').value = ''; }
      toast('Сохранено');
    };
  });
  return backBtn() + pushCard('pushProf') + `<div class="card">
    <div class="f"><label>Email</label><input value="${esc(A.user.email)}" disabled></div>
    <div class="f"><label>Ваше имя</label><input id="prN" value="${esc(A.profile.full_name || '')}"></div>
    <div class="f"><label>Новый пароль (если хотите сменить)</label><input id="prP" type="password" minlength="6" autocomplete="new-password"></div>
    <div class="actions"><span class="sp"></span><button class="btn pri" id="prS">Сохранить</button></div></div>
    <p class="muted" style="font-size:13px;margin:14px 4px">Чтобы установить приложение: на iPhone — «Поделиться» → «На экран Домой»; на Android — меню браузера → «Установить приложение»; на ПК — значок установки в адресной строке Chrome/Edge.</p>`;
}

function vSettings() {
  const st = A.studio;
  setTimeout(() => {
    const s = $('stS'); if (!s) return;
    s.onclick = async () => {
      const ws = +$('stWs').value, we = +$('stWe').value;
      if (we <= ws) { toast('Конец дня должен быть позже начала'); return; }
      const r = await run(sb.from('studios').update({ name: $('stN').value.trim() || st.name, phone: $('stP').value.trim(), address: $('stA').value.trim(), work_start: ws, work_end: we }).eq('id', st.id).select().single());
      A.studio = r; toast('Сохранено'); render();
    };
  });
  return backBtn() + `<div class="card">
    <div class="f"><label>Название студии</label><input id="stN" value="${esc(st.name)}"></div>
    <div class="f"><label>Телефон</label><input id="stP" type="tel" value="${esc(st.phone || '')}"></div>
    <div class="f"><label>Адрес</label><input id="stA" value="${esc(st.address || '')}"></div>
    <div class="two"><div class="f"><label>Начало дня</label><select id="stWs">${hours(st.work_start)}</select></div><div class="f"><label>Конец дня</label><select id="stWe">${hours(st.work_end)}</select></div></div>
    <p class="muted" style="font-size:13px">Подписка: ${subBadge(st)}. Продлевает администратор MariluStudio.</p>
    <div class="actions"><span class="sp"></span><button class="btn pri" id="stS" ${canManage() ? '' : 'disabled'}>Сохранить</button></div></div>`;
}

/* ================= КЛИЕНТЫ ================= */
function vClients() {
  const q = UI.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
  const l = arr('clients').filter(c => !q || c.name.toLowerCase().includes(q) || (qd.length > 1 && (c.phone || '').replace(/\D/g, '').includes(qd))).sort((a, b) => a.name.localeCompare(b.name));
  let h = `<input class="search" id="search" placeholder="Поиск по имени или телефону" value="${esc(UI.q)}">`;
  if (!arr('clients').length) return h + `<div class="card empty"><b>Клиентов пока нет</b>${canBook() ? 'Они появляются автоматически при записи или вручную кнопкой «+».' : isMaster() ? 'Здесь будут клиенты, записанные к вам.' : ''}</div>`;
  if (!l.length) return h + `<div class="card empty">Никого не найдено</div>`;
  return h + `<p class="muted" style="margin:0 4px 8px;font-size:13px">Всего: ${arr('clients').length}</p><div class="list">${l.slice(0, 300).map(c => `<div class="li" data-open="clients:${c.id}">${avatar({ name: c.name, color: COLORS[c.name.length % COLORS.length] }, 40)}<div class="main"><b>${esc(c.name)}</b><small>${esc(c.phone || 'без телефона')}</small></div><span class="muted">›</span></div>`).join('')}</div>${l.length > 300 ? '<p class="muted" style="text-align:center">Показаны первые 300 — уточните поиск</p>' : ''}`;
}
async function clientCard(c) {
  openModal(`<h3>${esc(c.name)}</h3><div class="empty">Загрузка истории…</div>`);
  const { data: hist } = await sb.from('appointments').select('*').eq('client_id', c.id).order('day', { ascending: false }).order('start_min', { ascending: false }).limit(100);
  if (!document.querySelector('#modal .ov')) return;
  const list = hist || [], done = list.filter(a => a.status === 'done'), sum = done.reduce((s, a) => s + (+a.price || 0), 0);
  const showMoney = !isMaster() && A.role !== 'smm' || isSuper();
  openModal(`<h3>${esc(c.name)}</h3>
    <div class="stats" style="grid-template-columns:repeat(${showMoney ? 3 : 1},1fr)"><div class="stat"><small>Визитов</small><b>${done.length}</b></div>${showMoney ? `<div class="stat"><small>Потратил</small><b>${money(sum)}</b></div><div class="stat"><small>Ср. чек</small><b>${money(done.length ? sum / done.length : 0)}</b></div>` : ''}</div>
    <p style="margin:0 0 4px"><b>Телефон:</b> ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</p>${c.note ? `<p class="muted" style="margin:0 0 8px">${esc(c.note)}</p>` : ''}
    ${canBook() ? '<div class="actions" style="margin:10px 0 14px"><button class="btn pri" id="cBook">Записать</button><button class="btn" id="cEdit">Изменить</button></div>' : ''}
    <b>История</b>
    <div class="hist">${list.length ? list.map(a => `<div class="li"><div class="main"><b>${fmtShort(a.day)} ${hm(a.start_min)} · ${esc(D.members[a.member_id]?.name || '')}</b><small>${esc(svcNames(a) || '—')}</small></div><div class="end">${showMoney ? money(a.price) : ''}<small><span class="badge b-${a.status}">${STATUSES[a.status]}</span></small></div></div>`).join('') : '<p class="muted">Записей пока нет</p>'}</div>
    <div class="actions"><span class="sp"></span><button class="btn ghost" data-close>Закрыть</button></div>`);
  const b = $('cBook'); if (b) b.onclick = () => { closeModal(); UI.tab = 'journal'; render(); apptForm({ client_id: c.id }); };
  const ed = $('cEdit'); if (ed) ed.onclick = () => clientForm(c);
}
function clientForm(c) {
  const isNew = !c.id;
  openModal(`<h3>${isNew ? 'Новый клиент' : 'Клиент'}</h3>
    <div class="f"><label>Имя</label><input id="n" value="${esc(c.name || '')}"></div>
    <div class="f"><label>Телефон</label><input id="p" type="tel" value="${esc(c.phone || '')}"></div>
    <div class="f"><label>Заметка</label><textarea id="nt" placeholder="Аллергии, предпочтения…">${esc(c.note || '')}</textarea></div>
    <div class="actions">${!isNew && canManage() ? '<button class="btn danger" id="d">Удалить</button>' : ''}<span class="sp"></span><button class="btn ghost" data-close>Отмена</button><button class="btn pri" id="s">Сохранить</button></div>`);
  $('s').onclick = async () => {
    const n = $('n').value.trim(); if (!n) { toast('Введите имя'); return; }
    const row = { name: n, phone: $('p').value.trim(), note: $('nt').value.trim() };
    const r = isNew ? await run(sb.from('clients').insert({ ...row, studio_id: A.studio.id }).select().single()) : await run(sb.from('clients').update(row).eq('id', c.id).select().single());
    D.clients[r.id] = r; closeModal(); render();
  };
  const d = $('d'); if (d) d.onclick = () => confirmBox('Удалить клиента? Его записи останутся в журнале без имени.', async () => { await run(sb.from('clients').delete().eq('id', c.id)); delete D.clients[c.id]; closeModal(); render(); });
}

/* ================= УСЛУГИ ================= */
function vServices() {
  const l = arr('services').sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  if (!l.length) return backBtn() + `<div class="card empty"><b>Список услуг пуст</b>${canManage() ? 'Добавьте услуги с ценой и длительностью — они подставляются в запись.<div class="actions" style="justify-content:center"><button class="btn pri" data-act="addService">Добавить услугу</button></div>' : 'Услуги добавляет главный студии.'}</div>`;
  let cat = null, h = backBtn();
  l.forEach(s => {
    if ((s.category || '') !== cat) { if (cat !== null) h += '</div>'; cat = s.category || ''; h += `<p class="muted" style="margin:14px 4px 6px;font-weight:700;font-size:13px">${esc(cat || 'Без категории')}</p><div class="list">`; }
    h += `<div class="li" ${canManage() ? `data-open="services:${s.id}"` : ''}><div class="main"><b>${esc(s.name)}</b><small>${s.duration} мин</small></div><div class="end">${money(s.price)}</div></div>`;
  });
  return h + '</div>';
}
function serviceForm(s) {
  if (!canManage()) return;
  const isNew = !s.id; const cats = [...new Set(arr('services').map(x => x.category).filter(Boolean))];
  openModal(`<h3>${isNew ? 'Новая услуга' : 'Услуга'}</h3>
    <div class="f"><label>Название</label><input id="n" value="${esc(s.name || '')}" placeholder="Например, Локоны"></div>
    <div class="f"><label>Категория</label><input id="c" list="cats" value="${esc(s.category || '')}" placeholder="Например, Причёски"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="two"><div class="f"><label>Длительность, мин</label><input id="d" type="number" min="5" step="5" value="${s.duration || 60}"></div>
    <div class="f"><label>Цена, ₽</label><input id="p" type="number" min="0" value="${s.price || 0}"></div></div>
    <div class="actions">${isNew ? '' : '<button class="btn danger" id="x">Удалить</button>'}<span class="sp"></span><button class="btn ghost" data-close>Отмена</button><button class="btn pri" id="s">Сохранить</button></div>`);
  $('s').onclick = async () => {
    const n = $('n').value.trim(); if (!n) { toast('Введите название'); return; }
    const row = { name: n, category: $('c').value.trim(), duration: +$('d').value || 30, price: +$('p').value || 0 };
    const r = isNew ? await run(sb.from('services').insert({ ...row, studio_id: A.studio.id }).select().single()) : await run(sb.from('services').update(row).eq('id', s.id).select().single());
    D.services[r.id] = r; closeModal(); render();
  };
  if (!isNew) $('x').onclick = () => confirmBox('Удалить услугу?', async () => { await run(sb.from('services').delete().eq('id', s.id)); delete D.services[s.id]; closeModal(); render(); });
}

/* ================= КОМАНДА ================= */
function vTeam() {
  const l = membersSorted(), max = A.studio.max_members;
  return backBtn() + `<p class="muted" style="margin:0 4px 10px;font-size:13px">Сотрудников: ${l.length} из ${max}. Каждый регистрируется в приложении с указанным здесь email и сразу попадает в студию.</p>
    <div class="list">${l.map(m => `<div class="li" data-open="members:${m.id}">${avatar(m, 44)}<div class="main"><b>${esc(m.name)}<span class="role ${m.role}">${ROLES[m.role]}</span></b><small>${esc(m.email)} · ${m.user_id ? '<span style="color:#1f7a37">подключён</span>' : '<span style="color:#8a5a00">ждёт регистрации</span>'}</small></div><span class="muted">›</span></div>`).join('')}</div>
    ${l.length < max && canManage() ? '<div class="actions"><button class="btn pri" data-act="addMember">+ Добавить сотрудника</button></div>' : `<p class="muted" style="font-size:13px;margin:10px 4px">Лимит сотрудников достигнут.${isSuper() ? ' Увеличьте его в админ-панели → «Изменить» (до 30).' : ' Увеличить его может администратор MariluStudio.'}</p>`}
    ${isSuper() ? '<div class="okbox" style="margin-top:12px">Вы — администратор MariluStudio: можете назначать любые роли (в т.ч. главного) без ограничений по количеству.</div>' : ''}
    <div class="card" style="margin-top:14px;font-size:13px;line-height:1.55"><b>Права доступа</b><br>
      <b>Главный</b> — всё: журнал, клиенты, услуги и цены, команда, отчёты, настройки.<br>
      <b>СММ-менеджер</b>${isSuper() ? '' : ' (до 2)'} — журнал всех мастеров, запись и перенос клиентов, база клиентов. Без отчётов, цен и команды.<br>
      <b>Мастер</b> — только свои записи и своих клиентов, может отметить «пришёл/не пришёл».</div>`;
}
function memberForm(m) {
  if (!canManage()) return;
  const isNew = !m.id; let color = m.color || COLORS[arr('members').length % COLORS.length]; let photo = m.photo || '';
  const ownerLocked = m.role === 'owner' && !isSuper();
  openModal(`<h3>${isNew ? 'Новый сотрудник' : 'Сотрудник'}</h3>
    <div class="f photo"><span id="pv">${avatar({ ...m, name: m.name || '?', color, photo }, 64)}</span><label class="btn">Фото<input type="file" accept="image/*" id="pf" hidden></label>${photo ? '<button class="btn ghost sm" id="pr">Убрать</button>' : ''}</div>
    <div class="f"><label>Имя</label><input id="n" value="${esc(m.name || '')}"></div>
    <div class="f"><label>Email (для входа в приложение)</label><input id="em" type="email" value="${esc(m.email || '')}" ${ownerLocked ? 'disabled' : ''}></div>
    <div class="two">
      <div class="f"><label>Роль</label><select id="rl" ${ownerLocked ? 'disabled' : ''}>${(m.role === 'owner' || isSuper() ? ['owner', 'smm', 'master'] : ['smm', 'master']).map(r => `<option value="${r}" ${r === (m.role || 'master') ? 'selected' : ''}>${ROLES[r]}</option>`).join('')}</select></div>
      <div class="f"><label>Должность</label><input id="ps" value="${esc(m.position || '')}" placeholder="Стилист, визажист…"></div>
    </div>
    <label class="sw">Показывать колонкой в журнале<input type="checkbox" id="ij" ${m.in_journal ?? true ? 'checked' : ''}></label>
    <div class="two"><div class="f"><label>Порядок в журнале</label><input id="o" type="number" value="${m.sort || 0}"></div><div></div></div>
    <div class="f"><label>Цвет (если нет фото)</label><div class="colors" id="cl">${COLORS.map(c => `<i style="background:${c}" data-c="${c}" class="${c === color ? 'on' : ''}"></i>`).join('')}</div></div>
    <div class="actions">${isNew || (m.role === 'owner' && !isSuper()) ? '' : '<button class="btn danger" id="x">Удалить</button>'}<span class="sp"></span><button class="btn ghost" data-close>Отмена</button><button class="btn pri" id="s">Сохранить</button></div>`);
  const pv = () => $('pv').innerHTML = avatar({ name: $('n').value || '?', color, photo }, 64);
  $('cl').onclick = e => { const i = e.target.closest('[data-c]'); if (!i) return; color = i.dataset.c; document.querySelectorAll('#cl i').forEach(x => x.classList.toggle('on', x === i)); pv(); };
  $('pf').onchange = e => {
    const f = e.target.files[0]; if (!f) return; const img = new Image(); const url = URL.createObjectURL(f);
    img.onload = () => { const S = 160, cv = document.createElement('canvas'); cv.width = cv.height = S; const k = Math.min(img.width, img.height); cv.getContext('2d').drawImage(img, (img.width - k) / 2, (img.height - k) / 2, k, k, 0, 0, S, S); photo = cv.toDataURL('image/jpeg', .82); URL.revokeObjectURL(url); pv(); };
    img.onerror = () => toast('Не удалось открыть фото'); img.src = url;
  };
  const pr = $('pr'); if (pr) pr.onclick = () => { photo = ''; pv(); pr.remove(); };
  $('s').onclick = async () => {
    const n = $('n').value.trim(), em = $('em').value.trim().toLowerCase();
    if (!n) { toast('Введите имя'); return; }
    if (!/^\S+@\S+\.\S+$/.test(em)) { toast('Введите корректный email'); return; }
    const row = { name: n, position: $('ps').value.trim(), in_journal: $('ij').checked, sort: +$('o').value || 0, color, photo };
    if (!ownerLocked) { row.email = em; row.role = $('rl').value; }
    const r = isNew ? await run(sb.from('members').insert({ ...row, studio_id: A.studio.id }).select().single()) : await run(sb.from('members').update(row).eq('id', m.id).select().single());
    D.members[r.id] = r; closeModal(); render(); toast(isNew ? `Добавлен. Пусть ${n} зарегистрируется с email ${em}` : 'Сохранено');
  };
  const x = $('x'); if (x) x.onclick = () => confirmBox('Удалить сотрудника? Его записи останутся в базе, но пропадут из журнала.', async () => { await run(sb.from('members').delete().eq('id', m.id)); delete D.members[m.id]; closeModal(); render(); });
}

/* ================= ОТЧЁТ ================= */
let reportRows = null;
function vReport() {
  const t = new Date(); let from, to = today();
  if (UI.period === 'day') from = to;
  else if (UI.period === 'week') { from = monday(to); to = addDays(from, 6); }
  else { from = iso(new Date(t.getFullYear(), t.getMonth(), 1)); to = iso(new Date(t.getFullYear(), t.getMonth() + 1, 0)); }
  const seg = `<div class="seg">${[['day', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц']].map(([k, v]) => `<button data-act="period" data-v="${k}" class="${UI.period === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
  if (!reportRows) {
    sb.from('appointments').select('day,status,price,member_id,service_ids,client_id').eq('studio_id', A.studio.id).gte('day', from).lte('day', to).limit(10000)
      .then(({ data, error }) => { reportRows = error ? [] : data; if (UI.tab === 'report') render(); });
    return backBtn() + seg + '<div class="empty">Загрузка…</div>';
  }
  const l = reportRows, done = l.filter(a => a.status === 'done'), act = l.filter(a => a.status !== 'cancelled');
  const rev = done.reduce((s, a) => s + (+a.price || 0), 0);
  const newC = arr('clients').filter(c => { const d = iso(new Date(c.created_at)); return d >= from && d <= to; }).length;
  let h = backBtn() + seg + `<div class="stats">
    <div class="stat"><small>Выручка (пришли)</small><b>${money(rev)}</b></div>
    <div class="stat"><small>Записей</small><b>${act.length}</b></div>
    <div class="stat"><small>Средний чек</small><b>${money(done.length ? rev / done.length : 0)}</b></div>
    <div class="stat"><small>Новых клиентов</small><b>${newC}</b></div>
    <div class="stat"><small>Пришли</small><b style="color:#1f7a37">${done.length}</b></div>
    <div class="stat"><small>Не пришли</small><b style="color:#d4291a">${l.filter(a => a.status === 'noshow').length}</b></div>
    <div class="stat"><small>Отмены</small><b class="muted">${l.filter(a => a.status === 'cancelled').length}</b></div>
    <div class="stat"><small>Ожидается</small><b>${money(act.filter(a => a.status !== 'done' && a.status !== 'noshow').reduce((s, a) => s + (+a.price || 0), 0))}</b></div>
  </div>`;
  const byM = membersSorted().map(m => { const x = done.filter(a => a.member_id === m.id); return { m, n: act.filter(a => a.member_id === m.id).length, d: x.length, s: x.reduce((s, a) => s + (+a.price || 0), 0) }; }).filter(r => r.n).sort((a, b) => b.s - a.s);
  h += `<div class="card" style="margin-bottom:12px"><b>По сотрудникам</b><table><tr><th>Сотрудник</th><th class="n">Записей</th><th class="n">Пришли</th><th class="n">Выручка</th></tr>${byM.map(r => `<tr><td>${esc(r.m.name)}</td><td class="n">${r.n}</td><td class="n">${r.d}</td><td class="n">${money(r.s)}</td></tr>`).join('') || '<tr><td colspan=4 class="muted">Нет данных</td></tr>'}</table></div>`;
  const sc = {}; done.forEach(a => (a.service_ids || []).forEach(id => { sc[id] = (sc[id] || 0) + 1; }));
  const top = Object.entries(sc).sort((a, b) => b[1] - a[1]).slice(0, 7);
  return h + `<div class="card"><b>Популярные услуги</b><table>${top.map(([id, n]) => `<tr><td>${esc(D.services[id]?.name || 'Удалённая услуга')}</td><td class="n">${n}</td></tr>`).join('') || '<tr><td class="muted">Нет данных</td></tr>'}</table></div>`;
}

/* ================= МОДАЛКИ ================= */
function openModal(html) { $('modal').innerHTML = `<div class="ov"><div class="sheet">${html}</div></div>`; }
function closeModal() { $('modal').innerHTML = ''; }
function confirmBox(text, yes) {
  const s = document.querySelector('#modal .sheet'); const box = document.createElement('div');
  box.className = 'warnbox'; box.style.marginTop = '12px';
  box.innerHTML = `<b>${esc(text)}</b><div class="actions" style="margin-top:8px"><button class="btn danger sm" id="cy">Да, удалить</button><button class="btn ghost sm" id="cn">Нет</button></div>`;
  s.appendChild(box); box.scrollIntoView({ behavior: 'smooth' });
  box.querySelector('#cy').onclick = yes; box.querySelector('#cn').onclick = () => box.remove();
}
setInterval(() => { if (A.view === 'studio' && UI.tab === 'journal' && !document.querySelector('#modal .ov')) render(); }, 60000);
