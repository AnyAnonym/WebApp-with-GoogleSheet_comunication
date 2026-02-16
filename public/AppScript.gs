/** Apps Script – Minimal-JSON-API für eure Vereinsdaten **/

function doGet(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    if (action === 'players') return jsonOk_(readSheet_('players'));
    // Health/Ping
    return jsonOk_({ msg: 'API alive', actions: ['players'] });
  } catch (err) {
    return jsonErr_(String(err));
  }
}

// ---- Lesen ----
function readSheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  const head = values[0];
  return values.slice(1).map(r => {
    const o = {};
    head.forEach((h,i) => o[h] = r[i]);
    return o;
  });
}


// ---- JSON Helpers ----
function jsonOk_(data) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data }))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonErr_(message, code) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: message, code: code || 500 }))
    .setMimeType(ContentService.MimeType.JSON);
}