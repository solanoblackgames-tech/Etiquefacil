const BLING_API_BASE_URL = "https://api.bling.com.br/Api/v3";
const BLING_OAUTH_TOKEN_URL = "https://www.bling.com.br/Api/v3/oauth/token";
const BLING_REQUEST_DELAY_MS = 450;
const BLING_RATE_LIMIT_FALLBACK_DELAY_MS = 2500;

export function buildBlingProductPayload(product) {
  return compactObject({
    nome: product.descricao || product.sku,
    codigo: product.sku || "",
    preco: numberOrZero(product.valorUnit),
    precoCusto: numberOrZero(product.precoCusto),
    tipo: "P",
    situacao: "A",
    formato: "S",
    unidade: "UN",
    gtin: product.ean || "",
    gtinEmbalagem: product.ean || "",
    marca: product.codigoMl || "",
    linkExterno: product.link || "",
    imagemURL: product.foto || "",
    descricaoCurta: product.descricao || "",
    tipoProducao: "T",
    condicao: 0,
    freteGratis: false,
    pesoLiquido: 0,
    pesoBruto: 0,
    volumes: 0,
    itensPorCaixa: 0
  });
}

export function buildBlingProductSupplierPayload(product, { productId, supplierId } = {}) {
  return compactObject({
    produto: { id: Number(productId) },
    fornecedor: { id: Number(supplierId) },
    descricao: product.descricao || product.sku || "",
    codigo: product.sku || "",
    precoCusto: numberOrZero(product.precoCusto),
    precoCompra: numberOrZero(product.precoCusto),
    padrao: true
  });
}

export function buildBlingStockEntryPayload(item, { productId, depositoId, observacao = "" } = {}) {
  return compactObject({
    produto: { id: Number(productId), codigo: item.sku || "" },
    deposito: { id: Number(depositoId) },
    operacao: "E",
    quantidade: numberOrZero(item.qtdConferida || item.quantidade),
    preco: numberOrZero(item.precoCusto),
    custo: numberOrZero(item.precoCusto),
    observacoes: observacao
  });
}

export function buildBlingStockExitPayload(item, { productId, depositoId, observacao = "" } = {}) {
  return compactObject({
    produto: { id: Number(productId), codigo: item.sku || "" },
    deposito: { id: Number(depositoId) },
    operacao: "S",
    quantidade: numberOrZero(item.quantidade || item.qtdConferida || 1),
    observacoes: observacao
  });
}

export function buildBlingStockTransferPayload(item, { productId, depositoOrigemId, depositoDestinoId, observacao = "" } = {}) {
  return compactObject({
    produto: { id: Number(productId), codigo: item.sku || "" },
    deposito: { id: Number(depositoOrigemId) },
    depositoDestino: { id: Number(depositoDestinoId) },
    operacao: "T",
    quantidade: numberOrZero(item.quantidade || item.qtdConferida),
    observacoes: observacao
  });
}

export async function syncBlingProducts({ integration, products, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const results = [];

  for (const product of products) {
    const existing = await client.findProductBySku(product.sku);
    if (existing?.id) {
      await client.ensureProductSupplier(product, existing.id);
      results.push({ sku: product.sku, status: "skipped", blingProductId: existing.id });
      continue;
    }

    const response = await client.createProduct(buildBlingProductPayload(product));
    const blingProductId = response?.data?.id || null;
    if (blingProductId) await client.ensureProductSupplier(product, blingProductId);
    results.push({ sku: product.sku, status: "created", blingProductId, response });
  }

  return summarizeSync(results);
}

export async function syncBlingStockEntries({ integration, items, depositoName, observacao, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const deposito = await client.findDepositByDescription(depositoName);
  if (!deposito?.id) throw new Error(`Deposito Bling nao encontrado: ${depositoName}`);

  const results = [];
  for (const item of items) {
    let product = await client.findProductBySku(item.sku);
    if (!product?.id) {
      const created = await client.createProduct(buildBlingProductPayload(item));
      product = { id: created?.data?.id, codigo: item.sku };
      if (product.id) await client.ensureProductSupplier(item, product.id);
    }
    if (!product?.id) throw new Error(`Produto ${item.sku} nao retornou ID no Bling.`);

    const response = await client.createStockEntry(
      buildBlingStockEntryPayload(item, {
        productId: product.id,
        depositoId: deposito.id,
        observacao
      })
    );
    results.push({ sku: item.sku, status: "entered", blingProductId: product.id, response });
  }

  return {
    ...summarizeSync(results),
    deposito: { id: deposito.id, descricao: deposito.descricao || depositoName }
  };
}

export async function syncBlingStockMovement({ integration, item, depositoName, operation = "entry", observacao, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const deposito = await client.findDepositByDescription(depositoName);
  if (!deposito?.id) throw new Error(`Deposito Bling nao encontrado: ${depositoName}`);

  let product = await client.findProductBySku(item.sku);
  if (!product?.id && operation === "entry") {
    const created = await client.createProduct(buildBlingProductPayload(item));
    product = { id: created?.data?.id, codigo: item.sku };
    if (product.id) await client.ensureProductSupplier(item, product.id);
  }
  if (!product?.id) throw new Error(`Produto ${item.sku} nao encontrado no Bling.`);

  const payloadBuilder = operation === "exit" ? buildBlingStockExitPayload : buildBlingStockEntryPayload;
  const response = await client.createStockEntry(
    payloadBuilder(
      { ...item, quantidade: item.quantidade || 1, qtdConferida: item.qtdConferida || 1 },
      {
        productId: product.id,
        depositoId: deposito.id,
        observacao
      }
    )
  );

  return {
    ok: true,
    operation,
    sku: item.sku,
    blingProductId: product.id,
    deposito: { id: deposito.id, descricao: deposito.descricao || depositoName },
    response
  };
}

export async function listBlingDeposits({ integration, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  return client.listDeposits();
}

export async function syncBlingStockTransfers({ integration, items, depositoOrigemName, depositoDestinoName, observacao, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const origem = await client.findDepositByDescription(depositoOrigemName);
  if (!origem?.id) throw new Error(`Deposito Bling de origem nao encontrado: ${depositoOrigemName}`);
  const destino = await client.findDepositByDescription(depositoDestinoName);
  if (!destino?.id) throw new Error(`Deposito Bling de destino nao encontrado: ${depositoDestinoName}`);
  if (String(origem.id) === String(destino.id)) throw new Error("Escolha depositos diferentes para transferir.");

  const results = [];
  for (const item of items) {
    const product = await client.findProductBySku(item.sku);
    if (!product?.id) throw new Error(`Produto ${item.sku} nao encontrado no Bling.`);

    const response = await client.createStockEntry(
      buildBlingStockTransferPayload(item, {
        productId: product.id,
        depositoOrigemId: origem.id,
        depositoDestinoId: destino.id,
        observacao
      })
    );
    results.push({ sku: item.sku, status: "transferred", blingProductId: product.id, response });
  }

  return {
    ...summarizeSync(results),
    transferred: results.length,
    depositoOrigem: { id: origem.id, descricao: origem.descricao || depositoOrigemName },
    depositoDestino: { id: destino.id, descricao: destino.descricao || depositoDestinoName }
  };
}

class BlingApiClient {
  constructor(integration, saveIntegration) {
    if (!integration?.accessToken) throw new Error("Autorize a integracao Bling antes de enviar dados.");
    this.integration = integration;
    this.saveIntegration = saveIntegration;
    this.lastRequestAt = 0;
  }

  async findProductBySku(sku) {
    const payload = await this.request("/produtos", {
      query: { "codigos[]": sku, criterio: 5, limite: 1 }
    });
    return (payload?.data || []).find((product) => String(product.codigo || "") === String(sku));
  }

  async createProduct(payload) {
    return this.request("/produtos", { method: "POST", body: payload });
  }

  async ensureProductSupplier(product, productId) {
    if (!product?.fornecedor || !productId) return null;
    const supplier = await this.findOrCreateSupplier(product.fornecedor);
    if (!supplier?.id) return null;
    const existing = await this.findProductSupplier(productId, supplier.id);
    if (existing?.id) return existing;
    return this.createProductSupplier(buildBlingProductSupplierPayload(product, { productId, supplierId: supplier.id }));
  }

  async findProductSupplier(productId, supplierId) {
    const payload = await this.request("/produtos/fornecedores", {
      query: { idProduto: productId, limite: 100 }
    });
    return (payload?.data || []).find((item) => {
      return String(item.produto?.id || item.idProduto || "") === String(productId) && String(item.fornecedor?.id || item.idFornecedor || "") === String(supplierId);
    });
  }

  async findOrCreateSupplier(name) {
    const normalized = normalizeText(name);
    if (!normalized) return null;
    const payload = await this.request("/contatos", {
      query: { pesquisa: name, limite: 100 }
    });
    const existing = (payload?.data || []).find((contact) => normalizeText(contact.nome) === normalized);
    if (existing?.id) return existing;

    const created = await this.request("/contatos", {
      method: "POST",
      body: { nome: name, situacao: "A" }
    });
    return created?.data || null;
  }

  async createProductSupplier(payload) {
    return this.request("/produtos/fornecedores", { method: "POST", body: payload });
  }

  async findDepositByDescription(description) {
    const payload = await this.request("/depositos", {
      query: { descricao: description, situacao: 1, limite: 100 }
    });
    const normalized = normalizeText(description);
    return (payload?.data || []).find((deposito) => normalizeText(deposito.descricao) === normalized) || (payload?.data || [])[0];
  }

  async listDeposits() {
    const payload = await this.request("/depositos", {
      query: { situacao: 1, limite: 100 }
    });
    return (payload?.data || []).map((deposito) => ({
      id: deposito.id,
      descricao: deposito.descricao || ""
    }));
  }

  async createStockEntry(payload) {
    return this.request("/estoques", { method: "POST", body: payload });
  }

  async request(path, { method = "GET", query = {}, body = null, retry = true } = {}) {
    await this.refreshTokenIfNeeded();

    const url = new URL(`${BLING_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
    }

    await this.waitForRequestSlot();

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.integration.accessToken}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 401 && retry && this.integration.refreshToken) {
      await this.refreshToken();
      return this.request(path, { method, query, body, retry: false });
    }

    if (response.status === 429) {
      await wait(retryAfterMs(response) ?? BLING_RATE_LIMIT_FALLBACK_DELAY_MS);
      return this.request(path, { method, query, body, retry });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(blingErrorMessage(payload, response.status));
    return payload;
  }

  async refreshTokenIfNeeded() {
    if (!this.integration.refreshToken || !this.integration.tokenExpiresAt) return;
    const expiresAt = new Date(this.integration.tokenExpiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) return;
    await this.refreshToken();
  }

  async refreshToken() {
    if (!this.integration.refreshToken) throw new Error("Token Bling expirado. Autorize a integracao novamente.");

    const response = await fetch(BLING_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.integration.clientId}:${this.integration.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        "enable-jwt": "1"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: this.integration.refreshToken
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(blingErrorMessage(payload, response.status));

    this.integration = {
      ...this.integration,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || this.integration.refreshToken,
      tokenExpiresAt: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : null
    };
    if (this.saveIntegration) await this.saveIntegration(this.integration);
  }

  async waitForRequestSlot() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < BLING_REQUEST_DELAY_MS) await wait(BLING_REQUEST_DELAY_MS - elapsed);
    this.lastRequestAt = Date.now();
  }
}

function summarizeSync(results) {
  return {
    ok: true,
    count: results.length,
    created: results.filter((item) => item.status === "created").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    entered: results.filter((item) => item.status === "entered").length,
    transferred: results.filter((item) => item.status === "transferred").length,
    results
  };
}

function blingErrorMessage(payload, status) {
  const description = payload?.error?.description || payload?.error_description || payload?.message || payload?.error;
  const fields = Array.isArray(payload?.error?.fields)
    ? payload.error.fields.map((field) => field.msg || field.message || field.element).filter(Boolean).join("; ")
    : "";
  return [description || `Erro ${status} na API do Bling`, fields].filter(Boolean).join(": ");
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function retryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = new Date(header).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function wait(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
