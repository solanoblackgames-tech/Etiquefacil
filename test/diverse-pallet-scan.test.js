import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function addDiverseItem(event)"), source.indexOf("async function loadNoSheetSuggestionMatches("));
const membership = source.slice(source.indexOf("function diverseProductBelongsToRz("), source.indexOf("function findExistingDiverseProductByDescription("));

async function scan({ activePallet, byDescription = false }) {
  const product = { id: "product-1", codigoMl: "ML1", sku: "SKU1" };
  const lot = { id: "lot-1", products: [product], items: [{ productId: product.id, codigoRz: "PALLET-1", qtdConferida: 3 }] };
  const calls = [];
  const input = { value: "ML1", select() {} };
  const button = { disabled: false };
  const message = { textContent: "", style: {} };
  const context = vm.createContext({
    state: { selectedDiverseLotId: lot.id, selectedDiverseLot: lot, selectedDiverseRz: activePallet, labelOptions: {} },
    $: () => message,
    normalizeCode: (value) => String(value || "").trim().toUpperCase(),
    normalizeCodigoMl: (value) => value,
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
  await context.addDiverseItem({ preventDefault() {}, currentTarget: { querySelector: (selector) => selector === "button" ? button : input } });
  assert.equal(message.textContent, "");
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

test("using an existing product by description on a new pallet preserves the requested quantity", async () => {
  const calls = await scan({ activePallet: "PALLET-2", byDescription: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "create");
  assert.equal(calls[0].payload.codigoMl, "ML1");
  assert.equal(calls[0].payload.manualProduct, null);
  assert.equal(calls[0].payload.quantidade, 5);
  assert.equal(calls[0].payload.allowDuplicate, true);
});
