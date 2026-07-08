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
    pesoLiquido: numberOrZero(product.pesoCaixa ?? product.pesoLiquido ?? product.peso),
    pesoBruto: numberOrZero(product.pesoCaixa ?? product.pesoBruto ?? product.peso),
    volumes: 0,
    itensPorCaixa: 0,
    dimensoes: buildBlingDimensionsPayload(product)
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

export function buildBlingSupplierContactPayload(name, supplierType, existing = {}) {
  return compactObject({
    ...existing,
    nome: name || existing.nome || "",
    tipo: existing.tipo || "J",
    situacao: existing.situacao || "A",
    tiposContato: mergeContactTypes(existing.tiposContato, supplierType)
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
  const quantidade = item.quantidade ?? item.qtdConferida ?? item.quantidadeConferida ?? 1;
  const transferItem = {
    ...item,
    quantidade,
    qtdConferida: quantidade
  };
  return {
    saida: buildBlingStockExitPayload(transferItem, {
      productId,
      depositoId: depositoOrigemId,
      observacao
    }),
    entrada: buildBlingStockEntryPayload(transferItem, {
      productId,
      depositoId: depositoDestinoId,
      observacao
    })
  };
}

export async function syncBlingProducts({ integration, products, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const supplier = await client.prepareSupplierForItems(products);
  const results = [];

  for (const product of products) {
    const existing = await client.findProductBySku(product.sku);
    if (existing?.id) {
      await client.updateProduct(existing.id, buildBlingProductPayload(product));
      await client.ensureProductSupplier(product, existing.id, supplier);
      results.push({ sku: product.sku, status: "updated", blingProductId: existing.id });
      continue;
    }

    const response = await client.createProduct(buildBlingProductPayload(product));
    const blingProductId = response?.data?.id || null;
    if (blingProductId) await client.ensureProductSupplier(product, blingProductId, supplier);
    results.push({ sku: product.sku, status: "created", blingProductId, response });
  }

  return summarizeSync(results);
}

export async function syncBlingStockEntries({ integration, items, depositoName, observacao, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const supplier = await client.prepareSupplierForItems(items);
  const deposito = await client.findDepositByDescription(depositoName);
  if (!deposito?.id) throw new Error(`Deposito Bling nao encontrado: ${depositoName}`);

  const results = [];
  for (const item of items) {
    let product = await client.findProductBySku(item.sku);
    if (!product?.id) {
      const created = await client.createProduct(buildBlingProductPayload(item));
      product = { id: created?.data?.id, codigo: item.sku };
      if (product.id) await client.ensureProductSupplier(item, product.id, supplier);
    } else {
      await client.updateProduct(product.id, buildBlingProductPayload(item));
      await client.ensureProductSupplier(item, product.id, supplier);
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

export async function syncBlingStockBalances({
  integration,
  items,
  depositoName,
  observacao,
  saveIntegration,
  createMissingProducts = true,
  updateExistingProducts = true,
  syncSuppliers = true
}) {
  const client = new BlingApiClient(integration, saveIntegration);
  const supplier = syncSuppliers ? await client.prepareSupplierForItems(items) : null;
  const deposito = await client.findDepositByDescription(depositoName);
  if (!deposito?.id) throw new Error(`Deposito Bling nao encontrado: ${depositoName}`);

  const results = [];
  for (const item of items) {
    let product = await client.findProductBySku(item.sku);
    if (!product?.id) {
      if (!createMissingProducts) {
        results.push({ sku: item.sku, status: "missing", current: 0, target: numberOrZero(item.qtdConferida || item.quantidade), delta: 0 });
        continue;
      }
      const created = await client.createProduct(buildBlingProductPayload(item));
      product = { id: created?.data?.id, codigo: item.sku };
    } else if (updateExistingProducts) {
      await client.updateProduct(product.id, buildBlingProductPayload(item));
    }
    if (!product?.id) throw new Error(`Produto ${item.sku} nao retornou ID no Bling.`);
    if (syncSuppliers) await client.ensureProductSupplier(item, product.id, supplier);

    const target = numberOrZero(item.qtdConferida || item.quantidade);
    const current = await client.getProductStockBalance(product.id, deposito.id);
    const delta = target - current;
    if (delta > 0) {
      const response = await client.createStockEntry(
        buildBlingStockEntryPayload(
          { ...item, quantidade: delta, qtdConferida: delta },
          { productId: product.id, depositoId: deposito.id, observacao }
        )
      );
      results.push({ sku: item.sku, status: "entered", blingProductId: product.id, current, target, delta, response });
      continue;
    }
    if (delta < 0) {
      const response = await client.createStockEntry(
        buildBlingStockExitPayload(
          { ...item, quantidade: Math.abs(delta), qtdConferida: Math.abs(delta) },
          { productId: product.id, depositoId: deposito.id, observacao }
        )
      );
      results.push({ sku: item.sku, status: "exited", blingProductId: product.id, current, target, delta, response });
      continue;
    }
    results.push({ sku: item.sku, status: "unchanged", blingProductId: product.id, current, target, delta: 0 });
  }

  return {
    ...summarizeSync(results),
    adjusted: results.filter((item) => item.status === "entered" || item.status === "exited").length,
    unchanged: results.filter((item) => item.status === "unchanged").length,
    entries: results.filter((item) => item.status === "entered").length,
    exits: results.filter((item) => item.status === "exited").length,
    deposito: { id: deposito.id, descricao: deposito.descricao || depositoName }
  };
}

export async function syncBlingStockMovement({ integration, item, depositoName, operation = "entry", observacao, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const supplier = operation === "entry" ? await client.prepareSupplierForItems([item]) : null;
  const deposito = await client.findDepositByDescription(depositoName);
  if (!deposito?.id) throw new Error(`Deposito Bling nao encontrado: ${depositoName}`);

  let product = await client.findProductBySku(item.sku);
  if (!product?.id && operation === "entry") {
    const created = await client.createProduct(buildBlingProductPayload(item));
    product = { id: created?.data?.id, codigo: item.sku };
    if (product.id) await client.ensureProductSupplier(item, product.id, supplier);
  } else if (product?.id && operation === "entry") {
    await client.updateProduct(product.id, buildBlingProductPayload(item));
    await client.ensureProductSupplier(item, product.id, supplier);
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

export async function deleteBlingProductBySku({ integration, sku, saveIntegration }) {
  const client = new BlingApiClient(integration, saveIntegration);
  const product = await client.findProductBySku(sku);
  if (!product?.id) return { status: "not_found", sku };
  await client.deleteProduct(product.id);
  return { status: "deleted", sku, blingProductId: product.id };
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

    const payloads = buildBlingStockTransferPayload(item, {
      productId: product.id,
      depositoOrigemId: origem.id,
      depositoDestinoId: destino.id,
      observacao
    });
    const saida = await client.createStockEntry(payloads.saida);
    const entrada = await client.createStockEntry(payloads.entrada);
    results.push({ sku: item.sku, status: "transferred", blingProductId: product.id, response: { saida, entrada } });
  }

  return {
    ...summarizeSync(results),
    transferred: results.length,
    depositoOrigem: { id: origem.id, descricao: origem.descricao || depositoOrigemName },
    depositoDestino: { id: destino.id, descricao: destino.descricao || depositoDestinoName }
  };
}

export async function updateBlingProductFromTriage({ integration, item, saveIntegration }) {
  const sku = normalizeCode(item?.sku || item?.productCode || item?.codigoBling2);
  if (!sku) return { ok: false, skipped: true, error: "SKU/codigo do produto nao informado para atualizar no Bling." };
  const client = new BlingApiClient(integration, saveIntegration);
  const product = await client.findProductBySku(sku, { detail: true });
  if (!product?.id) return { ok: false, skipped: true, error: `Produto nao encontrado no Bling: ${sku}` };

  const payload = compactObject({
    ...product,
    nome: product.nome || item.descricao || sku,
    codigo: product.codigo || sku,
    gtin: item.ean || product.gtin || "",
    gtinEmbalagem: item.ean || product.gtinEmbalagem || product.gtin || "",
    marca: item.asin || product.marca || "",
    pesoLiquido: item.pesoCaixa || product.pesoLiquido || product.pesoBruto || "",
    pesoBruto: item.pesoCaixa || product.pesoBruto || product.pesoLiquido || "",
    dimensoes: buildBlingDimensionsPayload(item) || product.dimensoes
  });
  const response = await client.updateProduct(product.id, payload);
  return { ok: true, status: "updated", sku, blingProductId: product.id, response };
}

export async function lookupBlingProductForTriage({ integration, code, saveIntegration }) {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) return null;
  const client = new BlingApiClient(integration, saveIntegration);
  const product = await client.findProductBySku(normalizedCode, { detail: true });
  return product ? blingProductToTriageLookup(product, normalizedCode) : null;
}

export function blingProductToTriageLookup(product = {}, fallbackCode = "") {
  const code = normalizeCode(product.codigo || fallbackCode);
  const ean = String(product.gtin || product.gtinEmbalagem || product.ean || "").trim();
  const asin = normalizeCode(product.marca);
  const dimensoes = product.dimensoes || {};
  const triageDimensions = compactObject({
    alturaCaixa: dimensoes.altura || product.alturaCaixa || "",
    larguraCaixa: dimensoes.largura || product.larguraCaixa || "",
    comprimentoCaixa: dimensoes.profundidade || dimensoes.comprimento || product.comprimentoCaixa || "",
    pesoCaixa: product.pesoBruto || product.pesoLiquido || product.pesoCaixa || ""
  });
  return {
    productCode: code,
    sku: code,
    ean,
    asin,
    codigoBling2: code,
    descricao: product.nome || product.descricaoCurta || product.descricao || code,
    valorUnit: numberOrZero(product.preco ?? product.valorUnit ?? product.precoVenda),
    precoCusto: numberOrZero(product.precoCusto ?? product.precoCompra ?? product.custo),
    categoria: product.categoria?.descricao || product.categoria || "",
    subcategoria: "",
    ...triageDimensions,
    source: "bling",
    sourceLotId: "",
    sourceLotName: "Bling"
  };
}

class BlingApiClient {
  constructor(integration, saveIntegration) {
    if (!integration?.accessToken) throw new Error("Autorize a integracao Bling antes de enviar dados.");
    this.integration = integration;
    this.saveIntegration = saveIntegration;
    this.lastRequestAt = 0;
    this.supplierContactType = null;
  }

  async findProductBySku(sku, { detail = false } = {}) {
    const payload = await this.request("/produtos", {
      query: { "codigos[]": sku, criterio: 5, limite: 1 }
    });
    const product = (payload?.data || []).find((candidate) => normalizeCode(candidate.codigo) === normalizeCode(sku));
    if (!detail || !product?.id) return product || null;
    const detailPayload = await this.request(`/produtos/${encodeURIComponent(product.id)}`);
    return detailPayload?.data || product;
  }

  async createProduct(payload) {
    return this.request("/produtos", { method: "POST", body: payload });
  }

  async updateProduct(productId, payload) {
    return this.request(`/produtos/${encodeURIComponent(productId)}`, { method: "PUT", body: payload });
  }

  async deleteProduct(productId) {
    return this.request(`/produtos/${encodeURIComponent(productId)}`, { method: "DELETE" });
  }

  async prepareSupplierForItems(items = []) {
    const supplierName = (items || []).map((item) => item?.fornecedor).find(Boolean);
    if (!supplierName) return null;
    const supplier = await this.findOrCreateSupplier(supplierName);
    if (!supplier?.id) throw new Error(`Fornecedor Bling nao retornou ID: ${supplierName}`);
    return supplier;
  }

  async ensureProductSupplier(product, productId, supplier = null) {
    if (!product?.fornecedor || !productId) return null;
    supplier = supplier || (await this.findOrCreateSupplier(product.fornecedor));
    if (!supplier?.id) throw new Error(`Fornecedor Bling nao retornou ID: ${product.fornecedor}`);
    const existing = await this.findProductSupplier(productId, supplier.id);
    if (existing?.id) return this.updateProductSupplier(existing.id, buildBlingProductSupplierPayload(product, { productId, supplierId: supplier.id }));
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
    const supplierType = await this.findSupplierContactType();
    if (!supplierType?.id) throw new Error("Tipo de contato Fornecedor nao encontrado no Bling.");
    const payload = await this.request("/contatos", {
      query: { pesquisa: name, limite: 100 }
    });
    const existing = (payload?.data || []).find((contact) => normalizeText(contact.nome) === normalized);
    if (existing?.id) return this.ensureSupplierContactType(existing, supplierType);

    const created = await this.request("/contatos", {
      method: "POST",
      body: buildBlingSupplierContactPayload(name, supplierType)
    });
    return created?.data || null;
  }

  async findSupplierContactType() {
    if (this.supplierContactType) return this.supplierContactType;
    const payload = await this.request("/contatos/tipos");
    this.supplierContactType = (payload?.data || []).find((type) => normalizeText(type.descricao) === "fornecedor") || null;
    return this.supplierContactType;
  }

  async ensureSupplierContactType(contact, supplierType) {
    if (!contact?.id || !supplierType?.id) return contact;
    const detail = await this.request(`/contatos/${encodeURIComponent(contact.id)}`);
    const fullContact = detail?.data || contact;
    const currentTypes = Array.isArray(fullContact.tiposContato) ? fullContact.tiposContato : [];
    if (currentTypes.some((type) => String(type.id) === String(supplierType.id) || normalizeText(type.descricao) === "fornecedor")) return fullContact;

    await this.request(`/contatos/${encodeURIComponent(contact.id)}`, {
      method: "PUT",
      body: buildBlingSupplierContactPayload(fullContact.nome || contact.nome, supplierType, fullContact)
    });
    return { ...fullContact, tiposContato: mergeContactTypes(currentTypes, supplierType) };
  }

  async createProductSupplier(payload) {
    return this.request("/produtos/fornecedores", { method: "POST", body: payload });
  }

  async updateProductSupplier(productSupplierId, payload) {
    return this.request(`/produtos/fornecedores/${encodeURIComponent(productSupplierId)}`, { method: "PUT", body: payload });
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

  async getProductStockBalance(productId, depositoId) {
    try {
      const payload = await this.request(`/estoques/saldos/${encodeURIComponent(depositoId)}`, {
        query: { "idsProdutos[]": productId }
      });
      return stockBalanceFromPayload(payload, productId);
    } catch (error) {
      const payload = await this.request("/estoques/saldos", {
        query: { "idsProdutos[]": productId }
      });
      return stockBalanceFromPayload(payload, productId);
    }
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
    updated: results.filter((item) => item.status === "updated").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    missing: results.filter((item) => item.status === "missing").length,
    entered: results.filter((item) => item.status === "entered").length,
    exited: results.filter((item) => item.status === "exited").length,
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

function buildBlingDimensionsPayload(product = {}) {
  const altura = numberOrEmpty(product.alturaCaixa ?? product.altura);
  const largura = numberOrEmpty(product.larguraCaixa ?? product.largura);
  const profundidade = numberOrEmpty(product.comprimentoCaixa ?? product.comprimento ?? product.profundidade);
  if (altura === "" && largura === "" && profundidade === "") return undefined;
  return compactObject({
    largura,
    altura,
    profundidade,
    unidadeMedida: 1
  });
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
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

function numberOrEmpty(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : "";
}

function mergeContactTypes(types = [], supplierType) {
  const merged = Array.isArray(types) ? [...types] : [];
  if (!supplierType?.id) return merged;
  if (!merged.some((type) => String(type.id) === String(supplierType.id) || normalizeText(type.descricao) === "fornecedor")) {
    merged.push({ id: Number(supplierType.id), descricao: supplierType.descricao || "Fornecedor" });
  }
  return merged;
}

function stockBalanceFromPayload(payload, productId) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const row = rows.find((item) => {
    return String(item.produto?.id || item.idProduto || item.produtoId || item.id || "") === String(productId);
  }) || rows[0] || {};
  const value = row.saldoFisico ?? row.saldoFisicoTotal ?? row.saldo ?? row.quantidade ?? row.estoque ?? 0;
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
