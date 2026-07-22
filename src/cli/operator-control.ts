import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorControlSnapshot } from "../operator/operator-control.js";
import {
  normalizeTargetWallet,
  saveSelectedTargetWallet,
  selectedTargetWallet,
} from "../operator/target-wallet.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

function valueArg(name: string): string | undefined {
  return process.argv.slice(2)
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

switch (command) {
  case "get-target":
    process.stdout.write(`${selectedTargetWallet(projectRoot).walletAddress}\n`);
    break;
  case "set-target": {
    const walletAddress = normalizeTargetWallet(valueArg("target-wallet"));
    console.log(JSON.stringify(saveSelectedTargetWallet(projectRoot, walletAddress), null, 2));
    break;
  }
  case "status":
    console.log(JSON.stringify(operatorControlSnapshot(projectRoot), null, 2));
    break;
  default:
    throw new Error("OPERATOR_CONTROL_COMMAND_REQUIRED:get-target|set-target|status");
}
