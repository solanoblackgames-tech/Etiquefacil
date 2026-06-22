import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const DEFAULT_PORT = 3000;
const DEFAULT_DEV_SECRET = "etiquefacil-dev-secret";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotenv({ path: path.resolve(__dirname, "../.env") });

export function buildRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";
  const databaseUrl = env.DATABASE_URL || "";
  const sessionSecret = env.SESSION_SECRET || (isProduction ? "" : DEFAULT_DEV_SECRET);
  const blingClientId = env.BLING_CLIENT_ID || "";
  const blingClientSecret = env.BLING_CLIENT_SECRET || "";

  if (isProduction && !databaseUrl) {
    throw new Error("DATABASE_URL é obrigatório em produção.");
  }
  if (isProduction && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET precisa ter pelo menos 32 caracteres em produção.");
  }

  return {
    port: Number(env.PORT || DEFAULT_PORT),
    nodeEnv,
    databaseUrl,
    sessionSecret,
    blingClientId,
    blingClientSecret,
    blingRedirectUri: env.BLING_REDIRECT_URI || "",
    downloadMode: env.DOWNLOAD_MODE || (isProduction ? "browser" : "local"),
    cookieSecure: env.COOKIE_SECURE === undefined ? isProduction : env.COOKIE_SECURE === "true",
    trustProxy: isProduction ? 1 : 0
  };
}
