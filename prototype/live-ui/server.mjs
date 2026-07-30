// Hecatonchires operator console: static UI plus the localhost control plane.
import { startOperatorUiServer } from "../../src/operator/operator-ui-server.ts";
import { assembleDefaultConnectedLiveRuntime } from "../../src/operator/default-connected-live-runtime.ts";
import { LiveWalletRequestBroker } from "../../src/operator/live-wallet-request-broker.ts";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const port = Number(process.env.OPERATOR_UI_PORT ?? process.env.PROTOTYPE_PORT ?? 4173);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const staticRoot = fileURLToPath(new URL("./", import.meta.url));
const walletRequestBroker = new LiveWalletRequestBroker();

let server;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = 0;
  try {
    await server.shutdownSafety();
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
  server.close(() => process.exit(exitCode));
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
};

server = await startOperatorUiServer({
  projectRoot,
  staticRoot,
  walletRequestBroker,
  connectedLiveRuntimeFactory: (input) => assembleDefaultConnectedLiveRuntime({
    ...input,
    walletRequestBroker,
  }),
  requestShutdown: shutdown,
}, port);
const address = server.address();
const actualPort = typeof address === "object" && address !== null ? address.port : port;
console.log(`Hecatonchires operator UI: http://127.0.0.1:${actualPort}/`);
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
