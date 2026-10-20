import { t, localeSelector, translateDOM } from "./i18n.js";
import { openAIModelOptions } from "./providerModels.js";
import { api } from "./api.js";
import { $, node, formDialog, toast } from "./ui.js";

let pending;
export function ensureAccess() {
  if (pending) return pending;
  pending = authenticate().finally(() => {
    pending = null;
  });
  return pending;
}
async function authenticate() {
  const status = await api("/api/setup/status");
  if (!status.authRequired || status.authenticated)
    return { created: false, authRequired: status.authRequired };
  const dialog = node("dialog", "access-dialog");
  dialog.setAttribute("aria-labelledby", "access-heading");
  const form = node("form", "dialog-form");
  const heading = node(
    "h1",
    "",
    status.setupRequired ? t("auth:setup.title") : t("auth:login.title"),
  );
  heading.id = "access-heading";
  heading.dataset.i18n = status.setupRequired
    ? "auth:setup.title"
    : "auth:login.title";
  form.append(
    heading,
    node(
      "p",
      "muted",
      status.setupRequired
        ? t("auth:setup.description")
        : t("auth:login.description"),
    ),
  );
  function field(label, name, autocomplete) {
    const wrapper = node("label", "field");
    const caption = node("span", "", label);
    caption.dataset.i18n =
      name === "setupKey"
        ? "auth:setup.key"
        : name === "confirmation"
          ? "auth:password.repeat"
          : "auth:password.label";
    wrapper.append(caption);
    const input = node("input");
    input.type = "password";
    input.name = name;
    input.required = true;
    input.autocomplete = autocomplete;
    wrapper.append(input);
    form.append(wrapper);
    return input;
  }
  const key = status.setupRequired
    ? field(t("auth:setup.key"), "setupKey", "off")
    : null;
  const password = field(
    t("auth:password.label"),
    "password",
    status.setupRequired ? "new-password" : "current-password",
  );
  password.maxLength = 1024;
  if (status.setupRequired) password.minLength = 12;
  const confirmation = status.setupRequired
    ? field(t("auth:password.repeat"), "confirmation", "new-password")
    : null;
  const error = node("p", "form-error");
  error.setAttribute("role", "alert");
  const submit = node(
    "button",
    "primary",
    status.setupRequired ? t("auth:setup.submit") : t("auth:login.submit"),
  );
  submit.type = "submit";
  submit.dataset.i18n = status.setupRequired
    ? "auth:setup.submit"
    : "auth:login.submit";
  const description = form.querySelector("p");
  description.dataset.i18n = status.setupRequired
    ? "auth:setup.description"
    : "auth:login.description";
  form.prepend(localeSelector());
  const updateLocale = () => {
    translateDOM(dialog);
    error.textContent = "";
  };
  window.addEventListener("locale-changed", updateLocale);
  for (const input of [key, password, confirmation].filter(Boolean)) {
    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("invalid", () =>
      input.setCustomValidity(
        input.validity.valueMissing
          ? t("common:validation.required")
          : input.validity.tooShort
            ? t("common:validation.minimum", { count: input.minLength })
            : "",
      ),
    );
  }
  form.append(error, submit);
  dialog.append(form);
  document.body.append(dialog);
  $("app").inert = true;
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.showModal();
  (key || password).focus();
  return new Promise((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (confirmation && confirmation.value !== password.value) {
        error.textContent = t("auth:password.mismatch");
        return;
      }
      submit.disabled = true;
      try {
        await api(status.setupRequired ? "/api/setup" : "/api/login", {
          method: "POST",
          body: {
            ...(key ? { setupKey: key.value.trim() } : {}),
            password: password.value,
          },
        });
        password.value = "";
        if (key) key.value = "";
        if (confirmation) confirmation.value = "";
        dialog.close();
        dialog.remove();
        window.removeEventListener("locale-changed", updateLocale);
        $("app").inert = false;
        resolve({ created: status.setupRequired, authRequired: true });
      } catch (reason) {
        error.textContent = reason.message;
      } finally {
        submit.disabled = false;
      }
    });
  });
}

export async function changePassword() {
  await formDialog({
    title: t("auth:password.change"),
    description: t("auth:password.sessions"),
    fields: [
      {
        name: "currentPassword",
        label: t("auth:password.current"),
        type: "password",
        required: true,
      },
      {
        name: "password",
        label: t("auth:password.new"),
        type: "password",
        required: true,
      },
      {
        name: "confirmation",
        label: t("auth:password.newRepeat"),
        type: "password",
        required: true,
      },
    ],
    onSave: async ({ currentPassword, password, confirmation }) => {
      if (password !== confirmation)
        throw new Error(t("auth:password.mismatch"));
      await api("/api/auth/password", {
        method: "PATCH",
        body: { currentPassword, password },
      });
    },
  });
}

export async function configureModel() {
  const settings = await api("/api/chat/settings");
  const metadata = await api("/api/provider/credentials");
  await formDialog({
    title: t("auth:model.connect"),
    description: t("auth:model.description"),
    submit: t("auth:model.saveTest"),
    fields: [
      {
        name: "provider",
        label: t("auth:model.provider"),
        type: "select",
        value: settings.provider || "lmstudio",
        options: [
          { value: "lmstudio", label: "LM Studio" },
          { value: "openai", label: "OpenAI API" },
        ],
      },
      {
        name: "lmStudioUrl",
        label: t("auth:model.lmUrl"),
        value: settings.lmStudioUrl,
        help: t("auth:model.lmHelp"),
      },
      {
        name: "openAIModel",
        label: t("auth:model.openai"),
        type: "select",
        options: await openAIModelOptions(settings.openAIModel),
        value: settings.openAIModel || "",
        help: t("auth:model.openaiHelp"),
      },
      {
        name: "apiKey",
        label: t("auth:credentials.optional"),
        type: "password",
        value: "",
        disabled: metadata.openai?.source === "file",
        autocomplete: "off",
        maxLength: 2048,
        help: t("auth:credentials.protected"),
      },
    ],
    onSave: async ({ provider, lmStudioUrl, openAIModel, apiKey }) => {
      if (apiKey.trim())
        await api("/api/provider/credentials", {
          method: "PATCH",
          body: { provider: "openai", apiKey: apiKey.trim() },
        });
      await api("/api/chat/settings", {
        method: "PATCH",
        body: {
          provider,
          lmStudioUrl:
            provider === "openai" ? settings.lmStudioUrl : lmStudioUrl,
          openAIModel: openAIModel.trim(),
        },
      });
      const result = await api("/api/provider/test", {
        method: "POST",
        body: {},
      });
      toast(
        result.connected
          ? result.status === "no-model"
            ? t("auth:model.select")
            : t("auth:model.ready")
          : result.error || t("auth:model.unavailable"),
        result.connected ? "info" : "error",
      );
    },
  });
}

export async function openCredentials() {
  const metadata = await api("/api/provider/credentials");
  const external = metadata.openai?.source === "file";
  await formDialog({
    title: t("auth:credentials.title"),
    submit: external ? t("common:actions.close") : t("common:actions.save"),
    description: metadata.openai?.configured
      ? t("auth:credentials.exists", {
          source:
            metadata.openai.source === "file"
              ? t("auth:credentials.file")
              : t("auth:credentials.server"),
        })
      : t("auth:credentials.description"),
    fields: [
      {
        name: "apiKey",
        label: t("auth:credentials.new"),
        type: "password",
        value: "",
        maxLength: 2048,
        autocomplete: "off",
        disabled: external,
      },
      {
        name: "clear",
        label: t("auth:credentials.remove"),
        type: "checkbox",
        value: false,
        disabled: external,
      },
    ],
    onSave: async ({ apiKey, clear }) => {
      if (apiKey.trim() && clear) throw new Error(t("auth:credentials.choose"));
      if (apiKey.trim() || clear)
        await api("/api/provider/credentials", {
          method: "PATCH",
          body: { provider: "openai", apiKey: clear ? null : apiKey.trim() },
        });
    },
  });
}
