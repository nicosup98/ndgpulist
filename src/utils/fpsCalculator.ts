export interface GpuBenchmarks {
  geekbenchOpenCL: number;
  geekbenchVulkan: number;
  passmarkDX12: number;
  passmarkDX11: number;
}

export interface VastAiMetrics {
  dlperf: number;
  hourlyRateUSD: number;
  dlperfPerDollar: number;
  availableOffers: number;
  verifiedFlops: number;
}

export interface TomsHardwareResult {
  relativePct: number;
  fps: number;
}

export interface TomsHardwareResolutionSet {
  '1080p': TomsHardwareResult | null;
  '1440p': TomsHardwareResult | null;
  '4K': TomsHardwareResult | null;
}

/** Datos scrapeados de Tom's Hardware GPU Benchmarks Hierarchy (preset Ultra). */
export interface TomsHardwareData {
  sourceName: string;
  rasterization: TomsHardwareResolutionSet | null;
  rayTracing: TomsHardwareResolutionSet | null;
  scrapedAt: string;
}

/** Datos scrapeados/sincronizados de TechPowerUp GPU Database. */
export interface TechPowerUpData {
  url: string;
  relativePerformancePct: number;
  tmus: number;
  rops: number;
  shadersTmusRops: string;
  launchDate?: string;
}

/** Datos oficiales descargados de UserBenchmark GPU Database (Daily CSV). */
export interface UserBenchmarkData {
  rank: number;
  score: number;
  samples: number;
  url: string;
}

export interface GpuSpec {
  id: string;
  name: string;
  brand: 'NVIDIA' | 'AMD' | 'Intel';
  series: string;
  architecture: string;
  releaseYear: number;
  vramGB: number;
  memoryType: string;
  busWidthBit: number;
  memoryBandwidthGBs: number;
  baseClockMHz: number;
  boostClockMHz: number;
  cores: number;
  tdpWatts: number;
  processNm: number;
  tflopsFP32: number;
  msrpUSD: number;
  benchmarks: GpuBenchmarks;
  vastai?: VastAiMetrics;
  tomshardware?: TomsHardwareData;
  techpowerup?: TechPowerUpData;
  userbenchmark?: UserBenchmarkData;
}

export interface PCGamingWikiData {
  wikiPage: string;
  graphicsApis: string[];
  upscalers: ('DLSS' | 'FSR' | 'XeSS')[];
  frameGeneration: boolean;
  rayTracing: boolean;
  pathTracing?: boolean;
  highFrameRate: boolean;
  ultrawide: boolean;
  hdr: boolean;
  engineFrameCap: number | null;
}

export type ProtonTier = 'native' | 'platinum' | 'gold' | 'silver' | 'bronze' | 'borked';

export interface ProtonDbData {
  tier: ProtonTier;
  trendingTier: ProtonTier;
  bestReportedTier: ProtonTier;
  score: number;
  confidence: string;
  totalReports: number;
}

export interface SteamGame {
  id: string;
  steamAppId: number;
  name: string;
  headerImage: string;
  genres: string[];
  engine: string;
  releaseYear: number;
  recommendedGpuName: string;
  recommendedPassmarkScore: number;
  recommendedVramGB: number;
  baseFpsAtRecommended1080pHigh: number;
  cpuBottleneckCap: number;
  rayTracingHeavy: boolean;
  pcgw: PCGamingWikiData;
  protondb: ProtonDbData;
}

export type ResolutionKey = '1080p' | '1440p' | '4K';
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export type UpscalingMode = 'off' | 'quality' | 'balanced' | 'performance';
export type TargetPlatform = 'windows' | 'linux';

export interface FpsCalculationOptions {
  upscaling?: UpscalingMode;
  frameGen?: boolean;
  platform?: TargetPlatform;
  unlockEngineCap?: boolean;
}

export interface FpsEstimateResult {
  avgFps: number;
  onePercentLow: number;
  vramLimited: boolean;
  cappedByEngine: boolean;
  activeUpscaler: string | null;
  frameGenActive: boolean;
  performanceTier: 'competitive' | 'smooth' | 'playable' | 'struggling';
  relativeRatio: number;
}

const RESOLUTION_MULTIPLIERS: Record<ResolutionKey, number> = {
  '1080p': 1.0,
  '1440p': 0.71,
  '4K': 0.42,
};

const QUALITY_MULTIPLIERS: Record<QualityPreset, number> = {
  low: 1.38,
  medium: 1.16,
  high: 1.0,
  ultra: 0.81,
};

const UPSCALING_GAINS: Record<UpscalingMode, Record<ResolutionKey, number>> = {
  off: { '1080p': 1.0, '1440p': 1.0, '4K': 1.0 },
  quality: { '1080p': 1.18, '1440p': 1.27, '4K': 1.36 },
  balanced: { '1080p': 1.28, '1440p': 1.41, '4K': 1.54 },
  performance: { '1080p': 1.38, '1440p': 1.56, '4K': 1.76 },
};

const VRAM_RESOLUTION_EXTRA_GB: Record<ResolutionKey, number> = {
  '1080p': 0,
  '1440p': 2,
  '4K': 4.5,
};

const VRAM_QUALITY_EXTRA_GB: Record<QualityPreset, number> = {
  low: -1.5,
  medium: -0.5,
  high: 0,
  ultra: 2,
};

/**
 * Determina qué tecnología de escalado (reportada por PCGamingWiki Cargo)
 * se activa en esta combinación de GPU + Juego.
 */
export function resolveSupportedUpscaler(gpu: GpuSpec, game: SteamGame): string | null {
  const upscalers = game.pcgw?.upscalers || [];
  if (!upscalers.length) return null;

  if (gpu.brand === 'NVIDIA' && gpu.series.startsWith('RTX') && upscalers.includes('DLSS')) {
    return 'DLSS';
  }
  if (gpu.brand === 'Intel' && upscalers.includes('XeSS')) {
    return 'XeSS';
  }
  if (upscalers.includes('FSR')) {
    return 'FSR';
  }
  if (upscalers.includes('XeSS')) {
    return 'XeSS';
  }
  return null;
}

/**
 * Calcula un Índice Compuesto de Rendimiento Relativo de una GPU combinando:
 * - PassMark DirectX 12 Benchmark & DirectX 11 Benchmark (peso 55%)
 * - Geekbench 6 Vulkan / OpenCL normalizado (peso 35% - cómputo moderno y shaders)
 * - Ancho de banda de memoria (peso 10%)
 */
export function getCompositeGpuScore(gpu: GpuSpec, apiHint?: 'DX12' | 'DX11'): number {
  const dx12Norm = gpu.benchmarks.passmarkDX12 * 265;
  const dx11Norm = gpu.benchmarks.passmarkDX11 * 108;

  let passmarkDirectX = dx12Norm * 0.65 + dx11Norm * 0.35;

  if (apiHint === 'DX12') {
    passmarkDirectX = dx12Norm * 0.85 + dx11Norm * 0.15;
  } else if (apiHint === 'DX11') {
    passmarkDirectX = dx11Norm * 0.85 + dx12Norm * 0.15;
  }

  const geekbenchAvg =
    (gpu.benchmarks.geekbenchVulkan * 0.6 + gpu.benchmarks.geekbenchOpenCL * 0.4) * 0.145;
  const bandwidthBonus = gpu.memoryBandwidthGBs * 6.5;

  return Math.round(passmarkDirectX * 0.55 + geekbenchAvg * 0.35 + bandwidthBonus * 0.1);
}

/**
 * Algoritmo de Rendimiento Relativo enriquecido con PCGamingWiki Cargo y ProtonDB Data
 */
export function calculateRelativeFps(
  gpu: GpuSpec,
  game: SteamGame,
  resolution: ResolutionKey = '1080p',
  quality: QualityPreset = 'high',
  options: FpsCalculationOptions = {}
): FpsEstimateResult {
  const {
    upscaling = 'off',
    frameGen = false,
    platform = 'windows',
    unlockEngineCap = false,
  } = options;

  const apis = game.pcgw?.graphicsApis || [];
  const apiHint: 'DX12' | 'DX11' | undefined =
    apis.includes('DirectX 12') && !apis.includes('DirectX 11')
      ? 'DX12'
      : apis.includes('DirectX 11') && !apis.includes('DirectX 12')
      ? 'DX11'
      : undefined;

  const compositeScore = getCompositeGpuScore(gpu, apiHint);
  const rawRatio = compositeScore / game.recommendedPassmarkScore;

  const scalingExponent = resolution === '4K' ? 0.91 : resolution === '1440p' ? 0.86 : 0.8;
  const scaledRatio = Math.pow(rawRatio, scalingExponent);

  // Penalización o bonificación por ancho de banda en 4K
  let bandwidthFactor = 1.0;
  if (resolution === '4K') {
    if (gpu.busWidthBit <= 128) bandwidthFactor = 0.86;
    else if (gpu.busWidthBit >= 384) bandwidthFactor = 1.07;
  } else if (resolution === '1440p' && gpu.busWidthBit <= 128) {
    bandwidthFactor = 0.94;
  }

  // Resolución de Upscaler vía PCGamingWiki Cargo
  const supportedUpscaler = resolveSupportedUpscaler(gpu, game);
  const activeUpscaler = upscaling !== 'off' && supportedUpscaler ? supportedUpscaler : null;
  const upscalingMultiplier = activeUpscaler ? UPSCALING_GAINS[upscaling][resolution] : 1.0;

  // El uso de DLSS/FSR/XeSS reduce ligeramente el consumo de VRAM de framebuffer
  const upscalingVramRelief = activeUpscaler ? -0.75 : 0;

  const requiredVram = Math.max(
    3,
    game.recommendedVramGB +
      VRAM_RESOLUTION_EXTRA_GB[resolution] +
      VRAM_QUALITY_EXTRA_GB[quality] +
      upscalingVramRelief
  );

  const vramLimited = gpu.vramGB < requiredVram;
  const vramPenalty = vramLimited
    ? Math.max(0.55, 1 - (requiredVram - gpu.vramGB) * 0.11)
    : 1.0;

  // Factor de arquitectura en juegos con Ray Tracing pesado (PCGamingWiki)
  let archFactor = 1.0;
  if (game.pcgw?.rayTracing && game.rayTracingHeavy && quality === 'ultra') {
    if (gpu.brand === 'NVIDIA' && gpu.releaseYear >= 2022) archFactor = 1.09;
    else if (gpu.brand === 'AMD') archFactor = 0.92;
  }

  // Modificador de Plataforma Linux / ProtonDB (VKD3D-Proton / DXVK / Nativo Vulkan)
  let platformFactor = 1.0;
  if (platform === 'linux' && game.protondb) {
    const hasNativeVulkan = game.pcgw?.graphicsApis?.includes('Vulkan');
    const isDx12Only =
      game.pcgw?.graphicsApis?.includes('DirectX 12') &&
      !game.pcgw?.graphicsApis?.includes('DirectX 11') &&
      !hasNativeVulkan;

    if (game.protondb.tier === 'native' || hasNativeVulkan) {
      platformFactor = gpu.brand === 'AMD' ? 1.04 : 1.0;
    } else if (isDx12Only) {
      // VKD3D-Proton rinde excelente en RDNA (Mesa RADV) y tiene un ligero overhead en arquitecturas antiguas
      platformFactor = gpu.brand === 'AMD' ? 1.01 : 0.95;
    } else {
      platformFactor = 0.98;
    }

    if (game.protondb.tier === 'silver') platformFactor *= 0.95;
    if (game.protondb.tier === 'bronze') platformFactor *= 0.88;
  }

  // Cálculo base antes de Frame Generation y Caps
  let computedFps =
    game.baseFpsAtRecommended1080pHigh *
    scaledRatio *
    RESOLUTION_MULTIPLIERS[resolution] *
    QUALITY_MULTIPLIERS[quality] *
    bandwidthFactor *
    vramPenalty *
    archFactor *
    upscalingMultiplier *
    platformFactor;

  // Frame Generation (DLSS 3/4 FG o FSR 3 FG según soporte en PCGamingWiki)
  const canUseFrameGen =
    frameGen &&
    Boolean(game.pcgw?.frameGeneration) &&
    (gpu.releaseYear >= 2021 || gpu.series.includes('RTX 40') || gpu.series.includes('RTX 50') || gpu.series.includes('RX 7000'));

  const baseLowFactor = vramLimited ? 0.64 : gpu.busWidthBit <= 128 ? 0.76 : 0.81;
  const rawOnePercentLow = computedFps * baseLowFactor;

  if (canUseFrameGen) {
    computedFps *= 1.52;
  }

  // Límite de cuello de botella de CPU y límite de motor de PCGamingWiki (ej. 60 FPS en Elden Ring)
  const engineCap = !unlockEngineCap && game.pcgw?.engineFrameCap ? game.pcgw.engineFrameCap : null;
  const effectiveCap = engineCap
    ? Math.min(game.cpuBottleneckCap, engineCap)
    : game.cpuBottleneckCap;

  const cappedByEngine = Boolean(engineCap && Math.round(computedFps) >= engineCap);
  const avgFps = Math.min(effectiveCap, Math.max(12, Math.round(computedFps)));
  const onePercentLow = Math.min(
    avgFps - 2,
    Math.max(8, Math.round(canUseFrameGen ? rawOnePercentLow * 1.12 : rawOnePercentLow))
  );

  let performanceTier: FpsEstimateResult['performanceTier'] = 'playable';
  if (avgFps >= 120) performanceTier = 'competitive';
  else if (avgFps >= 60) performanceTier = 'smooth';
  else if (avgFps >= 35) performanceTier = 'playable';
  else performanceTier = 'struggling';

  return {
    avgFps,
    onePercentLow,
    vramLimited,
    cappedByEngine,
    activeUpscaler,
    frameGenActive: canUseFrameGen,
    performanceTier,
    relativeRatio: Number(rawRatio.toFixed(2)),
  };
}
