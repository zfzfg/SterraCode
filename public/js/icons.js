const names = new Set([
  "orbit",
  "menu",
  "settings",
  "plus",
  "file",
  "folder",
  "chevron",
  "play",
  "stop",
  "close",
  "check",
  "undo",
  "trash",
  "edit",
  "send",
  "terminal",
  "bulb",
  "question",
  "plan",
  "chat",
  "refresh",
  "thumb-up",
  "thumb-down",
  "warning",
  "save",
]);
export function createIcon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute(
    "href",
    `/assets/icons.svg#${names.has(name) ? name : "file"}`,
  );
  svg.append(use);
  return svg;
}
export function button(label, icon, action, className = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.title = label;
  node.setAttribute("aria-label", label);
  if (icon) node.append(createIcon(icon));
  if (!className.includes("icon-only"))
    node.append(document.createTextNode(label));
  if (action)
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      try {
        Promise.resolve(action(event)).catch((error) =>
          window.dispatchEvent(new CustomEvent("app-error", { detail: error })),
        );
      } catch (error) {
        window.dispatchEvent(new CustomEvent("app-error", { detail: error }));
      }
    });
  return node;
}
