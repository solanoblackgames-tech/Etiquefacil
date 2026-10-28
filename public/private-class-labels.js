const base = "/api/private-classes";
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const date = (value) => value ? new Date(value).toLocaleString("pt-BR") : "Em montagem";
async function request(url, body) {
  const response = await fetch(base + url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Falha ao consultar etiquetas.");
  return data;
}
export const isPrivateClassCode = (value) => /^[A-F0-9]{32}$/i.test(String(value || "").trim());
const originLabel = (code) => ["A", "B"].includes(code) ? `${code} (piloto)` : code;

export async function mountClassGeneration(container) {
  if (!container) return;
  let panel = container.querySelector("[data-class-generation]");
  if (!panel) {
    panel = document.createElement("details");
    panel.className = "entry-panel";
    panel.dataset.classGeneration = "";
    container.prepend(panel);
    panel.innerHTML = `<summary>Etiquetas por lote de origem</summary><p class="muted">Cadastre cada chegada, como EXP10 e EXP11. Selecione o lote e gere suas etiquetas. Os QRs impressos continuam sem identificar a origem.</p>
      <form class="transfer-form" data-new-source-lot><label>Novo lote de origem<input name="code" maxlength="40" placeholder="EXP10" autocomplete="off" required></label><button>Cadastrar lote de origem</button></form>
      <form class="transfer-form" data-source-labels><label>Lote de origem<select name="sourceLot" required><option value="">Carregando lotes...</option></select></label>
      <label>Quantidade<input name="quantity" type="number" min="1" max="1000" step="1" value="1" required></label><button disabled>Gerar etiquetas</button></form>
      <p data-message class="message"></p><div data-batches></div>`;
    panel.querySelector("[data-new-source-lot]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const { sourceLot } = await request("/source-lots", { code: form.elements.code.value });
        form.reset();
        await loadSourceLots(panel, sourceLot.code);
        panel.querySelector("[data-message]").textContent = `Lote ${sourceLot.code} cadastrado. Informe a quantidade e gere as etiquetas.`;
      } catch (error) { panel.querySelector("[data-message]").textContent = error.message; }
      finally { button.disabled = false; }
    });
    panel.querySelector("[data-source-labels]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector("button");
      const message = panel.querySelector("[data-message]");
      button.disabled = true;
      try {
        const { batch } = await request("/batches", { sourceLot: form.elements.sourceLot.value, quantity: Number(form.elements.quantity.value) });
        message.innerHTML = `${batch.quantity} etiquetas do lote ${escape(batch.sourceLot || batch.grade)} geradas. <a href="${base}/batches/${encodeURIComponent(batch.id)}/print" target="_blank" rel="noopener">Abrir impressao 60 × 40 mm</a>`;
        await loadBatches(panel);
      } catch (error) { message.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  try { await Promise.all([loadSourceLots(panel), loadBatches(panel)]); } catch (error) { panel.querySelector("[data-message]").textContent = error.message; }
}

async function loadSourceLots(panel, selected = "") {
  const { sourceLots, suggestedCode } = await request("/source-lots");
  const form = panel.querySelector("[data-source-labels]");
  const select = form.elements.sourceLot;
  const previous = selected || select.value;
  select.innerHTML = sourceLots.length ? sourceLots.map((lot) => `<option value="${escape(lot.code)}">${escape(originLabel(lot.code))}</option>`).join("") : '<option value="">Cadastre um lote de origem</option>';
  select.value = sourceLots.some((lot) => lot.code === previous) ? previous : sourceLots.at(-1)?.code || "";
  form.querySelector("button").disabled = !sourceLots.length;
  const input = panel.querySelector("[data-new-source-lot] input");
  if (!input.value) input.value = suggestedCode || "";
}

async function loadBatches(panel) {
  const { batches } = await request("/batches");
  panel.querySelector("[data-batches]").innerHTML = `<details><summary>Emissoes anteriores (${batches.length})</summary><p class="muted">Reimprimir reutiliza os mesmos QRs; nao gera novas pecas.</p>
    <table><thead><tr><th>Data</th><th>Lote de origem</th><th>Geradas</th><th>Em pallets</th><th>Disponiveis</th><th></th></tr></thead><tbody>${batches.map((batch) => `<tr><td>${escape(date(batch.createdAt))}</td><td>${escape(originLabel(batch.sourceLot || batch.grade))}</td><td>${batch.quantity}</td><td>${batch.assigned}</td><td>${batch.quantity - batch.assigned}</td><td><a href="${base}/batches/${encodeURIComponent(batch.id)}/print" target="_blank" rel="noopener">Reimprimir</a></td></tr>`).join("")}</tbody></table></details>`;
}

export async function recordPrivateClass(lotId, codigoRz, code) {
  return request(`/lots/${encodeURIComponent(lotId)}/pallets/${encodeURIComponent(codigoRz)}`, { action: "add", code });
}

export async function mountClassPanel(container, lot, { active = null, canClose = false, openPallet } = {}) {
  if (!container || !lot.classMode) return;
  // Cada montagem tem sua propria identidade para descartar respostas de outra tela/pallet.
  let panel = container.querySelector(":scope > [data-class-panel]");
  panel?.remove();
  panel = document.createElement("section");
  panel.className = "entry-panel";
  panel.dataset.classPanel = lot.id;
  panel.innerHTML = '<h3>Composicao por lote de origem</h3><p data-message class="message">Carregando contagem...</p>';
  container.append(panel);
  const url = `/lots/${encodeURIComponent(lot.id)}`;
  try {
    const summary = await request(url);
    if (!panel.isConnected) return;
    const current = summary.pallets.find((p) => p.codigoRz === active);
    const supplier = summary.supplierSync;
    const sources = summary.sources || [];
    const counts = active ? current?.bySource || {} : summary.bySource;
    panel.innerHTML = `<h3>Composicao por lote de origem${active ? ` · ${escape(active)}` : ""}</h3>
      <p>Fornecedor: <strong>${escape(summary.supplierName || lot.fornecedor || "Nao informado")}</strong> · ${supplier?.ok ? `Confirmado no Bling (ID ${escape(supplier.supplierId)})` : `Pendente no Bling${supplier?.error ? `: ${escape(supplier.error)}` : ""}`}</p>
      ${canClose ? '<button type="button" class="ghost" data-sync-class-supplier>Sincronizar fornecedor no Bling</button>' : ""}
      <p class="muted">${active ? "Bipe o QR privado no campo abaixo ou no campo de bipagem do pallet." : "Contagem de etiquetas efetivamente colocadas nos pallets deste lote."}</p>
      <div class="summary-grid">${sources.map((source) => `<div class="metric"><span>${escape(originLabel(source))}${active ? " neste pallet" : " no agrupamento"}</span><strong>${counts[source] || 0}</strong></div>`).join("")}<div class="metric"><span>Total rastreado</span><strong>${active ? current?.total || 0 : summary.total}</strong></div></div>
      ${active ? `<form data-class-scan class="transfer-form"><label>QR privado<input name="code" autocomplete="off" required ${current?.closedAt ? "disabled" : ""}></label><label>Operacao<select name="action" ${current?.closedAt ? "disabled" : ""}><option value="add">Colocar no pallet</option><option value="remove">Retirar do pallet</option></select></label><button ${current?.closedAt ? "disabled" : ""}>Registrar QR</button></form>
      ${canClose && !current?.closedAt ? '<button type="button" data-close-class>Fechar composicao deste pallet</button>' : ""}` : ""}
      <p data-message class="message">${current?.closedAt ? `Composicao fechada em ${escape(date(current.closedAt))} por ${escape(current.closedBy?.name)}.` : ""}</p>
      <table><thead><tr><th>Pallet</th>${sources.map((source) => `<th>${escape(originLabel(source))}</th>`).join("")}<th>Total</th><th>Fechamento</th><th>Responsavel</th><th></th></tr></thead><tbody>${summary.pallets.map((p) => `<tr><td>${escape(p.codigoRz)}</td>${sources.map((source) => `<td>${p.bySource[source] || 0}</td>`).join("")}<td>${p.total}</td><td>${escape(date(p.closedAt))}</td><td>${escape(p.closedBy?.name || "")}</td><td><button type="button" class="ghost" data-class-open="${escape(p.codigoRz)}">Abrir</button></td></tr>`).join("")}</tbody><tfoot><tr><th>Total do agrupamento</th>${sources.map((source) => `<th>${summary.bySource[source]}</th>`).join("")}<th>${summary.total}</th><td colspan="3"></td></tr></tfoot></table>
      ${canClose ? `<p><a href="${base}${url}/export">Exportar composicao CSV</a></p>` : ""}
      <details><summary>Historico recente de movimentacoes</summary><ul>${summary.events.filter((e) => !active || e.codigoRz === active).map((e) => `<li>${escape(date(e.createdAt))} · ${escape(e.codigoRz)} · ${escape(({ add: "Entrada", remove: "Retirada", close: "Fechamento" })[e.action])}${e.sourceLot || e.grade ? ` · origem ${escape(originLabel(e.sourceLot || e.grade))}` : ""} · ${escape(e.code || "")} · ${escape(e.actor?.name)}</li>`).join("")}</ul></details>`;
    panel.querySelectorAll("[data-class-open]").forEach((button) => button.addEventListener("click", () => openPallet?.(button.dataset.classOpen)));
    panel.querySelector("[data-sync-class-supplier]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      panel.querySelector("[data-message]").textContent = "Consultando fornecedor no Bling...";
      try {
        await request(`${url}/supplier`, {});
        await mountClassPanel(container, lot, { active, canClose, openPallet });
      } catch (error) { panel.querySelector("[data-message]").textContent = error.message; button.disabled = false; }
    });
    const change = async (body, button) => {
      button.disabled = true;
      try {
        await request(`${url}/pallets/${encodeURIComponent(active)}`, body);
        await mountClassPanel(container, lot, { active, canClose, openPallet });
        const fresh = container.querySelector(":scope > [data-class-panel]");
        fresh?.querySelector("input[name=code]")?.focus();
      } catch (error) { panel.querySelector("[data-message]").textContent = error.message; button.disabled = false; }
    };
    panel.querySelector("[data-class-scan]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      change({ action: form.elements.action.value, code: form.elements.code.value }, form.querySelector("button"));
    });
    panel.querySelector("[data-close-class]")?.addEventListener("click", (event) => {
      if (confirm("Fechar a composicao por lote de origem? As entradas e retiradas de etiquetas deste pallet ficarao bloqueadas.")) change({ action: "close" }, event.currentTarget);
    });
  } catch (error) { if (panel.isConnected) panel.querySelector("[data-message]").textContent = error.message; }
}
