(function () {
  var FAA_ORIGIN = 'https://notams.aim.faa.gov';
  var AWC_ORIGIN = 'https://aviationweather.gov';
  var TFD = '__TFD_URL__';
  var TFD_ORIGIN = '__TFD_ORIGIN__';
  var mode = location.origin === FAA_ORIGIN ? 'notam' : (location.origin === AWC_ORIGIN ? 'wx' : null);
  if (!mode) { alert('Open the FAA NOTAM Search page (notams.aim.faa.gov) for NOTAMs, or aviationweather.gov for weather, then tap this bookmark again.'); return; }
  var raw = prompt('Paste the location list copied from TFD (4-letter ICAO codes):', '');
  if (!raw) return;
  var seen = {}, locs = (raw.toUpperCase().match(/\b[A-Z]{4}\b/g) || []).filter(function (c) { if (seen[c]) return false; seen[c] = 1; return true; });
  if (!locs.length) { alert('No 4-letter codes found in what you pasted.'); return; }
  if (locs.length > 80) { alert('Too many locations (' + locs.length + '). Maximum 80 per run.'); return; }
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;top:10px;right:10px;background:#0b1018;color:#e2e8f4;border:2px solid #C8991A;border-radius:8px;padding:10px 14px;font:13px/1.4 -apple-system,Helvetica,Arial,sans-serif;max-width:360px;box-shadow:0 4px 20px rgba(0,0,0,.5)';
  document.body.appendChild(box);
  function say(t) { box.textContent = t; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function formBody(loc, offset) {
    var f = {
      searchType: '0', designatorsForLocation: loc, designatorForAccountable: '', latDegrees: '', latMinutes: '0', latSeconds: '0',
      longDegrees: '', longMinutes: '0', longSeconds: '0', radius: '10', sortColumns: '5 false', sortDirection: 'true',
      designatorForNotamNumberSearch: '', notamNumber: '', radiusSearchOnDesignator: 'false', radiusSearchDesignator: '',
      latitudeDirection: 'N', longitudeDirection: 'W', freeFormText: '', flightPathText: '', flightPathDivisor: '', flightPathBuffer: '',
      flightPathIncludeNavaids: 'true', flightPathIncludeArtcc: 'false', flightPathIncludeTfr: 'true', flightPathIncludeRegulatory: 'false',
      flightPathResultsType: 'All NOTAMs', archiveDate: '', archiveDesignator: '', offset: String(offset), notamsOnly: 'false', filters: '', formatType: 'ICAO'
    };
    return Object.keys(f).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(f[k]).replace(/%20/g, '+'); }).join('&');
  }
  function postNotam(loc, offset) {
    return fetch('/notamSearch/search', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' },
      body: formBody(loc, offset)
    }).then(readJson);
  }
  function getJson(path) {
    return fetch(path, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }).then(readJson);
  }
  function readJson(r) {
    if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.text().then(function (t) {
      if (!t.trim()) return [];
      try { return JSON.parse(t); } catch (x) { throw new Error('answer is not JSON: ' + t.slice(0, 100).replace(/\s+/g, ' ')); }
    });
  }
  function textOf(n) { return String(n.icaoMessage || n.message || n.traditionalMessage || '').trim(); }
  var items = [], errors = [], unreadable = 0, firstKeys = null, aborted = null, type;

  async function runNotam() {
    type = 'tfd-faa-notams';
    for (var i = 0; i < locs.length && !aborted; i++) {
      var loc = locs[i], offset = 0, total = null, pages = 0;
      say('FAA NOTAMs ' + (i + 1) + '/' + locs.length + ': ' + loc + ' (' + items.length + ' so far)');
      try {
        while (pages < 40) {
          var j = await postNotam(loc, offset);
          var list = j && j.notamList;
          if (!Array.isArray(list)) { if (j && j.error) throw new Error(String(j.error).slice(0, 120)); list = []; }
          if (total === null) total = +j.totalNotamCount || list.length;
          list.forEach(function (n) {
            var t = textOf(n);
            if (!t) { unreadable++; if (!firstKeys) firstKeys = Object.keys(n).join(','); return; }
            items.push({ loc: loc, text: t.slice(0, 20000) });
          });
          pages++; offset += list.length;
          if (!list.length || offset >= total) break;
          await wait(250);
        }
      } catch (e) {
        errors.push(loc + ': ' + e.message);
        if (e.status === 403 || e.status === 429) aborted = 'FAA refused the request (' + e.status + '). Stopped.';
      }
      await wait(250);
    }
  }

  async function runWx() {
    type = 'tfd-wx';
    var size = 15;
    for (var i = 0; i < locs.length && !aborted; i += size) {
      var chunk = locs.slice(i, i + size).join(',');
      say('Weather ' + Math.min(i + size, locs.length) + '/' + locs.length + ' (' + items.length + ' reports so far)');
      var kinds = [['metar', 'METAR'], ['taf', 'TAF']];
      for (var k = 0; k < kinds.length && !aborted; k++) {
        try {
          var arr = await getJson('/api/data/' + kinds[k][0] + '?ids=' + encodeURIComponent(chunk) + '&format=json' + (kinds[k][0] === 'metar' ? '&hours=3' : ''));
          if (!Array.isArray(arr)) arr = [];
          arr.forEach(function (o) {
            var id = o && o.icaoId, text = kinds[k][1] === 'TAF' ? (o && o.rawTAF) : (o && o.rawOb);
            if (!id || !text) return;
            var t = o.obsTime || o.reportTime || o.issueTime || o.bulletinTime || 0;
            items.push({ loc: String(id), kind: kinds[k][1], text: String(text), t: t });
          });
        } catch (e) {
          errors.push(kinds[k][1] + ' ' + chunk.slice(0, 20) + '...: ' + e.message);
          if (e.status === 403 || e.status === 429) aborted = 'aviationweather.gov refused the request (' + e.status + '). Stopped.';
        }
        await wait(250);
      }
    }
  }

  (async function () {
    if (mode === 'notam') await runNotam(); else await runWx();
    var payload = { type: type, v: 1, fetchedAt: new Date().toISOString(), requested: locs, items: items, errors: errors.slice(0, 100).map(function (s) { return String(s).slice(0, 300); }) };
    if (unreadable) payload.errors.push('Unreadable NOTAM records: ' + unreadable + ' (fields: ' + firstKeys + ')');
    if (aborted) payload.errors.push(aborted);
    var failedAll = mode === 'notam' ? errors.length === locs.length : (errors.length > 0 && !items.length);
    if (!items.length && failedAll) { say('Nothing usable came back. First error: ' + errors[0]); return; }
    say('Fetched ' + items.length + (mode === 'notam' ? ' NOTAMs' : ' weather reports') + ' for ' + locs.length + ' locations. Opening TFD...');
    var w = window.open(TFD, 'tfd_import');
    if (!w) { say('The browser blocked the TFD window. Allow pop-ups for this site (icon at the right end of the address bar) and run the bookmark again.'); return; }
    var sent = false;
    window.addEventListener('message', function (e) {
      if (e.origin !== TFD_ORIGIN || !e.data || e.data.type !== 'tfd-ready' || sent) return;
      sent = true;
      w.postMessage(payload, TFD_ORIGIN);
      say('Sent to TFD: ' + items.length + (mode === 'notam' ? ' NOTAMs' : ' weather reports') + (payload.errors.length ? ', ' + payload.errors.length + ' problem(s) listed in TFD' : '') + '. You can close this tab.');
    });
    setTimeout(function () { if (!sent) say('TFD did not answer. Keep the TFD tab open on the Flight Brief page and run the bookmark again.'); }, 20000);
  })();
})();
