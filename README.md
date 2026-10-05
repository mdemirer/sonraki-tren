# Sonraki Tren

İstanbul raylı sistem istasyonları için tarifeye göre tahmini tren geliş süreleri. Bir PWA olarak telefona kurulur ve internetsiz çalışır.

- İstasyonu adıyla ara. Türkçe karakter gerekmez, "sisli" yazınca Şişli de bulunur.
- Yıldıza dokunarak favorilere ekle. Favoriler ana ekranda her iki yönüyle birlikte görünür. Son duraklarda o istasyonda biten yön "Son durak" olarak gösterilir.
- Tarifeler cihazda saklanır. İnternet yokken de süreler hesaplanır.
- Tarife uzun süre güncellenmezse uyarı verir. Süre Ayarlar'dan seçilir: 3, 7, 14 ya da 30 gün.
- İstasyonun hattında Metro İstanbul duyurusu varsa kartta gösterir. Duyuruda istasyonun adı geçiyorsa bunu ayrıca belirtir.
- Arızalar uygulama açılınca kontrol edilir; **Yenile** düğmesiyle elle de kontrol edilebilir. Son kontrol saati her zaman görünür.

## Uygulama kiminle konuşuyor

Kurulduktan sonra **sadece İBB sunucularıyla** (`api.ibb.gov.tr`):

| Ne | Metro İstanbul API uç noktası |
|---|---|
| İstasyonlar | `GET GetStations` |
| Yönler | `POST GetDirectionsByLineIdAndStationId` |
| Sefer saatleri | `POST GetTimeTable` |
| Arıza duyuruları | `GET GetServiceStatuses` (metro.istanbul "Sefer Durumları" sayfasıyla aynı bilgi) |

Uygulama dosyaları telefonda saklandığı için yayın adresine yalnızca **ilk kurulumda** ve **yeni sürümü almak için** erişmek gerekir; sonrasında uygulama yayın adresine hiç bağlanmadan açılır.

**Süreler canlı değildir.** Trenlerin anlık konumu açık veri olarak yayımlanmıyor. Süreler resmi sefer tarifesinden hesaplanır; gecikmeler yansımaz.

Kapsam: M1A–M9, T1/T3/T4/T5, F1, F4, TF1, TF2. Marmaray, M11 ve metrobüs bu API'de yok.

## GitHub Pages'te yayınlama

Site tamamen statik; derleme adımı ve sunucu yok. Yayımlanan klasör **`docs/`**.

1. GitHub'da yeni bir **public** repo aç (ör. `sonraki-tren`). Ücretsiz hesapta Pages için repo public olmalı.
2. Bu klasördeki her şeyi repoya yükle (web arayüzünde *Add file → Upload files*, ya da git ile). `docs/.nojekyll` dosyası da gitmeli; gizli dosya olduğu için bazı sistemlerde görünmeyebilir.
3. Repo → **Settings → Pages** → *Build and deployment*: Source **Deploy from a branch**, Branch **main**, klasör **/docs** → *Save*.
4. Bir iki dakika sonra adres `https://KULLANICI.github.io/sonraki-tren/` olur. Telefonda aç, ana ekrana ekle:
   - Android Chrome: menü → *Uygulamayı yükle*
   - iPhone Safari: Paylaş → *Ana Ekrana Ekle*

### Güncelleme yayınlarken

1. Değiştirdiğin dosyalarla birlikte `docs/sw.js` içindeki `VERSION` değerini ve `docs/config.js` içindeki `MT_VERSION`'ı artır. Aksi halde telefonlar eski sürümde kalır.
2. Dosyaları repoya yükle. Pages birkaç dakika içinde yeni sürümü yayımlar.
3. Telefonda uygulamayı aç, birkaç saniye bekle, kapatıp tekrar aç. Ayarlar sayfasının en altında sürüm numarası görünür.

GitHub Pages her dosya için 10 dakikalık tarayıcı önbelleği kullanıyor ve bunu değiştirmek mümkün değil. Service worker yeni sürümü kurarken bu önbelleği atlayıp dosyaları doğrudan sunucudan alıyor.

### Netlify'dan geçiş

Telefondaki Netlify sürümü ayrı bir uygulama sayılır; favoriler ve tarifeler yeni adrese taşınmaz. GitHub sürümünü kurup favorileri yeniden ekle, sonra eskisini ana ekrandan kaldır ve istersen Netlify'daki siteyi sil.

## Gerçek ortamda doğrulananlar

- `GetTimeTable` tarayıcıdan çalışıyor. Yanıtta `TimeInfos` tek bir nesne: `{Day, DayName, Times}`.
- Bir yönün son durağında o yön sorgulanırsa API `Index was out of range` hatası döndürüyor. Uygulama bu yönleri hiç sormuyor.
- `GetServiceStatuses` yanıtı duyurusu olan hatları `{LineId, LineName, Description, IsActive, UpdateDate, ...}` biçiminde listeliyor. Test verisi (`tests/fixtures/service-statuses.json`) bu alan yapısıyla elle yazıldı.

### Arıza ve bakım sırasında yönler

Metro İstanbul geçici sefer düzenlerini API'ye ayrı "yönler" olarak giriyor. 1 Ekim 2026'daki M7 onarımında:

- `GetDirectionsByLineIdAndStationId` Mecidiyeköy için sadece ana seferi döndürdü: `Nurtepe->Mahmutbey` (108) ve `Mahmutbey->Nurtepe` (109). İkisi de Mecidiyeköy'den geçmediği için tarifeleri hata verdi.
- `GetDirectionById/7` (hattın tüm yönleri) kısa seferleri de içeriyordu: `Yıldız->Mecidiyeköy` (74), `Mecidiyeköy ->Yıldız` (75), `Çağlayan->Nurtepe` (110), `Nurtepe->Çağlayan` (111). Mecidiyeköy'den Yıldız yönüne (75) 12 dakikada bir sefer var.
- `DirectionValue` hattın hangi ucuna gidildiğini gösteriyor (M7'de 1 Mahmutbey, 0 Yıldız tarafı) ve kısa seferlerde de tutarlı.

Düzenli kısa seferler de aynı şekilde ayrı yön olarak geliyor. T1'de istasyonun kendi listesinde sadece `Bağcılar->Kabataş` (21) ve `Kabataş->Bağcılar` (22) var; hattın listesinde ayrıca `Cevizlibağ->Eminönü` (26) ve `Eminönü->Cevizlibağ` (27) kısa seferleri var (gündüz, 07:08–21:54 arası).

Uygulama bu yüzden her istasyonda hattın iki tarafına (DirectionValue) ayrı bakıyor:
1. O taraftaki, bu istasyondan kalkışı olan bütün seferler toplanır: istasyonun kendi listesindekiler ve hattın listesindeki kısa/geçici seferler.
2. Seferler son durağa göre gruplanır. Tek son durak varsa tek satır ("Kabataş yönü 4 dk"); birden fazla varsa başlık altında her biri ayrı ("Kabataş yönü": "Kabataş seferi 9 dk", "Eminönü seferi 2 dk"). O an çalışmayan kısa sefer soluk görünür.
3. İstasyonun kendi listesindeki sefer buradan hiç geçmiyorsa ve sadece hattın listesindeki seferler varsa kartta "Hatta geçici sefer düzeni var" notu çıkar (M7 onarımı gibi).
4. Bir tarafta hiç kalkış yoksa tek satır: son durak ya da "Bu istasyondan şu an bu yöne sefer görünmüyor".

Hattın yön listesi hat başına günde bir kez istenir. Kısa seferin geçmediği istasyonlarda o yönün tarifesi hata verir; bu beklenen bir sonuçtur, hata kaydına yazılmaz ve bir süre tekrar sorulmaz. Yön listeleri günde bir, hatta duyuru varken en fazla 30 dakikada bir yenilenir; bakım bitince normal düzen kendiliğinden geri gelir.

Ayarlar → Tanılama'da *İstasyon sayfalarında ham veri düğmesini göster* açılırsa, istasyon sayfasının altındaki **Bu istasyonun ham verisini al** düğmesi bu üç kaynağın (istasyonun yönleri, hattın yönleri, her yönün o istasyondaki tarife özeti) ham hâlini kopyalanabilir metin olarak verir.

### Hâlâ bakılacak olan

**Arıza servisine tarayıcıdan erişim:** `GetServiceStatuses`'ın tarayıcıdan (CORS) çağrılabildiği henüz doğrulanmadı. Diğer uç noktalar çalıştığı için çalışması bekleniyor. Ana ekrandaki arıza satırı "kontrol edilemedi" ve altında "Failed to fetch" ya da "NetworkError" gösteriyorsa sebep budur.

**Hafta sonu tarifesi:** Ayarlar → Tanılama → *Son tarife yanıtı* satırında "API gün kodu" yazıyor (hafta içi 0). Cumartesi ya da pazar bir istasyon açıp bu koda bak:
- Değiştiyse API tarifeyi güne göre veriyor; uygulama zaten gün tipine göre ayrı saklıyor.
- Hâlâ 0 ise API hafta sonu da hafta içi tarifesini veriyor olabilir; o zaman hafta sonu süreleri yanlış olur ve kodun güncellenmesi gerekir.

## Süre nasıl hesaplanıyor

- `GetTimeTable` bir istasyon ve yön için o günün kalkış saatlerini dakika hassasiyetinde (`HH:MM`) verir. Başka bir şey (saniye, tren kimliği, gecikme) gelmez.
- Telefonun saati İstanbul saatine çevrilir ve **saniyesiyle** kullanılır. Kalan süre = kalkış saati − şimdi.
- Kalan süre **aşağı yuvarlanır**: 3 dk 20 sn kaldıysa "3 dk" yazar. Böylece uygulama hiçbir zaman gerçekte kalandan fazlasını söylemez. (Moovit de aynı şekilde gösteriyor; 1.6.0'dan önce bu uygulama yukarı yuvarladığı için hep bir dakika fazla gösteriyordu.)
- 1 dakikadan az kaldıysa "şimdi" yazar. Tarife dakika hassasiyetinde olduğu için tren yazan dakikanın içinde kalkabilir; bu yüzden kalkış saatinden sonra 30 saniye daha "şimdi" olarak görünür, sonra sıradaki trene geçilir.
- 90 dakikadan uzak trenler saat olarak gösterilir ("06:04"). Sonraki iki tren 120 dakika içindeyse "sonra X ve Y dk" diye eklenir.
- Ekran 5 saniyede bir yeniden hesaplanır; değişmeyen kısım yeniden çizilmez.

## Çevrimdışı çalışma nasıl işliyor

- Uygulama dosyaları service worker önbelleğinde tutulur (`docs/sw.js`); açılış her zaman önce bu kopyadan yapılır.
- Tarifeler `localStorage`'da, **gün tipine göre ayrı ayrı** saklanır (hafta içi, cumartesi, pazar). Bugünün gün tipi için kayıt yoksa en yeni kayıt kullanılır ve kartta "Saatler farklı olabilir" notu çıkar.
- Sefer günü gece 03:00'te değişir. Cumartesi 01:30, cuma gecesi seferi sayılır.
- Favoriler internete her bağlanıldığında yenilenir (aynı gün tipi için günde en fazla bir kez).
- Son çekilen arıza bilgisi cihazda saklanır; ne zaman alındığıyla birlikte gösterilir.
- Ayarlar → *Tüm hatların tarifesini indir* ile bütün istasyonlar da indirilebilir. İBB sunucusunu yormamak için istasyonlar sırayla ve aralıklı indirilir; sadece bugünün gün tipi indirilir.
- İBB ağ geçidi kısa sürede çok istek gelince 503 döndürebiliyor; uygulama bu durumda bekleyip en fazla iki kez daha dener.

## Testler

```bash
npm test                        # hesaplama ve arıza dönüştürme birim testleri (Node 18+)
python3 tests/browser_test.py   # sahte İBB yanıtlarıyla uçtan uca test (playwright + chromium gerekir)
```

Uçtan uca test, yayın sunucusu kapatıldıktan sonra uygulamanın telefondaki kopyadan açıldığını ve tarifelerle arızaları İBB'den almaya devam ettiğini de kontrol eder.

## Kaynak, lisans ve sorumluluk

**Resmi değildir.** Bu uygulama İBB, Metro İstanbul veya bağlı kuruluşları tarafından geliştirilmemiş ya da onaylanmamıştır. Kurum adları yalnızca verinin kaynağını belirtmek için kullanılır; kurum logoları kullanılmaz.

**Veri.** İBB Açık Veri Portalı'ndan, Atıf 4.0 Uluslararası (CC BY 4.0) kapsamında lisanslanan kamu sektörü bilgilerini içerir. Lisans: <https://data.ibb.gov.tr/license>. Lisans; kopyalama, yayımlama, uyarlama ve ticari kullanıma atıf şartıyla izin veriyor, resmî onay izlenimi verilmesini yasaklıyor ve veriyi "olduğu gibi" sağlıyor. Uygulama bu atfı altbilgide ve Ayarlar → *Kaynak ve gizlilik* bölümünde gösterir.

`docs/data/stations.json` İBB `GetStations` çıktısıdır. Uygulama açılışta listeyi zaten İBB'den yeniler; bu dosya yalnızca hiç internet yokken yapılan ilk açılış içindir. İlk sürümü, aynı API'yi kullanan başka bir açık kaynak projenin kaydettiği kopyadan alındı; doğrudan kaynaktan yenilemek için (Node 18+):

```bash
node scripts/update-stations.mjs
```

**Yazı tipi.** Overpass, SIL Open Font License 1.1 ile dağıtılır; lisans metni `docs/fonts/OFL.txt`.

**Gizlilik.** Uygulama kişisel veri toplamaz; analiz, çerez ya da üçüncü taraf betiği yoktur. Favoriler, tarifeler ve ayarlar yalnızca cihazdaki tarayıcı deposunda tutulur. İstekler doğrudan İBB sunucularına gider; sayfayı açarken GitHub Pages sunucuları da bağlantı kayıtları tutabilir.

**Teşekkür.** API yanıt biçimlerini anlamakta şu açık kaynak projelerin kodu ve notları yol gösterdi: [Metro-Istanbul-General-City-Map](https://github.com/Hero4mohamed/Metro-Istanbul-General-City-Map), [istanbul-nabiz](https://github.com/muratcan-ates/istanbul-nabiz).

## Dosyalar

```
docs/               yayımlanan uygulama (GitHub Pages bu klasörü yayınlar)
  index.html, styles.css, config.js, manifest.webmanifest, sw.js
  .nojekyll         GitHub Pages'in dosyaları Jekyll ile işlemesini kapatır
  js/core.js        saf hesaplamalar: sonraki tren, gün tipi, son durak, duyuru dönüştürme
  js/data.js        İBB API'si, cihazdaki depo
  js/app.js         arayüz
  data/stations.json   başlangıç istasyon listesi (açılışta API'den yenilenir)
  fonts/            Overpass (SIL OFL)
  icons/
scripts/update-stations.mjs   başlangıç istasyon listesini İBB'den yeniler
tests/
```
