import express from "express";
import { route } from "./helpers.js";
import { getSettings, AppError } from "../services/storage.js";
import {
  getProfile,
  configureProfile,
  selfAssess,
  resetProfile,
  importHistoricalSessions,
  profileToPromptText,
} from "../services/profileManager.js";
import { startReview, reviewResult } from "../services/learningReviews.js";

const router = express.Router();
router.get(
  "/",
  route(async (req, res) => {
    if (!(await getSettings()).crossChatProfileEnabled)
      return res.json({ enabled: false });
    const profile = await getProfile();
    res.json({
      enabled: true,
      ...profile,
      tutorContext: profileToPromptText(profile),
    });
  }),
);
router.get(
  "/reviews",
  route(async (req, res) =>
    res.json(
      (await getSettings()).crossChatProfileEnabled
        ? (await getProfile()).reviews
        : [],
    ),
  ),
);
router.get(
  "/export",
  route(async (req, res) => {
    // Explicit export remains available while collection is disabled.
    res
      .set(
        "Content-Disposition",
        'attachment; filename="sterracode-lernprofil.json"',
      )
      .json(await getProfile());
  }),
);
router.patch(
  "/",
  route(async (req, res) => res.json(await configureProfile(req.body))),
);
router.delete(
  "/",
  route(async (req, res) => {
    if (req.body.confirm !== true)
      throw new AppError("Löschen muss ausdrücklich bestätigt werden.");
    res.json(await resetProfile());
  }),
);
router.post(
  "/import-history",
  route(async (req, res) => {
    if (req.body.confirm !== true)
      throw new AppError("Historische Übernahme muss bestätigt werden.");
    res.json(await importHistoricalSessions());
  }),
);
router.post(
  "/concepts/:conceptId/self-assessments",
  route(async (req, res) =>
    res.json(await selfAssess(req.params.conceptId, req.body)),
  ),
);
router.post(
  "/reviews/:reviewId/start",
  route(async (req, res) => res.json(await startReview(req.params.reviewId))),
);
router.post(
  "/reviews/:reviewId/results",
  route(async (req, res) =>
    res.json(await reviewResult(req.params.reviewId, req.body)),
  ),
);
export default router;
