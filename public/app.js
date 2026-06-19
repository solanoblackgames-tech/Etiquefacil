const state = {
  user: null,
  adminUsers: [],
  adminCatalogRequests: [],
  adminCatalogProducts: [],
  lots: [],
  selectedLotId: null,
  previewLotId: null,
  selectedDiverseLotId: null,
  selectedDiverseLot: null,
  selectedDiverseRz: null,
  selectedRz: null,
  scanOnly: false,
  pendingScan: false,
  pendingDecrement: false,
  labelProduct: null,
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
const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const formatDate = (value) => new Date(value).toLocaleDateString("pt-BR");
const routePath = (path) => `${window.location.origin}${path}`;
const normalizeCodigoMl = (value) => String(value || "").trim().toUpperCase();

await bootstrap();

async function bootstrap() {
  bindEvents();
  state.config = await api("/api/config");
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

  $("#logoutButton").addEventListener("click", async () => {
    await logout();
  });

  $("#adminLogoutButton").addEventListener("click", async () => {
    await logout();
  });

  $("#adminCreateUserForm").addEventListener("submit", createAdminUser);

  $("#adminRefreshButton").addEventListener("click", loadAdminUsers);
  $("#adminCatalogRefreshButton").addEventListener("click", loadAdminCatalogRequests);
  $("#adminCatalogSearchForm").addEventListener("submit", loadAdminCatalogProducts);

  $("#adminUsers").addEventListener("click", handleAdminUsersClick);
  $("#adminCatalogRequests").addEventListener("click", handleAdminCatalogRequestsClick);
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
    if (state.user && !state.scanOnly) applyRouteFromLocation();
  });

  document.querySelectorAll("#app [data-tab]").forEach((button) => {
    button.addEventListener("click", () => setMainTab(button.dataset.tab, { resetSelection: true }));
  });

  $("#diverseLotForm").addEventListener("submit", createDiverseLot);
  $("#diverseRzForm").addEventListener("submit", createDiverseRz);
  $("#diverseRzList").addEventListener("click", handleDiverseRzClick);
  $("#diverseScanForm").addEventListener("submit", addDiverseItem);
  $("#diverseItems").addEventListener("click", handleDiverseItemsClick);
  $("#diverseDownloadButton").addEventListener("click", () => {
    if (state.selectedDiverseLotId) downloadBling(state.selectedDiverseLotId, "complete", "#diverseScanMessage");
  });
  $("#diverseDownloadRzButton").addEventListener("click", () => {
    if (state.selectedDiverseLotId && state.selectedDiverseRz) downloadDiverseRzBling(state.selectedDiverseLotId, state.selectedDiverseRz);
  });
  $("#searchForm").addEventListener("submit", searchMl);
  document.addEventListener("input", handleCodigoMlInput);

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
  const button = form.querySelector("button");
  $("#diverseLotMessage").textContent = "";
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    const response = await api("/api/diverse-lots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.selectedDiverseLotId = response.lot.id;
    $("#diverseLotMessage").style.color = "#0f766e";
    $("#diverseLotMessage").textContent = "Lote criado. Pode comecar a bipar.";
    renderDiverseLot(response.lot);
    await loadLots(response.lot.id);
    updateRoute("/entradas");
    $("#diverseRzForm input[name='codigoRz']").focus();
  } catch (error) {
    $("#diverseLotMessage").style.color = "";
    $("#diverseLotMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
    $("#diverseScanMessage").style.color = "#0f766e";
    $("#diverseScanMessage").textContent = diverseScanStatusMessage(response, codigoRz, parent);
    await loadLots(response.lot.id);
    if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true });
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
        $("#diverseScanMessage").style.color = "#0f766e";
        $("#diverseScanMessage").textContent = `SKU ${response.product.sku} gerado e enviado para sugestao do banco historico.`;
        await loadLots(response.lot.id);
        if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true });
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

function promptManualProduct(codigoMl, focusSelector) {
  return askManualProduct(codigoMl, focusSelector);
}

function parseMoneyInput(value) {
  return Number(String(value || "").trim().replace(/\./g, "").replace(",", "."));
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

function askManualProduct(codigoMl, focusSelector) {
  return openManualProductModal(codigoMl, focusSelector);
}

function openManualProductModal(codigoMl, focusSelector = "#diverseScanForm input[name='codigoMl']") {
  return new Promise((resolve) => {
    const modal = $("#manualProductModal");
    const form = $("#manualProductForm");
    const code = $("#manualProductCode");
    const description = $("#manualProductDescription");
    const price = $("#manualProductPrice");
    const ean = $("#manualProductEan");
    const link = $("#manualProductLink");
    const photo = $("#manualProductPhoto");
    const error = $("#manualProductError");
    const cancel = $("#manualProductCancel");

    const cleanup = () => {
      modal.classList.add("hidden");
      form.onsubmit = null;
      ean.onkeydown = null;
      cancel.onclick = null;
      modal.onkeydown = null;
      form.reset();
      error.textContent = "";
      setTimeout(() => $(focusSelector)?.focus(), 0);
    };

    code.textContent = codigoMl;
    form.reset();
    error.textContent = "";
    modal.classList.remove("hidden");

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
  const input = event.currentTarget.querySelector("input[name='codigoRz']");
  const codigoRz = normalizeCode(input.value);
  if (!codigoRz) return;
  setDiverseRz(codigoRz);
  input.value = "";
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
  if (state.selectedDiverseRz && !rzs.some((rz) => rz.codigoRz === state.selectedDiverseRz)) state.selectedDiverseRz = null;
  if (!state.selectedDiverseRz && rzs.length) state.selectedDiverseRz = rzs[0].codigoRz;
  mountDiversePanelForCurrentView();
  $("#diverseScanPanel").classList.remove("hidden");
  $("#diverseLotTitle").textContent = `${lot.nomeArquivo} · proximo ${lot.prefixoSku}${String(lot.proximoSequencialSku).padStart(4, "0")}`;
  renderDiverseRzControls(lot);
  $("#diverseLabelOptions").innerHTML = diverseLabelOptionsMarkup();
  bindDiverseLabelOptions();
  $("#diverseItems").innerHTML = diverseItemsTable(lot);
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
  return (lot.products || []).some((product) => product.origem === "lote_sem_planilha" || product.origem === "lote_sem_planilha_manual" || product.origem === "entrada_diversos");
}

function renderDiverseRzControls(lot) {
  const active = state.selectedDiverseRz;
  $("#diverseActiveRz").textContent = active ? `Remessa ativa: ${active}` : "Nenhuma remessa ativa";
  $("#diverseDownloadRzButton").disabled = !active;
  $("#diverseScanForm input[name='codigoMl']").disabled = !active;
  $("#diverseScanForm button").disabled = !active;
  $("#diverseRzList").innerHTML = diverseRzs(lot)
    .map((rz) => `
      <button type="button" class="${rz.codigoRz === active ? "active" : ""}" data-diverse-rz="${escapeHtml(rz.codigoRz)}">
        ${escapeHtml(rz.codigoRz)} <span>${rz.items}</span>
      </button>
    `)
    .join("");
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

function handleDiverseItemsClick(event) {
  const button = event.target.closest("[data-diverse-label]");
  if (!button) return;
  const product = findDiverseProduct(button.dataset.diverseLabel);
  if (product) showLabel(product, { autoPrint: true });
}

function findDiverseProduct(productId) {
  const lot = state.selectedDiverseLot;
  if (!lot?.items) return null;
  return lot.items.find((item) => item.product?.id === productId)?.product || null;
}

async function showApp(user) {
  state.user = user;
  $("#auth").classList.add("hidden");
  if (user.role === "admin") {
    $("#app").classList.add("hidden");
    $("#adminApp").classList.remove("hidden");
    $("#adminName").textContent = `${user.name} (${user.email})`;
    await loadAdminUsers();
    await loadAdminCatalogRequests();
    await loadAdminCatalogProducts();
    schedulePrimaryInputFocus();
    return;
  }

  $("#adminApp").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#app .app-nav")?.classList.remove("hidden");
  $("#userName").textContent = `${user.name} (${user.email})`;
  const scanRequest = getScanRequest();
  if (scanRequest) {
    await showScanOnly(scanRequest);
    return;
  }
  await loadLots();
  await applyRouteFromLocation({ replace: true });
  schedulePrimaryInputFocus();
}

function showAuth() {
  document.body.classList.remove("scan-only");
  document.body.classList.remove("lot-focus");
  $("#auth").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#adminApp").classList.add("hidden");
  schedulePrimaryInputFocus(["#loginForm input[name='email']"]);
}

async function applyRouteFromLocation({ replace = false } = {}) {
  const route = parseRoute(window.location.pathname);

  if (route.view === "lotRz") {
    const lot = await selectLot(route.lotId, { push: false });
    if (lot) renderRz(lot, route.codigoRz, { push: false });
    if (replace) updateRoute(lot ? lotRzPath(route.lotId, route.codigoRz) : "/lotes", { replace: true });
    return;
  }

  if (route.view === "lot") {
    const lot = await selectLot(route.lotId, { push: false });
    if (replace) updateRoute(lot ? lotPath(route.lotId) : "/lotes", { replace: true });
    return;
  }

  setMainTab(route.view, { push: false, resetSelection: route.view === "lots" });
  if (replace) updateRoute(routePathForView(route.view), { replace: true });
}

function parseRoute(pathname) {
  const parts = String(pathname || "/").split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts[0] === "entradas") return { view: "home" };
  if (parts[0] === "busca") return { view: "search" };
  if (parts[0] === "lotes" && parts[1] && parts[2] === "rz" && parts[3]) return { view: "lotRz", lotId: parts[1], codigoRz: parts[3] };
  if (parts[0] === "lotes" && parts[1]) return { view: "lot", lotId: parts[1] };
  if (parts[0] === "lotes") return { view: "lots" };
  return { view: "home" };
}

function routePathForView(view) {
  if (view === "lots") return "/lotes";
  if (view === "search") return "/busca";
  return "/entradas";
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

function setMainTab(tab, { push = true, resetSelection = false } = {}) {
  const target = tab || "home";
  if (resetSelection) {
    state.selectedLotId = null;
    state.previewLotId = null;
    state.selectedRz = null;
    renderLots();
    clearLotDetail();
  }
  document.querySelectorAll("#app [data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === target);
  });
  $(".upload-band").classList.toggle("hidden", target !== "home");
  $("#lotsTab").classList.toggle("hidden", target !== "lots");
  $("#searchTab").classList.toggle("hidden", target !== "search");
  document.body.classList.remove("lot-focus");
  if (push) updateRoute(routePathForView(target));
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

async function loadAdminCatalogRequests() {
  const response = await api("/api/admin/catalog-requests");
  state.adminCatalogRequests = response.requests;
  renderAdminCatalogRequests();
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

function renderAdminCatalogRequests() {
  const wrapper = $("#adminCatalogRequests");
  if (!state.adminCatalogRequests.length) {
    wrapper.innerHTML = '<p class="muted">Nenhuma sugestao enviada ainda.</p>';
    return;
  }

  wrapper.innerHTML = `
    <div class="admin-table">
      <div class="admin-row catalog-request-row admin-row-head">
        <span>Sugestao</span>
        <span>Codigo ML</span>
        <span>Preco</span>
        <span>Cadastros</span>
        <span>Status</span>
        <span>Acoes</span>
      </div>
      ${state.adminCatalogRequests.map(adminCatalogRequestRow).join("")}
    </div>
  `;
}

function renderAdminCatalogProducts() {
  const wrapper = $("#adminCatalogProducts");
  if (!state.adminCatalogProducts.length) {
    wrapper.innerHTML = '<p class="muted">Nenhum produto aprovado no banco historico.</p>';
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
  const user = request.user?.email || request.user?.name || "usuario";
  const pending = request.status === "pending";
  const options = catalogApprovalOptions(request);
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
      <div class="catalog-request-summary">
        ${catalogPhotoFrame(request.foto, "catalog-photo-main")}
        <div>
        <strong>${request.type === "update" ? "Alteracao" : "Cadastro"}</strong>
        <span class="muted">${escapeHtml(user)} · ${formatDate(request.createdAt)}</span>
        <span class="muted">${escapeHtml(request.descricao)}</span>
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
    { id: "base", label: "Cadastro inicial", user: request.user, createdAt: request.createdAt, descricao: request.descricao, valorUnit: request.valorUnit, ean: request.ean, link: request.link, foto: request.foto },
    ...(Array.isArray(request.doubleChecks) ? request.doubleChecks : []).map((check, index) => ({ ...check, label: `Double check ${index + 1}` }))
  ];
}

function catalogApprovalOptionRow(requestId, option, index) {
  const optionId = option.id || "base";
  const user = option.user?.email || option.user?.name || "usuario";
  const link = String(option.link || "").trim();
  const photo = String(option.foto || "").trim();
  const ean = String(option.ean || "").trim();
  return `
    <label class="double-check-item">
      <input type="radio" name="catalog-choice-${escapeHtml(requestId)}" value="${escapeHtml(optionId)}" ${index === 0 ? "checked" : ""} />
      ${catalogPhotoFrame(photo, "catalog-photo-option")}
      <div>
        <strong>${escapeHtml(option.label || "Cadastro")}</strong>
        <span>${escapeHtml(user)} - ${formatDate(option.createdAt)} - ${money(option.valorUnit)}</span>
        <span>${escapeHtml(option.descricao || "")}</span>
        <span>EAN: ${escapeHtml(ean || "-")}${link ? ` - <a class="catalog-link" href="${escapeHtml(link)}" target="_blank" rel="noopener">Abrir link</a>` : ""}</span>
      </div>
    </label>
  `;
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
    <article class="admin-row" data-user-id="${escapeHtml(user.id)}">
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
        <button class="danger" type="button" data-delete-user="${escapeHtml(user.id)}">Excluir</button>
      </div>
    </article>
  `;
}

async function handleAdminPasswordSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form.matches(".password-form")) return;
  const row = form.closest(".admin-row");
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
  const button = event.target.closest("[data-delete-user]");
  if (!button) return;
  const user = state.adminUsers.find((item) => item.id === button.dataset.deleteUser);
  if (!user || !confirm(`Excluir ${user.name}? Esta acao apaga tambem os lotes deste usuario.`)) return;

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
  const button = event.target.closest("[data-review-catalog]");
  if (!button) return;
  const row = button.closest("[data-catalog-request-id]");
  const action = button.dataset.reviewCatalog;
  const selectedCheckId = row.querySelector('input[type="radio"][name^="catalog-choice-"]:checked')?.value || "base";
  button.disabled = true;
  try {
    await api(`/api/admin/catalog-requests/${encodeURIComponent(row.dataset.catalogRequestId)}/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "approve" ? { selectedCheckId } : {})
    });
    $("#adminMessage").style.color = "#0f766e";
    $("#adminMessage").textContent = action === "approve" ? "Sugestao aprovada." : "Sugestao rejeitada.";
    await loadAdminCatalogRequests();
  } catch (error) {
    $("#adminMessage").style.color = "";
    $("#adminMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
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

async function loadLots(selectId = state.selectedLotId) {
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
}

function clearLotDetail() {
  document.body.classList.remove("lot-focus");
  state.previewLotId = null;
  $("#lotDetail").classList.add("empty");
  $("#lotDetail").textContent = "Selecione um lote para conferir RZs e baixar arquivos do Bling.";
  hideNoSheetPanel();
}

function renderLots() {
  const wrapper = $("#lots");
  wrapper.innerHTML = "";
  if (!state.lots.length) {
    wrapper.innerHTML = '<p class="muted">Nenhuma planilha importada ainda.</p>';
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
  if (isNoSheetLot(response.lot)) {
    renderDiverseLot(response.lot);
  } else {
    hideNoSheetPanel();
  }
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
    ${noSheetLot ? '<div id="diversePanelMount"></div>' : ""}
    ${noSheetLot ? '<p class="muted">Lote sem planilha: gere/use uma RZ no painel do lote e inicie a bipagem.</p>' : ""}
    <div class="actions">
      <button data-download="complete">Baixar Bling - Lote completo</button>
      <button data-download="excess" ${lot.totalExcessExternal ? "" : "disabled"}>Baixar Bling - Somente excedentes</button>
      <button class="danger" type="button" id="deleteLotButton">Excluir lote</button>
    </div>
    <p id="downloadMessage" class="message"></p>
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
    <h3 class="section-title">RZs</h3>
    <div class="rz-search">
      <input id="rzSearchInput" placeholder="Bipe ou digite o Código RZ" />
      <button id="rzSearchButton">Abrir RZ</button>
    </div>
    <p id="rzSearchMessage" class="message"></p>
    <div class="rz-grid">
      ${lot.rzs.map((rz) => rzCard(rz)).join("")}
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
  detail.querySelectorAll("button[data-download]").forEach((button) => {
    button.addEventListener("click", () => downloadBling(lot.id, button.dataset.download));
  });
  $("#deleteLotButton").addEventListener("click", () => deleteLot(lot));
  $("#rzSearchButton").addEventListener("click", () => openRzFromSearch(lot));
  $("#rzSearchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") openRzFromSearch(lot);
  });
  detail.querySelectorAll("[data-scan-rz]").forEach((button) => {
    button.addEventListener("click", () => renderRz(lot, button.dataset.scanRz));
  });
  detail.querySelectorAll("[data-pallet-rz]").forEach((button) => {
    button.addEventListener("click", () => renderPallet(lot, button.dataset.palletRz));
  });
  schedulePrimaryInputFocus(noSheetLot ? undefined : ["#rzSearchInput"]);
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
  if (!rz) {
    message.style.color = "";
    message.textContent = "RZ não encontrado neste lote.";
    input.select();
    return;
  }
  message.textContent = "";
  input.value = "";
  renderRz(lot, rz.codigoRz);
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
      <input id="scanInput" placeholder="Bipe o Código ML no ${escapeHtml(codigoRz)}" autofocus />
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
  bindScanControls(lot.id, codigoRz);
  if (push) updateRoute(lotRzPath(lot.id, codigoRz));
}

function renderPallet(lot, codigoRz) {
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
          <a class="button-link" href="/api/lots/${encodeURIComponent(lot.id)}/rz/${encodeURIComponent(codigoRz)}/bling">Baixar Bling Remessa</a>
          <a class="button-link" href="/api/lots/${encodeURIComponent(lot.id)}/rz/${encodeURIComponent(codigoRz)}/stock-entry">Entrada Estoque Bling</a>
          <a class="button-link" href="${baseUrl}/pdf">Baixar PDF</a>
          <a class="button-link" href="${baseUrl}/xlsx">Baixar XLSX</a>
        </div>
      </div>
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
  $("#rzDetail [data-scan-rz]").addEventListener("click", () => renderRz(lot, codigoRz));
}

function openScanWindow(lotId, codigoRz) {
  const url = lotRzPath(lotId, codigoRz);
  const target = `etiquefacil-bipagem-${String(lotId).replace(/\W/g, "")}-${String(codigoRz).replace(/\W/g, "")}`;
  const scanWindow = window.open(url, target, "width=1180,height=760");
  if (scanWindow) scanWindow.focus();
  return Boolean(scanWindow);
}

function renderScanPage(lot, codigoRz) {
  state.selectedLotId = lot.id;
  state.selectedRz = codigoRz;
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  if (!rz) {
    $("#lotDetail").classList.add("empty");
    $("#lotDetail").textContent = "RZ nao encontrado neste lote.";
    return;
  }

  const items = lot.items.filter((item) => item.codigoRz === codigoRz);
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
        <input id="scanInput" placeholder="Bipe o Codigo ML no ${escapeHtml(codigoRz)}" autofocus />
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
        ${items.map(itemRow).join("")}
      </div>
    </section>
  `;
  bindScanControls(lot.id, codigoRz);
}

function bindScanControls(lotId, codigoRz) {
  $("#scanButton").addEventListener("click", () => scanCurrent(lotId, codigoRz));
  $("#decrementScanButton").addEventListener("click", () => decrementCurrent(lotId, codigoRz));
  document.querySelectorAll("[data-decrement-ml]").forEach((button) => {
    button.addEventListener("click", () => decrementCurrent(lotId, codigoRz, button.dataset.decrementMl));
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
    if (event.key === "Enter") scanCurrent(lotId, codigoRz);
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
  const codigoMl = normalizeCodigoMl(input.value);
  input.value = codigoMl;
  if (!codigoMl) return;

  try {
    state.pendingScan = true;
    $("#scanButton").disabled = true;
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
      if (state.scanOnly) {
        renderScanPage(response.lot, codigoRz);
        $("#scanMessage").textContent = response.scan.status === "excedente" ? "Quantidade excedente registrada." : "Bipagem registrada.";
      } else {
        renderLotDetail(response.lot);
      }
      if (scannedProduct && state.labelOptions.autoPrint) showLabel(scannedProduct, { autoPrint: true });
    }
  } catch (error) {
    $("#scanMessage").textContent = error.message;
  } finally {
    state.pendingScan = false;
    const scanButton = $("#scanButton");
    if (scanButton) scanButton.disabled = false;
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
    if (state.scanOnly) {
      renderScanPage(response.lot, codigoRz);
      $("#scanMessage").textContent = successMessage;
    } else {
      renderLotDetail(response.lot);
      $("#scanMessage").textContent = successMessage;
    }
    if (response.product && state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true });
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
    if (state.scanOnly) {
      renderScanPage(response.lot, codigoRz);
      $("#scanMessage").textContent = "Quantidade bipada diminuida.";
    } else {
      renderLotDetail(response.lot);
    }
  } catch (error) {
    $("#scanMessage").textContent = error.message;
  } finally {
    state.pendingDecrement = false;
    const decrementButton = $("#decrementScanButton");
    if (decrementButton) decrementButton.disabled = false;
    schedulePrimaryInputFocus(["#scanInput"]);
  }
}

async function createExternalExcess(lotId, codigoRz, codigoMl) {
  try {
    const response = await api(`/api/lots/${lotId}/rz/${encodeURIComponent(codigoRz)}/external-excess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    if (state.scanOnly) {
      renderScanPage(response.lot, codigoRz);
      $("#scanMessage").textContent = "Excedente externo cadastrado.";
    } else {
      renderLotDetail(response.lot);
    }
    if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true });
  } catch (error) {
    $("#scanMessage").textContent = error.message;
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
    showLabel(response.product, { autoPrint: true });
  } catch (error) {
    alert(error.message);
  }
}

function findScannedProduct(lot, codigoRz, codigoMl) {
  const normalizedMl = normalizeCodigoMl(codigoMl);
  return lot.items.find((item) => item.codigoRz === codigoRz && normalizeCodigoMl(item.product?.codigoMl) === normalizedMl)?.product || null;
}

function showLabel(product, { autoPrint = false } = {}) {
  state.labelProduct = product;
  $("#labelPreview").innerHTML = labelMarkup(product);
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

  const encoded = `*${String(value).toUpperCase().replace(/[^0-9A-Z .$/+%-]/g, "-")}*`;
  const narrow = 2;
  const wide = 5;
  const height = 78;
  let x = 0;
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

  return `<svg class="label-barcode" viewBox="0 0 ${x} ${height}" role="img" aria-label="Código de barras">${bars}</svg>`;
}

function labelMarkup(product) {
  const price = state.labelOptions.includePrice ? money(product.valorUnit) : "";
  const customText = state.labelOptions.includeText ? state.labelOptions.customText.trim() : "";
  const hasCustomText = Boolean(customText);
  return `
    <section class="label-print ${hasCustomText ? "has-note" : ""}">
      <p class="label-desc">${escapeHtml(product.descricao)}</p>
      ${code39Svg(product.sku)}
      <strong class="label-sku">${escapeHtml(product.sku)}</strong>
      <strong class="label-price">${escapeHtml(price)}</strong>
      <strong class="label-note">${escapeHtml(customText)}</strong>
    </section>
  `;
}

function printCurrentLabel() {
  if (!state.labelProduct || $("#labelModal").classList.contains("hidden")) return;
  cleanupLabelPrintRoot();
  const printRoot = document.createElement("div");
  printRoot.id = "labelPrintRoot";
  printRoot.innerHTML = $("#labelPreview").innerHTML;
  document.body.appendChild(printRoot);
  document.body.classList.add("printing-label");
  window.print();
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
  document.body.classList.remove("printing-label");
  $("#labelPrintRoot")?.remove();
}

function hideLabelPreview() {
  $("#labelModal").classList.add("hidden");
  $("#labelPreview").innerHTML = "";
  state.labelProduct = null;
  scheduleScanInputFocus();
}

function scheduleScanInputFocus() {
  schedulePrimaryInputFocus(["#scanInput", "#diverseScanForm input[name='codigoMl']"]);
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
    "#decisionModal:not(.hidden) .decision-fields label:not(.hidden) input",
    "#scanInput",
    "#diverseScanForm input[name='codigoMl']:not(:disabled)",
    "#diverseRzForm input[name='codigoRz']",
    "#rzSearchInput",
    "#searchTab:not(.hidden) #searchForm input[name='codigoMl']",
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

function rzCard(rz) {
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
        <button type="button" data-scan-rz="${escapeHtml(rz.codigoRz)}">Iniciar bipagem</button>
        <button type="button" class="ghost" data-pallet-rz="${escapeHtml(rz.codigoRz)}">Exibir pallet</button>
      </div>
    </article>
  `;
}

function itemRow(item) {
  const product = item.product || {};
  const badge = item.tipoItem === "excedente_externo" ? '<span class="badge excess">excedente externo</span>' : `<span class="badge">${escapeHtml(item.tipoItem)}</span>`;
  return `
    <article class="item-row">
      <strong>${escapeHtml(product.sku || "")}</strong>
      <span>${escapeHtml(product.descricao || "")}</span>
      <span class="code-cell"><small>Codigo ML</small><strong>${escapeHtml(product.codigoMl || "")}</strong></span>
      <span>${item.qtdConferida}/${item.qtdEsperada}</span>
      ${badge}
      <button type="button" class="danger ghost" data-decrement-ml="${escapeHtml(product.codigoMl || "")}" ${item.qtdConferida > 0 ? "" : "disabled"}>Diminuir</button>
    </article>
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
        <span>Qtd</span>
        <span>Venda</span>
        <span>Custo</span>
        <span>Etiqueta</span>
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
      <span>${item.qtdEsperada || 0}</span>
      <span>${money(product.valorUnit)}</span>
      <span>${money(product.precoCusto)}</span>
      <span><button type="button" data-diverse-label="${escapeHtml(product.id || "")}">Imprimir</button></span>
    </article>
  `;
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
      <span><span class="badge">${rowStatus}</span></span>
    </article>
  `;
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
