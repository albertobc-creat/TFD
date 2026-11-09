/* TFD airport brief logic: NOTAM parsing/time filtering, TAF/METAR parsing, ETOPS planning-minima check.
   Pure functions, no DOM. Loads in the browser (window.TFDAirport) and in Node (module.exports).
   Everything shown to the pilot keeps the raw source text: parsing is an aid, never a filter that hides data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TFDAirport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60000;
  var HOUR = 3600000;

  // ───────────── time helpers ─────────────
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function fmtZ(d) {
    if (!d) return '—';
    return pad(d.getUTCDate()) + '/' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + 'Z';
  }

  // Resolve day-of-month + hour (+min) to the Date nearest to ref (TAF groups carry no month).
  function resolveDay(ref, dd, hh, mm) {
    var best = null, bestDiff = Infinity;
    for (var off = -1; off <= 1; off++) {
      var d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + off, dd, hh, mm || 0));
      if (hh < 24 && d.getUTCDate() !== dd) continue; // e.g. 31st in a 30-day month
      var diff = Math.abs(d - ref);
      if (diff < bestDiff) { bestDiff = diff; best = d; }
    }
    return best;
  }

  // Build the evaluation window from the OFP earliest/latest arrival times (HHMM Z) on baseDate (YYYY-MM-DD).
  function makeWindow(baseDate, earliestHHMM, latestHHMM, preMin, postMin) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(baseDate || '');
    var e = /^(\d{2}):?(\d{2})$/.exec(earliestHHMM || '');
    var l = /^(\d{2}):?(\d{2})$/.exec(latestHHMM || '');
    if (!m || !e || !l) return null;
    var base = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var eta1 = base + (+e[1]) * HOUR + (+e[2]) * MIN;
    var eta2 = base + (+l[1]) * HOUR + (+l[2]) * MIN;
    if (eta2 < eta1) eta2 += 24 * HOUR; // crosses midnight
    return {
      earliest: new Date(eta1), latest: new Date(eta2),
      start: new Date(eta1 - (preMin == null ? 60 : preMin) * MIN),
      end: new Date(eta2 + (postMin == null ? 120 : postMin) * MIN)
    };
  }

  // ───────────── NOTAM parsing ─────────────
  function parseNotamDate(s) {
    var m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s || '');
    if (!m) return null;
    return new Date(Date.UTC(2000 + (+m[1]), (+m[2]) - 1, +m[3], +m[4], +m[5]));
  }

  var FIELD_ORDER = 'QABCDEFG';

  function splitFields(block) {
    var re = /(?:^|\s)([QABCDEFG])\)\s*/g, marks = [], m, last = -1;
    while ((m = re.exec(block))) {
      var idx = FIELD_ORDER.indexOf(m[1]);
      if (idx > last) { marks.push({ k: m[1], start: m.index + m[0].length, at: m.index }); last = idx; }
    }
    var out = {};
    for (var i = 0; i < marks.length; i++) {
      var end = i + 1 < marks.length ? marks[i + 1].at : block.length;
      out[marks[i].k] = block.slice(marks[i].start, end).trim();
    }
    return out;
  }

  function parseQ(q) {
    if (!q) return null;
    var p = q.split('/').map(function (s) { return s.trim(); });
    var o = { fir: p[0] || '', code: (p[1] || '').toUpperCase(), traffic: p[2] || '', purpose: p[3] || '', scope: p[4] || '', lower: p[5] || '', upper: p[6] || '' };
    var c = /(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})?/.exec(p[7] || '');
    if (c) {
      o.lat = (+c[1] + c[2] / 60) * (c[3] === 'S' ? -1 : 1);
      o.lon = (+c[4] + c[5] / 60) * (c[6] === 'W' ? -1 : 1);
      o.radiusNm = c[7] ? +c[7] : null;
    }
    return o;
  }

  var SUBJECT_GROUP = {
    M: 'Movement area', L: 'Lighting', I: 'ILS/MLS', N: 'Nav aids', P: 'Procedures', F: 'Facilities',
    S: 'ATS/services', C: 'Comms', A: 'Airspace org.', R: 'Airspace restr.', W: 'Warnings', O: 'Obstacles',
    G: 'GNSS', X: 'Other'
  };

  function classifyNotam(n) {
    var code = (n.q && n.q.code) || '';
    var subj = code.slice(1, 3), cond = code.slice(3, 5);
    var text = String(n.e || n.raw || '').toUpperCase();
    var closed = cond === 'LC' || /\b(CLSD|CLOSED)\b/.test(text);
    var unserv = cond === 'AS' || cond === 'AU' || /\bU\/S\b|\bUNSERVICEABLE\b|\bNOT AVBL\b|\bNOT AVAILABLE\b|\bUNUSABLE\b/.test(text);
    var gnss = subj.charAt(0) === 'G' || /\b(GNSS|GPS|RNAV \(GNSS\)|JAMMING|SPOOFING)\b|\bGPS INTERFERENCE\b/.test(text);
    var prohibited = /\bPROHIBITED\b|\bRESTRICTED\b|\bDANGER\b/.test(text) || subj.charAt(0) === 'R';
    var rwyOrAd = subj === 'FA' || subj === 'MR' || subj === 'MA' || /\b(RWY|RUNWAY|AD|AERODROME|AIRPORT)\b/.test(text);
    var severity = 'INFO';
    if (closed && rwyOrAd) severity = 'CRIT';
    else if (/\bPROHIBITED\b/.test(text)) severity = 'CRIT';
    else if (closed || unserv || gnss || prohibited || 'IPW'.indexOf(subj.charAt(0)) >= 0) severity = 'HIGH';
    else if ('MLNSCFAOX'.indexOf(subj.charAt(0)) >= 0) severity = 'MED';
    var flags = [];
    if (closed) flags.push('CLOSED');
    if (unserv) flags.push('U/S');
    if (gnss) flags.push('GNSS');
    if (n.d) flags.push('SCHEDULED: read D)');
    if (n.cEst) flags.push('EST end');
    return {
      severity: severity,
      group: SUBJECT_GROUP[subj.charAt(0)] || (code ? 'Other' : 'Unclassified'),
      flags: flags,
      arrivalRelevant: 'MILNPFSCG'.indexOf(subj.charAt(0)) >= 0 || rwyOrAd
    };
  }

  // Returns notam objects; blocks that cannot be parsed come back with parsed:false and are always shown.
  function parseNotams(text) {
    var src = String(text || '').replace(/\r/g, '').trim();
    if (!src) return [];
    var headRe = /([A-Z]\d{4}\/\d{2})\s+NOTAM([NRC])(?:\s+([A-Z]\d{4}\/\d{2}))?/g;
    var heads = [], m;
    while ((m = headRe.exec(src))) heads.push({ at: m.index, id: m[1], type: m[2], ref: m[3] || null });
    var out = [];
    if (!heads.length) {
      src.split(/\n\s*\n/).forEach(function (b) {
        b = b.trim();
        if (!b) return;
        var n = { parsed: false, id: null, raw: b, e: b };
        n.cls = classifyNotam(n);
        out.push(n);
      });
      return out;
    }
    heads.forEach(function (h, i) {
      var block = src.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : src.length).trim();
      var f = splitFields(block);
      var n = { parsed: true, id: h.id, type: h.type, ref: h.ref, raw: block, q: parseQ(f.Q), a: f.A ? f.A.split(/\s+/) : [], d: f.D || '', e: f.E || '', f: f.F || '', g: f.G || '' };
      n.b = parseNotamDate((f.B || '').slice(0, 10));
      var c = f.C || '';
      n.cPerm = /^PERM/i.test(c);
      n.cEst = /EST/i.test(c);
      n.c = n.cPerm ? null : parseNotamDate(c.slice(0, 10));
      if (!n.b || (!n.cPerm && !n.c)) n.parsed = false; // validity unreadable: always shown, never filtered
      n.cls = classifyNotam(n);
      out.push(n);
    });
    // NOTAMC cancels, NOTAMR replaces: mark the referenced notam as superseded.
    var sup = {};
    out.forEach(function (n) { if (n.parsed && n.ref && (n.type === 'C' || n.type === 'R')) sup[n.ref] = n.id; });
    out.forEach(function (n) {
      if (n.id && sup[n.id]) { n.supersededBy = sup[n.id]; }
      if (n.type === 'C') n.isCancellation = true;
    });
    return out;
  }

  var SEV_RANK = { CRIT: 0, HIGH: 1, MED: 2, INFO: 3 };

  // Split into: active in window / future (starts after window) / expired (ended before window) / superseded.
  // Unparsed validity -> always in active, flagged.
  function filterNotams(list, win) {
    var r = { active: [], future: [], expired: [], superseded: [] };
    list.forEach(function (n) {
      if (n.supersededBy || n.isCancellation) { r.superseded.push(n); return; }
      if (!n.parsed || !win) { r.active.push(n); return; }
      if (n.b > win.end) r.future.push(n);
      else if (n.c && n.c < win.start) r.expired.push(n);
      else r.active.push(n);
    });
    r.active.sort(function (a, b) {
      var sa = a.cls ? SEV_RANK[a.cls.severity] : 4, sb = b.cls ? SEV_RANK[b.cls.severity] : 4;
      return sa - sb || ((a.b || 0) - (b.b || 0));
    });
    return r;
  }

  // ───────────── weather parsing ─────────────
  var WX_RE = /^[-+]?(VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$/;

  function parseGroup(tokens) {
    var o = {}, ceilVals = [], clouds = false, m;
    tokens.forEach(function (k) {
      if (k === 'CAVOK') { o.vis = 9999; o.cloudsSet = true; o.ceil = null; o.wx = []; clouds = 'cavok'; return; }
      if (/^(NSC|SKC|NCD|CLR)$/.test(k)) { o.cloudsSet = true; clouds = clouds || 'none'; return; }
      if (k === 'NSW') { o.wx = []; return; }
      if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(k))) {
        var f = m[4] === 'MPS' ? 1.944 : 1;
        o.wind = { dir: m[1] === 'VRB' ? null : +m[1], spd: Math.round(m[2] * f), gust: m[3] ? Math.round(m[3] * f) : null };
        return;
      }
      if ((m = /^(\d{4})$/.exec(k))) { o.vis = +m[1]; return; }
      if ((m = /^(P|M)?(\d+)(?:\/(\d+))?SM$/.exec(k))) {
        var sm = m[3] ? (+m[2]) / (+m[3]) : +m[2];
        o.vis = m[1] === 'P' ? 9999 : Math.min(9999, Math.round(sm * 1609));
        return;
      }
      if ((m = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/.exec(k))) {
        o.cloudsSet = true; clouds = true;
        if (m[1] === 'BKN' || m[1] === 'OVC') ceilVals.push(+m[2] * 100);
        if (m[3]) o.cb = true;
        return;
      }
      if ((m = /^VV(\d{3})$/.exec(k))) { o.cloudsSet = true; clouds = true; ceilVals.push(+m[1] * 100); return; }
      if (WX_RE.test(k)) { (o.wx = o.wx || []).push(k); return; }
    });
    if (o.cloudsSet && o.ceil === undefined) o.ceil = ceilVals.length ? Math.min.apply(null, ceilVals) : null;
    return o;
  }

  function applyOverlay(state, o) {
    var s = {};
    for (var k in state) s[k] = state[k];
    if (o.vis !== undefined) s.vis = o.vis;
    if (o.cloudsSet) { s.ceil = o.ceil; s.cb = !!o.cb; }
    if (o.wx !== undefined) s.wx = o.wx;
    if (o.wind) s.wind = o.wind;
    return s;
  }

  function worse(a, b) {
    var s = {};
    s.vis = Math.min(a.vis == null ? 9999 : a.vis, b.vis == null ? 9999 : b.vis);
    var ca = a.ceil == null ? Infinity : a.ceil, cb = b.ceil == null ? Infinity : b.ceil;
    s.ceil = Math.min(ca, cb) === Infinity ? null : Math.min(ca, cb);
    s.cb = !!(a.cb || b.cb);
    s.wx = (a.wx || []).concat((b.wx || []).filter(function (x) { return (a.wx || []).indexOf(x) < 0; }));
    var wa = a.wind, wb = b.wind;
    var sa = wa ? Math.max(wa.spd, wa.gust || 0) : -1, sb = wb ? Math.max(wb.spd, wb.gust || 0) : -1;
    s.wind = sb > sa ? wb : wa;
    return s;
  }

  function parseTaf(raw, ref) {
    ref = ref || new Date();
    var toks = String(raw || '').toUpperCase().replace(/=/g, ' ').split(/\s+/).filter(Boolean);
    var i = 0;
    if (toks[i] === 'TAF') i++;
    if (toks[i] === 'AMD' || toks[i] === 'COR') i++;
    var icao = /^[A-Z]{4}$/.test(toks[i] || '') ? toks[i++] : null;
    if (/^\d{6}Z$/.test(toks[i] || '')) i++;
    var v = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(toks[i] || '');
    if (!v) return { ok: false, error: 'TAF validity group (e.g. 0912/1018) not found', raw: raw };
    i++;
    var vFrom = resolveDay(ref, +v[1], +v[2], 0), vTo = resolveDay(ref, +v[3], +v[4], 0);
    if (vTo <= vFrom) vTo = new Date(vTo.getTime() + 30 * 24 * HOUR); // month rollover guard
    var events = [], tempos = [], cur = { kind: 'BASE', s: vFrom, e: null, tokens: [] };
    var cutoff = function () { return null; };

    function flush() {
      if (!cur) return;
      var o = parseGroup(cur.tokens);
      if (cur.kind === 'BASE' || cur.kind === 'FM' || cur.kind === 'BECMG') events.push({ kind: cur.kind, s: cur.s, e: cur.e, o: o, tokens: cur.tokens });
      else tempos.push({ kind: cur.kind, prob: cur.prob || null, s: cur.s, e: cur.e, o: o, tokens: cur.tokens });
    }
    function span(tok) {
      var m = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(tok || '');
      if (!m) return null;
      var s = resolveDay(vFrom, +m[1], +m[2], 0), e = resolveDay(vFrom, +m[3], +m[4], 0);
      if (e <= s) e = new Date(e.getTime() + 30 * 24 * HOUR);
      return { s: s, e: e };
    }

    for (; i < toks.length; i++) {
      var t = toks[i], m2;
      if ((m2 = /^FM(\d{2})(\d{2})(\d{2})$/.exec(t))) {
        flush(); cur = { kind: 'FM', s: resolveDay(vFrom, +m2[1], +m2[2], +m2[3]), e: null, tokens: [] }; continue;
      }
      if (t === 'BECMG' || t === 'TEMPO') {
        var sp = span(toks[i + 1]);
        if (sp) { flush(); cur = { kind: t, s: sp.s, e: sp.e, tokens: [] }; i++; continue; }
      }
      if ((m2 = /^PROB(30|40)$/.exec(t))) {
        var nxt = toks[i + 1] === 'TEMPO' ? i + 2 : i + 1;
        var sp2 = span(toks[nxt]);
        if (sp2) { flush(); cur = { kind: 'PROB', prob: +m2[1], s: sp2.s, e: sp2.e, tokens: [] }; i = nxt; continue; }
      }
      if (/^(TX|TN)M?\d{2}\/\d{4}Z$/.test(t)) continue;
      if (cur) cur.tokens.push(t);
    }
    flush();
    return { ok: true, icao: icao, validFrom: vFrom, validTo: vTo, events: events, tempos: tempos, raw: raw };
  }

  function stateAt(taf, t) {
    var evs = taf.events.slice().sort(function (a, b) { return a.s - b.s; });
    var st = {};
    for (var k = 0; k < evs.length; k++) {
      var ev = evs[k];
      if (ev.s > t) break;
      if (ev.kind === 'BASE') st = applyOverlay({}, ev.o);
      else if (ev.kind === 'FM') st = applyOverlay({}, ev.o);
      else if (ev.kind === 'BECMG') {
        var after = applyOverlay(st, ev.o);
        st = t >= ev.e ? after : worse(st, after); // conservative during the transition
      }
    }
    return st;
  }

  function tempoAt(taf, t) {
    var out = [];
    taf.tempos.forEach(function (x) { if (x.s <= t && t < x.e) out.push(x); });
    return out;
  }

  // ───────────── ETOPS planning minima ─────────────
  // Defaults follow the SPA.ETOPS.115 table as read from secondary sources (see README note):
  // precision: DA/H +200 ft, RVR/VIS +800 m; non-precision or circling: MDA/H +400 ft, RVR/VIS +1500 m.
  // VERIFY against the current EASA text and your OM-A 8.5 before relying on them; add-ons are editable.
  var ETOPS_ADDONS = {
    precision: { ceil: 200, vis: 800 },
    nonprecision: { ceil: 400, vis: 1500 },
    circling: { ceil: 400, vis: 1500 }
  };

  function requirement(m) {
    var add = ETOPS_ADDONS[m.type] || ETOPS_ADDONS.nonprecision;
    var ac = m.addCeil != null && m.addCeil !== '' ? +m.addCeil : add.ceil;
    var av = m.addVis != null && m.addVis !== '' ? +m.addVis : add.vis;
    return { ceil: +m.dh + ac, vis: +m.vis + av, addCeil: ac, addVis: av };
  }

  function groupIntervals(points, stepMs) {
    var out = [];
    points.forEach(function (p) {
      var last = out[out.length - 1];
      if (last && last.kind === p.kind && last.reason === p.reason && p.t - last.to <= stepMs) last.to = p.t;
      else out.push({ kind: p.kind, reason: p.reason, from: p.t, to: p.t });
    });
    return out;
  }

  // Evaluate a parsed TAF against a requirement over the window. Samples every 15 min.
  function evaluateTaf(taf, win, req, rwyHdg) {
    var STEP = 15 * MIN, fails = [], hazards = {}, worstVis = 9999, worstCeil = null, uncovered = [], maxXw = null;
    for (var t = win.start.getTime(); t <= win.end.getTime(); t += STEP) {
      var d = new Date(t);
      if (d < taf.validFrom || d >= taf.validTo) { uncovered.push({ kind: 'GAP', reason: 'no forecast', t: d }); continue; }
      var prev = stateAt(taf, d);
      var tmp = tempoAt(taf, d);
      var worst = prev;
      tmp.forEach(function (x) { worst = worse(worst, applyOverlay(prev, x.o)); });
      function check(s, kind) {
        var why = [];
        if (s.vis != null && s.vis < req.vis) why.push('VIS ' + s.vis + ' < ' + req.vis);
        if (s.ceil != null && s.ceil < req.ceil) why.push('CIG ' + s.ceil + ' < ' + req.ceil);
        return why.length ? { kind: kind, reason: why.join(', '), t: d } : null;
      }
      var fp = check(prev, 'FAIL');
      if (fp) fails.push(fp);
      else {
        var ft = check(worst, 'MARGINAL');
        if (ft) {
          var src = tmp.map(function (x) { return x.kind === 'PROB' ? 'PROB' + x.prob : 'TEMPO'; }).join('+');
          ft.reason += ' (' + src + ')';
          fails.push(ft);
        }
      }
      if (worst.vis != null) worstVis = Math.min(worstVis, worst.vis);
      if (worst.ceil != null) worstCeil = worstCeil == null ? worst.ceil : Math.min(worstCeil, worst.ceil);
      (worst.wx || []).forEach(function (w) {
        if (/TS/.test(w)) hazards.TS = true;
        if (/FZ|PL|GR|GS/.test(w)) hazards.FZ_ICE = true;
        if (/VA/.test(w)) hazards.VA = true;
        if (/SN|SG/.test(w)) hazards.SN = true;
        if (/FG/.test(w)) hazards.FG = true;
      });
      if (worst.cb) hazards.CB = true;
      var xw = crosswind(worst.wind, rwyHdg);
      if (xw && (!maxXw || xw.cross > maxXw.cross)) maxXw = { cross: xw.cross, at: d, wind: worst.wind };
    }
    var status = 'PASS';
    if (fails.some(function (f) { return f.kind === 'FAIL'; })) status = 'FAIL';
    else if (uncovered.length) status = 'INCOMPLETE';
    else if (fails.length) status = 'MARGINAL';
    return {
      status: status,
      intervals: groupIntervals(fails, STEP),
      gaps: groupIntervals(uncovered, STEP),
      worstVis: worstVis, worstCeil: worstCeil, hazards: Object.keys(hazards), maxXw: maxXw
    };
  }

  function parseMetar(raw) {
    var toks = String(raw || '').toUpperCase().replace(/=/g, ' ').split(/\s+/).filter(Boolean);
    var i = 0, info = { ok: false, raw: raw };
    if (toks[i] === 'METAR' || toks[i] === 'SPECI') i++;
    if (toks[i] === 'COR') i++;
    if (/^[A-Z]{4}$/.test(toks[i] || '')) info.icao = toks[i++];
    var t = /^(\d{2})(\d{2})(\d{2})Z$/.exec(toks[i] || '');
    if (t) { info.day = +t[1]; info.time = t[2] + t[3] + 'Z'; i++; }
    var body = [];
    for (; i < toks.length; i++) {
      if (/^(RMK|TEMPO|BECMG|NOSIG)$/.test(toks[i])) break;
      body.push(toks[i]);
    }
    var g = parseGroup(body);
    info.ok = g.vis !== undefined || g.cloudsSet || !!g.wind;
    info.state = applyOverlay({}, g);
    var q = body.filter(function (x) { return /^Q\d{4}$/.test(x); })[0];
    if (q) info.qnh = q.slice(1);
    return info;
  }

  function checkState(s, req) {
    var why = [];
    if (s.vis != null && s.vis < req.vis) why.push('VIS ' + s.vis + ' m < ' + req.vis + ' m');
    if (s.ceil != null && s.ceil < req.ceil) why.push('CIG ' + s.ceil + ' ft < ' + req.ceil + ' ft');
    return { ok: !why.length, why: why };
  }

  // Crosswind component in kt for wind dir/speed against runway heading (deg true or magnetic: caller keeps them consistent).
  function crosswind(wind, rwyHdg) {
    if (!wind || rwyHdg == null || rwyHdg === '' || isNaN(rwyHdg)) return null;
    var spd = Math.max(wind.spd, wind.gust || 0);
    if (wind.dir == null) return { cross: spd, head: 0, variable: true }; // VRB: assume worst case
    var ang = (wind.dir - rwyHdg) * Math.PI / 180;
    return { cross: Math.round(Math.abs(spd * Math.sin(ang))), head: Math.round(spd * Math.cos(ang)) };
  }

  return {
    fmtZ: fmtZ, makeWindow: makeWindow, resolveDay: resolveDay,
    parseNotams: parseNotams, classifyNotam: classifyNotam, filterNotams: filterNotams,
    parseTaf: parseTaf, parseMetar: parseMetar, stateAt: stateAt,
    requirement: requirement, evaluateTaf: evaluateTaf, checkState: checkState, crosswind: crosswind,
    ETOPS_ADDONS: ETOPS_ADDONS
  };
});
