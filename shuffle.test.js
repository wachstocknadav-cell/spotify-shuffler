import test from 'node:test';
import assert from 'node:assert/strict';
import {permutation, movesFor, readPlaylist, shufflePlaylist, randomBelow} from './shuffle.js';

test('moves produce the requested permutation for empty, short, and large playlists', () => {
  for (const n of [0, 1, 2, 51, 101, 503]) for (let trial = 0; trial < 20; trial++) {
    const order = permutation(n, max => Math.floor(Math.random() * max));
    const actual = Array.from({length:n}, (_,i) => i);
    for (const move of movesFor(order)) actual.splice(move.insert_before,0,actual.splice(move.range_start,1)[0]);
    assert.deepEqual(actual, order);
    assert.equal(new Set(actual).size,n);
  }
});
test('random sampling rejects modulo bias', () => {
  let calls = 0;
  const fake = {getRandomValues(a) {a[0] = calls++ ? 4 : 0xffffffff;}};
  assert.equal(randomBelow(3,fake),1); assert.equal(calls,2);
});
function fixture(n, fail = false) {
  let items = Array.from({length:n}, (_,i) => ({item: i % 7 ? {uri:`spotify:track:${i % 13}`} : null, added_at: String(i), is_local: i === 5}));
  let version = 1, writes = 0;
  const offsets = [];
  const api = async (path, options = {}) => {
    if (options.method === 'PUT') {
      assert.equal('snapshot_id' in options.body,false);
      assert.equal('uris' in options.body,false);
      writes++;
      if (fail && writes === 2) throw new Error('network failure');
      items.splice(options.body.insert_before,0,items.splice(options.body.range_start,1)[0]);
      return {snapshot_id:String(++version)};
    }
    if (path.includes('/items?')) {
      const offset = Number(new URL('https://example.org'+path).searchParams.get('offset')); offsets.push(offset);
      return {items:items.slice(offset,offset+50),total:items.length};
    }
    return {snapshot_id:String(version)};
  };
  return {api,offsets,getItems:() => items,getWrites:() => writes};
}
test('full paginated shuffle preserves duplicates, unavailable entries, and local files', async () => {
  const f = fixture(137), original = [...f.getItems()];
  const result = await shufflePlaylist(f.api,'id',() => {},() => 0);
  assert.equal(result.count,137);
  assert.deepEqual(f.getItems(),permutation(137,() => 0).map(i => original[i]));
  assert.ok(f.offsets.includes(100));
});
test('ambiguous write is not retried and reports partial progress', async () => {
  const f = fixture(10,true);
  await assert.rejects(shufflePlaylist(f.api,'id',() => {},() => 0),/Progress is saved/);
  assert.equal(f.getWrites(),2); assert.equal(f.getItems().length,10);
});
test('changing snapshot prevents writes', async () => {
  let version = 0;
  await assert.rejects(readPlaylist(async path => path.includes('/items?') ? {items:[],total:0} : {snapshot_id:String(++version)},'id',async()=>{}),/changed while loading/);
});
test('empty pagination fails instead of looping', async () => {
  await assert.rejects(readPlaylist(async path => path.includes('/items?') ? {items:[],total:5} : {snapshot_id:'a'},'id'),/incomplete/);
});
test('external edit before a move aborts safely', async () => {
  const f=fixture(10); let metadata=0;
  const api = async (path,options) => path.includes('fields=') && ++metadata === 3 ? {snapshot_id:'external'} : f.api(path,options);
  await assert.rejects(shufflePlaylist(api,'id',()=>{},()=>0),/edited elsewhere/);
  assert.equal(f.getWrites(),0);
});
test('lagging write snapshots do not trigger excessive full-playlist reads', async () => {
  const f = fixture(57);
  const api = async (path, options) => {
    const result = await f.api(path, options);
    return options?.method === 'PUT' ? {snapshot_id:'write-response-version'} : result;
  };
  const result = await shufflePlaylist(api,'id',()=>{},()=>0);
  assert.equal(result.count,57); assert.equal(f.offsets.length,6);
});
test('a real order change after a write stops further moves', async () => {
  const f = fixture(60);
  const api = async (path, options) => {
    const result = await f.api(path,options);
    if (options?.method === 'PUT') {
      if (f.getWrites() === 1) f.getItems().reverse();
      return {snapshot_id:'different'};
    }
    return result;
  };
  await assert.rejects(shufflePlaylist(api,'id',()=>{},()=>0),/order changed unexpectedly/);
  assert.equal(f.getWrites(),50);
});
test('a temporarily changing read snapshot is retried without any writes', async () => {
  let reads=0, pauses=0;
  const api=async path => path.includes('/items?') ? {items:[],total:0} : {snapshot_id:++reads===1?'old':'new'};
  const result=await readPlaylist(api,'id',async()=>{pauses++;});
  assert.equal(result.snapshot,'new'); assert.equal(pauses,1);
});

function memory() {
  let saved = null;
  return {load:()=>saved && structuredClone(saved), save:value=>{saved=structuredClone(value);},clear:()=>{saved=null;},value:()=>saved};
}
test('quota failure resumes at the saved move without reshuffling completed work', async()=>{
  const f=fixture(60), store=memory(); let denied=false;
  const api=async(path,options)=>{
    if (options?.method==='PUT' && f.getWrites()===7 && !denied) {denied=true; throw Object.assign(new Error('quota'),{definitelyNotApplied:true});}
    return f.api(path,options);
  };
  await assert.rejects(shufflePlaylist(api,'id',()=>{},()=>0,store),/quota/);
  assert.equal(store.value().next,7); assert.equal(store.value().pending,null);
  const result=await shufflePlaylist(api,'id',()=>{},()=>{throw Error('must reuse original permutation');},store);
  assert.equal(result.count,60); assert.equal(f.getWrites(),59); assert.equal(store.value(),null);
});
test('a timed-out write that applied is reconciled without replaying it', async()=>{
  const f=fixture(10),store=memory();let lost=false;
  const api=async(path,options)=>{
    const result=await f.api(path,options);
    if (options?.method==='PUT' && !lost) {lost=true;throw new Error('timeout');}
    return result;
  };
  await assert.rejects(shufflePlaylist(api,'id',()=>{},()=>0,store),/timeout/);
  assert.equal(store.value().pending,0);
  await shufflePlaylist(api,'id',()=>{},()=>0,store);
  assert.equal(f.getWrites(),9); assert.equal(store.value(),null);
});
test('an unconfirmed write is never blindly replayed', async()=>{
  const f=fixture(10),store=memory();
  const api=async(path,options)=>{if(options?.method==='PUT')throw new Error('timeout');return f.api(path,options);};
  await assert.rejects(shufflePlaylist(api,'id',()=>{},()=>0,store),/timeout/);
  await assert.rejects(shufflePlaylist(f.api,'id',()=>{},()=>0,store),/did not confirm/);
  assert.equal(f.getWrites(),0);
});
test('pausing persists progress and verifies the playlist before resuming',async()=>{
  const f=fixture(10),store=memory();store.shouldPause=()=>f.getWrites()===3;
  await assert.rejects(shufflePlaylist(f.api,'id',()=>{},()=>0,store),/Paused/);
  assert.equal(store.value().next,3); delete store.shouldPause;
  await shufflePlaylist(f.api,'id',()=>{},()=>0,store);
  assert.equal(f.getWrites(),9);
});
test('outside edits prevent a saved plan from resuming',async()=>{
  const f=fixture(10),store=memory();store.shouldPause=()=>f.getWrites()===3;
  await assert.rejects(shufflePlaylist(f.api,'id',()=>{},()=>0,store),/Paused/);
  delete store.shouldPause; f.getItems().reverse();
  await assert.rejects(shufflePlaylist(f.api,'id',()=>{},()=>0,store),/changed since/);
  assert.equal(f.getWrites(),3);
});
