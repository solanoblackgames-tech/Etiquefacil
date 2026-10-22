import { syncBlingSupplier } from "./bling-api.js";
import { registerPrivateClassLot, withClassState } from "./private-class-labels.js";

// A falha do Bling fica registrada sem desfazer a criacao do lote ou suas bipagens.
export async function syncClassLotSupplier({ userId, lot, getCredentials, saveIntegration, withState = withClassState, syncSupplier = syncBlingSupplier }) {
  let result;
  try {
    const supplier = await syncSupplier({ integration: await getCredentials(userId), name: lot.fornecedor, saveIntegration });
    result = { ok: true, supplierId: supplier.id, name: supplier.name, attemptedAt: new Date().toISOString() };
  } catch (error) {
    result = { ok: false, name: lot.fornecedor, error: error.message, attemptedAt: new Date().toISOString() };
  }
  await withState(userId, (state) => {
    registerPrivateClassLot(state, lot, null);
    state.classLots.find((item) => item.id === lot.id).supplierSync = result;
  });
  return result;
}
