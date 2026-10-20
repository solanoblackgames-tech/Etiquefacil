import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import XLSX from "xlsx";
import { prepareTriagePhotoExport } from "../src/triage-photo-export.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("ZIP preserves original photo bytes and unique item names alongside the workbook", async () => {
  const row = { product: { sku: "TV/123" }, item: { code: "../../TRI-1", diagnosisPhoto: `data:image/png;base64,${png.toString("base64")}` } };
  const { zip, photos } = prepareTriagePhotoExport([row, row, { item: {} }]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(photos), "Triagem");
  zip.file("triagem.xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const archive = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
  assert.notEqual(photos[0].file, photos[1].file);
  assert.match(photos[0].file, /^fotos\/00001_TV_123__+TRI-1\.png$/);
  for (const photo of photos.slice(0, 2)) {
    assert.deepEqual(await archive.file(photo.file).async("nodebuffer"), png);
    assert.equal(photo.status, "Foto incluida");
  }
  assert.deepEqual(photos[2], { file: "", status: "Sem foto" });
  const downloaded = XLSX.read(await archive.file("triagem.xlsx").async("nodebuffer"));
  assert.equal(XLSX.utils.sheet_to_json(downloaded.Sheets.Triagem)[0].file, photos[0].file);
});

test("ZIP distinguishes external links, invalid photos and missing photos", async () => {
  const { zip, photos } = prepareTriagePhotoExport([
    { item: { diagnosisPhoto: "https://example.com/foto.jpg" } },
    { item: { diagnosisPhoto: "invalid" } },
    { item: { diagnosisPhoto: "data:image/webp;base64,YWJj" } },
    { item: { diagnosisPhoto: "data:image/jpeg;base64,YWJj" } }
  ]);
  assert.match(photos[0].status, /Link externo/);
  assert.match(await zip.file(photos[0].file).async("string"), /https:\/\/example.com\/foto.jpg/);
  assert.equal(photos[1].file, "");
  assert.match(photos[1].status, /invalida/);
  assert.match(photos[2].file, /\.webp$/);
  assert.match(photos[3].file, /\.jpg$/);
});

test("empty exports still contain the photos folder and instructions", async () => {
  const { zip, photos } = prepareTriagePhotoExport([]);
  const archive = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual(photos, []);
  assert.ok(archive.files["fotos/"].dir);
  assert.ok(archive.file("LEIA-ME.txt"));
});
