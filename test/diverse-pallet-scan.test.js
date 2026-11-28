import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function addDiverseItem(event)"), source.indexOf("async function loadNoSheetSuggestionMatches("));
const membership = source.slice(source.indexOf("function diverseProductBelongsToRz("), source.indexOf("function findExistingDiverseProductByDescription("));

test("manual registration from conference scanning shows the active lot's suggestions", async () => {
  const elements = new Map();
  const timers = new Map();
  const calls = [];
  const suggestion = { descricao: "Fogão Atlas Mônaco", valorUnit: 704, quantidade: 2, source: "lista_lote" };
  const missingFields = new Set(["AlturaCaixa", "LarguraCaixa", "ComprimentoCaixa", "PesoCaixa", "LocalizacaoEstoque", "Categoria", "Subcategoria", "Ncm", "DataValidade"]);
  const context = vm.createContext({
    state: { selectedDiverseLotId: null },
    $: (selector) => {
      if (missingFields.has(selector.replace("#manualProduct", ""))) return null;
      if (!elements.has(selector)) {
        const classes = new Set(["hidden"]);
        elements.set(selector, {
          value: "",
          style: {},
          classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name)
          },
          reset() {},
          focus() {},
          select() {},
          closest: () => null
        });
      }
      return elements.get(selector);
    },
    window: {
      setTimeout: (callback, delay) => (timers.set(delay, callback), delay),
      clearTimeout: (delay) => timers.delete(delay)
    },
    setTimeout() {},
    normalizeConferenceSettings: () => ({ ncmByCategory: [] }),
    isConferenceFieldEnabled: () => false,
    findManualProductInitialValues: async () => ({}),
    escapeHtml: String,
    money: String,
    parseMoneyInput: Number,
    api: async (url) => {
      calls.push(url);
      return { suggestions: [suggestion] };
    }
  });
  const suggestions = source.slice(source.indexOf("async function loadNoSheetSuggestionMatches("), source.indexOf("function diverseProductBelongsToRz("));
  const prompt = source.slice(source.indexOf("function promptManualProduct("), source.indexOf("async function findManualProductInitialValues("));
  const modal = source.slice(source.indexOf("function askManualProduct("), source.indexOf("function openDecisionModal("));
  const conference = source.slice(source.indexOf("async function createManualExternalExcessFromScan("), source.indexOf("async function decrementCurrent("));
  vm.runInContext(suggestions + prompt + modal + conference, context);

  const pending = context.createManualExternalExcessFromScan("bumper-jz", "PALLET-1", "UNKNOWN");
  await new Promise((resolve) => setImmediate(resolve));
  const description = elements.get("#manualProductDescription");
  description.value = "atlas";
  description.oninput();
  await timers.get(220)();

  assert.deepEqual(calls, ["/api/lots/bumper-jz/no-sheet-suggestions?q=atlas"]);
  const menu = elements.get("#manualProductDescriptionSuggestions");
  assert.equal(menu.classList.contains("hidden"), false);
  assert.match(menu.innerHTML, /Fogão Atlas Mônaco/);
  assert.match(menu.innerHTML, /Lista do lote/);
  elements.get("#manualProductCancel").onclick();
  await pending;
});

test("an imported pallet uses conference scanning inside a lot without a spreadsheet", () => {
  const routing = source.slice(source.indexOf("function isNoSheetLot("), source.indexOf("function renderDiverseRzControls("));
  const itemType = source.slice(source.indexOf("function isNoSheetItem("), source.indexOf("function isDiversePanelItem("));
  const context = vm.createContext({
    normalizeCode: (value) => String(value || "").trim().toUpperCase()
  });
  vm.runInContext(routing + itemType, context);

  const imported = { codigoRz: "RZ-001", tipoItem: "esperado", qtdEsperada: 124 };
  const lot = {
    tipoCusto: "variable",
    percentualArremate: 0,
    items: [
      imported,
      { codigoRz: "RZ-001", tipoItem: "lote_sem_planilha_manual", qtdEsperada: 0 },
      { codigoRz: "BAG-002", tipoItem: "lote_sem_planilha", qtdEsperada: 0 }
    ]
  };
  assert.equal(context.usesPalletProductionPage(lot, "RZ-001"), false);
  imported.tipoItem = "excedente_outro_rz";
  assert.equal(context.usesPalletProductionPage(lot, "RZ-001"), false);
  assert.equal(context.usesPalletProductionPage(lot, "BAG-002"), true);
  assert.equal(context.usesPalletProductionPage(lot, "BAG-003"), true);
});

async function scan({ activePallet, byDescription = false, privateLabel = false, classLot = privateLabel, simultaneous = false }) {
  const product = { id: "product-1", codigoMl: "ML1", sku: "SKU1" };
  const lot = { id: "lot-1", classMode: classLot, products: [product], items: [{ productId: product.id, codigoRz: "PALLET-1", qtdConferida: 3 }] };
  const calls = [];
  const input = { value: "ML1", select() {} };
  const button = { disabled: false };
  const message = { textContent: "", style: {} };
  const context = vm.createContext({
    state: { selectedDiverseLotId: lot.id, selectedDiverseLot: lot, selectedDiverseRz: activePallet, labelOptions: {} },
    $: () => message,
    normalizeCode: (value) => String(value || "").trim().toUpperCase(),
    normalizeCodigoMl: (value) => value,
    isPrivateClassCode: () => privateLabel,
    recordPrivateClass: async (...args) => calls.push({ action: "private_class", args }),
    refreshPrivateClasses() {},
    playScanFeedback() {},
    previewDiverseItem: async () => {
      if (byDescription) throw Object.assign(new Error("manual"), { code: "manual_required" });
      return { status: "preview_existing", product, lot };
    },
    findNoSheetSuggestionForProduct: async () => ({ quantidade: 5 }),
    manualSuggestionQuantityValue: (suggestion) => suggestion.quantidade,
    addDiverseQuantity: async (...args) => calls.push({ action: "increment", args }),
    createDiverseItem: async (payload) => {
      calls.push({ action: "create", payload });
      return { lot, product };
    },
    refreshLotsList: async () => {},
    schedulePrimaryInputFocus() {},
    renderDiverseLot() {},
    showDiverseBlingSyncStatus: async () => {},
    diverseScanStatusMessage: () => "ok",
    findManualProductInitialValues: async () => ({}),
    promptManualProduct: async () => ({ descricao: "Produto", quantidade: 5 }),
    findExistingDiverseProductByDescription: () => product,
    askProductAlreadyRegistered: async () => "use_existing"
  });
  vm.runInContext(membership + handler, context);
  const event = { preventDefault() {}, currentTarget: { querySelector: (selector) => selector === "button" ? button : input } };
  const pending = context.addDiverseItem(event);
  if (simultaneous) await context.addDiverseItem(event);
  await pending;
  assert.equal(message.textContent, privateLabel && classLot ? "Etiqueta registrada na composicao por origem do pallet." : "");
  assert.equal(button.disabled, false);
  return calls;
}

test("existing ML on a new pallet creates its suggested quantity with the existing SKU", async () => {
  const calls = await scan({ activePallet: "PALLET-2" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "create");
  assert.equal(calls[0].payload.codigoRz, "PALLET-2");
  assert.equal(calls[0].payload.codigoMl, "ML1");
  assert.equal(calls[0].payload.quantidade, 5);
  assert.equal(calls[0].payload.allowDuplicate, true);
});

test("existing ML on the same pallet increments one unit", async () => {
  const calls = await scan({ activePallet: "PALLET-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "increment");
});

test("private class QR records composition without creating product or changing stock", async () => {
  const calls = await scan({ activePallet: "PALLET-1", privateLabel: true });
  assert.deepEqual(calls, [{ action: "private_class", args: ["lot-1", "PALLET-1", "ML1"] }]);
});

test("simultaneous submissions of a fresh class QR send only one registration", async () => {
  const calls = await scan({ activePallet: "PALLET-1", privateLabel: true, simultaneous: true });
  assert.deepEqual(calls, [{ action: "private_class", args: ["lot-1", "PALLET-1", "ML1"] }]);
});

test("normal lots keep their product scan flow even for codes that look like private QRs", async () => {
  const calls = await scan({ activePallet: "PALLET-1", privateLabel: true, classLot: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "increment");
});

test("using an existing product by description on a new pallet preserves the requested quantity", async () => {
  const calls = await scan({ activePallet: "PALLET-2", byDescription: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "create");
  assert.equal(calls[0].payload.codigoMl, "ML1");
  assert.equal(calls[0].payload.manualProduct, null);
  assert.equal(calls[0].payload.quantidade, 5);
  assert.equal(calls[0].payload.allowDuplicate, true);
});
