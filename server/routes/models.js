import express from "express";
import { getSettings } from "../services/storage.js";
import { route } from "./helpers.js";
import { listModelOptions } from "../services/lmStudio.js";
const router = express.Router();
router.get(
  "/",
  route(async (req, res) => {
    const settings = await getSettings();
    if (["openai", "lmstudio"].includes(req.query.provider))
      settings.provider = req.query.provider;
    try {
      const models = await listModelOptions(settings);
      res.json({
        models,
        connected: true,
        status: models.length ? "ready" : "no-model",
      });
    } catch (error) {
      res.json({
        models: [],
        connected: false,
        status: "offline",
        error:
          settings.provider === "openai"
            ? "OpenAI ist nicht erreichbar. API-Schlüssel, Internetzugang und Berechtigung prüfen."
            : "LM Studio ist nicht erreichbar. Server in LM Studio starten, URL und Secret-Datei prüfen.",
      });
    }
  }),
);
export default router;
