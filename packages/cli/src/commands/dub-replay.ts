import type { Command } from "commander";
import { executeDubReplay, type DubReplayFlags } from "../orchestrator/native-dub-replay.js";

export { executeDubReplay, type DubReplayFlags };

export const registerDubReplayCommand = (program: Command): void => {
  program
    .command("dub-replay")
    .description(
      "Replay timing negotiation and subtitle generation from a previous dub run's artifacts and " +
        "print the metrics. Pure computation — no LLM, no synthesis, no separation, no burning — so " +
        "tuning cue splitting or negotiation takes seconds instead of a full dub run. Always covers " +
        "every utterance in the artifacts; there is deliberately no time-window flag.",
    )
    .requiredOption("--video-id <id>", "Video ID under --article-out-dir")
    .option("--article-out-dir <path>", "Article artifact root (default: files/articles)")
    .option(
      "--preferred-rate-min <n>",
      "Counterfactual: override the negotiation speech-rate floor to compare its effect on silence",
    )
    .option(
      "--stretch-max-occupancy <n>",
      "Counterfactual: override the occupancy ceiling that triggers slowing a line down",
    )
    .action(async (opts: DubReplayFlags) => {
      process.exitCode = await executeDubReplay(opts);
    });
};
