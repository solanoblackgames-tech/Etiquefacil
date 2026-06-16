import path from "node:path";
import "dotenv/config";
import { readCatalogWorkbook } from "../src/catalog.js";
import { closePgPool, replaceCatalogProducts } from "../src/store.js";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Uso: npm run import:catalog -- C:\\caminho\\catalogo.xlsx");
  process.exit(1);
}

try {
  const absolutePath = path.resolve(filePath);
  const products = readCatalogWorkbook(absolutePath);
  const result = await replaceCatalogProducts(products);
  console.log(`Base oculta importada com ${result.count} produto(s).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closePgPool();
}
