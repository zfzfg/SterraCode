import express from "express";
import { route } from "./helpers.js";
import { getSettings, AppError } from "../services/storage.js";
import {
  getProfile,
  configureProfile,
  selfAssess,
  resetProfile,
  importHistoricalSessions,
  displayProfileContext,
  deriveProfile,
} from "../services/profileManager.js";
import { startReview, reviewResult } from "../services/learningReviews.js";

const router = express.Router();
const displayProfileView = (profile, locale) =>
  deriveProfile(profile, undefined, locale);
router.get(
  "/",
  route(async (req, res) => {
    if (!(await getSettings()).crossChatProfileEnabled)
      return res.json({ enabled: false });
    const profile = await getProfile(req.uiLocale);
    res.json({
      enabled: true,
      ...profile,
      tutorContext: displayProfileContext(profile, req.uiLocale),
    });
  }),
);
router.get(
  "/reviews",
  route(async (req, res) =>
    res.json(
      (await getSettings()).crossChatProfileEnabled
        ? (await getProfile(req.uiLocale)).reviews
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
  route(async (req, res) =>
    res.json(
      displayProfileView(await configureProfile(req.body), req.uiLocale),
    ),
  ),
);
router.delete(
  "/",
  route(async (req, res) => {
    if (req.body.confirm !== true)
      throw new AppError(
        "Löschen muss ausdrücklich bestätigt werden.",
        undefined,
        undefined,
        { messageKey: "serverFeature:profile.confirmDelete", params: {} },
      );
    res.json(displayProfileView(await resetProfile(), req.uiLocale));
  }),
);
router.post(
  "/import-history",
  route(async (req, res) => {
    if (req.body.confirm !== true)
      throw new AppError(
        "Historische Übernahme muss bestätigt werden.",
        undefined,
        undefined,
        { messageKey: "serverFeature:profile.confirmHistory", params: {} },
      );
    res.json(
      displayProfileView(await importHistoricalSessions(), req.uiLocale),
    );
  }),
);
router.post(
  "/concepts/:conceptId/self-assessments",
  route(async (req, res) =>
    res.json(
      displayProfileView(
        await selfAssess(req.params.conceptId, req.body),
        req.uiLocale,
      ),
    ),
  ),
);
router.post(
  "/reviews/:reviewId/start",
  route(async (req, res) =>
    res.json(
      await startReview(req.params.reviewId, {
        tutorLocale: req.body.tutorLocale ?? req.uiLocale,
      }),
    ),
  ),
);
router.post(
  "/reviews/:reviewId/results",
  route(async (req, res) =>
    res.json(
      displayProfileView(
        await reviewResult(req.params.reviewId, req.body),
        req.uiLocale,
      ),
    ),
  ),
);
export default router;
