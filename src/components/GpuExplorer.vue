<script setup lang="ts">
import { ref, computed } from 'vue';
import Fuse from 'fuse.js';
import type {
  GpuSpec,
  SteamGame,
  ResolutionKey,
  QualityPreset,
  UpscalingMode,
  TargetPlatform,
  ProtonTier,
} from '../utils/fpsCalculator';
import { calculateRelativeFps, getCompositeGpuScore } from '../utils/fpsCalculator';

const props = defineProps<{
  gpus: GpuSpec[];
  games: SteamGame[];
  initialGpuIds?: string[];
}>();

// Filtros del Ranking de GPUs
const selectedBrandFilter = ref<'ALL' | 'NVIDIA' | 'AMD' | 'Intel'>('ALL');
const selectedSeriesFilter = ref<string>('ALL');
const selectedVramFilter = ref<number>(0);
const searchQuery = ref('');
const sortBy = ref<'passmarkDX12' | 'passmarkDX11' | 'geekbenchOpenCL' | 'geekbenchVulkan' | 'vastDlperf' | 'vastCloudPrice' | 'vram' | 'value'>('passmarkDX12');
const showAllGpus = ref(false);

const availableSeries = computed(() => {
  const set = new Set<string>();
  for (const g of props.gpus) {
    if (selectedBrandFilter.value === 'ALL' || g.brand === selectedBrandFilter.value) {
      set.add(g.series);
    }
  }
  return Array.from(set);
});

// Comparador (soporta de 2 hasta 4 GPUs simultáneamente)
const comparedIds = ref<string[]>(
  props.initialGpuIds && props.initialGpuIds.length >= 2
    ? [...props.initialGpuIds]
    : ['rtx-4070-super', 'rx-7800-xt', 'arc-b580']
);

// Buscador difuso con Fuse.js para el Ranking y para agregar GPUs al Comparador
const gpuFuse = computed(
  () =>
    new Fuse(props.gpus, {
      keys: [
        { name: 'name', weight: 0.5 },
        { name: 'id', weight: 0.2 },
        { name: 'series', weight: 0.15 },
        { name: 'architecture', weight: 0.1 },
        { name: 'brand', weight: 0.05 },
      ],
      threshold: 0.35,
      ignoreLocation: true,
      includeScore: true,
    })
);

const compareSearchQuery = ref('');
const isCompareSearchOpen = ref(false);
const highlightedIndex = ref(0);

const compareSearchResults = computed(() => {
  const q = compareSearchQuery.value.trim();
  if (!q) {
    return props.gpus
      .filter((g) => !comparedIds.value.includes(g.id))
      .slice(0, 8);
  }
  return gpuFuse.value
    .search(q)
    .map((res) => res.item)
    .slice(0, 8);
});

// Controles del Estimador de FPS (enriquecido con PCGamingWiki Cargo + ProtonDB)
const selectedResolution = ref<ResolutionKey>('1440p');
const selectedQuality = ref<QualityPreset>('high');
const selectedUpscaling = ref<UpscalingMode>('off');
const enableFrameGen = ref<boolean>(false);
const selectedPlatform = ref<TargetPlatform>('windows');
const unlockEngineCap = ref<boolean>(false);
const gameFeatureFilter = ref<'ALL' | 'PROTON_TOP' | 'UPSCALING' | 'FRAME_GEN' | 'RAY_TRACING'>('ALL');

const maxPassmarkDX12 = computed(() => Math.max(...props.gpus.map((g) => g.benchmarks.passmarkDX12)));
const maxPassmarkDX11 = computed(() => Math.max(...props.gpus.map((g) => g.benchmarks.passmarkDX11)));
const maxGeekbenchCL = computed(() => Math.max(...props.gpus.map((g) => g.benchmarks.geekbenchOpenCL)));
const maxVastDlperf = computed(() => Math.max(...props.gpus.map((g) => g.vastai?.dlperf || 1)));

const filteredGpus = computed(() => {
  const q = searchQuery.value.trim();
  const baseList = q
    ? gpuFuse.value.search(q).map((r) => r.item)
    : props.gpus;

  const filtered = baseList.filter((gpu) => {
    const matchesBrand = selectedBrandFilter.value === 'ALL' || gpu.brand === selectedBrandFilter.value;
    const matchesSeries = selectedSeriesFilter.value === 'ALL' || gpu.series === selectedSeriesFilter.value;
    const matchesVram = selectedVramFilter.value === 0 || gpu.vramGB >= selectedVramFilter.value;
    return matchesBrand && matchesSeries && matchesVram;
  });

  if (q) {
    // Mantiene la relevancia difusa de Fuse.js cuando el usuario está buscando por texto
    return filtered;
  }

  return [...filtered].sort((a, b) => {
    if (sortBy.value === 'passmarkDX12') return b.benchmarks.passmarkDX12 - a.benchmarks.passmarkDX12;
    if (sortBy.value === 'passmarkDX11') return b.benchmarks.passmarkDX11 - a.benchmarks.passmarkDX11;
    if (sortBy.value === 'geekbenchOpenCL') return b.benchmarks.geekbenchOpenCL - a.benchmarks.geekbenchOpenCL;
    if (sortBy.value === 'geekbenchVulkan') return b.benchmarks.geekbenchVulkan - a.benchmarks.geekbenchVulkan;
    if (sortBy.value === 'userbenchmark') return (b.userbenchmark?.score || 0) - (a.userbenchmark?.score || 0);
    if (sortBy.value === 'vastDlperf') return (b.vastai?.dlperf || 0) - (a.vastai?.dlperf || 0);
    if (sortBy.value === 'vastCloudPrice') return (a.vastai?.hourlyRateUSD || 999) - (b.vastai?.hourlyRateUSD || 999);
    if (sortBy.value === 'vram') return b.vramGB - a.vramGB || b.benchmarks.passmarkDX12 - a.benchmarks.passmarkDX12;
    if (sortBy.value === 'value') {
      const valA = a.benchmarks.passmarkDX12 / a.msrpUSD;
      const valB = b.benchmarks.passmarkDX12 / b.msrpUSD;
      return valB - valA;
    }
    return 0;
  });
});

const displayedGpus = computed(() => {
  if (
    showAllGpus.value ||
    searchQuery.value.trim() ||
    selectedBrandFilter.value !== 'ALL' ||
    selectedSeriesFilter.value !== 'ALL' ||
    selectedVramFilter.value > 0
  ) {
    return filteredGpus.value;
  }
  return filteredGpus.value.slice(0, 16);
});

const filteredGames = computed(() => {
  return props.games.filter((game) => {
    if (gameFeatureFilter.value === 'PROTON_TOP') {
      return game.protondb?.tier === 'platinum' || game.protondb?.tier === 'native';
    }
    if (gameFeatureFilter.value === 'UPSCALING') {
      return (game.pcgw?.upscalers?.length || 0) > 0;
    }
    if (gameFeatureFilter.value === 'FRAME_GEN') {
      return Boolean(game.pcgw?.frameGeneration);
    }
    if (gameFeatureFilter.value === 'RAY_TRACING') {
      return Boolean(game.pcgw?.rayTracing);
    }
    return true;
  });
});

const comparedGpus = computed(() =>
  comparedIds.value
    .map((id) => props.gpus.find((g) => g.id === id))
    .filter((g): g is GpuSpec => Boolean(g))
);

const baselineGpu = computed(() => comparedGpus.value[0] || props.gpus[0]);

function getFpsForGpu(gpu: GpuSpec, game: SteamGame) {
  return calculateRelativeFps(gpu, game, selectedResolution.value, selectedQuality.value, {
    upscaling: selectedUpscaling.value,
    frameGen: enableFrameGen.value,
    platform: selectedPlatform.value,
    unlockEngineCap: unlockEngineCap.value,
  });
}

function toggleCompareGpu(id: string) {
  const idx = comparedIds.value.indexOf(id);
  if (idx !== -1) {
    if (comparedIds.value.length > 1) {
      comparedIds.value.splice(idx, 1);
    }
  } else {
    if (comparedIds.value.length >= 4) {
      comparedIds.value.shift();
    }
    comparedIds.value.push(id);
  }
}

function selectGpuForComparator(gpuId: string) {
  if (!comparedIds.value.includes(gpuId)) {
    if (comparedIds.value.length >= 4) {
      comparedIds.value.shift();
    }
    comparedIds.value.push(gpuId);
  }
  compareSearchQuery.value = '';
  isCompareSearchOpen.value = false;
  highlightedIndex.value = 0;
}

function handleCompareSearchKeydown(e: KeyboardEvent) {
  const results = compareSearchResults.value;
  if (!results.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    isCompareSearchOpen.value = true;
    highlightedIndex.value = (highlightedIndex.value + 1) % results.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    isCompareSearchOpen.value = true;
    highlightedIndex.value = (highlightedIndex.value - 1 + results.length) % results.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const chosen = results[highlightedIndex.value] || results[0];
    if (chosen) {
      selectGpuForComparator(chosen.id);
    }
  } else if (e.key === 'Escape') {
    isCompareSearchOpen.value = false;
  }
}

function handleCompareBlur() {
  setTimeout(() => {
    isCompareSearchOpen.value = false;
  }, 180);
}

function removeComparedGpu(id: string) {
  if (comparedIds.value.length > 1) {
    comparedIds.value = comparedIds.value.filter((item) => item !== id);
  }
}

function getBrandBadgeClass(brand: GpuSpec['brand']) {
  if (brand === 'NVIDIA')
    return 'bg-lime-500/10 text-lime-700 dark:text-lime-400 border-lime-500/30';
  if (brand === 'AMD')
    return 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30';
  return 'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30';
}

function getBrandBarClass(brand: GpuSpec['brand']) {
  if (brand === 'NVIDIA') return 'bg-lime-500';
  if (brand === 'AMD') return 'bg-red-500';
  return 'bg-sky-500';
}

function getProtonBadgeClass(tier: ProtonTier) {
  if (tier === 'native')
    return 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50';
  if (tier === 'platinum')
    return 'bg-cyan-400/20 text-cyan-200 border-cyan-300/50';
  if (tier === 'gold')
    return 'bg-amber-400/20 text-amber-300 border-amber-400/50';
  if (tier === 'silver')
    return 'bg-slate-300/20 text-slate-200 border-slate-400/50';
  return 'bg-orange-500/20 text-orange-300 border-orange-400/50';
}

function getDiffPercent(val: number, base: number): string {
  if (!base) return '0%';
  const diff = ((val - base) / base) * 100;
  if (Math.abs(diff) < 0.5) return '0%';
  return `${diff > 0 ? '+' : ''}${Math.round(diff)}%`;
}

function getFpsBadgeColor(fps: number) {
  if (fps >= 120) return 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
  if (fps >= 60) return 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/30';
  if (fps >= 35) return 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30';
  return 'text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/30';
}
</script>

<template>
  <div class="space-y-14">
    <!-- SECCIÓN 1: TABLA TÉCNICA Y RANKING DE BENCHMARKS -->
    <section id="ranking" class="space-y-5">
      <div class="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <div class="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1">
            <span>01 // BENCHMARK DATABASE ({{ filteredGpus.length }} GPUS)</span>
          </div>
          <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Índice Técnico de GPUs & Benchmarks
          </h2>
          <p class="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Especificaciones de <span class="font-mono">gpu-info-api</span> combinadas con puntuaciones de Geekbench 6 Compute y PassMark DirectX 12 / DirectX 11. Selecciona hasta 4 GPUs para comparar.
          </p>
        </div>

        <!-- Controles de filtro y búsqueda -->
        <div class="flex flex-wrap items-center gap-2">
          <!-- Filtro por marca -->
          <div class="inline-flex rounded-lg p-1 bg-slate-200/70 dark:bg-slate-900 border border-slate-300/80 dark:border-slate-800 text-xs font-mono">
            <button
              v-for="brand in (['ALL', 'NVIDIA', 'AMD', 'Intel'] as const)"
              :key="brand"
              type="button"
              @click="selectedBrandFilter = brand; selectedSeriesFilter = 'ALL'"
              :class="[
                'px-3 py-1.5 rounded-md font-semibold transition-all',
                selectedBrandFilter === brand
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
              ]"
            >
              {{ brand === 'ALL' ? 'TODAS' : brand }}
            </button>
          </div>

          <!-- Filtro por Serie (RTX 50, RX 500, RX 400, R9, R7, etc.) -->
          <select
            v-model="selectedSeriesFilter"
            aria-label="Filtrar por Serie de GPU"
            class="px-2.5 py-2 rounded-lg text-xs font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="ALL">Serie: Todas</option>
            <option v-for="serie in availableSeries" :key="serie" :value="serie">
              {{ serie }}
            </option>
          </select>

          <!-- Filtro por VRAM mínima -->
          <select
            v-model.number="selectedVramFilter"
            aria-label="Filtrar por VRAM mínima"
            class="px-2.5 py-2 rounded-lg text-xs font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option :value="0">VRAM: Todas</option>
            <option :value="4">4+ GB VRAM</option>
            <option :value="8">8+ GB VRAM</option>
            <option :value="12">12+ GB VRAM</option>
            <option :value="16">16+ GB VRAM</option>
            <option :value="24">24+ GB VRAM</option>
          </select>

          <!-- Ordenar por -->
          <select
            v-model="sortBy"
            aria-label="Ordenar GPUs por criterio"
            class="px-2.5 py-2 rounded-lg text-xs font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="passmarkDX12">Orden: PassMark DirectX 12</option>
            <option value="passmarkDX11">Orden: PassMark DirectX 11</option>
            <option value="geekbenchOpenCL">Orden: Geekbench 6 OpenCL</option>
            <option value="geekbenchVulkan">Orden: Geekbench 6 Vulkan</option>
            <option value="userbenchmark">Orden: UserBenchmark Speed</option>
            <option value="vastDlperf">Orden: Vast.ai DLPerf (AI/Compute)</option>
            <option value="vastCloudPrice">Orden: Vast.ai Cloud ($/hr)</option>
            <option value="vram">Orden: Capacidad VRAM</option>
            <option value="value">Orden: Calidad / Precio</option>
          </select>

          <!-- Buscador -->
          <div class="relative flex-1 sm:flex-initial sm:w-56">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Buscar GPU o arquitectura..."
              class="w-full pl-8 pr-3 py-2 rounded-lg text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <svg class="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>
      </div>

      <!-- Tabla estilo TechPowerUp / Versus -->
      <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 shadow-sm">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900 text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th class="py-3 px-4 w-12 text-center">VS</th>
              <th class="py-3 px-4">Modelo / Arquitectura</th>
              <th class="py-3 px-4">VRAM / Bus</th>
              <th class="py-3 px-4 min-w-[175px]">PassMark (DX12 / DX11)</th>
              <th class="py-3 px-4 min-w-[165px]">Geekbench 6 (OpenCL)</th>
              <th class="py-3 px-4 min-w-[155px]">Vast.ai DLPerf / Cloud</th>
              <th class="py-3 px-4 text-right">Boost / TDP</th>
              <th class="py-3 px-4 text-right">MSRP</th>
              <th class="py-3 px-4 text-right">Ficha</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200/70 dark:divide-slate-800/80 text-sm">
            <tr
              v-for="(gpu, index) in displayedGpus"
              :key="gpu.id"
              :class="[
                'transition-colors group',
                comparedIds.includes(gpu.id)
                  ? 'bg-blue-50/60 dark:bg-blue-950/25'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/40',
              ]"
            >
              <!-- Botón VS -->
              <td class="py-3 px-4 text-center">
                <button
                  type="button"
                  @click="toggleCompareGpu(gpu.id)"
                  :title="comparedIds.includes(gpu.id) ? 'Quitar del comparador' : 'Añadir al comparador'"
                  :class="[
                    'w-7 h-7 rounded-md font-mono text-xs font-bold border transition-all inline-flex items-center justify-center',
                    comparedIds.includes(gpu.id)
                      ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700 hover:border-blue-500',
                  ]"
                >
                  {{ comparedIds.includes(gpu.id) ? '✓' : '+' }}
                </button>
              </td>

              <!-- Nombre y Marca -->
              <td class="py-3 px-4">
                <div class="flex items-center gap-2.5">
                  <span class="font-mono text-xs text-slate-400 w-6">#{{ index + 1 }}</span>
                  <div>
                    <div class="flex items-center gap-2">
                      <a
                        :href="`/gpu/${gpu.id}`"
                        class="font-bold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      >
                        {{ gpu.name }}
                      </a>
                      <span
                        :class="[
                          'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border',
                          getBrandBadgeClass(gpu.brand),
                        ]"
                      >
                        {{ gpu.brand }}
                      </span>
                    </div>
                    <div class="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                      {{ gpu.architecture }} ({{ gpu.processNm }}nm) • {{ gpu.releaseYear }}
                    </div>
                  </div>
                </div>
              </td>

              <!-- VRAM / Bus -->
              <td class="py-3 px-4 font-mono text-xs">
                <div class="font-semibold text-slate-800 dark:text-slate-200">
                  {{ gpu.vramGB }} GB {{ gpu.memoryType }}
                </div>
                <div class="text-slate-500 dark:text-slate-400">
                  {{ gpu.busWidthBit }}-bit • {{ gpu.memoryBandwidthGBs }} GB/s
                </div>
              </td>

              <!-- PassMark DirectX 12 & DirectX 11 Bar -->
              <td class="py-3 px-4">
                <div class="flex items-center justify-between text-xs font-mono mb-1">
                  <span class="font-bold text-slate-900 dark:text-white">
                    DX12: {{ gpu.benchmarks.passmarkDX12.toLocaleString() }}
                  </span>
                  <span class="text-slate-400 text-[11px]">
                    DX11: {{ gpu.benchmarks.passmarkDX11.toLocaleString() }}
                  </span>
                </div>
                <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    :class="['h-full rounded-full transition-all duration-300', getBrandBarClass(gpu.brand)]"
                    :style="{ width: `${Math.round((gpu.benchmarks.passmarkDX12 / maxPassmarkDX12) * 100)}%` }"
                  ></div>
                </div>
              </td>

              <!-- Geekbench 6 OpenCL Bar -->
              <td class="py-3 px-4">
                <div class="flex items-center justify-between text-xs font-mono mb-1">
                  <span class="font-bold text-slate-900 dark:text-white">{{ gpu.benchmarks.geekbenchOpenCL.toLocaleString() }}</span>
                  <span class="text-slate-400 text-[11px]">VK: {{ (gpu.benchmarks.geekbenchVulkan / 1000).toFixed(0) }}k</span>
                </div>
                <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    class="h-full rounded-full bg-indigo-500 transition-all duration-300"
                    :style="{ width: `${Math.round((gpu.benchmarks.geekbenchOpenCL / maxGeekbenchCL) * 100)}%` }"
                  ></div>
                </div>
              </td>

              <!-- Vast.ai DLPerf & Cloud Price Bar -->
              <td class="py-3 px-4">
                <div v-if="gpu.vastai">
                  <div class="flex items-center justify-between text-xs font-mono mb-1">
                    <span class="font-bold text-cyan-600 dark:text-cyan-400">{{ gpu.vastai.dlperf }} DLP</span>
                    <span class="text-emerald-600 dark:text-emerald-400 font-semibold text-[11px]">
                      ${{ gpu.vastai.hourlyRateUSD.toFixed(2) }}/hr
                    </span>
                  </div>
                  <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      class="h-full rounded-full bg-cyan-500 transition-all duration-300"
                      :style="{ width: `${Math.round((gpu.vastai.dlperf / maxVastDlperf) * 100)}%` }"
                    ></div>
                  </div>
                </div>
                <span v-else class="text-xs font-mono text-slate-400">N/A</span>
              </td>

              <!-- Clocks & TDP -->
              <td class="py-3 px-4 text-right font-mono text-xs">
                <div class="text-slate-800 dark:text-slate-200 font-semibold">{{ gpu.boostClockMHz }} MHz</div>
                <div class="text-slate-500 dark:text-slate-400">{{ gpu.tdpWatts }} W TDP</div>
              </td>

              <!-- Precio -->
              <td class="py-3 px-4 text-right font-mono">
                <span class="text-sm font-bold text-slate-900 dark:text-white">${{ gpu.msrpUSD }}</span>
                <div class="text-[10px] text-slate-500">
                  {{ (gpu.benchmarks.passmarkDX12 / gpu.msrpUSD).toFixed(2) }} DX12/$
                </div>
              </td>

              <!-- Enlace a página individual -->
              <td class="py-3 px-4 text-right">
                <a
                  :href="`/gpu/${gpu.id}`"
                  class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-blue-600 hover:text-white dark:hover:bg-blue-600 dark:hover:text-white transition-colors"
                >
                  Specs
                  <span>→</span>
                </a>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Botón para expandir las 40 GPUs -->
        <div
          v-if="filteredGpus.length > 16 && !searchQuery.trim() && selectedBrandFilter === 'ALL' && selectedVramFilter === 0"
          class="p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 text-center"
        >
          <button
            type="button"
            @click="showAllGpus = !showAllGpus"
            class="px-4 py-1.5 rounded-lg text-xs font-mono font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 transition-colors"
          >
            {{ showAllGpus ? '▲ Mostrar Top 16 GPUs' : `▼ Mostrar las ${filteredGpus.length} GPUs del catálogo completo` }}
          </button>
        </div>
      </div>
    </section>

    <!-- SECCIÓN 2: COMPARADOR LADO A LADO (1 VS 1 HASTA 4 GPUS) -->
    <section id="comparador" class="space-y-6 scroll-mt-20">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <div class="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1">
            <span>02 // HEAD-TO-HEAD COMPARATOR</span>
          </div>
          <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Comparador Técnico Lado a Lado
          </h2>
          <p class="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Compara especificaciones de arquitectura, memoria, consumo y diferencias porcentuales tomando la primera GPU como referencia (<span class="font-mono font-semibold">{{ baselineGpu.name }} = 100%</span>).
          </p>
        </div>

        <!-- Buscador difuso con Fuse.js para añadir GPU al comparador -->
        <div class="relative w-full md:w-96">
          <label class="block text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1">
            Buscar y añadir GPU al comparador (Fuse.js)
          </label>
          <div class="relative">
            <input
              v-model="compareSearchQuery"
              type="text"
              placeholder="Ej: 4070 super, rx 580, r9 390, b580..."
              @focus="isCompareSearchOpen = true; highlightedIndex = 0"
              @input="isCompareSearchOpen = true; highlightedIndex = 0"
              @keydown="handleCompareSearchKeydown"
              @blur="handleCompareBlur"
              class="w-full pl-9 pr-16 py-2.5 rounded-xl text-xs font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <svg
              class="w-4 h-4 text-blue-500 absolute left-3 top-1/2 -translate-y-1/2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200 dark:border-slate-700">
              {{ comparedIds.length }}/4 VS
            </span>
          </div>

          <!-- Dropdown de resultados difusos de Fuse.js -->
          <div
            v-if="isCompareSearchOpen && compareSearchResults.length > 0"
            class="absolute z-40 mt-1.5 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800"
          >
            <button
              v-for="(item, idx) in compareSearchResults"
              :key="item.id"
              type="button"
              @mousedown.prevent="selectGpuForComparator(item.id)"
              @mouseenter="highlightedIndex = idx"
              :class="[
                'w-full px-3.5 py-2.5 text-left flex items-center justify-between gap-2 transition-colors',
                idx === highlightedIndex
                  ? 'bg-blue-50 dark:bg-blue-950/50'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
              ]"
            >
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    :class="[
                      'text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border shrink-0',
                      getBrandBadgeClass(item.brand),
                    ]"
                  >
                    {{ item.brand }}
                  </span>
                  <span class="text-xs font-bold text-slate-900 dark:text-white truncate">
                    {{ item.name }}
                  </span>
                </div>
                <div class="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                  {{ item.vramGB }}GB {{ item.memoryType }} • {{ item.series }} • DX12: {{ item.benchmarks.passmarkDX12.toLocaleString() }}
                </div>
              </div>

              <span
                :class="[
                  'text-[10px] font-mono font-bold px-2 py-1 rounded shrink-0',
                  comparedIds.includes(item.id)
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-blue-600 text-white',
                ]"
              >
                {{ comparedIds.includes(item.id) ? '✓ Activa' : '+ Añadir' }}
              </span>
            </button>
          </div>
        </div>
      </div>

      <!-- Tarjetas de cabecera de las GPUs comparadas -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          v-for="(gpu, idx) in comparedGpus"
          :key="gpu.id"
          class="relative rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm flex flex-col justify-between"
        >
          <div>
            <div class="flex items-center justify-between gap-2 mb-2">
              <span
                :class="[
                  'text-[10px] font-mono font-bold px-2 py-0.5 rounded border',
                  getBrandBadgeClass(gpu.brand),
                ]"
              >
                {{ gpu.brand }} • {{ idx === 0 ? 'BASE (100%)' : `VS #${idx + 1}` }}
              </span>
              <button
                v-if="comparedGpus.length > 1"
                type="button"
                @click="removeComparedGpu(gpu.id)"
                class="text-xs font-mono text-slate-400 hover:text-rose-500 transition-colors"
                title="Quitar GPU"
              >
                ✕ Quitar
              </button>
            </div>

            <a :href="`/gpu/${gpu.id}`" class="text-lg font-bold text-slate-900 dark:text-white hover:text-blue-500 transition-colors block">
              {{ gpu.name }}
            </a>
            <p class="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">
              {{ gpu.series }} • {{ gpu.architecture }}
            </p>
          </div>

          <div class="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 grid grid-cols-2 gap-2 text-xs font-mono">
            <div>
              <span class="text-slate-400 block text-[10px]">ÍNDICE GLOBAL</span>
              <span class="font-bold text-slate-900 dark:text-white">
                {{ getCompositeGpuScore(gpu).toLocaleString() }} pts
              </span>
            </div>
            <div class="text-right">
              <span class="text-slate-400 block text-[10px]">DIFERENCIA</span>
              <span
                :class="[
                  'font-bold',
                  idx === 0
                    ? 'text-slate-500'
                    : getCompositeGpuScore(gpu) >= getCompositeGpuScore(baselineGpu)
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400',
                ]"
              >
                {{ idx === 0 ? 'Referencia' : getDiffPercent(getCompositeGpuScore(gpu), getCompositeGpuScore(baselineGpu)) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabla comparativa detallada lado a lado -->
      <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-xs font-mono text-slate-500 dark:text-slate-400">
              <th class="py-3 px-4 w-52">Métrica / Especificación</th>
              <th v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 font-bold text-slate-900 dark:text-white">
                {{ gpu.name }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200/70 dark:divide-slate-800/80 font-mono text-xs">
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">PassMark DirectX 12 Benchmark</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <span class="font-bold text-slate-900 dark:text-white">{{ gpu.benchmarks.passmarkDX12.toLocaleString() }}</span>
                <span
                  v-if="i > 0"
                  :class="[
                    'ml-2 px-1.5 py-0.5 rounded text-[10px]',
                    gpu.benchmarks.passmarkDX12 >= baselineGpu.benchmarks.passmarkDX12
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                  ]"
                >
                  {{ getDiffPercent(gpu.benchmarks.passmarkDX12, baselineGpu.benchmarks.passmarkDX12) }}
                </span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">PassMark DirectX 11 Benchmark</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <span class="font-bold text-slate-900 dark:text-white">{{ gpu.benchmarks.passmarkDX11.toLocaleString() }}</span>
                <span
                  v-if="i > 0"
                  :class="[
                    'ml-2 px-1.5 py-0.5 rounded text-[10px]',
                    gpu.benchmarks.passmarkDX11 >= baselineGpu.benchmarks.passmarkDX11
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                  ]"
                >
                  {{ getDiffPercent(gpu.benchmarks.passmarkDX11, baselineGpu.benchmarks.passmarkDX11) }}
                </span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Geekbench 6 OpenCL</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <span class="font-bold text-slate-900 dark:text-white">{{ gpu.benchmarks.geekbenchOpenCL.toLocaleString() }}</span>
                <span
                  v-if="i > 0"
                  :class="[
                    'ml-2 px-1.5 py-0.5 rounded text-[10px]',
                    gpu.benchmarks.geekbenchOpenCL >= baselineGpu.benchmarks.geekbenchOpenCL
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                  ]"
                >
                  {{ getDiffPercent(gpu.benchmarks.geekbenchOpenCL, baselineGpu.benchmarks.geekbenchOpenCL) }}
                </span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Geekbench 6 Vulkan</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <span class="font-bold text-slate-900 dark:text-white">{{ gpu.benchmarks.geekbenchVulkan.toLocaleString() }}</span>
                <span
                  v-if="i > 0"
                  :class="[
                    'ml-2 px-1.5 py-0.5 rounded text-[10px]',
                    gpu.benchmarks.geekbenchVulkan >= baselineGpu.benchmarks.geekbenchVulkan
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                  ]"
                >
                  {{ getDiffPercent(gpu.benchmarks.geekbenchVulkan, baselineGpu.benchmarks.geekbenchVulkan) }}
                </span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">TechPowerUp Relative Perf.</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <template v-if="gpu.techpowerup">
                  <span class="font-bold text-amber-600 dark:text-amber-400">{{ gpu.techpowerup.relativePerformancePct }}%</span>
                  <span class="text-slate-400 ml-1 text-[11px]">({{ gpu.techpowerup.shadersTmusRops }})</span>
                  <span
                    v-if="i > 0 && baselineGpu.techpowerup"
                    :class="[
                      'ml-1.5 px-1.5 py-0.5 rounded text-[10px]',
                      gpu.techpowerup.relativePerformancePct >= baselineGpu.techpowerup.relativePerformancePct
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                    ]"
                  >
                    {{ getDiffPercent(gpu.techpowerup.relativePerformancePct, baselineGpu.techpowerup.relativePerformancePct) }}
                  </span>
                </template>
                <span v-else class="text-slate-400">N/A</span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Tom's Hardware (1080p / 1440p / 4K Ultra)</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <template v-if="gpu.tomshardware?.rasterization">
                  <span class="font-bold text-slate-900 dark:text-white">
                    {{ gpu.tomshardware.rasterization['1080p']?.fps ?? '-' }} /
                    {{ gpu.tomshardware.rasterization['1440p']?.fps ?? '-' }} /
                    {{ gpu.tomshardware.rasterization['4K']?.fps ?? '-' }} FPS
                  </span>
                  <span
                    v-if="i > 0 && baselineGpu.tomshardware?.rasterization?.['1440p'] && gpu.tomshardware.rasterization['1440p']"
                    :class="[
                      'ml-1.5 px-1.5 py-0.5 rounded text-[10px]',
                      gpu.tomshardware.rasterization['1440p'].fps >= baselineGpu.tomshardware.rasterization['1440p'].fps
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                    ]"
                  >
                    {{ getDiffPercent(gpu.tomshardware.rasterization['1440p'].fps, baselineGpu.tomshardware.rasterization['1440p'].fps) }}
                  </span>
                </template>
                <span v-else class="text-slate-400">N/A</span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Tom's Hardware Ray Tracing (1080p / 1440p / 4K)</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                <template v-if="gpu.tomshardware?.rayTracing">
                  <span class="font-semibold text-rose-600 dark:text-rose-400">
                    {{ gpu.tomshardware.rayTracing['1080p']?.fps ?? '-' }} /
                    {{ gpu.tomshardware.rayTracing['1440p']?.fps ?? '-' }} /
                    {{ gpu.tomshardware.rayTracing['4K']?.fps ?? '-' }} FPS
                  </span>
                  <span class="text-slate-400 ml-1 text-[11px]">
                    ({{ gpu.tomshardware.rayTracing['1440p']?.relativePct ?? '-' }}% Rel.)
                  </span>
                </template>
                <span v-else class="text-slate-400">N/A</span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">UserBenchmark (Effective Speed)</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <template v-if="gpu.userbenchmark">
                  <a
                    :href="gpu.userbenchmark.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="font-bold text-amber-600 dark:text-amber-400 hover:underline"
                  >
                    {{ gpu.userbenchmark.score }}%
                  </a>
                  <span class="text-slate-400 ml-1 text-[11px]">(#{{ gpu.userbenchmark.rank }})</span>
                  <span
                    v-if="i > 0 && baselineGpu.userbenchmark"
                    :class="[
                      'ml-1.5 px-1.5 py-0.5 rounded text-[10px]',
                      gpu.userbenchmark.score >= baselineGpu.userbenchmark.score
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                    ]"
                  >
                    {{ getDiffPercent(gpu.userbenchmark.score, baselineGpu.userbenchmark.score) }}
                  </span>
                </template>
                <span v-else class="text-slate-400">N/A</span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Vast.ai DLPerf (AI / Compute)</td>
              <td v-for="(gpu, i) in comparedGpus" :key="gpu.id" class="py-3 px-4">
                <template v-if="gpu.vastai && baselineGpu.vastai">
                  <span class="font-bold text-cyan-600 dark:text-cyan-400">{{ gpu.vastai.dlperf }} DLP</span>
                  <span
                    v-if="i > 0"
                    :class="[
                      'ml-2 px-1.5 py-0.5 rounded text-[10px]',
                      gpu.vastai.dlperf >= baselineGpu.vastai.dlperf
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                    ]"
                  >
                    {{ getDiffPercent(gpu.vastai.dlperf, baselineGpu.vastai.dlperf) }}
                  </span>
                </template>
                <span v-else class="text-slate-400">N/A</span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Vast.ai Tarifa Cloud ($/hr)</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                <template v-if="gpu.vastai">
                  <span class="font-bold text-emerald-600 dark:text-emerald-400">${{ gpu.vastai.hourlyRateUSD.toFixed(2) }}/hr</span>
                  <span class="text-slate-400 ml-1">({{ gpu.vastai.dlperfPerDollar }} DLP/$ • {{ gpu.vastai.availableOffers }} nodos)</span>
                </template>
                <span v-else class="text-slate-400">N/A</span>
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Potencia FP32 (TFLOPS)</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                {{ gpu.tflopsFP32 }} TFLOPS
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Memoria VRAM</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                {{ gpu.vramGB }} GB {{ gpu.memoryType }} ({{ gpu.busWidthBit }}-bit)
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Ancho de Banda</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                {{ gpu.memoryBandwidthGBs }} GB/s
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Frecuencia Base / Boost</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                {{ gpu.baseClockMHz }} / {{ gpu.boostClockMHz }} MHz
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Núcleos / Shaders</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                {{ gpu.cores.toLocaleString() }} unidades
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Consumo Energético (TDP)</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 text-slate-800 dark:text-slate-200">
                {{ gpu.tdpWatts }} W ({{ (gpu.benchmarks.passmarkDX12 / gpu.tdpWatts).toFixed(2) }} DX12/W)
              </td>
            </tr>
            <tr>
              <td class="py-3 px-4 font-sans font-medium text-slate-600 dark:text-slate-400">Precio Lanzamiento / Actual</td>
              <td v-for="gpu in comparedGpus" :key="gpu.id" class="py-3 px-4 font-bold text-slate-900 dark:text-white">
                ${{ gpu.msrpUSD }} USD
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- SECCIÓN 3: ESTIMADOR DE FPS POR JUEGO (STEAM API + PCGAMINGWIKI CARGO + PROTONDB) -->
    <section id="fps-estimator" class="space-y-6 scroll-mt-20">
      <div class="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <div class="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1">
            <span>03 // STEAM API + PCGAMINGWIKI CARGO + PROTONDB ENGINE</span>
          </div>
          <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Estimador de FPS, Escalado (DLSS/FSR/XeSS) y ProtonDB
          </h2>
          <p class="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Integra datos técnicos de <strong>PCGamingWiki Cargo</strong> (APIs DirectX 12/Vulkan, DLSS/FSR/XeSS, Frame Generation, límites de FPS del motor) y el estado de compatibilidad en Linux/SteamOS de <strong>ProtonDB</strong>.
          </p>
        </div>

        <!-- Filtros rápidos por características de PCGamingWiki / ProtonDB -->
        <div class="flex flex-wrap items-center gap-1.5 text-xs font-mono">
          <button
            v-for="f in ([
              { k: 'ALL', l: `Todos (${games.length})` },
              { k: 'PROTON_TOP', l: '🐧 Proton Platinum/Native' },
              { k: 'UPSCALING', l: '✨ Con DLSS/FSR/XeSS' },
              { k: 'FRAME_GEN', l: '🚀 Con Frame Gen' },
              { k: 'RAY_TRACING', l: '💎 Con Ray Tracing' },
            ] as const)"
            :key="f.k"
            type="button"
            @click="gameFeatureFilter = f.k"
            :class="[
              'px-2.5 py-1.5 rounded-lg border transition-colors',
              gameFeatureFilter === f.k
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-950 border-slate-900 dark:border-white font-bold'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-800 hover:border-blue-500',
            ]"
          >
            {{ f.l }}
          </button>
        </div>
      </div>

      <!-- Barra de Controles Técnicos: Resolución, Calidad, Upscaling (PCGW), Frame Gen y SO (ProtonDB) -->
      <div class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/90 shadow-sm grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <!-- 1. Resolución -->
        <div>
          <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1.5">Resolución de Salida</span>
          <div class="inline-flex w-full rounded-lg p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono">
            <button
              v-for="res in (['1080p', '1440p', '4K'] as const)"
              :key="res"
              type="button"
              @click="selectedResolution = res"
              :class="[
                'flex-1 py-1.5 rounded-md font-bold transition-all text-center',
                selectedResolution === res
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
              ]"
            >
              {{ res }}
            </button>
          </div>
        </div>

        <!-- 2. Calidad Gráfica -->
        <div>
          <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1.5">Preset Gráfico</span>
          <div class="inline-flex w-full rounded-lg p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono">
            <button
              v-for="q in ([
                { key: 'low', label: 'Bajo' },
                { key: 'medium', label: 'Medio' },
                { key: 'high', label: 'Alto' },
                { key: 'ultra', label: 'Ultra' },
              ] as const)"
              :key="q.key"
              type="button"
              @click="selectedQuality = q.key"
              :class="[
                'flex-1 py-1.5 rounded-md font-semibold transition-all text-center',
                selectedQuality === q.key
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
              ]"
            >
              {{ q.label }}
            </button>
          </div>
        </div>

        <!-- 3. Escalado PCGamingWiki (DLSS / FSR / XeSS) -->
        <div>
          <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1.5">Upscaling (PCGamingWiki)</span>
          <select
            v-model="selectedUpscaling"
            aria-label="Modo de Escalado DLSS FSR XeSS"
            class="w-full px-3 py-2 rounded-lg text-xs font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-semibold"
          >
            <option value="off">Nativo (TAA / Sin Escalado)</option>
            <option value="quality">Calidad (DLSS / FSR / XeSS)</option>
            <option value="balanced">Equilibrado (DLSS / FSR / XeSS)</option>
            <option value="performance">Rendimiento (DLSS / FSR / XeSS)</option>
          </select>
        </div>

        <!-- 4. Plataforma (Windows vs Linux ProtonDB) -->
        <div>
          <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1.5">Entorno / Plataforma</span>
          <div class="inline-flex w-full rounded-lg p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono">
            <button
              type="button"
              @click="selectedPlatform = 'windows'"
              :class="[
                'flex-1 py-1.5 rounded-md font-semibold transition-all text-center',
                selectedPlatform === 'windows'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400',
              ]"
            >
              Windows
            </button>
            <button
              type="button"
              @click="selectedPlatform = 'linux'"
              :class="[
                'flex-1 py-1.5 rounded-md font-semibold transition-all text-center',
                selectedPlatform === 'linux'
                  ? 'bg-amber-500 text-slate-950 shadow-sm font-bold'
                  : 'text-slate-600 dark:text-slate-400',
              ]"
            >
              🐧 ProtonDB
            </button>
          </div>
        </div>

        <!-- 5. Opciones avanzadas PCGamingWiki (Frame Generation + Engine Cap) -->
        <div class="flex flex-col justify-center gap-1.5 font-mono text-xs">
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              v-model="enableFrameGen"
              type="checkbox"
              class="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500"
            />
            <span class="text-slate-700 dark:text-slate-300 font-medium">Frame Generation (FG)</span>
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              v-model="unlockEngineCap"
              type="checkbox"
              class="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500"
            />
            <span class="text-slate-700 dark:text-slate-300 font-medium">Ignorar Cap Motor (PCGW)</span>
          </label>
        </div>
      </div>

      <!-- Grid de Juegos de Steam con telemetría de PCGamingWiki Cargo + ProtonDB -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <article
          v-for="game in filteredGames"
          :key="game.id"
          class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden shadow-sm flex flex-col justify-between"
        >
          <div>
            <!-- Cabecera con imagen oficial de Steam API + Badges de ProtonDB -->
            <div class="relative h-40 bg-slate-900 overflow-hidden">
              <img
                :src="game.headerImage"
                :alt="game.name"
                loading="lazy"
                class="w-full h-full object-cover opacity-85 hover:scale-105 transition-transform duration-500"
              />
              <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/50 to-transparent"></div>

              <!-- Top Badges: ProtonDB Tier + Enlace PCGamingWiki -->
              <div class="absolute top-3 left-3 right-3 flex items-center justify-between gap-2">
                <a
                  v-if="game.protondb"
                  :href="`https://www.protondb.com/app/${game.steamAppId}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  :class="[
                    'text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border backdrop-blur-md transition-transform hover:scale-105',
                    getProtonBadgeClass(game.protondb.tier),
                  ]"
                  :title="`ProtonDB Score: ${Math.round(game.protondb.score * 100)}% (${game.protondb.totalReports} reportes en Linux/SteamOS)`"
                >
                  🐧 ProtonDB: {{ game.protondb.tier }} ({{ game.protondb.totalReports.toLocaleString() }} reps)
                </a>

                <a
                  v-if="game.pcgw?.wikiPage"
                  :href="`https://www.pcgamingwiki.com/wiki/${game.pcgw.wikiPage}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-900/85 text-sky-300 border border-sky-500/30 hover:bg-sky-600 hover:text-white transition-colors"
                >
                  PCGamingWiki ↗
                </a>
              </div>

              <div class="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-2">
                <div>
                  <span class="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-slate-900/80 text-slate-300 border border-slate-700">
                    AppID {{ game.steamAppId }} • {{ game.engine }}
                  </span>
                  <h3 class="text-lg font-bold text-white mt-1 leading-tight">
                    {{ game.name }}
                  </h3>
                </div>
                <span class="text-xs font-mono font-semibold px-2 py-1 rounded bg-blue-600/90 text-white shrink-0">
                  {{ selectedResolution }} • {{ selectedQuality.toUpperCase() }}
                </span>
              </div>
            </div>

            <!-- Fila de capacidades técnicas extraídas de PCGamingWiki Cargo -->
            <div class="px-4 py-2 bg-slate-100/80 dark:bg-slate-950/80 border-b border-slate-200/70 dark:border-slate-800 flex flex-wrap items-center justify-between gap-1.5 text-[10px] font-mono">
              <div class="flex flex-wrap items-center gap-1">
                <!-- APIs Gráficas -->
                <span
                  v-for="api in game.pcgw?.graphicsApis"
                  :key="api"
                  class="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold"
                >
                  {{ api }}
                </span>

                <!-- Upscalers soportados -->
                <span
                  v-for="up in game.pcgw?.upscalers"
                  :key="up"
                  class="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30 font-semibold"
                >
                  {{ up }}
                </span>

                <!-- Frame Generation -->
                <span
                  v-if="game.pcgw?.frameGeneration"
                  class="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30 font-semibold"
                >
                  Frame Gen
                </span>

                <!-- Ray Tracing -->
                <span
                  v-if="game.pcgw?.rayTracing"
                  class="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-semibold"
                >
                  {{ game.pcgw.pathTracing ? 'Path Tracing' : 'Ray Tracing' }}
                </span>

                <!-- HDR / Ultrawide -->
                <span
                  v-if="game.pcgw?.hdr"
                  class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300"
                >
                  HDR
                </span>
                <span
                  v-if="game.pcgw?.ultrawide"
                  class="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-300"
                >
                  21:9
                </span>
              </div>

              <!-- Aviso de Límite de FPS del Motor según PCGamingWiki -->
              <span
                v-if="game.pcgw?.engineFrameCap"
                class="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 font-semibold"
                title="Límite de FPS nativo del motor reportado en PCGamingWiki"
              >
                🔒 Cap Motor: {{ game.pcgw.engineFrameCap }} FPS
              </span>
            </div>

            <!-- Requisito recomendado de referencia en Steam -->
            <div class="px-4 py-2 bg-slate-50 dark:bg-slate-900 border-b border-slate-200/70 dark:border-slate-800 text-[11px] font-mono text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span class="truncate">Rec. Steam: <strong class="text-slate-700 dark:text-slate-300">{{ game.recommendedGpuName }}</strong></span>
              <span class="shrink-0 ml-2">VRAM Base: {{ game.recommendedVramGB }}GB</span>
            </div>

            <!-- Barras de FPS para cada GPU en el comparador -->
            <div class="p-4 space-y-3">
              <div
                v-for="gpu in comparedGpus"
                :key="gpu.id"
                class="space-y-1"
              >
                <div class="flex items-center justify-between text-xs gap-2">
                  <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                    <span class="font-semibold text-slate-900 dark:text-white truncate">{{ gpu.name }}</span>

                    <!-- Badge de Upscaler Activo -->
                    <span
                      v-if="getFpsForGpu(gpu, game).activeUpscaler"
                      class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-500/30"
                    >
                      {{ getFpsForGpu(gpu, game).activeUpscaler }}
                    </span>

                    <!-- Badge de Frame Gen Activo -->
                    <span
                      v-if="getFpsForGpu(gpu, game).frameGenActive"
                      class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30"
                    >
                      +FG
                    </span>

                    <!-- Badge de Límite de VRAM -->
                    <span
                      v-if="getFpsForGpu(gpu, game).vramLimited"
                      class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
                      title="La VRAM de esta GPU es inferior a la demandada por esta resolución/calidad"
                    >
                      ⚠️ VRAM ({{ gpu.vramGB }}GB)
                    </span>

                    <!-- Badge de Límite de Motor alcanzado -->
                    <span
                      v-if="getFpsForGpu(gpu, game).cappedByEngine"
                      class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                      title="El rendimiento alcanza el límite nativo de FPS del motor reportado por PCGamingWiki"
                    >
                      🔒 Cap
                    </span>
                  </div>

                  <div class="flex items-center gap-2 font-mono shrink-0">
                    <span class="text-[11px] text-slate-400">
                      1% Low: {{ getFpsForGpu(gpu, game).onePercentLow }}
                    </span>
                    <span
                      :class="[
                        'px-2 py-0.5 rounded font-bold border text-xs',
                        getFpsBadgeColor(getFpsForGpu(gpu, game).avgFps),
                      ]"
                    >
                      {{ getFpsForGpu(gpu, game).avgFps }} FPS
                    </span>
                  </div>
                </div>

                <!-- Barra de progreso de FPS (escala sobre 200 FPS) -->
                <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    :class="['h-full rounded-full transition-all duration-300', getBrandBarClass(gpu.brand)]"
                    :style="{
                      width: `${Math.min(
                        100,
                        Math.round((getFpsForGpu(gpu, game).avgFps / 200) * 100)
                      )}%`,
                    }"
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
