const state = {
  user: null,
  lots: [],
  selectedLotId: null,
  selectedRz: null,
  labelProduct: null,
  config: { downloadMode: "local" },
  labelOptions: {
    autoPrint: localStorage.getItem("etiquefacil.autoPrint") !== "false",
    includePrice: localStorage.getItem("etiquefacil.includePrice") !== "false"
  }
};

const $ = (selector) => document.querySelector(selector);
const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

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
    await api("/api/logout", { method: "POST" });
    location.reload();
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
  $("#labelPrintButton").addEventListener("click", printCurrentLabel);
  $("#labelCloseButton").addEventListener("click", closeLabelModal);
  $("#labelModal").addEventListener("keydown", (event) => {
    if (event.key === "Enter") printCurrentLabel();
    if (event.key === "Escape") closeLabelModal();
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

async function showApp(user) {
  state.user = user;
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userName").textContent = `${user.name} (${user.email})`;
  await loadLots();
}

function showAuth() {
  $("#auth").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

async function loadLots(selectId = state.selectedLotId) {
  const response = await api("/api/lots");
  state.lots = response.lots;
  renderLots();
  if (selectId) await selectLot(selectId);
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
  detail.innerHTML = `
    <h2>${escapeHtml(lot.nomeArquivo)}</h2>
    <div class="actions">
      <button data-download="complete">Baixar Bling - Lote completo</button>
      <button data-download="excess" ${lot.totalExcessExternal ? "" : "disabled"}>Baixar Bling - Somente excedentes</button>
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
  $("#rzSearchButton").addEventListener("click", () => openRzFromSearch(lot));
  $("#rzSearchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") openRzFromSearch(lot);
  });
  detail.querySelectorAll(".rz-card").forEach((card) => {
    card.addEventListener("click", () => renderRz(lot, card.dataset.rz));
  });
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
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  const items = lot.items.filter((item) => item.codigoRz === codigoRz);
  $("#rzDetail").innerHTML = `
    <div class="scan-box">
      <input id="scanInput" placeholder="Bipe o Código ML no ${escapeHtml(codigoRz)}" autofocus />
      <button id="scanButton">Bipar</button>
      <label class="check-option"><input id="autoPrintToggle" type="checkbox" ${state.labelOptions.autoPrint ? "checked" : ""} /> Abrir impressão ao bipar</label>
      <label class="check-option"><input id="includePriceToggle" type="checkbox" ${state.labelOptions.includePrice ? "checked" : ""} /> Etiqueta com preço</label>
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
      renderLotDetail(response.lot);
      renderRz(response.lot, codigoRz);
      if (scannedProduct) showLabel(scannedProduct, { autoPrint: state.labelOptions.autoPrint });
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
    renderLotDetail(response.lot);
    renderRz(response.lot, codigoRz);
    showLabel(response.product, { autoPrint: state.labelOptions.autoPrint });
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
  const response = await api("/api/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId })
  });
  showLabel(response.product, { autoPrint: false });
}

function findScannedProduct(lot, codigoRz, codigoMl) {
  return lot.items.find((item) => item.codigoRz === codigoRz && item.product?.codigoMl === codigoMl)?.product || null;
}

function showLabel(product, { autoPrint = false } = {}) {
  state.labelProduct = product;
  const preview = $("#labelPreview");
  preview.innerHTML = "";
  const label = $("#labelTemplate").content.firstElementChild.cloneNode(true);
  label.querySelector(".label-desc").textContent = product.descricao;
  label.querySelector(".label-sku").textContent = product.sku;
  label.querySelector(".label-price").textContent = state.labelOptions.includePrice ? money(product.valorUnit) : "";
  renderCode39(label.querySelector(".label-barcode"), product.sku);
  preview.appendChild(label);
  $("#labelModal").classList.remove("hidden");
  $("#labelModal").focus();
  $("#labelPrintButton").focus();
  if (autoPrint) {
    setTimeout(printCurrentLabel, 250);
  }
}

function printCurrentLabel() {
  if ($("#labelModal").classList.contains("hidden")) return;
  requestAnimationFrame(() => window.print());
}

function closeLabelModal() {
  $("#labelModal").classList.add("hidden");
  $("#labelPreview").innerHTML = "";
  $("#scanInput")?.focus();
}

function renderCode39(svg, value) {
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

  svg.setAttribute("viewBox", `0 0 ${x} ${height}`);
  svg.innerHTML = bars;
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
  return `
    <article class="rz-card" data-rz="${escapeHtml(rz.codigoRz)}">
      <strong>${escapeHtml(rz.codigoRz)}</strong>
      <div class="muted">Esperado ${rz.expected} · Conferido ${rz.checked}</div>
      <div class="muted">Faltante ${rz.missing} · Excedente ${rz.excess}</div>
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
