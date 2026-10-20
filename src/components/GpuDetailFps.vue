<script setup lang="ts">
import { ref, computed } from 'vue';
import type {
  GpuSpec,
  SteamGame,
  ResolutionKey,
  QualityPreset,
  UpscalingMode,
  TargetPlatform,
  ProtonTier,
} from '../utils/fpsCalculator';
import { calculateRelativeFps } from '../utils/fpsCalculator';

const props = defineProps<{
  gpu: GpuSpec;
  allGpus: GpuSpec[];
  games: SteamGame[];
}>();

const resolution = ref<ResolutionKey>('1440p');
const quality = ref<QualityPreset>('high');
const upscaling = ref<UpscalingMode>('off');
const frameGen = ref<boolean>(false);
const platform = ref<TargetPlatform>('windows');
const rivalGpuId = ref<string>(
  props.gpu.id === 'rtx-4070-super' ? 'rx-7800-xt' : 'rtx-4070-super'
);

const rivalGpu = computed(
  () => props.allGpus.find((g) => g.id === rivalGpuId.value) || props.allGpus[0]
);

function calcFps(targetGpu: GpuSpec, game: SteamGame) {
  return calculateRelativeFps(targetGpu, game, resolution.value, quality.value, {
    upscaling: upscaling.value,
    frameGen: frameGen.value,
    platform: platform.value,
  });
}

function getFpsTierBadge(fps: number) {
  if (fps >= 120)
    return {
      label: '120+ FPS Competitivo',
      cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    };
  if (fps >= 60)
    return {
      label: '60+ FPS Fluido',
      cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    };
  if (fps >= 35)
    return {
      label: '35-59 FPS Jugable',
      cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    };
  return {
    label: '<35 FPS Exigente',
    cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30',
  };
}

function getProtonTierColor(tier: ProtonTier) {
  if (tier === 'native' || tier === 'platinum')
    return 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/30';
  if (tier === 'gold')
    return 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30';
  return 'text-slate-600 dark:text-slate-400 bg-slate-500/10 border-slate-500/30';
}
</script>

<template>
  <div class="space-y-6">
    <!-- Barra de configuración de prueba (Resolución, Calidad, Escalado PCGW, Plataforma ProtonDB y Rival) -->
    <div class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
      <div>
        <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1">Resolución</span>
        <div class="inline-flex w-full rounded-lg p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono">
          <button
            v-for="res in (['1080p', '1440p', '4K'] as const)"
            :key="res"
            type="button"
            @click="resolution = res"
            :class="[
              'flex-1 py-1.5 rounded font-bold transition-colors',
              resolution === res
                ? 'bg-blue-600 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
            ]"
          >
            {{ res }}
          </button>
        </div>
      </div>

      <div>
        <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1">Preset Gráfico</span>
        <div class="inline-flex w-full rounded-lg p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono">
          <button
            v-for="q in ([
              { k: 'low', l: 'Bajo' },
              { k: 'medium', l: 'Medio' },
              { k: 'high', l: 'Alto' },
              { k: 'ultra', l: 'Ultra' },
            ] as const)"
            :key="q.k"
            type="button"
            @click="quality = q.k"
            :class="[
              'flex-1 py-1.5 rounded font-semibold transition-colors',
              quality === q.k
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
            ]"
          >
            {{ q.l }}
          </button>
        </div>
      </div>

      <div>
        <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1">Escalado (PCGamingWiki)</span>
        <select
          v-model="upscaling"
          class="w-full px-3 py-2 rounded-lg text-xs font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
        >
          <option value="off">Nativo (TAA)</option>
          <option value="quality">Calidad (DLSS / FSR / XeSS)</option>
          <option value="balanced">Equilibrado (DLSS / FSR / XeSS)</option>
          <option value="performance">Rendimiento (DLSS / FSR / XeSS)</option>
        </select>
      </div>

      <div>
        <span class="block text-[10px] font-mono uppercase text-slate-400 mb-1">Plataforma & Frame Gen</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="platform = platform === 'windows' ? 'linux' : 'windows'"
            :class="[
              'flex-1 py-2 px-2.5 rounded-lg text-xs font-mono font-semibold border transition-colors',
              platform === 'linux'
                ? 'bg-amber-500 text-slate-950 border-amber-500'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
            ]"
          >
            {{ platform === 'windows' ? '🪟 Windows' : '🐧 ProtonDB' }}
          </button>
          <button
            type="button"
            @click="frameGen = !frameGen"
            :class="[
              'py-2 px-2.5 rounded-lg text-xs font-mono font-semibold border transition-colors',
              frameGen
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
            ]"
            title="Activar Frame Generation si el juego y GPU lo soportan"
          >
            +FG
          </button>
        </div>
      </div>

      <!-- Comparar contra otra GPU en esta misma página -->
      <div>
        <label class="block text-[10px] font-mono uppercase text-slate-400 mb-1">
          Comparar frente a:
        </label>
        <select
          v-model="rivalGpuId"
          class="w-full px-3 py-2 rounded-lg text-xs font-mono bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
        >
          <option
            v-for="item in allGpus.filter((g) => g.id !== gpu.id)"
            :key="item.id"
            :value="item.id"
          >
            {{ item.name }} ({{ item.vramGB }}GB)
          </option>
        </select>
      </div>
    </div>

    <!-- Tarjetas de FPS por juego con metadatos de PCGamingWiki y ProtonDB -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div
        v-for="game in games"
        :key="game.id"
        class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 flex flex-col justify-between gap-3"
      >
        <div class="flex items-start gap-3.5">
          <img
            :src="game.headerImage"
            :alt="game.name"
            loading="lazy"
            class="w-28 h-16 object-cover rounded-lg border border-slate-200 dark:border-slate-800 shrink-0"
          />
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-bold text-slate-900 dark:text-white truncate">{{ game.name }}</h4>
              <span
                :class="[
                  'text-[10px] font-mono px-2 py-0.5 rounded border shrink-0',
                  getFpsTierBadge(calcFps(gpu, game).avgFps).cls,
                ]"
              >
                {{ getFpsTierBadge(calcFps(gpu, game).avgFps).label }}
              </span>
            </div>

            <!-- Badges PCGamingWiki + ProtonDB -->
            <div class="flex flex-wrap items-center gap-1 mt-1.5 text-[10px] font-mono">
              <span
                v-if="game.protondb"
                :class="['px-1.5 py-0.2 rounded border uppercase font-semibold', getProtonTierColor(game.protondb.tier)]"
              >
                🐧 {{ game.protondb.tier }}
              </span>
              <span
                v-for="api in game.pcgw?.graphicsApis"
                :key="api"
                class="px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                {{ api }}
              </span>
              <span
                v-for="up in game.pcgw?.upscalers"
                :key="up"
                class="px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
              >
                {{ up }}
              </span>
              <span
                v-if="game.pcgw?.engineFrameCap"
                class="px-1.5 py-0.2 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400"
              >
                🔒 Cap {{ game.pcgw.engineFrameCap }}
              </span>
            </div>
          </div>
        </div>

        <!-- Comparación de barras de FPS: GPU actual vs Rival -->
        <div class="space-y-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80 font-mono text-xs">
          <!-- GPU Actual -->
          <div>
            <div class="flex justify-between mb-1">
              <div class="flex items-center gap-1.5">
                <span class="font-bold text-blue-600 dark:text-blue-400">{{ gpu.name }}</span>
                <span
                  v-if="calcFps(gpu, game).activeUpscaler"
                  class="text-[10px] px-1 rounded bg-indigo-500/15 text-indigo-500"
                >
                  {{ calcFps(gpu, game).activeUpscaler }}
                </span>
                <span
                  v-if="calcFps(gpu, game).frameGenActive"
                  class="text-[10px] px-1 rounded bg-purple-500/15 text-purple-500"
                >
                  +FG
                </span>
              </div>
              <span>
                <strong>{{ calcFps(gpu, game).avgFps }} FPS</strong>
                <span class="text-slate-400 ml-1.5">
                  (1% Low: {{ calcFps(gpu, game).onePercentLow }})
                </span>
              </span>
            </div>
            <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                class="h-full rounded-full bg-blue-600 transition-all duration-300"
                :style="{
                  width: `${Math.min(100, Math.round((calcFps(gpu, game).avgFps / 200) * 100))}%`,
                }"
              ></div>
            </div>
          </div>

          <!-- GPU Rival -->
          <div v-if="rivalGpu">
            <div class="flex justify-between mb-1 text-slate-500 dark:text-slate-400">
              <div class="flex items-center gap-1.5">
                <span>{{ rivalGpu.name }}</span>
                <span
                  v-if="calcFps(rivalGpu, game).activeUpscaler"
                  class="text-[10px] px-1 rounded bg-slate-200 dark:bg-slate-800"
                >
                  {{ calcFps(rivalGpu, game).activeUpscaler }}
                </span>
              </div>
              <span>
                <strong>{{ calcFps(rivalGpu, game).avgFps }} FPS</strong>
                <span class="text-[11px] ml-1.5">
                  (1% Low: {{ calcFps(rivalGpu, game).onePercentLow }})
                </span>
              </span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                class="h-full rounded-full bg-slate-400 dark:bg-slate-600 transition-all duration-300"
                :style="{
                  width: `${Math.min(100, Math.round((calcFps(rivalGpu, game).avgFps / 200) * 100))}%`,
                }"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
