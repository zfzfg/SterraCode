import { createHash } from "node:crypto";
import { modelHistory } from "./history.js";

export function sourceHash(messages, options) {
  return createHash("sha256")
    .update(JSON.stringify(modelHistory({ messages }, options)))
    .digest("hex");
}
