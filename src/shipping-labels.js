import { PDFDocument, rgb } from "pdf-lib";

const MM_TO_PT = 72 / 25.4;
const LABEL = { width: 100 * MM_TO_PT, height: 150 * MM_TO_PT };

// Mesmo recorte do JZ Transfer: o PDF do Bling (Mercado Envios) traz a etiqueta de envio
// a esquerda e a DANFE simplificada a direita. A etiqueta ocupa a 10x15 e o topo da
// DANFE (faixa com a chave de acesso) vai para a base.
export async function buildShippingLabelWithDanfeKey(pdfBuffer) {
  const source = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const firstPage = source.getPage(0);
  const { width, height } = firstPage.getSize();
  const sourceLabelWidth = Math.min(LABEL.width, width / 2);
  const sourceLabelHeight = Math.min(LABEL.height, height);
  const sourceGap = 3 * MM_TO_PT;
  const top = height;
  const labelBottom = top - sourceLabelHeight;

  const output = await PDFDocument.create();
  const page = output.addPage([LABEL.width, LABEL.height]);
  page.drawRectangle({ x: 0, y: 0, width: LABEL.width, height: LABEL.height, color: rgb(1, 1, 1) });

  const shippingLabel = await output.embedPage(firstPage, {
    left: 0,
    bottom: labelBottom,
    right: sourceLabelWidth,
    top
  });
  const danfeKeyHeight = 44 * MM_TO_PT;
  const danfeLeft = sourceLabelWidth + sourceGap;
  const danfeStrip = await output.embedPage(firstPage, {
    left: danfeLeft,
    bottom: top - Math.min(danfeKeyHeight, sourceLabelHeight),
    right: Math.min(danfeLeft + sourceLabelWidth, width),
    top
  });

  const marginX = 0.4 * MM_TO_PT;
  const marginTop = 0.2 * MM_TO_PT;
  const stripHeight = 28 * MM_TO_PT;
  const labelWidth = LABEL.width - marginX * 2;
  const labelMaxHeight = LABEL.height - stripHeight - marginTop - 0.5 * MM_TO_PT;
  const labelHeight = Math.min(labelMaxHeight, labelWidth * (sourceLabelHeight / sourceLabelWidth));

  page.drawPage(shippingLabel, {
    x: (LABEL.width - labelWidth) / 2,
    y: stripHeight + 0.5 * MM_TO_PT,
    width: labelWidth,
    height: labelHeight
  });
  const stripWidth = 96 * MM_TO_PT;
  page.drawPage(danfeStrip, {
    x: (LABEL.width - stripWidth) / 2,
    y: 0.8 * MM_TO_PT,
    width: stripWidth,
    height: stripHeight
  });

  return Buffer.from(await output.save());
}

export function buildShippingLabelPrintPage({ title, pdfUrl }) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { width: 100%; min-height: 100%; margin: 0; background: #fff; }
      body { display: grid; place-items: center; }
      canvas { display: block; width: 100mm; height: 150mm; max-width: 100vw; max-height: 100vh; background: #fff; }
      .status {
        position: fixed; left: 12px; bottom: 12px; z-index: 2; max-width: calc(100vw - 24px);
        border: 1px solid #ddd; border-radius: 6px; background: rgba(255, 255, 255, 0.96); color: #333;
        font: 13px/1.4 Arial, sans-serif; padding: 8px 10px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.10);
      }
      .status button { margin-left: 8px; border: 1px solid #222; border-radius: 4px; background: #222; color: #fff; font: inherit; padding: 4px 8px; cursor: pointer; }
      @page { size: 100mm 150mm; margin: 0; }
      @media print {
        html, body { width: 100mm; height: 150mm; margin: 0; overflow: hidden; display: block; }
        canvas { width: 100mm; height: 150mm; max-width: none; max-height: none; }
        .status { display: none; }
      }
    </style>
  </head>
  <body>
    <canvas id="etiqueta" width="1181" height="1772" aria-label="${escapeHtml(title)}"></canvas>
    <div id="status" class="status">Renderizando etiqueta...</div>
    <script type="module">
      import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

      const pdfUrl = ${JSON.stringify(pdfUrl)};
      const canvas = document.getElementById("etiqueta");
      const ctx = canvas.getContext("2d", { alpha: false });
      const statusEl = document.getElementById("status");
      let tried = false;

      const ready = () => {
        statusEl.innerHTML = "Etiqueta pronta. <button type='button' id='printAgain'>Imprimir</button>";
        document.getElementById("printAgain").onclick = () => { tried = false; print(); };
      };
      const print = () => {
        if (tried) return;
        tried = true;
        statusEl.textContent = "Abrindo impressao...";
        try {
          window.focus();
          window.print();
        } finally {
          setTimeout(ready, 1200);
        }
      };

      try {
        const pdf = await pdfjsLib.getDocument({ url: pdfUrl, disableAutoFetch: true, disableStream: true }).promise;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.max(canvas.width / base.width, canvas.height / base.height) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        statusEl.textContent = "Etiqueta pronta. Preparando impressao...";
        setTimeout(print, 700);
      } catch (error) {
        statusEl.textContent = "Nao foi possivel renderizar a etiqueta: " + (error?.message || error);
      }
    </script>
  </body>
</html>`;
}

// Relatorio de produtos coletados da venda direta: impresso em A4 e grampeado no pedido.
export function buildPickingReportPage({ order, printedBy = "", printedAt = new Date() }) {
  const items = order.items || [];
  const picks = order.picks || [];
  const formatDate = (value) => new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const positionsFor = (item) => [...new Set(picks.filter((pick) => pick.itemId === item.id).map((pick) => pick.wmsLocation).filter(Boolean))].join(", ");
  const rows = items.map((item) => `
        <tr>
          <td>${escapeHtml(item.sku || "")}</td>
          <td>${escapeHtml(item.codigoMl || "")}</td>
          <td>${escapeHtml(item.descricao || "")}</td>
          <td class="num">${Number(item.quantidade || 0)}</td>
          <td class="num">${Number(item.quantidadeSeparada || 0)}</td>
          <td>${escapeHtml(positionsFor(item))}</td>
          <td class="check"></td>
        </tr>`).join("");
  const totalQty = items.reduce((sum, item) => sum + Number(item.quantidade || 0), 0);
  const totalPicked = items.reduce((sum, item) => sum + Number(item.quantidadeSeparada || 0), 0);
  const lastPick = picks.map((pick) => pick.createdAt).filter(Boolean).sort().at(-1);
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Relatorio de coleta - Pedido ${escapeHtml(order.pedidoNumero)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      @page { size: A4; margin: 12mm; }
      body { font: 12px/1.4 Arial, sans-serif; color: #111; margin: 0; padding: 16px; background: #fff; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 24px; margin: 8px 0 14px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #333; padding: 5px 6px; text-align: left; vertical-align: top; }
      th { background: #eee; font-size: 11px; text-transform: uppercase; }
      .num { text-align: right; white-space: nowrap; }
      .check { width: 32px; }
      tfoot td { font-weight: bold; }
      .sign { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; margin-top: 36px; }
      .sign div { border-top: 1px solid #111; padding-top: 4px; }
      .actions { margin-bottom: 12px; }
      @media print { .actions { display: none; } body { padding: 0; } }
    </style>
  </head>
  <body>
    <div class="actions"><button type="button" onclick="window.print()">Imprimir</button></div>
    <h1>Relatorio de produtos coletados</h1>
    <div class="meta">
      <span><strong>Pedido:</strong> ${escapeHtml(order.pedidoNumero)}</span>
      <span><strong>Loja:</strong> ${escapeHtml(order.lojaNome || "")}</span>
      <span><strong>Deposito WMS:</strong> ${escapeHtml(order.wmsDepositName || "")}</span>
      <span><strong>Coleta concluida:</strong> ${lastPick ? escapeHtml(formatDate(lastPick)) : "-"}</span>
      <span><strong>Impresso por:</strong> ${escapeHtml(printedBy)}</span>
      <span><strong>Impresso em:</strong> ${escapeHtml(formatDate(printedAt))}</span>
    </div>
    <table>
      <thead>
        <tr><th>SKU</th><th>Cod ML / ASIN</th><th>Descricao</th><th class="num">Pedido</th><th class="num">Coletado</th><th>Posicao WMS</th><th>Conf.</th></tr>
      </thead>
      <tbody>${rows}
      </tbody>
      <tfoot>
        <tr><td colspan="3">${items.length} item(ns)</td><td class="num">${totalQty}</td><td class="num">${totalPicked}</td><td colspan="2"></td></tr>
      </tfoot>
    </table>
    <div class="sign"><div>Conferido por</div><div>Data</div></div>
    <script>window.addEventListener("load", () => setTimeout(() => window.print(), 300));</script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
