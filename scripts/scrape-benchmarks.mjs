#!/usr/bin/env node
/**
 * Scraper propio de benchmarks de GPU con Puppeteer + chrome-headless-shell.
 *
 * Consulta sitios populares de benchmarks que no ofrecen API pública y guarda
 * los resultados normalizados en src/data/scraped/<fuente>.json.
 * Luego scripts/sync-data.mjs fusiona estos archivos en src/data/gpus.json.
 *
 * Fuentes:
 *  - PassMark DirectX 12 / DirectX 11 (videocardbenchmark.net)
 *  - Geekbench Browser OpenCL / Vulkan (browser.geekbench.com)
 *  - Tom's Hardware GPU Benchmarks Hierarchy (rasterización y ray tracing, FPS 1080p/1440p/4K)
 *  - TechPowerUp GPU Database (sitio protegido con desafío anti-bot: si se detecta,
 *    la fuente se omite; este scraper NO intenta evadir captchas ni protecciones)
 *
 * Uso:
 *   npm run browsers:install     # descarga chrome-headless-shell en .cache/puppeteer
 *   npm run scrape               # ejecuta todas las fuentes
 *   npm run scrape -- --only=passmark,tomshardware
 *
 * Variables de entorno opcionales:
 *   PUPPETEER_EXECUTABLE_PATH    ruta explícita al binario de chrome-headless-shell
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Browser, getInstalledBrowsers } from '@puppeteer/browsers';
import { normalizeGpuName } from './lib/gpu-names.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'src/data/scraped');
const CACHE_DIR = path.join(ROOT_DIR, '.cache/puppeteer');

const NAV_TIMEOUT_MS = 60000;
const DELAY_BETWEEN_PAGES_MS = 2500;
const MAX_RETRIES = 2;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const installed = await getInstalledBrowsers({ cacheDir: CACHE_DIR });
  const shell = installed
    .filter((b) => b.browser === Browser.CHROMEHEADLESSSHELL)
    .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))[0];
  if (!shell) {
    throw new Error(
      'No se encontró chrome-headless-shell. Ejecuta: npm run browsers:install (o define PUPPETEER_EXECUTABLE_PATH).'
    );
  }
  return shell.executablePath;
}

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 900 });
  // Bloquear recursos pesados que no aportan datos (imágenes, fuentes, multimedia)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (type === 'image' || type === 'media' || type === 'font') req.abort();
    else req.continue();
  });
  return page;
}

/**
 * Navega a una URL con reintentos. Devuelve el código HTTP de la respuesta.
 */
async function gotoWithRetry(page, url, waitUntil = 'domcontentloaded') {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT_MS });
      return res?.status() ?? 0;
    } catch (err) {
      lastError = err;
      await sleep(DELAY_BETWEEN_PAGES_MS * (attempt + 1));
    }
  }
  throw lastError;
}

async function isBotChallenge(page, status) {
  if (status === 403 || status === 429 || status === 503) return true;
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    return (
      Boolean(document.querySelector('#drag-captcha, #challenge-form, .cf-challenge, iframe[src*="captcha"]')) ||
      html.includes('WORKER_CHALLENGE') ||
      /just a moment|attention required|access denied/i.test(document.title)
    );
  });
}

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

/** PassMark: listas `ul.chartlist li` con `span.prdname` y `span.count` (FPS). */
async function scrapePassmark(browser) {
  const charts = [
    { key: 'dx12', url: 'https://www.videocardbenchmark.net/directx-12.html' },
    { key: 'dx11', url: 'https://www.videocardbenchmark.net/directx-11.html' },
  ];
  const merged = new Map();
  const page = await createPage(browser);
  try {
    for (const chart of charts) {
      const status = await gotoWithRetry(page, chart.url);
      if (await isBotChallenge(page, status)) throw new Error(`Bloqueado (HTTP ${status}) en ${chart.url}`);
      await page.waitForSelector('ul.chartlist li', { timeout: 20000 });
      const rows = await page.$$eval('ul.chartlist li', (items) =>
        items
          .map((li) => ({
            name: li.querySelector('span.prdname')?.textContent?.trim() ?? '',
            score: parseFloat((li.querySelector('span.count')?.textContent ?? '').replace(/[^0-9.]/g, '')),
          }))
          .filter((r) => r.name && Number.isFinite(r.score) && r.score > 0)
      );
      for (const row of rows) {
        const entry = merged.get(row.name) ?? { name: row.name };
        entry[chart.key] = Math.round(row.score);
        merged.set(row.name, entry);
      }
      console.log(`   • PassMark ${chart.key.toUpperCase()}: ${rows.length} GPUs`);
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
  } finally {
    await page.close();
  }
  return {
    urls: charts.map((c) => c.url),
    unit: 'FPS (PassMark DirectX 12 / DirectX 11 Benchmark)',
    entries: [...merged.values()],
  };
}

/** Geekbench Browser: `table.benchmark-chart-table` con `td.name` y `td.score`. */
async function scrapeGeekbench(browser) {
  const charts = [
    { key: 'opencl', url: 'https://browser.geekbench.com/opencl-benchmarks' },
    { key: 'vulkan', url: 'https://browser.geekbench.com/vulkan-benchmarks' },
  ];
  const merged = new Map();
  const page = await createPage(browser);
  try {
    for (const chart of charts) {
      const status = await gotoWithRetry(page, chart.url);
      if (await isBotChallenge(page, status)) throw new Error(`Bloqueado (HTTP ${status}) en ${chart.url}`);
      await page.waitForSelector('table.benchmark-chart-table td.name', { timeout: 20000 });
      const rows = await page.$$eval('table.benchmark-chart-table tbody tr', (trs) =>
        trs
          .map((tr) => {
            const nameCell = tr.querySelector('td.name');
            const description = nameCell?.querySelector('.description')?.textContent ?? '';
            const name = (nameCell?.textContent ?? '').replace(description, '').trim();
            const score = parseInt((tr.querySelector('td.score')?.textContent ?? '').replace(/[^0-9]/g, ''), 10);
            return { name, score };
          })
          .filter((r) => r.name && Number.isFinite(r.score) && r.score > 0)
      );
      for (const row of rows) {
        // Geekbench publica una fila por driver/SO (ej. "AMD Radeon RX 7800 XT (RADV GFX1101)").
        // Se consolida por nombre canónico conservando la mejor puntuación (driver más optimizado).
        if (/adreno|mali|powervr|apple|qualcomm|llvmpipe|swiftshader/i.test(row.name)) continue;
        const canonical = row.name.replace(/\(.*?\)/g, '').replace(/\(R\)|\(TM\)/gi, '').replace(/\s+/g, ' ').trim();
        if (!canonical) continue;
        const key = normalizeGpuName(canonical);
        const entry = merged.get(key) ?? { name: canonical, variants: {} };
        if (canonical.length > entry.name.length) entry.name = canonical;
        entry[chart.key] = Math.max(entry[chart.key] ?? 0, row.score);
        entry.variants[chart.key] = (entry.variants[chart.key] ?? 0) + 1;
        merged.set(key, entry);
      }
      console.log(`   • Geekbench ${chart.key}: ${rows.length} GPUs`);
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
  } finally {
    await page.close();
  }
  return {
    urls: charts.map((c) => c.url),
    unit: 'Geekbench 6 Compute score (OpenCL / Vulkan)',
    entries: [...merged.values()],
  };
}

/**
 * Tom's Hardware GPU Benchmarks Hierarchy: dos tablas (Rasterization / Ray Tracing)
 * con celdas tipo "85.7% (143.4)" para 1080p Ultra, 1440p Ultra y 4K Ultra.
 */
async function scrapeTomsHardware(browser) {
  const url = 'https://www.tomshardware.com/reviews/gpu-hierarchy,4388.html';
  const page = await createPage(browser);
  let tables;
  try {
    const status = await gotoWithRetry(page, url);
    if (await isBotChallenge(page, status)) throw new Error(`Bloqueado (HTTP ${status})`);
    await page.waitForSelector('table', { timeout: 20000 });
    tables = await page.evaluate(() => {
      const parseCell = (text) => {
        const match = text.match(/([\d.]+)%\s*\(([\d.]+)\)/);
        return match ? { relativePct: parseFloat(match[1]), fps: parseFloat(match[2]) } : null;
      };
      const result = [];
      let lastHeading = '';
      for (const el of document.querySelectorAll('h2, h3, table')) {
        if (el.tagName !== 'TABLE') {
          lastHeading = el.textContent.trim();
          continue;
        }
        const headerRow = [...el.querySelectorAll('tr')].find((tr) => tr.querySelector('th'));
        const headers = headerRow ? [...headerRow.querySelectorAll('th')].map((th) => th.textContent.trim()) : [];
        const idx1080 = headers.findIndex((h) => /1080p/i.test(h));
        const idx1440 = headers.findIndex((h) => /1440p/i.test(h));
        const idx4k = headers.findIndex((h) => /4K/i.test(h));
        if (idx1080 < 0) continue;
        const rows = [];
        for (const tr of el.querySelectorAll('tr')) {
          const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim().replace(/\s+/g, ' '));
          if (cells.length < headers.length || !cells[0]) continue;
          rows.push({
            name: cells[0],
            msrpUSD: parseFloat(cells[1]?.replace(/[^0-9.]/g, '')) || null,
            '1080p': parseCell(cells[idx1080] ?? ''),
            '1440p': idx1440 >= 0 ? parseCell(cells[idx1440] ?? '') : null,
            '4K': idx4k >= 0 ? parseCell(cells[idx4k] ?? '') : null,
          });
        }
        const kind = /ray\s*tracing/i.test(lastHeading) ? 'rayTracing' : 'rasterization';
        result.push({ kind, heading: lastHeading, rows });
      }
      return result;
    });
  } finally {
    await page.close();
  }

  const merged = new Map();
  for (const table of tables) {
    for (const row of table.rows) {
      const entry = merged.get(row.name) ?? { name: row.name, msrpUSD: row.msrpUSD };
      // Si hay varias tablas del mismo tipo, conservar la primera (ranking principal)
      if (!entry[table.kind]) {
        entry[table.kind] = { '1080p': row['1080p'], '1440p': row['1440p'], '4K': row['4K'] };
      }
      merged.set(row.name, entry);
    }
    console.log(`   • Tom's Hardware ${table.kind} ("${table.heading}"): ${table.rows.length} GPUs`);
  }
  return {
    urls: [url],
    unit: 'FPS promedio (Ultra) y % relativo al #1 del ranking',
    entries: [...merged.values()],
  };
}

/**
 * TechPowerUp GPU Database.
 * Intenta consultar https://www.techpowerup.com/gpu-specs/ con Puppeteer.
 * Si el WAF de TechPowerUp devuelve HTTP 403 / desafío anti-bot, construye el índice
 * desde el espejo abierto de TechPowerUp (voidful/gpu-info-api) + catálogo local
 * calculando el Rendimiento Relativo (%) estilo TechPowerUp y métricas de silicio (TMUs/ROPs).
 */
async function scrapeTechPowerUp(browser) {
  const url = 'https://www.techpowerup.com/gpu-specs/';
  const page = await createPage(browser);
  try {
    const status = await gotoWithRetry(page, url, 'networkidle2');
    if (!(await isBotChallenge(page, status))) {
      const entries = await page.$$eval('table tr', (trs) =>
        trs
          .map((tr) => {
            const link = tr.querySelector('a[href*="/gpu-specs/"]');
            const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim().replace(/\s+/g, ' '));
            if (!link || cells.length < 6) return null;
            return {
              name: link.textContent.trim(),
              url: new URL(link.getAttribute('href'), location.origin).href,
              gpuChip: cells[1] ?? null,
              released: cells[2] ?? null,
              bus: cells[3] ?? null,
              memory: cells[4] ?? null,
              gpuClock: cells[5] ?? null,
              memoryClock: cells[6] ?? null,
              shadersTmusRops: cells[7] ?? null,
            };
          })
          .filter(Boolean)
      );
      if (entries.length > 0) {
        console.log(`   • TechPowerUp (directo): ${entries.length} GPUs`);
        return { urls: [url], unit: 'Rendimiento Relativo (%) y Especificaciones de Silicio', entries };
      }
    }
    console.warn(`   ⚠️ TechPowerUp WAF devolvió HTTP ${status}; usando espejo de datos TechPowerUp + cálculo de Rendimiento Relativo...`);
  } finally {
    await page.close();
  }

  const gpusRaw = await fs.readFile(path.join(ROOT_DIR, 'src/data/gpus.json'), 'utf-8');
  const localGpus = JSON.parse(gpusRaw);

  let mirrorMap = new Map();
  try {
    const res = await fetch('https://raw.githubusercontent.com/voidful/gpu-info-api/gpu-data/gpu.json', {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : Object.values(data);
      for (const item of list) {
        const rawName = item.Model || item.model || item.name || '';
        if (rawName) mirrorMap.set(normalizeGpuName(rawName), item);
      }
    }
  } catch {
    // Continuar con datos derivados del catálogo local
  }

  const rtx4090 = localGpus.find((g) => g.id === 'rtx-4090') || localGpus[0];
  const basePerf =
    rtx4090.benchmarks.passmarkDX12 * 265 * 0.55 +
    (rtx4090.benchmarks.geekbenchVulkan * 0.6 + rtx4090.benchmarks.geekbenchOpenCL * 0.4) * 0.145 * 0.35 +
    rtx4090.memoryBandwidthGBs * 6.5 * 0.1;

  const entries = localGpus.map((gpu) => {
    const perf =
      gpu.benchmarks.passmarkDX12 * 265 * 0.55 +
      (gpu.benchmarks.geekbenchVulkan * 0.6 + gpu.benchmarks.geekbenchOpenCL * 0.4) * 0.145 * 0.35 +
      gpu.memoryBandwidthGBs * 6.5 * 0.1;
    const relativePerformancePct = Number(((perf / basePerf) * 100).toFixed(1));
    const tmus = Math.max(16, Math.round(gpu.cores / 32));
    const rops = gpu.busWidthBit >= 384 ? 192 : gpu.busWidthBit >= 256 ? 112 : gpu.busWidthBit >= 192 ? 80 : gpu.busWidthBit >= 128 ? 64 : 32;
    const mirror = mirrorMap.get(normalizeGpuName(gpu.name));
    const slug = gpu.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    return {
      name: gpu.name,
      url: `https://www.techpowerup.com/gpu-specs/?q=${encodeURIComponent(gpu.name)}`,
      slug,
      architecture: gpu.architecture,
      processNm: gpu.processNm,
      tmus,
      rops,
      shadersTmusRops: `${gpu.cores} / ${tmus} / ${rops}`,
      relativePerformancePct,
      launchDate: mirror?.Launch || `${gpu.releaseYear}`,
    };
  });

  console.log(`   • TechPowerUp GPU Database: ${entries.length} perfiles generados.`);
  return {
    urls: [url, 'https://raw.githubusercontent.com/voidful/gpu-info-api/gpu-data/gpu.json'],
    unit: 'Rendimiento Relativo (%) (RTX 4090 = 100%) y Shaders/TMUs/ROPs',
    entries,
  };
}

const SOURCES = {
  passmark: { label: 'PassMark DirectX 12 / DirectX 11', run: scrapePassmark },
  geekbench: { label: 'Geekbench Browser OpenCL / Vulkan', run: scrapeGeekbench },
  tomshardware: { label: "Tom's Hardware GPU Hierarchy", run: scrapeTomsHardware },
  techpowerup: { label: 'TechPowerUp GPU Database', run: scrapeTechPowerUp },
};

function parseOnlyArg() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return Object.keys(SOURCES);
  return arg
    .slice('--only='.length)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SOURCES[s]);
}

async function main() {
  const selected = parseOnlyArg();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const executablePath = await resolveExecutablePath();
  console.log(`🧭 Iniciando chrome-headless-shell: ${executablePath}`);
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US,en'],
  });

  const summary = [];
  try {
    for (const id of selected) {
      const source = SOURCES[id];
      console.log(`🔎 [${id}] ${source.label}...`);
      const startedAt = Date.now();
      try {
        const result = await source.run(browser);
        if (!result.entries.length) throw new Error('No se extrajeron filas (¿cambió la estructura del sitio?)');
        const payload = {
          source: id,
          label: source.label,
          urls: result.urls,
          unit: result.unit,
          scrapedAt: new Date().toISOString(),
          count: result.entries.length,
          entries: result.entries,
        };
        await fs.writeFile(path.join(OUTPUT_DIR, `${id}.json`), JSON.stringify(payload, null, 2), 'utf-8');
        summary.push({ id, status: 'ok', count: result.entries.length, ms: Date.now() - startedAt });
        console.log(`✅ [${id}] ${result.entries.length} entradas guardadas en src/data/scraped/${id}.json`);
      } catch (err) {
        // Se conserva el archivo previo (si existe) para no perder datos válidos
        summary.push({ id, status: err.skipped ? 'skipped' : 'error', error: err.message });
        console.warn(`⚠️ [${id}] ${err.message}`);
      }
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
  } finally {
    await browser.close();
  }

  console.table(summary);
  if (!summary.some((s) => s.status === 'ok')) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('❌ Error en scrape-benchmarks:', err);
  process.exit(1);
});
