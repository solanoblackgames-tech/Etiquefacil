// Sinais de revisao das sugestoes do banco historico.
// Um double check agrupa cadastros com o mesmo Codigo ML; aqui medimos se esses cadastros
// concordam entre si para separar o que pode ser aprovado em massa do que exige atencao.
// O resultado e deterministico e serve tanto para a tela do back office quanto para um
// agente que futuramente aprove/reprove a partir destes sinais.

export const CATALOG_REVIEW_STATUSES = ["concordante", "revisar", "divergente", "unico"];

const CONCORDANT_TEXT_SIMILARITY = 0.8;
const DIVERGENT_TEXT_SIMILARITY = 0.25;
const CONCORDANT_PRICE_DELTA = 0.15;
const DIVERGENT_PRICE_RATIO = 2;
const MIN_DESCRIPTION_TOKENS = 2;

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "e", "em", "com", "para", "por", "a", "o", "as", "os", "um", "uma",
  "no", "na", "nos", "nas", "ao", "kit", "novo", "nova", "original", "produto", "unidade", "un", "und"
]);

const UNIT_ALIASES = {
  v: "v", volts: "v", volt: "v",
  w: "w", watts: "w",
  ml: "ml", l: "l", lt: "l", litro: "l", litros: "l",
  g: "g", gr: "g", kg: "kg",
  mm: "mm", cm: "cm", m: "m",
  gb: "gb", tb: "tb", mah: "mah",
  pol: "pol", polegadas: "pol"
};

export function normalizeReviewText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(^|\s)\.+|\.+(\s|$)/g, " ")
    .trim();
}

export function reviewTokens(value) {
  return normalizeReviewText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function textSimilarity(a, b) {
  const left = new Set(reviewTokens(a));
  const right = new Set(reviewTokens(b));
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let shared = 0;
  left.forEach((token) => { if (right.has(token)) shared += 1; });
  return shared / (left.size + right.size - shared);
}

// Medidas como "220v", "100 ml" ou "2,5kg". Numeros soltos (modelo, tamanho) ficam de fora
// porque variam demais entre cadastros do mesmo produto.
export function extractMeasures(value) {
  const measures = new Map();
  const text = normalizeReviewText(value);
  const pattern = /(\d+(?:\.\d+)?)\s?(volts|volt|watts|litros|litro|polegadas|mah|ml|lt|gr|kg|mm|cm|gb|tb|pol|v|w|l|g|m)\b/g;
  for (const match of text.matchAll(pattern)) {
    const unit = UNIT_ALIASES[match[2]];
    if (!unit) continue;
    if (!measures.has(unit)) measures.set(unit, new Set());
    measures.get(unit).add(Number(match[1]));
  }
  return measures;
}

export function measureConflicts(a, b) {
  const left = extractMeasures(a);
  const right = extractMeasures(b);
  const conflicts = [];
  left.forEach((values, unit) => {
    const other = right.get(unit);
    if (!other) return;
    const shared = [...values].some((value) => other.has(value));
    if (!shared) conflicts.push(`${[...values].join("/")}${unit} x ${[...other].join("/")}${unit}`);
  });
  return conflicts;
}

function normalizeEan(value) {
  return String(value || "").replace(/\D/g, "");
}

function roundRatio(value) {
  return Math.round(value * 100) / 100;
}

export function catalogReviewOptions(request = {}) {
  return [request, ...(Array.isArray(request.doubleChecks) ? request.doubleChecks : [])];
}

export function computeCatalogReviewSignals(request = {}) {
  const options = catalogReviewOptions(request);
  const base = options[0] || {};
  const others = options.slice(1);
  const reasons = [];
  const shortDescription = options.some((option) => reviewTokens(option.descricao).length < MIN_DESCRIPTION_TOKENS);

  if (!others.length) {
    if (shortDescription) reasons.push("Descrição curta demais para comparar");
    return {
      status: "unico",
      recommendation: "review",
      optionCount: 1,
      textSimilarity: null,
      priceDeltaPercent: null,
      eanConflict: false,
      measureConflicts: [],
      reasons
    };
  }

  const similarities = others.map((option) => textSimilarity(base.descricao, option.descricao));
  const minSimilarity = Math.min(...similarities);
  const conflicts = [...new Set(others.flatMap((option) => measureConflicts(base.descricao, option.descricao)))];
  const eans = [...new Set(options.map((option) => normalizeEan(option.ean)).filter(Boolean))];
  const eanConflict = eans.length > 1;
  const prices = options.map((option) => Number(option.valorUnit) || 0).filter((price) => price > 0);
  const priceRatio = prices.length > 1 ? Math.max(...prices) / Math.min(...prices) : 1;
  const priceDelta = priceRatio - 1;

  let status = "revisar";
  if (minSimilarity < DIVERGENT_TEXT_SIMILARITY) {
    status = "divergente";
    reasons.push(`Descrições muito diferentes (${Math.round(minSimilarity * 100)}% parecidas): provável Código ML errado`);
  }
  if (conflicts.length) {
    status = "divergente";
    reasons.push(`Medidas diferentes: ${conflicts.join(", ")}`);
  }
  if (eanConflict) {
    status = "divergente";
    reasons.push("EANs diferentes entre os cadastros");
  }
  if (priceRatio >= DIVERGENT_PRICE_RATIO) {
    reasons.push(`Preço varia ${Math.round(priceDelta * 100)}% entre os cadastros`);
  }

  if (status !== "divergente") {
    const textAgrees = minSimilarity >= CONCORDANT_TEXT_SIMILARITY && !shortDescription;
    const priceAgrees = priceDelta <= CONCORDANT_PRICE_DELTA;
    if (textAgrees && priceAgrees) {
      status = "concordante";
      reasons.unshift(minSimilarity === 1 ? "Descrições iguais" : `Descrições ${Math.round(minSimilarity * 100)}% parecidas`);
      if (eans.length === 1) reasons.push("Mesmo EAN");
    } else {
      if (!textAgrees && !shortDescription) reasons.push(`Descrições ${Math.round(minSimilarity * 100)}% parecidas`);
      if (shortDescription) reasons.push("Descrição curta demais para comparar");
      if (!priceAgrees && priceRatio < DIVERGENT_PRICE_RATIO) reasons.push(`Preço varia ${Math.round(priceDelta * 100)}% entre os cadastros`);
    }
  }

  return {
    status,
    recommendation: status === "concordante" ? "approve" : "review",
    optionCount: options.length,
    textSimilarity: roundRatio(minSimilarity),
    priceDeltaPercent: Math.round(priceDelta * 100),
    eanConflict,
    measureConflicts: conflicts,
    reasons
  };
}
