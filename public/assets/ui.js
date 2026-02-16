// assets/ui.js
export function setActive(navId) {
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  const el = document.querySelector(`.nav a[data-id="${navId}"]`);
  if (el) el.classList.add('active');
}
export function formatName(p) {
  return `${p.firstName || ''} ${p.lastName || ''}`.trim();
}
export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  });
  [].concat(children).forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}