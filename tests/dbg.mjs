import { connect } from "./mcp-client.mjs";
const c = await connect();
const [tool, json] = [process.argv[2], process.argv[3] || "{}"];
const r = await c.call(tool, JSON.parse(json));
console.log(r.ok, r.ms + "ms", JSON.stringify(r.data, null, 0).slice(0, 4000));
c.close();
