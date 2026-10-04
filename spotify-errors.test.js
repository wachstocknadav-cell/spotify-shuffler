import test from 'node:test';
import assert from 'node:assert/strict';
import {spotifyFailure, retryDeadline} from './spotify-errors.js';

test('developer quota is distinguished from a temporary rate limit',()=>{
  const e=spotifyFailure(429,null,{error:{reason:'QUOTA_EXCEEDED'}});
  assert.equal(e.kind,'quota'); assert.equal(e.until,null); assert.equal(e.definitelyNotApplied,true);
  assert.match(e.message,/quota/); assert.match(e.message,/has not supplied/);
});
test('long Retry-After values are honored rather than discarded',()=>{
  assert.equal(spotifyFailure(429,'86400',{},1000).until,86401000);
  assert.equal(retryDeadline('60',1000),61000);
});
test('missing or malformed retry headers do not create fictional reset times',()=>{
  for(const value of [null,'','garbage','-1']) assert.equal(retryDeadline(value,Date.now()),null);
});
test('date-form Retry-After is supported',()=>{
  const when=Date.UTC(2026,9,4,20);
  assert.equal(retryDeadline(new Date(when).toUTCString(),when-60000),when);
});
test('server errors leave writes ambiguous and do not expose server messages',()=>{
  const e=spotifyFailure(503,null,{error:{message:'private response'}});
  assert.equal(e.definitelyNotApplied,false); assert.equal(e.message.includes('private'),false);
});
