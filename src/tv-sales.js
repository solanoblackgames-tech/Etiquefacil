// Vendas do painel da TV: pedidos Atendidos das contas Bling (principal = JZ, ecommerce = PJJ),
// guardados em cache e somados no mes atual contra o mes anterior.

const TIME_ZONE = "America/Sao_Paulo";
export const TV_SALES_ACCOUNTS = [
  { account: "principal", label: "JZ" },
  { account: "ecommerce", label: "Ecommerce" }
];
// Panobianco Ibiti e a propria loja (transferencia interna), nao entra como venda.
const EXCLUDED_CHANNEL_PATTERNS = ["panobianco"];
const EXCLUDED_SKUS = new Set(["LOTE159"]);
const SELLER_ALIASES = new Map([
  ["fernando cavasane", "fernando cavacane"],
  ["fernanado cavacane", "fernando cavacane"]
]);
const EXCLUDED_SELLER_PATTERNS = [/treinamento/, /^ael comercio/, /panobianco/];
const NO_SELLER = "Sem vendedor";
const TOP_LIMIT = 10;

const LIST_REFRESH_MS = 10 * 60 * 1000;
const BACKFILL_RETRY_MS = 30 * 1000;
const VIEW_TTL_MS = 15 * 60 * 1000;
const CHANNELS_REFRESH_MS = 6 * 60 * 60 * 1000;
const IMAGE_REFRESH_MS = 12 * 60 * 60 * 1000;
const DETAIL_BUDGET = 300;
// Pausa entre detalhes: deixa folga no limite do Bling para o uso normal do sistema.
const DETAIL_PAUSE_MS = 700;

export function localDay(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TIME_ZONE })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function previousMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`;
}

function daysInMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

export function tvSalesPeriod(now = new Date()) {
  const today = localDay(now);
  const month = today.slice(0, 7);
  const prev = previousMonth(month);
  return { today, month, prev, startDay: `${prev}-01`, endDay: today };
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCase(key) {
  return key.split(" ").map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word)).join(" ");
}

// Junta grafias do mesmo vendedor; devolve null para quem nao entra no ranking.
export function canonicalSeller(name) {
  const raw = String(name || "").trim();
  if (!raw || normalizeName(raw) === normalizeName(NO_SELLER)) return { key: "", name: NO_SELLER };
  const normalized = normalizeName(raw);
  if (EXCLUDED_SELLER_PATTERNS.some((pattern) => pattern.test(normalized))) return null;
  const key = SELLER_ALIASES.get(normalized) || normalized;
  return { key, name: titleCase(key) };
}

function isExcludedChannel(name) {
  const normalized = normalizeName(name);
  return EXCLUDED_CHANNEL_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function channelName(cache, storeId) {
  if (!storeId || storeId === "0") return "Pedido manual";
  return cache.channels?.[storeId] || `Loja ${storeId}`;
}

const round = (value) => Math.round(Number(value || 0) * 100) / 100;
const emptyTotals = () => ({ total: 0, orders: 0, pieces: 0, detailed: 0 });

// accounts: [{ account, label, cache: { orders, details, channels, sellers, images }, error }]
export function buildTvSalesStats(accounts = [], now = new Date()) {
  const { today, month, prev } = tvSalesPeriod(now);
  const dayOfMonth = Number(today.slice(8, 10));
  const prevLastComparable = `${prev}-${String(Math.min(dayOfMonth, daysInMonth(prev))).padStart(2, "0")}`;
  const current = emptyTotals();
  const previous = emptyTotals();
  const todayTotals = emptyTotals();
  const byAccount = [];
  const dailyCurrent = Array.from({ length: daysInMonth(month) }, (_, index) => (index + 1 <= dayOfMonth ? 0 : null));
  const dailyPrevious = Array.from({ length: daysInMonth(prev) }, () => 0);
  const channels = new Map();
  const skus = new Map();
  const sellers = new Map();
  let pendingDetails = 0;

  for (const entry of accounts) {
    const cache = entry.cache || {};
    const accountTotals = { account: entry.account, label: entry.label, connected: Boolean(entry.connected), error: entry.error || "", current: 0, previous: 0 };
    byAccount.push(accountTotals);
    for (const order of Object.values(cache.orders || {})) {
      const channel = channelName(cache, order.storeId);
      if (isExcludedChannel(channel)) continue;
      const inCurrent = order.day.startsWith(month) && order.day <= today;
      const inPrevious = order.day.startsWith(prev);
      if (!inCurrent && !inPrevious) continue;
      const comparable = inPrevious && order.day <= prevLastComparable;
      const detail = cache.details?.[order.id];
      const pieces = detail ? detail.items.reduce((sum, item) => sum + item.quantity, 0) : 0;
      const dayIndex = Number(order.day.slice(8, 10)) - 1;
      const add = (totals) => {
        totals.total += order.total;
        totals.orders += 1;
        totals.pieces += pieces;
        if (detail) totals.detailed += 1;
      };

      if (inCurrent) {
        add(current);
        accountTotals.current += order.total;
        if (order.day === today) add(todayTotals);
        dailyCurrent[dayIndex] += order.total;
        if (!detail) pendingDetails += 1;
      } else {
        dailyPrevious[dayIndex] += order.total;
        if (comparable) {
          add(previous);
          accountTotals.previous += order.total;
        }
      }

      const channelKey = `${entry.account}\u0000${normalizeName(channel)}`;
      const channelRow = channels.get(channelKey) || { name: channel, account: entry.account, label: entry.label, current: 0, previous: 0 };
      if (inCurrent) channelRow.current += order.total;
      else if (comparable) channelRow.previous += order.total;
      channels.set(channelKey, channelRow);

      if (!inCurrent || !detail) continue;
      for (const item of detail.items) {
        if (EXCLUDED_SKUS.has(item.sku)) continue;
        const key = item.sku || normalizeName(item.name);
        const row = skus.get(key) || { sku: item.sku, name: item.name, quantity: 0, value: 0, account: entry.account, productId: item.productId };
        row.quantity += item.quantity;
        row.value += item.value;
        if (!row.productId && item.productId) row.productId = item.productId;
        skus.set(key, row);
      }
      // Ranking de vendedores so da JZ: o Ecommerce vende apenas no Mercado Livre, sem vendedor.
      if (entry.account !== "principal") continue;
      const sellerName = detail.sellerId ? cache.sellers?.[detail.sellerId] || `Vendedor ${detail.sellerId}` : "";
      const seller = canonicalSeller(sellerName);
      if (!seller) continue;
      const sellerRow = sellers.get(seller.key) || { name: seller.name, noSeller: !seller.key, total: 0, orders: 0, today: 0 };
      sellerRow.total += order.total;
      sellerRow.orders += 1;
      if (order.day === today) sellerRow.today += order.total;
      sellers.set(seller.key, sellerRow);
    }
  }

  const finish = (totals) => ({
    total: round(totals.total),
    orders: totals.orders,
    pieces: totals.pieces,
    ticket: totals.orders ? round(totals.total / totals.orders) : 0
  });
  const imageFor = (row) => accounts.find((entry) => entry.account === row.account)?.cache?.images?.[row.productId]?.url || "";

  return {
    generatedAt: now.toISOString(),
    today,
    month,
    previousMonth: prev,
    comparableUntil: prevLastComparable,
    current: finish(current),
    previous: finish(previous),
    todayTotals: finish(todayTotals),
    accounts: byAccount.map((row) => ({ ...row, current: round(row.current), previous: round(row.previous) })),
    daily: { current: dailyCurrent.map((value) => (value === null ? null : round(value))), previous: dailyPrevious.map(round) },
    channels: [...channels.values()]
      .filter((row) => row.current || row.previous)
      .map((row) => ({ ...row, current: round(row.current), previous: round(row.previous) }))
      .sort((a, b) => b.current - a.current || b.previous - a.previous),
    skus: [...skus.values()]
      .sort((a, b) => b.quantity - a.quantity || b.value - a.value)
      .slice(0, TOP_LIMIT)
      .map((row) => ({ ...row, value: round(row.value), image: imageFor(row) })),
    sellers: [...sellers.values()]
      .sort((a, b) => b.total - a.total)
      .map((row) => ({ ...row, total: round(row.total), today: round(row.today), ticket: row.orders ? round(row.total / row.orders) : 0 })),
    pendingDetails
  };
}

function emptyCache() {
  return { orders: {}, details: {}, channels: {}, channelsAt: 0, sellers: {}, images: {} };
}

// Sincroniza em segundo plano so enquanto alguma TV estiver aberta.
// getReader(userId, account) -> leitor do Bling ou null (conta nao conectada).
export function createTvSalesSync({
  getReader,
  loadCache = async () => null,
  saveCache = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => new Date(),
  logError = (error) => console.error("[tv-vendas]", error?.message || error)
} = {}) {
  const states = new Map();

  function stateFor(userId) {
    if (!states.has(userId)) states.set(userId, { viewedAt: 0, running: null, timer: null, stats: null, accounts: new Map() });
    return states.get(userId);
  }

  async function accountState(userId, state, account) {
    if (!state.accounts.has(account)) {
      const saved = await loadCache(userId, account).catch(() => null);
      state.accounts.set(account, { cache: { ...emptyCache(), ...(saved || {}) }, error: "", connected: false });
    }
    return state.accounts.get(account);
  }

  function rebuild(state) {
    const accounts = TV_SALES_ACCOUNTS.map(({ account, label }) => {
      const entry = state.accounts.get(account);
      return { account, label, cache: entry?.cache, error: entry?.error, connected: entry?.connected };
    });
    state.stats = buildTvSalesStats(accounts, clock());
  }

  async function syncAccount(userId, state, account) {
    const entry = await accountState(userId, state, account);
    const reader = await getReader(userId, account).catch(() => null);
    entry.connected = Boolean(reader);
    if (!reader) {
      entry.error = "";
      return 0;
    }
    const cache = entry.cache;
    const period = tvSalesPeriod(clock());
    try {
      const orders = await reader.listAttendedOrders({ startDay: period.startDay, endDay: period.endDay });
      cache.orders = Object.fromEntries(orders.map((order) => [order.id, order]));
      for (const id of Object.keys(cache.details)) if (!cache.orders[id]) delete cache.details[id];
      if (Date.now() - Number(cache.channelsAt || 0) > CHANNELS_REFRESH_MS) {
        const channels = await reader.listSalesChannels();
        cache.channels = Object.fromEntries(channels.map((channel) => [channel.id, channel.name]));
        cache.channelsAt = Date.now();
        // Junto com os canais, tenta de novo os vendedores que vieram sem nome.
        for (const [id, name] of Object.entries(cache.sellers)) if (!name) delete cache.sellers[id];
      }
      entry.error = "";
    } catch (error) {
      entry.error = error.message || "Falha ao ler o Bling.";
      logError(error);
      return 0;
    }
    rebuild(state);

    // Detalhes (itens e vendedor) dos pedidos mais novos primeiro.
    const missing = Object.values(cache.orders)
      .filter((order) => !cache.details[order.id])
      .sort((a, b) => b.day.localeCompare(a.day));
    let fetched = 0;
    for (const order of missing.slice(0, DETAIL_BUDGET)) {
      try {
        const detail = await reader.getOrderDetail(order.id);
        if (detail) cache.details[order.id] = detail;
      } catch (error) {
        // Pedido apagado vira detalhe vazio; limite, autorizacao ou rede: tenta na proxima rodada.
        if (error?.status !== 404) break;
        cache.details[order.id] = { sellerId: "", items: [] };
      }
      fetched += 1;
      if (fetched % 40 === 0) rebuild(state);
      await sleep(DETAIL_PAUSE_MS);
    }

    if (account === "principal") {
      const sellerIds = new Set(Object.values(cache.details).map((detail) => detail.sellerId).filter(Boolean));
      for (const sellerId of sellerIds) {
        if (sellerId in cache.sellers) continue;
        cache.sellers[sellerId] = await reader.getSellerName(sellerId).catch(() => "") || "";
      }
    }
    if (fetched) await saveCache(userId, account, cache).catch(logError);
    return missing.length - fetched;
  }

  async function fetchImages(userId, state) {
    rebuild(state);
    let changed = false;
    for (const row of state.stats?.skus || []) {
      const entry = state.accounts.get(row.account);
      if (!row.productId || !entry) continue;
      const cached = entry.cache.images[row.productId];
      if (cached && Date.now() - cached.at < IMAGE_REFRESH_MS) continue;
      const reader = await getReader(userId, row.account).catch(() => null);
      if (!reader) continue;
      const url = await reader.getProductImage(row.productId).catch(() => "");
      entry.cache.images[row.productId] = { url, at: Date.now() };
      changed = true;
    }
    if (changed) rebuild(state);
  }

  async function run(userId) {
    const state = stateFor(userId);
    let pending = 0;
    for (const { account } of TV_SALES_ACCOUNTS) {
      pending += await syncAccount(userId, state, account).catch((error) => {
        logError(error);
        return 0;
      });
    }
    await fetchImages(userId, state).catch(logError);
    rebuild(state);
    return pending;
  }

  function schedule(userId, delay) {
    const state = stateFor(userId);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (Date.now() - state.viewedAt > VIEW_TTL_MS) return;
      start(userId);
    }, delay);
    state.timer.unref?.();
  }

  function start(userId) {
    const state = stateFor(userId);
    if (state.running) return state.running;
    state.running = run(userId)
      .then((pending) => schedule(userId, pending > 0 ? BACKFILL_RETRY_MS : LIST_REFRESH_MS))
      .catch((error) => {
        logError(error);
        schedule(userId, LIST_REFRESH_MS);
      })
      .finally(() => {
        state.running = null;
      });
    return state.running;
  }

  return {
    // Chamado a cada atualizacao da TV: marca que ha alguem olhando e liga a sincronizacao.
    touch(userId) {
      const state = stateFor(userId);
      const idle = Date.now() - state.viewedAt > VIEW_TTL_MS;
      state.viewedAt = Date.now();
      if (!state.running && (idle || !state.stats)) start(userId);
      return state.stats;
    },
    stats: (userId) => stateFor(userId).stats,
    run: start
  };
}
