/* Rebuild fixed-column layout text from a pdf.js document, so OFP parsing sees the same lines as `pdftotext -layout`.
   Works with any monospaced OFP print. Browser: window.TFDPdfText; Node: module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TFDPdfText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a.length ? a[Math.floor(a.length / 2)] : 0; }

  function pageToText(items) {
    var widths = [];
    items.forEach(function (it) { if (it.str && it.str.length >= 4 && it.width > 0) widths.push(it.width / it.str.length); });
    var cw = median(widths);
    if (!cw) return '';
    var rows = [];
    items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var y = it.transform[5], x = it.transform[4], r = null;
      for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].y - y) < 2.5) { r = rows[i]; break; }
      if (!r) { r = { y: y, cells: [] }; rows.push(r); }
      r.cells.push({ x: x, str: it.str });
    });
    rows.sort(function (a, b) { return b.y - a.y; });
    return rows.map(function (r) {
      r.cells.sort(function (a, b) { return a.x - b.x; });
      var line = '';
      r.cells.forEach(function (c) {
        var col = Math.round(c.x / cw);
        if (col > line.length) line += new Array(col - line.length + 1).join(' ');
        else if (line.length && !/\s$/.test(line)) line += ' '; // touching items: keep tokens apart
        line += c.str;
      });
      return line.replace(/\s+$/, '');
    }).join('\n');
  }

  // pdf: a pdf.js PDFDocumentProxy. Returns the whole document as layout text.
  function layoutTextFromPdf(pdf) {
    var pages = [];
    var chain = Promise.resolve();
    for (var n = 1; n <= pdf.numPages; n++) {
      (function (num) {
        chain = chain.then(function () { return pdf.getPage(num); })
          .then(function (p) { return p.getTextContent(); })
          .then(function (tc) { pages.push(pageToText(tc.items)); });
      })(n);
    }
    return chain.then(function () { return pages.join('\n\n'); });
  }

  return { layoutTextFromPdf: layoutTextFromPdf, pageToText: pageToText };
});
