import { t } from "./i18n.js";
import { createIcon, button } from "./icons.js";
export const $ = (id) => document.getElementById(id);
export function node(tag, className = "", text) {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
export function toast(message, type = "info") {
  const n = node("div", `toast ${type}`);
  n.setAttribute("role", type === "error" ? "alert" : "status");
  n.append(
    createIcon(type === "error" ? "warning" : "check"),
    node("span", "", message),
    button(t("common:actions.close"), "close", () => n.remove(), "icon-only"),
  );
  $("toasts").append(n);
  if (type !== "error") setTimeout(() => n.remove(), 6000);
}
window.addEventListener("app-error", (event) =>
  toast(event.detail.message || String(event.detail), "error"),
);
export function setButton(id, label, icon) {
  const b = $(id);
  b.replaceChildren(createIcon(icon), document.createTextNode(label));
  b.title = label;
  b.setAttribute("aria-label", label);
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event("theme-changed"));
}
export function formDialog({
  title,
  description = "",
  fields = [],
  submit = t("common:actions.save"),
  danger = false,
  onPreview,
  onSave,
  actions = [],
}) {
  const dialog = $("app-dialog");
  if (dialog.open) return Promise.reject(new Error(t("common:dialog.open")));
  return new Promise((resolve) => {
    const form = node("form", "dialog-form");
    form.method = "dialog";
    const heading = node("h2", "", title);
    heading.id = "dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const head = node("div", "dialog-heading");
    head.append(
      heading,
      button(
        t("common:actions.close"),
        "close",
        () => dialog.close(),
        "icon-only",
      ),
    );
    form.append(head);
    if (description) form.append(node("p", "muted", description));
    if (actions.length) {
      const navigation = node("div", "settings-navigation");
      for (const action of actions)
        navigation.append(
          button(action.label, null, () => {
            action.onClick();
            dialog.close();
          }),
        );
      form.append(navigation);
    }
    const controls = new Map(),
      advanced = node("details", "advanced"),
      advancedBody = node("div", "form-fields");
    advanced.append(
      node("summary", "", t("common:dialog.advanced")),
      advancedBody,
    );
    const basic = node("div", "form-fields");
    form.append(basic);
    let hasAdvanced = false;
    for (const field of fields) {
      const label = node(
        "label",
        field.type === "checkbox" ? "checkbox-label" : "field",
      );
      label.append(node("span", "", field.label));
      let input;
      if (field.type === "select") {
        input = node("select");
        for (const option of field.options) {
          const opt = node("option", "", option.label ?? option);
          opt.value = option.value ?? option;
          input.append(opt);
        }
      } else input = node(field.type === "textarea" ? "textarea" : "input");
      if (input.tagName === "INPUT") input.type = field.type || "text";
      input.id = `field-${field.name}`;
      label.htmlFor = input.id;
      input.name = field.name;
      input.setAttribute("aria-label", field.label);
      if (field.type === "checkbox") input.checked = Boolean(field.value);
      else
        input.value =
          field.value ??
          (input.tagName === "SELECT" ? input.options[0]?.value || "" : "");
      if (field.type === "textarea") input.rows = field.rows || 4;
      for (const key of [
        "min",
        "max",
        "step",
        "maxLength",
        "required",
        "readOnly",
        "disabled",
        "autocomplete",
        "placeholder",
      ])
        if (field[key] !== undefined) input[key] = field[key];
      if (field.type === "checkbox") label.prepend(input);
      else label.append(input);
      if (field.help) label.append(node("small", "muted", field.help));
      (field.advanced ? advancedBody : basic).append(label);
      hasAdvanced ||= field.advanced;
      controls.set(field.name, { input, field });
      input.addEventListener("input", () => input.setCustomValidity(""));
      input.addEventListener("invalid", () => {
        input.setCustomValidity(
          input.validity.valueMissing
            ? t("common:validation.required")
            : input.validity.tooShort
              ? t("common:validation.minimum", { count: input.minLength })
              : input.validity.rangeUnderflow ||
                  input.validity.rangeOverflow ||
                  input.validity.stepMismatch ||
                  input.validity.typeMismatch ||
                  input.validity.badInput
                ? t("common:validation.invalid")
                : "",
        );
      });
      input.addEventListener("input", () => onPreview?.(values()));
    }
    function values() {
      const result = {};
      for (const [name, { input, field }] of controls)
        result[name] =
          field.type === "checkbox"
            ? input.checked
            : field.type === "number"
              ? Number(input.value)
              : input.value;
      return result;
    }
    if (hasAdvanced) form.append(advanced);
    const error = node("p", "form-error");
    error.setAttribute("role", "alert");
    form.append(error);
    const footer = node("div", "dialog-footer"),
      cancel = button(t("common:actions.cancel"), null, () => dialog.close()),
      save = button(submit, null, null, danger ? "danger" : "primary");
    save.type = "submit";
    footer.append(cancel, save);
    form.append(footer);
    let result = null,
      saving = false;
    const preventCancel = (event) => {
      if (saving) event.preventDefault();
    };
    dialog.addEventListener("cancel", preventCancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      saving = true;
      for (const control of form.querySelectorAll("button"))
        control.disabled = true;
      try {
        result = values();
        if (onSave) await onSave(result);
        dialog.close("saved");
      } catch (e) {
        result = null;
        error.textContent = e.message;
      } finally {
        saving = false;
        for (const control of form.querySelectorAll("button"))
          control.disabled = false;
      }
    });
    dialog.replaceChildren(form);
    dialog.addEventListener(
      "close",
      () => {
        for (const { input, field } of controls.values())
          if (field.type === "password") input.value = "";
        dialog.removeEventListener("cancel", preventCancel);
        resolve(result);
      },
      { once: true },
    );
    dialog.showModal();
    (controls.values().next().value?.input || cancel).focus();
  });
}
export async function confirmDialog(title, description) {
  return Boolean(
    await formDialog({
      title,
      description,
      submit: t("common:actions.confirm"),
      danger: true,
    }),
  );
}
export function markdown(text) {
  const container = node("div", "markdown");
  const lines = String(text || "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .split("\n");
  let code = null,
    list = null;
  function inline(parent, value) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let start = 0;
    for (const match of value.matchAll(pattern)) {
      parent.append(document.createTextNode(value.slice(start, match.index)));
      const raw = match[0];
      parent.append(
        node(
          raw.startsWith("`") ? "code" : "strong",
          "",
          raw.slice(raw.startsWith("`") ? 1 : 2, raw.startsWith("`") ? -1 : -2),
        ),
      );
      start = match.index + raw.length;
    }
    parent.append(document.createTextNode(value.slice(start)));
  }
  for (const line of lines) {
    if (line.startsWith("```")) {
      list = null;
      if (code) {
        code = null;
      } else {
        const pre = node("pre");
        code = node("code");
        pre.append(code);
        container.append(pre);
      }
      continue;
    }
    if (code) {
      code.append(document.createTextNode(line + "\n"));
      continue;
    }
    if (!line.trim()) {
      list = null;
      continue;
    }
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
    if (item) {
      if (!list) {
        list = node(/^\s*\d/.test(line) ? "ol" : "ul");
        container.append(list);
      }
      const li = node("li");
      inline(li, item[1]);
      list.append(li);
      continue;
    }
    list = null;
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    const p = node(heading ? "h3" : "p");
    inline(p, heading ? heading[2] : line);
    container.append(p);
  }
  return container;
}
