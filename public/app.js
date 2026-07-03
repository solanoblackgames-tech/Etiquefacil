const state = {
  user: null,
  adminUsers: [],
  adminLots: [],
  adminCatalogRequests: [],
  adminCatalogRejectedRequests: [],
  adminCatalogProducts: [],
  adminCatalogRequestFilters: {
    creator: "",
    date: "",
    doubleCheckOnly: false
  },
  blingIntegration: null,
  operators: [],
  operatorDateFilter: null,
  transferLots: [],
  selectedTransferLotId: null,
  triageItems: [],
  selectedTriageCode: null,
  blingDeposits: [],
  blingDepositsLoaded: false,
  profileSection: "entries",
  lots: [],
  selectedLotId: null,
  previewLotId: null,
  selectedDiverseLotId: null,
  selectedDiverseLot: null,
  selectedDiverseRz: null,
  noSheetSuggestionTimer: null,
  selectedRz: null,
  scanOnly: false,
  transferReceiveOnly: false,
  transferCameraStream: null,
  transferCameraTimer: null,
  lastCameraCode: "",
  lastCameraScanAt: 0,
  pendingTransferReceive: false,
  pendingTransferConfirmation: null,
  operatorInviteToken: null,
  pendingScan: false,
  pendingDecrement: false,
  labelProduct: null,
  labelMeta: null,
  labelPrintMarkup: "",
  labelQuantity: 1,
  labelReturnFocusSelectors: null,
  config: { downloadMode: "local" },
  labelOptions: {
    autoPrint: localStorage.getItem("etiquefacil.autoPrint") !== "false",
    includePrice: localStorage.getItem("etiquefacil.includePrice") !== "false",
    suggestPrice: localStorage.getItem("etiquefacil.suggestPrice") === "true",
    includeText: localStorage.getItem("etiquefacil.includeText") === "true",
    customText: localStorage.getItem("etiquefacil.customText") || ""
  }
};

const $ = (selector) => document.querySelector(selector);
const LABEL_PRINT_FALLBACK_MS = 15000;
let labelPrintFallbackTimer = null;
const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleDateString("pt-BR");
};
const formatDateTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--"
    : date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const formatInputDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
const routePath = (path) => `${window.location.origin}${path}`;
const normalizeCodigoMl = (value) => String(value || "").trim().toUpperCase();

await bootstrap();

async function bootstrap() {
  bindEvents();
  state.config = await api("/api/config");
  const operatorInviteRequest = getOperatorInviteRequest();
  if (operatorInviteRequest) {
    await showOperatorInviteAuth(operatorInviteRequest);
    return;
  }
  const transferReceiveRequest = getTransferReceiveRequest();
  if (transferReceiveRequest) {
    await showTransferReceiveOnly(transferReceiveRequest);
    return;
  }
  const me = await api("/api/me");
  if (me.user) showApp(me.user);
  else showAuth();
}

function bindEvents() {
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAuth("/api/login", event.currentTarget);
  });

  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAuth("/api/register", event.currentTarget);
  });

  $("#operatorInviteForm").addEventListener("submit", acceptOperatorInvite);

  $("#logoutButton").addEventListener("click", async () => {
    await logout();
  });

  $("#adminLogoutButton").addEventListener("click", async () => {
    await logout();
  });

  $("#adminCreateUserForm").addEventListener("submit", createAdminUser);

  $("#adminRefreshButton").addEventListener("click", loadAdminUsers);
  $("#adminLotsRefreshButton").addEventListener("click", loadAdminLots);
  $("#adminCatalogRefreshButton").addEventListener("click", loadAdminCatalogReviewLists);
  $("#adminCatalogSearchForm").addEventListener("submit", loadAdminCatalogProducts);

  $("#adminUsers").addEventListener("click", handleAdminUsersClick);
  $("#adminCatalogRequests").addEventListener("click", handleAdminCatalogRequestsClick);
  $("#adminCatalogRequests").addEventListener("submit", handleAdminCatalogRequestsFilter);
  $("#adminCatalogRequests").addEventListener("change", handleAdminCatalogRequestsChange);
  $("#adminCatalogProducts").addEventListener("click", handleAdminCatalogProductsClick);

  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => setAdminTab(button.dataset.adminTab));
  });

  $("#adminUsers").addEventListener("submit", handleAdminPasswordSubmit);

  $("#adminUsers").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches('input[name="password"]')) {
      event.preventDefault();
      event.target.closest("form")?.requestSubmit();
    }
  });

  $("#uploadForm").addEventListener("submit", uploadLot);

  window.addEventListener("popstate", () => {
    if (state.transferReceiveOnly) {
      const transferReceiveRequest = getTransferReceiveRequest();
      if (transferReceiveRequest) showTransferReceiveOnly(transferReceiveRequest);
      else window.location.href = "/";
      return;
    }
    if (state.user && !state.scanOnly) applyRouteFromLocation();
  });

  document.querySelectorAll("#app [data-tab]").forEach((button) => {
    button.addEventListener("click", () => setMainTab(button.dataset.tab, { resetSelection: true }));
  });

  $("#diverseLotForm").addEventListener("submit", createDiverseLot);
  $("#diverseRzForm").addEventListener("submit", createDiverseRz);
  $("#diverseRzList").addEventListener("click", handleDiverseRzClick);
  $("#diverseScanForm").addEventListener("submit", addDiverseItem);
  $("#noSheetSuggestionUploadForm").addEventListener("submit", uploadNoSheetSuggestions);
  $("#generateCodigoMlButton").addEventListener("click", generateRandomCodigoMlForNoSheet);
  $("#diverseItems").addEventListener("click", handleDiverseItemsClick);
  $("#diverseDownloadButton").addEventListener("click", () => {
    if (state.selectedDiverseLotId) downloadBling(state.selectedDiverseLotId, "complete", "#diverseScanMessage");
  });
  $("#diverseDownloadRzButton").addEventListener("click", () => {
    if (state.selectedDiverseLotId && state.selectedDiverseRz) downloadDiverseRzBling(state.selectedDiverseLotId, state.selectedDiverseRz);
  });
  $("#searchForm").addEventListener("submit", searchMl);
  $("#transferLotForm").addEventListener("submit", createTransferLot);
  $("#transferLots").addEventListener("click", handleTransferLotsClick);
  $("#transferDetail").addEventListener("submit", handleTransferDetailSubmit);
  $("#transferDetail").addEventListener("click", handleTransferDetailClick);
  $("#triageCreateForm").addEventListener("submit", createTriageItem);
  $("#triageCreateForm input[name='lookupCode']").addEventListener("change", lookupTriageCode);
  $("#triageCreateForm input[name='lookupCode']").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    lookupTriageCode();
  });
  $("#triageItems").addEventListener("click", handleTriageItemsClick);
  $("#triageDetail").addEventListener("submit", handleTriageDetailSubmit);
  $("#triageDetail").addEventListener("click", handleTriageDetailClick);
  $("#lotDetail").addEventListener("submit", handleLotDetailSubmit);
  $("#blingIntegrationDelete").addEventListener("click", deleteBlingIntegration);
  $("#operatorForm").addEventListener("submit", createOperator);
  $("#operatorInviteButton").addEventListener("click", generateOperatorInvite);
  $("#operatorManualToggle").addEventListener("click", toggleOperatorManualForm);
  $("#operatorInviteCopyButton").addEventListener("click", copyOperatorInviteLink);
  $("#operatorList").addEventListener("submit", handleOperatorFilterSubmit);
  $("#operatorList").addEventListener("submit", handleOperatorPasswordSubmit);
  $("#operatorList").addEventListener("change", handleOperatorFilterChange);
  $("#operatorList").addEventListener("click", handleOperatorFilterClick);
  document.querySelectorAll("[data-profile-section]").forEach((button) => {
    button.addEventListener("click", () => setProfileSection(button.dataset.profileSection));
  });
  document.addEventListener("input", handleCodigoMlInput);
  document.addEventListener("change", handleNoSheetCostModeChange);

  $("#labelPrintButton").addEventListener("click", printCurrentLabel);
  $("#labelCloseButton").addEventListener("click", () => hideLabelPreview());
  $("#labelModal").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      printCurrentLabel();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideLabelPreview();
    }
  });
  window.addEventListener("afterprint", finishLabelPrint);
  bindPrintCloseFallback();
}

function handleCodigoMlInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.name !== "codigoMl" && input.id !== "scanInput") return;

  const start = input.selectionStart;
  const end = input.selectionEnd;
  const upper = input.value.toUpperCase();
  if (input.value === upper) return;
  input.value = upper;
  if (start !== null && end !== null) input.setSelectionRange(start, end);
}

async function submitAuth(url, form) {
  try {
    $("#authMessage").textContent = "";
    const payload = Object.fromEntries(new FormData(form));
    const response = await api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    showApp(response.user);
  } catch (error) {
    $("#authMessage").textContent = error.message;
  }
}

function getOperatorInviteRequest() {
  const match = window.location.pathname.match(/^\/operadores\/cadastro\/([^/]+)$/);
  return match ? { token: decodeURIComponent(match[1]) } : null;
}

async function showOperatorInviteAuth({ token }) {
  state.operatorInviteToken = token;
  $("#auth").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#adminApp").classList.add("hidden");
  $("#operatorInviteAuth").classList.remove("hidden");
  $("#operatorInviteMessage").textContent = "";
  $("#operatorInviteForm").classList.add("hidden");

  try {
    const response = await api(`/api/operator-invites/${encodeURIComponent(token)}`);
    $("#operatorInviteDetails").textContent = `${response.invite.ownerName} enviou um convite. O link expira em ${formatDateTime(response.invite.expiresAt)}.`;
    $("#operatorInviteForm").classList.remove("hidden");
    schedulePrimaryInputFocus(["#operatorInviteForm input[name='name']"]);
  } catch (error) {
    $("#operatorInviteDetails").textContent = "";
    $("#operatorInviteMessage").textContent = error.message;
  }
}

async function acceptOperatorInvite(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  $("#operatorInviteMessage").textContent = "";
  button.disabled = true;
  try {
    const response = await api(`/api/operator-invites/${encodeURIComponent(state.operatorInviteToken)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    history.replaceState(null, "", "/lotes");
    await showApp(response.user);
  } catch (error) {
    $("#operatorInviteMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function uploadLot(event) {
  event.preventDefault();
  $("#uploadMessage").textContent = "";
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await api("/api/lots", {
      method: "POST",
      body: new FormData(form)
    });
    form.reset();
    $("#uploadMessage").textContent = `Lote importado: ${response.lot.nomeArquivo}`;
    await loadLots(response.lot.id);
  } catch (error) {
    $("#uploadMessage").textContent = error.message;
  } finally {
    button.disabled = false;
    schedulePrimaryInputFocus(["#uploadForm input[name='file']"]);
  }
}

async function createDiverseLot(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await createNoSheetLotFromForm(form, {
    messageSelector: "#diverseLotMessage",
    successMessage: "Lote criado. Pode comecar a bipar."
  });
}

async function handleLotDetailSubmit(event) {
  if (event.target.id !== "noSheetLotForm") return;
  event.preventDefault();
  await createNoSheetLotFromForm(event.target, {
    messageSelector: "#noSheetLotMessage",
    successMessage: "Lote sem planilha criado. Pode comecar a bipar."
  });
}

async function createNoSheetLotFromForm(form, { messageSelector, successMessage }) {
  updateNoSheetCostFields(form);
  const button = form.querySelector("button[type='submit']");
  const message = $(messageSelector);
  $("#diverseLotMessage").textContent = "";
  if (message) {
    message.textContent = "";
    message.style.color = "";
  }
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    const response = await api("/api/diverse-lots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.selectedDiverseLotId = response.lot.id;
    if (message) {
      message.style.color = "#0f766e";
      message.textContent = successMessage;
    }
    form.reset();
    updateNoSheetCostFields(form);
    await loadLots(response.lot.id);
    updateRoute(lotPath(response.lot.id));
    $("#rzSearchInput")?.focus();
  } catch (error) {
    if (message) {
      message.style.color = "";
      message.textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
}

function handleNoSheetCostModeChange(event) {
  if (event.target?.name !== "costMode") return;
  const form = event.target.closest("form");
  if (form) updateNoSheetCostFields(form);
}

function updateNoSheetCostFields(form) {
  const mode = form.querySelector('[name="costMode"]')?.value === "variable" ? "variable" : "fixed";
  const fixed = form.querySelector('[data-cost-field="fixed"]');
  const variable = form.querySelector('[data-cost-field="variable"]');
  const averageCost = form.querySelector('[name="averageCost"]');
  const costPercent = form.querySelector('[name="costPercent"]');
  fixed?.classList.toggle("hidden", mode !== "fixed");
  variable?.classList.toggle("hidden", mode !== "variable");
  if (averageCost) averageCost.required = mode === "fixed";
  if (costPercent) costPercent.required = mode === "variable";
}

async function addDiverseItem(event) {
  event.preventDefault();
  if (!state.selectedDiverseLotId) return;
  const form = event.currentTarget;
  const input = form.querySelector("input[name='codigoMl']");
  const button = form.querySelector("button");
  const codigoMl = normalizeCodigoMl(input.value);
  input.value = codigoMl;
  const codigoRz = state.selectedDiverseRz;
  if (!codigoMl || !codigoRz) return;

  $("#diverseScanMessage").textContent = "";
  button.disabled = true;
  try {
    let valorUnitOverride;
    if (state.labelOptions.suggestPrice) {
      const preview = await previewDiverseItem(codigoMl, codigoRz);
      if (preview.status === "preview") {
        const product = preview.product || {};
        valorUnitOverride = await askPriceSuggestion({ codigoMl, product });
        if (valorUnitOverride === null) return;
      }
    }

    const response = await createDiverseItem({ codigoMl, codigoRz, valorUnitOverride });
    input.value = "";
    renderDiverseLot(response.lot);
    const parent = response.parent?.lot?.nomeArquivo ? ` Pai: ${response.parent.lot.nomeArquivo}.` : "";
    await refreshLotsList(response.lot.id);
    await showDiverseBlingSyncStatus(response, diverseScanStatusMessage(response, codigoRz, parent));
    if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true, meta: labelMeta() });
    schedulePrimaryInputFocus(["#diverseScanForm input[name='codigoMl']"]);
  } catch (error) {
    if (error.code === "manual_required" || error.status === 404) {
      try {
        const manualProduct = await promptManualProduct(codigoMl);
        if (!manualProduct) {
          input.select();
          return;
        }
        const response = await createDiverseItem({ codigoMl, codigoRz, manualProduct });
        input.value = "";
        renderDiverseLot(response.lot);
        await refreshLotsList(response.lot.id);
        await showDiverseBlingSyncStatus(response, `SKU ${response.product.sku} gerado e enviado para sugestao do banco historico.`);
        if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true, meta: labelMeta() });
        schedulePrimaryInputFocus(["#diverseScanForm input[name='codigoMl']"]);
        return;
      } catch (manualError) {
        $("#diverseScanMessage").style.color = "";
        $("#diverseScanMessage").textContent = manualError.message;
        input.select();
        return;
      }
    }
    $("#diverseScanMessage").style.color = "";
    $("#diverseScanMessage").textContent = error.message;
    input.select();
  } finally {
    button.disabled = false;
  }
}

async function loadNoSheetSuggestionMatches(query) {
  if (!state.selectedDiverseLotId) return [];
  const response = await api(`/api/lots/${encodeURIComponent(state.selectedDiverseLotId)}/no-sheet-suggestions?q=${encodeURIComponent(query)}`);
  return response.suggestions || [];
}

function renderManualDescriptionSuggestions(suggestions) {
  const menu = $("#manualProductDescriptionSuggestions");
  if (!menu || !suggestions.length) {
    hideManualDescriptionSuggestions();
    return;
  }
  menu.innerHTML = suggestions.map((suggestion, index) => `
    <button type="button" data-manual-description-suggestion="${index}">
      <strong>${escapeHtml(suggestion.descricao)}</strong>
      <span>${suggestion.source === "lista_lote" ? "Lista do lote" : `Historico ${suggestion.codigoMl || ""}`}</span>
    </button>
  `).join("");
  menu._suggestions = suggestions;
  menu.classList.remove("hidden");
}

function hideManualDescriptionSuggestions() {
  const menu = $("#manualProductDescriptionSuggestions");
  if (!menu) return;
  menu.classList.add("hidden");
  menu.innerHTML = "";
  menu._suggestions = [];
}

async function uploadNoSheetSuggestions(event) {
  event.preventDefault();
  if (!state.selectedDiverseLotId) return;
  await uploadNoSheetSuggestionsFromForm(event.currentTarget, $("#noSheetSuggestionUploadStatus"), state.selectedDiverseLotId);
}

async function uploadNoSheetSuggestionsFromForm(form, status, lotId) {
  const file = form.querySelector("input[type='file']")?.files?.[0];
  if (!file) {
    status.textContent = "Selecione um arquivo.";
    return;
  }
  status.textContent = "Enviando...";
  try {
    const body = new FormData();
    body.append("file", file);
    const response = await api(`/api/lots/${encodeURIComponent(lotId)}/no-sheet-suggestions`, {
      method: "POST",
      body
    });
    state.selectedDiverseLot = response.lot;
    form.reset();
    status.textContent = `${response.suggestions.length} nomes carregados.`;
    if (state.selectedDiverseLotId === lotId) renderDiverseLot(response.lot);
    await refreshLotsList(lotId);
    return response;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function showDiverseBlingSyncStatus(response, baseMessage) {
  const message = $("#diverseScanMessage");
  try {
    if (response.bling?.ok === false) throw new Error(response.bling.error || "Erro ao sincronizar produto.");
    const bling = response.bling || await syncDiverseProductToBling(response.lot.id, response.product.id);
    message.style.color = "#0f766e";
    message.textContent = `${baseMessage} ${blingProductSyncMessage(bling)}`;
  } catch (error) {
    message.style.color = "";
    message.textContent = `${baseMessage} Produto nao criado no Bling: ${error.message}`;
  }
}

function syncDiverseProductToBling(lotId, productId) {
  return api(`/api/lots/${encodeURIComponent(lotId)}/products/${encodeURIComponent(productId)}/bling/sync`, {
    method: "POST"
  });
}

function blingProductSyncMessage(result) {
  const item = (result.results || [])[0];
  if (item?.status === "entered") return `Produto sincronizado e saldo lancado no deposito ${result.deposito?.descricao || "Geral"}.`;
  if (item?.status === "created") return "Produto criado no Bling.";
  if (item?.status === "updated") return "Produto atualizado no Bling.";
  return "Produto sincronizado no Bling.";
}

async function previewDiverseItem(codigoMl, codigoRz) {
  return api(`/api/lots/${encodeURIComponent(state.selectedDiverseLotId)}/diverse-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codigoMl, codigoRz, preview: true })
  });
}

async function createDiverseItem({ codigoMl, codigoRz, manualProduct, valorUnitOverride }) {
  return api(`/api/lots/${encodeURIComponent(state.selectedDiverseLotId)}/diverse-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codigoMl, codigoRz, manualProduct, valorUnitOverride })
  });
}

function promptManualProduct(codigoMl, focusSelector, initialValues = {}) {
  return askManualProduct(codigoMl, focusSelector, initialValues);
}

function parseMoneyInput(value) {
  return Number(normalizeMoneyText(value));
}

function normalizeMoneyText(value) {
  const clean = String(value || "").trim().replace(/[^\d,.-]/g, "");
  if (clean.includes(",") && clean.includes(".")) {
    return clean.lastIndexOf(",") > clean.lastIndexOf(".")
      ? clean.replace(/\./g, "").replace(",", ".")
      : clean.replace(/,/g, "");
  }
  if (clean.includes(",")) return clean.replace(",", ".");
  if (!clean.includes(".")) return clean;
  const parts = clean.split(".");
  if (parts.length === 2 && parts[1].length === 3 && parts[0].length > 3) return clean;
  if (parts.length > 1 && parts.slice(1).every((part) => part.length === 3)) return clean.replace(/\./g, "");
  return clean;
}

function askPriceSuggestion({ codigoMl, product }) {
  return openDecisionModal({
    title: "Conferir preco",
    rows: [
      ["Codigo ML", codigoMl],
      ["Produto", product.descricao || "Descricao nao encontrada"],
      ["Preco atual do banco", money(product.valorUnit)]
    ],
    fields: [{ name: "valorUnit", label: "Novo preco para este lote/usuario", value: String(product.valorUnit || "").replace(".", ","), hidden: true }],
    actions: [
      { id: "no", label: "Nao alterar", primary: true, value: { changed: false } },
      { id: "yes", label: "Alterar preco", value: { changed: true }, showFields: ["valorUnit"] },
      { id: "cancel", label: "Cancelar", value: null }
    ],
    onSubmit: (action, values) => {
      if (action === null) return null;
      if (!action.changed) return undefined;
      const price = parseMoneyInput(values.valorUnit);
      if (!Number.isFinite(price) || price <= 0) throw new Error("Preco informado invalido.");
      return price;
    }
  });
}

function askManualProduct(codigoMl, focusSelector, initialValues = {}) {
  return openManualProductModal(codigoMl, focusSelector, initialValues);
}

function openManualProductModal(codigoMl, focusSelector = "#diverseScanForm input[name='codigoMl']", initialValues = {}) {
  return new Promise((resolve) => {
    const modal = $("#manualProductModal");
    const form = $("#manualProductForm");
    const code = $("#manualProductCode");
    const description = $("#manualProductDescription");
    const price = $("#manualProductPrice");
    const ean = $("#manualProductEan");
    const link = $("#manualProductLink");
    const photo = $("#manualProductPhoto");
    const descriptionSuggestions = $("#manualProductDescriptionSuggestions");
    const error = $("#manualProductError");
    const cancel = $("#manualProductCancel");

    const cleanup = () => {
      modal.classList.add("hidden");
      form.onsubmit = null;
      description.oninput = null;
      descriptionSuggestions.onclick = null;
      ean.onkeydown = null;
      cancel.onclick = null;
      modal.onkeydown = null;
      hideManualDescriptionSuggestions();
      form.reset();
      error.textContent = "";
      setTimeout(() => $(focusSelector)?.focus(), 0);
    };

    code.textContent = codigoMl;
    form.reset();
    description.value = initialValues.descricao || "";
    price.value = initialValues.valorUnit ? String(initialValues.valorUnit).replace(".", ",") : "";
    ean.value = initialValues.ean || "";
    link.value = initialValues.link || "";
    photo.value = initialValues.foto || "";
    error.textContent = "";
    modal.classList.remove("hidden");

    description.oninput = () => {
      const query = description.value.trim();
      window.clearTimeout(state.noSheetSuggestionTimer);
      if (query.length < 2) {
        hideManualDescriptionSuggestions();
        return;
      }
      state.noSheetSuggestionTimer = window.setTimeout(async () => {
        try {
          renderManualDescriptionSuggestions(await loadNoSheetSuggestionMatches(query));
        } catch {
          hideManualDescriptionSuggestions();
        }
      }, 220);
    };

    descriptionSuggestions.onclick = (event) => {
      const button = event.target.closest("[data-manual-description-suggestion]");
      if (!button) return;
      const suggestion = descriptionSuggestions._suggestions?.[Number(button.dataset.manualDescriptionSuggestion)];
      if (!suggestion) return;
      description.value = suggestion.descricao || "";
      if (suggestion.source !== "lista_lote") {
        if (suggestion.valorUnit) price.value = String(suggestion.valorUnit).replace(".", ",");
        if (suggestion.ean) ean.value = suggestion.ean;
        if (suggestion.link) link.value = suggestion.link;
        if (suggestion.foto) photo.value = suggestion.foto;
      }
      hideManualDescriptionSuggestions();
      price.focus();
    };

    form.onsubmit = (event) => {
      event.preventDefault();
      const descricao = description.value.trim();
      const valorUnit = parseMoneyInput(price.value);
      if (!descricao) {
        error.textContent = "Informe o nome/descricao do produto.";
        description.focus();
        return;
      }
      if (!Number.isFinite(valorUnit) || valorUnit <= 0) {
        error.textContent = "Informe um preco valido.";
        price.focus();
        return;
      }
      const result = {
        descricao,
        valorUnit,
        ean: ean.value.trim(),
        link: link.value.trim(),
        foto: photo.value.trim()
      };
      cleanup();
      resolve(result);
    };

    cancel.onclick = () => {
      cleanup();
      resolve(null);
    };

    ean.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        form.requestSubmit();
      }
    };

    modal.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    };

    setTimeout(() => description.focus(), 0);
  });
}

function openDecisionModal({ title, rows = [], fields = [], actions = [], onSubmit }) {
  return new Promise((resolve) => {
    const modal = $("#decisionModal");
    const titleEl = $("#decisionTitle");
    const bodyEl = $("#decisionBody");
    const fieldsEl = $("#decisionFields");
    const actionsEl = $("#decisionActions");
    let activeAction = actions.find((action) => action.primary) || actions[0];

    const cleanup = () => {
      modal.classList.add("hidden");
      modal.onkeydown = null;
      actionsEl.onclick = null;
      fieldsEl.oninput = null;
      titleEl.textContent = "";
      bodyEl.innerHTML = "";
      fieldsEl.innerHTML = "";
      actionsEl.innerHTML = "";
      setTimeout(() => $("#diverseScanForm input[name='codigoMl']")?.focus(), 0);
    };

    const submit = (action) => {
      try {
        const values = Object.fromEntries([...fieldsEl.querySelectorAll("input")].map((input) => [input.name, input.value]));
        const result = onSubmit ? onSubmit(action.value, values) : action.value;
        cleanup();
        resolve(result);
      } catch (error) {
        const message = fieldsEl.querySelector(".message") || document.createElement("p");
        message.className = "message";
        message.textContent = error.message;
        fieldsEl.appendChild(message);
      }
    };

    titleEl.textContent = title;
    bodyEl.innerHTML = rows
      .map(([label, value]) => `
        <div class="decision-body-row">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `)
      .join("");
    fieldsEl.innerHTML = fields
      .map((field) => `
        <label class="${field.hidden ? "hidden" : ""}" data-field-name="${escapeHtml(field.name)}">
          ${escapeHtml(field.label)}
          <input name="${escapeHtml(field.name)}" value="${escapeHtml(field.value || "")}" placeholder="${escapeHtml(field.placeholder || "")}" ${field.required ? "required" : ""} />
        </label>
      `)
      .join("");
    actionsEl.innerHTML = actions
      .map((action) => `<button type="button" class="${action.primary ? "" : "ghost"}" data-decision-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`)
      .join("");

    const updateVisibleFields = () => {
      const visible = new Set(activeAction?.showFields || []);
      fields.forEach((field) => {
        const wrapper = [...fieldsEl.querySelectorAll("[data-field-name]")].find((item) => item.dataset.fieldName === field.name);
        wrapper?.classList.toggle("hidden", !visible.has(field.name) && field.hidden);
      });
    };

    actionsEl.onclick = (event) => {
      const button = event.target.closest("[data-decision-action]");
      if (!button) return;
      const action = actions.find((item) => item.id === button.dataset.decisionAction);
      if (!action) return;
      if (action.showFields && activeAction?.id !== action.id) {
        activeAction = action;
        updateVisibleFields();
        fieldsEl.querySelector(`[name="${action.showFields[0]}"]`)?.focus();
        return;
      }
      submit(action);
    };

    modal.onkeydown = (event) => {
      if (event.key === "Enter") {
        const target = event.target;
        if (target?.tagName === "INPUT") {
          const visibleRequired = [...fieldsEl.querySelectorAll("label:not(.hidden) input[required]")];
          const hasEmptyRequired = visibleRequired.some((input) => !String(input.value || "").trim());
          if (hasEmptyRequired) return;
        }
        event.preventDefault();
        submit(activeAction);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        submit({ value: null });
      }
    };

    updateVisibleFields();
    modal.classList.remove("hidden");
    modal.focus();
    const firstVisibleInput = fieldsEl.querySelector("label:not(.hidden) input");
    const primaryButton = actionsEl.querySelector("[data-decision-action]");
    (firstVisibleInput || primaryButton)?.focus();
  });
}

function createDiverseRz(event) {
  event.preventDefault();
  const codigoRz = nextNoSheetRzCode(state.selectedDiverseLot);
  if (!codigoRz) return;
  setDiverseRz(codigoRz);
  $("#diverseScanMessage").style.color = "#0f766e";
  $("#diverseScanMessage").textContent = `Remessa ${codigoRz} ativa.`;
  $("#diverseScanForm input[name='codigoMl']").focus();
}

function handleDiverseRzClick(event) {
  const button = event.target.closest("[data-diverse-rz]");
  if (!button) return;
  setDiverseRz(button.dataset.diverseRz);
  $("#diverseScanMessage").style.color = "#0f766e";
  $("#diverseScanMessage").textContent = `Remessa ${button.dataset.diverseRz} ativa.`;
  $("#diverseScanForm input[name='codigoMl']").focus();
}

function setDiverseRz(codigoRz) {
  state.selectedDiverseRz = normalizeCode(codigoRz);
  renderDiverseRzControls(state.selectedDiverseLot);
}

function renderDiverseLot(lot) {
  state.selectedDiverseLotId = lot.id;
  state.selectedDiverseLot = lot;
  const rzs = diverseRzs(lot);
  if (state.selectedDiverseRz && rzs.length && !rzs.some((rz) => rz.codigoRz === state.selectedDiverseRz)) state.selectedDiverseRz = null;
  if (!state.selectedDiverseRz) state.selectedDiverseRz = rzs[0]?.codigoRz || defaultDiverseRz(lot);
  mountDiversePanelForCurrentView();
  $("#diverseScanPanel").classList.remove("hidden");
  $("#diverseLotTitle").textContent = `${lot.nomeArquivo} · proximo ${lot.prefixoSku}${String(lot.proximoSequencialSku).padStart(4, "0")}`;
  renderDiverseRzControls(lot);
  $("#diverseLabelOptions").innerHTML = diverseLabelOptionsMarkup();
  bindDiverseLabelOptions();
  $("#diverseItems").innerHTML = diverseItemsTable(lot);
  $("#noSheetSuggestionUploadStatus").textContent = lot.noSheetSuggestions?.length ? `${lot.noSheetSuggestions.length} nomes na lista.` : "";
  schedulePrimaryInputFocus();
}

function hideNoSheetPanel() {
  state.selectedDiverseLotId = null;
  state.selectedDiverseLot = null;
  state.selectedDiverseRz = null;
  $("#diverseScanPanel")?.classList.add("hidden");
  moveDiversePanelToHome();
  const message = $("#diverseLotMessage");
  if (message) message.textContent = "";
}

function mountDiversePanelForCurrentView() {
  const panel = $("#diverseScanPanel");
  const mount = $("#diversePanelMount");
  if (panel && mount && panel.parentElement !== mount) {
    mount.appendChild(panel);
  }
}

function moveDiversePanelToHome() {
  const panel = $("#diverseScanPanel");
  const message = $("#diverseLotMessage");
  if (panel && message && panel.parentElement !== message.parentElement) {
    message.insertAdjacentElement("afterend", panel);
  }
}

function isNoSheetLot(lot) {
  if (!lot) return false;
  if (Number(lot.custoMedioUnitario || 0) > 0 && Number(lot.percentualArremate || 0) === 0) return true;
  if ((lot.tipoCusto === "variable" || Number(lot.percentualCusto || 0) > 0) && Number(lot.percentualArremate || 0) === 0) return true;
  return (lot.products || []).some((product) => product.origem === "lote_sem_planilha" || product.origem === "lote_sem_planilha_manual" || product.origem === "entrada_diversos");
}

function renderDiverseRzControls(lot) {
  const active = state.selectedDiverseRz;
  $("#diverseNextRz").textContent = `Proxima RZ: ${nextNoSheetRzCode(lot)}`;
  $("#diverseActiveRz").textContent = active ? `Remessa ativa: ${active}` : "Nenhuma remessa ativa";
  $("#diverseDownloadRzButton").disabled = !active;
  $("#diverseScanForm input[name='codigoMl']").disabled = !active;
  $("#diverseScanForm button[type='submit']").disabled = !active;
  $("#generateCodigoMlButton").disabled = !active;
  $("#diverseRzList").innerHTML = diverseRzsWithActive(lot)
    .map((rz) => `
      <button type="button" class="${rz.codigoRz === active ? "active" : ""}" data-diverse-rz="${escapeHtml(rz.codigoRz)}">
        ${escapeHtml(rz.codigoRz)} <span>${rz.items}</span>
      </button>
    `)
    .join("");
}

function diverseRzsWithActive(lot) {
  const rzs = diverseRzs(lot);
  const active = state.selectedDiverseRz;
  if (active && !rzs.some((rz) => rz.codigoRz === active)) {
    return [{ codigoRz: active, items: 0 }, ...rzs];
  }
  return rzs;
}

function diverseRzs(lot) {
  const byRz = new Map();
  for (const item of lot?.items || []) {
    if (!isNoSheetItem(item)) continue;
    const current = byRz.get(item.codigoRz) || { codigoRz: item.codigoRz, items: 0 };
    current.items += item.qtdEsperada || 0;
    byRz.set(item.codigoRz, current);
  }
  return [...byRz.values()].sort((a, b) => a.codigoRz.localeCompare(b.codigoRz));
}

function defaultDiverseRz(lot) {
  const base = normalizeCode(lot?.nomeArquivo || lot?.prefixoSku || "RZ1").replace(/[^A-Z0-9]+/g, "");
  return base.slice(0, 24) || "RZ1";
}

function nextNoSheetRzCode(lot) {
  const lotCode = noSheetLotRzPrefix(lot);
  const operatorCode = noSheetOperatorRzCode();
  const base = `${lotCode}-${operatorCode}`;
  const usedSequences = new Set();

  for (const rz of diverseRzsWithActive(lot)) {
    const code = normalizeCode(rz.codigoRz);
    if (!code.startsWith(`${base}-`)) continue;
    const match = code.slice(base.length + 1).match(/^(\d+)$/);
    if (match) usedSequences.add(Number(match[1]));
  }

  let sequence = 1;
  while (usedSequences.has(sequence)) sequence += 1;
  return `${base}-${String(sequence).padStart(3, "0")}`;
}

function noSheetLotRzPrefix(lot) {
  const raw = normalizeCode(lot?.prefixoSku || lot?.nomeArquivo || "LOTE").replace(/[^A-Z0-9]+/g, "");
  return (raw || "LOTE").slice(0, 12);
}

function noSheetOperatorRzCode() {
  if (state.user?.operatorCode) return String(state.user.operatorCode).replace(/[^0-9A-Z]+/gi, "").toUpperCase();
  if (state.user?.role === "operator") {
    const fallback = normalizeCode(state.user.email || state.user.name || state.user.id || "OP").replace(/[^A-Z0-9]+/g, "");
    return (fallback || "OP").slice(0, 8);
  }
  return "OWNER";
}

function generateRandomCodigoMlForNoSheet() {
  const input = $("#diverseScanForm input[name='codigoMl']");
  if (!input || !state.selectedDiverseLot || !state.selectedDiverseRz) return;
  input.value = randomNoSheetCodigoMl(state.selectedDiverseLot);
  input.focus();
  input.select();
  $("#diverseScanMessage").style.color = "#0f766e";
  $("#diverseScanMessage").textContent = "Codigo ML aleatorio gerado com referencia do lote e operadora.";
}

function randomNoSheetCodigoMl(lot) {
  const lotRef = noSheetLotRzPrefix(lot).slice(0, 4);
  const operatorRef = noSheetOperatorRzCode().slice(-4);
  const usedCodes = new Set((lot.items || []).map((item) => normalizeCodigoMl(item.product?.codigoMl)));
  let candidate = "";
  do {
    candidate = `ML${lotRef}${operatorRef}${randomCodeChunk(3)}`;
  } while (usedCodes.has(candidate));
  return candidate;
}

function randomCodeChunk(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

async function downloadDiverseRzBling(lotId, codigoRz) {
  const message = $("#diverseScanMessage");
  message.textContent = "";
  try {
    if (state.config.downloadMode === "browser") {
      window.location.href = `/api/lots/${encodeURIComponent(lotId)}/rz/${encodeURIComponent(codigoRz)}/bling`;
      message.style.color = "#0f766e";
      message.textContent = "Download da remessa enviado para o navegador.";
      return;
    }

    const response = await fetch(`/api/lots/${encodeURIComponent(lotId)}/rz/${encodeURIComponent(codigoRz)}/bling/save`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Nao foi possivel gerar o arquivo Bling da remessa.");
    }
    const payload = await response.json();
    message.style.color = "#0f766e";
    message.innerHTML = `Arquivo da remessa salvo: <strong>${escapeHtml(payload.path)}</strong>`;
  } catch (error) {
    message.style.color = "";
    message.textContent = error.message;
  }
}

function diverseScanStatusMessage(response, codigoRz, parent) {
  if (response.status === "duplicado_rz") return `Quantidade somada na remessa ${codigoRz}.`;
  if (response.status === "mesmo_sku_novo_rz") return `SKU ${response.product.sku} reutilizado na remessa ${codigoRz}.`;
  if (response.status === "cadastro_manual") return `SKU ${response.product.sku} gerado e enviado para sugestao do banco historico.`;
  return `SKU ${response.product.sku} gerado na remessa ${codigoRz}.${parent}`;
}

function diverseLabelOptionsMarkup() {
  return `
    <div class="diverse-label-options">
      <label class="check-option"><input id="diverseAutoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Imprimir ao bipar</label>
      <label class="check-option"><input id="diverseIncludePriceToggle" type="checkbox" ${state.labelOptions.includePrice ? "checked" : ""} /> Etiqueta com preco</label>
      <label class="check-option"><input id="diverseSuggestPriceToggle" type="checkbox" ${state.labelOptions.suggestPrice ? "checked" : ""} /> Sugerir preco antes de imprimir</label>
      <label class="check-option"><input id="diverseIncludeTextToggle" type="checkbox" ${state.labelOptions.includeText ? "checked" : ""} /> Texto na etiqueta</label>
      <div id="diverseCustomTextRow" class="custom-text-row ${state.labelOptions.includeText ? "" : "hidden"}">
        <label>Texto que sera impresso abaixo do preco
          <input id="diverseCustomTextInput" maxlength="48" value="${escapeHtml(state.labelOptions.customText)}" placeholder="Ex: CONFERIDO - SEM TROCA" />
        </label>
        <strong>Ativo para as proximas etiquetas</strong>
      </div>
    </div>
  `;
}

function bindDiverseLabelOptions() {
  $("#diverseAutoPrintToggle").addEventListener("change", (event) => {
    state.labelOptions.autoPrint = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.autoPrint", String(state.labelOptions.autoPrint));
  });
  $("#diverseIncludePriceToggle").addEventListener("change", (event) => {
    state.labelOptions.includePrice = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.includePrice", String(state.labelOptions.includePrice));
  });
  $("#diverseSuggestPriceToggle").addEventListener("change", (event) => {
    state.labelOptions.suggestPrice = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.suggestPrice", String(state.labelOptions.suggestPrice));
  });
  $("#diverseIncludeTextToggle").addEventListener("change", (event) => {
    state.labelOptions.includeText = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.includeText", String(state.labelOptions.includeText));
    $("#diverseCustomTextRow").classList.toggle("hidden", !state.labelOptions.includeText);
    if (state.labelOptions.includeText) $("#diverseCustomTextInput").focus();
  });
  $("#diverseCustomTextInput").addEventListener("input", (event) => {
    state.labelOptions.customText = event.currentTarget.value;
    localStorage.setItem("etiquefacil.customText", state.labelOptions.customText);
  });
}

async function handleDiverseItemsClick(event) {
  const labelButton = event.target.closest("[data-diverse-label]");
  if (labelButton) {
    const product = findDiverseProduct(labelButton.dataset.diverseLabel);
    if (product) showLabel(product, { autoPrint: true, meta: labelMeta() });
    return;
  }

  const splitButton = event.target.closest("[data-diverse-split]");
  if (splitButton) {
    const item = findDiverseItem(splitButton.dataset.diverseSplit);
    if (item?.product) await splitLotProduct(item.product, item.codigoRz, { lotId: state.selectedDiverseLotId, messageSelector: "#diverseScanMessage", render: renderDiverseLot });
    return;
  }

  const editButton = event.target.closest("[data-diverse-edit]");
  if (!editButton) return;
  const product = findDiverseProduct(editButton.dataset.diverseEdit);
  if (product) await editDiverseProduct(product);
}

function findDiverseItem(productId) {
  const lot = state.selectedDiverseLot;
  if (!lot?.items) return null;
  return lot.items.find((item) => item.product?.id === productId) || null;
}

function findDiverseProduct(productId) {
  return findDiverseItem(productId)?.product || null;
}

async function editDiverseProduct(product) {
  const edited = await openProductEditModal(product);
  if (!edited) return;

  const message = $("#diverseScanMessage");
  message.textContent = "";
  try {
    const response = await api(`/api/lots/${encodeURIComponent(state.selectedDiverseLotId)}/products/${encodeURIComponent(product.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edited)
    });
    renderDiverseLot(response.lot);
    await refreshLotsList(response.lot.id);
    if (response.bling?.ok === false) {
      message.style.color = "";
      message.textContent = `Produto atualizado no sistema, mas nao foi atualizado no Bling: ${response.bling.error}`;
    } else {
      message.style.color = "#0f766e";
      message.textContent = `Produto atualizado no sistema e no Bling. ${blingProductSyncMessage(response.bling || {})}`;
    }
  } catch (error) {
    message.style.color = "";
    message.textContent = error.message;
  }
}

function openProductEditModal(product) {
  return new Promise((resolve) => {
    const modal = $("#productEditModal");
    const form = $("#productEditForm");
    const code = $("#productEditCode");
    const sku = $("#productEditSku");
    const description = $("#productEditDescription");
    const price = $("#productEditPrice");
    const cost = $("#productEditCost");
    const ean = $("#productEditEan");
    const link = $("#productEditLink");
    const photo = $("#productEditPhoto");
    const error = $("#productEditError");
    const cancel = $("#productEditCancel");

    const cleanup = () => {
      modal.classList.add("hidden");
      form.onsubmit = null;
      cancel.onclick = null;
      modal.onkeydown = null;
      form.reset();
      error.textContent = "";
      setTimeout(() => $("#diverseScanForm input[name='codigoMl']")?.focus(), 0);
    };

    code.textContent = product.codigoMl || "";
    sku.textContent = product.sku || "";
    description.value = product.descricao || "";
    price.value = String(product.valorUnit || "").replace(".", ",");
    cost.value = String(product.precoCusto || "").replace(".", ",");
    ean.value = product.ean || "";
    link.value = product.link || "";
    photo.value = product.foto || "";
    error.textContent = "";
    modal.classList.remove("hidden");

    form.onsubmit = (event) => {
      event.preventDefault();
      const valorUnit = parseMoneyInput(price.value);
      const precoCusto = parseMoneyInput(cost.value);
      if (!description.value.trim()) {
        error.textContent = "Informe o nome/descricao do produto.";
        description.focus();
        return;
      }
      if (!Number.isFinite(valorUnit) || valorUnit <= 0) {
        error.textContent = "Informe um preco valido.";
        price.focus();
        return;
      }
      if (!Number.isFinite(precoCusto) || precoCusto < 0) {
        error.textContent = "Informe um custo valido.";
        cost.focus();
        return;
      }
      const result = {
        descricao: description.value.trim(),
        valorUnit,
        precoCusto,
        ean: ean.value.trim(),
        link: link.value.trim(),
        foto: photo.value.trim()
      };
      cleanup();
      resolve(result);
    };

    cancel.onclick = () => {
      cleanup();
      resolve(null);
    };

    modal.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    };

    setTimeout(() => description.focus(), 0);
  });
}

async function splitLotProduct(product, codigoRz, { lotId = state.selectedLotId, messageSelector = "#scanMessage", render = null } = {}) {
  const split = await openProductSplitModal(product);
  if (!split) return;

  const message = $(messageSelector);
  if (message) {
    message.style.color = "";
    message.textContent = "";
  }

  try {
    const response = await api(`/api/lots/${encodeURIComponent(lotId)}/products/${encodeURIComponent(product.id)}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...split, codigoRz })
    });
    if (typeof render === "function") render(response.lot);
    else renderLotRz(response.lot, codigoRz, { replace: false });
    await refreshLotsList(response.lot.id);
    showLabel(response.product, { autoPrint: true, meta: labelMeta(response.label?.createdAt), quantity: response.labelQuantity || split.sellableQuantity });
    if (message) {
      const printed = response.labelQuantity || split.sellableQuantity;
      if (response.bling?.ok === false) {
        message.style.color = "";
        message.textContent = `Produto desmembrado e ${printed} etiqueta(s) enviada(s) para impressao, mas o Bling nao atualizou: ${response.bling.error}`;
      } else {
        message.style.color = "#0f766e";
        message.textContent = `Produto desmembrado, Bling atualizado e ${printed} etiqueta(s) enviada(s) para impressao.`;
      }
    }
  } catch (error) {
    if (message) message.textContent = error.message;
  }
}

function openProductSplitModal(product) {
  return new Promise((resolve) => {
    const modal = $("#productSplitModal");
    const form = $("#productSplitForm");
    const name = $("#productSplitName");
    const kitQuantity = $("#productSplitKitQuantity");
    const sellableQuantity = $("#productSplitSellableQuantity");
    const description = $("#productSplitDescription");
    const preview = $("#productSplitPreview");
    const error = $("#productSplitError");
    const cancel = $("#productSplitCancel");

    const updatePreview = () => {
      const kit = Math.round(Number(kitQuantity.value || 0));
      const sellable = Math.round(Number(sellableQuantity.value || 0));
      if (kit < 2 || sellable < 1 || sellable > kit) {
        preview.textContent = "";
        return;
      }
      preview.textContent = `Venda: ${money(Number(product.valorUnit || 0) / kit)} | Custo: ${money(Number(product.precoCusto || 0) / kit)} | Quantidade: ${sellable}`;
    };

    const cleanup = () => {
      modal.classList.add("hidden");
      form.onsubmit = null;
      cancel.onclick = null;
      modal.onkeydown = null;
      kitQuantity.oninput = null;
      sellableQuantity.oninput = null;
      form.reset();
      preview.textContent = "";
      error.textContent = "";
    };

    name.textContent = `${product.sku || ""} ${product.descricao || ""}`.trim();
    kitQuantity.value = "6";
    sellableQuantity.value = "5";
    description.value = unitTitleSuggestion(product.descricao || "");
    error.textContent = "";
    updatePreview();
    modal.classList.remove("hidden");

    kitQuantity.oninput = updatePreview;
    sellableQuantity.oninput = updatePreview;

    form.onsubmit = (event) => {
      event.preventDefault();
      const kit = Math.round(Number(kitQuantity.value || 0));
      const sellable = Math.round(Number(sellableQuantity.value || 0));
      const descricao = description.value.trim();
      if (!Number.isFinite(kit) || kit < 2) {
        error.textContent = "Informe a quantidade original do kit.";
        kitQuantity.focus();
        return;
      }
      if (!Number.isFinite(sellable) || sellable < 1 || sellable > kit) {
        error.textContent = "Informe uma quantidade vendavel valida.";
        sellableQuantity.focus();
        return;
      }
      if (!descricao) {
        error.textContent = "Informe o titulo do produto unitario.";
        description.focus();
        return;
      }
      cleanup();
      resolve({ kitQuantity: kit, sellableQuantity: sellable, descricao });
    };

    cancel.onclick = () => {
      cleanup();
      resolve(null);
    };

    modal.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    };

    setTimeout(() => description.focus(), 0);
  });
}

function unitTitleSuggestion(description) {
  return String(description || "")
    .replace(/\bkit\b/gi, "")
    .replace(/\bconjunto\b/gi, "")
    .replace(/\bjogo\b/gi, "")
    .replace(/\bcom\s+\d+\b/gi, "")
    .replace(/\b\d+\s*(pecas|peças|unidades|unid|unds|und|pcs|pçs|pç)\b/gi, "")
    .replace(/\b\d+\s*x\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[-,.;:\s]+|[-,.;:\s]+$/g, "")
    .trim();
}

async function showApp(user) {
  state.user = user;
  $("#auth").classList.add("hidden");
  $("#operatorInviteAuth").classList.add("hidden");
  if (user.role === "admin") {
    $("#app").classList.add("hidden");
    $("#adminApp").classList.remove("hidden");
    $("#adminName").textContent = `${user.name} (${user.email})`;
    await loadAdminUsers();
    await loadAdminLots();
    await loadAdminCatalogReviewLists();
    await loadAdminCatalogProducts();
    schedulePrimaryInputFocus();
    return;
  }

  $("#adminApp").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#app .app-nav")?.classList.remove("hidden");
  $("#userName").textContent = `${user.name} (${user.email})`;
  applyUserPermissions(user);
  const scanRequest = getScanRequest();
  if (scanRequest) {
    await showScanOnly(scanRequest);
    return;
  }
  const transferReceiveRequest = getTransferReceiveRequest();
  if (transferReceiveRequest) {
    await showTransferReceiveOnly(transferReceiveRequest);
    return;
  }
  await loadLots();
  await loadTransferLots();
  if (user.triageAccess) await loadTriageItems();
  await applyRouteFromLocation({ replace: true });
  schedulePrimaryInputFocus();
}

function applyUserPermissions(user) {
  const operator = user.role === "operator";
  document.querySelector('#app [data-tab="profile"]')?.classList.toggle("hidden", operator);
  document.querySelector('#app [data-tab="triage"]')?.classList.toggle("hidden", !user.triageAccess);
  document.querySelector(".transfer-create-panel")?.classList.remove("hidden");
  document.body.classList.toggle("operator-view", operator);
}

function showAuth() {
  document.body.classList.remove("scan-only");
  document.body.classList.remove("lot-focus");
  stopTransferCamera();
  $("#auth").classList.remove("hidden");
  $("#operatorInviteAuth").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#adminApp").classList.add("hidden");
  schedulePrimaryInputFocus(["#loginForm input[name='email']"]);
}

async function loadBlingIntegration() {
  try {
    const response = await api("/api/integrations/bling");
    state.blingIntegration = response.integration;
    renderBlingIntegration(response.integration);
  } catch (error) {
    $("#blingIntegrationStatus").textContent = error.message;
  }
}

function renderBlingIntegration(integration) {
  const connected = Boolean(integration?.connected && integration?.hasAccessToken);
  const appConfigured = Boolean(integration?.appConfigured);
  $("#blingIntegrationTitle").textContent = connected ? "Bling autorizado para este usuario" : "Bling ainda nao autorizado";
  $("#blingIntegrationDetails").textContent = connected
    ? `Autorizado com o aplicativo ${integration.clientId}. ${integration.tokenExpiresAt ? `Token expira em ${formatDate(integration.tokenExpiresAt)}.` : ""}`
    : appConfigured
      ? "Clique em Autorizar no Bling, entre na conta Bling deste usuario e aprove o acesso."
      : "A integracao Bling ainda precisa ser configurada no sistema.";
  $("#blingAuthorizeLink").classList.toggle("hidden", !appConfigured);
  $("#blingIntegrationDelete").disabled = !connected;
  $("#blingIntegrationStatus").style.color = connected ? "#0f766e" : "";
  $("#blingIntegrationStatus").textContent = getBlingCallbackMessage() || "";
}

async function deleteBlingIntegration() {
  if (!confirm("Remover a integracao Bling deste usuario?")) return;
  $("#blingIntegrationDelete").disabled = true;
  try {
    await api("/api/integrations/bling", { method: "DELETE" });
    state.blingIntegration = null;
    renderBlingIntegration(null);
  } catch (error) {
    $("#blingIntegrationStatus").style.color = "";
    $("#blingIntegrationStatus").textContent = error.message;
  } finally {
    $("#blingIntegrationDelete").disabled = false;
  }
}

function getBlingCallbackMessage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("bling") === "connected") return "Integracao Bling autorizada com sucesso.";
  if (params.get("bling") === "error") return params.get("message") || "Nao foi possivel autorizar no Bling.";
  return "";
}

function setProfileSection(section = "entries") {
  state.profileSection = section;
  document.querySelectorAll("[data-profile-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.profileSection === section);
  });
  $("#profileEntries").classList.toggle("hidden", section !== "entries");
  $("#profileSync").classList.toggle("hidden", section !== "sync");
  $("#profileOperators").classList.toggle("hidden", section !== "operators");
  $("#profileTab").scrollTop = 0;
  if (section === "sync") loadBlingIntegration();
  if (section === "operators") loadOperators();
}

async function loadOperators() {
  try {
    if (!state.operatorDateFilter) state.operatorDateFilter = defaultOperatorDateFilter();
    const params = new URLSearchParams();
    if (state.operatorDateFilter.startDate) params.set("startDate", state.operatorDateFilter.startDate);
    if (state.operatorDateFilter.endDate) params.set("endDate", state.operatorDateFilter.endDate);
    const response = await api(`/api/operators?${params.toString()}`);
    state.operators = response.operators || [];
    renderOperators();
  } catch (error) {
    $("#operatorMessage").textContent = error.message;
  }
}

function renderOperators() {
  const wrapper = $("#operatorList");
  const filter = normalizeOperatorDateFilter(state.operatorDateFilter);
  if (!state.operators.length) {
    wrapper.innerHTML = `
      <section class="operator-dashboard">
        ${operatorDateFilterMarkup(filter)}
        <p class="empty">Nenhum operador cadastrado.</p>
      </section>
    `;
    return;
  }
  const operators = state.operators.map(operatorViewModel);
  const totals = operators.reduce((acc, operator) => {
    acc.activity += operator.activity;
    acc.logins += operator.logins;
    acc.searches += operator.searches;
    acc.scans += operator.scans;
    acc.creates += operator.creates;
    acc.lotViews += operator.lotViews;
    acc.palletViews += operator.palletViews;
    acc.productionErrors += operator.productionErrors;
    acc.activeOperators += operator.activity > 0 ? 1 : 0;
    if (!acc.lastActivityAt || (operator.lastActivityAt && operator.lastActivityAt > acc.lastActivityAt)) {
      acc.lastActivityAt = operator.lastActivityAt;
    }
    if (!acc.bestDay || operator.bestDayTotal > acc.bestDay.total) {
      acc.bestDay = {
        total: operator.bestDayTotal,
        date: operator.bestDayDate,
        operatorName: operator.name
      };
    }
    return acc;
  }, { activity: 0, logins: 0, searches: 0, scans: 0, creates: 0, lotViews: 0, palletViews: 0, productionErrors: 0, activeOperators: 0, bestDay: null, lastActivityAt: null });
  const topOperators = [...operators].sort((a, b) => b.activity - a.activity || a.name.localeCompare(b.name)).slice(0, 3);
  const leader = topOperators[0];
  const periodDays = operatorPeriodDays(filter);
  const avgPerActiveOperatorDay = totals.activeOperators && periodDays ? totals.activity / totals.activeOperators / periodDays : 0;

  wrapper.innerHTML = `
    <section class="operator-dashboard">
      ${operatorDateFilterMarkup(filter)}

      <div class="operator-metrics">
        <article class="operator-metric">
          <span>Atividades no periodo</span>
          <strong>${totals.activity}</strong>
          <small>${operators.length} operadores cadastrados</small>
        </article>
        <article class="operator-metric">
          <span>Buscas e bipagens</span>
          <strong>${totals.searches + totals.scans}</strong>
          <small>${totals.searches} buscas / ${totals.scans} bipagens</small>
        </article>
        <article class="operator-metric">
          <span>Erros producao</span>
          <strong>${totals.productionErrors}</strong>
          <small>divergencias reportadas</small>
        </article>
        <article class="operator-metric">
          <span>Capacidade media</span>
          <strong>${formatDecimal(avgPerActiveOperatorDay)}</strong>
          <small>atividades por operador em dia do periodo</small>
        </article>
        <article class="operator-metric">
          <span>Melhor dia de um operador</span>
          <strong>${totals.bestDay?.total || 0}</strong>
          <small>${totals.bestDay?.operatorName ? `${escapeHtml(totals.bestDay.operatorName)}${totals.bestDay.date ? ` - ${formatShortDate(totals.bestDay.date)}` : ""}` : "Sem atividade"}</small>
        </article>
      </div>

      <div class="operator-podium">
        ${topOperators.map(operatorPodiumCard).join("")}
      </div>

      <div class="operator-table">
        <div class="operator-row operator-row-head">
          <span>#</span>
          <span>Operador</span>
          <span>Cod.</span>
          <span>Total</span>
          <span>Logins</span>
          <span>Buscas</span>
          <span>Bipagens</span>
          <span>Cadastros</span>
          <span>Lotes</span>
          <span>Pallets</span>
          <span>Erros</span>
          <span>Dias trab.</span>
          <span>Media/dia</span>
          <span>Melhor dia</span>
          <span>Ultima ativ.</span>
          <span>Triagem</span>
          <span>Senha</span>
        </div>
        ${operators
          .sort((a, b) => b.activity - a.activity || a.name.localeCompare(b.name))
          .map(operatorTableRow)
          .join("")}
      </div>
    </section>
  `;
}

function defaultOperatorDateFilter() {
  const today = new Date();
  return {
    startDate: formatInputDate(addDays(today, -6)),
    endDate: formatInputDate(today)
  };
}

function operatorPeriodDays(filter) {
  if (!filter.startDate || !filter.endDate) return 0;
  const start = new Date(`${filter.startDate}T00:00:00`);
  const end = new Date(`${filter.endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function formatDecimal(value) {
  return Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function formatShortDate(value) {
  if (!value) return "--";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function normalizeOperatorDateFilter(filter = {}) {
  let startDate = filter.startDate || "";
  let endDate = filter.endDate || "";
  if (startDate && endDate && startDate > endDate) [startDate, endDate] = [endDate, startDate];
  state.operatorDateFilter = { startDate, endDate };
  return state.operatorDateFilter;
}

function operatorDateFilterMarkup(filter) {
  return `
    <form class="operator-filter" id="operatorDateFilter">
      <div class="operator-filter-title">
        <span aria-hidden="true">!</span>
        <strong>Desempenho da Equipe</strong>
      </div>
      <div class="operator-filter-fields">
        <label>
          Data inicial
          <input type="date" name="startDate" value="${escapeHtml(filter.startDate)}" />
        </label>
        <label>
          Data final
          <input type="date" name="endDate" value="${escapeHtml(filter.endDate)}" />
        </label>
        <button type="button" class="ghost" data-operator-period="today">Hoje</button>
        <button type="button" class="ghost" data-operator-period="7">7 dias</button>
        <button type="button" class="ghost" data-operator-period="30">30 dias</button>
        <button type="submit" class="ghost operator-refresh" aria-label="Atualizar desempenho">Atualizar</button>
      </div>
    </form>
  `;
}

function handleOperatorFilterSubmit(event) {
  if (!event.target.matches("#operatorDateFilter")) return;
  event.preventDefault();
  applyOperatorFilterFromForm(event.target);
}

function handleOperatorFilterChange(event) {
  if (!event.target.closest("#operatorDateFilter") || !event.target.matches('input[type="date"]')) return;
  applyOperatorFilterFromForm(event.target.form);
}

function handleOperatorFilterClick(event) {
  const triageButton = event.target.closest("[data-toggle-operator-triage]");
  if (triageButton) {
    triageButton.disabled = true;
    $("#operatorMessage").textContent = "";
    try {
      api(`/api/operators/${encodeURIComponent(triageButton.dataset.toggleOperatorTriage)}/triage-access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triageAccess: triageButton.dataset.triageAccess === "true" })
      })
        .then(async () => {
          $("#operatorMessage").style.color = "#0f766e";
          $("#operatorMessage").textContent = "Permissao de triagem do operador atualizada.";
          await loadOperators();
        })
        .catch((error) => {
          $("#operatorMessage").style.color = "";
          $("#operatorMessage").textContent = error.message;
        })
        .finally(() => {
          triageButton.disabled = false;
        });
    } catch {
      triageButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-operator-period]");
  if (!button) return;
  const days = button.dataset.operatorPeriod;
  const today = new Date();
  state.operatorDateFilter = {
    startDate: days === "today" ? formatInputDate(today) : formatInputDate(addDays(today, -(Number(days) - 1))),
    endDate: formatInputDate(today)
  };
  loadOperators();
}

function applyOperatorFilterFromForm(form) {
  const data = new FormData(form);
  state.operatorDateFilter = normalizeOperatorDateFilter({
    startDate: data.get("startDate") || "",
    endDate: data.get("endDate") || ""
  });
  loadOperators();
}

function operatorViewModel(operator) {
  const stats = operator.stats || {};
  const logins = stats.logins || 0;
  const searches = stats.searches || 0;
  const scans = stats.scans || 0;
  const creates = stats.creates || 0;
  const lotViews = stats.lotViews || 0;
  const palletViews = stats.palletViews || 0;
  const productionErrors = stats.productionErrors || 0;
  const dailyTotals = stats.dailyTotals || {};
  const activeDays = Object.values(dailyTotals).filter((total) => Number(total || 0) > 0).length;
  const bestDay = Object.entries(dailyTotals).reduce((best, [date, total]) => {
    const normalizedTotal = Number(total || 0);
    if (!best || normalizedTotal > best.total) return { date, total: normalizedTotal };
    return best;
  }, null);
  const activity = logins + searches + scans + creates + lotViews + palletViews + productionErrors;
  return {
    id: operator.id || "",
    name: operator.name || "Operador",
    email: operator.email || "",
    operatorCode: operator.operatorCode || "",
    triageAccess: Boolean(operator.triageAccess),
    logins,
    searches,
    scans,
    creates,
    lotViews,
    palletViews,
    productionErrors,
    activeDays,
    averagePerDay: activeDays ? activity / activeDays : 0,
    bestDayDate: bestDay?.date || "",
    bestDayTotal: bestDay?.total || 0,
    activity,
    lastActivityAt: stats.lastActivityAt || null
  };
}

function operatorPodiumCard(operator, index) {
  const rank = index + 1;
  const rankClass = rank === 1 ? "gold" : rank === 2 ? "silver" : "bronze";
  return `
    <article class="operator-podium-card ${rankClass}">
      <div class="operator-medal">${rank}</div>
      <strong>${escapeHtml(operator.name)}</strong>
      <span>${escapeHtml(operator.operatorCode || operator.email)}</span>
      <b>${operator.activity}</b>
      <small>atividades registradas</small>
      <em>${operator.bestDayTotal} no melhor dia</em>
    </article>
  `;
}

function operatorTableRow(operator, index) {
  return `
    <div class="operator-row" data-operator-id="${escapeHtml(operator.id)}">
      <span>${index + 1}</span>
      <span>
        <strong>${escapeHtml(operator.name)}</strong>
        <small>${escapeHtml(operator.email)}</small>
      </span>
      <strong>${escapeHtml(operator.operatorCode || "--")}</strong>
      <strong>${operator.activity}</strong>
      <span>${operator.logins}</span>
      <span>${operator.searches}</span>
      <span>${operator.scans}</span>
      <span>${operator.creates}</span>
      <span>${operator.lotViews}</span>
      <span>${operator.palletViews}</span>
      <strong>${operator.productionErrors}</strong>
      <strong>${operator.activeDays}</strong>
      <strong>${formatDecimal(operator.averagePerDay)}</strong>
      <strong>${operator.bestDayTotal}</strong>
      <span>${operator.lastActivityAt ? formatDateTime(operator.lastActivityAt) : "Sem atividade"}</span>
      ${state.user?.triageAccess ? `<button type="button" class="ghost" data-toggle-operator-triage="${escapeHtml(operator.id)}" data-triage-access="${operator.triageAccess ? "false" : "true"}">${operator.triageAccess ? "Liberado" : "Bloqueado"}</button>` : "<span>Sem acesso</span>"}
      <form class="operator-password-form">
        <input name="password" type="password" minlength="4" placeholder="Nova senha" aria-label="Nova senha para ${escapeHtml(operator.email)}" required />
        <button type="submit" class="ghost">Salvar</button>
      </form>
    </div>
  `;
}

async function handleOperatorPasswordSubmit(event) {
  if (!event.target.matches(".operator-password-form")) return;
  event.preventDefault();
  const form = event.target;
  const row = form.closest("[data-operator-id]");
  const password = new FormData(form).get("password");
  const button = form.querySelector("button");
  $("#operatorMessage").textContent = "";
  $("#operatorMessage").style.color = "";
  button.disabled = true;
  try {
    await api(`/api/operators/${encodeURIComponent(row.dataset.operatorId)}/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    form.reset();
    $("#operatorMessage").style.color = "#0f766e";
    $("#operatorMessage").textContent = "Senha do operador atualizada.";
  } catch (error) {
    $("#operatorMessage").style.color = "";
    $("#operatorMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function toggleOperatorManualForm(forceOpen) {
  const form = $("#operatorForm");
  const button = $("#operatorManualToggle");
  const open = typeof forceOpen === "boolean" ? forceOpen : form.classList.contains("hidden");
  form.classList.toggle("hidden", !open);
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? "Fechar cadastro" : "Criar manualmente";
  if (open) schedulePrimaryInputFocus(["#operatorForm input[name='name']"]);
}

async function createOperator(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  $("#operatorMessage").textContent = "";
  button.disabled = true;
  try {
    await api("/api/operators", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    form.reset();
    toggleOperatorManualForm(false);
    $("#operatorMessage").style.color = "#0f766e";
    $("#operatorMessage").textContent = "Operador criado.";
    await loadOperators();
  } catch (error) {
    $("#operatorMessage").style.color = "";
    $("#operatorMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function generateOperatorInvite() {
  const button = $("#operatorInviteButton");
  $("#operatorMessage").textContent = "";
  button.disabled = true;
  try {
    const response = await api("/api/operator-invites", { method: "POST" });
    $("#operatorInviteResult").classList.remove("hidden");
    $("#operatorInviteUrl").value = response.url;
    $("#operatorInviteExpires").textContent = `Expira em ${formatDateTime(response.invite.expiresAt)}`;
    $("#operatorMessage").style.color = "#0f766e";
    $("#operatorMessage").textContent = "Link gerado. Envie para o operador concluir o cadastro.";
    await copyText(response.url).catch(() => null);
  } catch (error) {
    $("#operatorMessage").style.color = "";
    $("#operatorMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function copyOperatorInviteLink() {
  const url = $("#operatorInviteUrl").value;
  if (!url) return;
  try {
    await copyText(url);
    $("#operatorMessage").style.color = "#0f766e";
    $("#operatorMessage").textContent = "Link copiado.";
  } catch {
    $("#operatorInviteUrl").select();
    $("#operatorMessage").style.color = "";
    $("#operatorMessage").textContent = "Selecione e copie o link manualmente.";
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Nao foi possivel copiar.");
}

async function recordOperatorActivity(action, metadata = {}) {
  if (state.user?.role !== "operator") return;
  try {
    await api("/api/operator-activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, metadata })
    });
  } catch {
    // Activity tracking must not interrupt the read-only workflow.
  }
}

async function applyRouteFromLocation({ replace = false } = {}) {
  const route = parseRoute(window.location.pathname);
  if (state.user?.role === "operator" && route.view === "profile") {
    setMainTab("lots", { push: false, resetSelection: true });
    if (replace) updateRoute("/lotes", { replace: true });
    return;
  }

  if (route.view === "lotRz") {
    const lot = await selectLot(route.lotId, { push: false });
    if (lot) {
      renderRz(lot, route.codigoRz, { push: false });
    }
    if (replace) updateRoute(lot ? lotRzPath(route.lotId, route.codigoRz) : "/lotes", { replace: true });
    return;
  }

  if (route.view === "lot") {
    const lot = await selectLot(route.lotId, { push: false });
    if (replace) updateRoute(lot ? lotPath(route.lotId) : "/lotes", { replace: true });
    return;
  }

  if (route.view === "triage" && !state.user?.triageAccess) {
    setMainTab(state.user?.role === "operator" ? "lots" : "profile", { push: false, resetSelection: true });
    if (replace) updateRoute(state.user?.role === "operator" ? "/lotes" : "/perfil", { replace: true });
    return;
  }

  if (route.view === "triageView" && !state.user?.triageAccess) {
    setMainTab(state.user?.role === "operator" ? "lots" : "profile", { push: false, resetSelection: true });
    if (replace) updateRoute(state.user?.role === "operator" ? "/lotes" : "/perfil", { replace: true });
    return;
  }

  if (route.view === "triageView") {
    setMainTab("triage", { push: false, triageViewOnly: true });
    await showTriageItemView(route.triageCode);
    if (replace) updateRoute(`/triagem/visualizar/${encodeURIComponent(route.triageCode)}`, { replace: true });
    return;
  }

  setMainTab(route.view, { push: false, resetSelection: route.view === "lots" });
  if (route.view === "triage" && route.triageCode) {
    await loadTriageItems(route.triageCode);
    await selectTriageItem(route.triageCode, { push: false });
  }
  if (replace) updateRoute(routePathForView(route.view), { replace: true });
}

function parseRoute(pathname) {
  const parts = String(pathname || "/").split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts[0] === "entradas" || parts[0] === "perfil" || parts[0] === "bling") return { view: "profile" };
  if (parts[0] === "busca") return { view: "search" };
  if (parts[0] === "transferencias" && parts[1] && parts[2] === "loja") return { view: "transferReceive", transferLotId: parts[1] };
  if (parts[0] === "transferencias") return { view: "transfers" };
  if (parts[0] === "triagem" && parts[1] === "visualizar" && parts[2]) return { view: "triageView", triageCode: parts[2] };
  if (parts[0] === "triagem" && parts[1]) return { view: "triage", triageCode: parts[1] };
  if (parts[0] === "triagem") return { view: "triage" };
  if (parts[0] === "lotes" && parts[1] && parts[2] === "rz" && parts[3]) return { view: "lotRz", lotId: parts[1], codigoRz: parts[3] };
  if (parts[0] === "lotes" && parts[1]) return { view: "lot", lotId: parts[1] };
  if (parts[0] === "lotes") return { view: "lots" };
  return { view: "profile" };
}

function routePathForView(view) {
  if (view === "lots") return "/lotes";
  if (view === "search") return "/busca";
  if (view === "transfers") return "/transferencias";
  if (view === "triage") return "/triagem";
  if (view === "profile") return "/perfil";
  return "/perfil";
}

function lotPath(lotId) {
  return `/lotes/${encodeURIComponent(lotId)}`;
}

function lotRzPath(lotId, codigoRz) {
  return `${lotPath(lotId)}/rz/${encodeURIComponent(codigoRz)}`;
}

function updateRoute(path, { replace = false } = {}) {
  const next = routePath(path);
  if (window.location.href === next) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", next);
}

function setMainTab(tab, { push = true, resetSelection = false, triageViewOnly = false } = {}) {
  let target = tab || "profile";
  if (state.user?.role === "operator" && target === "profile") target = "lots";
  if (resetSelection) {
    state.selectedLotId = null;
    state.previewLotId = null;
    state.selectedRz = null;
    state.selectedTransferLotId = null;
    state.selectedTriageCode = null;
    renderLots();
    renderTransferLots();
    renderTriageItems();
    clearLotDetail();
    clearTransferDetail();
    clearTriageDetail();
  }
  document.querySelectorAll("#app [data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === target);
  });
  $(".upload-band").classList.toggle("hidden", target !== "profile");
  $("#lotsTab").classList.toggle("hidden", target !== "lots");
  $("#searchTab").classList.toggle("hidden", target !== "search");
  $("#transfersTab").classList.toggle("hidden", target !== "transfers");
  $("#triageTab").classList.toggle("hidden", target !== "triage");
  $("#triageTab").classList.toggle("triage-view-only", target === "triage" && triageViewOnly);
  $("#profileTab").classList.toggle("hidden", target !== "profile");
  document.body.classList.remove("lot-focus");
  if (push) updateRoute(routePathForView(target));
  if (target === "profile") setProfileSection(state.profileSection || "entries");
  if (target === "transfers") {
    loadBlingDeposits();
    loadTransferLots(state.selectedTransferLotId);
  }
  if (target === "triage" && !triageViewOnly) loadTriageItems(state.selectedTriageCode);
  schedulePrimaryInputFocus();
}

function getScanRequest() {
  const params = new URLSearchParams(window.location.search);
  const lotId = params.get("scanLot");
  const codigoRz = params.get("scanRz");
  if (lotId && codigoRz) return { lotId, codigoRz };

  const route = parseRoute(window.location.pathname);
  if (route.view === "lotRz") return { lotId: route.lotId, codigoRz: route.codigoRz };
  return null;
}

function getTransferReceiveRequest() {
  const params = new URLSearchParams(window.location.search);
  const transferLotId = params.get("receiveTransfer");
  if (transferLotId) return { transferLotId };

  const route = parseRoute(window.location.pathname);
  if (route.view === "transferReceive") return { transferLotId: route.transferLotId };
  return null;
}

async function showScanOnly({ lotId, codigoRz }) {
  state.scanOnly = true;
  state.selectedLotId = lotId;
  state.selectedRz = codigoRz;
  document.body.classList.add("scan-only");
  document.body.classList.remove("lot-focus");
  $("#app .topbar h1").textContent = "Bipagem";
  $("#app .app-nav")?.classList.add("hidden");
  $("#uploadForm").closest(".upload-band").classList.add("hidden");
  $(".tabs").classList.add("hidden");
  $("#lotsTab").classList.remove("hidden");
  $("#searchTab").classList.add("hidden");
  $("#profileTab").classList.add("hidden");
  $("#lotDetail").classList.remove("empty");
  $("#lotDetail").innerHTML = '<p class="muted">Carregando bipagem...</p>';

  try {
    const response = await api(`/api/lots/${encodeURIComponent(lotId)}`);
    renderScanPage(response.lot, codigoRz);
  } catch (error) {
    $("#lotDetail").classList.add("empty");
    $("#lotDetail").textContent = error.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  location.reload();
}

async function loadAdminUsers() {
  const response = await api("/api/admin/users");
  state.adminUsers = response.users;
  renderAdminUsers();
}

async function loadAdminLots() {
  const response = await api("/api/admin/lots");
  state.adminLots = response.lots;
  renderAdminLots();
}

async function loadAdminCatalogRequests() {
  const response = await api("/api/admin/catalog-requests");
  state.adminCatalogRequests = response.requests;
  renderAdminCatalogRequests();
}

async function loadAdminCatalogRejectedRequests() {
  const response = await api("/api/admin/catalog-rejected-requests");
  state.adminCatalogRejectedRequests = response.requests;
  renderAdminCatalogRejectedRequests();
}

async function loadAdminCatalogReviewLists() {
  await Promise.all([
    loadAdminCatalogRequests(),
    loadAdminCatalogRejectedRequests()
  ]);
}

async function loadAdminCatalogProducts(event) {
  if (event) event.preventDefault();
  const query = $("#adminCatalogSearchForm") ? new FormData($("#adminCatalogSearchForm")).get("q") : "";
  const response = await api(`/api/admin/catalog-products?q=${encodeURIComponent(query || "")}`);
  state.adminCatalogProducts = response.products;
  renderAdminCatalogProducts();
}

function setAdminTab(tab) {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.classList.toggle("active", button.dataset.adminTab === tab));
  $("#adminUsersTab").classList.toggle("hidden", tab !== "users");
  $("#adminLotsTab").classList.toggle("hidden", tab !== "lots");
  $("#adminCatalogTab").classList.toggle("hidden", tab !== "catalog");
  schedulePrimaryInputFocus();
}

async function createAdminUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  $("#adminMessage").textContent = "";
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    await api("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    form.reset();
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = "Usuario criado.";
    await loadAdminUsers();
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
  } finally {
    button.disabled = false;
    schedulePrimaryInputFocus(["#adminCreateUserForm input[name='name']"]);
  }
}

function renderAdminUsers() {
  const wrapper = $("#adminUsers");
  if (!state.adminUsers.length) {
    wrapper.innerHTML = '<p class="muted">Nenhum usuario cadastrado ainda.</p>';
    return;
  }

  wrapper.innerHTML = `
    <div class="admin-table">
      <div class="admin-row admin-row-head">
        <span>Usuario</span>
        <span>Lotes</span>
        <span>Produtos</span>
        <span>Criado em</span>
        <span>Acoes</span>
      </div>
      ${state.adminUsers.map(adminUserRow).join("")}
    </div>
  `;
}

function renderAdminLots() {
  const wrapper = $("#adminLots");
  if (!state.adminLots.length) {
    wrapper.innerHTML = '<p class="muted">Nenhum lote encontrado.</p>';
    return;
  }

  wrapper.innerHTML = `
    <div class="admin-table">
      <div class="admin-row admin-lot-row admin-row-head">
        <span>Lote</span>
        <span>Usuario</span>
        <span>SKUs</span>
        <span>RZs</span>
        <span>Conferencia</span>
        <span>Criado em</span>
      </div>
      ${state.adminLots.map(adminLotRow).join("")}
    </div>
  `;
}

function adminLotRow(lot) {
  const user = lot.user || {};
  const qty = lot.progress || {};
  return `
    <article class="admin-row admin-lot-row" data-admin-lot-id="${escapeHtml(lot.id)}">
      <div>
        <strong>${escapeHtml(lot.nomeArquivo)}</strong>
        <span class="muted">${escapeHtml(lot.prefixoSku || "")} - ${escapeHtml(lot.fornecedor || "")}</span>
      </div>
      <div>
        <strong>${escapeHtml(user.tenantName || user.name || "Usuario removido")}</strong>
        <span class="muted">${escapeHtml(user.email || "")}</span>
      </div>
      <span>${lot.totalProducts || 0}</span>
      <span>${(lot.rzs || []).length}</span>
      <span>${qty.checkedQty || 0}/${qty.expectedQty || 0}<small class="muted">${money(qty.checkedValue || 0)} / ${money(qty.expectedValue || 0)}</small></span>
      <span>${formatDate(lot.createdAt)}</span>
    </article>
  `;
}

function renderAdminCatalogRequests() {
  const wrapper = $("#adminCatalogRequests");
  if (!state.adminCatalogRequests.length) {
    wrapper.innerHTML = `
      <div class="admin-empty-state">
        <strong>Nenhuma sugestao pendente agora.</strong>
        <span>Quando alguem cadastrar ou confirmar um produto novo, ele aparece aqui para aprovar, rejeitar, filtrar por criador/data ou selecionar varios de uma vez.</span>
      </div>
    `;
    return;
  }

  const filteredRequests = filteredAdminCatalogRequests();
  const lotRequests = filteredRequests.filter((request) => request.scope === "lot");
  const individualRequests = filteredRequests.filter((request) => request.scope !== "lot");
  wrapper.innerHTML = `
    ${adminCatalogRequestFiltersHtml()}
    ${adminCatalogRequestSection("Sugestoes de lotes", lotRequests)}
    ${adminCatalogRequestSection("Sugestoes individuais", individualRequests)}
  `;
}

function adminCatalogRequestFiltersHtml() {
  const filters = state.adminCatalogRequestFilters;
  const visibleCount = filteredAdminCatalogRequests().length;
  return `
    <form class="catalog-request-filters" data-catalog-request-filters>
      <label>Login criador
        <input name="creator" value="${escapeHtml(filters.creator)}" placeholder="E-mail, nome ou operador" autocomplete="off" />
      </label>
      <label>Data
        <input name="date" type="date" value="${escapeHtml(filters.date)}" />
      </label>
      <label class="catalog-check-filter">
        <input name="doubleCheckOnly" type="checkbox" ${filters.doubleCheckOnly ? "checked" : ""} />
        Com double check
      </label>
      <button type="submit">Filtrar</button>
      <button type="button" class="ghost" data-clear-catalog-filters>Limpar filtros</button>
      <span class="catalog-filter-count">${visibleCount} sugestao${visibleCount === 1 ? "" : "es"}</span>
    </form>
  `;
}

function filteredAdminCatalogRequests() {
  const filters = state.adminCatalogRequestFilters;
  const creator = normalizeFilterText(filters.creator);
  const date = String(filters.date || "").trim();
  return state.adminCatalogRequests.filter((request) => {
    if (creator && !normalizeFilterText(catalogActorSearchText(request)).includes(creator)) return false;
    if (date && !isSameInputDate(request.createdAt, date)) return false;
    if (filters.doubleCheckOnly && catalogApprovalOptions(request).length < 2) return false;
    return true;
  });
}

function adminCatalogRequestSection(title, requests) {
  return `
    <section class="catalog-request-section">
      <h3>${escapeHtml(title)}</h3>
      ${
        requests.length
          ? `
            <div class="catalog-bulk-actions">
              <label class="catalog-select-all">
                <input type="checkbox" data-select-catalog-visible />
                Selecionar visiveis
              </label>
              <button type="button" data-review-catalog-bulk="approve">Aprovar selecionadas</button>
              <button type="button" class="danger" data-review-catalog-bulk="reject">Rejeitar selecionadas</button>
            </div>
            <div class="admin-table">
              <div class="admin-row catalog-request-row admin-row-head">
                <span>Sel.</span>
                <span>Sugestao</span>
                <span>Codigo ML</span>
                <span>Preco</span>
                <span>Cadastros</span>
                <span>Status</span>
                <span>Acoes</span>
              </div>
              ${requests.map(adminCatalogRequestRow).join("")}
            </div>
          `
          : '<p class="muted">Nenhuma sugestao nesta lista.</p>'
      }
    </section>
  `;
}

function renderAdminCatalogRejectedRequests() {
  const wrapper = $("#adminCatalogRejectedRequests");
  if (!state.adminCatalogRejectedRequests.length) {
    wrapper.innerHTML = `
      <div class="admin-empty-state">
        <strong>Nenhuma sugestao rejeitada ainda.</strong>
        <span>As sugestoes rejeitadas ficam listadas aqui depois que voce clicar em Rejeitar.</span>
      </div>
    `;
    return;
  }

  wrapper.innerHTML = `
    <div class="admin-table">
      <div class="admin-row catalog-rejected-row admin-row-head">
        <span>Sugestao</span>
        <span>Codigo ML</span>
        <span>Preco</span>
        <span>Cadastros</span>
        <span>Rejeitada em</span>
      </div>
      ${state.adminCatalogRejectedRequests.map(adminCatalogRejectedRequestRow).join("")}
    </div>
  `;
}

function renderAdminCatalogProducts() {
  const wrapper = $("#adminCatalogProducts");
  if (!state.adminCatalogProducts.length) {
    wrapper.innerHTML = `
      <div class="admin-empty-state">
        <strong>Nenhum produto encontrado no banco historico oficial.</strong>
        <span>Se voce buscou por Codigo ML, EAN ou descricao, tente limpar a busca. Produtos aprovados aparecem aqui.</span>
      </div>
    `;
    return;
  }

  wrapper.innerHTML = `
    <div class="admin-table">
      <div class="admin-row catalog-product-row admin-row-head">
        <span>Produto</span>
        <span>Codigo ML</span>
        <span>EAN</span>
        <span>Preco</span>
        <span>Custo</span>
        <span>Atualizado</span>
        <span>Acoes</span>
      </div>
      ${state.adminCatalogProducts.map(adminCatalogProductRow).join("")}
    </div>
  `;
}

function adminCatalogRejectedRequestRow(request) {
  const actor = catalogActorLabel(request);
  const options = catalogApprovalOptions(request);
  return `
    <article class="admin-row catalog-rejected-row" data-catalog-rejected-request-id="${escapeHtml(request.id)}">
      <div class="catalog-request-summary">
        ${catalogPhotoFrame(request.foto, "catalog-photo-main")}
        <div>
          <strong>${request.type === "update" ? "Alteracao" : "Cadastro"}</strong>
          <span class="muted">${escapeHtml(actor)} - ${formatDate(request.createdAt)}</span>
          <span class="muted">${escapeHtml(request.descricao)}</span>
        </div>
      </div>
      <span>${escapeHtml(request.codigoMl)}</span>
      <span>${money(request.valorUnit)}</span>
      <span><strong class="check-count">${options.length} cadastro${options.length === 1 ? "" : "s"}</strong></span>
      <span>${formatDate(request.rejectedAt)}</span>
    </article>
  `;
}

function adminCatalogProductRow(product) {
  return `
    <article class="admin-row catalog-product-row" data-catalog-product-id="${escapeHtml(product.id)}">
      <div>
        <strong>${escapeHtml(product.descricao)}</strong>
        <span class="muted">${escapeHtml(product.categoria || "-")} ${escapeHtml(product.subcategoria || "")}</span>
      </div>
      <span>${escapeHtml(product.codigoMl)}</span>
      <span>${escapeHtml(product.ean || "-")}</span>
      <span>${money(product.valorUnit)}</span>
      <span>${money(product.precoCusto)}</span>
      <span>${formatDate(product.updatedAt || product.createdAt)}</span>
      <div class="admin-actions">
        <button type="button" class="danger" data-delete-catalog-product="${escapeHtml(product.id)}">Excluir do banco</button>
      </div>
    </article>
  `;
}

function adminCatalogRequestRow(request) {
  const actor = catalogActorLabel(request);
  const pending = request.status === "pending";
  const options = catalogApprovalOptions(request);
  const alertHtml = request.alertMessage ? `<span class="catalog-alert">${escapeHtml(request.alertMessage)}</span>` : "";
  const choiceHtml = options.length > 1
    ? `
      <details class="double-checks" open>
        <summary>Escolher cadastro para aprovar</summary>
        <div class="double-check-list">
          ${options.map((option, index) => catalogApprovalOptionRow(request.id, option, index)).join("")}
        </div>
      </details>
    `
    : "";
  return `
    <article class="admin-row catalog-request-row" data-catalog-request-id="${escapeHtml(request.id)}">
      <label class="catalog-select-row" title="Selecionar sugestao">
        <input type="checkbox" data-select-catalog-request ${pending ? "" : "disabled"} />
      </label>
      <div class="catalog-request-summary">
        ${catalogPhotoFrame(request.foto, "catalog-photo-main")}
        <div>
        <strong>${request.type === "update" ? "Alteracao" : "Cadastro"}</strong>
        <span class="muted">${escapeHtml(actor)} - ${formatDate(request.createdAt)}</span>
        <span class="muted">${escapeHtml(request.descricao)}</span>
        ${alertHtml}
        </div>
      </div>
      <span>${escapeHtml(request.codigoMl)}</span>
      <span>${money(request.valorUnit)}</span>
      <span><strong class="check-count">${options.length} cadastro${options.length === 1 ? "" : "s"}</strong></span>
      <span>${catalogRequestStatus(request.status)}</span>
      <div class="admin-actions">
        <button type="button" ${pending ? "" : "disabled"} data-review-catalog="approve">Aprovar</button>
        <button type="button" class="danger" ${pending ? "" : "disabled"} data-review-catalog="reject">Rejeitar</button>
      </div>
      ${choiceHtml}
    </article>
  `;
}

function catalogApprovalOptions(request) {
  return [
    { id: "base", label: "Cadastro inicial", user: request.user, createdByUser: request.createdByUser, operatorUser: request.operatorUser, createdAt: request.createdAt, descricao: request.descricao, valorUnit: request.valorUnit, ean: request.ean, link: request.link, foto: request.foto },
    ...(Array.isArray(request.doubleChecks) ? request.doubleChecks : []).map((check, index) => ({ ...check, label: `Double check ${index + 1}` }))
  ];
}

function catalogApprovalOptionRow(requestId, option, index) {
  const optionId = option.id || "base";
  const actor = catalogActorLabel(option);
  const link = String(option.link || "").trim();
  const photo = String(option.foto || "").trim();
  const ean = String(option.ean || "").trim();
  return `
    <label class="double-check-item">
      <input type="radio" name="catalog-choice-${escapeHtml(requestId)}" value="${escapeHtml(optionId)}" ${index === 0 ? "checked" : ""} />
      ${catalogPhotoFrame(photo, "catalog-photo-option")}
      <div>
        <strong>${escapeHtml(option.label || "Cadastro")}</strong>
        <span>${escapeHtml(actor)} - ${formatDate(option.createdAt)} - ${money(option.valorUnit)}</span>
        <span>${escapeHtml(option.descricao || "")}</span>
        <span>EAN: ${escapeHtml(ean || "-")}${link ? ` - <a class="catalog-link" href="${escapeHtml(link)}" target="_blank" rel="noopener">Abrir link</a>` : ""}</span>
      </div>
    </label>
  `;
}

function catalogActorLabel(item) {
  const owner = item.user?.email || item.user?.name || "usuario";
  const createdBy = item.createdByUser?.email || item.createdByUser?.name || "";
  const operator = item.operatorUser?.email || item.operatorUser?.name || "";
  const actor = operator || createdBy;
  if (actor && actor !== owner) return `${owner} / operador ${actor}`;
  return actor || owner;
}

function catalogActorSearchText(item) {
  return [
    item.user?.email,
    item.user?.name,
    item.createdByUser?.email,
    item.createdByUser?.name,
    item.operatorUser?.email,
    item.operatorUser?.name,
    catalogActorLabel(item)
  ].filter(Boolean).join(" ");
}

function catalogPhotoFrame(photo, className = "") {
  const src = String(photo || "").trim();
  if (!src) return `<span class="catalog-photo-frame ${className} is-empty">Sem foto</span>`;
  return `
    <span class="catalog-photo-frame ${className}">
      <img src="${escapeHtml(src)}" alt="Foto do produto" loading="lazy" onerror="this.closest('.catalog-photo-frame').classList.add('is-missing');" />
      <span class="photo-missing">Foto indisponivel</span>
    </span>
  `;
}

function catalogRequestStatus(status) {
  if (status === "approved") return "Aprovada";
  if (status === "rejected") return "Rejeitada";
  return "Pendente";
}

function adminUserRow(user) {
  return `
    <article class="admin-row admin-user-row" data-user-id="${escapeHtml(user.id)}">
      <div class="admin-user-main">
        <div>
          <strong>${escapeHtml(user.name)}</strong>
          <span class="muted">${escapeHtml(user.email)}</span>
        </div>
        <span>${user.totalLots}</span>
        <span>${user.totalProducts}</span>
        <span>${formatDate(user.createdAt)}</span>
        <div class="admin-actions">
          <form class="password-form">
            <input name="password" type="password" placeholder="Nova senha" aria-label="Nova senha para ${escapeHtml(user.email)}" required />
            <button type="submit">Salvar senha</button>
          </form>
          <button type="button" data-toggle-admin-triage="${escapeHtml(user.id)}" data-triage-access="${user.triageAccess ? "false" : "true"}">${user.triageAccess ? "Bloquear triagem" : "Liberar triagem"}</button>
          <button class="danger" type="button" data-delete-user="${escapeHtml(user.id)}">Excluir</button>
        </div>
      </div>
      ${adminOperatorList(user.operators || [])}
    </article>
  `;
}

function adminOperatorList(operators) {
  if (!operators.length) return "";
  return `
    <div class="admin-operators">
      <strong>Operadores</strong>
      <div class="admin-operator-list">
        ${operators.map(adminOperatorRow).join("")}
      </div>
    </div>
  `;
}

function adminOperatorRow(operator) {
  return `
    <div class="admin-operator-item" data-user-id="${escapeHtml(operator.id)}">
      <div>
        <strong>${escapeHtml(operator.name)}</strong>
        <span class="muted">${escapeHtml(operator.email)}</span>
      </div>
      <span class="admin-operator-code">${escapeHtml(operator.operatorCode || "--")}</span>
      <div class="admin-actions">
        <form class="password-form">
          <input name="password" type="password" placeholder="Nova senha" aria-label="Nova senha para ${escapeHtml(operator.email)}" required />
          <button type="submit">Salvar senha</button>
        </form>
        <button type="button" data-toggle-admin-triage="${escapeHtml(operator.id)}" data-triage-access="${operator.triageAccess ? "false" : "true"}">${operator.triageAccess ? "Bloquear triagem" : "Liberar triagem"}</button>
        <button class="danger" type="button" data-delete-user="${escapeHtml(operator.id)}">Excluir</button>
      </div>
    </div>
  `;
}

function findAdminUser(userId) {
  for (const user of state.adminUsers) {
    if (user.id === userId) return user;
    const operator = (user.operators || []).find((item) => item.id === userId);
    if (operator) return operator;
  }
  return null;
}

async function handleAdminPasswordSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form.matches(".password-form")) return;
  const row = form.closest("[data-user-id]");
  const password = new FormData(form).get("password");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    form.reset();
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = "Senha atualizada.";
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleAdminUsersClick(event) {
  const triageButton = event.target.closest("[data-toggle-admin-triage]");
  if (triageButton) {
    triageButton.disabled = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(triageButton.dataset.toggleAdminTriage)}/triage-access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triageAccess: triageButton.dataset.triageAccess === "true" })
      });
      $("#adminMessage").style.color = "#0f766e";
      $("#adminMessage").textContent = "Permissao de triagem atualizada.";
      await loadAdminUsers();
    } catch (error) {
      $("#adminMessage").style.color = "";
      $("#adminMessage").textContent = error.message;
    } finally {
      triageButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-delete-user]");
  if (!button) return;
  const user = findAdminUser(button.dataset.deleteUser);
  if (!user) return;
  const deleteMessage = user.role === "operator"
    ? `Excluir operador ${user.name}?`
    : `Excluir ${user.name}? Esta acao apaga tambem os lotes deste usuario.`;
  if (!confirm(deleteMessage)) return;

  button.disabled = true;
  try {
    await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = "Usuario excluido.";
    await loadAdminUsers();
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleAdminCatalogRequestsClick(event) {
  const clearFiltersButton = event.target.closest("[data-clear-catalog-filters]");
  if (clearFiltersButton) {
    state.adminCatalogRequestFilters = { creator: "", date: "", doubleCheckOnly: false };
    renderAdminCatalogRequests();
    return;
  }

  const bulkButton = event.target.closest("[data-review-catalog-bulk]");
  if (bulkButton) {
    await reviewSelectedCatalogRequests(bulkButton.dataset.reviewCatalogBulk, bulkButton);
    return;
  }

  const button = event.target.closest("[data-review-catalog]");
  if (!button) return;
  const row = button.closest("[data-catalog-request-id]");
  const action = button.dataset.reviewCatalog;
  const selectedCheckId = row.querySelector('input[type="radio"][name^="catalog-choice-"]:checked')?.value || "base";
  const actionLabel = action === "approve" ? "aprovar" : "rejeitar";
  if (!confirm(`Deseja ${actionLabel} esta sugestao?`)) return;
  button.disabled = true;
  try {
    await reviewCatalogRequestById(row.dataset.catalogRequestId, action, selectedCheckId);
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = action === "approve" ? "Sugestao aprovada." : "Sugestao rejeitada.";
    await loadAdminCatalogReviewLists();
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function handleAdminCatalogRequestsFilter(event) {
  const form = event.target.closest("[data-catalog-request-filters]");
  if (!form) return;
  event.preventDefault();
  updateAdminCatalogRequestFilters(form);
}

function handleAdminCatalogRequestsChange(event) {
  const selectVisible = event.target.closest("[data-select-catalog-visible]");
  if (selectVisible) {
    selectVisible.closest(".catalog-request-section")
      ?.querySelectorAll("[data-select-catalog-request]:not(:disabled)")
      .forEach((checkbox) => { checkbox.checked = selectVisible.checked; });
    return;
  }

  const filterInput = event.target.closest("[data-catalog-request-filters] input");
  if (filterInput) {
    updateAdminCatalogRequestFilters(event.target.form);
  }
}

function updateAdminCatalogRequestFilters(form) {
  const data = new FormData(form);
  state.adminCatalogRequestFilters = {
    creator: String(data.get("creator") || ""),
    date: String(data.get("date") || ""),
    doubleCheckOnly: data.get("doubleCheckOnly") === "on"
  };
  renderAdminCatalogRequests();
}

async function reviewSelectedCatalogRequests(action, button) {
  const rows = [...document.querySelectorAll("#adminCatalogRequests [data-catalog-request-id]")]
    .filter((row) => row.querySelector("[data-select-catalog-request]:checked"));
  if (!rows.length) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = "Selecione pelo menos uma sugestao.";
    return;
  }

  const actionLabel = action === "approve" ? "aprovar" : "rejeitar";
  if (!confirm(`Deseja ${actionLabel} ${rows.length} sugestao${rows.length === 1 ? "" : "es"} selecionada${rows.length === 1 ? "" : "s"}?`)) return;

  const buttons = [...document.querySelectorAll("#adminCatalogRequests button, #adminCatalogRequests input")];
  buttons.forEach((control) => { control.disabled = true; });
  button.disabled = true;
  try {
    for (const row of rows) {
      const selectedCheckId = row.querySelector('input[type="radio"][name^="catalog-choice-"]:checked')?.value || "base";
      await reviewCatalogRequestById(row.dataset.catalogRequestId, action, selectedCheckId);
    }
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = action === "approve"
      ? `${rows.length} sugestao${rows.length === 1 ? "" : "es"} aprovada${rows.length === 1 ? "" : "s"}.`
      : `${rows.length} sugestao${rows.length === 1 ? "" : "es"} rejeitada${rows.length === 1 ? "" : "s"}.`;
    await loadAdminCatalogReviewLists();
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
    await loadAdminCatalogReviewLists();
  }
}

async function reviewCatalogRequestById(requestId, action, selectedCheckId = "base") {
  return api(`/api/admin/catalog-requests/${encodeURIComponent(requestId)}/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action === "approve" ? { selectedCheckId } : {})
  });
}

async function handleAdminCatalogProductsClick(event) {
  const button = event.target.closest("[data-delete-catalog-product]");
  if (!button) return;
  const product = state.adminCatalogProducts.find((item) => item.id === button.dataset.deleteCatalogProduct);
  if (!product || !confirm(`Excluir ${product.codigoMl} do banco historico oficial?`)) return;

  button.disabled = true;
  try {
    await api(`/api/admin/catalog-products/${encodeURIComponent(product.id)}`, { method: "DELETE" });
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = "Produto removido do banco historico.";
    await loadAdminCatalogProducts();
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function showTransferReceiveOnly({ transferLotId }) {
  state.transferReceiveOnly = true;
  state.selectedTransferLotId = transferLotId;
  document.body.classList.add("scan-only");
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#adminApp").classList.add("hidden");
  $("#app .app-nav")?.classList.add("hidden");
  $(".upload-band").classList.add("hidden");
  $("#lotsTab").classList.add("hidden");
  $("#searchTab").classList.add("hidden");
  $("#profileTab").classList.add("hidden");
  $("#transfersTab").classList.remove("hidden");
  document.querySelector(".transfer-create-panel")?.classList.add("hidden");
  $("#transferLots").innerHTML = "";
  $("#transferDetail").classList.remove("empty");
  $("#transferDetail").innerHTML = '<p class="muted">Carregando remessa...</p>';
  try {
    const response = await api(`${transferReceiveApiBase(transferLotId)}`);
    renderTransferReceivePage(response.lot);
  } catch (error) {
    $("#transferDetail").innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
  }
}

function transferReceiveApiBase(transferLotId) {
  const prefix = state.transferReceiveOnly ? "/api/public/transfer-lots" : "/api/transfer-lots";
  return `${prefix}/${encodeURIComponent(transferLotId)}`;
}

function renderTransferReceivePage(lot, { suppressInputFocus = false } = {}) {
  const detail = $("#transferDetail");
  const pending = state.pendingTransferConfirmation?.transferLotId === lot.id ? state.pendingTransferConfirmation : null;
  const cameraActive = Boolean(state.transferCameraStream) || suppressInputFocus;
  if (!pending && isTransferReceiveComplete(lot)) {
    stopTransferCamera();
    renderTransferReceiveCompletePage(lot);
    return;
  }
  detail.classList.remove("empty");
  detail.innerHTML = `
    <section class="scan-page transfer-receive-page">
      <div class="scan-heading">
        <div>
          <span class="muted">${escapeHtml(lot.depositoOrigem)} para ${escapeHtml(lot.depositoDestino)}</span>
          <h2>${escapeHtml(lot.name)}</h2>
          ${lot.descricao ? `<p class="muted transfer-description">${escapeHtml(lot.descricao)}</p>` : ""}
        </div>
        <div class="transfer-status-group">
          ${isTransferReleasedForStore(lot.status) ? '<span class="transfer-store-check" aria-label="Liberada para loja" title="Liberada para loja">&#10003;</span>' : ""}
          <span class="badge ${transferStatusClass(lot.status)}">${transferStatusLabel(lot.status)}</span>
        </div>
      </div>
      <div class="summary-grid">
        ${metric("Planejado", lot.totalPlanned ?? lot.totalQty)}
        ${metric("Conferido", lot.totalReceived || 0)}
        ${metric("Falta", lot.totalPending ?? 0)}
      </div>
      <div class="camera-panel">
        <video id="transferCameraVideo" playsinline muted></video>
        ${pending ? `<div class="camera-confirmation">${transferPendingConfirmation(pending)}</div>` : ""}
        <div class="actions">
          <button type="button" id="transferCameraButton">Ler com camera</button>
          <button type="button" id="transferCameraStopButton" class="ghost">Parar camera</button>
        </div>
      </div>
      <form id="transferReceiveForm" class="scan-box">
        <input id="transferReceiveInput" name="code" placeholder="Bipe ou digite Codigo ML, SKU ou EAN" autocomplete="off" ${cameraActive ? "" : "autofocus"} ${pending ? "disabled" : ""} />
        <button type="submit" ${pending ? "disabled" : ""}>Ler etiqueta</button>
      </form>
      <div id="transferReceiveMessage" class="message"></div>
      ${transferDivergenceReportPanel(lot)}
      <details class="transfer-items-panel">
        <summary>
          <span>Ver itens da remessa</span>
          <strong>${lot.totalPending ?? 0} faltando</strong>
        </summary>
        <div class="diverse-table transfer-table">
          <div class="diverse-row transfer-row diverse-row-head">
            <span>SKU</span>
            <span>Codigo</span>
            <span>Produto</span>
            <span>CD</span>
            <span>Loja</span>
            <span>Falta</span>
            <span>Status</span>
          </div>
          ${transferReceiveRows(lot)}
        </div>
      </details>
    </section>
  `;
  $("#transferReceiveForm").addEventListener("submit", (event) => {
    event.preventDefault();
    prepareTransferReceiveConfirmation(lot);
  });
  detail.querySelector("[data-confirm-transfer-entry]")?.addEventListener("click", () => confirmTransferReceiveCurrent(lot.id));
  detail.querySelector("[data-cancel-transfer-entry]")?.addEventListener("click", () => cancelTransferReceiveConfirmation(lot));
  detail.querySelector("#transferDivergenceForm")?.addEventListener("submit", (event) => submitTransferDivergenceReport(event, lot.id));
  $("#transferCameraButton").addEventListener("click", () => startTransferCamera(lot.id, lot));
  $("#transferCameraStopButton").addEventListener("click", stopTransferCamera);
  if (!pending && !cameraActive) schedulePrimaryInputFocus(["#transferReceiveInput"]);
}

function isTransferReceiveComplete(lot) {
  const planned = Number(lot.totalPlanned ?? lot.totalQty ?? 0);
  const pending = Number(lot.totalPending ?? planned - Number(lot.totalReceived || 0));
  return planned > 0 && pending <= 0;
}

function renderTransferReceiveCompletePage(lot) {
  const detail = $("#transferDetail");
  detail.classList.remove("empty");
  detail.innerHTML = `
    <section class="scan-page transfer-receive-page transfer-complete-page">
      <div class="transfer-complete-hero">
        <span class="transfer-complete-icon" aria-hidden="true">OK</span>
        <div>
          <span class="muted">${escapeHtml(lot.depositoOrigem)} para ${escapeHtml(lot.depositoDestino)}</span>
          <h2>Conferencia encerrada</h2>
          <p>Todas as quantidades desta remessa foram conferidas.</p>
        </div>
        <div class="transfer-status-group">
          ${isTransferReleasedForStore(lot.status) ? '<span class="transfer-store-check" aria-label="Liberada para loja" title="Liberada para loja">&#10003;</span>' : ""}
          <span class="badge ${transferStatusClass(lot.status)}">${transferStatusLabel(lot.status)}</span>
        </div>
      </div>
      <div class="summary-grid">
        ${metric("Planejado", lot.totalPlanned ?? lot.totalQty)}
        ${metric("Conferido", lot.totalReceived || 0)}
        ${metric("Falta", lot.totalPending ?? 0)}
      </div>
      <div id="transferReceiveMessage" class="message transfer-complete-message">Pode fechar esta tela.</div>
      ${transferDivergenceReportPanel(lot)}
      <details class="transfer-items-panel">
        <summary>
          <span>Itens conferidos</span>
          <strong>${lot.totalSkus || 0} SKUs</strong>
        </summary>
        <div class="diverse-table transfer-table">
          <div class="diverse-row transfer-row diverse-row-head">
            <span>SKU</span>
            <span>Codigo</span>
            <span>Produto</span>
            <span>CD</span>
            <span>Loja</span>
            <span>Falta</span>
            <span>Status</span>
          </div>
          ${transferReceiveAllRows(lot)}
        </div>
      </details>
    </section>
  `;
  detail.querySelector("#transferDivergenceForm")?.addEventListener("submit", (event) => submitTransferDivergenceReport(event, lot.id));
}

function transferDivergenceReportPanel(lot) {
  const disabled = lot.status === "synced";
  return `
    <details class="transfer-divergence-panel">
      <summary>
        <span>Reportar divergencia</span>
        <strong>${lot.divergenceCount || 0} reportes</strong>
      </summary>
      <form id="transferDivergenceForm" class="transfer-divergence-form">
        <label>Tipo
          <select name="type" ${disabled ? "disabled" : ""} required>
            <option value="falta">Falta de item</option>
            <option value="sobra">Sobra de item</option>
            <option value="avaria">Avaria</option>
            <option value="produto_trocado">Produto trocado</option>
            <option value="outro">Outro</option>
          </select>
        </label>
        <label>Codigo do item
          <input name="code" placeholder="Opcional: Codigo ML, SKU ou EAN" autocomplete="off" ${disabled ? "disabled" : ""} />
        </label>
        <label>Operador
          <input name="reporterName" placeholder="Nome de quem esta conferindo" maxlength="120" autocomplete="name" ${disabled ? "disabled" : ""} />
        </label>
        <label class="transfer-divergence-description">Descricao
          <textarea name="description" rows="4" maxlength="1000" placeholder="Descreva o que foi encontrado na remessa" ${disabled ? "disabled" : ""} required></textarea>
        </label>
        <button type="submit" ${disabled ? "disabled" : ""}>Enviar reporte</button>
      </form>
    </details>
  `;
}

async function submitTransferDivergenceReport(event, transferLotId) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const message = $("#transferReceiveMessage") || $("#transferScanMessage");
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.code = normalizeCode(payload.code || "");
  if (String(payload.description || "").trim().length < 5) {
    if (message) {
      message.style.color = "";
      message.textContent = "Descreva a divergencia com pelo menos 5 caracteres.";
    }
    return;
  }
  button.disabled = true;
  try {
    const response = await api(`${transferReceiveApiBase(transferLotId)}/divergence-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    form.reset();
    state.pendingTransferConfirmation = null;
    renderTransferReceivePage(response.lot);
    const updatedMessage = $("#transferReceiveMessage");
    if (updatedMessage) {
      updatedMessage.style.color = "#0f766e";
      updatedMessage.textContent = "Divergencia reportada na remessa.";
    }
  } catch (error) {
    if (message) {
      message.style.color = "";
      message.textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
}

function transferPendingConfirmation(pending) {
  const item = pending.item;
  const title = item ? escapeHtml(item.descricao) : "Produto nao identificado na remessa";
  const force = pending.force === true;
  const subtitle = item ? `${escapeHtml(item.sku)} · ${escapeHtml(item.codigoMl)}` : escapeHtml(pending.code);
  return `
    <section class="transfer-confirm-panel ${force ? "force-transfer-panel" : ""}">
      <span class="muted">${force ? "Codigo fora da remessa" : "Etiqueta lida"}</span>
      <strong>${title}</strong>
      <span>${subtitle}</span>
      ${force ? `
        <p>Deseja forcar a transferencia deste item no Bling?</p>
        <label>Descreva o ocorrido antes de finalizar
          <textarea id="forceTransferReason" rows="4" maxlength="1000" placeholder="Ex.: item fisico veio junto na caixa, mas nao estava previsto na remessa."></textarea>
        </label>
      ` : ""}
      <div class="transfer-confirm-actions">
        <button type="button" data-confirm-transfer-entry>${force ? "Forcar transferencia no Bling" : "Confirmar entrada no estoque"}</button>
        <button type="button" class="ghost" data-cancel-transfer-entry>Cancelar leitura</button>
      </div>
    </section>
  `;
}

function transferReceiveRows(lot) {
  const pendingItems = (lot.items || []).filter((item) => Number(item.falta ?? Math.max(0, Number(item.quantidade || 0) - Number(item.quantidadeConferida || 0))) > 0);
  return pendingItems.length
    ? pendingItems.map(transferReceiveItemRow).join("")
    : '<p class="muted transfer-empty">Todos os itens desta remessa foram conferidos e transferidos.</p>';
}

function transferReceiveAllRows(lot) {
  return (lot.items || []).length
    ? lot.items.map(transferReceiveItemRow).join("")
    : '<p class="muted transfer-empty">Nenhum item encontrado nesta remessa.</p>';
}

function transferReceiveItemRow(item) {
  const falta = item.falta ?? Math.max(0, Number(item.quantidade || 0) - Number(item.quantidadeConferida || 0));
  const status = item.forceReason ? "Sobra forcada" : receiveStatusLabel(item.statusConferencia);
  return `
    <article class="diverse-row transfer-row">
      <strong>${escapeHtml(item.sku)}</strong>
      <span>${escapeHtml(item.codigoMl)}</span>
      <span>${escapeHtml(item.descricao)}</span>
      <span>${item.quantidade}</span>
      <span>${item.quantidadeConferida || 0}</span>
      <span>${falta}</span>
      <span>${escapeHtml(status)}</span>
    </article>
  `;
}

function receiveStatusLabel(status) {
  return ({ pendente: "Pendente", parcial: "Parcial", ok: "OK", sobra: "Sobra" })[status] || "";
}

function findTransferReceiveItem(lot, code) {
  const normalized = normalizeCode(code);
  return (lot.items || []).find((item) => {
    return (
      normalizeCode(item.codigoMl) === normalized ||
      normalizeCode(item.sku) === normalized ||
      normalizeCode(code39BarcodeValue(item.sku)) === normalized ||
      normalizeCode(item.ean) === normalized
    );
  }) || null;
}

function prepareTransferReceiveConfirmation(lot) {
  if (state.pendingTransferReceive || state.pendingTransferConfirmation) return;
  const input = $("#transferReceiveInput");
  if (!input) return;
  const code = normalizeCode(input.value);
  input.value = code;
  if (!code) return;
  const item = findTransferReceiveItem(lot, code);
  const forcedExcess = item && Number(item.quantidade || 0) === 0;
  const missing = item ? Number(item.falta ?? Math.max(0, Number(item.quantidade || 0) - Number(item.quantidadeConferida || 0))) : 0;
  playTransferReadSound();
  if (!item || forcedExcess) {
    state.pendingTransferConfirmation = { transferLotId: lot.id, code, item, force: true };
    input.value = "";
    if (state.transferCameraStream) {
      mountTransferCameraConfirmation(lot);
    } else {
      renderTransferReceivePage(lot);
    }
    const message = $("#transferReceiveMessage");
    message.style.color = "";
    message.textContent = "Codigo lido, mas nao previsto nesta remessa. Confirme se deseja forcar a transferencia no Bling.";
    schedulePrimaryInputFocus(["#forceTransferReason"]);
    return;
  }
  if (missing <= 0) {
    $("#transferReceiveMessage").style.color = "";
    $("#transferReceiveMessage").textContent = "Este produto ja foi totalmente conferido.";
    input.select();
    return;
  }
  state.pendingTransferConfirmation = { transferLotId: lot.id, code, item };
  input.value = "";
  if (state.transferCameraStream) {
    mountTransferCameraConfirmation(lot);
  } else {
    renderTransferReceivePage(lot);
  }
  const message = $("#transferReceiveMessage");
  message.style.color = "#0f766e";
  message.textContent = "Confira o produto em maos e confirme a entrada no estoque.";
}

function cancelTransferReceiveConfirmation(lot) {
  state.pendingTransferConfirmation = null;
  if (state.transferCameraStream) {
    clearTransferCameraConfirmation();
    const input = $("#transferReceiveInput");
    const button = $("#transferReceiveForm button");
    if (input) input.disabled = false;
    if (button) button.disabled = false;
  } else {
    renderTransferReceivePage(lot);
  }
  $("#transferReceiveMessage").textContent = "Leitura cancelada.";
}

function mountTransferCameraConfirmation(lot) {
  const cameraPanel = $(".camera-panel");
  const input = $("#transferReceiveInput");
  const button = $("#transferReceiveForm button");
  if (input) input.disabled = true;
  if (button) button.disabled = true;
  if (!cameraPanel || !state.pendingTransferConfirmation) return;
  clearTransferCameraConfirmation();
  cameraPanel.classList.add("has-confirmation");
  cameraPanel.insertAdjacentHTML("beforeend", `<div class="camera-confirmation">${transferPendingConfirmation(state.pendingTransferConfirmation)}</div>`);
  cameraPanel.querySelector("[data-confirm-transfer-entry]")?.addEventListener("click", () => confirmTransferReceiveCurrent(lot.id));
  cameraPanel.querySelector("[data-cancel-transfer-entry]")?.addEventListener("click", () => cancelTransferReceiveConfirmation(lot));
}

function clearTransferCameraConfirmation() {
  $(".camera-panel")?.classList.remove("has-confirmation");
  $(".camera-confirmation")?.remove();
}

async function confirmTransferReceiveCurrent(transferLotId) {
  if (state.pendingTransferReceive) return;
  const pending = state.pendingTransferConfirmation;
  if (!pending || pending.transferLotId !== transferLotId) return;
  const button = $("#transferReceiveForm button");
  const confirmButton = $("[data-confirm-transfer-entry]");
  const input = $("#transferReceiveInput");
  const code = pending.code;
  const reason = pending.force ? String($("#forceTransferReason")?.value || "").trim() : "";
  if (pending.force && reason.length < 5) {
    $("#transferReceiveMessage").style.color = "";
    $("#transferReceiveMessage").textContent = "Descreva o ocorrido antes de forcar a transferencia.";
    schedulePrimaryInputFocus(["#forceTransferReason"]);
    return;
  }
  state.pendingTransferReceive = true;
  if (input) input.disabled = true;
  if (button) button.disabled = true;
  if (confirmButton) confirmButton.disabled = true;
  const shouldResumeCamera = Boolean(state.transferCameraStream);
  try {
    const endpoint = pending.force ? "force-receive-scan" : "receive-scan";
    const response = await api(`${transferReceiveApiBase(transferLotId)}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending.force ? { code, reason } : { code })
    });
    state.pendingTransferConfirmation = null;
    if (shouldResumeCamera) stopTransferCamera();
    renderTransferReceivePage(response.lot, { suppressInputFocus: shouldResumeCamera });
    playTransferSuccessSound();
    const message = $("#transferReceiveMessage");
    message.style.color = "#0f766e";
    message.textContent = pending.force
      ? `${response.item?.sku || code} transferido no Bling com ocorrencia registrada.`
      : `${response.item?.sku || code} confirmado no estoque.`;
    if (shouldResumeCamera && !isTransferReceiveComplete(response.lot)) await startTransferCamera(transferLotId, response.lot);
  } catch (error) {
    playTransferErrorSound();
    $("#transferReceiveMessage").style.color = "";
    $("#transferReceiveMessage").textContent = error.message;
  } finally {
    state.pendingTransferReceive = false;
    const currentInput = $("#transferReceiveInput");
    const currentButton = $("#transferReceiveForm button");
    const currentConfirmButton = $("[data-confirm-transfer-entry]");
    if (currentInput) currentInput.disabled = Boolean(state.pendingTransferConfirmation);
    if (currentButton) currentButton.disabled = Boolean(state.pendingTransferConfirmation);
    if (currentConfirmButton) currentConfirmButton.disabled = false;
    if (!state.pendingTransferConfirmation && !state.transferCameraStream) schedulePrimaryInputFocus(["#transferReceiveInput"]);
  }
}

function playTransferSuccessSound() {
  playToneSequence([880, 1175], 0.09, 0.04);
}

function playTransferReadSound() {
  playToneSequence([660], 0.08, 0);
}

function playTransferErrorSound() {
  playToneSequence([220, 180], 0.12, 0.03);
}

function playToneSequence(frequencies, duration = 0.1, gap = 0.04) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  let start = context.currentTime;
  frequencies.forEach((frequency) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
    start += duration + gap;
  });
  setTimeout(() => context.close().catch(() => {}), (start - context.currentTime + 0.1) * 1000);
}

async function startTransferCamera(transferLotId, lot) {
  if (!("BarcodeDetector" in window)) {
    $("#transferReceiveMessage").textContent = "Este navegador nao possui leitor de codigo nativo. Use o campo de bipagem.";
    return;
  }
  stopTransferCamera();
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e"] });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    state.transferCameraStream = stream;
    const video = $("#transferCameraVideo");
    video.srcObject = stream;
    await video.play();
    state.transferCameraTimer = window.setInterval(async () => {
      if (state.pendingTransferReceive || state.pendingTransferConfirmation) return;
      if (!video.videoWidth) return;
      const codes = await detector.detect(video).catch(() => []);
      const code = chooseTransferCameraCode(codes, lot);
      const now = Date.now();
      if (!code || (code === state.lastCameraCode && now - state.lastCameraScanAt < 10000)) return;
      state.lastCameraCode = code;
      state.lastCameraScanAt = now;
      $("#transferReceiveInput").value = code;
      prepareTransferReceiveConfirmation(lot);
    }, 700);
    $("#transferReceiveMessage").style.color = "#0f766e";
    $("#transferReceiveMessage").textContent = "Camera ativa. Aponte para o codigo de barras.";
  } catch (error) {
    $("#transferReceiveMessage").style.color = "";
    $("#transferReceiveMessage").textContent = `Nao foi possivel abrir a camera: ${error.message}`;
  }
}

function chooseTransferCameraCode(codes, lot) {
  const normalizedCodes = (codes || [])
    .map((item) => ({ value: normalizeCode(item.rawValue), format: String(item.format || "").toLowerCase() }))
    .filter((item) => item.value);
  const matchingCodes = normalizedCodes.filter((item) => findTransferReceiveItem(lot, item.value));
  return (
    matchingCodes.find((item) => item.format === "code_39")?.value ||
    matchingCodes.find((item) => item.format === "code_128")?.value ||
    matchingCodes[0]?.value ||
    ""
  );
}

function stopTransferCamera() {
  if (state.transferCameraTimer) window.clearInterval(state.transferCameraTimer);
  state.transferCameraTimer = null;
  if (state.transferCameraStream) state.transferCameraStream.getTracks().forEach((track) => track.stop());
  state.transferCameraStream = null;
  state.lastCameraCode = "";
  state.lastCameraScanAt = 0;
}

async function loadTransferLots(selectId = state.selectedTransferLotId) {
  try {
    const response = await api("/api/transfer-lots");
    state.transferLots = response.lots || [];
    renderTransferLots();
    if (selectId && state.transferLots.some((lot) => lot.id === selectId)) {
      await selectTransferLot(selectId);
    } else if (!selectId) {
      clearTransferDetail();
    }
  } catch (error) {
    $("#transferMessage").textContent = error.message;
  }
}

async function loadBlingDeposits({ force = false } = {}) {
  const form = $("#transferLotForm");
  if (!form || (state.blingDepositsLoaded && !force)) return;
  renderDepositSelects({ loading: true });
  try {
    const response = await api("/api/bling/deposits");
    state.blingDeposits = response.deposits || [];
    state.blingDepositsLoaded = true;
    renderDepositSelects();
    if (!state.blingDeposits.length) {
      $("#transferMessage").style.color = "";
      $("#transferMessage").textContent = "Nenhum deposito ativo foi encontrado no Bling.";
    }
  } catch (error) {
    state.blingDeposits = [];
    state.blingDepositsLoaded = false;
    renderDepositSelects({ error: error.message });
    $("#transferMessage").style.color = "";
    $("#transferMessage").textContent = `${error.message} Autorize o Bling em Perfil > Sincronizacao para selecionar os depositos.`;
  }
}

function renderDepositSelects({ loading = false, error = "" } = {}) {
  const selects = [...document.querySelectorAll("#transferLotForm select[name='depositoOrigem'], #transferLotForm select[name='depositoDestino']")];
  if (!selects.length) return;
  const options = loading
    ? '<option value="">Carregando depositos...</option>'
    : error
      ? '<option value="">Depositos indisponiveis</option>'
      : '<option value="">Selecione</option>' + state.blingDeposits.map((deposit) => `<option value="${escapeHtml(deposit.descricao)}">${escapeHtml(deposit.descricao)}</option>`).join("");

  selects.forEach((select) => {
    const previous = select.value;
    select.innerHTML = options;
    select.disabled = loading || Boolean(error) || !state.blingDeposits.length;
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  });
}

async function createTransferLot(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  $("#transferMessage").textContent = "";
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    if (normalizeCode(payload.depositoOrigem) === normalizeCode(payload.depositoDestino)) {
      throw new Error("Escolha depositos diferentes para origem e destino.");
    }
    const response = await api("/api/transfer-lots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    form.reset();
    $("#transferMessage").style.color = "#0f766e";
    $("#transferMessage").textContent = "Lote de transferencia criado. Pode comecar a bipar.";
    await loadTransferLots(response.lot.id);
    $("#transferScanInput")?.focus();
  } catch (error) {
    $("#transferMessage").style.color = "";
    $("#transferMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderTransferLots() {
  const wrapper = $("#transferLots");
  if (!wrapper) return;
  if (!state.transferLots.length) {
    wrapper.innerHTML = '<p class="muted">Nenhum lote de transferencia criado.</p>';
    return;
  }
  wrapper.innerHTML = state.transferLots.map((lot) => `
    <article class="lot-card ${lot.id === state.selectedTransferLotId ? "active" : ""} ${isTransferReleasedForStore(lot.status) ? "transfer-released" : ""}" data-transfer-lot="${escapeHtml(lot.id)}">
      <div class="transfer-card-title">
        <strong>${escapeHtml(lot.name)}</strong>
        ${isTransferReleasedForStore(lot.status) ? '<span class="transfer-store-check" aria-label="Liberada para loja" title="Liberada para loja">&#10003;</span>' : ""}
      </div>
      ${lot.descricao ? `<span class="muted">${escapeHtml(lot.descricao)}</span>` : ""}
      <span class="muted">${lot.totalSkus} SKUs · ${lot.totalQty} unidades</span>
      <span class="muted">${escapeHtml(lot.depositoOrigem)} → ${escapeHtml(lot.depositoDestino)}</span>
      ${lot.divergenceCount ? `<span class="transfer-error-count">${lot.divergenceCount} erro${lot.divergenceCount === 1 ? "" : "s"} producao</span>` : ""}
      <span class="badge ${transferStatusClass(lot.status)}">${transferStatusLabel(lot.status)}</span>
    </article>
  `).join("");
}

function clearTransferDetail() {
  const detail = $("#transferDetail");
  if (!detail) return;
  detail.classList.add("empty");
  detail.textContent = "Crie ou selecione um lote de transferencia.";
}

async function handleTransferLotsClick(event) {
  const card = event.target.closest("[data-transfer-lot]");
  if (!card) return;
  await selectTransferLot(card.dataset.transferLot);
}

async function selectTransferLot(transferLotId) {
  state.selectedTransferLotId = transferLotId;
  const response = await api(`/api/transfer-lots/${encodeURIComponent(transferLotId)}`);
  renderTransferLots();
  renderTransferDetail(response.lot);
}

function renderTransferDetail(lot, { lastCode = "" } = {}) {
  const canSync = state.user?.role !== "operator";
  const synced = lot.status === "synced";
  const cdLocked = lot.status !== "open";
  const displayItems = prioritizeTransferItems(lot.items || [], lastCode);
  const detail = $("#transferDetail");
  detail.classList.remove("empty");
  detail.innerHTML = `
    <section class="transfer-panel">
      <div class="work-heading">
        <div>
          <span class="muted">${escapeHtml(lot.depositoOrigem)} → ${escapeHtml(lot.depositoDestino)}</span>
          <h2>${escapeHtml(lot.name)}</h2>
          ${lot.descricao ? `<p class="muted transfer-description">${escapeHtml(lot.descricao)}</p>` : ""}
        </div>
        <div class="transfer-status-group">
          ${isTransferReleasedForStore(lot.status) ? '<span class="transfer-store-check" aria-label="Liberada para loja" title="Liberada para loja">&#10003;</span>' : ""}
          <span class="badge ${transferStatusClass(lot.status)}">${transferStatusLabel(lot.status)}</span>
        </div>
      </div>
      <form id="transferScanForm" class="search-bar">
        <input id="transferScanInput" name="code" placeholder="CD: bipe Codigo ML ou SKU para montar a remessa" autocomplete="off" ${synced || cdLocked ? "disabled" : ""} required />
        <button type="submit" ${synced || cdLocked ? "disabled" : ""}>Adicionar</button>
      </form>
      <p id="transferScanMessage" class="message"></p>
      <div class="summary-grid">
        ${metric("SKUs", lot.totalSkus)}
        ${metric("Planejado CD", lot.totalPlanned ?? lot.totalQty)}
        ${metric("Conferido loja", lot.totalReceived || 0)}
        ${metric("Falta", lot.totalPending ?? 0)}
      </div>
      <div class="summary-grid">
        ${metric("Origem", lot.depositoOrigem)}
        ${metric("Destino", lot.depositoDestino)}
      </div>
      ${transferDivergenceReportsList(lot)}
      <div class="actions">
        <button type="button" data-print-transfer-qr="${escapeHtml(lot.id)}" ${!lot.items.length ? "disabled" : ""}>Imprimir QR da remessa</button>
        <button type="button" data-release-transfer="${escapeHtml(lot.id)}" ${synced || cdLocked || !lot.items.length ? "disabled" : ""}>Liberar para loja</button>
        <a class="button-link" href="/transferencias/${encodeURIComponent(lot.id)}/loja">Abrir conferencia da loja</a>
      </div>
      <div class="actions ${canSync ? "" : "hidden"}">
        <a class="button-link" href="/api/transfer-lots/${encodeURIComponent(lot.id)}/bling">Baixar CSV</a>
        <button type="button" data-sync-transfer="${escapeHtml(lot.id)}" ${synced || !lot.items.length || !(lot.totalReceived || 0) ? "disabled" : ""}>Enviar transferencia ao Bling</button>
      </div>
      <div class="diverse-table transfer-table">
        <div class="diverse-row transfer-row diverse-row-head">
          <span>SKU</span>
          <span>Codigo</span>
          <span>Produto</span>
          <span>CD</span>
          <span>Loja</span>
          <span>Falta</span>
          <span>Acoes</span>
        </div>
        ${displayItems.length ? displayItems.map((item) => transferItemRow(item, synced || cdLocked)).join("") : '<p class="muted transfer-empty">Nenhum produto bipado.</p>'}
      </div>
    </section>
  `;
  schedulePrimaryInputFocus(["#transferScanInput"]);
}

function prioritizeTransferItems(items, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return items;
  return [...items].sort((a, b) => Number(transferItemMatchesCode(b, normalized)) - Number(transferItemMatchesCode(a, normalized)));
}

function transferItemMatchesCode(item, normalizedCode) {
  return [item.codigoMl, item.sku, code39BarcodeValue(item.sku), item.ean]
    .some((value) => normalizeCode(value) === normalizedCode);
}

function transferDivergenceReportsList(lot) {
  const reports = lot.divergenceReports || [];
  if (!reports.length) return "";
  return `
    <section class="transfer-divergence-list">
      <div class="transfer-divergence-list-heading">
        <strong>Divergencias reportadas</strong>
        <span>${reports.length}</span>
      </div>
      ${reports.map((report) => `
        <article class="transfer-divergence-item">
          <div>
            <strong>${transferDivergenceTypeLabel(report.type)}</strong>
            <span>${formatDateTime(report.createdAt)}${report.reporterName ? ` - ${escapeHtml(report.reporterName)}` : ""}</span>
          </div>
          ${report.code ? `<code>${escapeHtml(report.code)}</code>` : ""}
          <p>${escapeHtml(report.description)}</p>
        </article>
      `).join("")}
    </section>
  `;
}

function transferDivergenceTypeLabel(type) {
  return ({
    falta: "Falta de item",
    sobra: "Sobra de item",
    avaria: "Avaria",
    produto_trocado: "Produto trocado",
    outro: "Outro"
  })[type] || "Divergencia";
}

function transferItemRow(item, synced) {
  const falta = item.falta ?? Math.max(0, Number(item.quantidade || 0) - Number(item.quantidadeConferida || 0));
  return `
    <article class="diverse-row transfer-row">
      <strong>${escapeHtml(item.sku)}</strong>
      <span>${escapeHtml(item.codigoMl)}</span>
      <span>${escapeHtml(item.descricao)}</span>
      <span>${item.quantidade}</span>
      <span>${item.quantidadeConferida || 0}</span>
      <span>${falta}</span>
      <span class="transfer-row-actions">
        <button type="button" class="danger ghost" data-transfer-decrement="${escapeHtml(item.id)}" ${synced ? "disabled" : ""}>Diminuir</button>
        <button type="button" class="danger ghost" data-transfer-delete="${escapeHtml(item.id)}" ${synced ? "disabled" : ""}>Excluir</button>
      </span>
    </article>
  `;
}

function transferStatusLabel(status) {
  return ({
    open: "CD montando",
    waiting_store: "Liberada para loja",
    checking: "Loja conferindo",
    ready_sync: "Conferida",
    divergent: "Divergente",
    synced: "Enviada"
  })[status] || "Aberta";
}

function isTransferReleasedForStore(status) {
  return ["waiting_store", "checking", "ready_sync", "divergent"].includes(status);
}

function transferStatusClass(status) {
  if (status === "synced" || status === "ready_sync") return "";
  if (status === "divergent") return "danger";
  return "excess";
}

async function handleTransferDetailSubmit(event) {
  if (event.target.id !== "transferScanForm") return;
  event.preventDefault();
  if (!state.selectedTransferLotId) return;
  const input = event.target.querySelector("input[name='code']");
  const button = event.target.querySelector("button");
  const code = normalizeCode(input.value);
  input.value = code;
  if (!code) return;
  button.disabled = true;
  try {
    const response = await api(`/api/transfer-lots/${encodeURIComponent(state.selectedTransferLotId)}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    input.value = "";
    renderTransferDetail(response.lot, { lastCode: code });
    await loadTransferLots(response.lot.id);
    $("#transferScanMessage").style.color = "#0f766e";
    $("#transferScanMessage").textContent = `${response.product.sku} adicionado ao lote.`;
  } catch (error) {
    $("#transferScanMessage").style.color = "";
    $("#transferScanMessage").textContent = error.message;
    input.select();
  } finally {
    button.disabled = false;
    schedulePrimaryInputFocus(["#transferScanInput"]);
  }
}

async function handleTransferDetailClick(event) {
  const deleteButton = event.target.closest("[data-transfer-delete]");
  if (deleteButton && state.selectedTransferLotId) {
    let reason = "";
    if (state.user?.role === "operator") {
      reason = prompt("Informe a justificativa para excluir este item da remessa:")?.trim() || "";
      if (reason.length < 5) {
        $("#transferScanMessage").style.color = "";
        $("#transferScanMessage").textContent = "Informe uma justificativa com pelo menos 5 caracteres.";
        return;
      }
    } else if (!confirm("Excluir este item da remessa?")) {
      return;
    }
    deleteButton.disabled = true;
    try {
      const response = await api(`/api/transfer-lots/${encodeURIComponent(state.selectedTransferLotId)}/items/${encodeURIComponent(deleteButton.dataset.transferDelete)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      });
      renderTransferDetail(response.lot);
      await loadTransferLots(state.selectedTransferLotId);
      $("#transferScanMessage").style.color = "#0f766e";
      $("#transferScanMessage").textContent = "Item excluido da remessa.";
    } catch (error) {
      $("#transferScanMessage").style.color = "";
      $("#transferScanMessage").textContent = error.message;
    }
    return;
  }

  const decrement = event.target.closest("[data-transfer-decrement]");
  if (decrement && state.selectedTransferLotId) {
    decrement.disabled = true;
    try {
      const response = await api(`/api/transfer-lots/${encodeURIComponent(state.selectedTransferLotId)}/items/${encodeURIComponent(decrement.dataset.transferDecrement)}/decrement`, { method: "POST" });
      renderTransferDetail(response.lot);
      await loadTransferLots(state.selectedTransferLotId);
    } catch (error) {
      $("#transferScanMessage").textContent = error.message;
    }
    return;
  }

  const sync = event.target.closest("[data-sync-transfer]");
  if (sync) await syncTransferLot(sync.dataset.syncTransfer, sync);

  const release = event.target.closest("[data-release-transfer]");
  if (release) await releaseTransferLot(release.dataset.releaseTransfer, release);

  const qr = event.target.closest("[data-print-transfer-qr]");
  if (qr) showTransferQrLabel(qr.dataset.printTransferQr);
}

async function releaseTransferLot(transferLotId, button) {
  if (!confirm("Liberar esta remessa para conferencia na loja?")) return;
  button.disabled = true;
  try {
    const response = await api(`/api/transfer-lots/${encodeURIComponent(transferLotId)}/release`, { method: "POST" });
    renderTransferDetail(response.lot);
    await loadTransferLots(transferLotId);
    $("#transferScanMessage").style.color = "#0f766e";
    $("#transferScanMessage").textContent = "Remessa liberada para a loja.";
  } catch (error) {
    $("#transferScanMessage").style.color = "";
    $("#transferScanMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function showTransferQrLabel(transferLotId) {
  const lot = state.transferLots.find((item) => item.id === transferLotId);
  const receiveUrl = `${window.location.origin}/transferencias/${encodeURIComponent(transferLotId)}/loja`;
  state.labelProduct = null;
  state.labelMeta = null;
  state.labelQuantity = 1;
  state.labelReturnFocusSelectors = currentLabelReturnFocusSelectors();
  state.labelPrintMarkup = `
    <section class="transfer-qr-label">
      <header class="transfer-label-header">
        <strong>REMESSA</strong>
        <span>${escapeHtml(lot?.name || transferLotId)}</span>
      </header>
      <img src="/api/transfer-lots/${encodeURIComponent(transferLotId)}/qr.svg" alt="QR Code da remessa" />
      <div class="transfer-label-info">
        ${lot?.descricao ? `<p>${escapeHtml(lot.descricao)}</p>` : ""}
        <dl>
          <div>
            <dt>ORIGEM</dt>
            <dd>${escapeHtml(lot?.depositoOrigem || "-")}</dd>
          </div>
          <div>
            <dt>DESTINO</dt>
            <dd>${escapeHtml(lot?.depositoDestino || "-")}</dd>
          </div>
          <div>
            <dt>ITENS</dt>
            <dd>${escapeHtml(String(lot?.totalQty || 0))} un. / ${escapeHtml(String(lot?.totalSkus || 0))} SKUs</dd>
          </div>
        </dl>
        <small>${escapeHtml(receiveUrl)}</small>
      </div>
    </section>
  `;
  $("#labelPreview").innerHTML = state.labelPrintMarkup;
  $("#labelPrintButton").textContent = "Imprimir QR";
  $("#labelModal").classList.remove("hidden");
  $("#labelModal").focus();
}

async function syncTransferLot(transferLotId, button) {
  if (!confirm("Enviar esta transferencia ao Bling agora?")) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/transfer-lots/${encodeURIComponent(transferLotId)}/bling/sync`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Nao foi possivel enviar a transferencia ao Bling.");
    await loadTransferLots(transferLotId);
    $("#transferScanMessage").style.color = "#0f766e";
    $("#transferScanMessage").textContent = `Transferencia enviada: ${payload.transferred} item(ns) para ${payload.depositoDestino?.descricao || ""}.`;
  } catch (error) {
    $("#transferScanMessage").style.color = "";
    $("#transferScanMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadLots(selectId = state.selectedLotId) {
  try {
    const response = await api("/api/lots");
    state.lots = response.lots;
    if (!selectId || !state.lots.some((lot) => lot.id === selectId)) {
      selectId = null;
      state.selectedLotId = null;
      state.previewLotId = null;
      state.selectedRz = null;
      clearLotDetail();
    }
    renderLots();
    if (selectId) await selectLot(selectId);
  } catch (error) {
    state.lots = [];
    state.selectedLotId = null;
    state.previewLotId = null;
    state.selectedRz = null;
    renderLots();
    clearLotDetail();
    $("#lots").innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
    $("#uploadMessage").textContent = error.message;
  }
}

async function refreshLotsList(activeLotId = state.selectedLotId) {
  const response = await api("/api/lots");
  state.lots = response.lots;
  if (activeLotId && state.lots.some((lot) => lot.id === activeLotId)) {
    state.selectedLotId = activeLotId;
    state.previewLotId = null;
  }
  renderLots();
}

function clearLotDetail() {
  document.body.classList.remove("lot-focus");
  state.previewLotId = null;
  $("#lotDetail").classList.add("empty");
  $("#lotDetail").innerHTML = emptyLotDetailMarkup();
  hideNoSheetPanel();
}

function renderLots() {
  const wrapper = $("#lots");
  wrapper.innerHTML = "";
  if (!state.lots.length) {
    wrapper.innerHTML = '<p class="muted">Nenhum lote criado ainda.</p>';
    return;
  }

  for (const lot of state.lots) {
    const card = document.createElement("article");
    const activeLotId = state.previewLotId || state.selectedLotId;
    card.className = `lot-card ${lot.id === activeLotId ? "active" : ""}`;
    card.innerHTML = `
      <strong>${escapeHtml(lot.nomeArquivo)}</strong>
      <span class="muted">${lot.totalProducts} SKUs · ${lot.rzs.length} RZs</span>
      <span class="muted">${escapeHtml(lot.prefixoSku)} · ${lot.percentualArremate}% · ${escapeHtml(lot.fornecedor)}</span>
      ${lot.totalExcessExternal ? `<span class="badge excess">${lot.totalExcessExternal} excedente(s)</span>` : ""}
    `;
    card.addEventListener("click", () => previewLot(lot.id));
    wrapper.appendChild(card);
  }
}

async function previewLot(lotId) {
  state.previewLotId = lotId;
  state.selectedLotId = null;
  state.selectedRz = null;
  setMainTab("lots", { push: false });
  renderLots();
  $("#lotDetail").classList.remove("empty");
  $("#lotDetail").innerHTML = '<p class="muted">Carregando status do lote...</p>';

  try {
    const response = await api(`/api/lots/${lotId}`);
    renderLotPreview(response.lot);
  } catch (error) {
    $("#lotDetail").classList.add("empty");
    $("#lotDetail").textContent = error.message;
  }
}

async function selectLot(lotId, { push = true } = {}) {
  state.selectedLotId = lotId;
  state.previewLotId = null;
  state.selectedRz = null;
  setMainTab("lots", { push: false });
  const response = await api(`/api/lots/${lotId}`);
  renderLots();
  renderLotDetail(response.lot);
  hideNoSheetPanel();
  document.body.classList.add("lot-focus");
  if (push) updateRoute(lotPath(lotId));
  return response.lot;
}

function renderLotPreview(lot) {
  const missingQty = lot.rzs.reduce((sum, rz) => sum + Number(rz.missing || 0), 0);
  const excessQty = lot.rzs.reduce((sum, rz) => sum + Number(rz.excess || 0), 0);
  const checkedRzs = lot.rzs.filter((rz) => Number(rz.qtyPercent || 0) >= 100 && Number(rz.missing || 0) === 0 && Number(rz.excess || 0) === 0).length;
  const status = missingQty === 0 && excessQty === 0 && lot.totalItems > 0 ? "Conferido" : lot.progress.checkedQty > 0 ? "Em andamento" : "Pendente";
  const detail = $("#lotDetail");
  detail.classList.remove("empty");
  detail.innerHTML = `
    <section class="lot-preview-panel">
      <div class="work-heading">
        <div>
          <span class="muted">Status do lote</span>
          <h2>${escapeHtml(lot.nomeArquivo)}</h2>
        </div>
        <button type="button" id="openLotButton">Abrir lote</button>
      </div>
      <div class="summary-grid">
        ${metric("Status", status)}
        ${metric("SKUs", lot.totalProducts)}
        ${metric("RZs", `${checkedRzs}/${lot.rzs.length}`)}
        ${metric("Excedentes", lot.totalExcessExternal)}
      </div>
      <h3 class="section-title">Andamento geral</h3>
      <div class="summary-grid">
        ${progressMetric("Quantidade", lot.progress.qtyPercent, `${lot.progress.checkedQty}/${lot.progress.expectedQty}`)}
        ${progressMetric("Preco de venda", lot.progress.valuePercent, `${money(lot.progress.checkedValue)} / ${money(lot.progress.expectedValue)}`)}
        ${metric("Itens faltantes", missingQty)}
        ${metric("Itens excedentes", excessQty)}
      </div>
      <h3 class="section-title">Resumo das RZs</h3>
      <div class="preview-rz-list">
        ${lot.rzs.length ? lot.rzs.map(previewRzRow).join("") : '<p class="muted">Nenhuma RZ encontrada neste lote.</p>'}
      </div>
    </section>
  `;
  $("#openLotButton").addEventListener("click", () => selectLot(lot.id));
}

function renderLotDetail(lot) {
  const detail = $("#lotDetail");
  const noSheetLot = isNoSheetLot(lot);
  const canManage = state.user?.role !== "operator";
  const canScan = true;
  moveDiversePanelToHome();
  detail.classList.remove("empty");
  detail.innerHTML = `
    <div class="work-heading">
      <div>
        <span class="muted">Lote em trabalho</span>
        <h2>${escapeHtml(lot.nomeArquivo)}</h2>
      </div>
      <button type="button" class="ghost" id="backToLotsButton">Voltar para lotes</button>
    </div>
    ${noSheetLot ? '<p class="muted">Lote sem planilha: gere/use uma RZ no painel do lote e inicie a bipagem.</p>' : ""}
    ${noSheetLot ? `
      <form id="lotNoSheetSuggestionUploadForm" class="suggestion-upload-form">
        <label>Lista de sugestao do lote<input name="file" type="file" accept=".xlsx,.xls,.csv,.txt" /></label>
        <button type="submit" class="ghost">Subir lista</button>
        <span id="lotNoSheetSuggestionUploadStatus" class="muted">${lot.noSheetSuggestions?.length ? `${lot.noSheetSuggestions.length} nomes na lista.` : ""}</span>
      </form>
    ` : ""}
    ${noSheetLot ? `
      <form id="lotDiverseRzForm" class="diverse-rz-form">
        <span class="muted">Proxima RZ: ${escapeHtml(nextNoSheetRzCode(lot))}</span>
        <button type="submit">Gerar RZ</button>
        <strong id="lotDiverseActiveRz">Nenhuma remessa ativa</strong>
        <span></span>
      </form>
    ` : ""}
    <div class="actions ${canManage ? "" : "hidden"}">
      <button data-download="complete">Baixar Bling - Lote completo</button>
      <button data-download="excess" ${lot.totalExcessExternal ? "" : "disabled"}>Baixar Bling - Somente excedentes</button>
      <button data-sync-products="complete">Criar produtos no Bling</button>
      <button class="danger" type="button" id="deleteLotButton">Excluir lote</button>
    </div>
    <p id="downloadMessage" class="message"></p>
    ${noSheetLot ? `
      <div class="summary-grid">
        ${metric("Quantidade bipada", lot.progress.checkedQty)}
        ${metric("Valor bipado", money(lot.progress.checkedValue))}
      </div>
    ` : `
      <div class="summary-grid">
        ${metric("SKUs", lot.totalProducts)}
        ${metric("Itens esperados", lot.totalItems)}
        ${metric("RZs", lot.rzs.length)}
        ${metric("Excedentes externos", lot.totalExcessExternal)}
      </div>
      <h3 class="section-title">Progresso do lote</h3>
      <div class="summary-grid">
        ${progressMetric("Quantidade", lot.progress.qtyPercent, `${lot.progress.checkedQty}/${lot.progress.expectedQty}`)}
        ${progressMetric("Preço de venda", lot.progress.valuePercent, `${money(lot.progress.checkedValue)} / ${money(lot.progress.expectedValue)}`)}
        ${metric("Valor faltante", money(lot.rzs.reduce((sum, rz) => sum + rz.missingValue, 0)))}
        ${metric("Valor excedente", money(lot.rzs.reduce((sum, rz) => sum + rz.excessValue, 0)))}
      </div>
    `}
    <h3 class="section-title">RZs</h3>
    <div class="rz-search">
      <input id="rzSearchInput" placeholder="Bipe ou digite o Código RZ" />
      <button id="rzSearchButton">Abrir RZ</button>
    </div>
    <p id="rzSearchMessage" class="message"></p>
    <div class="rz-grid">
      ${lot.rzs.map((rz) => rzCard(rz, { canScan })).join("")}
    </div>
    <div id="rzDetail"></div>
  `;
  $("#backToLotsButton").addEventListener("click", () => {
    state.selectedLotId = null;
    state.selectedRz = null;
    document.body.classList.remove("lot-focus");
    renderLots();
    clearLotDetail();
    updateRoute("/lotes");
  });
  if (canManage) {
    detail.querySelectorAll("button[data-download]").forEach((button) => {
      button.addEventListener("click", () => downloadBling(lot.id, button.dataset.download));
    });
    detail.querySelectorAll("button[data-sync-products]").forEach((button) => {
      button.addEventListener("click", () => syncBlingProducts(lot.id, button.dataset.syncProducts, button));
    });
    $("#deleteLotButton").addEventListener("click", () => deleteLot(lot));
  }
  $("#rzSearchButton").addEventListener("click", () => openRzFromSearch(lot));
  $("#rzSearchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") openRzFromSearch(lot);
  });
  $("#lotDiverseRzForm")?.addEventListener("submit", (event) => createLotDetailNoSheetRz(event, lot));
  $("#lotNoSheetSuggestionUploadForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await uploadNoSheetSuggestionsFromForm(event.currentTarget, $("#lotNoSheetSuggestionUploadStatus"), lot.id);
    if (response?.lot) renderLotDetail(response.lot);
  });
  detail.querySelectorAll("[data-scan-rz]").forEach((button) => {
    button.addEventListener("click", () => {
      if (noSheetLot) openNoSheetRz(lot, button.dataset.scanRz);
      else renderRz(lot, button.dataset.scanRz);
    });
  });
  detail.querySelectorAll("[data-pallet-rz]").forEach((button) => {
    button.addEventListener("click", () => renderPallet(lot, button.dataset.palletRz));
  });
  schedulePrimaryInputFocus(["#rzSearchInput"]);
}

function emptyLotDetailMarkup() {
  return `
    <section class="empty-lot-start">
      <div>
        <span class="muted">Novo lote</span>
        <h2>Criar lote sem planilha</h2>
      </div>
      <form id="noSheetLotForm" class="diverse-form">
        <label>Nome do lote<input name="name" placeholder="Lote sem planilha" /></label>
        <label>Fornecedor<input name="fornecedor" placeholder="AMZ04LOTE" required /></label>
        <label>Tipo de custo<select name="costMode"><option value="fixed">Custo fixo</option><option value="variable">Custo variavel</option></select></label>
        <label data-cost-field="fixed">Custo fixo unitario<input name="averageCost" type="number" min="0.01" step="0.01" placeholder="12.50" required /></label>
        <label data-cost-field="variable" class="hidden">% do valor de venda<input name="costPercent" type="number" min="0.01" step="0.01" placeholder="30" /></label>
        <label>Prefixo SKU<input name="skuPrefix" placeholder="DIV" required /></label>
        <label>Sequencial inicial<input name="startSequence" type="number" min="1" step="1" value="1" required /></label>
        <label class="wide-field">Lista de sugestao opcional<textarea name="suggestions" rows="3" placeholder="Um produto por linha, sem codigo"></textarea></label>
        <button type="submit">Criar lote</button>
      </form>
      <p id="noSheetLotMessage" class="message"></p>
    </section>
  `;
}

async function deleteLot(lot) {
  if (!confirm(`Excluir o lote ${lot.nomeArquivo}? Esta acao apaga tambem os produtos, RZs, bipagens e etiquetas deste lote.`)) return;

  const button = $("#deleteLotButton");
  button.disabled = true;
  try {
    await api(`/api/lots/${encodeURIComponent(lot.id)}`, { method: "DELETE" });
    state.selectedLotId = null;
    state.selectedRz = null;
    await loadLots(null);
  } catch (error) {
    const message = $("#downloadMessage");
    message.style.color = "";
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function openRzFromSearch(lot) {
  const input = $("#rzSearchInput");
  const message = $("#rzSearchMessage");
  const typed = normalizeCode(input.value);
  const rz = lot.rzs.find((item) => normalizeCode(item.codigoRz) === typed);
  if (!rz && isNoSheetLot(lot) && typed) {
    message.style.color = "";
    message.textContent = "Use Gerar RZ para criar o proximo codigo automaticamente.";
    input.select();
    return;
  }
  if (!rz) {
    message.style.color = "";
    message.textContent = "RZ não encontrado neste lote.";
    input.select();
    return;
  }
  message.textContent = "";
  input.value = "";
  if (isNoSheetLot(lot)) openNoSheetRz(lot, rz.codigoRz);
  else renderRz(lot, rz.codigoRz);
}

function createLotDetailNoSheetRz(event, lot) {
  event.preventDefault();
  openNoSheetRz(lot, nextNoSheetRzCode(lot));
}

function openNoSheetRz(lot, codigoRz) {
  const normalizedRz = normalizeCode(codigoRz);
  if (!normalizedRz) return;

  state.selectedDiverseRz = normalizedRz;
  state.selectedRz = null;
  document.querySelectorAll(".rz-card").forEach((card) => {
    card.classList.toggle("selected", normalizeCode(card.dataset.rz) === normalizedRz);
  });

  const message = $("#rzSearchMessage");
  if (message) {
    message.style.color = "#0f766e";
    message.textContent = `Remessa ${normalizedRz} ativa.`;
  }

  const activeRz = $("#lotDiverseActiveRz");
  if (activeRz) activeRz.textContent = `Remessa ativa: ${normalizedRz}`;

  const input = $("#rzSearchInput");
  if (input) input.value = "";

  const rzDetail = $("#rzDetail");
  if (rzDetail) rzDetail.innerHTML = '<div id="diversePanelMount"></div>';

  renderDiverseLot(lot);

  const scanMessage = $("#diverseScanMessage");
  if (scanMessage) {
    scanMessage.style.color = "#0f766e";
    scanMessage.textContent = `Remessa ${normalizedRz} ativa.`;
  }
  $("#diverseScanForm input[name='codigoMl']")?.focus();
}

async function downloadBling(lotId, kind, messageSelector = "#downloadMessage") {
  const message = $(messageSelector);
  message.textContent = "";
  try {
    if (state.config.downloadMode === "browser") {
      window.location.href = `/api/lots/${lotId}/bling/${kind}`;
      message.style.color = "#0f766e";
      message.textContent = "Download enviado para o navegador.";
      return;
    }

    const response = await fetch(`/api/lots/${lotId}/bling/${kind}/save`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Não foi possível gerar o arquivo Bling.");
    }
    const payload = await response.json();
    message.style.color = "#0f766e";
    message.innerHTML = `Arquivo salvo: <strong>${escapeHtml(payload.path)}</strong>`;
  } catch (error) {
    message.style.color = "";
    message.textContent = error.message;
  }
}

async function syncBlingProducts(lotId, kind, button, messageSelector = "#downloadMessage") {
  if (!confirm("Criar no Bling os produtos deste lote que ainda nao existem pelo SKU?")) return;
  const message = $(messageSelector);
  message.textContent = "";
  button.disabled = true;
  try {
    const response = await fetch(`/api/lots/${encodeURIComponent(lotId)}/bling/${encodeURIComponent(kind)}/sync-products`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Nao foi possivel criar os produtos no Bling.");
    message.style.color = "#0f766e";
    message.textContent = `Produtos no Bling: ${payload.created} criado(s), ${payload.updated || 0} atualizado(s), ${payload.skipped} ja existente(s).`;
  } catch (error) {
    message.style.color = "";
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderRz(lot, codigoRz, { push = true } = {}) {
  state.selectedRz = codigoRz;
  document.querySelectorAll(".rz-card").forEach((card) => card.classList.toggle("selected", card.dataset.rz === codigoRz));
  const opened = openScanWindow(lot.id, codigoRz);
  const rzDetail = $("#rzDetail");
  if (rzDetail) {
    rzDetail.innerHTML = `
      <div class="scan-opened">
        <strong>Bipagem aberta em uma nova janela.</strong>
        <span class="muted">Use a janela dedicada para bipar e imprimir etiquetas automaticamente.</span>
        <button type="button" id="reopenScanButton">Reabrir bipagem</button>
      </div>
    `;
    $("#reopenScanButton").addEventListener("click", () => openScanWindow(lot.id, codigoRz));
  }
  if (!opened) alert("O navegador bloqueou a janela de bipagem. Permita pop-ups para o Etiquefacil.");
  if (push) updateRoute(lotPath(lot.id));
  return;
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  const items = lot.items.filter((item) => item.codigoRz === codigoRz);
  $("#rzDetail").innerHTML = `
    <div class="scan-box">
      <input id="scanInput" placeholder="Bipe o SKU da etiqueta ou Codigo ML no ${escapeHtml(codigoRz)}" autofocus />
      <button id="scanButton">Bipar</button>
      <button id="decrementScanButton" type="button" class="danger">Diminuir qtd</button>
      <label class="check-option"><input id="autoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Imprimir ao bipar</label>
      <label class="check-option"><input id="includePriceToggle" type="checkbox" ${state.labelOptions.includePrice ? "checked" : ""} /> Etiqueta com preço</label>
      <label class="check-option"><input id="includeTextToggle" type="checkbox" ${state.labelOptions.includeText ? "checked" : ""} /> Texto na etiqueta</label>
      ${labelTextControls()}
    </div>
    <div class="summary-grid">
      ${metric("Conferido", rz.checked)}
      ${metric("Faltante", rz.missing)}
      ${metric("Excedente", rz.excess)}
      ${metric("Impacto", `${money(rz.missingValue)} / ${money(rz.excessValue)}`)}
    </div>
    <h3 class="section-title">Progresso do RZ</h3>
    <div class="summary-grid">
      ${progressMetric("Quantidade", rz.qtyPercent, `${rz.checked}/${rz.expected}`)}
      ${progressMetric("Preço de venda", rz.valuePercent, `${money(rz.checkedValue)} / ${money(rz.expectedValue)}`)}
      ${metric("Valor faltante", money(rz.missingValue))}
      ${metric("Valor excedente", money(rz.excessValue))}
    </div>
    <div id="scanMessage" class="message"></div>
    <div class="items">
      ${items.map(itemRow).join("")}
    </div>
  `;
  bindScanControls(lot.id, codigoRz, items);
  if (push) updateRoute(lotRzPath(lot.id, codigoRz));
}

function renderPallet(lot, codigoRz) {
  const canManage = state.user?.role !== "operator";
  if (state.user?.role === "operator") recordOperatorActivity("view_pallet", { lotId: lot.id, codigoRz });
  state.selectedRz = codigoRz;
  document.querySelectorAll(".rz-card").forEach((card) => card.classList.toggle("selected", card.dataset.rz === codigoRz));
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  if (!rz) return;

  const items = lot.items.filter((item) => item.codigoRz === codigoRz);
  const status = rz.missing === 0 && rz.excess === 0 ? "Concluido" : rz.checked > 0 ? "Em andamento" : "Pendente";
  const baseUrl = `/api/lots/${encodeURIComponent(lot.id)}/rz/${encodeURIComponent(codigoRz)}/pallet`;
  $("#rzDetail").innerHTML = `
    <section class="pallet-panel">
      <div class="pallet-heading">
        <div>
          <span class="muted">${escapeHtml(lot.nomeArquivo)}</span>
          <h2>Pallet ${escapeHtml(codigoRz)}</h2>
        </div>
        <div class="pallet-actions">
          <button type="button" data-scan-rz="${escapeHtml(codigoRz)}">Iniciar bipagem</button>
          ${canManage ? `<a class="button-link" href="/api/lots/${encodeURIComponent(lot.id)}/rz/${encodeURIComponent(codigoRz)}/bling">Baixar Bling Remessa</a>` : ""}
          ${canManage ? `<a class="button-link" href="/api/lots/${encodeURIComponent(lot.id)}/rz/${encodeURIComponent(codigoRz)}/stock-entry">Entrada Estoque Bling</a>` : ""}
          ${canManage ? `<a class="button-link" href="${baseUrl}/pdf">Baixar PDF</a>` : ""}
          ${canManage ? `<a class="button-link" href="${baseUrl}/xlsx">Baixar XLSX</a>` : ""}
        </div>
      </div>
      <p id="palletMessage" class="message"></p>
      <div class="summary-grid">
        ${metric("Status", status)}
        ${metric("Itens", rz.expected)}
        ${metric("Conferido", rz.checked)}
        ${metric("Faltante", rz.missing)}
      </div>
      <div class="summary-grid">
        ${metric("Excedente", rz.excess)}
        ${metric("Venda total", money(rz.expectedValue))}
        ${metric("Venda conferida", money(rz.checkedValue))}
        ${metric("Impacto", `${money(rz.missingValue)} / ${money(rz.excessValue)}`)}
      </div>
      <h3 class="section-title">Progresso do pallet</h3>
      <div class="summary-grid">
        ${progressMetric("Quantidade", rz.qtyPercent, `${rz.checked}/${rz.expected}`)}
        ${progressMetric("Preco de venda", rz.valuePercent, `${money(rz.checkedValue)} / ${money(rz.expectedValue)}`)}
        ${metric("Valor faltante", money(rz.missingValue))}
        ${metric("Valor excedente", money(rz.excessValue))}
      </div>
      <div class="pallet-table">
        <div class="pallet-row pallet-row-head">
          <span>SKU / ML</span>
          <span>Produto</span>
          <span>Endereco</span>
          <span>Qtd</span>
          <span>Valores</span>
          <span>Status</span>
        </div>
        ${items.map(palletRow).join("")}
      </div>
    </section>
  `;
  $("#rzDetail [data-scan-rz]").addEventListener("click", () => {
    if (isNoSheetLot(lot)) openNoSheetRz(lot, codigoRz);
    else renderRz(lot, codigoRz);
  });
  document.querySelectorAll("[data-pallet-split]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((candidate) => candidate.product?.id === button.dataset.palletSplit);
      if (item?.product) await splitLotProduct(item.product, codigoRz, { lotId: lot.id, messageSelector: "#palletMessage", render: (updatedLot) => renderPallet(updatedLot, codigoRz) });
    });
  });
}

function openScanWindow(lotId, codigoRz) {
  const url = lotRzPath(lotId, codigoRz);
  const target = `etiquefacil-bipagem-${String(lotId).replace(/\W/g, "")}-${String(codigoRz).replace(/\W/g, "")}`;
  const scanWindow = window.open(url, target, "width=1180,height=760");
  if (scanWindow) scanWindow.focus();
  return Boolean(scanWindow);
}

function renderScanPage(lot, codigoRz, { lastCodigoMl = "" } = {}) {
  state.selectedLotId = lot.id;
  state.selectedRz = codigoRz;
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  if (!rz) {
    $("#lotDetail").classList.add("empty");
    $("#lotDetail").textContent = "RZ nao encontrado neste lote.";
    return;
  }

  const items = lot.items.filter((item) => item.codigoRz === codigoRz);
  const displayItems = prioritizeScannedItems(items, lastCodigoMl);
  document.title = `Bipagem ${codigoRz}`;
  $("#lotDetail").classList.remove("empty");
  $("#lotDetail").innerHTML = `
    <section class="scan-page">
      <div class="scan-heading">
        <div>
          <span class="muted">${escapeHtml(lot.nomeArquivo)}</span>
          <h2>${escapeHtml(codigoRz)}</h2>
        </div>
      </div>
      <div class="scan-box">
        <input id="scanInput" placeholder="Bipe o SKU da etiqueta ou Codigo ML no ${escapeHtml(codigoRz)}" autofocus />
        <button id="scanButton">Bipar</button>
        <button id="decrementScanButton" type="button" class="danger">Diminuir qtd</button>
        <label class="check-option"><input id="autoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Imprimir ao bipar</label>
        <label class="check-option"><input id="includePriceToggle" type="checkbox" ${state.labelOptions.includePrice ? "checked" : ""} /> Etiqueta com preco</label>
        <label class="check-option"><input id="includeTextToggle" type="checkbox" ${state.labelOptions.includeText ? "checked" : ""} /> Texto na etiqueta</label>
        ${labelTextControls()}
      </div>
      <div class="summary-grid">
        ${metric("Conferido", rz.checked)}
        ${metric("Faltante", rz.missing)}
        ${metric("Excedente", rz.excess)}
        ${metric("Impacto", `${money(rz.missingValue)} / ${money(rz.excessValue)}`)}
      </div>
      <h3 class="section-title">Progresso do RZ</h3>
      <div class="summary-grid">
        ${progressMetric("Quantidade", rz.qtyPercent, `${rz.checked}/${rz.expected}`)}
        ${progressMetric("Preco de venda", rz.valuePercent, `${money(rz.checkedValue)} / ${money(rz.expectedValue)}`)}
        ${metric("Valor faltante", money(rz.missingValue))}
        ${metric("Valor excedente", money(rz.excessValue))}
      </div>
      <div id="scanMessage" class="message"></div>
      <div class="items">
        ${displayItems.map(itemRow).join("")}
      </div>
    </section>
  `;
  bindScanControls(lot.id, codigoRz, items);
}

function prioritizeScannedItems(items, codigoMl) {
  const normalized = normalizeCode(codigoMl);
  if (!normalized) return items;
  return [...items].sort((a, b) => Number(itemMatchesScanCode(b, normalized)) - Number(itemMatchesScanCode(a, normalized)));
}

function itemMatchesScanCode(item, normalizedCode) {
  const product = item.product || {};
  return [product.codigoMl, product.sku, code39BarcodeValue(product.sku), product.ean]
    .some((value) => normalizeCode(value) === normalizedCode);
}

function bindScanControls(lotId, codigoRz, items = []) {
  $("#scanButton").addEventListener("click", () => scanCurrent(lotId, codigoRz));
  $("#decrementScanButton").addEventListener("click", () => decrementCurrent(lotId, codigoRz));
  document.querySelectorAll("[data-decrement-ml]").forEach((button) => {
    button.addEventListener("click", () => decrementCurrent(lotId, codigoRz, button.dataset.decrementMl));
  });
  document.querySelectorAll("[data-delete-external-excess]").forEach((button) => {
    button.addEventListener("click", () => deleteExternalExcess(lotId, codigoRz, button.dataset.deleteExternalExcess, button));
  });
  document.querySelectorAll("[data-split-product]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((candidate) => candidate.product?.id === button.dataset.splitProduct);
      if (item?.product) await splitLotProduct(item.product, codigoRz, { lotId });
    });
  });
  $("#autoPrintToggle").addEventListener("change", (event) => {
    state.labelOptions.autoPrint = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.autoPrint", String(state.labelOptions.autoPrint));
  });
  $("#includePriceToggle").addEventListener("change", (event) => {
    state.labelOptions.includePrice = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.includePrice", String(state.labelOptions.includePrice));
  });
  bindLabelTextControls();
  $("#scanInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) scanCurrent(lotId, codigoRz);
    }
  });
  schedulePrimaryInputFocus(["#scanInput"]);
}

function bindLabelTextControls() {
  const includeTextToggle = $("#includeTextToggle");
  const customTextInput = $("#customTextInput");
  const customTextRow = $("#customTextRow");

  if (!includeTextToggle || !customTextInput || !customTextRow) return;

  includeTextToggle.addEventListener("change", (event) => {
    state.labelOptions.includeText = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.includeText", String(state.labelOptions.includeText));
    customTextRow.classList.toggle("hidden", !state.labelOptions.includeText);
    if (state.labelOptions.includeText) customTextInput.focus();
  });

  customTextInput.addEventListener("input", (event) => {
    state.labelOptions.customText = event.currentTarget.value;
    localStorage.setItem("etiquefacil.customText", state.labelOptions.customText);
  });
}

async function scanCurrent(lotId, codigoRz) {
  if (state.pendingScan) return;
  const input = $("#scanInput");
  if (!input) return;
  const codigoMl = normalizeCodigoMl(input.value);
  input.value = "";
  if (!codigoMl) return;

  try {
    state.pendingScan = true;
    $("#scanButton").disabled = true;
    input.disabled = true;
    const response = await api(`/api/lots/${lotId}/rz/${encodeURIComponent(codigoRz)}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    input.value = "";
    const message = $("#scanMessage");
    if (response.scan.status === "desconhecido") {
      await createManualExternalExcessFromScan(lotId, codigoRz, codigoMl);
      return;
    }
    if (response.scan.status === "historico") {
      const history = response.scan.history[0];
      message.innerHTML = `
        ML encontrado em outra planilha: ${escapeHtml(history.descricao)}.
        SKU sugerido no sequencial do lote atual.
        <button id="confirmExternal">Cadastrar excedente externo</button>
      `;
      $("#confirmExternal").addEventListener("click", () => createExternalExcess(lotId, codigoRz, codigoMl));
    } else if (response.scan.status === "outro_rz") {
      message.textContent = "Este ML existe no lote, mas pertence a outro RZ.";
    } else if (response.scan.status === "desconhecido") {
      message.textContent = "ML não encontrado neste lote nem no histórico do usuário.";
    } else {
      message.textContent = response.scan.status === "excedente" ? "Quantidade excedente registrada." : "Bipagem registrada.";
      const scannedProduct = findScannedProduct(response.lot, codigoRz, codigoMl);
      renderScanPage(response.lot, codigoRz, { lastCodigoMl: codigoMl });
      $("#scanMessage").textContent = response.scan.status === "excedente" ? "Quantidade excedente registrada." : "Bipagem registrada.";
      if (scannedProduct && state.labelOptions.autoPrint) {
        showLabel(scannedProduct, { autoPrint: true, meta: labelMeta(response.scan.createdAt) });
        await syncPrintedLabelStockEntry(lotId, codigoRz, codigoMl);
      }
    }
  } catch (error) {
    $("#scanMessage").textContent = error.message;
  } finally {
    state.pendingScan = false;
    const scanButton = $("#scanButton");
    if (scanButton) scanButton.disabled = false;
    const scanInput = $("#scanInput");
    if (scanInput) scanInput.disabled = false;
    schedulePrimaryInputFocus(["#scanInput"]);
  }
}

async function createManualExternalExcessFromScan(lotId, codigoRz, codigoMl) {
  const message = $("#scanMessage");
  const input = $("#scanInput");
  try {
    const manualProduct = await promptManualProduct(codigoMl, "#scanInput");
    if (!manualProduct) {
      message.textContent = "ML nao encontrado neste lote nem no historico do usuario.";
      input?.select();
      return;
    }

    const response = await api(`/api/lots/${lotId}/rz/${encodeURIComponent(codigoRz)}/external-excess/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl, manualProduct })
    });

    const successMessage = `SKU ${response.product.sku} gerado localmente e enviado para sugestao do banco historico.`;
    renderScanPage(response.lot, codigoRz, { lastCodigoMl: codigoMl });
    $("#scanMessage").textContent = successMessage;
    if (response.product && state.labelOptions.autoPrint) {
      showLabel(response.product, { autoPrint: true, meta: labelMeta() });
      await syncPrintedLabelStockEntry(lotId, codigoRz, codigoMl);
    }
  } catch (error) {
    message.textContent = error.message;
    input?.select();
  }
}

async function decrementCurrent(lotId, codigoRz, codigoMlFromButton) {
  if (state.pendingDecrement) return;
  const input = $("#scanInput");
  const codigoMl = normalizeCodigoMl(codigoMlFromButton || input?.value);
  if (input && !codigoMlFromButton) input.value = codigoMl;
  if (!codigoMl) return;

  try {
    state.pendingDecrement = true;
    $("#decrementScanButton").disabled = true;
    const response = await api(`/api/lots/${lotId}/rz/${encodeURIComponent(codigoRz)}/scan/decrement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    if (input && !codigoMlFromButton) input.value = "";
    renderScanPage(response.lot, codigoRz, { lastCodigoMl: codigoMl });
    $("#scanMessage").textContent = "Quantidade bipada diminuida.";
    await syncDecrementStockExit(lotId, codigoRz, codigoMl);
  } catch (error) {
    $("#scanMessage").textContent = error.message;
  } finally {
    state.pendingDecrement = false;
    const decrementButton = $("#decrementScanButton");
    if (decrementButton) decrementButton.disabled = false;
    schedulePrimaryInputFocus(["#scanInput"]);
  }
}

async function syncPrintedLabelStockEntry(lotId, codigoRz, codigoMl) {
  const message = $("#scanMessage");
  try {
    const response = await api(`/api/lots/${encodeURIComponent(lotId)}/rz/${encodeURIComponent(codigoRz)}/stock-entry/sync-one`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    if (message) {
      message.style.color = "#0f766e";
      message.textContent = `Bipagem registrada, etiqueta impressa e entrada lancada no Bling (${response.deposito?.descricao || "Geral"}).`;
    }
  } catch (error) {
    if (message) {
      message.style.color = "";
      message.textContent = `Bipagem registrada e etiqueta impressa, mas a entrada no Bling falhou: ${error.message}`;
    }
  }
}

async function syncDecrementStockExit(lotId, codigoRz, codigoMl) {
  const message = $("#scanMessage");
  try {
    const response = await api(`/api/lots/${encodeURIComponent(lotId)}/rz/${encodeURIComponent(codigoRz)}/stock-exit/sync-one`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    if (message) {
      message.style.color = "#0f766e";
      message.textContent = `Quantidade diminuida e saida lancada no Bling (${response.deposito?.descricao || "Geral"}).`;
    }
  } catch (error) {
    if (message) {
      message.style.color = "";
      message.textContent = `Quantidade diminuida, mas a saida no Bling falhou: ${error.message}`;
    }
  }
}

async function createExternalExcess(lotId, codigoRz, codigoMl) {
  try {
    const response = await api(`/api/lots/${lotId}/rz/${encodeURIComponent(codigoRz)}/external-excess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    renderScanPage(response.lot, codigoRz);
    $("#scanMessage").textContent = "Excedente externo cadastrado.";
    if (response.product && state.labelOptions.autoPrint) {
      showLabel(response.product, { autoPrint: true, meta: labelMeta() });
      await syncPrintedLabelStockEntry(lotId, codigoRz, codigoMl);
    }
  } catch (error) {
    $("#scanMessage").textContent = error.message;
  }
}

async function deleteExternalExcess(lotId, codigoRz, codigoMlFromButton, button) {
  const codigoMl = normalizeCodigoMl(codigoMlFromButton);
  if (!codigoMl) return;
  if (!confirm(`Excluir o excedente ${codigoMl} do Bling e deste RZ?`)) return;

  try {
    if (button) button.disabled = true;
    const response = await api(`/api/lots/${encodeURIComponent(lotId)}/rz/${encodeURIComponent(codigoRz)}/external-excess`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    renderScanPage(response.lot, codigoRz);
    const blingMessage = response.bling?.status === "deleted" ? "Cadastro excluido no Bling" : "Cadastro nao existia mais no Bling";
    $("#scanMessage").style.color = "#0f766e";
    $("#scanMessage").textContent = `${blingMessage}; SKU ${response.product?.sku || ""} liberado.`;
  } catch (error) {
    if (button) button.disabled = false;
    const message = $("#scanMessage");
    if (message) {
      message.style.color = "";
      message.textContent = error.message;
    }
  } finally {
    schedulePrimaryInputFocus(["#scanInput"]);
  }
}

async function searchMl(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector("input[name='codigoMl']");
  const codigoMl = normalizeCodigoMl(input?.value);
  if (input) input.value = codigoMl;
  const response = await api(`/api/search?codigoMl=${encodeURIComponent(codigoMl)}`);
  const wrapper = $("#searchResults");
  if (!response.results.length) {
    schedulePrimaryInputFocus(["#searchForm input[name='codigoMl']"]);
    wrapper.innerHTML = '<p class="muted">Produto não encontrado.</p>';
    return;
  }
  wrapper.innerHTML = response.results.map((product) => `
    <article class="result-card">
      <div>
        <strong>${escapeHtml(product.sku)} · ${escapeHtml(product.codigoMl)}</strong>
        <p>${escapeHtml(product.descricao)}</p>
        <span class="muted">${escapeHtml(product.lot.nomeArquivo)} · RZ ${escapeHtml(product.rzs.join(", "))} · ${money(product.valorUnit)}</span>
      </div>
      <button data-product="${product.id}">Imprimir etiqueta</button>
    </article>
  `).join("");
  wrapper.querySelectorAll("button[data-product]").forEach((button) => {
    button.addEventListener("click", () => printLabel(button.dataset.product));
  });
  schedulePrimaryInputFocus(["#searchForm input[name='codigoMl']"]);
}

async function printLabel(productId) {
  try {
    const response = await api("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId })
    });
    showLabel(response.product, { autoPrint: true, meta: labelMeta(response.label?.createdAt) });
  } catch (error) {
    alert(error.message);
  }
}

function findScannedProduct(lot, codigoRz, codigoMl) {
  const normalizedMl = normalizeCodigoMl(codigoMl);
  const matches = lot.items.filter((item) => {
    const product = item.product || {};
    return (
      item.codigoRz === codigoRz &&
      (normalizeCodigoMl(product.codigoMl) === normalizedMl ||
        normalizeCodigoMl(product.sku) === normalizedMl ||
        normalizeCodigoMl(code39BarcodeValue(product.sku)) === normalizedMl)
    );
  });
  const productIds = new Set(matches.map((item) => item.product?.id).filter(Boolean));
  if (productIds.size > 1) return null;
  return matches[0]?.product || null;
}

function showLabel(product, { autoPrint = false, meta = null, quantity = 1, returnFocusSelectors = null } = {}) {
  state.labelProduct = product;
  state.labelMeta = meta;
  state.labelPrintMarkup = labelMarkup(product, meta);
  state.labelQuantity = Math.max(1, Math.round(Number(quantity || 1)));
  state.labelReturnFocusSelectors = returnFocusSelectors || currentLabelReturnFocusSelectors();
  $("#labelPreview").innerHTML = state.labelPrintMarkup;
  $("#labelPrintButton").textContent = "Imprimir etiqueta";
  $("#labelModal").classList.remove("hidden");
  $("#labelModal").focus();
  if (autoPrint) setTimeout(printCurrentLabel, 120);
}

function code39Svg(value) {
  const patterns = {
    "0": "nnnwwnwnn",
    "1": "wnnwnnnnw",
    "2": "nnwwnnnnw",
    "3": "wnwwnnnnn",
    "4": "nnnwwnnnw",
    "5": "wnnwwnnnn",
    "6": "nnwwwnnnn",
    "7": "nnnwnnwnw",
    "8": "wnnwnnwnn",
    "9": "nnwwnnwnn",
    A: "wnnnnwnnw",
    B: "nnwnnwnnw",
    C: "wnwnnwnnn",
    D: "nnnnwwnnw",
    E: "wnnnwwnnn",
    F: "nnwnwwnnn",
    G: "nnnnnwwnw",
    H: "wnnnnwwnn",
    I: "nnwnnwwnn",
    J: "nnnnwwwnn",
    K: "wnnnnnnww",
    L: "nnwnnnnww",
    M: "wnwnnnnwn",
    N: "nnnnwnnww",
    O: "wnnnwnnwn",
    P: "nnwnwnnwn",
    Q: "nnnnnnwww",
    R: "wnnnnnwwn",
    S: "nnwnnnwwn",
    T: "nnnnwnwwn",
    U: "wwnnnnnnw",
    V: "nwwnnnnnw",
    W: "wwwnnnnnn",
    X: "nwnnwnnnw",
    Y: "wwnnwnnnn",
    Z: "nwwnwnnnn",
    "-": "nwnnnnwnw",
    ".": "wwnnnnwnn",
    " ": "nwwnnnwnn",
    "$": "nwnwnwnnn",
    "/": "nwnwnnnwn",
    "+": "nwnnnwnwn",
    "%": "nnnwnwnwn",
    "*": "nwnnwnwnn"
  };

  const barcodeValue = code39BarcodeValue(value);
  const encoded = `*${barcodeValue}*`;
  const narrow = 2;
  const wide = 5;
  const height = 78;
  const quietZone = 24;
  let x = quietZone;
  let bars = "";

  for (const char of encoded) {
    const pattern = patterns[char] || patterns["-"];
    [...pattern].forEach((part, index) => {
      const width = part === "w" ? wide : narrow;
      if (index % 2 === 0) {
        bars += `<rect x="${x}" y="0" width="${width}" height="${height}" />`;
      }
      x += width;
    });
    x += narrow;
  }

  x += quietZone;
  return `<svg class="label-barcode" viewBox="0 0 ${x} ${height}" preserveAspectRatio="xMidYMid meet" data-barcode-value="${escapeHtml(barcodeValue)}" role="img" aria-label="Codigo de barras">${bars}</svg>`;
}

function code39BarcodeValue(value) {
  return String(value || "").trim().toUpperCase().replace(/[^0-9A-Z .$/+%-]/g, "-");
}

function labelMarkup(product, meta = null) {
  const price = state.labelOptions.includePrice ? money(product.valorUnit) : "";
  const customText = state.labelOptions.includeText ? state.labelOptions.customText.trim() : "";
  const hasCustomText = Boolean(customText);
  const footer = labelFooterText(meta);
  const hasMeta = Boolean(footer);
  const sku = code39BarcodeValue(product.sku);
  return `
    <section class="label-print ${hasCustomText ? "has-note" : ""} ${hasMeta ? "has-meta" : ""}">
      <p class="label-desc">${escapeHtml(product.descricao)}</p>
      ${code39Svg(sku)}
      <strong class="label-sku">${escapeHtml(sku)}</strong>
      <strong class="label-price">${escapeHtml(price)}</strong>
      <strong class="label-note">${escapeHtml(customText)}</strong>
      <span class="label-footer">${escapeHtml(footer)}</span>
    </section>
  `;
}

function labelMeta(createdAt = new Date().toISOString()) {
  if (!state.user?.operatorCode) return null;
  return {
    operatorCode: state.user.operatorCode,
    createdAt
  };
}

function labelFooterText(meta) {
  if (!meta?.operatorCode || !meta.createdAt) return "";
  return `${meta.operatorCode} ${formatLabelDateTime(meta.createdAt)}`;
}

function formatLabelDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function printCurrentLabel() {
  if (!$("#labelPreview")?.innerHTML || $("#labelModal").classList.contains("hidden")) return;
  cleanupLabelPrintRoot();
  const printRoot = document.createElement("div");
  printRoot.id = "labelPrintRoot";
  printRoot.innerHTML = currentLabelPreviewPrintMarkup();
  document.body.appendChild(printRoot);
  document.body.classList.add("printing-label");
  window.print();
  labelPrintFallbackTimer = setTimeout(finishLabelPrint, LABEL_PRINT_FALLBACK_MS);
}

function currentLabelPreviewPrintMarkup() {
  const printMarkup = $("#labelPreview").innerHTML;
  return Array.from({ length: state.labelQuantity }, () => printMarkup).join("");
}

function bindPrintCloseFallback() {
  const printMedia = window.matchMedia?.("print");
  if (!printMedia) return;

  const handleChange = (event) => {
    if (!event.matches) finishLabelPrint();
  };

  if (printMedia.addEventListener) {
    printMedia.addEventListener("change", handleChange);
  } else if (printMedia.addListener) {
    printMedia.addListener(handleChange);
  }
}

function finishLabelPrint() {
  const wasPrintingLabel = Boolean($("#labelPrintRoot")) || document.body.classList.contains("printing-label");
  cleanupLabelPrintRoot();
  if (wasPrintingLabel) hideLabelPreview();
}

function cleanupLabelPrintRoot() {
  if (labelPrintFallbackTimer) {
    clearTimeout(labelPrintFallbackTimer);
    labelPrintFallbackTimer = null;
  }
  document.body.classList.remove("printing-label");
  $("#labelPrintRoot")?.remove();
}

function hideLabelPreview() {
  $("#labelModal").classList.add("hidden");
  $("#labelPreview").innerHTML = "";
  state.labelProduct = null;
  state.labelMeta = null;
  state.labelPrintMarkup = "";
  state.labelQuantity = 1;
  $("#labelPrintButton").textContent = "Imprimir etiqueta";
  const returnFocusSelectors = state.labelReturnFocusSelectors;
  state.labelReturnFocusSelectors = null;
  scheduleScanInputFocus(returnFocusSelectors);
}

function scheduleScanInputFocus(preferredSelectors = null) {
  schedulePrimaryInputFocus(preferredSelectors || ["#scanInput", "#diverseScanForm input[name='codigoMl']"]);
}

function currentLabelReturnFocusSelectors() {
  const active = document.activeElement;
  if (active?.id === "scanInput") return ["#scanInput"];
  if (active?.matches?.("#diverseScanForm input[name='codigoMl']")) return ["#diverseScanForm input[name='codigoMl']"];
  if (active?.matches?.("#searchForm input[name='codigoMl']")) return ["#searchForm input[name='codigoMl']"];
  return ["#scanInput", "#diverseScanForm input[name='codigoMl']", "#searchForm input[name='codigoMl']"];
}

function schedulePrimaryInputFocus(preferredSelectors) {
  [0, 50, 150, 300, 600].forEach((delay) => {
    setTimeout(() => focusPrimaryInput(preferredSelectors), delay);
  });
}

function focusScanInput() {
  focusPrimaryInput(["#scanInput", "#diverseScanForm input[name='codigoMl']"]);
}

function focusPrimaryInput(preferredSelectors) {
  const selectors = [
    ...(Array.isArray(preferredSelectors) ? preferredSelectors : preferredSelectors ? [preferredSelectors] : []),
    ...primaryInputSelectors()
  ];
  const input = selectors.map((selector) => $(selector)).find(isFocusableInput);
  if (!input) return;

  const visibleModal = [...document.querySelectorAll(".label-modal:not(.hidden)")].find(isElementVisible);
  if (visibleModal && !visibleModal.contains(input)) return;

  window.focus();
  input.focus({ preventScroll: true });
}

function primaryInputSelectors() {
  return [
    "#manualProductModal:not(.hidden) #manualProductDescription",
    "#productEditModal:not(.hidden) #productEditDescription",
    "#productSplitModal:not(.hidden) #productSplitDescription",
    "#decisionModal:not(.hidden) .decision-fields label:not(.hidden) input",
    "#scanInput",
    "#diverseScanForm input[name='codigoMl']:not(:disabled)",
    "#rzSearchInput",
    "#searchTab:not(.hidden) #searchForm input[name='codigoMl']",
    "#transferScanInput",
    "#transferLotForm input[name='descricao']",
    "#loginForm input[name='email']",
    "#adminUsersTab:not(.hidden) #adminCreateUserForm input[name='name']",
    "#adminCatalogTab:not(.hidden) #adminCatalogSearchForm input[name='q']",
    "#uploadForm input[name='file']",
    "#diverseLotForm input[name='name']"
  ];
}

function isFocusableInput(element) {
  if (!element || element.disabled || element.readOnly) return false;
  return isElementVisible(element);
}

function isElementVisible(element) {
  return Boolean(element && !element.closest(".hidden") && element.getClientRects().length);
}

function labelTextControls() {
  return `
    <div id="customTextRow" class="custom-text-row ${state.labelOptions.includeText ? "" : "hidden"}">
      <label>Texto que sera impresso abaixo do preco
        <input id="customTextInput" maxlength="48" value="${escapeHtml(state.labelOptions.customText)}" placeholder="Ex: CONFERIDO - SEM TROCA" />
      </label>
      <strong>Ativo para as proximas etiquetas</strong>
    </div>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function progressMetric(label, percent, detail) {
  const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
  return `
    <div class="metric progress-metric">
      <span>${label}</span>
      <strong>${safePercent.toLocaleString("pt-BR")}%</strong>
      <div class="progress-bar"><i style="width: ${safePercent}%"></i></div>
      <em>${escapeHtml(detail)}</em>
    </div>
  `;
}

function previewRzRow(rz) {
  const status = rz.missing === 0 && rz.excess === 0 && rz.checked > 0 ? "OK" : rz.checked > 0 ? "Parcial" : "Pendente";
  return `
    <article class="preview-rz-row">
      <strong>${escapeHtml(rz.codigoRz)}</strong>
      <span><small>Status</small>${escapeHtml(status)}</span>
      <span><small>Conferido</small>${rz.checked}/${rz.expected}</span>
      <span><small>Faltante</small>${rz.missing}</span>
      <span><small>Excedente</small>${rz.excess}</span>
      <span><small>Venda conf.</small>${money(rz.checkedValue)}</span>
    </article>
  `;
}

function rzCard(rz, { canScan = true } = {}) {
  const title = `Itens ${rz.expected} · Conferido ${rz.checked} · Venda total ${money(rz.expectedValue)} · Venda conferida ${money(rz.checkedValue)} · Faltante ${rz.missing} · Excedente ${rz.excess}`;
  return `
    <article class="rz-card" data-rz="${escapeHtml(rz.codigoRz)}" title="${escapeHtml(title)}">
      <strong>${escapeHtml(rz.codigoRz)}</strong>
      <div class="rz-card-details">
        <span>Itens</span><strong>${rz.expected}</strong>
        <span>Conferido</span><strong>${rz.checked}</strong>
        <span>Venda total</span><strong>${money(rz.expectedValue)}</strong>
        <span>Venda conf.</span><strong>${money(rz.checkedValue)}</strong>
        <span>Faltante</span><strong>${rz.missing}</strong>
        <span>Excedente</span><strong>${rz.excess}</strong>
      </div>
      <div class="rz-card-actions">
        ${canScan ? `<button type="button" data-scan-rz="${escapeHtml(rz.codigoRz)}">Iniciar bipagem</button>` : ""}
        <button type="button" class="ghost" data-pallet-rz="${escapeHtml(rz.codigoRz)}">Exibir pallet</button>
      </div>
    </article>
  `;
}

function itemRow(item) {
  const product = item.product || {};
  const badge = item.tipoItem === "excedente_externo" ? '<span class="badge excess">excedente externo</span>' : `<span class="badge">${escapeHtml(item.tipoItem)}</span>`;
  const deleteButton =
    item.tipoItem === "excedente_externo"
      ? `<button type="button" class="danger ghost icon-button" data-delete-external-excess="${escapeHtml(product.codigoMl || "")}" title="Excluir excedente no Bling" aria-label="Excluir excedente no Bling">${trashIcon()}</button>`
      : "";
  return `
    <article class="item-row">
      <strong>${escapeHtml(product.sku || "")}</strong>
      <span>${escapeHtml(product.descricao || "")}</span>
      <span class="code-cell"><small>Codigo ML</small><strong>${escapeHtml(product.codigoMl || "")}</strong></span>
      <span>${item.qtdConferida}/${item.qtdEsperada}</span>
      ${badge}
      <span class="item-actions">
        ${deleteButton}
        <button type="button" class="ghost" data-split-product="${escapeHtml(product.id || "")}">Desmembrar</button>
        <button type="button" class="danger ghost" data-decrement-ml="${escapeHtml(product.codigoMl || "")}" ${item.qtdConferida > 0 ? "" : "disabled"}>Diminuir</button>
      </span>
    </article>
  `;
}

function trashIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 14H6L5 6"></path>
      <path d="M10 11v5"></path>
      <path d="M14 11v5"></path>
    </svg>
  `;
}

function diverseItemsTable(lot) {
  const items = (lot.items || []).filter(isNoSheetItem);
  if (!items.length) return '<p class="muted">Nenhum codigo bipado neste lote ainda.</p>';
  const sortedItems = [...items].sort((a, b) => {
    const byRz = String(a.codigoRz || "").localeCompare(String(b.codigoRz || ""));
    if (byRz) return byRz;
    return String(a.product?.sku || "").localeCompare(String(b.product?.sku || ""));
  });

  return `
    <div class="diverse-table">
      <div class="diverse-row diverse-row-head">
        <span>Remessa</span>
        <span>SKU</span>
        <span>Codigo</span>
        <span>Produto</span>
        <span>Operador</span>
        <span>Qtd</span>
        <span>Venda</span>
        <span>Custo</span>
        <span>Acoes</span>
      </div>
      ${sortedItems.map((item, index) => diverseItemRow(item, sortedItems[index - 1]?.codigoRz !== item.codigoRz)).join("")}
    </div>
  `;
}

function isNoSheetItem(item) {
  return item.tipoItem === "entrada_diversos" || item.tipoItem === "lote_sem_planilha";
}

function diverseItemRow(item, startsRz = false) {
  const product = item.product || {};
  return `
    ${startsRz ? `<div class="diverse-rz-divider">Remessa ${escapeHtml(item.codigoRz || "")}</div>` : ""}
    <article class="diverse-row">
      <span>${escapeHtml(item.codigoRz || "")}</span>
      <strong>${escapeHtml(product.sku || "")}</strong>
      <span>${escapeHtml(product.codigoMl || "")}</span>
      <span>${escapeHtml(product.descricao || "")}</span>
      <span>${escapeHtml(productOperatorLabel(product))}</span>
      <span>${item.qtdEsperada || 0}</span>
      <span>${money(product.valorUnit)}</span>
      <span>${money(product.precoCusto)}</span>
      <span class="diverse-row-actions">
        <button type="button" class="ghost" data-diverse-edit="${escapeHtml(product.id || "")}">Editar</button>
        <button type="button" class="ghost" data-diverse-split="${escapeHtml(product.id || "")}">Desmembrar</button>
        <button type="button" data-diverse-label="${escapeHtml(product.id || "")}">Reimprimir</button>
      </span>
    </article>
  `;
}

function productOperatorLabel(product) {
  const user = product.operatorUser || product.createdByUser || null;
  if (!user) return "-";
  const name = String(user.name || "").trim();
  const email = String(user.email || "").trim();
  if (user.operatorCode) return `${name || email || "Operador"} #${user.operatorCode}`;
  return name || email || "-";
}

function palletRow(item) {
  const product = item.product || {};
  const missing = Math.max(0, item.qtdEsperada - item.qtdConferida);
  const excess = item.tipoItem === "excedente_externo" ? item.qtdConferida : Math.max(0, item.qtdConferida - item.qtdEsperada);
  const value = Number(product.valorUnit || 0);
  const rowStatus = missing === 0 && excess === 0 ? "OK" : item.qtdConferida > 0 ? "Parcial" : "Pendente";
  return `
    <article class="pallet-row">
      <span><strong>${escapeHtml(product.sku || "")}</strong><small>Codigo ML: ${escapeHtml(product.codigoMl || "")}</small></span>
      <span>${escapeHtml(product.descricao || "")}<small>${escapeHtml(item.tipoItem || "")} ${escapeHtml(item.condicaoGrade || "")}</small><small>${escapeHtml(product.origem || "")} · ${escapeHtml(product.categoria || "")} / ${escapeHtml(product.subcategoria || "")}</small></span>
      <span>${escapeHtml(item.enderecoWms || "-")}</span>
      <span>Esp. ${item.qtdEsperada}<small>Conf. ${item.qtdConferida} · Falt. ${missing} · Exc. ${excess}</small></span>
      <span>${money(value)}<small>Total ${money(value * item.qtdEsperada)}</small><small>Custo ${money(product.precoCusto)} · Estoque ${product.qtdTotal || 0}</small></span>
      <span class="pallet-row-actions"><span class="badge">${rowStatus}</span><button type="button" class="ghost" data-pallet-split="${escapeHtml(product.id || "")}">Desmembrar</button></span>
    </article>
  `;
}

async function loadTriageItems(selectCode = null) {
  if (!state.user?.triageAccess) return;
  try {
    const response = await api("/api/triage/items");
    state.triageItems = response.items || [];
    renderTriageItems();
    if (selectCode) await selectTriageItem(selectCode, { push: false });
  } catch (error) {
    $("#triageMessage").textContent = error.message;
  }
}

async function createTriageItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  $("#triageMessage").textContent = "";
  try {
    if (new FormData(form).get("lookupCode") && !new FormData(form).get("descricao") && !new FormData(form).get("sku") && !new FormData(form).get("ean")) {
      await lookupTriageCode();
    }
    const response = await api("/api/triage/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    form.reset();
    renderTriageLookupPreview(null);
    state.triageItems = [response.item, ...state.triageItems.filter((item) => item.code !== response.item.code)];
    state.selectedTriageCode = response.item.code;
    renderTriageItems();
    renderTriageDetail(response.item);
    updateRoute(`/triagem/${encodeURIComponent(response.item.code)}`);
    $("#triageMessage").style.color = "#0f766e";
    $("#triageMessage").textContent = "Etiqueta QR gerada.";
  } catch (error) {
    $("#triageMessage").style.color = "";
    $("#triageMessage").textContent = error.message;
  }
}

async function lookupTriageCode() {
  const form = $("#triageCreateForm");
  const code = String(new FormData(form).get("lookupCode") || "").trim();
  if (!code) return null;
  $("#triageMessage").textContent = "";
  try {
    const response = await api(`/api/triage/lookup?code=${encodeURIComponent(code)}`);
    if (!response.product) {
      renderTriageLookupPreview(null, "Produto nao encontrado. Preencha manualmente somente o necessario.");
      schedulePrimaryInputFocus(["#triageCreateForm input[name='descricao']"]);
      return null;
    }
    fillTriageProduct(response.product);
    renderTriageLookupPreview(response.product);
    schedulePrimaryInputFocus(["#triageCreateForm input[name='serial']", "#triageCreateForm button[type='submit']"]);
    return response.product;
  } catch (error) {
    $("#triageMessage").textContent = error.message;
    return null;
  }
}

function fillTriageProduct(product) {
  const form = $("#triageCreateForm");
  for (const [name, value] of Object.entries({
    productCode: product.productCode,
    descricao: product.descricao,
    sku: product.sku,
    ean: product.ean,
    asin: product.asin
  })) {
    const input = form.elements.namedItem(name);
    if (input) input.value = value || "";
  }
}

function renderTriageLookupPreview(product, message = "") {
  const wrapper = $("#triageLookupPreview");
  if (!wrapper) return;
  if (!product && !message) {
    wrapper.classList.add("hidden");
    wrapper.innerHTML = "";
    return;
  }
  wrapper.classList.remove("hidden");
  wrapper.innerHTML = product
    ? `
      <strong>Produto encontrado</strong>
      <span>${escapeHtml(product.descricao || "-")}</span>
      <small>SKU ${escapeHtml(product.sku || "-")} · EAN ${escapeHtml(product.ean || "-")} · Origem ${escapeHtml(product.sourceLotName || product.source || "-")}</small>
    `
    : `<span>${escapeHtml(message)}</span>`;
}

function renderTriageItems() {
  const wrapper = $("#triageItems");
  if (!wrapper) return;
  if (!state.triageItems.length) {
    wrapper.innerHTML = '<p class="muted">Nenhum produto em triagem.</p>';
    return;
  }
  wrapper.innerHTML = state.triageItems.map((item) => `
    <article class="lot-card triage-card ${state.selectedTriageCode === item.code ? "active" : ""}" data-triage-code="${escapeHtml(item.code)}">
      <strong>${escapeHtml(item.code)}</strong>
      <span>${escapeHtml(item.descricao || item.sku || item.ean || item.asin || "Produto sem descricao")}</span>
      <small>${triageStatusLabel(item)}${item.destination ? ` - ${escapeHtml(item.destination)}` : ""}</small>
    </article>
  `).join("");
}

function handleTriageItemsClick(event) {
  const card = event.target.closest("[data-triage-code]");
  if (!card) return;
  selectTriageItem(card.dataset.triageCode);
}

async function selectTriageItem(code, { push = true } = {}) {
  try {
    const response = await api(`/api/triage/items/${encodeURIComponent(code)}`);
    const item = response.item;
    state.selectedTriageCode = item.code;
    state.triageItems = [item, ...state.triageItems.filter((candidate) => candidate.code !== item.code)]
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    renderTriageItems();
    renderTriageDetail(item);
    if (push) updateRoute(`/triagem/${encodeURIComponent(item.code)}`);
    return item;
  } catch (error) {
    $("#triageDetail").classList.add("empty");
    $("#triageDetail").textContent = error.message;
    return null;
  }
}

async function showTriageItemView(code) {
  const detail = $("#triageDetail");
  try {
    detail.classList.add("empty");
    detail.textContent = "Carregando item da triagem...";
    const response = await api(`/api/triage/items/${encodeURIComponent(code)}`);
    const item = response.item;
    state.selectedTriageCode = item.code;
    renderTriageItemView(item);
    return item;
  } catch (error) {
    detail.classList.add("empty");
    detail.textContent = error.message;
    return null;
  }
}

function clearTriageDetail() {
  const detail = $("#triageDetail");
  if (!detail) return;
  detail.classList.add("empty");
  detail.textContent = "Selecione um produto da triagem.";
}

function renderTriageDetail(item) {
  const detail = $("#triageDetail");
  const footer = labelFooterText(labelMeta(item.createdAt));
  detail.classList.remove("empty");
  detail.innerHTML = `
    <section class="triage-detail-grid">
      <div class="triage-label-preview" id="triageLabelPrintable">
        <img src="${escapeHtml(item.qrDataUrl)}" alt="QR Code ${escapeHtml(item.code)}" />
        <span>${escapeHtml(item.code)}</span>
        <small>${escapeHtml(footer)}</small>
      </div>
      <div class="triage-info">
        <div class="detail-heading">
          <div>
            <span class="muted">Identificacao interna</span>
            <h2>${escapeHtml(item.code)}</h2>
          </div>
          <button type="button" class="ghost" data-toggle-triage-edit>Editar dados</button>
        </div>
        <dl class="triage-fields">
          <div><dt>Status</dt><dd>${triageStatusLabel(item)}</dd></div>
          <div><dt>Destino</dt><dd>${escapeHtml(item.destination || "Nao definido")}</dd></div>
          <div><dt>Descricao</dt><dd>${escapeHtml(item.descricao || "-")}</dd></div>
          <div><dt>SKU</dt><dd>${escapeHtml(item.sku || "-")}</dd></div>
          <div><dt>EAN</dt><dd>${escapeHtml(item.ean || "-")}</dd></div>
          <div><dt>ASIN/COD ML</dt><dd>${escapeHtml(item.asin || "-")}</dd></div>
          <div><dt>Serial</dt><dd>${escapeHtml(item.serial || "-")}</dd></div>
          <div><dt>Entrada</dt><dd>${formatDateTime(item.createdAt)}</dd></div>
          ${item.diagnosedAt ? `<div><dt>Operador ultimo laudo</dt><dd>${escapeHtml(triageDiagnosedByLabel(item))}</dd></div>` : ""}
        </dl>
        <div class="settings-actions">
          <a class="button-link" href="${escapeHtml(item.statusUrl)}" target="_blank" rel="noreferrer">Abrir status</a>
          <button type="button" data-print-triage-label>Imprimir etiqueta</button>
        </div>
      </div>
    </section>
    <form class="triage-edit-form hidden">
      <div class="panel-heading">
        <span class="muted">Dados da etiqueta</span>
        <h3>Editar identificacao e informacoes</h3>
      </div>
      <label>Identificacao interna<input name="code" value="${escapeHtml(item.code)}" required /></label>
      <label>Descricao<input name="descricao" value="${escapeHtml(item.descricao || "")}" /></label>
      <label>SKU<input name="sku" value="${escapeHtml(item.sku || "")}" /></label>
      <label>EAN<input name="ean" value="${escapeHtml(item.ean || "")}" /></label>
      <label>ASIN/COD ML<input name="asin" value="${escapeHtml(item.asin || "")}" /></label>
      <label>Codigo produto<input name="productCode" value="${escapeHtml(item.productCode || "")}" /></label>
      <label>Codigo Bling 2<input name="codigoBling2" value="${escapeHtml(item.codigoBling2 || "")}" /></label>
      <label>Serial<input name="serial" value="${escapeHtml(item.serial || "")}" /></label>
      <div class="settings-actions">
        <button type="submit">Salvar dados</button>
        <button type="button" class="ghost" data-cancel-triage-edit>Cancelar</button>
      </div>
      <p class="message" id="triageEditMessage"></p>
    </form>
    <form class="triage-diagnosis-form">
      <div class="panel-heading">
        <span class="muted">Diagnostico</span>
        <h3>Saida do teste</h3>
      </div>
      <label>Diagnostico<textarea name="diagnosis" rows="4" required>${escapeHtml(item.diagnosis || "")}</textarea></label>
      <label>Destino
        <select name="destination" required>
          <option value="">Selecione</option>
          <option value="LOJA" ${item.destination === "LOJA" ? "selected" : ""}>Loja</option>
          <option value="INTERNET" ${item.destination === "INTERNET" ? "selected" : ""}>Internet</option>
          <option value="RMA" ${item.destination === "RMA" ? "selected" : ""}>RMA</option>
        </select>
      </label>
      <button type="submit">Salvar diagnostico</button>
      <p class="message" id="triageDetailMessage"></p>
    </form>
  `;
}

function renderTriageItemView(item) {
  const detail = $("#triageDetail");
  detail.classList.remove("empty");
  detail.innerHTML = `
    <section class="triage-readonly-view">
      <div class="detail-heading">
        <span class="muted">Visualizacao da etiqueta</span>
        <h2>${escapeHtml(item.code)}</h2>
      </div>
      <dl class="triage-fields">
        <div><dt>Status</dt><dd>${triageStatusLabel(item)}</dd></div>
        <div><dt>Destino</dt><dd>${escapeHtml(item.destination || "Nao definido")}</dd></div>
        <div><dt>Descricao</dt><dd>${escapeHtml(item.descricao || "-")}</dd></div>
        <div><dt>SKU</dt><dd>${escapeHtml(item.sku || "-")}</dd></div>
        <div><dt>EAN</dt><dd>${escapeHtml(item.ean || "-")}</dd></div>
        <div><dt>ASIN/COD ML</dt><dd>${escapeHtml(item.asin || "-")}</dd></div>
        <div><dt>Serial</dt><dd>${escapeHtml(item.serial || "-")}</dd></div>
        <div><dt>Entrada</dt><dd>${formatDateTime(item.createdAt)}</dd></div>
        ${item.diagnosedAt ? `<div><dt>Diagnostico em</dt><dd>${formatDateTime(item.diagnosedAt)}</dd></div>` : ""}
        ${item.diagnosedAt ? `<div><dt>Operador ultimo laudo</dt><dd>${escapeHtml(triageDiagnosedByLabel(item))}</dd></div>` : ""}
        ${item.diagnosis ? `<div class="wide-field"><dt>Diagnostico</dt><dd>${escapeHtml(item.diagnosis)}</dd></div>` : ""}
      </dl>
    </section>
  `;
}

async function handleTriageDetailSubmit(event) {
  if (event.target.matches(".triage-edit-form")) {
    await handleTriageEditSubmit(event);
    return;
  }
  if (!event.target.matches(".triage-diagnosis-form")) return;
  event.preventDefault();
  const message = $("#triageDetailMessage");
  try {
    const response = await api(`/api/triage/items/${encodeURIComponent(state.selectedTriageCode)}/diagnosis`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
    });
    state.triageItems = [response.item, ...state.triageItems.filter((item) => item.code !== response.item.code)];
    renderTriageItems();
    renderTriageDetail(response.item);
    $("#triageDetailMessage").style.color = "#0f766e";
    $("#triageDetailMessage").textContent = "Diagnostico salvo.";
  } catch (error) {
    message.textContent = error.message;
  }
}

async function handleTriageEditSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const message = $("#triageEditMessage");
  try {
    const previousCode = state.selectedTriageCode;
    const response = await api(`/api/triage/items/${encodeURIComponent(previousCode)}/details`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    state.selectedTriageCode = response.item.code;
    state.triageItems = [response.item, ...state.triageItems.filter((item) => item.code !== previousCode && item.code !== response.item.code)]
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    renderTriageItems();
    renderTriageDetail(response.item);
    updateRoute(`/triagem/${encodeURIComponent(response.item.code)}`);
    $("#triageDetailMessage").style.color = "#0f766e";
    $("#triageDetailMessage").textContent = "Dados atualizados.";
  } catch (error) {
    if (message) message.textContent = error.message;
  }
}

function handleTriageDetailClick(event) {
  const toggle = event.target.closest("[data-toggle-triage-edit]");
  if (toggle) {
    const form = event.currentTarget.querySelector(".triage-edit-form");
    if (!form) return;
    form.classList.toggle("hidden");
    toggle.textContent = form.classList.contains("hidden") ? "Editar dados" : "Fechar edicao";
    if (!form.classList.contains("hidden")) form.querySelector('input[name="code"]')?.focus();
    return;
  }

  if (event.target.closest("[data-cancel-triage-edit]")) {
    const form = event.currentTarget.querySelector(".triage-edit-form");
    const toggleButton = event.currentTarget.querySelector("[data-toggle-triage-edit]");
    form?.classList.add("hidden");
    if (toggleButton) toggleButton.textContent = "Editar dados";
    return;
  }

  if (!event.target.closest("[data-print-triage-label]")) return;
  document.body.classList.add("printing-triage-label");
  window.print();
  setTimeout(() => document.body.classList.remove("printing-triage-label"), 1000);
}

function triageStatusLabel(item) {
  if (item.status === "diagnosticado") return "Diagnosticado";
  return "Aguardando teste";
}

function triageDiagnosedByLabel(item) {
  const user = item?.diagnosedByUser;
  if (user?.name && user?.email) return `${user.name} (${user.email})`;
  return user?.name || user?.email || "Nao registrado";
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      const error = new Error(response.ok ? "Resposta invalida do servidor." : "Servidor retornou uma pagina de erro. Recarregue e tente novamente.");
      error.status = response.status;
      error.raw = text.slice(0, 200);
      throw error;
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || "Erro inesperado.");
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeFilterText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isSameInputDate(value, inputDate) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return formatInputDate(date) === inputDate;
}
