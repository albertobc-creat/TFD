/* TFD OFP parser: Jeppesen Dataplan text (as printed by MSC Air Cargo) -> structured flight + schedule.
   Input is the OFP text layout (pdftotext -layout, or the layout text rebuilt by pdf.js in the browser).
   Parsing is strict about the records it understands and reports what it could not read in `warnings`;
   it never invents values. Pure functions: browser (window.TFDOfp) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TFDOfp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60000;
  var MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

  function hm(s) { return (+s.slice(0, 2)) * 60 + (+s.slice(2, 4)); }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function parseLat(s) {
    var m = /^([NS])(\d{2})(\d{2})\.?(\d)$/.exec(s || '');
    if (!m) return null;
    return (+m[2] + (+m[3] + (+m[4]) / 10) / 60) * (m[1] === 'S' ? -1 : 1);
  }
  function parseLon(s) {
    var m = /^([EW])(\d{3})(\d{2})\.?(\d)$/.exec(s || '');
    if (!m) return null;
    return (+m[2] + (+m[3] + (+m[4]) / 10) / 60) * (m[1] === 'W' ? -1 : 1);
  }
  // Flight level token: 350 -> FL350; S1250 -> 12,500 m -> ~FL410 (ICAO metric level); CLB/DSC kept as phase.
  function parseFl(tok) {
    if (/^\d{3}$/.test(tok)) return { raw: tok, fl: +tok };
    var m = /^S(\d{4})$/.exec(tok);
    if (m) return { raw: tok, fl: Math.round((+m[1]) * 10 * 3.28084 / 100), metric: (+m[1]) * 10 };
    return { raw: tok, fl: null, phase: tok };
  }
  function signedTemp(sign, n) { return (sign === 'M' ? -1 : 1) * (+n); }

  // ───────────── line patterns (verified against a real LROP-VHHH Dataplan) ─────────────
  // line 1 of a navlog record: MT, wind, OAT/DEV, TAS, GS, leg DIST, leg TIME, ETO, RTO, FL, BTGO
  var L1 = /^\s*(?:(\d{3}\.\d{1,3})\s+)?([MT])(\d{3})\s+(\d{3})\/(\d{3})\s+([MP])(\d{2})\/\s*([MP]?)(\d{2,3})\s+(\d{3})\s+(\d{3})\s+(\d{4})\s+(\d{4})\s+(\S+)\s+(\S+)\s+(\S+?)\s*\/(\d{5,6})\s*$/;
  // line 2: POSN, AWY, LAT, LONG, [MN, W/C], DTGO, EET (elapsed), TT, ATO, GM, FL/FUEL
  var L2 = /^\s*([A-Z0-9]{2,7})\s+(\S+)\s+([NS]\d{4}\.?\d)\s+([EW]\d{5}\.?\d)\s+(?:(\d{3})\s+([MP])(\d{3})\s+)?(\d{4})\s+(\d{4})\s+(\d{3})\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;
  var L0 = /^\s*([A-Z]{4})\s+(\S+)\s+([NS]\d{4,5})\s+([EW]\d{5,6})\s+(\d{4})\s+(\d{4})\s+\S+\s+(\d{5,6})\s*$/;
  var FIRLINE = /^\s*([A-Z]{4})\s{2,}([A-Z][A-Z .'()\/-]*?)(?:\s{2,}(\d{2}))?\s*$/;
  var SHRLINE = /^\s{20,}(\d{2})\s*$/;

  function parseHeader(lines, res) {
    var head = lines.slice(0, 120);
    head.forEach(function (l) {
      var m;
      if (!res.callsign && (m = /^\s*([A-Z0-9]{3,8})\s+([A-Z]{4})\/([A-Z]{3})\s*-\s*([A-Z]{4})\/([A-Z]{3})/.exec(l))) {
        res.callsign = m[1]; res.dep = m[2]; res.depIata = m[3]; res.arr = m[4]; res.arrIata = m[5];
      }
      if (!res.off && (m = /OFF\/ON\s+(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{4})Z?/.exec(l))) {
        res.off = { day: +m[1], hhmm: m[2] }; res.on = { day: +m[3], hhmm: m[4] };
      }
      if (!res.computed && (m = /COMPUTED\s+(\d{2})([A-Z]{3})(\d{2})\s+(\d{4})Z/.exec(l))) {
        res.computed = { day: +m[1], mon: MONTHS[m[2]], year: 2000 + (+m[3]), hhmm: m[4] };
      }
      if (!res.etops && (m = /ETOPS\s+(\d{2,3})\/(\d{2,3})/.exec(l))) res.etops = { rule: +m[1], diversion: +m[2] };
      if (!res.reg && (m = /REG\/([A-Z0-9]+)/.exec(l))) res.reg = m[1];
      if (!res.fuel) res.fuel = {};
      if ((m = /^\s*TRIPFUEL\s+[A-Z]{4}\s+(\d{6})\s+(\d{4})/.exec(l))) res.fuel.trip = +m[1];
      if ((m = /^\s*FOB\s+(\d{6})\s+(\d{4})/.exec(l))) { res.fuel.fob = +m[1]; res.fuel.endurance = hm(m[2]); }
      if ((m = /^\s*MINTOF\s+(\d{6})/.exec(l))) res.fuel.minTof = +m[1];
      if ((m = /^\s*ZFW\s+(\d{6})/.exec(l)) || (m = /\bZFW\s+(\d{6})/.exec(l))) res.zfw = +m[1];
      if ((m = /\bTOW\s+(\d{6})/.exec(l))) res.tow = +m[1];
      if ((m = /\bLDW\s+(\d{6})/.exec(l))) res.ldw = +m[1];
    });
    for (var q = 0; q < Math.min(lines.length, 400) && !res.reg; q++) {
      var rg = /REG\/([A-Z0-9]+)/.exec(lines[q]);
      if (rg) res.reg = rg[1];
    }
    for (var i = 0; i < Math.min(lines.length, 200); i++) {
      if (/^\s*FMS:/.test(lines[i])) {
        var r = [lines[i].replace(/^\s*FMS:\s*/, '')];
        for (var j = i + 1; j < lines.length && !/^\s*FL\s*:/.test(lines[j]) && !/^-{5,}/.test(lines[j]); j++) r.push(lines[j].trim());
        res.routeString = r.join(' ').replace(/\s+/g, ' ').trim();
      }
      var fl = /^\s*FL\s*:\s*(.+)$/.exec(lines[i]);
      if (fl && !res.flPlan) res.flPlan = fl[1].trim();
    }

    // OFP REMARK / MEL / NOTES TO CREW blocks (shown verbatim in the briefing)
    for (var h = 0; h < Math.min(lines.length, 200); h++) {
      if (/^\s*OFP REMARK:/.test(lines[h]) && res.remark == null) {
        var rm = [];
        for (var h2 = h + 1; h2 < lines.length && lines[h2].trim() && !/^\s*MEL\b/.test(lines[h2]) && !/^-{5,}/.test(lines[h2]); h2++) rm.push(lines[h2].trim());
        res.remark = rm.join(' ');
        if (/^\s*MEL\b/.test(lines[h2] || '')) res.mel = lines[h2].replace(/^\s*MEL\s*/, '').trim();
      }
      if (/^\s*NOTES TO CREW:/.test(lines[h]) && !res.notes) {
        var nt = [];
        for (var h3 = h + 1; h3 < lines.length && !/^-{20,}/.test(lines[h3]) && !/^\s*FMS:/.test(lines[h3]); h3++) nt.push(lines[h3].trim());
        var joined = nt.join(' ').replace(/\s+/g, ' ').trim();
        res.notes = joined ? joined.split(/(?=CO_\d{2}\/)/).map(function (x) { return x.replace(/\s*-{5,}.*$/, '').trim(); }).filter(Boolean) : [];
      }
    }
    var created = /Created Date Time:\s*(\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}) UTC/.exec(lines.join('\n'));
    if (created) res.created = new Date(Date.UTC(+created[3], MONTHS[created[2].toUpperCase()], +created[1], +created[4], +created[5])).toISOString();
  }

  function parseNavlog(lines, start, end, warnings) {
    var fixes = [], pending = null, last = null;
    for (var i = start; i < end; i++) {
      var l = lines[i], m;
      if (!l.trim() || /^-{5,}/.test(l) || /Page\s*-?\s*\d+/.test(l) || /^\s*(FREQ|POSN)\s/.test(l) || /^\s*SHR\s*$/.test(l)) continue;
      if (!fixes.length && !pending && (m = L0.exec(l))) {
        last = { name: m[1], awy: m[2], lat: parseLat(m[3]), lon: parseLon(m[4]), dtgo: +m[5], eet: 0, totalTime: hm(m[6]), fl: null, kind: 'DEP' };
        fixes.push(last); continue;
      }
      if ((m = L1.exec(l))) {
        pending = {
          freq: m[1] || null, mt: +m[3], mtType: m[2], windDir: +m[4], windSpd: +m[5],
          oat: signedTemp(m[6], m[7]), dev: signedTemp(m[8] || 'P', m[9]), tas: +m[10], gs: +m[11],
          legDist: +m[12], legTime: hm(m[13]), flTok: m[16], btgo: +m[17]
        };
        continue;
      }
      if (pending && (m = L2.exec(l))) {
        var f = pending; pending = null;
        f.name = m[1]; f.awy = m[2]; f.lat = parseLat(m[3]); f.lon = parseLon(m[4]);
        f.mn = m[5] ? +m[5] / 1000 : null; f.wc = m[7] ? (m[6] === 'M' ? -1 : 1) * (+m[7]) : null;
        f.dtgo = +m[8]; f.eet = hm(m[9]); f.tt = +m[10]; f.gm = m[12];
        var fl = parseFl(f.flTok); f.fl = fl.fl; f.flRaw = fl.raw; f.flPhase = fl.phase || null; if (fl.metric) f.flMetric = fl.metric;
        if (f.lat == null || f.lon == null) warnings.push('Bad coordinates at ' + f.name);
        f.kind = /^(EEP|EXP|ETP)\d*$/.test(f.name) ? f.name.slice(0, 3) : (f.name === 'TOC' ? 'TOC' : f.name === 'TOD' ? 'TOD' : f.name === 'FIR' ? 'FIR' : 'FIX');
        fixes.push(f); last = f; continue;
      }
      if (last && (m = SHRLINE.exec(l))) { last.shr = +m[1]; continue; }
      if (last && (m = FIRLINE.exec(l)) && !/^(FREQ|POSN)/.test(m[1])) { last.fir = m[1]; last.firName = m[2].trim(); if (m[3]) last.shr = +m[3]; continue; }
    }
    if (pending) warnings.push('Navlog record without a position line near the end');
    return fixes;
  }

  function parseWinds(lines, fixes, warnings) {
    var levels = null, list = [];
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*FL\s*\/\s*((?:\d{5}\s*)+)$/.exec(lines[i]);
      if (m) { levels = m[1].trim().split(/\s+/).map(Number); continue; }
      if (!levels) continue;
      var r = /^\s*([A-Z0-9]{2,7})\s+((?:\d{5,6}[MP]\d{2}\s*)+)$/.exec(lines[i]);
      if (!r) continue;
      var cells = r[2].trim().split(/\s+/).map(function (c) {
        var p = /^(\d{3})(\d{2,3})([MP])(\d{2})$/.exec(c);
        return p ? { dir: +p[1], spd: +p[2], temp: signedTemp(p[3], p[4]) } : null;
      });
      if (cells.length !== levels.length || cells.some(function (c) { return !c; })) { warnings.push('Wind row not readable: ' + r[1]); continue; }
      list.push({ name: r[1], cells: cells });
    }
    if (!levels) return null;
    return { levelsFt: levels, rows: list };
  }

  function parseEtops(lines, res, warnings) {
    var et = { alternates: [], era: null, etp: null, rangeRingNm: null };
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], m;
      if ((m = /^\s*([A-Z]{4})\/([A-Z]{3})\s+VALIDITY PERIOD FROM\s+(\d{4})\s+UTC\s*\/\s*TO\s+(\d{4})\s+UTC/.exec(l)))
        et.alternates.push({ icao: m[1], iata: m[2], from: hm(m[3]), to: hm(m[4]), fromHHMM: m[3], toHHMM: m[4] });
      if ((m = /^\s*ETP LOCATION\s+([NS]\d{4}\.\d)\s+([EW]\d{5}\.\d)/.exec(l))) et.etp = { lat: parseLat(m[1]), lon: parseLon(m[2]) };
      if (et.etp && (m = /^\s*ETE FROM ORIGIN\s+(\d{2})\+(\d{2})/.exec(l))) et.etp.eet = (+m[1]) * 60 + (+m[2]);
      if ((m = /Range Ring Radius:\s*(\d+)/.exec(l))) et.rangeRingNm = +m[1];
      if ((m = /Diversion Mode:\s*(\d+)\/(\d+)/.exec(l))) et.mode = { rule: +m[1], diversion: +m[2] };
      if (/^\s*ERA\s+DIVERT PT/.test(l)) {
        var n = /^\s*([A-Z]{4})\s+([NS]\d{4}\.\d)\s+(\d{4})\s+(\d{3})\s+(\d{3})\s+(\d{4})\s+(\d{3})\s+(\d\.\d{2})\s+(\d{4})/.exec(lines[i + 1] || '');
        var n2 = /^\s*([EW]\d{5}\.\d)/.exec(lines[i + 2] || '');
        if (n) et.era = { icao: n[1], divertLat: parseLat(n[2]), divertLon: n2 ? parseLon(n2[1]) : null, distNm: +n[6], fl: +n[7], time: (+n[8].split('.')[0]) * 60 + (+n[8].split('.')[1]), eta: hm(n[9]), etaHHMM: n[9] };
      }
    }
    // dedupe alternates (OFP prints the block twice in some exports)
    var seen = {};
    et.alternates = et.alternates.filter(function (a) { var k = a.icao; if (seen[k]) return false; seen[k] = 1; return true; });
    return et;
  }

  function parseAlternates(lines) {
    var out = [], seen = {};
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*ALTN-(\d)\s+([A-Z]{4})\/([A-Z]{3})\s+(.+?)\s+([NS]\d{4}\.\d)\s+([EW]\d{5}\.\d)\s*$/.exec(lines[i]);
      if (!m || seen[m[2]]) continue;
      seen[m[2]] = 1;
      var a = { n: +m[1], icao: m[2], iata: m[3], name: m[4].trim(), lat: parseLat(m[5]), lon: parseLon(m[6]) };
      for (var j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        var d = /^\s*ALTERNATE\s*-\s*\d\s+[A-Z]{4}\s+(\d{3})\s+(\d{3})\s+(\d{4})\s+(\d{3})\s+(\d)\.(\d{2})\s+(\d{4})\s+(\d{6})/.exec(lines[j]);
        if (d) { a.msa = +d[1]; a.dist = +d[3]; a.fl = +d[4]; a.time = (+d[5]) * 60 + (+d[6]); a.eta = hm(d[7]); a.etaHHMM = d[7]; a.fuel = +d[8]; break; }
      }
      out.push(a);
    }
    return out;
  }

  function parseOfp(text) {
    var all = String(text || '').replace(/\r/g, '').split('\n');
    var endIdx = -1;
    for (var k = 0; k < all.length; k++) if (/END OF JEPPESEN DATAPLAN/.test(all[k])) { endIdx = k; break; }
    var lines = endIdx > 0 ? all.slice(0, endIdx) : all;
    var res = { ok: false, warnings: [] };
    parseHeader(all, res);
    var rs = -1, re = lines.length;
    for (var i = 0; i < lines.length; i++) {
      if (rs < 0 && /ROUTING TO [A-Z]{4}/.test(lines[i])) rs = i;
      else if (rs >= 0 && /DESTINATION ALTERNATE AIRPORTS/.test(lines[i])) { re = i; break; }
    }
    if (rs < 0) { res.error = 'No "ROUTING TO ..." navlog found: is this a Jeppesen Dataplan OFP?'; return res; }
    res.fixes = parseNavlog(lines, rs, re, res.warnings);
    if (res.fixes.length < 5) { res.error = 'Navlog could not be read (' + res.fixes.length + ' records).'; return res; }
    var firs = [];
    res.fixes.forEach(function (f, idx) { if (f.fir) firs.push({ icao: f.fir, name: f.firName, entryFix: f.name, entryEet: f.eet, idx: idx }); });
    firs.forEach(function (f, i) { f.exitEet = i + 1 < firs.length ? firs[i + 1].entryEet : res.fixes[res.fixes.length - 1].eet; f.exitFix = i + 1 < firs.length ? firs[i + 1].entryFix : res.fixes[res.fixes.length - 1].name; });
    res.firs = firs;
    res.winds = parseWinds(lines, res.fixes, res.warnings);
    res.etopsData = parseEtops(lines, res, res.warnings);
    res.alternates = parseAlternates(lines);
    var lastFix = res.fixes[res.fixes.length - 1];
    res.totalEet = lastFix.eet;
    res.totalDist = res.fixes[0].dtgo;
    if (res.dep && res.fixes[0].name !== res.dep) res.warnings.push('Navlog start ' + res.fixes[0].name + ' differs from header ' + res.dep);
    if (res.on && res.off) {
      var planned = ((hm(res.on.hhmm) - hm(res.off.hhmm)) + 1440) % 1440;
      res.plannedBlockMin = planned;
      if (Math.abs(planned - res.totalEet) > 10) res.warnings.push('OFF/ON time (' + planned + ' min) and navlog EET (' + res.totalEet + ' min) differ by >10 min');
    }
    res.ok = true;
    return res;
  }

  // ───────────── schedule for a chosen take-off time ─────────────
  // offDate: Date (UTC) of actual/planned take-off. Returns absolute times for every fix, FIR, ETOPS alternate and alternate.
  function schedule(ofp, offDate) {
    var off = offDate.getTime();
    var at = function (min) { return new Date(off + min * MIN); };
    var origOffMin = ofp.off ? hm(ofp.off.hhmm) : null;
    var rel = function (hhmm) { // OFP absolute HHMM -> minutes after OFP take-off (handles midnight)
      return ((hm(hhmm) - origOffMin) + 1440) % 1440;
    };
    var s = {
      off: new Date(off),
      fixes: ofp.fixes.map(function (f) { return { name: f.name, eto: at(f.eet) }; }),
      on: at(ofp.plannedBlockMin != null ? ofp.plannedBlockMin : ofp.totalEet),
      firs: ofp.firs.map(function (f) { return { icao: f.icao, name: f.name, entry: at(f.entryEet), exit: at(f.exitEet), entryFix: f.entryFix, exitFix: f.exitFix }; }),
      etopsAlternates: [], era: null, alternates: [], etp: null
    };
    if (origOffMin != null) {
      ofp.etopsData.alternates.forEach(function (a) {
        var from = rel(a.fromHHMM), to = rel(a.toHHMM);
        if (to < from) to += 1440;
        s.etopsAlternates.push({ icao: a.icao, iata: a.iata, from: at(from), to: at(to) });
      });
      if (ofp.etopsData.era) s.era = { icao: ofp.etopsData.era.icao, eta: at(rel(ofp.etopsData.era.etaHHMM)) };
      ofp.alternates.forEach(function (a) { if (a.etaHHMM) s.alternates.push({ icao: a.icao, eta: at(rel(a.etaHHMM)) }); });
    }
    if (ofp.etopsData.etp && ofp.etopsData.etp.eet != null) s.etp = at(ofp.etopsData.etp.eet);
    return s;
  }

  // Wind/temperature profile along the route: for each fix with a wind row, the 7 flight-level samples.
  function windProfile(ofp) {
    if (!ofp.winds) return null;
    var cols = ofp.winds.levelsFt, pts = [], j = 0, rows = ofp.winds.rows;
    // The summary lists fixes in navlog order but omits some (TOC, ETOPS points...) and repeats names (FIR): match sequentially.
    ofp.fixes.forEach(function (f, idx) {
      if (j < rows.length && rows[j].name === f.name) { pts.push({ idx: idx, name: f.name, eet: f.eet, dtgo: f.dtgo, fl: f.fl, lat: f.lat, lon: f.lon, cells: rows[j].cells }); j++; }
    });
    return { levelsFt: cols, points: pts };
  }

  // Great-circle distance in NM
  function gcNm(lat1, lon1, lat2, lon2) {
    var R = 3440.065, r = Math.PI / 180;
    var a = Math.sin((lat2 - lat1) * r / 2) * Math.sin((lat2 - lat1) * r / 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) * Math.sin((lon2 - lon1) * r / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }


  // Spherical interpolation between two points, f in [0,1]
  function gcInterp(lat1, lon1, lat2, lon2, f) {
    var r = Math.PI / 180, p1 = lat1 * r, l1 = lon1 * r, p2 = lat2 * r, l2 = lon2 * r;
    var d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((l2 - l1) / 2), 2)));
    if (d < 1e-9) return { lat: lat1, lon: lon1 };
    var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    var z = A * Math.sin(p1) + B * Math.sin(p2);
    return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) / r, lon: Math.atan2(y, x) / r };
  }

  // Dead-reckoned position at `minutes` after take-off (clamped to the navlog), from OFP elapsed times.
  function interpolate(ofp, minutes) {
    var fx = ofp.fixes, n = fx.length;
    if (minutes <= 0) return { lat: fx[0].lat, lon: fx[0].lon, prev: fx[0], next: fx[1], phase: 'GROUND' };
    if (minutes >= fx[n - 1].eet) return { lat: fx[n - 1].lat, lon: fx[n - 1].lon, prev: fx[n - 1], next: null, phase: 'ARRIVED' };
    var i = 0;
    while (i < n - 2 && fx[i + 1].eet <= minutes) i++;
    var a = fx[i], b = fx[i + 1], span = b.eet - a.eet;
    var f = span > 0 ? (minutes - a.eet) / span : 0;
    var p = gcInterp(a.lat, a.lon, b.lat, b.lon, f);
    var fir = null;
    for (var k = i; k >= 0; k--) if (fx[k].fir) { fir = { icao: fx[k].fir, name: fx[k].firName }; break; }
    return { lat: p.lat, lon: p.lon, prev: a, next: b, fraction: f, fir: fir, phase: 'AIRBORNE' };
  }

  // Altitude profile (ft) vs distance flown (NM). Climb/descent legs are interpolated: approximate by construction.
  function profile(ofp) {
    var fx = ofp.fixes, total = ofp.totalDist, pts = [];
    var distOf = function (f) { return total - f.dtgo; };
    var lastNum = { d: 0, alt: 0 };
    for (var i = 0; i < fx.length; i++) {
      var f = fx[i], d = distOf(f), alt = null;
      if (f.fl != null) alt = f.fl * 100;
      else if (f.kind === 'DEP') alt = 0;
      pts.push({ d: d, alt: alt, fix: f });
    }
    // fill CLB (between previous numeric and next numeric) and DES (previous numeric down to 0 at the last fix)
    for (var j = 0; j < pts.length; j++) {
      if (pts[j].alt != null) continue;
      var pj = j - 1; while (pj >= 0 && pts[pj].alt == null) pj--;
      var nj = j + 1; while (nj < pts.length && pts[nj].alt == null) nj++;
      var a0 = pj >= 0 ? pts[pj] : { d: 0, alt: 0 };
      var a1 = nj < pts.length ? pts[nj] : { d: pts[pts.length - 1].d, alt: 0 };
      if (a1.d === a0.d) { pts[j].alt = a0.alt; continue; }
      pts[j].alt = a0.alt + (a1.alt - a0.alt) * (pts[j].d - a0.d) / (a1.d - a0.d);
    }
    return pts.map(function (p) { return { d: p.d, alt: Math.max(0, Math.round(p.alt)), name: p.fix.name, kind: p.fix.kind, gm: p.fix.gm }; });
  }

  return { gcInterp: gcInterp, interpolate: interpolate, profile: profile, parseOfp: parseOfp, schedule: schedule, windProfile: windProfile, gcNm: gcNm, parseLat: parseLat, parseLon: parseLon, parseFl: parseFl };
});
