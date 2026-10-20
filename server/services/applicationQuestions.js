import { randomUUID } from "node:crypto";
import { normalizeLocale } from "../../shared/i18n/locale.js";
import { t } from "./i18n.js";

const templates = {
  onboarding: ["create_plan", "start_directly"],
  "plan-completed": ["continue_plan", "finish_today"],
};

// These saved strings are canonical transcript data. Only the presentation of
// a recognised application question may follow a different browser locale.
export function materializeApplicationQuestion(template, locale) {
  const optionIds = Object.hasOwn(templates, template)
    ? templates[template]
    : null;
  if (!optionIds) throw new TypeError("Unknown application question template");
  locale = normalizeLocale(locale);
  return {
    type: "ask_question",
    questionId: randomUUID(),
    questionType: "multiple-choice",
    question: t(locale, `learningContent:questions.${template}.question`),
    options: optionIds.map((id) =>
      t(locale, `learningContent:questions.${template}.options.${id}`),
    ),
    optionIds: [...optionIds],
    application: { version: 1, template, locale },
    ...(template === "onboarding" ? { onboarding: true } : {}),
  };
}

export function applicationOption(event, optionId) {
  const template = event.application?.template;
  const expected = Object.hasOwn(templates, template)
    ? templates[template]
    : null;
  if (
    event.application?.version !== 1 ||
    !expected ||
    !expected.includes(optionId) ||
    !Array.isArray(event.optionIds) ||
    !Array.isArray(event.options)
  )
    return null;
  const index = event.optionIds.indexOf(optionId);
  return index >= 0 && typeof event.options[index] === "string"
    ? event.options[index]
    : null;
}
