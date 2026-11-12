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
