const state = {
  user: null,
  adminUsers: [],
  lots: [],
  selectedLotId: null,
  selectedDiverseLotId: null,
  selectedDiverseLot: null,
  selectedDiverseRz: null,
  selectedRz: null,
  scanOnly: false,
  labelProduct: null,
  config: { downloadMode: "local" },
  labelOptions: {
    autoPrint: localStorage.getItem("etiquefacil.autoPrint") !== "false",
    includePrice: localStorage.getItem("etiquefacil.includePrice") !== "false",
    includeText: localStorage.getItem("etiquefacil.includeText") === "true",
    customText: localStorage.getItem("etiquefacil.customText") || ""
  }
};

const $ = (selector) => document.querySelector(selector);
const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const formatDate = (value) => new Date(value).toLocaleDateString("pt-BR");

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

  $("#adminUsers").addEventListener("click", handleAdminUsersClick);

  $("#adminUsers").addEventListener("submit", handleAdminPasswordSubmit);

  $("#adminUsers").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches('input[name="password"]')) {
      event.preventDefault();
      event.target.closest("form")?.requestSubmit();
    }
  });

  $("#uploadForm").addEventListener("submit", uploadLot);

  document.querySelectorAll(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $("#lotsTab").classList.toggle("hidden", button.dataset.tab !== "lots");
      $("#diverseTab").classList.toggle("hidden", button.dataset.tab !== "diverse");
      $("#searchTab").classList.toggle("hidden", button.dataset.tab !== "search");
    });
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
  window.addEventListener("afterprint", () => {
    cleanupLabelPrintRoot();
    hideLabelPreview();
  });
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
  const codigoMl = input.value.trim();
  const codigoRz = state.selectedDiverseRz;
  if (!codigoMl || !codigoRz) return;

  $("#diverseScanMessage").textContent = "";
  button.disabled = true;
  try {
    const response = await api(`/api/lots/${encodeURIComponent(state.selectedDiverseLotId)}/diverse-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl, codigoRz })
    });
    input.value = "";
    renderDiverseLot(response.lot);
    const parent = response.parent?.lot?.nomeArquivo ? ` Pai: ${response.parent.lot.nomeArquivo}.` : "";
    $("#diverseScanMessage").style.color = "#0f766e";
    $("#diverseScanMessage").textContent = diverseScanStatusMessage(response, codigoRz, parent);
    await loadLots(response.lot.id);
    if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true });
    input.focus();
  } catch (error) {
    $("#diverseScanMessage").style.color = "";
    $("#diverseScanMessage").textContent = error.message;
    input.select();
  } finally {
    button.disabled = false;
  }
}

function createDiverseRz(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector("input[name='codigoRz']");
  const codigoRz = normalizeCode(input.value);
  if (!codigoRz) return;
  setDiverseRz(codigoRz);
  input.value = "";
  $("#diverseScanMessage").style.color = "#0f766e";
  $("#diverseScanMessage").textContent = `RZ ${codigoRz} ativo.`;
  $("#diverseScanForm input[name='codigoMl']").focus();
}

function handleDiverseRzClick(event) {
  const button = event.target.closest("[data-diverse-rz]");
  if (!button) return;
  setDiverseRz(button.dataset.diverseRz);
  $("#diverseScanMessage").style.color = "#0f766e";
  $("#diverseScanMessage").textContent = `RZ ${button.dataset.diverseRz} ativo.`;
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
  $("#diverseScanPanel").classList.remove("hidden");
  $("#diverseLotTitle").textContent = `${lot.nomeArquivo} · proximo ${lot.prefixoSku}${String(lot.proximoSequencialSku).padStart(4, "0")}`;
  renderDiverseRzControls(lot);
  $("#diverseLabelOptions").innerHTML = diverseLabelOptionsMarkup();
  bindDiverseLabelOptions();
  $("#diverseItems").innerHTML = diverseItemsTable(lot);
}

function renderDiverseRzControls(lot) {
  const active = state.selectedDiverseRz;
  $("#diverseActiveRz").textContent = active ? `RZ ativo: ${active}` : "Nenhum RZ ativo";
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
    if (item.tipoItem !== "entrada_diversos") continue;
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
      message.textContent = "Download do RZ enviado para o navegador.";
      return;
    }

    const response = await fetch(`/api/lots/${encodeURIComponent(lotId)}/rz/${encodeURIComponent(codigoRz)}/bling/save`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Nao foi possivel gerar o arquivo Bling do RZ.");
    }
    const payload = await response.json();
    message.style.color = "#0f766e";
    message.innerHTML = `Arquivo do RZ salvo: <strong>${escapeHtml(payload.path)}</strong>`;
  } catch (error) {
    message.style.color = "";
    message.textContent = error.message;
  }
}

function diverseScanStatusMessage(response, codigoRz, parent) {
  if (response.status === "duplicado_rz") return `Quantidade somada no RZ ${codigoRz}.`;
  if (response.status === "mesmo_sku_novo_rz") return `SKU ${response.product.sku} reutilizado no RZ ${codigoRz}.`;
  return `SKU ${response.product.sku} gerado no RZ ${codigoRz}.${parent}`;
}

function diverseLabelOptionsMarkup() {
  return `
    <div class="diverse-label-options">
      <label class="check-option"><input id="diverseAutoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Imprimir ao bipar</label>
      <label class="check-option"><input id="diverseIncludePriceToggle" type="checkbox" ${state.labelOptions.includePrice ? "checked" : ""} /> Etiqueta com preco</label>
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
    return;
  }

  $("#adminApp").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userName").textContent = `${user.name} (${user.email})`;
  const scanRequest = getScanRequest();
  if (scanRequest) {
    await showScanOnly(scanRequest);
    return;
  }
  await loadLots();
}

function showAuth() {
  document.body.classList.remove("scan-only");
  $("#auth").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#adminApp").classList.add("hidden");
}

function getScanRequest() {
  const params = new URLSearchParams(window.location.search);
  const lotId = params.get("scanLot");
  const codigoRz = params.get("scanRz");
  if (!lotId || !codigoRz) return null;
  return { lotId, codigoRz };
}

async function showScanOnly({ lotId, codigoRz }) {
  state.scanOnly = true;
  state.selectedLotId = lotId;
  state.selectedRz = codigoRz;
  document.body.classList.add("scan-only");
  $("#app .topbar h1").textContent = "Bipagem";
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

async function loadLots(selectId = state.selectedLotId) {
  const response = await api("/api/lots");
  state.lots = response.lots;
  if (!selectId || !state.lots.some((lot) => lot.id === selectId)) {
    selectId = null;
    state.selectedLotId = null;
    state.selectedRz = null;
    clearLotDetail();
  }
  renderLots();
  if (selectId) await selectLot(selectId);
}

function clearLotDetail() {
  $("#lotDetail").classList.add("empty");
  $("#lotDetail").textContent = "Selecione um lote para conferir RZs e baixar arquivos do Bling.";
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
    card.className = `lot-card ${lot.id === state.selectedLotId ? "active" : ""}`;
    card.innerHTML = `
      <strong>${escapeHtml(lot.nomeArquivo)}</strong>
      <span class="muted">${lot.totalProducts} SKUs · ${lot.rzs.length} RZs</span>
      <span class="muted">${escapeHtml(lot.prefixoSku)} · ${lot.percentualArremate}% · ${escapeHtml(lot.fornecedor)}</span>
      ${lot.totalExcessExternal ? `<span class="badge excess">${lot.totalExcessExternal} excedente(s)</span>` : ""}
    `;
    card.addEventListener("click", () => selectLot(lot.id));
    wrapper.appendChild(card);
  }
}

async function selectLot(lotId) {
  state.selectedLotId = lotId;
  state.selectedRz = null;
  const response = await api(`/api/lots/${lotId}`);
  renderLots();
  renderLotDetail(response.lot);
}

function renderLotDetail(lot) {
  const detail = $("#lotDetail");
  detail.classList.remove("empty");
  detail.innerHTML = `
    <h2>${escapeHtml(lot.nomeArquivo)}</h2>
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

function renderRz(lot, codigoRz) {
  state.selectedRz = codigoRz;
  document.querySelectorAll(".rz-card").forEach((card) => card.classList.toggle("selected", card.dataset.rz === codigoRz));
  const opened = openScanWindow(lot.id, codigoRz);
  const rzDetail = $("#rzDetail");
  if (rzDetail) {
    rzDetail.innerHTML = `
      <div class="scan-opened">
        <strong>Bipagem aberta em uma nova janela.</strong>
        <span class="muted">Voce pode continuar navegando neste sistema enquanto o operador bipa o ${escapeHtml(codigoRz)}.</span>
        <button type="button" id="reopenScanButton">Reabrir bipagem</button>
      </div>
    `;
    $("#reopenScanButton").addEventListener("click", () => openScanWindow(lot.id, codigoRz));
  }
  if (!opened) alert("O navegador bloqueou a janela de bipagem. Permita pop-ups para o Etiquefacil.");
  return;
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  const items = lot.items.filter((item) => item.codigoRz === codigoRz);
  $("#rzDetail").innerHTML = `
    <div class="scan-box">
      <input id="scanInput" placeholder="Bipe o Código ML no ${escapeHtml(codigoRz)}" autofocus />
      <button id="scanButton">Bipar</button>
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
  $("#scanButton").addEventListener("click", () => scanCurrent(lot.id, codigoRz));
  $("#autoPrintToggle").addEventListener("change", (event) => {
    state.labelOptions.autoPrint = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.autoPrint", String(state.labelOptions.autoPrint));
  });
  $("#includePriceToggle").addEventListener("change", (event) => {
    state.labelOptions.includePrice = event.currentTarget.checked;
    localStorage.setItem("etiquefacil.includePrice", String(state.labelOptions.includePrice));
  });
  $("#scanInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") scanCurrent(lot.id, codigoRz);
  });
  $("#scanInput").focus();
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
          <a class="button-link" href="/api/lots/${encodeURIComponent(lot.id)}/rz/${encodeURIComponent(codigoRz)}/bling">Baixar Bling RZ</a>
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
  const url = `${window.location.pathname}?scanLot=${encodeURIComponent(lotId)}&scanRz=${encodeURIComponent(codigoRz)}`;
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
  $("#scanInput").focus();
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
  const input = $("#scanInput");
  const codigoMl = input.value.trim();
  if (!codigoMl) return;

  try {
    const response = await api(`/api/lots/${lotId}/rz/${encodeURIComponent(codigoRz)}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoMl })
    });
    input.value = "";
    const message = $("#scanMessage");
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
  const codigoMl = new FormData(event.currentTarget).get("codigoMl");
  const response = await api(`/api/search?codigoMl=${encodeURIComponent(codigoMl)}`);
  const wrapper = $("#searchResults");
  if (!response.results.length) {
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
  return lot.items.find((item) => item.codigoRz === codigoRz && item.product?.codigoMl === codigoMl)?.product || null;
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

function cleanupLabelPrintRoot() {
  document.body.classList.remove("printing-label");
  $("#labelPrintRoot")?.remove();
}

function hideLabelPreview() {
  $("#labelModal").classList.add("hidden");
  $("#labelPreview").innerHTML = "";
  state.labelProduct = null;
  setTimeout(() => $("#scanInput")?.focus(), 0);
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
    </article>
  `;
}

function diverseItemsTable(lot) {
  const items = (lot.items || []).filter((item) => item.tipoItem === "entrada_diversos");
  if (!items.length) return '<p class="muted">Nenhum codigo bipado neste lote ainda.</p>';
  const sortedItems = [...items].sort((a, b) => {
    const byRz = String(a.codigoRz || "").localeCompare(String(b.codigoRz || ""));
    if (byRz) return byRz;
    return String(a.product?.sku || "").localeCompare(String(b.product?.sku || ""));
  });

  return `
    <div class="diverse-table">
      <div class="diverse-row diverse-row-head">
        <span>RZ</span>
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

function diverseItemRow(item, startsRz = false) {
  const product = item.product || {};
  return `
    ${startsRz ? `<div class="diverse-rz-divider">RZ ${escapeHtml(item.codigoRz || "")}</div>` : ""}
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
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || "Erro inesperado.");
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
