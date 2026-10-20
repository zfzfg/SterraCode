import { t } from "./i18n.js";
import { reasonMetadata } from "./processReasons.js";

// These serializers accept only explicitly owned message fields. User text,
// source code, terminal output and opaque provider data are never traversed.
export function localizeFields(
  value,
  locale,
  fields = ["error", "warning", "reason", "limitations", "message"],
) {
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  for (const field of fields) {
    const key = field === "message" ? value.messageKey : value[`${field}Key`];
    const params = field === "message" ? value.params : value[`${field}Params`];
    if (key) result[field] = t(locale, key, params);
  }
  return result;
}
export function localizeProcess(value, locale) {
  const result = localizeFields(
    {
      ...value,
      ...reasonMetadata(value.reason, value.errorKey, value.errorParams),
    },
    locale,
    ["error"],
  );
  if (value.systemMessages)
    result.systemMessages = value.systemMessages.map((item) =>
      localizeFields(item, locale, ["message"]),
    );
  if (value.testResults)
    result.testResults = value.testResults.map((item) =>
      localizeFields(item, locale, ["message"]),
    );
  return result;
}
export function localizeRun(value, locale) {
  const result = localizeFields(
    {
      ...value,
      ...reasonMetadata(value.reason, value.errorKey, value.errorParams),
    },
    locale,
    ["error", "limitations"],
  );
  if (value.programError?.messageKey)
    result.programError = {
      ...value.programError,
      displayMessage: t(
        locale,
        value.programError.messageKey,
        value.programError.params,
      ),
    };
  if (value.cases)
    result.cases = value.cases.map((item) =>
      localizeFields(item, locale, ["message"]),
    );
  if (value.runtime?.versionKey)
    result.runtime = {
      ...value.runtime,
      version: t(locale, value.runtime.versionKey, value.runtime.versionParams),
    };
  return result;
}
export function localizePreview(value, locale) {
  return {
    ...value,
    diagnostics: value.diagnostics.map((item) =>
      localizeFields(item, locale, ["message"]),
    ),
  };
}
export function localizeProgramJob(value, locale) {
  if (!value) return value;
  const result = localizeFields(value, locale, ["error"]);
  if (value.progressMessage?.key) {
    result.progress = t(
      locale,
      value.progressMessage.key,
      value.progressMessage.params,
    );
  }
  if (value.blockingJobs)
    result.blockingJobs = value.blockingJobs.map((job) =>
      localizeProcess(job, locale),
    );
  return result;
}
export function localizeProgramStatus(value, locale) {
  return {
    ...value,
    programs: value.programs.map((program) =>
      localizeFields(program, locale, ["error", "description"]),
    ),
    activeJob: localizeProgramJob(value.activeJob, locale),
    latestJob: localizeProgramJob(value.latestJob, locale),
  };
}
export function localizeRunnerStatus(value, locale) {
  const result = localizeFields(value, locale, ["error"]);
  if (value.error && typeof value.error === "object")
    result.error = localizeFields(value.error, locale, ["message"]);
  if (value.activeJobs)
    result.activeJobs = value.activeJobs.map((job) =>
      localizeProcess(job, locale),
    );
  return result;
}
export function localizeProposal(value, locale) {
  return value.hunks
    ? {
        ...value,
        hunks: value.hunks.map((hunk) =>
          localizeFields(hunk, locale, ["summary"]),
        ),
      }
    : value;
}
function localizeTraceValue(value, locale) {
  return value?.valueMessage?.key
    ? {
        ...value,
        displayValue: t(
          locale,
          value.valueMessage.key,
          value.valueMessage.params,
        ),
      }
    : value;
}
export function localizeTracePage(value, locale) {
  const locals = (values) =>
    Object.fromEntries(
      Object.entries(values || {}).map(([name, item]) => [
        name,
        localizeTraceValue(item, locale),
      ]),
    );
  const objectView = (object) =>
    !object || !Array.isArray(object.items)
      ? object
      : {
          ...object,
          items: object.items.map((item) =>
            Array.isArray(item)
              ? item.map((entry) => localizeTraceValue(entry, locale))
              : localizeTraceValue(item, locale),
          ),
        };
  return {
    ...value,
    events: value.events.map((event) => ({
      ...event,
      ...(event.locals ? { locals: locals(event.locals) } : {}),
      ...(event.stack
        ? {
            stack: event.stack.map((frame) => ({
              ...frame,
              locals: locals(frame.locals),
            })),
          }
        : {}),
      ...(event.objects
        ? {
            objects: Object.fromEntries(
              Object.entries(event.objects).map(([id, object]) => [
                id,
                objectView(object),
              ]),
            ),
          }
        : {}),
      ...(event.returnValue
        ? { returnValue: localizeTraceValue(event.returnValue, locale) }
        : {}),
      ...(event.exception?.messageKey
        ? {
            exception: {
              ...event.exception,
              displayMessage: t(
                locale,
                event.exception.messageKey,
                event.exception.params,
              ),
            },
          }
        : {}),
    })),
  };
}
export function localizeTeacherResult(value, locale) {
  return {
    ...value,
    ...(value.turn
      ? { turn: localizeFields(value.turn, locale, ["error"]) }
      : {}),
    ...(value.contextUsage
      ? { contextUsage: localizeFields(value.contextUsage, locale, ["error"]) }
      : {}),
  };
}
