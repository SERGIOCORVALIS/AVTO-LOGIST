import fs from "fs";

function stripInlineComment(val) {
  // Only strip unquoted trailing "  # comment"
  if (/^["']/.test(val.trim())) return val;
  const m = val.match(/^(.*?)\s+#\s.*$/);
  return m ? m[1].trimEnd() : val;
}

function parseLines(path) {
  return fs.readFileSync(path, "utf8").split(/\r?\n/);
}

function keyVal(line) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq < 0) return null;
  return {
    key: t.slice(0, eq).trim(),
    val: t.slice(eq + 1),
    leadingSpace: /^\s+[A-Z0-9_]+=/.test(line),
  };
}

const envPath = ".env";
const exPath = ".env.example";
const envLines = parseLines(envPath);
const exLines = parseLines(exPath);

const issues = [];
for (const [label, lines] of [
  [".env", envLines],
  [".env.example", exLines],
]) {
  lines.forEach((line, i) => {
    const kv = keyVal(line);
    if (!kv) return;
    if (kv.leadingSpace) issues.push(`${label}:${i + 1} leading_space key=${kv.key}`);
    const cleaned = stripInlineComment(kv.val);
    if (cleaned !== kv.val && /#/.test(kv.val)) {
      issues.push(
        `${label}:${i + 1} inline_comment_in_value key=${kv.key} raw=${JSON.stringify(kv.val.slice(0, 60))}`
      );
    }
  });
}
console.log(issues.join("\n") || "no structural issues");
