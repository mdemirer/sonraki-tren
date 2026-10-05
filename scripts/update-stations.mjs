// İstasyon başlangıç listesini (docs/data/stations.json) doğrudan Metro İstanbul API'sinden yeniler.
// Uygulama açılışta listeyi zaten İBB'den günceller; bu dosya yalnızca hiç internet yokken
// yapılan ilk açılış ve arama için kullanılır. Yeni istasyon açıldığında çalıştırman yeterli.
//
// Kullanım (Node 18+):  node scripts/update-stations.mjs
import { writeFileSync } from 'node:fs';

const URL = 'https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2/GetStations';
const r = await fetch(URL);
if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1); }
const j = await r.json();
if (!j.Success || !Array.isArray(j.Data)) { console.error('Beklenmeyen yanıt'); process.exit(1); }

const list = j.Data.map((x) => ({
  id: x.Id, lineId: x.LineId, line: x.LineName,
  lat: x.DetailInfo ? +(+x.DetailInfo.Latitude).toFixed(5) : null,
  lng: x.DetailInfo ? +(+x.DetailInfo.Longitude).toFixed(5) : null,
  name: x.Description || x.Name,
})).filter((x) => x.id != null && x.lineId != null && x.name);

if (list.length < 50) { console.error('Beklenenden az istasyon: ' + list.length); process.exit(1); }
const out = {
  fetchedAt: Date.now(),
  source: 'Metro İstanbul GetStations, İBB Açık Veri Portalı (CC BY 4.0)',
  list,
};
writeFileSync(new URL('../docs/data/stations.json', import.meta.url), JSON.stringify(out));
console.log(list.length + ' istasyon yazıldı.');
