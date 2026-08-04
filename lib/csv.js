// Minimal CSV serializer — no dependency needed for something this small.
// columns: [{ key: 'name', header: 'Name' }, ...] — key can be a dotted path like 'equipment.brand'.

function getPath(obj, path) {
  return path.split('.').reduce((val, key) => (val && typeof val === 'object' ? val[key] : undefined), obj);
}

function escapeCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCell(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCell(getPath(row, c.key))).join(',')
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

module.exports = { toCsv };
