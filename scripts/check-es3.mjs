// ExtendScript is stricter than acorn --ecma3: ES3 "future reserved words"
// cannot be used as property names (obj.native, { class: 1 }). Fail if any are.
import fs from "node:fs";

const words = "abstract|boolean|byte|char|class|const|debugger|double|enum|export|extends|final|float|goto|implements|import|int|interface|long|native|package|private|protected|public|short|static|super|synchronized|throws|transient|volatile|in";
const idWords = words.replace("|in", "");
const re = new RegExp(
  `(?:[{,]\\s*(${words})\\s*:)|(?:\\.(${words})\\b)|(?:^\\s*(${words})\\s*:)` + // property names
    `|(?:\\b(?:var|function)\\s+(${idWords})\\b)|(?:\\bvar\\s[^;]*,\\s*(${idWords})\\s*=)`, // identifiers
);
const file = process.argv[2] || "host/premiere-lib.jsx";
const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
const bad = [];
lines.forEach((line, i) => {
  const code = line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (re.test(code)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
});
if (bad.length) {
  console.error("ExtendScript reserved word used as a property name:\n" + bad.join("\n"));
  process.exit(1);
}
console.log("es3 reserved-word check ok");

// ExtendScript evaluates an unparenthesized chained conditional wrongly:
// `a ? 1 : b ? 2 : 4` returns 2 when a is true. Require parentheses around a
// conditional used as the "else" branch of another one.
const { createRequire } = await import("node:module");
let acorn = null;
try {
  acorn = createRequire(import.meta.url)("acorn");
} catch {
  console.log("acorn not installed locally; chained-ternary check skipped");
}
if (acorn) {
  const src = fs.readFileSync(file, "utf-8");
  const ast = acorn.parse(src, { ecmaVersion: 3, preserveParens: true, locations: true, allowReserved: true });
  const chained = [];
  (function visit(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ConditionalExpression" && node.alternate.type === "ConditionalExpression") chained.push(node.alternate.loc.start.line);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  })(ast);
  if (chained.length) {
    console.error("Chained ternary without parentheses (ExtendScript evaluates it wrongly) at lines:\n" + chained.map((l) => `${file}:${l}: ${lines[l - 1].trim()}`).join("\n"));
    process.exit(1);
  }
  console.log("es3 chained-ternary check ok");
}
