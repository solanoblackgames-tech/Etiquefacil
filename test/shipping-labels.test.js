import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { getBlingShippingLabelPdf, listBlingSalesChannels } from "../src/bling-api.js";
import { buildShippingLabelPrintPage, buildShippingLabelWithDanfeKey } from "../src/shipping-labels.js";

const MM_TO_PT = 72 / 25.4;

// PDF no formato do Bling para Mercado Envios: etiqueta a esquerda, DANFE simplificada a direita.
async function sampleBlingLabelPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([210 * MM_TO_PT, 150 * MM_TO_PT]);
  page.drawText("ETIQUETA", { x: 20, y: 380 });
  page.drawText("DANFE", { x: 320, y: 380 });
  return Buffer.from(await doc.save());
}

function jsonResponse(payload, status = 200) {
  return { ok: status < 400, status, headers: new Headers(), json: async () => payload };
}

test("shipping label becomes a single 10x15 page with the DANFE key strip", async () => {
  const output = await PDFDocument.load(await buildShippingLabelWithDanfeKey(await sampleBlingLabelPdf()));
  const pages = output.getPages();

  assert.equal(pages.length, 1);
  const { width, height } = pages[0].getSize();
  assert.equal(Math.round(width / MM_TO_PT), 100);
  assert.equal(Math.round(height / MM_TO_PT), 150);
});

test("shipping label print page renders the PDF with pdf.js and prints 100x150", () => {
  const html = buildShippingLabelPrintPage({ title: "Etiqueta pedido <1>", pdfUrl: "/api/x.pdf" });

  assert.match(html, /\/vendor\/pdfjs\/pdf\.mjs/);
  assert.match(html, /@page \{ size: 100mm 150mm; margin: 0; \}/);
  assert.match(html, /"\/api\/x\.pdf"/);
  assert.equal(html.includes("<1>"), false);
});

test("Bling shipping label downloads the PDF from the logistics link", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const pdf = await sampleBlingLabelPdf();
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/logisticas/etiquetas")) return jsonResponse({ data: [{ id: 101, link: "https://storage.example/etiqueta.pdf", observacao: "" }] });
    if (href === "https://storage.example/etiqueta.pdf") return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => pdf };
    throw new Error(`URL inesperada ${href}`);
  };

  try {
    const content = await getBlingShippingLabelPdf({ integration: { accessToken: "token" }, blingPedidoId: "101" });

    assert.equal(content.subarray(0, 4).toString("latin1"), "%PDF");
    assert.equal(calls[0].includes("formato=PDF"), true);
    assert.equal(calls[0].includes("idsVendas%5B%5D=101"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bling shipping label explains when Mercado Livre has not released it yet", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ data: [{ id: 101, link: "", observacao: "Etiqueta disponivel em 2026-10-14" }] });
  try {
    await assert.rejects(
      () => getBlingShippingLabelPdf({ integration: { accessToken: "token" }, blingPedidoId: "101" }),
      /Aguardando liberacao da etiqueta\. Disponivel em: 14\/10\/2026/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bling sales channels list the account stores for expedition", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ data: [
    { id: 203, descricao: "Mercado Livre", tipo: "MercadoLivre", situacao: 1 },
    { id: 204, descricao: "Venda atacado", tipo: "Api", situacao: 1 },
    { id: 0, descricao: "Sem loja" }
  ] });
  try {
    const channels = await listBlingSalesChannels({ integration: { accessToken: "token" } });

    assert.deepEqual(channels.map((channel) => [channel.id, channel.name]), [["203", "Mercado Livre"], ["204", "Venda atacado"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("picking report lists collected products with WMS positions for direct sales", async () => {
  const { buildPickingReportPage } = await import("../src/shipping-labels.js");
  const html = buildPickingReportPage({
    order: {
      pedidoNumero: "30001",
      lojaNome: "Venda atacado",
      wmsDepositName: "Ecommerce",
      items: [{ id: "i1", sku: "SKU-SOM", codigoMl: "MLB9", descricao: "Caixa <som>", quantidade: 2, quantidadeSeparada: 2 }],
      picks: [
        { itemId: "i1", wmsLocation: "ECOM-A-3-2", createdAt: "2026-10-13T12:00:00.000Z" },
        { itemId: "i1", wmsLocation: "ECOM-A-3-3", createdAt: "2026-10-13T12:01:00.000Z" }
      ]
    },
    printedBy: "Operador",
    printedAt: new Date("2026-10-13T12:05:00.000Z")
  });

  assert.match(html, /Relatorio de produtos coletados/);
  assert.match(html, /Pedido:<\/strong> 30001/);
  assert.match(html, /ECOM-A-3-2, ECOM-A-3-3/);
  assert.match(html, /Caixa &lt;som&gt;/);
  assert.match(html, /@page \{ size: A4/);
});
