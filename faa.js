/* TFD: validate and group NOTAMs delivered by the FAA bookmarklet (see faa-bookmarklet.js).
   The payload comes from another site's page, so it is treated as untrusted data: strict shape checks, size caps,
   text is only ever parsed or escaped, never executed. Browser: window.TFDFaa; Node: module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TFDFaa = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { locs: 200, items: 20000, text: 20000, errors: 100, errLen: 300, wxText: 5000 };
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  // The FAA site delivers HTML-encoded text (&apos; &amp; ...). Decode once, as plain text: no HTML parser involved.
  function decodeEntities(t) {
    return String(t).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var n = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENT.hasOwnProperty(e) ? ENT[e] : m;
    });
  }
  var CODE = /^[A-Z]{4}$/;

  // Returns a cleaned payload, or null if the shape is wrong.
  function validate(p) {
    if (!p || typeof p !== 'object' || p.type !== 'tfd-faa-notams' || p.v !== 1) return null;
    if (!Array.isArray(p.requested) || !Array.isArray(p.items)) return null;
    if (p.requested.length > LIMITS.locs || p.items.length > LIMITS.items) return null;
    var requested = [];
    for (var i = 0; i < p.requested.length; i++) {
      if (typeof p.requested[i] !== 'string' || !CODE.test(p.requested[i])) return null;
      requested.push(p.requested[i]);
    }
    var items = [];
    for (var k = 0; k < p.items.length; k++) {
      var it = p.items[k];
      if (!it || typeof it.loc !== 'string' || !CODE.test(it.loc) || typeof it.text !== 'string') return null;
      if (requested.indexOf(it.loc) < 0) continue;
      items.push({ loc: it.loc, text: it.text.slice(0, LIMITS.text) });
    }
    var errors = (Array.isArray(p.errors) ? p.errors : []).slice(0, LIMITS.errors).map(function (e) { return String(e).slice(0, LIMITS.errLen); });
    var at = new Date(p.fetchedAt);
    return { requested: requested, items: items, errors: errors, fetchedAt: isNaN(at) ? new Date().toISOString() : at.toISOString() };
  }

  // Group by location, drop exact duplicates, keep the order the FAA returned.
  function ingest(p) {
    var v = validate(p);
    if (!v) return null;
    var byLoc = {}, seen = {}, counts = {};
    v.requested.forEach(function (l) { byLoc[l] = []; counts[l] = 0; });
    v.items.forEach(function (it) {
      var key = it.loc + '|' + it.text;
      if (seen[key]) return;
      seen[key] = 1;
      byLoc[it.loc].push(decodeEntities(it.text).trim());
      counts[it.loc]++;
    });
    return { requested: v.requested, byLoc: byLoc, counts: counts, errors: v.errors, fetchedAt: v.fetchedAt };
  }

  // Weather payload from the bookmark run on aviationweather.gov: raw METAR/TAF strings per airport.
  function validateWx(p) {
    if (!p || typeof p !== 'object' || p.type !== 'tfd-wx' || p.v !== 1) return null;
    if (!Array.isArray(p.requested) || !Array.isArray(p.items)) return null;
    if (p.requested.length > LIMITS.locs || p.items.length > LIMITS.items) return null;
    for (var i = 0; i < p.requested.length; i++) if (typeof p.requested[i] !== 'string' || !CODE.test(p.requested[i])) return null;
    var items = [];
    for (var k = 0; k < p.items.length; k++) {
      var it = p.items[k];
      if (!it || typeof it.loc !== 'string' || !CODE.test(it.loc) || (it.kind !== 'METAR' && it.kind !== 'TAF') || typeof it.text !== 'string') return null;
      if (p.requested.indexOf(it.loc) < 0) continue;
      var t = typeof it.t === 'number' ? it.t : (typeof it.t === 'string' ? Date.parse(it.t) / 1000 : 0);
      items.push({ loc: it.loc, kind: it.kind, text: it.text.slice(0, LIMITS.wxText).replace(/\s+/g, ' ').trim(), t: isNaN(t) ? 0 : t });
    }
    var errors = (Array.isArray(p.errors) ? p.errors : []).slice(0, LIMITS.errors).map(function (e) { return String(e).slice(0, LIMITS.errLen); });
    var at = new Date(p.fetchedAt);
    return { requested: p.requested.slice(), items: items, errors: errors, fetchedAt: isNaN(at) ? new Date().toISOString() : at.toISOString() };
  }

  // Latest METAR and latest TAF per airport (by report time; later item wins a tie).
  function ingestWx(p) {
    var v = validateWx(p);
    if (!v) return null;
    var byLoc = {};
    v.requested.forEach(function (l) { byLoc[l] = { metar: '', taf: '', mt: -1, tt: -1 }; });
    v.items.forEach(function (it) {
      var b = byLoc[it.loc];
      if (it.kind === 'METAR' && it.t >= b.mt) { b.metar = it.text; b.mt = it.t; }
      if (it.kind === 'TAF' && it.t >= b.tt) { b.taf = it.text; b.tt = it.t; }
    });
    return { requested: v.requested, byLoc: byLoc, errors: v.errors, fetchedAt: v.fetchedAt };
  }

  // FIRs crossed more than once (e.g. UZTR) become one entry covering first entry to last exit.
  function mergeFirs(firs) {
    var m = {}, order = [];
    firs.forEach(function (f) {
      var x = m[f.icao];
      if (!x) { m[f.icao] = { icao: f.icao, name: f.name, entry: f.entry, exit: f.exit }; order.push(f.icao); }
      else { if (f.entry < x.entry) x.entry = f.entry; if (f.exit > x.exit) x.exit = f.exit; }
    });
    return order.map(function (k) { return m[k]; });
  }

  return { validate: validate, ingest: ingest, validateWx: validateWx, ingestWx: ingestWx, decodeEntities: decodeEntities, mergeFirs: mergeFirs, LIMITS: LIMITS };
});
