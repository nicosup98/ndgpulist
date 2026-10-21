#!/usr/bin/env node
/**
 * Script de sincronización e ingesta de datos de GPUs, Benchmarks, Cloud y Juegos
 * Fuentes integradas:
 * 1. Geekbench 6 Compute Benchmarks (OpenCL / Vulkan): https://browser.geekbench.com/v6/compute
 * 2. Especificaciones de GPUs: https://raw.githubusercontent.com/voidful/gpu-info-api/gpu-data/gpu.json
 * 3. PassMark G3D Mark Scraper (videocardbenchmark.net)
 * 4. Vast.ai Cloud GPU Bundles API: https://cloud.vast.ai/api/v0/bundles/
 * 5. Steam Store API: https://store.steampowered.com/api/appdetails?appids={appid}
 * 6. PCGamingWiki Cargo API: https://www.pcgamingwiki.com/w/api.php?action=cargoquery
 * 7. ProtonDB Reports API: https://www.protondb.com/api/v1/reports/summaries/{appid}.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../src/data');
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function normalizeGpuName(name) {
  return name
    .toLowerCase()
    .replace(/nvidia|amd|intel|geforce|radeon|arc/gi, '')
    .replace(/\bsuper\b/gi, 'super')
    .replace(/(\d{4})s\b/gi, '$1super')
    .replace(/(\d{4})ti\b/gi, '$1ti')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function fetchGeekbenchCompute() {
  console.log('⚡ [1/7] Consultando Geekbench 6 Compute Benchmarks (browser.geekbench.com/v6/compute)...');
  const scores = new Map();
  try {
    const res = await fetchWithTimeout('https://browser.geekbench.com/v6/compute', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NDGPUList/2.1)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('table.benchmark-chart-table tbody tr, .table tbody tr').each((_, row) => {
      const name = $(row).find('td.name a, td.name').first().text().trim();
      const scoreText = $(row).find('td.score').first().text().trim();
      const score = parseInt(scoreText.replace(/[^0-9]/g, ''), 10);
      if (name && !isNaN(score) && score > 0) {
        const key = normalizeGpuName(name);
        if (!scores.has(key) || scores.get(key) < score) {
          scores.set(key, score);
        }
      }
    });
    console.log(`✅ Geekbench 6: ${scores.size} GPUs procesadas.`);
  } catch (err) {
    console.warn(`⚠️ Aviso en Geekbench scraper: ${err.message}. Usando datos locales.`);
  }
  return scores;
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
        scores.set(normalizeGpuName(name), Math.round(score));
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

  const [geekbenchMap, voidfulMap, passmarkMap, vastMap, steamGamesMap, pcgwMap, protonMap] = await Promise.all([
    fetchGeekbenchCompute(),
    fetchVoidfulGpuSpecs(),
    fetchPassmarkScores(),
    fetchVastAiBundles(),
    fetchSteamGames(appIds),
    fetchPCGamingWikiCargo(appIds),
    fetchProtonDbData(appIds)
  ]);

  // Actualizar GPUs con Geekbench, PassMark (DirectX 12 y DirectX 11), voidful y Vast.ai Cloud Bundles
  for (const gpu of gpus) {
    const normKey = normalizeGpuName(gpu.name);
    if (geekbenchMap.has(normKey)) {
      gpu.benchmarks.geekbenchOpenCL = geekbenchMap.get(normKey);
    }
    if (passmarkMap.dx12Map.has(normKey)) {
      gpu.benchmarks.passmarkDX12 = passmarkMap.dx12Map.get(normKey);
    }
    if (passmarkMap.dx11Map.has(normKey)) {
      gpu.benchmarks.passmarkDX11 = passmarkMap.dx11Map.get(normKey);
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
  console.log(`🎉 Sincronización completada: ${gpus.length} GPUs (con Vast.ai Bundles) y ${games.length} juegos guardados.`);
}

main().catch((err) => {
  console.error('❌ Error en sync-data:', err);
  process.exit(1);
});
