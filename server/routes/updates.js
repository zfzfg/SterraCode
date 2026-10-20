import express from "express";
import { route } from "./helpers.js";
export function createUpdatesRouter(service) {
  const router = express.Router();
  router.get(
    "/",
    route(async (req, res) => res.json(await service.get())),
  );
  router.post(
    "/check",
    route(async (req, res) => res.json(await service.check())),
  );
  router.post(
    "/install",
    route(async (req, res) => res.status(202).json(await service.install())),
  );
  router.patch(
    "/settings",
    route(async (req, res) => res.json(await service.settings(req.body))),
  );
  router.post(
    "/activity",
    route(async (req, res) => res.json(await service.activity(req.body))),
  );
  return router;
}
