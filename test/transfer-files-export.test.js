import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import XLSX from "xlsx";
import { buildTransferFilesArchive } from "../src/transfer-files-export.js";

test("lot archive matches every photo to its Excel row, including repeated SKUs and missing photos", async () => {
  const photo = "data:image/png;base64,YWJj";
  const lot = { name: "Lote 1", type: "leilao", items: [
    { sku: "SKU/1", triageCode: "LAB-1", descricao: "Produto 1", quantidade: 1, diagnosisCondition: "Avariado", diagnosisPhoto: JSON.stringify([photo, photo]) },
    { sku: "SKU/1", triageCode: "LAB-2", descricao: "Produto 2", quantidade: 2, diagnosisPhoto: photo },
    { sku: "SKU-2", quantidade: 1 }
  ] };
  const zip = await JSZip.loadAsync(await buildTransferFilesArchive(lot));
  const workbook = XLSX.read(await zip.file("lote.xlsx").async("nodebuffer"));
  assert.deepEqual(workbook.SheetNames, ["Itens do lote"]);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Itens do lote"]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ETIQUETA, "LAB-1");
  assert.equal(rows[0].LAUDO, "Avariado");
  const files = rows.slice(0, 2).flatMap((row) => row["ARQUIVO DA FOTO"].split("; "));
  assert.equal(new Set(files).size, 3);
  for (const file of files) assert.equal(await zip.file(file).async("string"), "abc");
  assert.equal(rows[2]["SITUACAO DA FOTO"], "Sem foto");
  assert.ok(zip.files["fotos/"].dir);
});

test("transfer archive keeps Bling export in a separate worksheet", async () => {
  const zip = await JSZip.loadAsync(await buildTransferFilesArchive({ name: "Transferencia", type: "transferencia", depositoOrigem: "CD", depositoDestino: "Loja", items: [{ sku: "SKU", descricao: "Produto", quantidade: 3, quantidadeConferida: 2 }] }));
  const workbook = XLSX.read(await zip.file("lote.xlsx").async("nodebuffer"));
  assert.deepEqual(workbook.SheetNames, ["Itens do lote", "Transferencia Bling"]);
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets["Itens do lote"])[0].QUANTIDADE, 3);
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets["Transferencia Bling"]).length, 1);
});
