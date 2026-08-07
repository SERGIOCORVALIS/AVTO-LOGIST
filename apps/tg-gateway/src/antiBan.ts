const minuteBuckets: number[] = [];

export function withinWorkHours(now = new Date()): boolean {
  const start = Number(process.env.TG_WORK_HOURS_START || 9);
  const end = Number(process.env.TG_WORK_HOURS_END || 21);
  // Approximate using local server time; production should use TG_TZ
  const hour = now.getHours();
  return hour >= start && hour < end;
}

export async function humanDelay(): Promise<number> {
  const min = Number(process.env.TG_MIN_REPLY_DELAY_MS || 800);
  const max = Number(process.env.TG_MAX_REPLY_DELAY_MS || 2500);
  const jitter = Math.floor(Math.random() * (max - min + 1)) + min;
  return jitter;
}

export function rateLimitOk(now = Date.now()): boolean {
  const limit = Number(process.env.TG_MAX_MSGS_PER_MINUTE || 20);
  while (minuteBuckets.length && now - minuteBuckets[0] > 60_000) {
    minuteBuckets.shift();
  }
  if (minuteBuckets.length >= limit) return false;
  minuteBuckets.push(now);
  return true;
}
