import JSZip from "jszip";

function filePart(value, fallback) {
  return String(value || fallback).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 70) || fallback;
}

// Keep the row number in every name: repeated SKUs/codes cannot overwrite photos.
export function prepareTriagePhotoExport(rows = []) {
  const zip = new JSZip();
  zip.folder("fotos");
  const photos = rows.map((row, index) => {
    const photo = String(row.item?.diagnosisPhoto || "").trim();
    if (!photo) return { file: "", status: "Sem foto" };
    let entries;
    try { entries = photo.startsWith("[") ? JSON.parse(photo) : [photo]; } catch { entries = [photo]; }
    const exported = entries.map((photo, photoIndex) => {
    const base = `${String(index + 1).padStart(5, "0")}_${filePart(row.product?.sku || row.item?.sku, "sem-sku")}_${filePart(row.item?.code, "sem-codigo")}${entries.length > 1 ? `_${photoIndex + 1}` : ""}`;
    const match = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(photo);
    if (match) {
      const extension = /^jpe?g$/i.test(match[1]) ? "jpg" : match[1].toLowerCase();
      const file = `fotos/${base}.${extension}`;
      zip.file(file, Buffer.from(match[2], "base64"));
      return { file, status: "Foto incluida" };
    }
    if (/^https?:\/\/\S+$/i.test(photo)) {
      const file = `fotos/${base}-link.txt`;
      zip.file(file, `Foto cadastrada como link externo:\r\n${photo}\r\n`);
      return { file, status: "Link externo (ver arquivo TXT)" };
    }
    return { file: "", status: "Foto invalida; nao exportada" };
    });
    return { file: exported.map(entry => entry.file).filter(Boolean).join("; "), status: [...new Set(exported.map(entry => entry.status))].join("; ") };
  });
  zip.file("LEIA-ME.txt", [
    "Extraia todo o ZIP antes de abrir a planilha.",
    "A pasta fotos contem as fotos dos laudos, identificadas por linha, SKU e codigo de triagem.",
    "As colunas ARQUIVO DA FOTO e SITUACAO DA FOTO relacionam cada item ao arquivo.",
    "As imagens ficam em arquivos separados, sem precisar extrair do Excel.",
    "Fotos cadastradas como links externos ficam em arquivos TXT com o endereco original.",
    "Itens sem foto continuam na planilha. Os filtros de periodo e lotes se aplicam a todo o pacote."
  ].join("\r\n"));
  return { zip, photos };
}
