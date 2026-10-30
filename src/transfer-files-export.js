import XLSX from "xlsx";
import { prepareTriagePhotoExport } from "./triage-photo-export.js";
import { BLING_STOCK_TRANSFER_HEADERS, buildBlingStockTransferRows } from "./domain.js";

export async function buildTransferFilesArchive(lot) {
  const items = lot.items || [];
  const bundle = prepareTriagePhotoExport(items.map((item) => ({ item: { ...item, code: item.triageCode || item.code }, product: { sku: item.sku } })));
  const workbook = XLSX.utils.book_new();
  const rows = items.map((item, index) => ({
    LOTE: lot.name,
    SKU: item.sku || "",
    ETIQUETA: item.triageCode || item.code || "",
    PRODUTO: item.descricao || "",
    QUANTIDADE: Number(item.quantidade || 0),
    LAUDO: item.diagnosis || item.diagnosisCondition || "",
    "ARQUIVO DA FOTO": bundle.photos[index].file,
    "SITUACAO DA FOTO": bundle.photos[index].status
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Itens do lote");
  if (lot.type !== "leilao") {
    const hasReceived = items.some((item) => Number(item.quantidadeConferida || 0) > 0);
    const transferItems = items.map((item) => ({ ...item, quantidade: Number(hasReceived ? item.quantidadeConferida || 0 : item.quantidade || 0) })).filter((item) => item.quantidade > 0);
    const transferRows = buildBlingStockTransferRows(transferItems, { depositoOrigem: lot.depositoOrigem, depositoDestino: lot.depositoDestino, observacao: `Transferencia ${lot.name}` });
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(transferRows, { header: BLING_STOCK_TRANSFER_HEADERS }), "Transferencia Bling");
  }
  bundle.zip.file("lote.xlsx", XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
  bundle.zip.file("LEIA-ME.txt", [
    `Arquivos do lote: ${lot.name}`,
    "Extraia todo o ZIP antes de abrir lote.xlsx.",
    "A pasta fotos contem todas as fotos cadastradas nos itens, identificadas por linha, SKU e etiqueta.",
    "As colunas ARQUIVO DA FOTO e SITUACAO DA FOTO relacionam cada item aos arquivos.",
    "Itens sem foto permanecem no Excel. Fotos cadastradas como links externos ficam em arquivos TXT com o endereco original."
  ].join("\r\n"));
  return bundle.zip.generateAsync({ type: "nodebuffer" });
}
