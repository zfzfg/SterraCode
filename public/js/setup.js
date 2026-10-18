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
    status.setupRequired ? "SterraCode einrichten" : "Bei SterraCode anmelden",
  );
  heading.id = "access-heading";
  form.append(
    heading,
    node(
      "p",
      "muted",
      status.setupRequired
        ? "Gib den einmaligen Schlüssel aus dem Installer ein und lege dein Administratorpasswort fest."
        : "Melde dich mit dem Administratorpasswort dieses Servers an.",
    ),
  );
  function field(label, name, autocomplete) {
    const wrapper = node("label", "field", label);
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
    ? field("Einrichtungsschlüssel", "setupKey", "off")
    : null;
  const password = field(
    "Administratorpasswort",
    "password",
    status.setupRequired ? "new-password" : "current-password",
  );
  password.maxLength = 1024;
  if (status.setupRequired) password.minLength = 12;
  const confirmation = status.setupRequired
    ? field("Passwort wiederholen", "confirmation", "new-password")
    : null;
  const error = node("p", "form-error");
  error.setAttribute("role", "alert");
  const submit = node(
    "button",
    "primary",
    status.setupRequired ? "Einrichtung abschließen" : "Anmelden",
  );
  submit.type = "submit";
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
        error.textContent = "Die Passwörter stimmen nicht überein.";
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
    title: "Administratorpasswort ändern",
    description:
      "Nach dem Passwortwechsel werden alle bisherigen Anmeldungen beendet.",
    fields: [
      {
        name: "currentPassword",
        label: "Bisheriges Passwort",
        type: "password",
        required: true,
      },
      {
        name: "password",
        label: "Neues Passwort (mindestens 12 Zeichen)",
        type: "password",
        required: true,
      },
      {
        name: "confirmation",
        label: "Neues Passwort wiederholen",
        type: "password",
        required: true,
      },
    ],
    onSave: async ({ currentPassword, password, confirmation }) => {
      if (password !== confirmation)
        throw new Error("Die Passwörter stimmen nicht überein.");
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
    title: "KI verbinden",
    description:
      "LM Studio kann auf jedem vom Server erreichbaren Rechner laufen, auch über eine externe HTTPS-Adresse. Alternativ kannst du die OpenAI API verwenden. Ohne Modell kannst du Sessions, Dateien und Programme verwenden.",
    submit: "Speichern und Verbindung prüfen",
    fields: [
      {
        name: "provider",
        label: "KI-Anbieter",
        type: "select",
        value: settings.provider || "lmstudio",
        options: [
          { value: "lmstudio", label: "LM Studio" },
          { value: "openai", label: "OpenAI API" },
        ],
      },
      {
        name: "lmStudioUrl",
        label: "LM-Studio-URL",
        value: settings.lmStudioUrl,
        help: "Für LM Studio erforderlich. Bei OpenAI wird die bisherige LM-Studio-Adresse beibehalten.",
      },
      {
        name: "openAIModel",
        label: "OpenAI-Modell-ID",
        value: settings.openAIModel || "",
      },
      {
        name: "apiKey",
        label: "OpenAI-API-Schlüssel (optional)",
        type: "password",
        value: "",
        disabled: metadata.openai?.source === "file",
        autocomplete: "off",
        maxLength: 2048,
        help: "Wird auf dem Server geschützt gespeichert und nie wieder angezeigt.",
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
            ? "Verbindung steht. Bitte ein Modell auswählen."
            : "KI-Verbindung ist bereit."
          : result.error ||
              "Verbindung gespeichert; der KI-Dienst ist zurzeit nicht erreichbar.",
        result.connected ? "info" : "error",
      );
    },
  });
}

export async function openCredentials() {
  const metadata = await api("/api/provider/credentials");
  const external = metadata.openai?.source === "file";
  await formDialog({
    title: "KI-Zugangsdaten",
    submit: external ? "Schließen" : "Speichern",
    description: metadata.openai?.configured
      ? `Ein OpenAI-Schlüssel ist eingerichtet (${metadata.openai.source === "file" ? "Secret-Datei" : "Serverdaten"}). Leer lassen erhält ihn. Für LM-Studio-Authentifizierung wird die Token-Secret-Datei am Server eingerichtet.`
      : "Ein OpenAI-Schlüssel wird auf dem Server separat von den Einstellungen gespeichert. Für LM-Studio-Authentifizierung wird die Token-Secret-Datei am Server eingerichtet.",
    fields: [
      {
        name: "apiKey",
        label: "Neuer OpenAI-API-Schlüssel",
        type: "password",
        value: "",
        maxLength: 2048,
        autocomplete: "off",
        disabled: external,
      },
      {
        name: "clear",
        label: "Gespeicherten OpenAI-Schlüssel entfernen",
        type: "checkbox",
        value: false,
        disabled: external,
      },
    ],
    onSave: async ({ apiKey, clear }) => {
      if (apiKey.trim() && clear)
        throw new Error(
          "Bitte entweder einen Schlüssel setzen oder den gespeicherten Schlüssel entfernen.",
        );
      if (apiKey.trim() || clear)
        await api("/api/provider/credentials", {
          method: "PATCH",
          body: { provider: "openai", apiKey: clear ? null : apiKey.trim() },
        });
    },
  });
}
