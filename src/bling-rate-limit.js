const REQUEST_DELAY_MS = 450;
const FALLBACK_DELAY_MS = 2500;
const MAX_RETRIES = 3;
const MAX_INLINE_WAIT_MS = 30_000;
const limiters = new Map();
let tokenLimiter;

// OAuth has a separate limit of 20 requests/minute for the server IP.
export function getBlingTokenRateLimiter() {
  return tokenLimiter ||= new BlingRateLimiter({ requestDelayMs: 3100 });
}

// All clients for an integration share one schedule, including after token refresh.
export function getBlingRateLimiter(integration) {
  const key = integration.userId || integration.accessToken;
  if (!limiters.has(key)) limiters.set(key, new BlingRateLimiter());
  return limiters.get(key);
}

export class BlingRateLimiter {
  constructor({ now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), requestDelayMs = REQUEST_DELAY_MS } = {}) {
    this.requestDelayMs = requestDelayMs;
    this.now = now;
    this.sleep = sleep;
    this.nextRequestAt = 0;
    this.cooldownUntil = 0;
    this.tail = Promise.resolve();
  }

  async acquire() {
    const slot = this.tail.then(async () => {
      while (true) {
        const now = this.now();
        if (this.cooldownUntil - now > MAX_INLINE_WAIT_MS) throw rateLimitError();
        const delay = Math.max(this.nextRequestAt, this.cooldownUntil) - now;
        if (delay <= 0) break;
        await this.sleep(delay);
      }
      this.nextRequestAt = this.now() + this.requestDelayMs;
    });
    this.tail = slot.catch(() => {});
    await slot;
  }

  onRateLimit(response, payload, retries) {
    const header = response.headers?.get?.("retry-after");
    const seconds = header?.trim() ? Number(header) : NaN;
    const retryAt = header ? Date.parse(header) : NaN;
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000
      : Number.isFinite(retryAt) ? retryAt - this.now() : 0;
    const dailyDelay = payload?.error?.period === "day" ? 24 * 60 * 60 * 1000 : 0;
    const delay = Math.max(REQUEST_DELAY_MS, headerDelay, dailyDelay, FALLBACK_DELAY_MS * 2 ** retries);
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay);
    if (retries >= MAX_RETRIES || delay > MAX_INLINE_WAIT_MS) throw rateLimitError(payload);
  }
}

function rateLimitError(payload) {
  const error = new Error("Limite de requisicoes do Bling atingido (429). A sincronizacao sera tentada novamente pela fila.");
  error.name = "BlingApiError";
  error.status = 429;
  error.payload = payload;
  return error;
}
