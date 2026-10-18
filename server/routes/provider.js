import express from "express";
import { route } from "./helpers.js";
import { getSettings } from "../services/storage.js";
import {
  getProviderCredentials,
  updateProviderCredentials,
} from "../services/providerCredentials.js";
import { testOpenAIConnection } from "../services/openAI.js";
import { testLMStudioConnection } from "../services/lmStudio.js";
const router = express.Router();
router.get(
  "/credentials",
  route(async (req, res) => res.json(await getProviderCredentials())),
);
router.patch(
  "/credentials",
  route(async (req, res) =>
    res.json(await updateProviderCredentials(req.body)),
  ),
);
router.post(
  "/test",
  route(async (req, res) => {
    const settings = await getSettings();
    res.json(
      await (settings.provider === "openai"
        ? testOpenAIConnection(settings)
        : testLMStudioConnection(settings)),
    );
  }),
);
export default router;
