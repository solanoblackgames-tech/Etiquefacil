const state = {
  user: null,
  adminUsers: [],
  lots: [],
  selectedLotId: null,
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
      $("#searchTab").classList.toggle("hidden", button.dataset.tab !== "search");
    });
  });

  $("#searchForm").addEventListener("submit", searchMl);
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

async function downloadBling(lotId, kind) {
  const message = $("#downloadMessage");
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
      <label class="check-option"><input id="autoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Abrir impressão ao bipar</label>
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
        <label class="check-option"><input id="autoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Abrir impressao ao bipar</label>
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
  const printWindow = state.labelOptions.autoPrint ? openLabelPrintWindow() : null;

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
      if (scannedProduct && state.labelOptions.autoPrint) showLabel(scannedProduct, { autoPrint: true, printWindow });
      else printWindow?.close();
    }
  } catch (error) {
    printWindow?.close();
    $("#scanMessage").textContent = error.message;
  }
}

async function createExternalExcess(lotId, codigoRz, codigoMl) {
  const printWindow = state.labelOptions.autoPrint ? openLabelPrintWindow() : null;
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
    if (state.labelOptions.autoPrint) showLabel(response.product, { autoPrint: true, printWindow });
    else printWindow?.close();
  } catch (error) {
    printWindow?.close();
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
  const printWindow = openLabelPrintWindow();
  try {
    const response = await api("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId })
    });
    showLabel(response.product, { autoPrint: true, printWindow });
  } catch (error) {
    printWindow?.close();
    alert(error.message);
  }
}

function findScannedProduct(lot, codigoRz, codigoMl) {
  return lot.items.find((item) => item.codigoRz === codigoRz && item.product?.codigoMl === codigoMl)?.product || null;
}

function showLabel(product, { autoPrint = false, printWindow = null } = {}) {
  state.labelProduct = product;
  const target = printWindow || openLabelPrintWindow();
  if (!target) {
    alert("O navegador bloqueou a nova guia de impressão. Permita pop-ups para o Etiquefácil.");
    return;
  }
  writeLabelPrintWindow(target, product, { autoPrint });
  $("#scanInput")?.focus();
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

function openLabelPrintWindow() {
  const printWindow = window.open("", "_blank");
  if (printWindow) printWindow.opener = null;
  return printWindow;
}

function writeLabelPrintWindow(printWindow, product, { autoPrint }) {
  const price = state.labelOptions.includePrice ? money(product.valorUnit) : "";
  const customText = state.labelOptions.includeText ? state.labelOptions.customText.trim() : "";
  const hasCustomText = Boolean(customText);
  printWindow.document.open();
  printWindow.document.write(`
    <!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <title>Etiqueta ${escapeHtml(product.sku)}</title>
        <style>
          @page {
            margin: 0;
            size: 60mm 40mm;
          }

          * {
            box-sizing: border-box;
          }

          html,
          body {
            background: #fff;
            height: 40mm;
            margin: 0;
            width: 60mm;
          }

          body {
            color: #111;
            font-family: Arial, sans-serif;
          }

          .label-print {
            display: grid;
            grid-template-rows: 9.5mm 16mm 4mm 7mm;
            height: 40mm;
            overflow: hidden;
            padding: 3mm 4mm 2.5mm;
            width: 60mm;
          }

          .label-print.has-note {
            grid-template-rows: 8mm 12mm 3.5mm 6mm 5.5mm;
            padding-bottom: 2mm;
          }

          .label-desc {
            font-size: 8.5px;
            font-weight: 700;
            line-height: 1.15;
            margin: 0;
            overflow: hidden;
          }

          .has-note .label-desc {
            font-size: 7.6px;
            line-height: 1.12;
          }

          .label-barcode {
            align-self: end;
            fill: #111;
            height: 15mm;
            justify-self: center;
            width: 49mm;
          }

          .has-note .label-barcode {
            height: 11.5mm;
          }

          .label-sku {
            align-self: center;
            font-size: 8px;
            font-weight: 500;
            justify-self: center;
            letter-spacing: 3.2px;
            line-height: 1;
          }

          .has-note .label-sku {
            font-size: 7.4px;
          }

          .label-price {
            align-self: end;
            font-family: "Arial Black", Arial, sans-serif;
            font-size: 18px;
            line-height: 1;
            white-space: nowrap;
          }

          .has-note .label-price {
            font-size: 15.5px;
          }

          .label-note {
            border-top: 1px solid #111;
            display: none;
            font-family: Arial, sans-serif;
            font-size: 6.8px;
            font-weight: 700;
            line-height: 1.15;
            margin: 0;
            overflow: hidden;
            padding-top: 0.8mm;
            text-transform: uppercase;
          }

          .has-note .label-note {
            display: block;
          }

          @media screen {
            body {
              align-items: center;
              background: #eef2f4;
              display: flex;
              height: 100vh;
              justify-content: center;
              width: 100vw;
            }

            .label-print {
              background: #fff;
              box-shadow: 0 10px 30px rgb(0 0 0 / 0.18);
            }
          }
        </style>
      </head>
      <body>
        <section class="label-print ${hasCustomText ? "has-note" : ""}">
          <p class="label-desc">${escapeHtml(product.descricao)}</p>
          ${code39Svg(product.sku)}
          <strong class="label-sku">${escapeHtml(product.sku)}</strong>
          <strong class="label-price">${escapeHtml(price)}</strong>
          <strong class="label-note">${escapeHtml(customText)}</strong>
        </section>
        <script>
          ${autoPrint ? "window.addEventListener('load', () => setTimeout(() => window.print(), 150));" : ""}
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
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
      <span>${escapeHtml(product.codigoMl || "")}</span>
      <span>${item.qtdConferida}/${item.qtdEsperada}</span>
      ${badge}
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
      <span><strong>${escapeHtml(product.sku || "")}</strong><small>${escapeHtml(product.codigoMl || "")}</small></span>
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
