// assets/api.js
const API_BASE = 'https://script.google.com/macros/s/AKfycbzxaRpxt54plDvJvklYLKeX54hZL5p-QDLEyKKS_SZQM1tRbXYMS90LNZNzD4Ylwy43/exec';

async function apiGet(action, params = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    // Wenn die Web-App "Anmeldung erforderlich" hat:
    // credentials: 'include'
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API error');
  return json.data;
}

export async function getPlayers() { return apiGet('players'); }
