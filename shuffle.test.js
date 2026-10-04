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
      assert.equal(options.body.snapshot_id,String(version));
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
  await assert.rejects(shufflePlaylist(f.api,'id',() => {},() => 0),/Some entries may already have moved/);
  assert.equal(f.getWrites(),2); assert.equal(f.getItems().length,10);
});
test('changing snapshot prevents writes', async () => {
  let version = 0;
  await assert.rejects(readPlaylist(async path => path.includes('/items?') ? {items:[],total:0} : {snapshot_id:String(++version)},'id'),/changed while loading/);
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
test('a different write snapshot is reconciled only against the complete expected order', async () => {
  const f = fixture(57);
  const api = async (path, options) => {
    const result = await f.api(path, options);
    return options?.method === 'PUT' ? {snapshot_id:'write-response-version'} : result;
  };
  const result = await shufflePlaylist(api,'id',()=>{},()=>0);
  assert.equal(result.count,57);
});
test('a real order change after a write stops further moves', async () => {
  const f = fixture(10);
  const api = async (path, options) => {
    const result = await f.api(path,options);
    if (options?.method === 'PUT') {
      f.getItems().reverse();
      return {snapshot_id:'different'};
    }
    return result;
  };
  await assert.rejects(shufflePlaylist(api,'id',()=>{},()=>0),/order changed unexpectedly/);
  assert.equal(f.getWrites(),1);
});
