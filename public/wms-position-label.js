// Numeracao das etiquetas fisicas do JZ, tambem usada na leitura em wms-units.js.
const STREET_RANGES = {
  A: [1, 104], B: [105, 184], C: [185, 264],
  D: [265, 306], E: [307, 366], F: [367, 426]
};

export function wmsPositionLabel(location, depositName) {
  const original = String(location || "");
  if (String(depositName || "").trim().toUpperCase() !== "VENDA B2B") return original;
  const match = original.trim().toUpperCase().match(/^B2B-([A-F])-(\d+)-([1-4])$/);
  if (!match) return original;
  const [, street, column, level] = match;
  const [start, end] = STREET_RANGES[street];
  const number = start + (Number(column) - 1) * 4 + Number(level) - 1;
  if (Number(column) < 1 || number > end) return original;
  return `Posição ${number} · Rua ${street} · C${column.padStart(2, "0")} A${level}`;
}
