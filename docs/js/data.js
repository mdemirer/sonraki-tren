// Veri katmanı: Metro İstanbul API'si, cihazdaki önbellek (localStorage) ve arıza dosyası.
import { parseTimes, istanbulNow, lineMatches, mentionsStation, isTerminusFor, mapServiceStatuses, pickTimetable, norm, towards } from './core.js';

const CFG = (typeof window !== 'undefined' && window.MT_CONFIG) || {};
export const API = CFG.apiBase || 'https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2';

const K = {
  stations: 'mt.stations', dirs: 'mt.dirs', lineDirs: 'mt.linedirs', tt: 'mt.tt', favs: 'mt.favs',
  settings: 'mt.settings', meta: 'mt.meta', disr: 'mt.disr',
};
// Yön listesi arıza ya da bakım sırasında geçici olarak değişebiliyor (ör. M7'de bölünmüş işletme),
// bu yüzden tarifeyle aynı sıklıkta yenilenir; hatta duyuru varsa çok daha sık.
const DIRS_MAX_AGE = 20 * 36e5;
const NOTICE_MAX_AGE = 30 * 6e4;      // hatta duyuru varken yön ve tarife en fazla 30 dk bekletilir
const STATIONS_MAX_AGE = 7 * 864e5;
const TT_MAX_AGE = 20 * 36e5;         // aynı gün tipi için günde bir kez yenile
const DISR_MAX_AGE = 5 * 6e4;
// "Tüm hatları indir" sırasında istasyonlar arası bekleme (testlerde kısaltılabilir)
const DOWNLOAD_GAP_MS = (typeof window !== 'undefined' && window.MT_CONFIG && window.MT_CONFIG.downloadGapMs != null)
  ? window.MT_CONFIG.downloadGapMs : 300;

function load(k, def) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { logError('Depolama', 'Cihazda yer kalmadı: ' + e.message); return false; }
}

export const store = {
  stations: load(K.stations, null),
  dirs: load(K.dirs, {}),
  lineDirs: load(K.lineDirs, {}),
  tt: load(K.tt, {}),
  favs: load(K.favs, []),
  settings: Object.assign({ staleDays: 7 }, load(K.settings, {})),
  meta: load(K.meta, { lastOkAt: null, lastError: null, diag: {} }),
  disr: load(K.disr, null),
};

export const bus = new EventTarget();
const changed = (what) => bus.dispatchEvent(new CustomEvent('change', { detail: what }));

function logError(where, msg) {
  store.meta.lastError = { at: Date.now(), where, msg: String(msg).slice(0, 300) };
  try { localStorage.setItem(K.meta, JSON.stringify(store.meta)); } catch (e) { /* yer yoksa yapacak bir şey yok */ }
}
function noteOk() { store.meta.lastOkAt = Date.now(); save(K.meta, store.meta); }

export function isOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; }

// ---- API çağrısı -------------------------------------------------------------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// İBB ağ geçidi kısa sürede çok istek gelince bir süre 503 döndürebiliyor.
// O durumda bekleyip en fazla iki kez daha dene.
async function fetchPolite(url, opts) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, opts);
    if ((r.status === 503 || r.status === 429) && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    return r;
  }
}

async function call(method, path, body, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchPolite(API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.Success === false) {
      throw new Error('API hata döndürdü: ' + ((j.Error && j.Error.Message) || j.Message || 'Success=false'));
    }
    noteOk();
    return j && typeof j === 'object' && 'Data' in j ? j.Data : j;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Zaman aşımı' : e.message;
    logError(path, msg);
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// ---- istasyonlar ---------------------------------------------------------------------
export async function loadStations() {
  if (store.stations && store.stations.list && store.stations.list.length) return store.stations.list;
  // Paket içindeki başlangıç listesi (service worker önbelleğinde, çevrimdışı da gelir)
  const r = await fetch('./data/stations.json');
  const j = await r.json();
  store.stations = { fetchedAt: j.fetchedAt || null, seed: true, list: j.list };
  return store.stations.list;
}

export async function refreshStations(force = false) {
  const s = store.stations;
  if (!force && s && !s.seed && s.fetchedAt && Date.now() - s.fetchedAt < STATIONS_MAX_AGE) return false;
  if (!isOnline()) return false;
  const data = await call('GET', '/GetStations');
  const list = (Array.isArray(data) ? data : []).map((x) => ({
    id: x.Id, lineId: x.LineId, line: x.LineName,
    lat: x.DetailInfo ? +x.DetailInfo.Latitude : null,
    lng: x.DetailInfo ? +x.DetailInfo.Longitude : null,
    name: x.Description || x.Name,
  })).filter((x) => x.id != null && x.lineId != null && x.name);
  if (list.length < 50) { logError('/GetStations', 'Beklenenden az istasyon geldi: ' + list.length); return false; }
  store.stations = { fetchedAt: Date.now(), list };
  save(K.stations, store.stations);
  changed('stations');
  return true;
}

export function stationById(id) {
  const list = (store.stations && store.stations.list) || [];
  return list.find((s) => s.id === id) || null;
}

// ---- yönler -------------------------------------------------------------------------
export function cachedDirs(st) {
  const d = store.dirs[st.id];
  return d ? d.dirs : null;
}

export async function ensureDirs(st, force = false) {
  const c = store.dirs[st.id];
  const maxAge = lineHasNotice(st) ? NOTICE_MAX_AGE : DIRS_MAX_AGE;
  // 1.4.0 öncesi kayıtlarda hattın tarafı (side) yok; onları bayat say ve yenile
  const legacy = c && c.dirs.some((d) => !('side' in d));
  if (c && !force && !legacy && Date.now() - c.at < maxAge) return c.dirs;
  if (!isOnline()) return c ? c.dirs : null;
  try {
    const data = await call('POST', '/GetDirectionsByLineIdAndStationId', { lineId: st.lineId, stationId: st.id });
    store.meta.diagDirs = { at: Date.now(), station: st.name + ' ' + st.line, sample: JSON.stringify(data).slice(0, 500) };
    save(K.meta, store.meta);
    const dirs = mapDirs(data);
    if (!dirs.length && c) return c.dirs;
    store.dirs[st.id] = { at: Date.now(), dirs };
    save(K.dirs, store.dirs);
    return dirs;
  } catch (e) {
    return c ? c.dirs : null;
  }
}

// API yön kaydı -> { id, name, side }. side = DirectionValue: hattın hangi ucuna gidildiği
// (M7'de 1 Mahmutbey tarafı, 0 Yıldız tarafı). Geçici kısa seferler de aynı değeri taşıyor.
function mapDirs(data) {
  return (Array.isArray(data) ? data : [])
    .map((d) => ({ id: d.DirectionId, name: d.DirectionName, side: d.DirectionValue != null ? d.DirectionValue : null }))
    .filter((d) => d.id != null);
}

// Hattın bütün yönleri (geçici kısa seferler dahil). İstasyonun kendi yön listesi bazen
// sadece ana seferi içeriyor; arıza sırasında istasyondan geçen kısa seferler buradan bulunur.
export function cachedLineDirs(st) {
  const d = store.lineDirs[st.lineId];
  return d ? d.dirs : null;
}

export async function ensureLineDirs(st, force = false) {
  const c = store.lineDirs[st.lineId];
  const maxAge = lineHasNotice(st) ? NOTICE_MAX_AGE : DIRS_MAX_AGE;
  if (c && !force && Date.now() - c.at < maxAge) return c.dirs;
  if (!isOnline()) return c ? c.dirs : null;
  try {
    const dirs = mapDirs(await call('GET', '/GetDirectionById/' + encodeURIComponent(st.lineId)));
    if (!dirs.length && c) return c.dirs;
    store.lineDirs[st.lineId] = { at: Date.now(), dirs };
    save(K.lineDirs, store.lineDirs);
    return dirs;
  } catch (e) {
    return c ? c.dirs : null;
  }
}

// Bir istasyonda gösterilecek satırlar. Hattın her tarafı (DirectionValue) için bir satır.
// Bir taraftaki seferler son durağa göre gruplanır: T1'de Kabataş tarafında hem Kabataş'a giden
// ana sefer hem Eminönü'nde biten kısa sefer olabilir. Kaynaklar:
//  - istasyonun kendi yön listesi (ana sefer),
//  - hattın tüm yönleri (kısa seferler, onarım sırasındaki geçici seferler).
// Bir tarafta bu istasyondan kalkış yoksa: son durak ya da "sefer görünmüyor".
export function directionPlan(st, dayType) {
  const own = cachedDirs(st) || [];
  const line = cachedLineDirs(st) || [];
  // Tarafı bilinmeyen eski kayıtlarda tarafı hattın listesinden (aynı yön kimliği) al
  const sideOf = (d) => {
    if (d.side != null) return d.side;
    const l = line.find((x) => x.id === d.id);
    return l && l.side != null ? l.side : null;
  };
  const keyOf = (d) => (sideOf(d) != null ? 's' + sideOf(d) : 'i' + d.id);
  const pick = (d) => pickTimetable(cachedTT(st.id, d.id), dayType);
  const departs = (d) => !isTerminusFor(st.name, d.name) && !!pick(d);
  const count = (d) => { const p = pick(d); return p ? p.times.length : 0; };
  const keys = [];
  for (const d of own) if (!keys.includes(keyOf(d))) keys.push(keyOf(d));
  const rows = [];
  for (const key of keys) {
    const mine = own.filter((d) => keyOf(d) === key);
    const mineDep = mine.filter(departs);
    const extra = line
      .filter((d) => keyOf(d) === key && !own.some((o) => o.id === d.id) && departs(d))
      .sort((a, b) => count(b) - count(a));
    const groups = [];
    for (const d of mineDep.concat(extra)) {
      const dest = towards(d.name);
      const g = groups.find((x) => norm(x.dest) === norm(dest));
      if (g) g.dirs.push(d); else groups.push({ dest, dirs: [d] });
    }
    if (groups.length) {
      // alt: istasyonun kendi listesindeki sefer buradan geçmiyor, sadece geçici/kısa seferler var
      rows.push({ type: 'times', groups, dir: groups[0].dirs[0], alt: mineDep.length === 0 });
      continue;
    }
    const label = mine[0];
    if (mine.some((d) => isTerminusFor(st.name, d.name))) rows.push({ type: 'end', dir: label });
    else if (mine.some((d) => (cachedTT(st.id, d.id) || {}).none)) rows.push({ type: 'none', dir: label });
    else rows.push({ type: 'missing', dir: label });
  }
  // son durak satırları en alta
  return rows.filter((r) => r.type !== 'end').concat(rows.filter((r) => r.type === 'end'));
}

// ---- tarifeler ---------------------------------------------------------------------
export const ttKey = (stId, dirId) => stId + '|' + dirId;

// Yanıtın içinden saat listesini çıkarır. Önce bilinen yol (Data[0].TimeInfos[0].Times),
// bulamazsa yapının içinde "HH:MM" dizisi arar.
export function extractTimes(data) {
  const row = Array.isArray(data) ? data[0] : data;
  const ti = row && row.TimeInfos;
  const tiObj = Array.isArray(ti) ? ti[0] : ti;
  const meta = {
    tiCount: Array.isArray(ti) ? ti.length : (ti ? 1 : null),
    apiDay: tiObj && tiObj.Day != null ? tiObj.Day : null,
    apiDayName: tiObj ? tiObj.DayName || null : null,
  };
  const times = tiObj && tiObj.Times;
  if (Array.isArray(times) && times.length) {
    return Object.assign({ times, path: Array.isArray(ti) ? 'Data[0].TimeInfos[0].Times' : 'Data[0].TimeInfos.Times' }, meta);
  }
  const seen = new Set();
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return null;
    seen.add(o);
    if (Array.isArray(o) && o.length && o.every((x) => typeof x === 'string' && /^\d{1,2}:\d{2}/.test(x))) return { times: o, path: p };
    for (const k of Object.keys(o)) { const r = walk(o[k], p + '.' + k); if (r) return r; }
    return null;
  };
  const found = walk(data, 'Data');
  return Object.assign(found || { times: [], path: null }, meta);
}

export function cachedTT(stId, dirId) { return store.tt[ttKey(stId, dirId)] || null; }

// API'nin "bu yön için tarife yok" anlamına gelen hatası (ör. yönün son durağında sorgulanınca)
const NO_TT = /index was out of range|sequence contains no elements|bulunamad/i;

export async function ensureTT(st, dir, force = false, quiet = false) {
  // Son durakta o yöne tren kalkmaz; API'ye hiç sorma
  if (isTerminusFor(st.name, dir.name)) return null;
  const key = ttKey(st.id, dir.id);
  const day = istanbulNow().dayType;
  const rec = store.tt[key] || {};
  const cur = rec[day];
  const maxAge = lineHasNotice(st) ? NOTICE_MAX_AGE : TT_MAX_AGE;
  if (cur && cur.t && cur.t.length && !force && Date.now() - cur.at < maxAge) return rec;
  // Az önce "tarife yok" dendiyse bir süre tekrar sorma
  if (rec.none && !force && Date.now() - rec.none < maxAge && !cur) return rec;
  if (!isOnline()) return rec;
  const where = st.name + ' ' + st.line + ', ' + dir.name;
  try {
    const data = await call('POST', '/GetTimeTable', { boardingStationId: st.id, directionId: dir.id });
    const ex = extractTimes(data);
    const t = parseTimes(ex.times);
    store.meta.diag = {
      at: Date.now(), station: st.name + ' ' + st.line, dir: dir.name,
      path: ex.path, timeInfos: ex.tiCount, count: t.length,
      apiDay: ex.apiDay, apiDayName: ex.apiDayName, dayType: day,
      sample: JSON.stringify(data).slice(0, 700),
    };
    save(K.meta, store.meta);
    if (!t.length) {
      rec.none = Date.now();
      store.tt[key] = rec;
      save(K.tt, store.tt);
      if (!cur && !quiet) logError('/GetTimeTable', where + ': boş tarife geldi');
      return rec;
    }
    delete rec.none;
    rec[day] = { t, at: Date.now(), apiDay: ex.apiDay };
    store.tt[key] = rec;
    save(K.tt, store.tt);
    return rec;
  } catch (e) {
    // Hattın diğer yönleri denenirken "bu istasyondan geçmiyor" hatası beklenen bir sonuç
    if (!(quiet && NO_TT.test(e.message))) logError('/GetTimeTable', where + ': ' + e.message);
    if (NO_TT.test(e.message)) {
      rec.none = Date.now();
      store.tt[key] = rec;
      save(K.tt, store.tt);
    }
    return rec;
  }
}

// Bir istasyonun tüm yönlerini indirir. Dönen değer: başarılı mı?
export async function syncStation(st, force = false) {
  const dirs = await ensureDirs(st, force);
  if (!dirs) return false;
  for (const d of dirs) await ensureTT(st, d, force);
  // Hattın diğer yönleri: kısa seferler (T1 Cevizlibağ-Eminönü gibi) ve onarım sırasındaki
  // geçici seferler. Hat başına günde bir istek; bu istasyondan geçmeyenler hata verir ve
  // bir süre tekrar sorulmaz.
  const line = await ensureLineDirs(st, force);
  for (const d of line || []) {
    if (dirs.some((x) => x.id === d.id) || isTerminusFor(st.name, d.name)) continue;
    await ensureTT(st, d, force, true);
  }
  changed('tt');
  return true;
}

let syncing = null;
export function syncFavorites(force = false) {
  if (syncing) return syncing;
  syncing = (async () => {
    for (const id of store.favs) {
      const st = stationById(id);
      if (st) await syncStation(st, force);
    }
  })().finally(() => { syncing = null; changed('tt'); });
  return syncing;
}

// Tüm hatların tarifelerini çevrimdışı kullanım için indirir.
export async function downloadAll(onProgress, signal) {
  await refreshStations().catch(() => {});
  const list = (store.stations && store.stations.list) || [];
  let done = 0, failed = 0;
  // Sıralı ve aralıklı: İBB sunucusuna aynı anda tek istek, istasyonlar arasında kısa bir ara
  for (const st of list) {
    if (signal && signal.aborted) break;
    const ok = await syncStation(st, false).catch(() => false);
    if (!ok) failed++;
    done++;
    onProgress && onProgress(done, list.length, failed);
    await sleep(DOWNLOAD_GAP_MS);
  }
  return { done, failed, total: list.length };
}

// ---- favoriler ve ayarlar ----------------------------------------------------------
export function isFav(id) { return store.favs.includes(id); }
export function toggleFav(id) {
  const i = store.favs.indexOf(id);
  if (i >= 0) store.favs.splice(i, 1); else store.favs.push(id);
  save(K.favs, store.favs);
  if (i < 0 && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  changed('favs');
  return i < 0;
}
export function moveFav(id, delta) {
  const i = store.favs.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= store.favs.length) return;
  [store.favs[i], store.favs[j]] = [store.favs[j], store.favs[i]];
  save(K.favs, store.favs);
  changed('favs');
}
export function setSetting(k, v) { store.settings[k] = v; save(K.settings, store.settings); changed('settings'); }

export function clearTimetables() {
  store.tt = {}; store.dirs = {}; store.lineDirs = {};
  save(K.tt, store.tt); save(K.dirs, store.dirs); save(K.lineDirs, store.lineDirs);
  changed('tt');
}

export function storageStats() {
  let bytes = 0;
  for (const k of Object.values(K)) { try { bytes += (localStorage.getItem(k) || '').length * 2; } catch (e) { /* yok say */ } }
  const ttCount = Object.values(store.tt).reduce((n, r) => n + Object.keys(r).length, 0);
  const stCount = new Set(Object.keys(store.tt).map((k) => k.split('|')[0])).size;
  return { bytes, ttCount, stCount };
}

// ---- arızalar ----------------------------------------------------------------------
// Metro İstanbul'un kendi hizmet durumu servisi (GetServiceStatuses). metro.istanbul'daki
// "Sefer Durumları" sayfası da aynı duyuruları gösteriyor. Uygulama sadece İBB ile konuşur.

// Arayüzün "kontrol ediliyor / alınamadı" durumunu göstermesi için
export const disrStatus = { state: 'idle', error: null, at: null };

let disrInflight = null;
export function refreshDisruptions(force = false) {
  const d = store.disr;
  if (!force && d && Date.now() - d.fetchedAt < DISR_MAX_AGE) return Promise.resolve(false);
  if (!isOnline()) {
    disrStatus.state = 'error'; disrStatus.error = 'İnternet bağlantısı yok'; disrStatus.at = Date.now();
    changed('disr');
    return Promise.resolve(false);
  }
  if (disrInflight) return disrInflight;
  disrStatus.state = 'loading';
  changed('disr');
  disrInflight = (async () => {
    try {
      const data = await call('GET', '/GetServiceStatuses');
      store.disr = { fetchedAt: Date.now(), items: mapServiceStatuses(data), url: 'GetServiceStatuses' };
      save(K.disr, store.disr);
      disrStatus.state = 'ok'; disrStatus.error = null; disrStatus.at = Date.now();
      return true;
    } catch (e) {
      disrStatus.state = 'error'; disrStatus.error = e.message; disrStatus.at = Date.now();
      return false;
    }
  })().finally(() => { disrInflight = null; changed('disr'); });
  return disrInflight;
}

export function lineHasNotice(st) {
  return disruptionsFor(st).length > 0;
}

// Bir istasyon için İBB'nin döndürdüğü ham veriyi toplar (Tanılama için).
// İstasyonun yön listesi, hattın tüm yönleri ve her yön için bu istasyondaki tarife özeti.
export async function stationDebug(st) {
  const out = { at: new Date().toISOString(), station: { id: st.id, name: st.name, line: st.line, lineId: st.lineId } };
  const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
  out.stationDirs = await safe(() => call('POST', '/GetDirectionsByLineIdAndStationId', { lineId: st.lineId, stationId: st.id }));
  out.lineDirs = await safe(() => call('GET', '/GetDirectionById/' + encodeURIComponent(st.lineId)));
  const ids = new Map();
  for (const list of [out.stationDirs, out.lineDirs]) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const id = d.DirectionId != null ? d.DirectionId : d.Id;
      if (id != null && !ids.has(id)) ids.set(id, d.DirectionName || d.Name || d.Description || '');
    }
  }
  out.timetables = [];
  for (const [id, name] of ids) {
    const r = await safe(() => call('POST', '/GetTimeTable', { boardingStationId: st.id, directionId: id }));
    if (r && r.error) { out.timetables.push({ directionId: id, name, error: r.error }); continue; }
    const ex = extractTimes(r);
    const row = Array.isArray(r) ? r[0] : r;
    out.timetables.push({
      directionId: id, name, count: ex.times.length, apiDay: ex.apiDay,
      first: ex.times.slice(0, 6), last: ex.times.slice(-3),
      firstStation: row && row.FirstStation, lastStation: row && row.LastStation,
    });
  }
  return out;
}

export function disruptionsFor(st) {
  const items = (store.disr && store.disr.items) || [];
  return items
    .filter((it) => lineMatches(it.line, st.line))
    .map((it) => Object.assign({}, it, { affectsStation: mentionsStation(it, st.name) }));
}

// Arıza bilgisinin en son ne zaman kontrol edildiği
export function disruptionAge() {
  const d = store.disr;
  return d ? d.fetchedAt : null;
}
