import { isAfterHours } from "./hours";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const prev = { ...process.env };
process.env.VOICE_TZ = "Europe/Moscow";
process.env.VOICE_HOURS_START = "1";
process.env.VOICE_HOURS_END = "23";
process.env.VOICE_SKIP_WEEKENDS = "false";

assert(isAfterHours(new Date("2026-08-14T20:35:00+03:00")) === false, "Friday 20:35 Moscow is in hours 1-23");
assert(isAfterHours(new Date("2026-08-14T08:00:00+03:00")) === false, "Friday 08:00 in hours");
assert(isAfterHours(new Date("2026-08-14T00:30:00+03:00")) === true, "Friday 00:30 after hours");

process.env.VOICE_HOURS_START = "9";
process.env.VOICE_HOURS_END = "19";
assert(isAfterHours(new Date("2026-08-14T20:35:00+03:00")) === true, "20:35 after 19");

Object.assign(process.env, prev);
console.log("hours.test ok");
