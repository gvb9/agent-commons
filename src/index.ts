import { resolve } from "node:path";
import { startServer } from "./server.js";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const port = Number(process.env.PORT ?? 8787);

const s = await startServer({
  dataDir,
  port,
  trustProxy: process.env.TRUST_PROXY === "1",
  ipSalt: process.env.IP_SALT || undefined,
  dashboardToken: process.env.DASHBOARD_TOKEN || undefined,
  donateUrl: process.env.DONATE_URL || undefined,
});
console.log(`agent-commons listening on :${s.port}, data in ${dataDir}`);

const stop = () => void s.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
