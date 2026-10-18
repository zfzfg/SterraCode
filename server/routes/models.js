import express from "express";
import { getSettings } from "../services/storage.js";
import { route } from "./helpers.js";
import { listLoadedModels } from "../services/lmStudio.js";
const router = express.Router();
router.get(
  "/",
  route(async (req, res) => {
    const settings = await getSettings();
    try {
      const models = (await listLoadedModels(settings)).map((m) => ({
        id: m.identifier,
        name: m.displayName || m.identifier,
      }));
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
