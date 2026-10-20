// Process reasons are machine IDs. Their display metadata never replaces them.
const reasonKeys = Object.freeze({
  timeout: "serverFeature:reason.timeout",
  output_limit: "serverFeature:reason.outputLimit",
  stopped: "serverFeature:reason.stopped",
  runner_restarted: "serverFeature:reason.runnerRestarted",
  resource_limit_or_sigkill: "serverFeature:reason.resourceLimit",
  process_unavailable: "serverFeature:reason.processUnavailable",
  connection_lost: "serverFeature:reason.connectionLost",
  start_failed: "serverFeature:reason.startFailed",
  invalid_trace: "serverFeature:reason.invalidTrace",
  incomplete_trace: "serverFeature:reason.incompleteTrace",
  event_limit: "serverFeature:reason.eventLimit",
  trace_size_limit: "serverFeature:reason.traceSizeLimit",
  completed: "serverFeature:reason.completed",
  program_error: "serverFeature:reason.programError",
});
export function reasonMetadata(reason, fallbackKey, fallbackParams = {}) {
  if (!reason) return {};
  const key = Object.hasOwn(reasonKeys, reason)
    ? reasonKeys[reason]
    : fallbackKey;
  return key
    ? {
        reasonKey: key,
        reasonParams: key === fallbackKey ? fallbackParams : {},
      }
    : {};
}
export function describeProcess(value) {
  return {
    ...value,
    ...reasonMetadata(value.reason, value.errorKey, value.errorParams),
  };
}
