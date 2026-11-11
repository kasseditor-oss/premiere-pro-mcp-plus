// Nothing to copy: host/ and cep/ ship from the package root. Keep the bin executable.
import fs from "node:fs";
try { fs.chmodSync("dist/index.js", 0o755); } catch {}
