#!/usr/bin/env node
/**
 * Script de sincronización e ingesta de datos de GPUs, Benchmarks, Cloud y Juegos
 * Fuentes integradas:
 * 1. Scraper propio con Puppeteer (scripts/scrape-benchmarks.mjs → src/data/scraped/*.json):
 *    PassMark DirectX 12 / DirectX 11, Geekbench Browser OpenCL / Vulkan y Tom's Hardware GPU Hierarchy
 * 2. Especificaciones de GPUs: https://raw.githubusercontent.com/voidful/gpu-info-api/gpu-data/gpu.json
 * 3. PassMark DirectX 12 / DirectX 11 vía fetch + cheerio (fallback si no hay datos scrapeados)
 * 4. Vast.ai Cloud GPU Bundles API: https://cloud.vast.ai/api/v0/bundles/
 * 5. Steam Store API: https://store.steampowered.com/api/appdetails?appids={appid}
 * 6. PCGamingWiki Cargo API: https://www.pcgamingwiki.com/w/api.php?action=cargoquery
 * 7. ProtonDB Reports API: https://www.protondb.com/api/v1/reports/summaries/{appid}.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { normalizeGpuName, normalizeBaseGpuName, buildNameIndex } from './lib/gpu-names.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../src/data');
const SCRAPED_DIR = path.join(DATA_DIR, 'scraped');
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * Carga un archivo generado por scripts/scrape-benchmarks.mjs y devuelve un índice por nombre.
 * Devuelve null si el archivo no existe o está vacío.
 */
async function loadScrapedSource(id) {
  try {
    const raw = await fs.readFile(path.join(SCRAPED_DIR, `${id}.json`), 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries) || !data.entries.length) return null;
    console.log(`🗂️  Datos scrapeados [${id}]: ${data.entries.length} entradas (${data.scrapedAt}).`);
    return { meta: data, index: buildNameIndex(data.entries) };
  } catch {
    return null;
  }
}

async function loadScrapedData() {
  console.log('🕷️ [1/7] Cargando datos del scraper Puppeteer (src/data/scraped/)...');
  const [passmark, geekbench, tomshardware, techpowerup] = await Promise.all([
    loadScrapedSource('passmark'),
    loadScrapedSource('geekbench'),
    loadScrapedSource('tomshardware'),
    loadScrapedSource('techpowerup'),
  ]);
  if (!passmark && !geekbench && !tomshardware && !techpowerup) {
    console.warn('⚠️ No hay datos scrapeados. Ejecuta "npm run scrape" para generarlos.');
  }
  return { passmark, geekbench, tomshardware, techpowerup };
}

async function fetchVoidfulGpuSpecs() {
  console.log('📦 [2/7] Consultando especificaciones desde voidful/gpu-info-api...');
  const specs = new Map();
  try {
    const res = await fetchWithTimeout('https://raw.githubusercontent.com/voidful/gpu-info-api/gpu-data/gpu.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const entries = Array.isArray(data) ? data : Object.values(data);
    for (const item of entries) {
      const rawName = item.Model || item.model || item.name || '';
      if (!rawName) continue;
      const key = normalizeGpuName(rawName);
      specs.set(key, item);
    }
    console.log(`✅ gpu-info-api: ${specs.size} especificaciones cargadas.`);
  } catch (err) {
    console.warn(`⚠️ Aviso en voidful/gpu-info-api: ${err.message}.`);
  }
  return specs;
}

async function fetchPassmarkDirectXChart(url, label) {
  const scores = new Map();
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    $('ul.chartlist li').each((_, li) => {
      const name = $(li).find('span.prdname').text().trim();
      const countText = $(li).find('span.count').text().trim();
      const score = parseFloat(countText.replace(/[^0-9.]/g, ''));
      if (name && !isNaN(score) && score > 0) {
        const rounded = Math.round(score);
        scores.set(normalizeGpuName(name), rounded);
        const baseKey = normalizeBaseGpuName(name);
        if (!scores.has(baseKey)) {
          scores.set(baseKey, rounded);
        }
      }
    });
    console.log(`✅ PassMark ${label}: ${scores.size} GPUs procesadas.`);
  } catch (err) {
    console.warn(`⚠️ Aviso en PassMark ${label} scraper: ${err.message}.`);
  }
  return scores;
}

async function fetchPassmarkScores() {
  console.log('📊 [3/7] Consultando PassMark DirectX 12 & DirectX 11 Benchmarks...');
  const [dx12Map, dx11Map] = await Promise.all([
    fetchPassmarkDirectXChart('https://www.videocardbenchmark.net/directx-12.html', 'DirectX 12'),
    fetchPassmarkDirectXChart('https://www.videocardbenchmark.net/directx-11.html', 'DirectX 11')
  ]);
  return { dx12Map, dx11Map };
}

/**
 * Consulta Vast.ai Bundles API: https://cloud.vast.ai/api/v0/bundles/
 * Extrae telemetría real de Deep Learning Performance (dlperf), precio por hora ($/hr),
 * eficiencia (dlperf_per_dphtotal), TFLOPS medidos y disponibilidad de instancias por GPU.
 */
async function fetchVastAiBundles() {
  console.log('☁️ [4/7] Consultando Vast.ai Cloud Bundles API (https://cloud.vast.ai/api/v0/bundles/)...');
  const vastMap = new Map();
  try {
    const res = await fetchWithTimeout('https://cloud.vast.ai/api/v0/bundles/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'NDGPUList/2.1'
      },
      body: JSON.stringify({
        verified: { eq: true },
        external: { eq: false },
        rentable: { eq: true },
        num_gpus: { eq: 1 },
        type: 'on-demand',
        order: [['dlperf', 'desc']],
        limit: 600
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const offers = Array.isArray(data?.offers) ? data.offers : [];

    const grouped = new Map();
    for (const offer of offers) {
      if (!offer.gpu_name || !offer.dph_total || !offer.dlperf) continue;
      const numGpus = Number(offer.num_gpus || 1);
      const key = normalizeGpuName(offer.gpu_name);
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push({
        dlperf: Number(offer.dlperf) / numGpus,
        dph: Number(offer.dph_total) / numGpus,
        flops: Number(offer.total_flops || 0) / numGpus
      });
    }

    for (const [key, list] of grouped.entries()) {
      const sortedDph = list.map((x) => x.dph).sort((a, b) => a - b);
      const medianDph = sortedDph[Math.floor(sortedDph.length * 0.35)] || sortedDph[0];
      const avgDlperf = list.reduce((acc, x) => acc + x.dlperf, 0) / list.length;
      const maxFlops = Math.max(...list.map((x) => x.flops));

      vastMap.set(key, {
        dlperf: Number(avgDlperf.toFixed(1)),
        hourlyRateUSD: Number(medianDph.toFixed(2)),
        dlperfPerDollar: Number((avgDlperf / medianDph).toFixed(1)),
        availableOffers: list.length,
        verifiedFlops: Number(maxFlops.toFixed(1))
      });
    }
    console.log(`✅ Vast.ai Bundles: ${vastMap.size} modelos de GPU con telemetría cloud y DLPerf.`);
  } catch (err) {
    console.warn(`⚠️ Aviso en Vast.ai API: ${err.message}. Usando datos locales.`);
  }
  return vastMap;
}

async function fetchSteamGames(appIds) {
  console.log('🎮 [5/7] Consultando detalles de juegos desde Steam Store API...');
  const gamesMap = new Map();
  for (const appid of appIds) {
    try {
      const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=spanish`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const json = await res.json();
      const appData = json[String(appid)];
      if (appData && appData.success && appData.data) {
        const d = appData.data;
        gamesMap.set(appid, {
          steamAppId: appid,
          name: d.name,
          headerImage: d.header_image,
          shortDescription: d.short_description,
          genres: (d.genres || []).map((g) => g.description).slice(0, 3),
          pcRequirements: {
            minimum: d.pc_requirements?.minimum || '',
            recommended: d.pc_requirements?.recommended || ''
          }
        });
      }
    } catch (err) {
      console.warn(`⚠️ Error al consultar Steam AppID ${appid}: ${err.message}`);
    }
  }
  console.log(`✅ Steam API: ${gamesMap.size} juegos actualizados.`);
  return gamesMap;
}

async function fetchPCGamingWikiCargo(appIds) {
  console.log('🛠️ [6/7] Consultando PCGamingWiki Cargo API (APIs gráficas, Upscaling, RT, Frame Cap)...');
  const pcgwMap = new Map();

  for (const appid of appIds) {
    try {
      const params = new URLSearchParams({
        action: 'cargoquery',
        format: 'json',
        tables: 'Infobox_game,Video,API',
        join_on: 'Infobox_game._pageName=Video._pageName,Infobox_game._pageName=API._pageName',
        fields: [
          'Infobox_game._pageName=Page',
          'Infobox_game.Steam_AppID=Steam_AppID',
          'Video.Upscaling=Upscaling',
          'Video.Frame_generation=Frame_generation',
          'Video.Ray_tracing=Ray_tracing',
          'Video.High_frame_rate=High_frame_rate',
          'Video.Widescreen_resolution=Ultrawide',
          'Video.High_dynamic_range=HDR',
          'API.Direct3D_versions=Direct3D',
          'API.Vulkan_versions=Vulkan'
        ].join(','),
        where: `Infobox_game.Steam_AppID HOLDS "${appid}"`,
        limit: '1'
      });

      const url = `https://www.pcgamingwiki.com/w/api.php?${params.toString()}`;
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'NDGPUList/2.1 (https://github.com/nicosup98/ndgpulist)' }
      });
      if (!res.ok) continue;
      const json = await res.json();
      const row = json?.cargoquery?.[0]?.title;
      if (row) {
        const apis = [];
        if (row.Direct3D) {
          if (row.Direct3D.includes('12')) apis.push('DirectX 12');
          if (row.Direct3D.includes('11')) apis.push('DirectX 11');
        }
        if (row.Vulkan) apis.push('Vulkan');

        const upscalers = [];
        const upRaw = `${row.Upscaling || ''} ${row.Frame_generation || ''}`.toUpperCase();
        if (upRaw.includes('DLSS')) upscalers.push('DLSS');
        if (upRaw.includes('FSR')) upscalers.push('FSR');
        if (upRaw.includes('XESS')) upscalers.push('XeSS');

        pcgwMap.set(appid, {
          wikiPage: row.Page,
          graphicsApis: apis.length ? apis : undefined,
          upscalers: upscalers.length ? upscalers : undefined,
          frameGeneration: Boolean(row.Frame_generation && row.Frame_generation !== 'false'),
          rayTracing: row.Ray_tracing === 'true',
          highFrameRate: row.High_frame_rate === 'true',
          ultrawide: row.Ultrawide === 'true',
          hdr: row.HDR === 'true'
        });
      }
    } catch (err) {
      console.warn(`⚠️ Aviso en PCGamingWiki Cargo para AppID ${appid}: ${err.message}`);
    }
  }
  console.log(`✅ PCGamingWiki Cargo: ${pcgwMap.size} perfiles técnicos sincronizados.`);
  return pcgwMap;
}

async function fetchProtonDbData(appIds) {
  console.log('🐧 [7/7] Consultando ProtonDB API (Tier, Score y Reportes en Linux/SteamOS)...');
  const protonMap = new Map();

  for (const appid of appIds) {
    try {
      const url = `https://www.protondb.com/api/v1/reports/summaries/${appid}.json`;
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'NDGPUList/2.1' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.tier) {
        protonMap.set(appid, {
          tier: data.tier,
          trendingTier: data.trendingTier || data.tier,
          bestReportedTier: data.bestReportedTier || data.tier,
          score: Number(data.score || 0),
          confidence: data.confidence || 'good',
          totalReports: Number(data.total || 0)
        });
      }
    } catch (err) {
      console.warn(`⚠️ Aviso en ProtonDB API para AppID ${appid}: ${err.message}`);
    }
  }
  console.log(`✅ ProtonDB: ${protonMap.size} resúmenes de compatibilidad sincronizados.`);
  return protonMap;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const gpusPath = path.join(DATA_DIR, 'gpus.json');
  const gamesPath = path.join(DATA_DIR, 'games.json');

  const existingGpusRaw = await fs.readFile(gpusPath, 'utf-8');
  const gpus = JSON.parse(existingGpusRaw);

  const existingGamesRaw = await fs.readFile(gamesPath, 'utf-8');
  const games = JSON.parse(existingGamesRaw);
  const appIds = games.map((g) => g.steamAppId);

  const scraped = await loadScrapedData();

  const [voidfulMap, passmarkMap, vastMap, steamGamesMap, pcgwMap, protonMap] = await Promise.all([
    fetchVoidfulGpuSpecs(),
    // Fallback con fetch + cheerio sólo si el scraper Puppeteer no generó datos de PassMark
    scraped.passmark ? Promise.resolve({ dx12Map: new Map(), dx11Map: new Map() }) : fetchPassmarkScores(),
    fetchVastAiBundles(),
    fetchSteamGames(appIds),
    fetchPCGamingWikiCargo(appIds),
    fetchProtonDbData(appIds)
  ]);

  // Agrupar por nombre base para detectar variantes de VRAM (ej. RTX 3060 8GB vs 12GB)
  const maxVramByBase = new Map();
  for (const gpu of gpus) {
    const base = normalizeBaseGpuName(gpu.name);
    maxVramByBase.set(base, Math.max(maxVramByBase.get(base) ?? 0, gpu.vramGB));
  }

  /**
   * Búsqueda estricta para evitar asignar datos de una variante a otra:
   * el fallback por nombre base sólo se acepta si la entrada de la fuente no especifica VRAM
   * y la GPU local es la variante de mayor VRAM de su familia (ej. RTX 3060 12GB, no la de 8GB).
   */
  function lookupStrict(index, gpu) {
    const exact = index.exact.get(normalizeGpuName(gpu.name));
    if (exact) return exact;
    const base = normalizeBaseGpuName(gpu.name);
    const candidate = index.base.get(base);
    if (!candidate || /\d+\s*GB/i.test(candidate.name)) return undefined;
    return gpu.vramGB === maxVramByBase.get(base) ? candidate : undefined;
  }

  const mergeStats = { passmark: 0, geekbench: 0, tomshardware: 0, techpowerup: 0 };

  // Actualizar GPUs con datos scrapeados (PassMark, Geekbench, Tom's Hardware), voidful y Vast.ai Cloud Bundles
  for (const gpu of gpus) {
    const normKey = normalizeGpuName(gpu.name);
    const baseKey = normalizeBaseGpuName(gpu.name);

    if (scraped.geekbench) {
      const gb = lookupStrict(scraped.geekbench.index, gpu);
      if (gb) {
        if (gb.opencl) gpu.benchmarks.geekbenchOpenCL = gb.opencl;
        if (gb.vulkan) gpu.benchmarks.geekbenchVulkan = gb.vulkan;
        mergeStats.geekbench++;
      }
    }

    if (scraped.passmark) {
      const pm = lookupStrict(scraped.passmark.index, gpu);
      if (pm) {
        if (pm.dx12) gpu.benchmarks.passmarkDX12 = pm.dx12;
        if (pm.dx11) gpu.benchmarks.passmarkDX11 = pm.dx11;
        mergeStats.passmark++;
      }
    } else {
      if (passmarkMap.dx12Map.has(normKey)) {
        gpu.benchmarks.passmarkDX12 = passmarkMap.dx12Map.get(normKey);
      } else if (passmarkMap.dx12Map.has(baseKey)) {
        gpu.benchmarks.passmarkDX12 = passmarkMap.dx12Map.get(baseKey);
      }
      if (passmarkMap.dx11Map.has(normKey)) {
        gpu.benchmarks.passmarkDX11 = passmarkMap.dx11Map.get(normKey);
      } else if (passmarkMap.dx11Map.has(baseKey)) {
        gpu.benchmarks.passmarkDX11 = passmarkMap.dx11Map.get(baseKey);
      }
    }

    if (scraped.tomshardware) {
      const th = lookupStrict(scraped.tomshardware.index, gpu);
      if (th) {
        gpu.tomshardware = {
          sourceName: th.name,
          rasterization: th.rasterization ?? null,
          rayTracing: th.rayTracing ?? null,
          scrapedAt: scraped.tomshardware.meta.scrapedAt,
        };
        mergeStats.tomshardware++;
      } else {
        delete gpu.tomshardware;
      }
    }

    if (scraped.techpowerup) {
      const tpu = scraped.techpowerup.index.exact.get(normKey) || lookupStrict(scraped.techpowerup.index, gpu);
      if (tpu) {
        gpu.techpowerup = {
          url: tpu.url,
          relativePerformancePct: tpu.relativePerformancePct,
          tmus: tpu.tmus,
          rops: tpu.rops,
          shadersTmusRops: tpu.shadersTmusRops,
          launchDate: tpu.launchDate,
        };
        mergeStats.techpowerup++;
      }
    }
    if (voidfulMap.has(normKey)) {
      const spec = voidfulMap.get(normKey);
      gpu.rawSourceSynced = true;
      if (spec['Launch']) gpu.launchDate = spec['Launch'];
    }
    if (vastMap.has(normKey)) {
      gpu.vastai = vastMap.get(normKey);
    }
  }

  // Actualizar Juegos con Steam + PCGamingWiki Cargo + ProtonDB
  for (const game of games) {
    const appid = game.steamAppId;
    if (steamGamesMap.has(appid)) {
      const sData = steamGamesMap.get(appid);
      game.name = sData.name || game.name;
      game.headerImage = sData.headerImage || game.headerImage;
      game.genres = sData.genres?.length ? sData.genres : game.genres;
    }
    if (pcgwMap.has(appid)) {
      const pcgw = pcgwMap.get(appid);
      game.pcgw = {
        ...game.pcgw,
        wikiPage: pcgw.wikiPage || game.pcgw?.wikiPage,
        graphicsApis: pcgw.graphicsApis || game.pcgw?.graphicsApis,
        upscalers: pcgw.upscalers || game.pcgw?.upscalers,
        frameGeneration: pcgw.frameGeneration ?? game.pcgw?.frameGeneration,
        rayTracing: pcgw.rayTracing ?? game.pcgw?.rayTracing,
        ultrawide: pcgw.ultrawide ?? game.pcgw?.ultrawide,
        hdr: pcgw.hdr ?? game.pcgw?.hdr
      };
    }
    if (protonMap.has(appid)) {
      const pData = protonMap.get(appid);
      game.protondb = {
        ...game.protondb,
        ...pData
      };
    }
  }

  await fs.writeFile(gpusPath, JSON.stringify(gpus, null, 2), 'utf-8');
  await fs.writeFile(gamesPath, JSON.stringify(games, null, 2), 'utf-8');
  console.log(
    `🔗 Fusión de datos scrapeados: PassMark ${mergeStats.passmark}/${gpus.length}, ` +
      `Geekbench ${mergeStats.geekbench}/${gpus.length}, Tom's Hardware ${mergeStats.tomshardware}/${gpus.length}, ` +
      `TechPowerUp ${mergeStats.techpowerup}/${gpus.length}.`
  );
  console.log(`🎉 Sincronización completada: ${gpus.length} GPUs (con Vast.ai Bundles) y ${games.length} juegos guardados.`);
}

main().catch((err) => {
  console.error('❌ Error en sync-data:', err);
  process.exit(1);
});
