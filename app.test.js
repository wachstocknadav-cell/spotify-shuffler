import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spotifyFailure} from './spotify-errors.js';
import {shufflePlaylist} from './shuffle.js';

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const source=(await readFile(new URL('./app.js',import.meta.url),'utf8')).replace(/^import .+;\n/gm,'');
const client='a'.repeat(32), key='shuffler:/spotify-shuffler/:';
function storage() {
  const values=new Map();
  return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
}
async function harness(reply, local=storage()) {
  const elements=new Map(), timers=[], requests=[]; let calls=0;
  const get=id=>{if(!elements.has(id))elements.set(id,{dataset:{},addEventListener(){},querySelector(){return get('save');}});return elements.get(id);};
  const session=storage();session.setItem(key+'token',JSON.stringify({access:'synthetic-test-token',refresh:'synthetic-test-refresh',expires:Date.now()+3600000}));
  const args=['document','window','location','localStorage','sessionStorage','fetch','CLIENT_ID','PLAYLIST_ID','shufflePlaylist','spotifyFailure','setInterval','setTimeout','navigator'];
  const code=new AsyncFunction(...args,source+'\nreturn {run,api,showLimit};');
  const controls=await code({getElementById:get},{addEventListener(){}},{href:'https://example.org/spotify-shuffler/',search:''},local,session,async(url,options)=>{calls++;requests.push({url,method:options.method});return reply();},client,'id',shufflePlaylist,spotifyFailure,fn=>timers.push(fn),fn=>fn(),{onLine:true});
  return {...controls,get,local,timers,requests,calls:()=>calls};
}
const quota=()=>({ok:false,status:429,headers:{get:()=>null},json:async()=>({error:{reason:'QUOTA_EXCEEDED'}})});
test('quota response stops after one request and remains stopped after reload',async()=>{
  const h=await harness(quota);await h.run();
  assert.equal(h.calls(),1);assert.match(h.get('status').textContent,/developer quota/);
  assert.equal(h.get('shuffle').textContent,'Check Spotify access');
  for(let i=0;i<20;i++)h.timers.forEach(fn=>fn());assert.equal(h.calls(),1);
  const reloaded=await harness(quota,h.local);
  assert.equal(reloaded.calls(),0);assert.match(reloaded.get('status').textContent,/quota/);
  await reloaded.run();assert.equal(reloaded.calls(),1);
});
test('a long cooldown prevents requests even after reload',async()=>{
  const h=await harness(()=>({ok:false,status:429,headers:{get:()=> '86400'},json:async()=>({})}));
  await h.run();assert.equal(h.calls(),1);assert.equal(h.get('shuffle').disabled,true);
  const again=await harness(quota,h.local);await again.run();assert.equal(again.calls(),0);
});
test('network timeout returns without an automatic mutation retry',async()=>{
  const h=await harness(()=>{throw new Error('network timeout');});
  await assert.rejects(h.api('/playlists/id/items',{method:'PUT',body:{range_start:1,insert_before:0}}),/timed out/);
  assert.equal(h.calls(),1);
});
test('manual access check makes one read without starting a shuffle',async()=>{
  const h=await harness(()=>({ok:true,json:async()=>({snapshot_id:'snapshot'})}));
  await h.run(true);
  assert.deepEqual(h.requests,[{url:'https://api.spotify.com/v1/playlists/id?fields=snapshot_id',method:'GET'}]);
  assert.match(h.get('status').textContent,/access is working/);
  assert.equal(h.get('shuffle').textContent,'Shuffle Playlist');
  assert.equal(h.local.getItem(key+'progress:'+client),null);
});
