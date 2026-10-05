# Uçtan uca tarayıcı testi: gerçek API yerine sahte yanıtlar kullanır.
# Çalıştırma: python3 tests/browser_test.py   (playwright + chromium gerekir)
import json, os, sys, threading, http.server, functools, pathlib, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'docs'
SHOTS = pathlib.Path(os.environ.get('SHOTS', '/tmp/sonraki-tren-shots'))
SHOTS.mkdir(parents=True, exist_ok=True)
PORT = 8765

stations = json.load(open(ROOT / 'data/stations.json'))['list']
by_line = {}
for s in stations:
    by_line.setdefault(s['lineId'], []).append(s)

calls = {'GetStations': 0, 'GetDirectionsByLineIdAndStationId': 0, 'GetTimeTable': 0}

def api_stations():
    return [{'Id': s['id'], 'LineId': s['lineId'], 'LineName': s['line'], 'Name': s['name'], 'Description': s['name'],
             'DetailInfo': {'Latitude': str(s['lat']), 'Longitude': str(s['lng'])}} for s in stations]

def api_dirs(line_id):
    if line_id in PATTERNS:
        own_ids, dirs = PATTERNS[line_id]
        return [d for d in dirs if d['DirectionId'] in own_ids]
    lst = by_line[line_id]
    a, b = lst[0]['name'], lst[-1]['name']
    return [{'LineId': line_id, 'DirectionId': line_id * 10 + 1, 'DirectionName': f'{a}->{b}', 'DirectionValue': 1},
            {'LineId': line_id, 'DirectionId': line_id * 10 + 2, 'DirectionName': f'{b}->{a}', 'DirectionValue': 0}]

def api_line_dirs(line_id):
    return PATTERNS[line_id][1] if line_id in PATTERNS else api_dirs(line_id)

# M7'deki gerçek onarım düzeni (1 Ekim 2026'da API'den alınan yön listesi):
# istasyonun kendi listesinde sadece Nurtepe-Mahmutbey var; Yıldız-Mecidiyeköy ve
# Çağlayan-Nurtepe kısa seferleri sadece hattın yön listesinde.
M7_LINE = 7
M7_ORDER = [s['name'] for s in by_line[M7_LINE]]
M7_DIRS = [
    {'LineId': 7, 'DirectionId': 108, 'DirectionName': 'Nurtepe->Mahmutbey', 'DirectionValue': 1},
    {'LineId': 7, 'DirectionId': 109, 'DirectionName': 'Mahmutbey->Nurtepe', 'DirectionValue': 0},
    {'LineId': 7, 'DirectionId': 74, 'DirectionName': 'Yıldız->Mecidiyeköy', 'DirectionValue': 1},
    {'LineId': 7, 'DirectionId': 75, 'DirectionName': 'Mecidiyeköy ->Yıldız', 'DirectionValue': 0},
    {'LineId': 7, 'DirectionId': 110, 'DirectionName': 'Çağlayan->Nurtepe', 'DirectionValue': 1},
    {'LineId': 7, 'DirectionId': 111, 'DirectionName': 'Nurtepe->Çağlayan', 'DirectionValue': 0},
]
# T1'in düzenli kısa seferi (1 Ekim 2026'da API'den alınan yön listesi): Cevizlibağ-Eminönü
T1_LINE = 11
T1_DIRS = [
    {'LineId': 11, 'DirectionId': 21, 'DirectionName': 'Bağcılar->Kabataş', 'DirectionValue': 1},
    {'LineId': 11, 'DirectionId': 22, 'DirectionName': 'Kabataş->Bağcılar', 'DirectionValue': 0},
    {'LineId': 11, 'DirectionId': 26, 'DirectionName': 'Cevizlibağ->Eminönü', 'DirectionValue': 1},
    {'LineId': 11, 'DirectionId': 27, 'DirectionName': 'Eminönü->Cevizlibağ', 'DirectionValue': 0},
]
PATTERNS = {M7_LINE: ((108, 109), M7_DIRS), T1_LINE: ((21, 22), T1_DIRS)}
SHORT_DIRS = {26, 27}

def pattern_serves(st_id, dir_id):
    line_id = st_by_id[st_id]['lineId']
    order = [x['name'] for x in by_line[line_id]]
    idx = lambda n: next(i for i, o in enumerate(order) if o == n or o.startswith(n + '-'))
    d = next(x for x in PATTERNS[line_id][1] if x['DirectionId'] == dir_id)
    a, b = [n.strip() for n in d['DirectionName'].split('->')]
    i, j, k = idx(a), idx(b), order.index(st_by_id[st_id]['name'])
    return min(i, j) <= k <= max(i, j)   # gerçek API'deki gibi: segmentin iki ucunda da saat döner

st_by_id = {s['id']: s for s in stations}
def is_terminus(st_id, dir_id):
    st = st_by_id[st_id]; lst = by_line[st['lineId']]
    if st['lineId'] in PATTERNS: return False
    end = lst[-1] if dir_id % 10 == 1 else lst[0]
    return end['id'] == st_id

def api_tt(st_id, dir_id):
    off = (st_id * 3 + dir_id) % 7
    times = []
    if dir_id in SHORT_DIRS:   # kısa sefer: sadece gündüz
        times = [f'{m // 60:02d}:{m % 60:02d}' for m in range(7 * 60 + 3, 21 * 60 + 4, 10)]
        return [{'BoardingStationId': st_id, 'LineId': 0, 'TimeInfos': {'Day': 0, 'DayName': None, 'Times': times}}]
    m = 6 * 60 + off
    while m < 24 * 60 + 30:
        times.append(f'{(m // 60) % 24:02d}:{m % 60:02d}')
        m += 6 if 7 * 60 <= m <= 21 * 60 else 10
    return [{'BoardingStationId': st_id, 'LineId': 0, 'TimeInfos': {'Day': 0, 'DayName': None, 'Times': times}}]

def handle(route):
    req = route.request
    path = req.url.split('/V2/')[-1].split('?')[0]
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type'}
    if req.method == 'OPTIONS':
        return route.fulfill(status=204, headers=cors)
    calls[path] = calls.get(path, 0) + 1
    body = json.loads(req.post_data or '{}')
    if path == 'GetServiceStatuses':
        disr_mode['calls'] += 1
        if disr_mode.get('busy_once'):
            disr_mode['busy_once'] = False
            return route.fulfill(status=503, headers=cors, body='Service Unavailable')
        if disr_mode['fail']:   # tekrar denenmeyen bir sunucu hatası
            return route.fulfill(status=500, headers=cors, body='Internal Server Error')
        data = SERVICE_STATUSES
    elif path.startswith('GetDirectionById/'):
        data = api_line_dirs(int(path.split('/')[1]))
    elif path == 'GetStations':
        data = api_stations()
    elif path == 'GetDirectionsByLineIdAndStationId':
        data = api_dirs(body['lineId'])
    elif path == 'GetTimeTable':
        st_l = st_by_id[body['boardingStationId']]['lineId']
        bad = (not pattern_serves(body['boardingStationId'], body['directionId'])) if st_l in PATTERNS else is_terminus(body['boardingStationId'], body['directionId'])
        if bad:
            calls['terminus'] = calls.get('terminus', 0) + 1
            return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(
                {'Success': False, 'Error': {'Message': "Index was out of range. Must be non-negative and less than the size of the collection. (Parameter 'index')"}, 'Data': None}))
        data = api_tt(body['boardingStationId'], body['directionId'])
    else:
        return route.fulfill(status=404, headers=cors)
    route.fulfill(status=200, headers=cors, content_type='application/json',
                  body=json.dumps({'Success': True, 'Error': None, 'Data': data}))

# GetServiceStatuses: sadece duyurusu olan hatlar (gerçek yanıt şekli)
SERVICE_STATUSES = [
    {'LineId': 1, 'LineName': 'M2', 'IsActive': True, 'UpdateDate': '2026-10-01T19:40:12.500',
     'LineLongDescription': 'Yenikapı-Hacıosman Metro Hattı',
     'Description': 'Teknik arıza nedeniyle seferler Levent istasyonunda 10 dakika aralıklarla yapılmaktadır.'},
    {'LineId': 7, 'LineName': 'M7', 'IsActive': True, 'UpdateDate': '2026-07-27T09:27:37.103',
     'LineLongDescription': 'Yıldız-Mahmutbey Metro Hattı',
     'Description': 'Onarım çalışması nedeniyle seferler Yıldız-Mecidiyeköy ve Nurtepe istasyonundan aktarmalı olarak Çağlayan-Mahmutbey istasyonları arasında yapılmaktadır.'},
    {'LineId': 9, 'LineName': 'M1', 'IsActive': True, 'UpdateDate': '2026-10-01T20:05:00',
     'LineLongDescription': 'Yenikapı-Atatürk Havalimanı/Kirazlı Metro Hattı',
     'Description': 'Elektrik kesintisi nedeniyle seferler geçici süreyle durdurulmuştur.'},
]
disr_mode = {'fail': False, 'calls': 0}

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

# GitHub Pages proje sitesi gibi alt dizinden servis et: https://KULLANICI.github.io/sonraki-tren/
import tempfile
SITE = pathlib.Path(tempfile.mkdtemp())
(SITE / 'sonraki-tren').symlink_to(ROOT)
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Quiet, directory=str(SITE)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.5)
URL = f'http://127.0.0.1:{PORT}/sonraki-tren/'
errors = []

def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond: errors.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                        timezone_id='Europe/Istanbul', locale='tr-TR', service_workers='allow')
    ctx.route('https://api.ibb.gov.tr/**', handle)
    pg = ctx.new_page()
    pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errors.append('console: ' + m.text))
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))

    pg.goto(URL)
    pg.wait_for_selector('.empty-state')
    check('Favori istasyonun yok' in pg.inner_text('main'), 'boş favori ekranı')
    pg.screenshot(path=str(SHOTS / '01-bos.png'))

    pg.fill('#q', 'levent')
    pg.wait_for_selector('.results a')
    names = pg.locator('.rname').all_inner_texts()
    check('Levent' in names and any('4' in n for n in names), f'arama sonuçları: {names}')
    pg.screenshot(path=str(SHOTS / '02-arama.png'))

    pg.locator('.results a', has_text='Levent').first.click()
    pg.wait_for_selector('.dir .next b', timeout=8000)
    rows = pg.locator('.card .dir').count()
    check(rows >= 2, f'istasyon sayfasında iki yön ({rows} satır)')
    check(pg.locator('.alert').count() >= 1, 'M2 arıza uyarısı istasyon sayfasında')
    check('Duyuruda bu istasyon geçiyor' in pg.inner_text('main'), 'istasyon adı geçen duyuru belirtiliyor')
    pg.screenshot(path=str(SHOTS / '03-istasyon.png'), full_page=True)
    t_lev = pg.inner_text('main')
    check('geçici düzenlemeyi yansıtmayabilir' in t_lev, 'duyurulu hatta kart notu var')
    # Ham veri aracı: varsayılan olarak gizli, Ayarlar'dan açılıyor
    check(pg.locator('[data-raw]').count() == 0, 'ham veri düğmesi varsayılan olarak gizli')
    pg.goto(URL + '#/ayarlar'); pg.wait_for_selector('#devTools')
    pg.check('#devTools')
    pg.goto(URL + '#/s/levent'); pg.wait_for_selector('[data-raw]', timeout=8000)
    check(True, 'Ayarlar\'dan açılınca ham veri düğmesi görünüyor')
    pg.click('[data-raw]')
    pg.wait_for_selector('.raw-out textarea', timeout=10000)
    raw = json.loads(pg.input_value('.raw-out textarea'))
    r0 = raw['results'][0]
    check(isinstance(r0['stationDirs'], list) and isinstance(r0['lineDirs'], list) and len(r0['timetables']) >= 2,
          f"ham veri: {len(raw['results'])} hat, ilk hatta {len(r0['timetables'])} yön tarifesi")
    time.sleep(16)
    check(pg.locator('.raw-out textarea').count() == 1, 'ham veri kutusu ekran yenilenince kaybolmuyor')
    pg.screenshot(path=str(SHOTS / '03b-ham-veri.png'), full_page=True)
    pg.reload(); pg.wait_for_selector('.dir .next b', timeout=8000)
    pg.click('[data-fav]')
    check(pg.get_attribute('[data-fav]', 'aria-pressed') == 'true', 'favoriye eklendi')

    pg.fill('#q', 'yenikapi')
    pg.wait_for_selector('.results a')
    pg.locator('.results a').first.click()
    # Yenikapı M1A, M1B ve M2'nin son durağı: her hatta bir yön süre, diğeri "Son durak"
    pg.wait_for_function("document.querySelectorAll('.card').length >= 3 && document.querySelectorAll('.dir .next b').length >= 3 && !document.querySelector('main').innerText.includes('indiriliyor')", timeout=10000)
    exp_end = sum(1 for x in stations if x['name'] == 'Yenikapı' for d in (1, 2) if is_terminus(x['id'], x['lineId'] * 10 + d))
    check(pg.locator('.dir.end').count() == exp_end, f"Yenikapı'da son durak satırları ({pg.locator('.dir.end').count()} / {exp_end})")
    lines = pg.locator('.card .pill').all_inner_texts()
    check(set(['M1A', 'M1B', 'M2']).issubset(set(lines)), f'Yenikapı hatları: {lines}')
    m1a_star = pg.locator('.card', has=pg.locator('.pill', has_text='M1A')).locator('[data-fav]')
    m1a_star.click()
    pg.wait_for_function("JSON.parse(localStorage.getItem('mt.favs') || '[]').length === 2", timeout=5000)
    pg.screenshot(path=str(SHOTS / '04-yenikapi.png'), full_page=True)

    term0 = calls.get('terminus', 0)   # ham veri aracı bilerek tüm yönleri sorar; sadece buradan sonrasını say
    pg.fill('#q', 'haciosman')
    pg.wait_for_selector('.results a')
    pg.locator('.results a').first.click()
    pg.wait_for_selector('.dir .next b', timeout=8000)
    t_end = pg.inner_text('main')
    check('Son durak' in t_end and 'Tarife alınamadı' not in t_end, 'son durakta ters yön "Son durak" gösteriliyor')
    check(calls.get('terminus', 0) == term0, f"son durak yönü için API'ye sorulmadı ({calls.get('terminus', 0) - term0})")
    pg.screenshot(path=str(SHOTS / '04b-son-durak.png'), full_page=True)

    # M7 onarım düzeni: istasyonun kendi yönleri bu istasyondan geçmiyorsa hattın kısa seferleri
    def open_station(q, name):
        pg.fill('#q', q)
        pg.wait_for_selector('.results a')
        pg.locator('.results a', has_text=name).first.click()
        pg.wait_for_function("document.querySelector('.station-title') && !document.querySelector('main').innerText.includes('indiriliyor')", timeout=10000)
        time.sleep(0.6)
        return pg.locator('.card').first.inner_text()
    def rows_of(text):
        return [l.strip() for l in text.split('\n') if l.strip().endswith('yönü')]
    t = open_station('mecidiyekoy', 'Mecidiyeköy')
    m7 = pg.locator('.card', has=pg.locator('.pill', has_text='M7')).inner_text()
    check(rows_of(m7) == ['Mahmutbey yönü', 'Yıldız yönü'] or rows_of(m7) == ['Yıldız yönü', 'Mahmutbey yönü'], f"Mecidiyeköy M7 yönleri: {rows_of(m7)}")
    check('bu yöne sefer görünmüyor' in m7 and 'geçici sefer düzeni' in m7, 'Mecidiyeköy: Mahmutbey tarafı sefer yok, geçici düzen notu')
    check(pg.locator('.card', has=pg.locator('.pill', has_text='M7')).locator('.dir .next b').count() == 1, 'Mecidiyeköy: Yıldız yönünde süre var')
    pg.screenshot(path=str(SHOTS / '04c-mecidiyekoy.png'), full_page=True)
    t = open_station('fulya', 'Fulya')
    check(sorted(rows_of(t)) == ['Mecidiyeköy yönü', 'Yıldız yönü'], f"Fulya yönleri: {rows_of(t)}")
    t = open_station('kagithane', 'Kağıthane')
    check(sorted(rows_of(t)) == ['Nurtepe yönü', 'Çağlayan yönü'], f"Kağıthane yönleri: {rows_of(t)}")
    t = open_station('nurtepe', 'Nurtepe')
    check(sorted(rows_of(t)) == ['Mahmutbey yönü', 'Çağlayan yönü'], f"Nurtepe yönleri: {rows_of(t)}")
    t = open_station('alibeykoy', 'Alibeyköy')
    m7a = pg.locator('.card', has=pg.locator('.pill', has_text='M7')).inner_text()
    check(sorted(rows_of(m7a)) == ['Mahmutbey yönü', 'Nurtepe yönü'] and 'geçici sefer düzeni' not in m7a, f"Alibeyköy (ana sefer çalışıyor): {rows_of(m7a)}")
    # T1 düzenli kısa sefer: aynı tarafta iki son durak
    def subs_of(card_text):
        return [l.strip() for l in card_text.split('\n') if l.strip().endswith('seferi')]
    open_station('capa', 'Çapa')
    t1 = pg.locator('.card', has=pg.locator('.pill', has_text='T1')).inner_text()
    check(sorted(rows_of(t1)) == ['Bağcılar yönü', 'Kabataş yönü'], f"Çapa yönleri: {rows_of(t1)}")
    check(subs_of(t1) == ['Kabataş seferi', 'Eminönü seferi', 'Bağcılar seferi', 'Cevizlibağ seferi'], f"Çapa son durakları: {subs_of(t1)}")
    check('geçici' not in t1, 'Çapa: düzenli kısa seferde "geçici" notu yok')
    pg.screenshot(path=str(SHOTS / '04d-capa.png'), full_page=True)
    open_station('guneste', 'Güneştepe')
    t1b = pg.locator('.card').first.inner_text()
    check(rows_of(t1b) == ['Kabataş yönü', 'Bağcılar yönü'] and not subs_of(t1b), f"Güneştepe (kısa sefer dışında): {rows_of(t1b)} {subs_of(t1b)}")
    open_station('eminonu', 'Eminönü')
    t1c = pg.locator('.card', has=pg.locator('.pill', has_text='T1')).inner_text()
    check(subs_of(t1c) == ['Bağcılar seferi', 'Cevizlibağ seferi'], f"Eminönü (kısa seferin ucu): {subs_of(t1c)}")

    # 1.4.0 öncesinden kalan, hattın tarafı (side) olmayan yön önbelleği: kısa seferler yine görünmeli
    pg.evaluate("""() => {
      const d = JSON.parse(localStorage.getItem('mt.dirs'));
      d[77] = {at: Date.now(), dirs: [{id: 21, name: 'Bağcılar->Kabataş'}, {id: 22, name: 'Kabataş->Bağcılar'}]};
      localStorage.setItem('mt.dirs', JSON.stringify(d));
      const l = JSON.parse(localStorage.getItem('mt.linedirs') || '{}'); delete l[11];
      localStorage.setItem('mt.linedirs', JSON.stringify(l));
    }""")
    pg.goto(URL + '#/'); pg.reload(); pg.wait_for_selector('main')   # depo sayfa yüklenirken okunur
    check(pg.evaluate("JSON.parse(localStorage.getItem('mt.dirs'))[77].dirs.every(d => !('side' in d))"), 'eski biçimli önbellek yüklendi')
    open_station('sirkeci', 'Sirkeci')
    t1d = pg.locator('.card').first.inner_text()
    check(subs_of(t1d) == ['Kabataş seferi', 'Eminönü seferi', 'Bağcılar seferi', 'Cevizlibağ seferi'], f"Sirkeci, eski önbellekle: {subs_of(t1d)}")

    lerr = pg.evaluate("JSON.parse(localStorage.getItem('mt.meta')).lastError")
    check(not lerr or 'Çağlayan->Nurtepe' not in lerr['msg'] and 'Mecidiyeköy ->Yıldız' not in lerr['msg'], 'kısa sefer denemeleri hata kaydı oluşturmuyor')

    pg.click('.back')
    pg.wait_for_selector('main .card h3 a')   # ana ekran kartlarında istasyon adı bağlantıdır
    n_cards = pg.locator('main .card').count()
    favs_raw = pg.evaluate("localStorage.getItem('mt.favs')")
    check(n_cards == 2, f'ana ekranda 2 favori ({n_cards}, depo: {favs_raw})')
    txt = pg.inner_text('main')
    check('yönü' in txt and 'dk' in txt or 'şimdi' in txt, 'favorilerde dakika gösteriliyor')
    check('M2 hattı için duyuru' in txt and 'M1 hattı için duyuru' in txt, 'favorilerde M2 ve M1 (M1A) duyuruları')
    check(pg.locator('.card.doubt').count() == 1, 'durdurulmuş hattın (M1) süreleri soluk')
    check('son kontrol' in txt and 'Yenile' in txt, 'arıza durum satırı ve Yenile düğmesi')
    pg.screenshot(path=str(SHOTS / '05-favoriler.png'), full_page=True)

    # Yenile: kaynak hata verirse eski arızalar kalır, durum satırı uyarır
    n0 = disr_mode['calls']
    disr_mode['fail'] = True
    pg.click('[data-disr-refresh]')
    pg.wait_for_selector('.disr-line.warn', timeout=8000)
    t_err = pg.inner_text('main')
    check(disr_mode['calls'] == n0 + 1, 'Yenile düğmesi tek istek attı')
    check('kontrol edilemedi' in t_err and 'HTTP 500' in t_err, 'arıza kaynağı hatası gösteriliyor')
    check('Duyuruda bu istasyon geçiyor' in t_err, 'hata sonrası eski arıza bilgisi korunuyor')
    pg.screenshot(path=str(SHOTS / '05b-ariza-hatasi.png'))
    disr_mode['fail'] = False
    pg.click('[data-disr-refresh]')
    pg.wait_for_function("!document.querySelector('.disr-line.warn')", timeout=8000)
    check(True, 'Yenile ile tekrar başarılı')
    # Sunucu bir kez 503 ("meşgul") dönerse uygulama bekleyip tekrar dener
    n1 = disr_mode['calls']
    disr_mode['busy_once'] = True
    pg.click('[data-disr-refresh]')
    pg.wait_for_function("!document.querySelector('.disr-line').textContent.includes('kontrol ediliyor')", timeout=15000)
    check(disr_mode['calls'] == n1 + 2 and not pg.locator('.disr-line.warn').count(), f"503 sonrası tekrar denendi ({disr_mode['calls'] - n1} istek)")
    foot = pg.inner_text('footer')
    check('Resmi uygulama değildir' in foot and 'CC BY 4.0' in foot, 'altbilgide resmi değil notu ve İBB atfı')

    # Service worker hazır olsun, sonra çevrimdışı yeniden aç
    pg.evaluate("navigator.serviceWorker.ready.then(() => true)")
    pg.reload(); pg.wait_for_selector('.card')
    check(pg.evaluate("!!navigator.serviceWorker.controller"), 'service worker sayfayı kontrol ediyor')
    before = dict(calls)
    ctx.set_offline(True)
    pg.reload()
    pg.wait_for_selector('.card', timeout=8000)
    t2 = pg.inner_text('body')
    check('Çevrimdışısın' in t2, 'çevrimdışı uyarısı')
    n_online_rows = pg.evaluate("document.querySelectorAll('.dir').length - document.querySelectorAll('.dir.end').length")
    check(n_online_rows >= 3 and pg.locator('.dir .next b').count() == n_online_rows, f'çevrimdışıyken favorilerde süreler var ({n_online_rows} satır)')
    pg.screenshot(path=str(SHOTS / '06-cevrimdisi.png'), full_page=True)

    # Çevrimdışı, hiç açılmamış istasyon
    pg.fill('#q', 'kadikoy'); pg.wait_for_selector('.results a'); pg.locator('.results a').first.click()
    pg.wait_for_selector('.card')
    check('cihazda yok' in pg.inner_text('main'), 'indirilmemiş istasyon için çevrimdışı mesajı')
    pg.goto(URL + '#/')
    pg.wait_for_selector('.card')

    # Eski tarife ve gün tipi uyuşmazlığı
    pg.evaluate("""() => {
      const tt = JSON.parse(localStorage.getItem('mt.tt'));
      const old = Date.now() - 12*864e5;
      for (const k in tt) for (const d in tt[k]) tt[k][d].at = old;
      localStorage.setItem('mt.tt', JSON.stringify(tt));
    }""")
    pg.reload(); pg.wait_for_selector('.card')
    t3 = pg.inner_text('body')
    check('12 gündür güncellenmedi' in t3, 'eski tarife uyarısı (12 gün)')
    pg.screenshot(path=str(SHOTS / '07-eski-tarife.png'), full_page=True)
    pg.evaluate("""() => {
      const tt = JSON.parse(localStorage.getItem('mt.tt'));
      for (const k in tt) { const days = Object.keys(tt[k]); for (const d of days) { const other = d === 'wd' ? 'sat' : 'wd'; tt[k] = {[other]: tt[k][d]}; } }
      localStorage.setItem('mt.tt', JSON.stringify(tt));
    }""")
    pg.reload(); pg.wait_for_selector('.card')
    check('Saatler farklı olabilir' in pg.inner_text('body'), 'gün tipi uyuşmazlığı uyarısı')
    pg.screenshot(path=str(SHOTS / '08-gun-tipi.png'), full_page=True)

    # Tekrar çevrimiçi: favoriler kendiliğinden yenilenmeli
    ctx.set_offline(False)
    pg.evaluate("window.dispatchEvent(new Event('online'))")
    pg.wait_for_function("!document.body.innerText.includes('gündür güncellenmedi')", timeout=10000)
    check(calls['GetTimeTable'] > before['GetTimeTable'], 'çevrimiçi olunca tarifeler yenilendi')

    # Yayın adresi engelli (netlify.app'e erişilemiyor) ama İBB erişilebilir:
    # uygulama telefondaki kopyadan açılmalı, tarifeleri ve arızaları İBB'den almalı.
    # Yayın sunucusunu tamamen kapat: adrese artık hiç bağlanılamaz
    httpd.shutdown(); httpd.server_close()
    pg.evaluate("""() => {
      const tt = JSON.parse(localStorage.getItem('mt.tt'));
      for (const k in tt) for (const d in tt[k]) if (tt[k][d] && tt[k][d].at) tt[k][d].at = Date.now() - 2*864e5;
      localStorage.setItem('mt.tt', JSON.stringify(tt));
    }""")
    tt0, ss0 = calls['GetTimeTable'], disr_mode['calls']
    pg.reload()
    pg.wait_for_selector('main .card', timeout=8000)
    pg.wait_for_function("document.querySelectorAll('.dir .next b').length >= 3", timeout=10000)
    check(True, 'yayın adresi engelliyken uygulama telefondaki kopyadan açıldı')
    pg.click('[data-disr-refresh]')
    pg.wait_for_function("!document.querySelector('.disr-line').textContent.includes('kontrol ediliyor')", timeout=8000)
    t_blk = pg.inner_text('main')
    check(disr_mode['calls'] > ss0 and 'kontrol edilemedi' not in t_blk, 'yayın adresi engelliyken arızalar İBB\'den alındı')
    time.sleep(1.5)
    check(calls['GetTimeTable'] > tt0, f"yayın adresi engelliyken tarifeler İBB'den yenilendi ({calls['GetTimeTable'] - tt0} istek)")
    pg.screenshot(path=str(SHOTS / '12-yayin-engelli.png'), full_page=True)
    probe = pg.evaluate("fetch('./olmayan-dosya.txt').then(r => 'açık ' + r.status).catch(() => 'engelli')")
    check(probe == 'engelli', f'yayın adresi gerçekten engelli (deneme isteği: {probe})')

    # Ayarlar ve tümünü indir
    pg.goto(URL + '#/ayarlar'); pg.wait_for_selector('#dlAll')
    st_txt = pg.inner_text('main')
    check('Bu uygulama resmi değildir' in st_txt and 'kişisel veri toplamaz' in st_txt, 'Ayarlar: kaynak ve gizlilik bölümü')
    pg.click('#dlAll')
    pg.wait_for_function("document.querySelector('#dlMsg') && /istasyonun tarifesi indirildi|indirildi,/.test(document.querySelector('#dlMsg').textContent)", timeout=240000)
    msg = pg.inner_text('#dlMsg')
    check('245' in msg or 'indirildi' in msg, f'tümünü indir: {msg}')
    # Hattın yön listesi hat başına bir kez istenmeli (ham veri aracı +1)
    many = {k: v for k, v in calls.items() if k.startswith('GetDirectionById/') and v > 2}
    check(not many, f'hat yön listesi hat başına en fazla iki kez istendi ({many})')
    pg.screenshot(path=str(SHOTS / '09-ayarlar.png'), full_page=True)

    # Geri sayım: saniyeyle, aşağı yuvarlanmış; kalkıştan sonra 30 sn "şimdi"
    import datetime as _dt
    def expected(st_id, dir_id, now_sec):
        ts = sorted({int(x[:2]) * 60 + int(x[3:5]) for x in api_tt(st_id, dir_id)[0]['TimeInfos']['Times']})
        ds = sorted((((t * 60 - now_sec) % 86400) - (86400 if ((t * 60 - now_sec) % 86400) > 86400 - 30 else 0)) for t in ts)
        return 'şimdi' if ds[0] < 60 else str(ds[0] // 60)
    lev = next(x for x in stations if x['name'] == 'Levent' and x['line'] == 'M2')
    d1 = lev['lineId'] * 10 + 1
    for label, hh, mm, ss in [('08:00:40', 8, 0, 40), ('08:03:59', 8, 3, 59)]:
        cpg = ctx.new_page()
        cpg.clock.set_fixed_time(_dt.datetime(2026, 10, 1, hh - 3, mm, ss, tzinfo=_dt.timezone.utc))
        cpg.goto(URL + '#/s/levent')
        cpg.wait_for_selector('.dir .next b', timeout=8000)
        card = cpg.locator('.card', has=cpg.locator('.pill', has_text='M2'))
        row = card.locator('.dir', has_text='Hacıosman yönü')
        got = row.locator('.next b').inner_text()
        want = expected(lev['id'], d1, (hh * 60 + mm) * 60 + ss)
        check(got == want, f'geri sayım {label}: ekranda {got}, beklenen {want}')
        cpg.close()
    # kalkıştan 20 sn sonra hâlâ "şimdi", 31 sn sonra sıradaki tren
    ts = sorted({int(x[:2]) * 60 + int(x[3:5]) for x in api_tt(lev['id'], d1)[0]['TimeInfos']['Times']})
    dep = next(t for t in ts if t >= 9 * 60)
    for extra, want_now in [(20, True), (31, False)]:
        cpg = ctx.new_page()
        sec = dep * 60 + extra
        cpg.clock.set_fixed_time(_dt.datetime(2026, 10, 1, sec // 3600 - 3, (sec // 60) % 60, sec % 60, tzinfo=_dt.timezone.utc))
        cpg.goto(URL + '#/s/levent')
        cpg.wait_for_selector('.dir .next b', timeout=8000)
        got = cpg.locator('.card', has=cpg.locator('.pill', has_text='M2')).locator('.dir', has_text='Hacıosman yönü').locator('.next b').inner_text()
        check((got == 'şimdi') == want_now, f'kalkıştan {extra} sn sonra: {got}')
        cpg.close()

    # Karanlık tema
    pg.emulate_media(color_scheme='dark')
    pg.goto(URL + '#/'); pg.wait_for_selector('.card')
    pg.screenshot(path=str(SHOTS / '10-karanlik.png'), full_page=True)
    b.close()

print('\nAPI çağrıları:', calls)
if errors:
    print('\nHATALAR:'); [print(' -', e) for e in errors]; sys.exit(1)
print('Tarayıcı testleri geçti')
