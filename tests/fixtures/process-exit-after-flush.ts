import { exitAfterFlushingStandardStreams } from "../../src/cli/process-exit.js";

setInterval(() => undefined, 1_000);
process.stdout.write("CAMPAIGN_FINALIZED\n");
process.stderr.write("CAMPAIGN_STDERR_FLUSHED\n");
await exitAfterFlushingStandardStreams(7);
