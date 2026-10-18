import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, AppError, readJSON, writeJSON, serial } from "./storage.js";

const file = () => path.join(DATA_DIR, "provider-secrets.json");
async function saved() {
  try {
    return await readJSON(file());
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1 };
    throw error;
  }
}
export async function getOpenAIKey() {
  if (process.env.STERRACODE_OPENAI_API_KEY_FILE) {
    try {
      const key = (
        await fs.readFile(process.env.STERRACODE_OPENAI_API_KEY_FILE, "utf8")
      ).trim();
      if (!key) throw new Error();
      return key;
    } catch {
      throw new AppError(
        "OpenAI-Secret-Datei fehlt, ist leer oder nicht lesbar.",
        503,
        "OPENAI_SECRET_UNAVAILABLE",
      );
    }
  }
  const key = (await saved()).openai;
  if (!key)
    throw new AppError(
      "Bitte einen OpenAI-API-Schlüssel in den Einstellungen hinterlegen.",
      400,
      "OPENAI_KEY_REQUIRED",
    );
  return key;
}
export async function getProviderCredentials() {
  return {
    openai: {
      configured: Boolean(
        process.env.STERRACODE_OPENAI_API_KEY_FILE || (await saved()).openai,
      ),
      source: process.env.STERRACODE_OPENAI_API_KEY_FILE
        ? "file"
        : (await saved()).openai
          ? "saved"
          : null,
    },
  };
}
export async function updateProviderCredentials({ provider, apiKey, ...rest }) {
  if (provider !== "openai" || Object.keys(rest).length)
    throw new AppError("Nur OpenAI-Zugangsdaten können hier geändert werden.");
  if (process.env.STERRACODE_OPENAI_API_KEY_FILE)
    throw new AppError(
      "Die OpenAI-Zugangsdaten werden durch eine schreibgeschützte Secret-Datei vorgegeben.",
      409,
      "EXTERNAL_SECRET",
    );
  if (
    apiKey !== null &&
    (typeof apiKey !== "string" || !/^sk-[^\s]{8,2045}$/.test(apiKey))
  )
    throw new AppError(
      "Bitte einen gültigen OpenAI-API-Schlüssel angeben.",
      400,
      "INVALID_API_KEY",
    );
  return serial("provider-credentials", async () => {
    const next = await saved();
    if (apiKey === null) delete next.openai;
    else next.openai = apiKey;
    await writeJSON(file(), next);
    await fs.chmod(file(), 0o600);
    return getProviderCredentials();
  });
}
