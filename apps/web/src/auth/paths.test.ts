/**
 * Run: pnpm --filter @alo/web test
 */
import {
  DIRECTOR_NAV,
  DIRECTOR_ONLY_SEGMENTS,
  MANAGER_NAV,
  homePath,
  isDirectorOnlySegment,
  navForRole,
} from "./paths";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(homePath("director") === "/director", "director home");
assert(homePath("manager") === "/manager", "manager home");
assert(MANAGER_NAV.some((i) => i.to === "deals"), "deals nav");
assert(MANAGER_NAV.some((i) => i.to === "clients"), "clients nav");
assert(MANAGER_NAV.some((i) => i.to === "documents"), "docs nav");
assert(!MANAGER_NAV.some((i) => i.to === "policy"), "manager has no policy");
assert(DIRECTOR_NAV.some((i) => i.to === "policy"), "director policy");
assert(DIRECTOR_NAV.some((i) => i.to === "partners"), "director partners");
assert(navForRole("manager").length === MANAGER_NAV.length, "manager nav size");
assert(navForRole("director").length > MANAGER_NAV.length, "director extra");
assert(DIRECTOR_ONLY_SEGMENTS.length === 6, "six director sections");
assert(isDirectorOnlySegment("playbooks"), "playbooks director-only");
assert(!isDirectorOnlySegment("deals"), "deals shared");

console.log("paths.test.ts: ok");
