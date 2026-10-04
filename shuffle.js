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

export async function readPlaylist(api, id) {
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

export const identity = entry => JSON.stringify([entry.item?.uri ?? entry.track?.uri ?? null, entry.added_at ?? null, entry.is_local ?? false]);

export async function shufflePlaylist(api, id, progress, random = randomBelow) {
  const initial = await readPlaylist(api, id);
  if (initial.items.length < 2) return {count: initial.items.length, unchanged: true};
  const order = permutation(initial.items.length, random);
  const moves = movesFor(order);
  let snapshot = initial.snapshot;
  let attempted = false;
  try {
    for (let i = 0; i < moves.length; i++) {
      progress(i, moves.length);
      const latest = await api(`/playlists/${id}?fields=snapshot_id`);
      if (latest.snapshot_id !== snapshot) throw new Error('The playlist was edited elsewhere. Shuffle stopped to avoid mixing edits.');
      attempted = true;
      const result = await api(`/playlists/${id}/items`, {method: 'PUT', body: {...moves[i], snapshot_id: snapshot}});
      if (!result.snapshot_id) throw new Error('Spotify did not confirm the new order.');
      snapshot = result.snapshot_id;
    }
    progress(moves.length, moves.length);
    const final = await readPlaylist(api, id);
    if (final.snapshot !== snapshot || final.items.length !== order.length || final.items.some((entry, i) => identity(entry) !== identity(initial.items[order[i]]))) throw new Error('The final playlist order could not be verified.');
    return {count: final.items.length};
  } catch (error) {
    if (attempted) error.message += ' Some entries may already have moved. No entries were added or removed by this app. You can shuffle again.';
    throw error;
  }
}
