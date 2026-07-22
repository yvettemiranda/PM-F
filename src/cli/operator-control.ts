import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorControlSnapshot } from "../operator/operator-control.js";
import {
  normalizeTargetWallet,
  saveSelectedTargetWallet,
  selectedTargetWallet,
} from "../operator/target-wallet.js";
import {
  OPERATOR_RULESET_PROFILE_CONTEXT,
  type RulesetCatalog,
} from "../domain/versioning.js";
import {
  resetSelectedRulesetProfile,
  saveSelectedRulesetProfile,
  selectedRulesetProfile,
} from "../operator/ruleset-profile.js";

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
  case "get-ruleset":
    console.log(JSON.stringify(selectedRulesetProfile(projectRoot, OPERATOR_RULESET_PROFILE_CONTEXT), null, 2));
    break;
  case "set-ruleset": {
    const file = valueArg("file");
    if (!file) throw new Error("OPERATOR_CONTROL_RULESET_FILE_REQUIRED");
    const parsed = JSON.parse(readFileSync(resolve(file), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPERATOR_CONTROL_RULESET_INPUT_INVALID");
    }
    const input = parsed as { name?: unknown; overrides?: unknown };
    if (typeof input.name !== "string"
      || !input.overrides
      || typeof input.overrides !== "object"
      || Array.isArray(input.overrides)) {
      throw new Error("OPERATOR_CONTROL_RULESET_INPUT_INVALID");
    }
    console.log(JSON.stringify(saveSelectedRulesetProfile(projectRoot, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: input.name,
      overrides: input.overrides as Partial<RulesetCatalog>,
    }), null, 2));
    break;
  }
  case "reset-ruleset":
    console.log(JSON.stringify({ reset: resetSelectedRulesetProfile(projectRoot) }));
    break;
  case "status":
    console.log(JSON.stringify(operatorControlSnapshot(projectRoot), null, 2));
    break;
  default:
    throw new Error(
      "OPERATOR_CONTROL_COMMAND_REQUIRED:get-target|set-target|get-ruleset|set-ruleset|reset-ruleset|status",
    );
}
