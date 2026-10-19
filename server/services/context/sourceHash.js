import { createHash } from "node:crypto";
import { modelHistory } from "./history.js";

export function sourceHash(messages) {
  return createHash("sha256")
    .update(JSON.stringify(modelHistory({ messages })))
    .digest("hex");
}
