import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

const root = path.dirname(fileURLToPath(import.meta.url));
const split = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const normalizeHost = (host) =>
  String(host)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

function configurationError(message) {
  throw new Error(`Ungültige Serverkonfiguration: ${message}`);
}
function origin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    configurationError(`${name} ist keine URL.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash
  )
    configurationError(
      `${name} muss eine HTTP(S)-Adresse ohne Zugangsdaten, Unterpfad, Query oder Fragment sein.`,
    );
  return url;
}
function proxyAddress(value) {
  const [address, prefix, ...rest] = value.split("/");
  const family = isIP(address);
  if (
    !family ||
    rest.length ||
    (prefix !== undefined &&
      (!/^\d+$/.test(prefix) ||
        Number(prefix) < 1 ||
        Number(prefix) > (family === 4 ? 32 : 128)))
  )
    configurationError(
      "STERRACODE_TRUSTED_PROXIES verlangt konkrete IP-Adressen oder begrenzte CIDR-Netze.",
    );
  return value;
}
export function loadConfig(env = process.env) {
  const mode = env.STERRACODE_MODE || "local";
  if (!["local", "docker", "server"].includes(mode))
    configurationError("STERRACODE_MODE muss local, docker oder server sein.");
  const docker = mode === "docker",
    authRequired = mode !== "local";
  const port = docker ? 3000 : Number(env.PORT || env.STERRACODE_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    configurationError("Der Listen-Port ist ungültig.");
  if (authRequired && !env.STERRACODE_PUBLIC_URL)
    configurationError("STERRACODE_PUBLIC_URL fehlt im Serverbetrieb.");
  const publicUrl = origin(
    env.STERRACODE_PUBLIC_URL || `http://localhost:${port}`,
    "STERRACODE_PUBLIC_URL",
  );
  const allowedHosts = new Set([normalizeHost(publicUrl.hostname)]);
  if (!authRequired)
    for (const host of ["localhost", "127.0.0.1", "::1"])
      allowedHosts.add(host);
  for (const host of split(env.STERRACODE_EXTRA_ALLOWED_HOSTS)) {
    if (
      !host ||
      /[\s/@?#]/.test(host) ||
      (!isIP(normalizeHost(host)) && host.includes(":"))
    )
      configurationError("Unzulässiger zusätzlicher Hostname.");
    allowedHosts.add(normalizeHost(host));
  }
  const allowedOrigins = new Set([publicUrl.origin]);
  for (const value of split(env.STERRACODE_EXTRA_ALLOWED_ORIGINS))
    allowedOrigins.add(origin(value, "Zusätzlicher Origin").origin);
  const trustedProxies = split(env.STERRACODE_TRUSTED_PROXIES).map(
    proxyAddress,
  );
  const configuredProxyMode = env.STERRACODE_PROXY_MODE || "off";
  const proxyMode =
    { "external-host": "host", "external-docker": "docker" }[
      configuredProxyMode
    ] || configuredProxyMode;
  if (!["off", "caddy", "host", "docker"].includes(proxyMode))
    configurationError("Unbekannter Proxy-Modus.");
  return Object.freeze({
    mode,
    docker,
    authRequired,
    port,
    bindAddress: docker ? "0.0.0.0" : env.STERRACODE_LISTEN_HOST || "127.0.0.1",
    publicUrl: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    allowedHosts,
    allowedOrigins,
    trustedProxies,
    proxyMode,
    dataDir: path.resolve(
      env.STERRACODE_DATA_DIR || (docker ? "/data" : path.join(root, "data")),
    ),
    workspacesDir: path.resolve(
      env.STERRACODE_WORKSPACE_DIR ||
        env.STERRACODE_WORKSPACES_DIR ||
        (docker
          ? "/workspaces"
          : path.join(
              env.STERRACODE_DATA_DIR || path.join(root, "data"),
              "workspaces",
            )),
    ),
    lmStudioUrl:
      env.STERRACODE_LM_STUDIO_URL ||
      (docker ? "http://host.docker.internal:1234" : "http://localhost:1234"),
    lmStudioOverrideUrl: env.STERRACODE_LM_STUDIO_OVERRIDE_URL || null,
    lmStudioTokenFile: env.STERRACODE_LM_STUDIO_TOKEN_FILE || null,
    adminPasswordFile: env.STERRACODE_ADMIN_PASSWORD_FILE || null,
    source: authRequired
      ? ".env / Prozessumgebung (Neustart erforderlich)"
      : "Prozessumgebung / lokale Standardwerte",
  });
}

export function getServerConfig(config = loadConfig()) {
  return {
    mode: config.mode,
    authRequired: config.authRequired,
    publicUrl: config.publicUrl,
    bindAddress: config.bindAddress,
    port: config.port,
    proxyMode: config.proxyMode,
    allowedHosts: [...config.allowedHosts],
    allowedOrigins: [...config.allowedOrigins],
    trustedProxies: [...config.trustedProxies],
    source: config.source,
    readOnly: true,
    restartRequiredForChanges: true,
    lmStudioOverride: Boolean(config.lmStudioOverrideUrl),
    lmStudioTokenConfigured: Boolean(config.lmStudioTokenFile),
  };
}
