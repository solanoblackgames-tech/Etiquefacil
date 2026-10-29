import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const code = "LAB-20261029-000001";
const lot = {
  id: "transfer-1", source: "triage", wmsEnabled: true, wmsPrefix: "B2B",
  depositoDestino: "VENDA B2B", totalPlanned: 1, totalReceived: 0, totalPending: 1,
  items: [{ sku: "SKU1", codigoMl: "ML1", descricao: "Televisao", triageCode: code, quantidade: 1, quantidadeConferida: 0 }]
};

function setup({ selected = true, failure = false } = {}) {
  const nodes = {};
  const calls = [];
  const focuses = [];
  const node = (selector) => nodes[selector] ||= {
    value: "", disabled: false, style: {}, innerHTML: "", textContent: "",
    classList: { remove() {}, add() {} },
    addEventListener(event, listener) { this[event] = listener; },
    querySelector(selector) { return node(selector); }, select() {}
  };
  node("#transferReceiveInput").value = code;
  node("#transferWmsLocationInput").value = "RUA B | POSICAO 174 | ANDAR 2";
  const state = {
    transferReceiveOnly: true, transferReceivePublic: false,
    transferWmsLaudo: selected ? { transferLotId: lot.id, code } : null,
    pendingTransferConfirmation: null, pendingTransferReceive: false
  };
  const context = vm.createContext({
    state, $: node, URL, URLSearchParams,
    document: { body: node("body"), querySelector: node },
    window: { location: { href: `https://example.test/transferencias/${lot.id}/wms?laudo=${code}`, search: `?laudo=${code}` },
      history: { replaceState(...args) { calls.push({ action: "history", url: args[2] }); } } },
    normalizeCode: value => String(value || "").trim().toUpperCase(),
    code39BarcodeValue: value => value,
    escapeHtml: value => String(value ?? "").replaceAll('"', "&quot;"),
    userCanAcceptTransfer: () => true,
    transferStatusLabel: () => "Pendente", transferReleasedIconMarkup: () => "",
    transferStatusClass: () => "", metric: () => "", transferDivergenceReportPanel: () => "",
    transferReceiveAllRows: () => "", transferPendingConfirmation: () => "CONFIRMAR NOVAMENTE",
    schedulePrimaryInputFocus: selectors => focuses.push(selectors[0]),
    playTransferReadSound() {}, playTransferSuccessSound() {}, playTransferErrorSound() {},
    showWmsPlacementSuggestion() {}, stopTransferCamera() {},
    api: async (url, options) => {
      calls.push({ action: "api", url, body: options ? JSON.parse(options.body) : null });
      if (failure) throw new Error("Posicao invalida");
      return { lot: { ...lot, totalPending: 0, totalReceived: 1 }, item: lot.items[0] };
    },
    renderTransferReceivePage: (next) => calls.push({ action: "render", lot: next })
  });
  const functions = ["findTransferReceiveItem", "transferReceiveApiBase", "wmsLocationPlaceholder",
    "renderTransferWmsEntryPage", "prepareTransferReceiveConfirmation", "confirmTransferReceiveCurrent",
    "transferReceivePath", "triageTransferSummaryMarkup", "showTransferReceiveOnly"];
  vm.runInContext(functions.map(functionSource).join("\n"), context);
  return { context, state, node, calls, focuses };
}

test("accepting from a laudo carries its exact code to WMS and preserves other transfer links", () => {
  const { context } = setup();
  const transfer = { ...lot, status: "waiting_store" };
  const html = context.triageTransferSummaryMarkup(transfer, code);
  assert.ok(html.includes(`/transferencias/transfer-1/wms?laudo=${code}`));
  assert.ok(html.includes("Aceitar transferencia"));
  const ordinary = context.triageTransferSummaryMarkup({ ...transfer, wmsEnabled: false }, code);
  assert.ok(!ordinary.includes("?laudo="));
  assert.ok(ordinary.includes("Aceitar entrada fisica"));
});

test("the selected laudo asks only for position and OK, with virtual keyboard disabled", () => {
  const { context, node, focuses } = setup();
  context.renderTransferWmsEntryPage(lot);
  const html = node("#transferDetail").innerHTML;
  assert.ok(html.includes(`type="hidden" value="${code}"`));
  assert.ok(!html.includes("Bipe LAB, SKU"));
  assert.match(html, /id="transferWmsLocationInput"[^>]*inputmode="none"/);
  assert.ok(html.includes('type="submit">OK</button>'));
  assert.equal(focuses.at(-1), "#transferWmsLocationInput");
});

test("opening the WMS link retains the laudo without receiving any product yet", async () => {
  const { context, state, calls } = setup({ selected: false });
  await context.showTransferReceiveOnly({ transferLotId: lot.id, publicAccess: false });
  assert.equal(state.transferWmsLaudo.code, code);
  assert.equal(state.transferWmsLaudo.transferLotId, lot.id);
  assert.equal(calls.filter(call => call.action === "api" && call.body).length, 0);
  context.window.location.search = "";
  await context.showTransferReceiveOnly({ transferLotId: lot.id, publicAccess: false });
  assert.equal(state.transferWmsLaudo, null);
});

test("one OK submits the original laudo once without another confirmation", async () => {
  const { context, state, calls } = setup();
  context.prepareTransferReceiveConfirmation(lot, { confirmImmediately: true });
  context.prepareTransferReceiveConfirmation(lot, { confirmImmediately: true });
  await new Promise(resolve => setImmediate(resolve));
  const requests = calls.filter(call => call.action === "api");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/transfer-lots/transfer-1/receive-scan");
  assert.deepEqual(requests[0].body, { code, wmsLocation: "RUA B | POSICAO 174 | ANDAR 2" });
  assert.equal(state.transferWmsLaudo, null);
  assert.equal(state.pendingTransferConfirmation, null);
  assert.equal(state.pendingTransferReceive, false);
  assert.equal(calls.find(call => call.action === "history").url, "/transferencias/transfer-1/wms");
});

test("a rejected position keeps the product and enables a new position attempt", async () => {
  const { context, state, node, calls, focuses } = setup({ failure: true });
  context.prepareTransferReceiveConfirmation(lot, { confirmImmediately: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.transferWmsLaudo.code, code);
  assert.equal(node("#transferReceiveInput").value, code);
  assert.equal(node("#transferWmsLocationInput").disabled, false);
  assert.equal(node("#transferReceiveMessage").textContent, "Posicao invalida");
  assert.equal(focuses.at(-1), "#transferWmsLocationInput");
  assert.equal(state.pendingTransferConfirmation, null);
  assert.ok(!calls.some(call => call.action === "history"));
});

test("missing position does not submit, and a laudo outside the remessa is not preselected", () => {
  const { context, node, state, calls } = setup();
  node("#transferWmsLocationInput").value = "";
  context.prepareTransferReceiveConfirmation(lot, { confirmImmediately: true });
  assert.ok(!calls.some(call => call.action === "api"));
  state.transferWmsLaudo.code = "LAB-20261029-999999";
  context.renderTransferWmsEntryPage(lot);
  assert.ok(!node("#transferDetail").innerHTML.includes('type="submit">OK</button>'));
  assert.match(node("#transferDetail").innerHTML, /id="transferReceiveInput"[^>]*inputmode="none"/);
  assert.ok(node("#transferReceiveMessage").textContent.includes("nao esta pendente"));
});
