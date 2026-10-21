/**
 * Utilidades compartidas para normalizar nombres de GPU entre fuentes
 * (PassMark, Geekbench, Tom's Hardware, TechPowerUp, etc.).
 */

export function normalizeGpuName(name) {
  return name
    .toLowerCase()
    .replace(/nvidia|amd|intel|geforce|radeon|arc/gi, '')
    .replace(/(\d+)\s*lc\b/gi, '$1 liquid')
    .replace(/\bliquid\s*cooled\b|\bliquid\s*cooling\b/gi, 'liquid')
    .replace(/\blc\b/gi, 'liquid')
    .replace(/\bsuper\b/gi, 'super')
    .replace(/(\d{4})s\b/gi, '$1super')
    .replace(/(\d{4})ti\b/gi, '$1ti')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Nombre base sin sufijos de VRAM, tipo de memoria, ediciones especiales ni texto entre paréntesis.
 * Se usa como fallback cuando no hay coincidencia exacta.
 */
export function normalizeBaseGpuName(name) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b\d+\s*gb\b/gi, '')
    .replace(/\bgddr6x?\b/gi, '')
    .replace(/\bhbm2?\b/gi, '')
    .replace(/\b50th\s*anniversary\b/gi, '')
    .replace(/nvidia|amd|intel|geforce|radeon|arc/gi, '')
    .replace(/(\d+)\s*lc\b/gi, '$1 liquid')
    .replace(/\bliquid\s*cooled\b|\bliquid\s*cooling\b/gi, 'liquid')
    .replace(/\blc\b/gi, 'liquid')
    .replace(/\bsuper\b/gi, 'super')
    .replace(/(\d{4})s\b/gi, '$1super')
    .replace(/(\d{4})ti\b/gi, '$1ti')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Construye un índice { exact: Map, base: Map } a partir de entradas { name, ... }.
 * En el índice base se conserva la primera aparición (normalmente la variante principal).
 */
export function buildNameIndex(entries) {
  const exact = new Map();
  const base = new Map();
  for (const entry of entries) {
    if (!entry?.name) continue;
    const exactKey = normalizeGpuName(entry.name);
    const baseKey = normalizeBaseGpuName(entry.name);
    if (!exact.has(exactKey)) exact.set(exactKey, entry);
    if (!base.has(baseKey)) base.set(baseKey, entry);
  }
  return { exact, base };
}

/**
 * Busca una GPU en el índice: primero por nombre exacto normalizado y luego por nombre base.
 */
export function lookupGpu(index, gpuName) {
  if (!index) return undefined;
  return index.exact.get(normalizeGpuName(gpuName)) ?? index.base.get(normalizeBaseGpuName(gpuName));
}
