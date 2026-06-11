const DEFAULT_PORT = 3000;
const DEFAULT_DEV_SECRET = "etiquefacil-dev-secret";

export function buildRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";
  const databaseUrl = env.DATABASE_URL || "";
  const sessionSecret = env.SESSION_SECRET || (isProduction ? "" : DEFAULT_DEV_SECRET);

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
    downloadMode: env.DOWNLOAD_MODE || (isProduction ? "browser" : "local"),
    cookieSecure: isProduction,
    trustProxy: isProduction ? 1 : 0
  };
}
