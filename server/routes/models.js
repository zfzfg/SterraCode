import express from "express";
import { getSettings } from "../services/storage.js";
import { route } from "./helpers.js";
const router = express.Router();
router.get(
  "/",
  route(async (req, res) => {
    const settings = await getSettings();
    try {
      const response = await fetch(`${settings.lmStudioUrl}/v1/models`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const models = (data.data || []).map((m) => ({ id: m.id, name: m.id }));
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
        error: `LM Studio ist nicht erreichbar (${error.message}). Server in LM Studio starten und URL prüfen.`,
      });
    }
  }),
);
export default router;
