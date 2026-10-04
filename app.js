import {CLIENT_ID, PLAYLIST_ID} from './config.js?v=20261004-4';
import {shufflePlaylist} from './shuffle.js?v=20261004-4';

const $ = id => document.getElementById(id);
const redirect = new URL('./', location.href).href;
const key = `shuffler:${new URL(redirect).pathname}:`;
const scopes = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private';
let clientId = CLIENT_ID || localStorage.getItem(key + 'client') || '';
let token;
try { token = JSON.parse(sessionStorage.getItem(key + 'token') || 'null'); } catch { token = null; }
let busy = false;
const status = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => base64(crypto.getRandomValues(new Uint8Array(48)));
function render() {
  $('shuffle').disabled = busy || !/^[a-f\d]{32}$/i.test(clientId);
  $('disconnect').hidden = !token;
  $('disconnect').disabled = busy;
  $('client-id').disabled = busy;
  $('setup').querySelector('button').disabled = busy;
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
  if (!response.ok) { clearToken(); throw new Error('Spotify sign-in expired or setup is incorrect. Check your Client ID and redirect URI, then connect again.'); }
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
async function api(path, options = {}, retries = 0) {
  if (!token) throw new Error('Please connect to Spotify again.');
  if (token.expires < Date.now() + 60000) {
    if (!token.refresh) { clearToken(); throw new Error('Please connect to Spotify again.'); }
    await exchange({grant_type: 'refresh_token', refresh_token: token.refresh});
  }
  let response;
  try {
    response = await fetch('https://api.spotify.com/v1' + path, {
      method: options.method || 'GET', headers: {Authorization: `Bearer ${token.access}`, 'Content-Type': 'application/json'},
      body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(30000), cache: 'no-store'
    });
  } catch { throw new Error('Connection interrupted. Spotify may have received the last move; its result is uncertain.'); }
  if (response.status === 401 && retries < 1 && token.refresh) {
    await exchange({grant_type: 'refresh_token', refresh_token: token.refresh});
    return api(path, options, retries + 1);
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After') || 30);
    if (retries < 3 && Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
      status(`Spotify needs a pause. Continuing in ${Math.max(1, seconds)} seconds…`);
      await new Promise(resolve => setTimeout(resolve, Math.max(1, seconds) * 1000));
      return api(path, options, retries + 1);
    }
    throw new Error('Spotify is limiting requests. Wait a while before shuffling again.');
  }
  if (!response.ok) {
    if (response.status === 401) { clearToken(); throw new Error('Please connect to Spotify again.'); }
    if (response.status === 403) throw new Error('Spotify denied access. Use the playlist owner or a collaborator account, check the app’s allowed users, and confirm the developer account has Premium.');
    if (response.status === 404) throw new Error('Spotify could not find this playlist for your account.');
    throw new Error(`Spotify could not complete the request (${response.status}). Please try again later.`);
  }
  return response.json();
}
async function run() {
  if (busy) return;
  busy = true; render();
  try {
    if (!token) { status('Connecting to Spotify…'); await authenticate(); return; }
    if (!navigator.onLine) throw new Error('You are offline. Connect to the internet and try again.');
    const work = async () => {
      status('Loading the full playlist…');
      const result = await shufflePlaylist(api, PLAYLIST_ID, (done, total) => {
        status(done === total ? 'Checking the saved order…' : `Shuffling… ${Math.round(done / total * 100)}%. Keep this page open.`);
      });
      status(result.unchanged ? 'This playlist needs at least two entries to shuffle.' : `Done! All ${result.count} entries are in their new order. In Spotify, choose Custom order, turn shuffle off, and play from the first track.`);
    };
    if (navigator.locks) {
      await navigator.locks.request(key + 'shuffle', {ifAvailable: true}, async lock => {
        if (!lock) throw new Error('A shuffle is already running in another tab.');
        await work();
      });
    } else await work();
  } catch (error) { status(error.message, true); }
  finally { busy = false; render(); }
}
$('shuffle').addEventListener('click', run);
$('disconnect').addEventListener('click', () => { clearToken(); status('Disconnected. Tap Shuffle Playlist to reconnect.'); });
$('setup').addEventListener('submit', event => {
  event.preventDefault();
  clientId = $('client-id').value.trim();
  if (!/^[a-f\d]{32}$/i.test(clientId)) { status('Enter the 32-character public Spotify Client ID.', true); return; }
  localStorage.setItem(key + 'client', clientId); clearToken(); $('settings').open = false;
  status('Setup saved. Tap Shuffle Playlist to connect.'); render();
});
window.addEventListener('beforeunload', event => { if (busy && token) { event.preventDefault(); event.returnValue = ''; } });
$('client-id').value = clientId;
$('redirect').value = redirect;
$('settings').open = !clientId;
status(clientId ? (token ? 'Ready to shuffle your playlist.' : 'Tap Shuffle Playlist to connect to Spotify.') : 'Add your Spotify Client ID in Setup to get started.');
busy = true; render();
try { await callback(); } catch (error) { status(error.message, true); }
finally { busy = false; render(); }
