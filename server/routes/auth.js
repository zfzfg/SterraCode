import express from "express";
import { route } from "./helpers.js";
import { SESSION_COOKIE, sessionToken } from "../services/auth.js";

const cookieOptions = (config) => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.secureCookies,
  path: "/",
  maxAge: 14 * 86400000,
});
export function createAuthRouter(config, auth) {
  const router = express.Router();
  const issue = (res, token) =>
    res.cookie(SESSION_COOKIE, token, cookieOptions(config));
  router.get(
    "/setup/status",
    route(async (req, res) =>
      res.json({
        authRequired: config.authRequired,
        setupRequired:
          config.authRequired && (await auth.status()).setupRequired,
        authenticated:
          !config.authRequired || (await auth.authenticate(sessionToken(req))),
      }),
    ),
  );
  for (const [endpoint, operation] of [
    ["setup", "setup"],
    ["login", "login"],
  ])
    router.post(
      `/${endpoint}`,
      route(async (req, res) => {
        if (!config.authRequired) return res.json({ ok: true });
        const token = await auth[operation](req.body, req.ip);
        issue(res, token);
        res.json({ ok: true });
      }),
    );
  return router;
}
export function requireAuthentication(config, auth) {
  return route(async (req, res, next) => {
    if (!config.authRequired) return next();
    const token = sessionToken(req);
    if (await auth.authenticate(token)) {
      res.cookie(SESSION_COOKIE, token, cookieOptions(config));
      return next();
    }
    const setupRequired = (await auth.status()).setupRequired;
    res.status(401).json({
      error: setupRequired
        ? "Bitte zuerst die geschützte Einrichtung abschließen."
        : "Bitte am Server anmelden.",
      code: setupRequired ? "SETUP_REQUIRED" : "AUTH_REQUIRED",
    });
  });
}
export function createAccountRouter(config, auth) {
  const router = express.Router();
  router.post(
    "/logout",
    route(async (req, res) => {
      if (config.authRequired) await auth.logout(sessionToken(req));
      res.clearCookie(SESSION_COOKIE, {
        ...cookieOptions(config),
        maxAge: undefined,
      });
      res.json({ ok: true });
    }),
  );
  router.patch(
    "/auth/password",
    route(async (req, res) => {
      if (config.authRequired)
        res.cookie(
          SESSION_COOKIE,
          await auth.changePassword(req.body),
          cookieOptions(config),
        );
      res.json({ ok: true });
    }),
  );
  return router;
}
