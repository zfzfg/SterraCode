import express from "express";
import { route } from "./helpers.js";
import { listProjectTemplates, importProject } from "../services/projects.js";
const router = express.Router();
router.get(
  "/templates",
  route(async (req, res) => res.json(listProjectTemplates())),
);
router.post(
  "/import",
  route(async (req, res) =>
    res.status(201).json(await importProject(req.body)),
  ),
);
export default router;
