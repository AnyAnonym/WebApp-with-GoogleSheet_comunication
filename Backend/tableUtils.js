function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase();
}

function headerOf(values) {
  return Array.isArray(values) && values.length ? values[0].map(normalizeHeader) : [];
}

function headerIndex(header, ...names) {
  const normalized = names.map(normalizeHeader);
  return header.findIndex((value) => normalized.includes(value));
}

function columnName(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error("Ungueltiger Spaltenindex");
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function rowsById(values) {
  const header = headerOf(values);
  const idIndex = headerIndex(header, "id");
  const map = new Map();
  if (idIndex < 0) return map;
  for (const row of values.slice(1)) {
    const id = String(row[idIndex] || "").trim();
    if (id) map.set(id, row);
  }
  return map;
}

module.exports = { columnName, headerIndex, headerOf, normalizeHeader, rowsById };
