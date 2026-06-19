import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalogRows } from "../src/catalog.js";

test("parseCatalogRows imports Bling-like catalog using Marca as ML code", () => {
  const products = parseCatalogRows([
    ["Codigo", "Descricao", "Preco", "Preco de custo", "Marca", "Categoria"],
    ["SKU-OLD", "Produto catalogo", "1.234,56", "123,45", "ML123", "Auto"]
  ]);

  assert.deepEqual(products, [
    {
      codigoMl: "ML123",
      descricao: "Produto catalogo",
      valorUnit: 1234.56,
      precoCusto: 123.45,
      categoria: "Auto",
      subcategoria: "",
      ean: "",
      foto: "",
      link: ""
    }
  ]);
});

test("parseCatalogRows imports optional EAN image URL and link", () => {
  const products = parseCatalogRows([
    ["Marca", "Descricao", "Preco", "EAN", "URL Imagens Externas", "Link Externo"],
    ["ML123", "Produto catalogo", "10,00", "7891234567890", "https://img.example/produto.jpg", "https://example/produto"]
  ]);

  assert.equal(products[0].ean, "7891234567890");
  assert.equal(products[0].foto, "https://img.example/produto.jpg");
  assert.equal(products[0].link, "https://example/produto");
});
