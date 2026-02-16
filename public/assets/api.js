// assets/api.js
const API_BASE = 'https://script.google.com/macros/s/AKfycbwv0p6-pwtG0cUTN2oMvOJvFMieaFO4NJDRXF2xUm_7S7MiwHbpkRPLaIRSexSEUvmQ/exec';

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
