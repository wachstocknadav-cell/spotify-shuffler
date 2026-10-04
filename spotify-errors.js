export function retryDeadline(value, now = Date.now()) {
  if (!value || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.max(1, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date : null;
}

export function spotifyFailure(status, retryAfter, body, now = Date.now()) {
  const quota = status === 429 && body?.error?.reason === 'QUOTA_EXCEEDED';
  const until = status === 429 ? retryDeadline(retryAfter, now) : null;
  const kind = quota ? 'quota' : status === 429 ? 'rate' : 'http';
  let message = `Spotify could not complete the request (${status}).`;
  if (status === 429) {
    message = quota ? 'Spotify’s developer quota has been reached.' : 'Spotify is currently limiting requests.';
    message += until ? ' Spotify supplied a retry time.' : ' Spotify has not supplied a retry time.';
    message += ' Automatic retries have stopped.';
  }
  if (status === 403) message = 'Spotify denied access. Check playlist ownership, allowed users, and the developer account’s Premium subscription.';
  if (status === 404) message = 'Spotify could not find this playlist for your account.';
  const error = new Error(message);
  Object.assign(error, {kind, until, definitelyNotApplied: [400,401,403,404,409,429].includes(status)});
  return error;
}
