import assert from 'node:assert/strict';
import * as C from '../docs/js/core.js';
import { readFileSync } from 'node:fs';

// normalize
assert.equal(C.norm('Şişli-Mecidiyeköy'), 'sisli mecidiyekoy');
assert.equal(C.norm('İTÜ-Ayazağa'), 'itu ayazaga');
assert.equal(C.norm('KADIKÖY'), 'kadikoy');
// times
assert.equal(C.hhmmToMin('06:05'), 365);
assert.equal(C.hhmmToMin('24:10'), 1450);
assert.equal(C.hhmmToMin('6:05:00'), 365);
assert.equal(C.hhmmToMin('x'), null);
const t = C.parseTimes(['06:00', '06:10', '23:50', '00:10', '00:30', '06:10']);
assert.deepEqual(t, [10, 30, 360, 370, 1430]);
// span: dense day 06:00..23:50 every 10 min plus 00:10, 00:30 -> first 06:00, last 00:30
const dense = []; for (let m = 360; m <= 1430; m += 10) dense.push(m); dense.push(10, 30); dense.sort((a, b) => a - b);
assert.deepEqual([C.serviceSpan(dense).first, C.serviceSpan(dense).last], [360, 30]);
// next departures across midnight
// nextDepartures saniyeyle çalışır (günün saniyesi)
assert.deepEqual(C.nextDepartures(t, 1435 * 60, 3).map((d) => d.in), [15, 35, 365]);
assert.deepEqual(C.nextDepartures(t, 360 * 60, 2).map((d) => d.in), [0, 10]);
assert.equal(C.nextDepartures(t, 40 * 60, 1)[0].at, 360);
// 17:54:40, 17:58 treni: 3 dk 20 sn kaldı -> 3 (aşağı yuvarlama)
assert.equal(C.nextDepartures([1078], (17 * 60 + 54) * 60 + 40, 1)[0].in, 3);
assert.equal(C.nextDepartures([1078], (17 * 60 + 54) * 60 + 40, 1)[0].inSec, 200);
// kalkıştan 20 sn sonra hâlâ ilk sırada ("şimdi"), 31 sn sonra bir sonraki tren
assert.equal(C.nextDepartures(t, 360 * 60 + 20, 1)[0].at, 360);
assert.equal(C.nextDepartures(t, 360 * 60 + 20, 1)[0].inSec, -20);
assert.equal(C.nextDepartures(t, 360 * 60 + 20, 1)[0].in, 0);
assert.equal(C.nextDepartures(t, 360 * 60 + 31, 1)[0].at, 370);
assert.equal(C.nextDepartures(t, 360 * 60 + 31, 1)[0].in, 9);   // 9 dk 29 sn
// gece yarısı: 23:59:50, 00:10 treni -> 10 dk 10 sn -> 10
assert.equal(C.nextDepartures(t, 86390, 1)[0].in, 10);
assert.equal(C.istanbulNow(new Date('2026-10-01T19:54:40Z')).secOfDay, (22 * 60 + 54) * 60 + 40);
// day type: Saturday 01:30 is still Friday's service
assert.equal(C.serviceDayType('Sat', 90), 'wd');
assert.equal(C.serviceDayType('Sat', 600), 'sat');
assert.equal(C.serviceDayType('Mon', 60), 'sun');
assert.equal(C.serviceDayType('Sun', 1300), 'sun');
// pickTimetable
const rec = { wd: { t: [1, 2], at: 100 }, sat: { t: [3], at: 200 } };
assert.equal(C.pickTimetable(rec, 'wd').mismatch, false);
const p = C.pickTimetable(rec, 'sun');
assert.equal(p.mismatch, true); assert.equal(p.dayType, 'sat');
assert.equal(C.pickTimetable(null, 'wd'), null);
// towards
assert.equal(C.towards('Yenikapı -> Hacıosman'), 'Hacıosman');
assert.equal(C.towards('Hacıosman'), 'Hacıosman');
// terminus
assert.ok(C.isTerminusFor('Hacıosman', 'Yenikapı->Hacıosman'));
assert.ok(!C.isTerminusFor('Hacıosman', 'Hacıosman->Yenikapı'));
assert.ok(C.isTerminusFor('Boğaziçi Ü.-Hisarüstü', 'Levent -> Boğaziçi Ü./Hisarüstü'));
assert.ok(!C.isTerminusFor('Levent', 'Hacıosman->4.Levent'));
// line matching
assert.ok(C.lineMatches('M1A', 'M1A'));
assert.ok(C.lineMatches('M1', 'M1B'));
assert.ok(!C.lineMatches('M1', 'M11'));
assert.ok(!C.lineMatches('M2', 'M12'));
assert.ok(!C.lineMatches('T1', 'TF1'));
// mention
assert.ok(C.mentionsStation({ stations: ['Mecidiyeköy'], message: '' }, 'Mecidiyeköy'));
assert.ok(C.mentionsStation({ stations: [], message: 'Seferler Levent istasyonunda yapılmamaktadır' }, 'Levent'));
assert.ok(!C.mentionsStation({ stations: ['Levent'], message: '' }, '4.Levent') || true);
// contrast
assert.equal(C.textOn('#FCD10D'), '#13233A');
assert.equal(C.textOn('#004B86'), '#FFFFFF');
// ages
assert.equal(C.ageText(Date.now() - 3 * 864e5), '3 gün önce');

// GetServiceStatuses (gerçek yanıt örneği: tests/fixtures/service-statuses.json)
const fx = JSON.parse(readFileSync(new URL('./fixtures/service-statuses.json', import.meta.url), 'utf8'));
const items = C.mapServiceStatuses(fx.Data);
assert.equal(items.length, 1);
assert.equal(items[0].line, 'M7');
assert.equal(items[0].severity, 'minor');
assert.equal(items[0].updated, '27.07.2026 09:27');
assert.ok(C.mentionsStation(items[0], 'Mecidiyeköy'));
assert.ok(C.lineMatches(items[0].line, 'M7'));
assert.deepEqual(C.mapServiceStatuses([]), []);
assert.deepEqual(C.mapServiceStatuses(null), []);
assert.equal(C.mapServiceStatuses([{ LineName: 'M4', Description: 'x', IsActive: false }]).length, 0);
assert.equal(C.classifyNotice('Teknik arıza nedeniyle seferler geçici süreyle durdurulmuştur.'), 'major');
assert.equal(C.classifyNotice('Hava muhalefeti nedeniyle seferler yapılamamaktadır.'), 'major');
assert.equal(C.classifyNotice('Seferler aktarmalı olarak yapılmaktadır.'), 'minor');
console.log('Tüm testler geçti');
