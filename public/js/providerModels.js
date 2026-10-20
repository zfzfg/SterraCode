import { t } from "./i18n.js";
import { api } from "./api.js";

export async function openAIModelOptions(selected = "") {
  const { models, connected } = await api("/api/models?provider=openai");
  const options = [
    {
      value: "",
      label: connected
        ? t("features:providerModels.choose")
        : t("features:providerModels.connect"),
    },
    ...models.map((model) => ({ value: model.id, label: model.name })),
  ];
  if (selected && !models.some((model) => model.id === selected))
    options.push({
      value: selected,
      label: t("features:providerModels.unavailable", { p1: selected }),
    });
  return options;
}
