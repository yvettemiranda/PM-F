// Hecatonchires operator console: static UI plus the localhost control plane.
import { startOperatorUiServer } from "../../src/operator/operator-ui-server.ts";
import { fileURLToPath } from "node:url";

const port = Number(process.env.OPERATOR_UI_PORT ?? process.env.PROTOTYPE_PORT ?? 4173);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const staticRoot = fileURLToPath(new URL("./", import.meta.url));
const server = await startOperatorUiServer({ projectRoot, staticRoot }, port);
const address = server.address();
const actualPort = typeof address === "object" && address !== null ? address.port : port;
console.log(`Hecatonchires operator UI: http://127.0.0.1:${actualPort}/`);

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
