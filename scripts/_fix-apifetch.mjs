import fs from "fs";
const p = new URL("../apps/tg-gateway/src/managementBot.ts", import.meta.url);
let s = fs.readFileSync(p, "utf8");
const before = (s.match(/await fetch\(`\$\{opts\.apiBase\}/g) || []).length;
s = s.replaceAll("await fetch(`${opts.apiBase}", "await apiFetch(`${opts.apiBase}");
fs.writeFileSync(p, s);
const after = (s.match(/await fetch\(`\$\{opts\.apiBase\}/g) || []).length;
const done = (s.match(/await apiFetch\(`\$\{opts\.apiBase\}/g) || []).length;
console.log({ before, after, done });
