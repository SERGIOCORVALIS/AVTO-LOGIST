import { resolveSipProvider, listSipProviders } from "./providers";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

assert(resolveSipProvider("zadarma").domain === "sip.zadarma.com", "zadarma domain");
assert(resolveSipProvider("beeline").id === "beeline", "beeline id");
assert(resolveSipProvider("beeline_business").label.includes("Билайн"), "beeline alias");
assert(resolveSipProvider("BEELINE").codec === "pcma", "beeline codec");
assert(listSipProviders().length >= 2, "list providers");

let threw = false;
try {
  resolveSipProvider("twilio");
} catch {
  threw = true;
}
assert(threw, "unknown provider throws");

console.log("providers.test ok");
