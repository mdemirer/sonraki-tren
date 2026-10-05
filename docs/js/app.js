// Arayüz: arama, istasyon sayfası, favoriler, ayarlar.
import {
  norm, istanbulNow, nextDepartures, serviceSpan, pickTimetable, ageDays, ageText,
  towards, minToHHMM, lineColor, textOn, DAY_LABEL, isTerminusFor,
} from './core.js';
import {
  store, bus, loadStations, refreshStations, stationById, cachedDirs, cachedTT, ttKey,
  syncStation, syncFavorites, downloadAll, isFav, toggleFav, moveFav, setSetting,
  clearTimetables, storageStats, refreshDisruptions, disruptionsFor, disruptionAge, disrStatus, isOnline,
  stationDebug, directionPlan,
} from './data.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const main = $('#main');
const banners = $('#banners');
const search = $('#q');
const pending = new Set();          // şu an indirilen istasyonlar
let stations = [];

// ---- yardımcılar -------------------------------------------------------------------
function groupsByName() {
  const g = new Map();
  for (const s of stations) {
    const k = norm(s.name);
    if (!g.has(k)) g.set(k, { key: k, name: s.name, items: [] });
    g.get(k).items.push(s);
  }
  for (const v of g.values()) v.items.sort((a, b) => a.line.localeCompare(b.line, 'tr', { numeric: true }));
  return g;
}

function pill(line) {
  const c = lineColor(line);
  return `<span class="pill" style="background:${c};color:${textOn(c)}">${esc(line)}</span>`;
}

function online() { return isOnline(); }

// ---- yön satırları ------------------------------------------------------------------
// Aynı son durağa giden seferlerin (birden fazla yön kaydı olabilir) bugünkü birleşik saatleri
function groupTimes(st, g, dayType) {
  const picks = g.dirs.map((d) => pickTimetable(cachedTT(st.id, d.id), dayType)).filter(Boolean);
  const times = [...new Set(picks.flatMap((p) => p.times))].sort((a, b) => a - b);
  return { times, picks };
}

// Büyük sayı, "sonra ..." ve işletme saatleri
function nextBits(times, now) {
  const deps = nextDepartures(times, now.secOfDay, 3);
  const span = serviceSpan(times);
  const first = deps[0];
  let big;
  if (first.inSec < 60) big = `<span class="next now"><b>şimdi</b></span>`;
  else if (first.in <= 90) big = `<span class="next"><b>${first.in}</b><small>dk</small></span>`;
  else big = `<span class="next clock"><b>${minToHHMM(first.at)}</b></span>`;
  let later = '';
  const rest = deps.slice(1).filter((d) => d.in <= 120);
  if (first.in > 90 && span && first.at === span.first) later = 'ilk tren';
  else if (rest.length) later = 'sonra ' + rest.map((d) => d.in).join(' ve ') + ' dk';
  const range = span ? `${minToHHMM(span.first)} ile ${minToHHMM(span.last)} arası` : '';
  return `${big}<span class="later">${esc(later)}</span><span class="range">${range}</span>`;
}

const dirLabel = (dest) => `<span class="to">${esc(dest)} <span class="yon">yönü</span></span>`;

// Yön planındaki bir satır: süreler, son durak ya da "sefer görünmüyor"
function planRow(st, r, now, hasNotice) {
  if (r.type === 'times') {
    if (r.groups.length === 1) {
      const { times, picks } = groupTimes(st, r.groups[0], now.dayType);
      return { html: `<li class="dir">${dirLabel(r.groups[0].dest)}${nextBits(times, now)}</li>`, picks };
    }
    // Aynı tarafta farklı son duraklara giden seferler (ör. T1'de Kabataş ve Eminönü)
    const parts = r.groups.map((g) => {
      const { times, picks } = groupTimes(st, g, now.dayType);
      // Şu an çalışmayan kısa sefer (ör. akşam 21:00'den sonra) soluk görünsün
      const idle = times.length && nextDepartures(times, now.secOfDay, 1)[0].in > 90;
      return { html: `<div class="sub${idle ? ' idle' : ''}"><span class="to">${esc(g.dest)} seferi</span>${nextBits(times, now)}</div>`, picks };
    });
    return {
      html: `<li class="dir multi">${dirLabel(r.groups[0].dest)}${parts.map((p) => p.html).join('')}</li>`,
      picks: parts.flatMap((p) => p.picks),
    };
  }
  const label = `<span class="to">${esc(towards(r.dir.name))} <span class="yon">yönü</span></span>`;
  let msg, cls = 'dir empty';
  if (r.type === 'end') { msg = 'Son durak; bu yönde tren kalkmaz.'; cls += ' end'; }
  else if (r.type === 'none') {
    msg = hasNotice ? 'Bu istasyondan şu an bu yöne sefer görünmüyor. Hat duyurusuna bak.' : 'Metro İstanbul bu yön için tarife vermiyor.';
  } else {
    msg = pending.has(st.id) ? 'Tarife indiriliyor' : online() ? 'Tarife alınamadı' : 'Bu tarife cihazda yok';
  }
  return { html: `<li class="${cls}">${label}<span class="status">${msg}</span></li>` };
}

// Kartın altındaki tek not: gün tipi uyuşmazlığı ya da eski tarife
function cardNote(picks, now, notices = [], alt = false) {
  if (!picks.length) return '';
  // Hatta duyuru varken yön listesi ve saatler Metro İstanbul'un sisteminde ne varsa o;
  // aktarmalı ya da bölünmüş işletmeyi yansıtmayabilir.
  const notes = [];
  if (alt) notes.push("Hatta geçici sefer düzeni var. Bu istasyondan Metro İstanbul'un geçici planında görünen seferler gösteriliyor.");
  else if (notices.length) notes.push("Hatta duyuru var. Yönler ve süreler Metro İstanbul'un tarife servisinden geliyor; duyurudaki geçici düzenlemeyi yansıtmayabilir.");
  const mis = picks.find((p) => p.mismatch);
  const oldest = Math.min(...picks.map((p) => p.at));
  if (mis) notes.push(`Bugün ${DAY_LABEL[now.dayType]}; cihazdaki tarife ${DAY_LABEL[mis.dayType]} günü indirildi. Saatler farklı olabilir.`);
  else if (ageDays(oldest) > store.settings.staleDays) notes.push(`Tarife ${ageText(oldest)} indirildi.`);
  return notes.map((n) => `<p class="card-note warn">${n}</p>`).join('');
}

// ---- arıza kutusu -------------------------------------------------------------------
function alertsFor(st) {
  const items = disruptionsFor(st);
  if (!items.length) return '';
  const age = disruptionAge();
  const old = age && Date.now() - age > 2 * 36e5 ? ` <span class="age">(${ageText(age)} alınan bilgi)</span>` : '';
  return items.map((it) => {
    const sev = it.severity === 'major' ? 'major' : 'minor';
    const head = `${esc(it.line)} hattı için duyuru.`;
    const where = it.affectsStation ? ' <span class="mention">Duyuruda bu istasyon geçiyor.</span>' : '';
    const when = it.updated ? ` <span class="age">(${esc(it.updated)})</span>` : '';
    return `<div class="alert ${sev}" role="status"><strong>${head}</strong> ${esc(it.message || '')}${when}${where}${old}</div>`;
  }).join('');
}

// ---- istasyon kartı -----------------------------------------------------------------
function card(st, now, opts = {}) {
  const c = lineColor(st.line);
  const dirs = cachedDirs(st);
  const fav = isFav(st.id);
  const notices = disruptionsFor(st);
  const doubt = notices.some((n) => n.severity === 'major');
  let body, note = '';
  if (dirs && dirs.length) {
    const plan = directionPlan(st, now.dayType);
    const rows = plan.map((r) => planRow(st, r, now, notices.length > 0));
    body = rows.map((r) => r.html).join('');
    note = cardNote(rows.flatMap((r) => r.picks || []), now, notices, plan.some((r) => r.alt));
  }
  else if (pending.has(st.id)) body = `<li class="dir empty"><span class="status">Tarife indiriliyor</span></li>`;
  else if (!online()) body = `<li class="dir empty"><span class="status">Bu istasyonun tarifesi cihazda yok. İnternete bağlanınca indirilir.</span></li>`;
  else body = `<li class="dir empty"><span class="status">Tarife alınamadı. Ayarlar sayfasındaki tanılama bölümüne bakabilirsin.</span></li>`;

  const pos = store.favs.indexOf(st.id);
  const order = opts.reorder ? `<span class="order">
      ${pos > 0 ? `<button class="icon small" data-move="${st.id}" data-d="-1" aria-label="${esc(st.name)} yukarı taşı">${ICON.up}</button>` : ''}
      ${pos < store.favs.length - 1 ? `<button class="icon small" data-move="${st.id}" data-d="1" aria-label="${esc(st.name)} aşağı taşı">${ICON.down}</button>` : ''}
    </span>` : '';
  return `<article class="card${doubt ? ' doubt' : ''}" style="--line:${c}">
    <header>
      ${pill(st.line)}
      <h3>${opts.link ? `<a href="#/s/${encodeURIComponent(norm(st.name))}">${esc(st.name)}</a>` : esc(st.name)}</h3>
      ${order}
      <button class="icon star" data-fav="${st.id}" aria-pressed="${fav}" aria-label="${fav ? 'Favorilerden çıkar' : 'Favorilere ekle'}">${fav ? ICON.starOn : ICON.starOff}</button>
    </header>
    ${alertsFor(st)}
    <ul class="dirs">${body}</ul>
    ${note}
  </article>`;
}

// ---- üst uyarılar --------------------------------------------------------------------
function renderBanners(now) {
  const out = [];
  if (!online()) out.push(`<div class="banner">Çevrimdışısın. Cihazda kayıtlı tarifeler gösteriliyor.</div>`);

  // Favorilerdeki en eski tarife
  let oldest = null, missing = 0;
  for (const id of store.favs) {
    const st = stationById(id);
    const dirs = st && cachedDirs(st);
    if (!dirs) { missing++; continue; }
    for (const r of directionPlan(st, now.dayType)) {
      if (r.type === 'missing') { missing++; continue; }
      if (r.type !== 'times') continue;
      for (const g of r.groups) for (const p of groupTimes(st, g, now.dayType).picks) {
        if (!oldest || p.at < oldest) oldest = p.at;
      }
    }
  }
  if (oldest && ageDays(oldest) > store.settings.staleDays) {
    out.push(`<div class="banner warn">Favori istasyonlarının tarifesi ${Math.floor(ageDays(oldest))} gündür güncellenmedi. Saatler değişmiş olabilir; internete bağlandığında kendiliğinden yenilenir.</div>`);
  }
  if (missing && !online() && store.favs.length) {
    out.push(`<div class="banner warn">Bazı favorilerinin tarifesi cihazda yok.</div>`);
  }

  setHTML(banners, out.join(''));
}

// ---- arıza durum satırı ve Yenile düğmesi -------------------------------------------
function whenText(ts) {
  if (!ts) return '';
  if (Date.now() - ts < 12 * 36e5) {
    return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  }
  return ageText(ts);
}

function disrLine() {
  const age = disruptionAge();
  const n = ((store.disr && store.disr.items) || []).length;
  const st = disrStatus.state;
  let text, detail = '', cls = '';
  if (st === 'loading') {
    text = 'Arızalar kontrol ediliyor';
  } else if (st === 'error') {
    cls = 'warn';
    text = age ? `Arızalar şu an kontrol edilemedi. Gösterilen bilgi: son kontrol ${whenText(age)}.` : 'Arıza bilgisi alınamadı.';
    detail = disrStatus.error || '';
  } else if (!age) {
    text = 'Arızalar henüz kontrol edilmedi.';
  } else {
    text = `Arızalar: son kontrol ${whenText(age)}.` + (n ? '' : ' Bildirilen arıza yok.');
    if (Date.now() - age > 2 * 36e5) cls = 'warn';
  }
  const btn = st === 'loading'
    ? `<button class="link" disabled>Yenile</button>`
    : `<button class="link" data-disr-refresh>${st === 'error' ? 'Tekrar dene' : 'Yenile'}</button>`;
  return `<div class="disr-line ${cls}" aria-live="polite"><span>${esc(text)}${detail ? ` <small>${esc(detail)}</small>` : ''}</span>${btn}</div>`;
}

// ---- görünümler ---------------------------------------------------------------------
function viewHome(now) {
  const q = search.value.trim();
  if (q) return viewResults(q);
  if (!store.favs.length) {
    return `<section class="empty-state">
      <h2>Favori istasyonun yok</h2>
      <p>Yukarıdan bir istasyon ara, sayfasındaki yıldıza dokun. Favoriler burada her iki yönüyle birlikte görünür ve internet olmadan da çalışır.</p>
    </section>`;
  }
  const reorder = store.favs.length > 1;
  return disrLine() + store.favs.map((id) => stationById(id)).filter(Boolean)
    .map((st) => card(st, now, { link: true, reorder })).join('');
}

function viewResults(q) {
  const nq = norm(q);
  const groups = [...groupsByName().values()]
    .filter((g) => g.key.includes(nq) || g.items.some((s) => norm(s.line) === nq))
    .sort((a, b) => (b.key.startsWith(nq) - a.key.startsWith(nq)) || a.name.localeCompare(b.name, 'tr'))
    .slice(0, 25);
  if (!groups.length) return `<p class="none">"${esc(q)}" ile eşleşen istasyon yok. Yazımı kontrol et ya da hat adıyla dene (ör. M4).</p>`;
  return `<ul class="results">${groups.map((g) => `
    <li><a href="#/s/${encodeURIComponent(g.key)}"><span class="rname">${esc(g.name)}</span>
      <span class="rlines">${g.items.map((s) => pill(s.line)).join('')}</span></a></li>`).join('')}</ul>`;
}

function viewStation(key, now) {
  const g = groupsByName().get(key);
  if (!g) return `<p class="none">İstasyon bulunamadı.</p>`;
  return `<div class="crumb"><a href="#/" class="back">${ICON.back} Favoriler</a></div>
    <h2 class="station-title">${esc(g.name)}</h2>
    ${disrLine()}
    ${g.items.map((st) => card(st, now)).join('')}
    ${store.settings.devTools ? `<div class="raw">
      <button class="link" data-raw="${esc(g.key)}">Bu istasyonun ham verisini al</button>
      <p class="raw-help">İBB'nin bu istasyon için döndürdüğü yönleri ve tarifeleri toplar.</p>
    </div>` : ''}`;
}

async function collectRaw(key, btn) {
  const g = groupsByName().get(key);
  if (!g) return;
  btn.disabled = true;
  btn.textContent = 'Veri toplanıyor';
  const results = [];
  for (const st of g.items) results.push(await stationDebug(st));
  const text = JSON.stringify({ version: window.MT_VERSION, results }, null, 1);
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { /* aşağıdaki kutudan kopyalanır */ }
  const box = document.createElement('div');
  box.className = 'raw-out';
  box.innerHTML = `<p class="raw-help">${copied ? 'Panoya kopyalandı. ' : ''}Metnin tamamı aşağıda.</p><textarea readonly rows="10"></textarea>`;
  box.querySelector('textarea').value = text;
  btn.closest('.raw').replaceWith(box);
  main._html = null;   // DOM elle değişti; bir sonraki çizim karşılaştırma yapmadan yazsın
  rawOpen = true;
}
let rawOpen = false;

function viewSettings() {
  const s = storageStats();
  const m = store.meta;
  const d = m.diag || {};
  const err = m.lastError;
  const stations = store.stations || {};
  return `<div class="crumb"><a href="#/" class="back">${ICON.back} Favoriler</a></div>
  <h2 class="station-title">Ayarlar</h2>

  <section class="panel">
    <h3>Çevrimdışı kullanım</h3>
    <p>Favori istasyonların tarifeleri kendiliğinden indirilir. Tüm hatları da indirirsen internet yokken herhangi bir istasyona bakabilirsin. İBB sunucusunu yormamak için istasyonlar sırayla indirilir; birkaç dakika sürer.</p>
    <p class="stat">Cihazda ${s.stCount} istasyonun ${s.ttCount} tarifesi var (${Math.round(s.bytes / 1024)} KB).</p>
    <div class="row">
      <button id="dlAll" class="btn">Tüm hatların tarifesini indir</button>
      <button id="syncNow" class="btn ghost">Şimdi güncelle</button>
    </div>
    <progress id="dlProg" max="1" value="0" hidden></progress>
    <p id="dlMsg" class="stat" aria-live="polite"></p>
  </section>

  <section class="panel">
    <h3>Eski tarife uyarısı</h3>
    <label class="row">Tarife
      <select id="staleDays">${[3, 7, 14, 30].map((n) => `<option value="${n}" ${store.settings.staleDays === n ? 'selected' : ''}>${n} gün</option>`).join('')}</select>
      güncellenmezse uyar</label>
  </section>

  <section class="panel" id="installPanel" hidden>
    <h3>Ana ekrana ekle</h3>
    <button id="installBtn" class="btn">Uygulamayı yükle</button>
  </section>

  <section class="panel">
    <h3>Bu süreler nereden geliyor?</h3>
    <p>Geliş süreleri Metro İstanbul'un yayımladığı sefer tarifesinden hesaplanır. Trenlerin anlık konumu açık veri olarak yayımlanmadığı için gecikme ve aksamalar sürelere yansımaz. Arıza duyuruları Metro İstanbul'un hizmet durumu servisinden alınır; metro.istanbul'daki "Sefer Durumları" sayfasıyla aynı bilgidir.</p>
    <p>Uygulama sadece İBB sunucularıyla konuşur. Uygulamanın kendisi telefonda saklandığı için açılmak için internete ihtiyaç duymaz. Yeni sürüm yayımlandığında telefona inmesi için uygulamanın bir kez yayın adresine erişebilmesi gerekir.</p>
  </section>

  <section class="panel">
    <h3>Kaynak ve gizlilik</h3>
    <p>Bu uygulama resmi değildir. İBB, Metro İstanbul veya bağlı kuruluşları tarafından geliştirilmemiş ya da onaylanmamıştır.</p>
    <p><a href="https://data.ibb.gov.tr" target="_blank" rel="noopener">İBB Açık Veri Portalı</a>'ndan, Atıf 4.0 Uluslararası (CC BY 4.0) kapsamında lisanslanan kamu sektörü bilgilerini içerir. <a href="https://data.ibb.gov.tr/license" target="_blank" rel="noopener">Lisans metni</a>. Veriler olduğu gibi gösterilir; doğruluğu garanti edilmez.</p>
    <p>Uygulama kişisel veri toplamaz. Favoriler, tarifeler ve ayarlar yalnızca bu cihazda saklanır.</p>
  </section>

  <section class="panel">
    <h3>Tanılama</h3>
    <dl class="diag">
      <dt>Son başarılı bağlantı</dt><dd>${m.lastOkAt ? ageText(m.lastOkAt) : 'yok'}</dd>
      <dt>Son hata</dt><dd>${err ? esc(err.where + ': ' + err.msg) + ' (' + ageText(err.at) + ')' : 'yok'}</dd>
      <dt>İstasyon listesi</dt><dd>${stations.seed || !stations.fetchedAt ? 'paket içi kopya' : ageText(stations.fetchedAt)} (${(stations.list || []).length} istasyon)</dd>
      <dt>Son tarife yanıtı</dt><dd>${d.at ? esc(`${d.station}, ${d.dir}: ${d.count} sefer, alan ${d.path || 'bulunamadı'}, TimeInfos sayısı ${d.timeInfos == null ? '?' : d.timeInfos}, API gün kodu ${d.apiDay == null ? '?' : d.apiDay}${d.apiDayName ? ' (' + d.apiDayName + ')' : ''}, ${DAY_LABEL[d.dayType] || '?'} günü alındı`) : 'henüz yok'}</dd>
      <dt>Son yön listesi</dt><dd>${m.diagDirs ? esc(m.diagDirs.station + ': ' + m.diagDirs.sample) : 'henüz yok'}</dd>
      <dt>Arıza kaynağı</dt><dd>${store.disr ? 'Metro İstanbul GetServiceStatuses, ' + ageText(disruptionAge()) + ', ' + store.disr.items.length + ' duyuru' : 'alınamadı'}</dd>
      <dt>Gün tipi</dt><dd>${DAY_LABEL[istanbulNow().dayType]}</dd>
    </dl>
    ${d.sample ? `<pre class="sample">${esc(d.sample)}</pre>` : ''}
    <label class="row check"><input type="checkbox" id="devTools" ${store.settings.devTools ? 'checked' : ''}> İstasyon sayfalarında ham veri düğmesini göster</label>
    <div class="row">
      <button id="copyDiag" class="btn ghost">Tanılamayı kopyala</button>
      <button id="wipe" class="btn ghost danger">Tarifeleri sil</button>
    </div>
  </section>
  <p class="ver">Sürüm ${esc(window.MT_VERSION || '')}</p>`;
}

// ---- yönlendirme ve çizim -----------------------------------------------------------
function route() {
  const h = location.hash || '#/';
  if (h.startsWith('#/s/')) return { name: 'station', key: decodeURIComponent(h.slice(4)) };
  if (h === '#/ayarlar') return { name: 'settings' };
  return { name: 'home' };
}

// Sadece değişen içerik DOM'a yazılır: ekran sık yenilendiği için dokunuşlar kaybolmasın
function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

function render() {
  const now = istanbulNow();
  const r = route();
  document.body.dataset.view = r.name;
  renderBanners(now);
  if (r.name === 'settings') { main._html = null; main.innerHTML = viewSettings(); wireSettings(); }
  else if (r.name === 'station') setHTML(main, viewStation(r.key, now));
  else setHTML(main, viewHome(now));
}

// Sadece sayılar değişir; ayarlar sayfası açıkken tick çizmez (formu bozmasın)
function tick() { if (route().name !== 'settings' && !rawOpen) render(); }

async function syncGroup(items) {
  if (!online()) return;
  for (const st of items) {
    pending.add(st.id);
  }
  render();
  for (const st of items) {
    await syncStation(st).catch(() => {});
    pending.delete(st.id);
    render();
  }
}

function onRoute() {
  rawOpen = false;
  const r = route();
  if (r.name === 'station') {
    search.value = '';
    const g = groupsByName().get(r.key);
    if (g) syncGroup(g.items);
  }
  render();
  window.scrollTo(0, 0);
}

// ---- olaylar ------------------------------------------------------------------------
main.addEventListener('click', (e) => {
  if (e.target.closest('[data-disr-refresh]')) { refreshDisruptions(true); return; }
  const raw = e.target.closest('[data-raw]');
  if (raw) { collectRaw(raw.dataset.raw, raw); return; }
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const id = +fav.dataset.fav;
    const added = toggleFav(id);
    if (added) { const st = stationById(id); if (st) syncGroup([st]); }
    render();
    return;
  }
  const mv = e.target.closest('[data-move]');
  if (mv) { moveFav(+mv.dataset.move, +mv.dataset.d); render(); }
});

search.addEventListener('input', () => {
  if (route().name !== 'home') { history.replaceState(null, '', '#/'); }
  render();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const a = $('.results a', main); if (a) location.hash = a.getAttribute('href'); }
  if (e.key === 'Escape') { search.value = ''; render(); }
});

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

let dlCtl = null;
function wireSettings() {
  const sel = $('#staleDays');
  sel.addEventListener('change', () => setSetting('staleDays', +sel.value));
  const dev = $('#devTools');
  dev.addEventListener('change', () => setSetting('devTools', dev.checked));
  const dl = $('#dlAll'), prog = $('#dlProg'), msg = $('#dlMsg');
  if (dlCtl) { dl.textContent = 'İndirmeyi durdur'; prog.hidden = false; }
  dl.addEventListener('click', async () => {
    if (dlCtl) { dlCtl.abort(); return; }
    if (!online()) { msg.textContent = 'İnternet bağlantısı yok.'; return; }
    dlCtl = new AbortController();
    dl.textContent = 'İndirmeyi durdur';
    prog.hidden = false;
    const res = await downloadAll((d, t, f) => {
      const p = $('#dlProg'), m = $('#dlMsg');
      if (p) { p.max = t; p.value = d; }
      if (m) m.textContent = `${d} / ${t} istasyon${f ? `, ${f} tanesi alınamadı` : ''}`;
    }, dlCtl.signal);
    dlCtl = null;
    if (route().name === 'settings') {
      render();
      $('#dlMsg').textContent = res.failed
        ? `${res.done - res.failed} istasyon indirildi, ${res.failed} tanesi alınamadı.`
        : `${res.done} istasyonun tarifesi indirildi.`;
    }
  });
  $('#syncNow').addEventListener('click', async () => {
    $('#dlMsg').textContent = 'Güncelleniyor';
    await Promise.allSettled([refreshStations(true), syncFavorites(true), refreshDisruptions(true)]);
    render();
    $('#dlMsg').textContent = store.meta.lastError && Date.now() - store.meta.lastError.at < 30000
      ? 'Bazı veriler alınamadı: ' + store.meta.lastError.msg : 'Güncellendi.';
  });
  $('#wipe').addEventListener('click', () => {
    if (confirm('Cihazdaki tüm tarifeler silinsin mi? Favoriler kalır.')) { clearTimetables(); render(); }
  });
  $('#copyDiag').addEventListener('click', async () => {
    const text = JSON.stringify({ version: window.MT_VERSION, meta: store.meta, ua: navigator.userAgent }, null, 2);
    try { await navigator.clipboard.writeText(text); $('#copyDiag').textContent = 'Kopyalandı'; }
    catch (e) { prompt('Kopyalayın:', text); }
  });
  if (deferredInstall) {
    $('#installPanel').hidden = false;
    $('#installBtn').addEventListener('click', async () => { deferredInstall.prompt(); deferredInstall = null; $('#installPanel').hidden = true; });
  }
}

// ---- simgeler -----------------------------------------------------------------------
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" ${extra}><path d="${d}"/></svg>`;
const ICON = {
  starOn: svg('M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z', 'class="filled"'),
  starOff: svg('M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z', 'class="outline"'),
  back: svg('M15 5l-7 7 7 7', 'class="stroke"'),
  up: svg('M6 15l6-6 6 6', 'class="stroke"'),
  down: svg('M6 9l6 6 6-6', 'class="stroke"'),
};

// ---- başlangıç ----------------------------------------------------------------------
async function start() {
  stations = await loadStations();
  window.addEventListener('hashchange', onRoute);
  bus.addEventListener('change', (e) => {
    if (e.detail === 'stations') stations = store.stations.list;
    if (route().name !== 'settings' || e.detail === 'settings') tick();
  });
  window.addEventListener('online', () => { render(); backgroundSync(); });
  window.addEventListener('offline', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); backgroundSync(); } });
  onRoute();
  backgroundSync();
  // Süreler saniyeyle hesaplandığı için birkaç saniyede bir; değişmeyen ekran yeniden çizilmez
  setInterval(tick, 5000);
  // Uygulama açık kaldıkça sadece tarifeler yenilenir; arızalar açılışta ve Yenile ile çekilir
  setInterval(() => { if (!document.hidden) backgroundSync({ disruptions: false }); }, 30 * 60000);
}

// Açılışta, internete dönünce ve uygulamaya geri gelince çalışır.
// Arızalar en fazla 5 dakikada bir otomatik çekilir.
async function backgroundSync({ disruptions = true } = {}) {
  if (!online()) return;
  if (disruptions) refreshDisruptions().catch(() => {});
  await refreshStations().catch(() => {});
  await syncFavorites().catch(() => {});
  render();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}

start();
