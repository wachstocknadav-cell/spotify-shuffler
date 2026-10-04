export function randomBelow(max, cryptoSource = globalThis.crypto) {
  const ceiling = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do { cryptoSource.getRandomValues(buffer); } while (buffer[0] >= ceiling);
  return buffer[0] % max;
}

export function permutation(length, random = randomBelow) {
  const order = Array.from({length}, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = random(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function movesFor(order) {
  const current = Array.from({length: order.length}, (_, i) => i);
  if (new Set(order).size !== order.length || order.some(i => !Number.isInteger(i) || i < 0 || i >= order.length)) throw new Error('Invalid permutation');
  const moves = [];
  for (let target = 0; target < order.length; target++) {
    const source = current.indexOf(order[target], target);
    if (source !== target) {
      moves.push({range_start: source, insert_before: target, range_length: 1});
      current.splice(target, 0, current.splice(source, 1)[0]);
    }
  }
  return moves;
}

async function readPlaylistOnce(api, id) {
  const path = `/playlists/${id}`;
  const before = await api(`${path}?fields=snapshot_id`);
  let items = [], total;
  do {
    const page = await api(`${path}/items?limit=50&offset=${items.length}&additional_types=track,episode`);
    if (!Array.isArray(page.items) || !Number.isInteger(page.total) || (total !== undefined && total !== page.total)) throw new Error('The playlist changed while loading. Please try again.');
    total = page.total;
    items.push(...page.items);
    if (!page.items.length && items.length < total) throw new Error('Spotify returned an incomplete playlist. Please try again.');
  } while (items.length < total);
  const after = await api(`${path}?fields=snapshot_id`);
  if (!before.snapshot_id || before.snapshot_id !== after.snapshot_id || items.length !== total) throw new Error('The playlist changed while loading. Please try again.');
  return {items, snapshot: after.snapshot_id};
}

export async function readPlaylist(api, id, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await readPlaylistOnce(api, id); }
    catch (error) {
      // Allow Spotify's read replicas to settle after a confirmed reorder.
      // Only repeat reads, never an ambiguous write.
      if (attempt >= 4 || !error.message.includes('changed while loading')) throw error;
      await pause(400 * 2 ** attempt);
    }
  }
}

export const identity = entry => JSON.stringify([entry.item?.uri ?? entry.track?.uri ?? null, entry.added_at ?? null, entry.is_local ?? false]);

export function savedPlanValid(plan, id) {
  if (!plan || plan.version !== 1 || plan.id !== id || !Array.isArray(plan.identities) || !plan.identities.every(x => typeof x === 'string')) return false;
  const n = plan.identities.length;
  const validOrder = order => Array.isArray(order) && order.length === n && new Set(order).size === n && order.every(i => Number.isInteger(i) && i >= 0 && i < n);
  if (!validOrder(plan.order) || !validOrder(plan.current)) return false;
  const count = movesFor(plan.order).length;
  return Number.isInteger(plan.next) && plan.next >= 0 && plan.next <= count && (plan.pending === null || (plan.pending === plan.next && plan.next < count));
}
const applyMove = (current, move) => current.splice(move.insert_before, 0, current.splice(move.range_start, 1)[0]);
const sameOrder = (items, plan, positions) => items.length === positions.length && items.every((entry, i) => identity(entry) === plan.identities[positions[i]]);

export async function shufflePlaylist(api, id, progress, random = randomBelow, persistence = {}) {
  const {load = () => null, save = () => {}, clear = () => {}, shouldPause = () => false} = persistence;
  const initial = await readPlaylist(api, id);
  let plan = load();
  if (plan && !savedPlanValid(plan, id)) throw Object.assign(new Error('Saved progress could not be read. Choose Start a new shuffle.'), {conflict:true});
  if (!plan) {
    if (initial.items.length < 2) return {count:initial.items.length, unchanged:true};
    plan = {version:1, id, identities:initial.items.map(identity), order:permutation(initial.items.length, random), current:initial.items.map((_,i)=>i), next:0, pending:null};
    save(plan);
  }
  const moves = movesFor(plan.order);
  if (plan.pending !== null) {
    const after = [...plan.current];
    applyMove(after, moves[plan.pending]);
    // A lost response may hide a successful write. Never replay it blindly.
    if (sameOrder(initial.items, plan, after)) {
      plan.current = after; plan.next++; plan.pending = null; save(plan);
    } else {
      throw Object.assign(new Error('Spotify did not confirm the last move. Choose Start a new shuffle to use its current order safely.'), {conflict:true});
    }
  }
  if (!sameOrder(initial.items, plan, plan.current)) throw Object.assign(new Error('The playlist changed since the last saved step. Choose Start a new shuffle.'), {conflict:true});
  let attempted = false;
  try {
    const latest = await api(`/playlists/${id}?fields=snapshot_id`);
    if (latest.snapshot_id !== initial.snapshot) throw new Error('The playlist was edited elsewhere. Shuffle stopped to avoid mixing edits.');
    for (let i = plan.next; i < moves.length; i++) {
      if (shouldPause()) throw new Error('Paused. Your progress is saved.');
      progress(i, moves.length, initial.items.length);
      plan.pending = i; save(plan);
      attempted = true;
      let result;
      try {
        result = await api(`/playlists/${id}/items`, {method:'PUT', body:moves[i]});
      } catch (error) {
        if (error.definitelyNotApplied) { plan.pending = null; save(plan); }
        throw error;
      }
      if (!result.snapshot_id) throw new Error('Spotify did not confirm the last move. Progress is saved for verification.');
      applyMove(plan.current, moves[i]); plan.next = i + 1; plan.pending = null; save(plan);
      if ((i + 1) % 50 === 0 && i + 1 < moves.length) {
        const observed = await readPlaylist(api, id);
        if (!sameOrder(observed.items, plan, plan.current)) throw Object.assign(new Error('The playlist order changed unexpectedly. Choose Start a new shuffle.'), {conflict:true});
      }
    }
    progress(moves.length, moves.length, initial.items.length);
    const final = await readPlaylist(api, id);
    if (!sameOrder(final.items, plan, plan.order)) throw Object.assign(new Error('The final order could not be verified. Choose Start a new shuffle.'), {conflict:true});
    clear();
    return {count:final.items.length};
  } catch (error) {
    if (attempted && !error.message.includes('progress is saved')) error.message += ' Progress is saved. No entries were added or removed by this app.';
    throw error;
  }
}
