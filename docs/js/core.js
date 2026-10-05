// Saf hesaplama fonksiyonları: DOM yok, ağ yok, depolama yok.
// Node'da da çalışır (tests/core.test.mjs).

export const TZ = 'Europe/Istanbul';

// Türkçe karakterleri sadeleştirip küçük harfe çevirir: "Şişli-Mecidiyeköy" -> "sisli mecidiyekoy"
export function norm(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/̇/g, '').replace(/ı/g, 'i')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/[âà]/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "06:05" -> 365, "24:10" -> 1450, "6:05:00" -> 365. Geçersizse null.
export function hhmmToMin(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (mi > 59 || h > 30) return null;
  return h * 60 + mi;
}

export function minToHHMM(min) {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

// İstanbul saatine göre şimdiki an. `date` verilmezse gerçek saat.
export function istanbulNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const h = +get('hour') % 24, m = +get('minute'), sec = +get('second');
  const wd = get('weekday');
  return { min: h * 60 + m, sec, secOfDay: (h * 60 + m) * 60 + sec, weekday: wd, dayType: serviceDayType(wd, h * 60 + m) };
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Sefer günü gece 03:00'te değişir: cumartesi 01:30, hâlâ cuma gecesinin seferidir.
export function serviceDayType(weekday, min) {
  let i = WD.indexOf(weekday);
  if (i < 0) return 'wd';
  if (min < 180) i = (i + 6) % 7;
  return i === 6 ? 'sat' : i === 0 ? 'sun' : 'wd';
}

export const DAY_LABEL = { wd: 'hafta içi', sat: 'cumartesi', sun: 'pazar' };

// API'nin döndürdüğü saat listesini sıralı dakika dizisine çevirir (tekrarları atar).
export function parseTimes(list) {
  const out = [];
  for (const x of list || []) {
    const v = hhmmToMin(x);
    if (v != null) out.push(v % 1440);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Dairesel listede en büyük boşluk gece arasıdır. Ondan sonraki ilk sefer, öncesi son seferdir.
export function serviceSpan(times) {
  if (!times || !times.length) return null;
  if (times.length === 1) return { first: times[0], last: times[0] };
  let bestGap = -1, idx = 0;
  for (let i = 0; i < times.length; i++) {
    const a = times[i], b = times[(i + 1) % times.length];
    const gap = ((b - a) + 1440) % 1440 || 1440;
    if (gap > bestGap) { bestGap = gap; idx = i; }
  }
  return { last: times[idx], first: times[(idx + 1) % times.length], nightGap: bestGap };
}

// Kalkışı yeni geçmiş bir tren bu kadar saniye daha "şimdi" olarak gösterilir. Tarife dakika
// hassasiyetinde; tren yazan dakikanın içinde herhangi bir saniyede kalkabilir.
export const GRACE_SEC = 30;

// Şimdiden sonraki seferler. nowSec: günün saniyesi (İstanbul saati).
// Her biri { at: dakika (0-1439), inSec: kalan saniye (pay içinde negatif olabilir),
//            in: gösterilecek dakika = kalan sürenin aşağı yuvarlanmışı }.
// Aşağı yuvarlama bilerek: "3 dk" en fazla 3 dk 59 sn demek, gerçekte kalan süreden fazlasını söylemez.
export function nextDepartures(times, nowSec, n = 3) {
  if (!times || !times.length) return [];
  const out = times.map((t) => {
    let d = ((t * 60 - nowSec) % 86400 + 86400) % 86400;
    if (d > 86400 - GRACE_SEC) d -= 86400;   // az önce kalkmış: kısa bir süre daha göster
    return { at: t, inSec: d, in: Math.max(0, Math.floor(d / 60)) };
  }).sort((a, b) => a.inSec - b.inSec);
  return out.slice(0, n);
}

// Sefer aralığının medyanı (dakika); ekran için "yaklaşık her X dk" bilgisi.
export function medianHeadway(times) {
  if (!times || times.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// Bir istasyon-yön kaydı { wd:{t,at}, sat:{...}, sun:{...} } içinden bugün için en uygununu seçer.
// Bugünün gün tipi varsa onu, yoksa en yeni olanı döndürür ve uyuşmazlığı işaretler.
export function pickTimetable(rec, dayType) {
  if (!rec) return null;
  if (rec[dayType] && rec[dayType].t && rec[dayType].t.length) {
    return { times: rec[dayType].t, at: rec[dayType].at, dayType, mismatch: false };
  }
  let best = null;
  for (const k of ['wd', 'sat', 'sun']) {
    const r = rec[k];
    if (r && r.t && r.t.length && (!best || r.at > best.at)) best = { times: r.t, at: r.at, dayType: k, mismatch: true };
  }
  return best;
}

export function ageDays(ts, now = Date.now()) {
  if (!ts) return Infinity;
  return (now - ts) / 86400000;
}

export function ageText(ts, now = Date.now()) {
  if (!ts) return 'hiç indirilmedi';
  const m = Math.round((now - ts) / 60000);
  if (m < 2) return 'az önce';
  if (m < 60) return m + ' dakika önce';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' saat önce';
  const d = Math.round(h / 24);
  return d + ' gün önce';
}

// "Yenikapı -> Hacıosman" -> "Hacıosman"
export function towards(dirName) {
  const s = String(dirName || '');
  const parts = s.split(/\s*(?:->|→|–>|-\s*>)\s*/);
  return (parts[parts.length - 1] || s).trim() || s;
}

// Yön bu istasyonda bitiyorsa (ör. Hacıosman'da "Yenikapı->Hacıosman") buradan o yöne tren kalkmaz.
// Sadece tam eşleşme: "Levent" ile "4.Levent" gibi benzer adlar karışmasın.
export function isTerminusFor(stationName, dirName) {
  const a = norm(stationName), b = norm(towards(dirName));
  return !!a && a === b;
}

// Arıza kaydındaki hat ile istasyonun hattı eşleşiyor mu? "M1" <-> "M1A", "M1B"
export function lineMatches(disrLine, stationLine) {
  const a = String(disrLine || '').toUpperCase().replace(/\s+/g, '');
  const b = String(stationLine || '').toUpperCase().replace(/\s+/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (x) => x.replace(/[A-Z]$/, '');
  return /\d[A-Z]$/.test(b) && strip(b) === a || /\d[A-Z]$/.test(a) && strip(a) === b;
}

// Arıza kaydı bu istasyonu adıyla anıyor mu?
export function mentionsStation(item, stationName) {
  const n = norm(stationName);
  if (!n) return false;
  const words = n.split(' ').filter((w) => w.length > 2);
  const hay = [norm((item.stations || []).join(' ')), norm(item.message)].join(' | ');
  if (hay.includes(n)) return true;
  // "Şişli-Mecidiyeköy" gibi çift isimlerde parçalardan biri yeterli olsun
  return words.length > 1 && words.some((w) => w.length > 4 && (' ' + hay + ' ').includes(' ' + w + ' '));
}

// Metro İstanbul GetServiceStatuses yanıtını uygulamanın arıza kayıtlarına çevirir.
// Servis sadece duyurusu olan hatları döndürür; boş liste "bildirilen arıza yok" demektir.
export function classifyNotice(text) {
  const t = String(text || '').toLocaleLowerCase('tr');
  if (/(durduruldu|durdurulmuş|yapılamamakta|yapılmamakta|yapılamıyor|hizmet ver(?:il)?memekte|hizmet dışı|kapalı|kapatıl|iptal)/.test(t)) return 'major';
  return 'minor';
}

// "2026-07-27T09:27:37.103" (İstanbul yerel saati) -> "27.07.2026 09:27"
export function ibbDateText(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : '';
}

export function mapServiceStatuses(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((x) => x && x.IsActive !== false && (x.Description || '').trim())
    .map((x) => {
      const message = String(x.Description).replace(/\s+/g, ' ').trim();
      return {
        line: String(x.LineName || '').trim(),
        lineName: x.LineLongDescription || '',
        message,
        stations: [],
        severity: classifyNotice(message),
        updated: ibbDateText(x.UpdateDate),
      };
    })
    .filter((x) => x.line);
}

// Arka planda okunabilir yazı rengi (WCAG göreli parlaklık)
export function textOn(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return '#fff';
  const lin = (c) => { c = parseInt(c, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return L > 0.35 ? '#13233A' : '#FFFFFF';
}

export const LINE_COLORS = {
  M1A: '#EE2229', M1B: '#EE2229', M2: '#059A4D', M3: '#0CA6DF', M4: '#E81E77', M5: '#683166',
  M6: '#C9AA79', M7: '#F490B3', M8: '#487ABF', M9: '#FCD10D', M11: '#A1609B', M12: '#7DBB42', M14: '#9C7E4F',
  T1: '#004B86', T2: '#90ABA0', T3: '#99562F', T4: '#FF7E42', T5: '#7B72B2',
  F1: '#7A745A', F2: '#7A745A', F3: '#7A745A', F4: '#7A745A', TF1: '#5C7A8A', TF2: '#5C7A8A',
};
export function lineColor(ref) {
  return LINE_COLORS[String(ref || '').toUpperCase()] || '#5B6878';
}
