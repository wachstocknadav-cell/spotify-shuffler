import {CLIENT_ID, PLAYLIST_ID} from './config.js?v=20261004-6';
import {shufflePlaylist} from './shuffle.js?v=20261004-6';
import {spotifyFailure} from './spotify-errors.js?v=20261004-6';

const $ = id => document.getElementById(id);
const redirect = new URL('./', location.href).href;
const key = `shuffler:${new URL(redirect).pathname}:`;
const scopes = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private';
let clientId = CLIENT_ID || localStorage.getItem(key + 'client') || '';
let token;
try { token = JSON.parse(sessionStorage.getItem(key + 'token') || 'null'); } catch { token = null; }
let busy = false;
let lastRequest = 0;
let pauseRequested = false;
const planKey = () => key + 'progress:' + clientId;
const limitKey = () => key + 'limit:' + clientId;
const readLimit = () => { try { return JSON.parse(localStorage.getItem(limitKey()) || 'null'); } catch { return null; } };
const hasProgress = () => !!localStorage.getItem(planKey());
let needsRestart = localStorage.getItem(key + 'restart') === 'true';
const status = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => base64(crypto.getRandomValues(new Uint8Array(48)));
function render() {
  const limit = readLimit();
  const cooling = limit?.until && limit.until > Date.now();
  $('shuffle').disabled = busy || cooling || !/^[a-f\d]{32}$/i.test(clientId) || (needsRestart && !limit);
  $('shuffle').textContent = cooling ? 'Spotify cooldown' : limit ? 'Check Spotify access' : hasProgress() ? 'Resume shuffle' : 'Shuffle Playlist';
  $('disconnect').hidden = !token;
  $('disconnect').disabled = busy;
  $('client-id').disabled = busy;
  $('setup').querySelector('button').disabled = busy;
  $('check-access').disabled = busy || cooling || !/^[a-f\d]{32}$/i.test(clientId);
  $('pause').hidden = !busy || !token;
  $('pause').disabled = pauseRequested;
  $('discard').hidden = !needsRestart || busy;
}
function showLimit() {
  const limit = readLimit();
  if (!limit || busy) return;
  const saved = hasProgress() ? ' Your shuffle progress is saved.' : '';
  const timing = limit.until && limit.until > Date.now()
    ? ` Try again after ${new Date(limit.until).toLocaleString()}.`
    : ' Use Check Spotify access later.';
  status(limit.message + timing + saved, true);
  render();
}
function clearToken() { token = null; sessionStorage.removeItem(key + 'token'); render(); }
async function exchange(params) {
  let response;
  try {
    response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: clientId, ...params}), signal: AbortSignal.timeout(30000)
    });
  } catch { throw new Error('Could not connect to Spotify. Check your connection and try again.'); }
  if (!response.ok) { if ([400,401].includes(response.status)) clearToken(); throw new Error('Spotify could not refresh your sign-in. Please try connecting again later.'); }
  const data = await response.json();
  if (!data.access_token) throw new Error('Spotify did not return a usable sign-in. Please reconnect.');
  token = {access: data.access_token, refresh: data.refresh_token || token?.refresh, expires: Date.now() + data.expires_in * 1000};
  sessionStorage.setItem(key + 'token', JSON.stringify(token));
}
async function authenticate() {
  const verifier = randomString(), state = randomString();
  sessionStorage.setItem(key + 'auth', JSON.stringify({verifier, state, time: Date.now()}));
  const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: scopes, state, code_challenge_method: 'S256', code_challenge: challenge});
  location.assign(url.href);
}
async function callback() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  history.replaceState(null, '', redirect);
  const saved = sessionStorage.getItem(key + 'auth');
  sessionStorage.removeItem(key + 'auth');
  let auth;
  try { auth = JSON.parse(saved); } catch { /* Invalid callback is rejected below. */ }
  if (!auth || params.get('state') !== auth.state || Date.now() - auth.time > 600000) throw new Error('This sign-in link expired or could not be verified. Please connect again.');
  if (params.has('error')) throw new Error('Spotify connection was cancelled. Tap Shuffle Playlist to try again.');
  await exchange({grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirect, code_verifier: auth.verifier});
  status('Connected. Ready to shuffle your playlist.');
}
async function api(path, options = {}, refreshed = false) {
  if (!token) throw new Error('Please connect to Spotify again.');
  const existing = readLimit();
  if (existing?.until > Date.now()) throw Object.assign(new Error(existing.message), {definitelyNotApplied:true,kind:existing.kind,until:existing.until});
  if (token.expires < Date.now() + 60000) {
    if (!token.refresh) { clearToken(); throw new Error('Please connect to Spotify again.'); }
    try { await exchange({grant_type:'refresh_token',refresh_token:token.refresh}); }
    catch (error) { error.definitelyNotApplied = true; throw error; }
  }
  let response;
  try {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 750 - (Date.now() - lastRequest))));
    lastRequest = Date.now();
    response = await fetch('https://api.spotify.com/v1' + path, {
      method:options.method || 'GET', headers:{Authorization:`Bearer ${token.access}`,'Content-Type':'application/json'},
      body:options.body ? JSON.stringify(options.body) : undefined, signal:AbortSignal.timeout(45000), cache:'no-store'
    });
  } catch { throw new Error('The connection timed out or was interrupted. Saved progress will be checked before any more moves.'); }
  if (response.status === 401 && !refreshed && token.refresh) {
    try { await exchange({grant_type:'refresh_token',refresh_token:token.refresh}); }
    catch (error) { error.definitelyNotApplied = true; throw error; }
    return api(path,options,true);
  }
  if (!response.ok) {
    if (response.status === 401) { clearToken(); throw Object.assign(new Error('Please connect to Spotify again.'),{definitelyNotApplied:true}); }
    const body = await response.json().catch(() => null);
    const error = spotifyFailure(response.status,response.headers.get('Retry-After'),body);
    if (response.status === 429) localStorage.setItem(limitKey(),JSON.stringify({kind:error.kind,until:error.until,message:error.message}));
    throw error;
  }
  return response.json();
}
async function run(checkOnly = false) {
  if (busy) return;
  if (readLimit()?.until > Date.now()) { showLimit(); return; }
  busy = true; pauseRequested = false; render();
  try {
    if (!token) { status('Connecting to Spotify…'); await authenticate(); return; }
    if (!navigator.onLine) throw new Error('You are offline. Connect to the internet and try again.');
    const work = async () => {
      if (checkOnly || readLimit()) {
        status('Checking Spotify access…');
        await api(`/playlists/${PLAYLIST_ID}?fields=snapshot_id`);
        localStorage.removeItem(limitKey());
        status('Spotify access is working. Tap the main button when ready to shuffle.');
        return;
      }
      status(hasProgress() ? 'Checking saved progress…' : 'Loading the full playlist…');
      const result = await shufflePlaylist(api, PLAYLIST_ID, (done, total, count) => {
        status(done === total ? 'Checking the saved order…' : `Shuffling ${count} entries… ${Math.round(done / total * 100)}%. Keep this page open.`);
      }, undefined, {
        load:() => JSON.parse(localStorage.getItem(planKey()) || 'null'),
        save:plan => localStorage.setItem(planKey(),JSON.stringify(plan)),
        clear:() => { localStorage.removeItem(planKey()); localStorage.removeItem(key + 'restart'); needsRestart = false; },
        shouldPause:() => pauseRequested
      });
      status(result.unchanged ? 'This playlist needs at least two entries to shuffle.' : `Done! All ${result.count} entries are in their new order. In Spotify, choose Custom order, turn shuffle off, and play from the first track.`);
    };
    if (navigator.locks) {
      await navigator.locks.request(key + 'shuffle', {ifAvailable: true}, async lock => {
        if (!lock) throw new Error('A shuffle is already running in another tab.');
        await work();
      });
    } else await work();
  } catch (error) {
    if (error.conflict) { needsRestart = true; localStorage.setItem(key + 'restart','true'); }
    status(error.message,true);
  } finally { busy = false; render(); showLimit(); }
}
$('shuffle').addEventListener('click', () => run());
$('check-access').addEventListener('click', () => run(true));
$('pause').addEventListener('click', () => { pauseRequested = true; status('Pausing after the current step…'); render(); });
$('discard').addEventListener('click', () => {
  localStorage.removeItem(planKey()); localStorage.removeItem(key + 'restart'); needsRestart = false;
  status('Ready to start a new shuffle from the current playlist order.'); render(); showLimit();
});
$('disconnect').addEventListener('click', () => { clearToken(); status('Disconnected. Tap Shuffle Playlist to reconnect.'); });
$('setup').addEventListener('submit', event => {
  event.preventDefault();
  clientId = $('client-id').value.trim();
  if (!/^[a-f\d]{32}$/i.test(clientId)) { status('Enter the 32-character public Spotify Client ID.', true); return; }
  localStorage.setItem(key + 'client', clientId); clearToken(); $('settings').open = false;
  status('Setup saved. Tap Shuffle Playlist to connect.'); render();
});
window.addEventListener('storage', () => { if (!busy) { render(); showLimit(); } });
$('client-id').value = clientId;
$('redirect').value = redirect;
$('settings').open = !clientId;
status(clientId ? (hasProgress() ? 'Saved progress is ready to resume.' : token ? 'Ready to shuffle your playlist.' : 'Tap Shuffle Playlist to connect to Spotify.') : 'Add your Spotify Client ID in Setup to get started.');
busy = true; render();
try { await callback(); } catch (error) { status(error.message, true); }
finally { busy = false; render(); showLimit(); }

setInterval(() => { if (!busy) showLimit(); },1000);
