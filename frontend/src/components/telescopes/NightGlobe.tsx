import { useEffect, useRef, useState } from "react";
import {
  geoEquirectangular,
  geoGraticule10,
  geoOrthographic,
  geoPath,
  type GeoPermissibleObjects,
} from "d3-geo";
import { feature } from "topojson-client";
import landUrl from "world-atlas/land-110m.json?url";
import { NIGHT_SUN_ALTITUDE, skyState, subsolarPoint, sunAltitude, wrapLongitude } from "@/lib/sun";
import { type Site } from "@/lib/telescopes";
import boomLogo from "@/assets/boom-logo.png";
import {
  alongFlow,
  DAYLIGHT_EDGES,
  FLOW_DOT_SPACING,
  FLOW_PX_PER_SECOND,
  flowTo,
  type Flow,
  type LandTopology,
  PALETTES,
  type Palette,
  type Point,
  resolveColors,
  ring,
  RING_PERIOD_MS,
  RINGS,
  smoothstep,
} from "@/components/telescopes/shared";

const DEG = Math.PI / 180;
const MASK_CELL = 4;
const REPAINT_SIM_MS = 20_000;
const LAND_RASTER = 4;
const SHADE_LEVELS = 4;
// The camera stays fixed relative to the Sun, so the Earth turns underneath it.
// Longitude offset from local midnight: -60° centers the view on early evening,
// leaving the sunlit limb on the left and the anti-Sun direction (L2) on the right.
const DEFAULT_VIEW = { offset: -60, lat: 12 };
const HALO_PERIOD_MS = 180 * 86_400_000;
const ROMAN_COLOR = "rgb(163, 230, 53)";
const ROMAN_DISTANCE = 1.45;
const HUB = { x: 0.86, y: 0.26 } as const;

type Vec = [number, number, number];

type View = { offset: number; lat: number };

type Frame = {
  o: Vec;
  e: Vec;
  n: Vec;
  sun: Vec;
};

type Scene = {
  width: number;
  height: number;
  dpr: number;
  cx: number;
  cy: number;
  radius: number;
  hub: Point;
  dots: Float32Array;
  dotRadius: number;
  sites: Float32Array;
  base: HTMLCanvasElement;
  work: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  maskPixels: ImageData;
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function unit(lat: number, lon: number): Vec {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function dot(a: Vec, x: number, y: number, z: number): number {
  return a[0] * x + a[1] * y + a[2] * z;
}

// Orthographic camera basis: `o` points at the viewer, `e` to screen right, `n` to screen up.
function cameraFrame(ms: number, view: View): Frame & { lon: number; lat: number } {
  const sun = subsolarPoint(ms);
  const lon = wrapLongitude(sun.lon + 180 + view.offset);
  const phi = view.lat * DEG;
  const lambda = lon * DEG;
  return {
    lon,
    lat: view.lat,
    o: [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)],
    e: [-Math.sin(lambda), Math.cos(lambda), 0],
    n: [-Math.sin(phi) * Math.cos(lambda), -Math.sin(phi) * Math.sin(lambda), Math.cos(phi)],
    sun: unit(sun.lat, sun.lon),
  };
}

function landDots(land: GeoPermissibleObjects, radius: number) {
  const width = 360 * LAND_RASTER;
  const height = 180 * LAND_RASTER;
  const g = createCanvas(width, height).getContext("2d", { willReadFrequently: true })!;
  g.beginPath();
  geoPath(geoEquirectangular().scale(width / (2 * Math.PI)).translate([width / 2, height / 2]), g)(land);
  g.fill();
  const pixels = g.getImageData(0, 0, width, height).data;
  const isLand = (lat: number, lon: number) => {
    const x = Math.min(width - 1, Math.floor((lon + 180) * LAND_RASTER));
    const y = Math.min(height - 1, Math.floor((90 - lat) * LAND_RASTER));
    return pixels[(y * width + x) * 4 + 3] > 127;
  };

  const spacing = Math.min(7, Math.max(3.5, radius / 55));
  const step = spacing / radius / DEG;
  const dots: number[] = [];
  for (let row = 0, lat = -90 + step / 2; lat < 90; row++, lat += step * 0.87) {
    const count = Math.max(1, Math.round((360 * Math.cos(lat * DEG)) / step));
    const shift = row % 2 ? 0.5 : 0;
    for (let k = 0; k < count; k++) {
      const lon = ((k + shift) / count) * 360 - 180;
      if (isLand(lat, lon)) dots.push(...unit(lat, lon));
    }
  }
  return { dots: new Float32Array(dots), dotRadius: spacing * 0.28 };
}

function buildScene(width: number, land: GeoPermissibleObjects, sites: Site[]): Scene {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const height = Math.round(width * 0.52);
  const radius = Math.min(height * 0.38, width * 0.3);
  const { dots, dotRadius } = landDots(land, radius);
  const cells = Math.ceil((2 * radius) / MASK_CELL);
  const maskPixels = new ImageData(cells, cells);
  maskPixels.data.fill(255);
  return {
    width,
    height,
    dpr,
    cx: width * 0.4,
    cy: height * 0.5,
    radius,
    hub: [width * HUB.x, height * HUB.y],
    dots,
    dotRadius,
    sites: new Float32Array(sites.flatMap((site) => unit(site.lat, site.lon))),
    base: createCanvas(Math.round(width * dpr), Math.round(height * dpr)),
    work: createCanvas(Math.round(width * dpr), Math.round(height * dpr)),
    mask: createCanvas(cells, cells),
    maskPixels,
  };
}

function paintBase(scene: Scene, palette: Palette, frame: ReturnType<typeof cameraFrame>, ms: number) {
  const { width, height, dpr, cx, cy, radius: r } = scene;
  const { o, e, n, sun } = frame;
  const se = dot(sun, ...e);
  const sn = dot(sun, ...n);
  const so = dot(sun, ...o);

  const base = scene.base.getContext("2d")!;
  base.setTransform(dpr, 0, 0, dpr, 0, 0);
  base.clearRect(0, 0, width, height);

  // Sunlight wrapping around the limb from behind.
  const glowX = cx + se * r * 1.05;
  const glowY = cy - sn * r * 1.05;
  const rim = base.createRadialGradient(glowX, glowY, 0, glowX, glowY, r * 1.15);
  rim.addColorStop(0, palette.sunGlow);
  rim.addColorStop(1, "rgba(255, 190, 110, 0)");
  base.fillStyle = rim;
  base.fillRect(0, 0, width, height);

  const atmosphere = base.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.12);
  atmosphere.addColorStop(0, "rgba(129, 140, 248, 0.28)");
  atmosphere.addColorStop(1, "rgba(129, 140, 248, 0)");
  base.fillStyle = atmosphere;
  base.fillRect(0, 0, width, height);

  base.beginPath();
  base.arc(cx, cy, r, 0, 2 * Math.PI);
  base.fillStyle = palette.nightOcean;
  base.fill();

  // Daylit ocean, masked per cell by the Sun's altitude at the point under it.
  const cells = scene.mask.width;
  const data = scene.maskPixels.data;
  for (let j = 0; j < cells; j++) {
    const v = -(((j + 0.5) * MASK_CELL - r) / r);
    for (let i = 0; i < cells; i++) {
      const u = ((i + 0.5) * MASK_CELL - r) / r;
      const z = Math.sqrt(Math.max(0, 1 - u * u - v * v));
      const sinAltitude = u * se + v * sn + z * so;
      data[(j * cells + i) * 4 + 3] = 255 * smoothstep(DAYLIGHT_EDGES[0], DAYLIGHT_EDGES[1], sinAltitude);
    }
  }
  scene.mask.getContext("2d")!.putImageData(scene.maskPixels, 0, 0);
  const work = scene.work.getContext("2d")!;
  work.setTransform(dpr, 0, 0, dpr, 0, 0);
  work.globalCompositeOperation = "copy";
  work.beginPath();
  work.arc(cx, cy, r, 0, 2 * Math.PI);
  work.fillStyle = palette.dayOcean;
  work.fill();
  work.globalCompositeOperation = "destination-in";
  work.imageSmoothingQuality = "high";
  work.drawImage(scene.mask, cx - r, cy - r, cells * MASK_CELL, cells * MASK_CELL);
  work.globalCompositeOperation = "source-over";
  base.setTransform(1, 0, 0, 1, 0, 0);
  base.drawImage(scene.work, 0, 0);
  base.setTransform(dpr, 0, 0, dpr, 0, 0);

  const projection = geoOrthographic()
    .rotate([-frame.lon, -frame.lat])
    .translate([cx, cy])
    .scale(r);
  const path = geoPath(projection, base);
  base.beginPath();
  path(geoGraticule10());
  base.strokeStyle = palette.nightGrid;
  base.lineWidth = 0.5;
  base.stroke();

  // Land dots, bucketed by how lit they are so each shade is a single fill.
  const buckets: number[][] = Array.from({ length: SHADE_LEVELS + 1 }, () => []);
  const dots = scene.dots;
  for (let k = 0; k < dots.length; k += 3) {
    const x = dots[k];
    const y = dots[k + 1];
    const z = dots[k + 2];
    const depth = x * o[0] + y * o[1] + z * o[2];
    if (depth <= 0) continue;
    const lit = smoothstep(DAYLIGHT_EDGES[0], DAYLIGHT_EDGES[1], x * sun[0] + y * sun[1] + z * sun[2]);
    buckets[Math.round(lit * SHADE_LEVELS)].push(
      cx + r * (x * e[0] + y * e[1] + z * e[2]),
      cy - r * (x * n[0] + y * n[1] + z * n[2]),
      scene.dotRadius * (0.45 + 0.55 * Math.sqrt(depth)),
    );
  }
  buckets.forEach((points, level) => {
    const lit = level / SHADE_LEVELS;
    for (const [color, alpha] of [[palette.nightLand, 1 - lit], [palette.dayLand, lit]] as const) {
      if (alpha <= 0 || points.length === 0) continue;
      base.globalAlpha = alpha;
      base.fillStyle = color;
      base.beginPath();
      for (let k = 0; k < points.length; k += 3) {
        base.moveTo(points[k] + points[k + 2], points[k + 1]);
        base.arc(points[k], points[k + 1], points[k + 2], 0, 2 * Math.PI);
      }
      base.fill();
    }
  });
  base.globalAlpha = 1;

  const subsolar = subsolarPoint(ms);
  const antisolar: [number, number] = [wrapLongitude(subsolar.lon + 180), -subsolar.lat];
  base.lineWidth = 1;
  base.strokeStyle = palette.terminator;
  base.beginPath();
  path(ring(antisolar, 90));
  base.stroke();
  base.setLineDash([3, 4]);
  base.strokeStyle = palette.darkEdge;
  base.beginPath();
  path(ring(antisolar, 90 + NIGHT_SUN_ALTITUDE));
  base.stroke();
  base.setLineDash([]);

  if (so > 0) {
    const [sunX, sunY] = projection([subsolar.lon, subsolar.lat]) ?? [0, 0];
    const disc = base.createRadialGradient(sunX, sunY, 0, sunX, sunY, 16);
    disc.addColorStop(0, "rgba(255, 247, 222, 1)");
    disc.addColorStop(0.28, "rgba(253, 186, 116, 0.95)");
    disc.addColorStop(1, "rgba(251, 146, 60, 0)");
    base.fillStyle = disc;
    base.beginPath();
    base.arc(sunX, sunY, 16, 0, 2 * Math.PI);
    base.fill();
  }

  // Shade the limb so the disc reads as a sphere.
  const limb = base.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
  limb.addColorStop(0, "rgba(0, 0, 0, 0)");
  limb.addColorStop(1, "rgba(0, 0, 0, 0.35)");
  base.fillStyle = limb;
  base.beginPath();
  base.arc(cx, cy, r, 0, 2 * Math.PI);
  base.fill();
  base.strokeStyle = palette.outline;
  base.stroke();
}

export default function NightGlobe({ sites, timeRef, time }: {
  sites: Site[];
  timeRef: React.RefObject<number>;
  time: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const romanRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ ...DEFAULT_VIEW });
  const [land, setLand] = useState<GeoPermissibleObjects | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(landUrl)
      .then((res) => res.json() as Promise<LandTopology>)
      .then((topology) => !cancelled && setLand(feature(topology, topology.objects.land)))
      .catch(() => !cancelled && setLand({ type: "FeatureCollection", features: [] }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const view = canvasRef.current;
    if (!land || !container || !view) return;
    const ctx = view.getContext("2d")!;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let palette = PALETTES.dark;
    let colors: string[][] = [];
    let scene: Scene | null = null;
    let painted = { ms: Number.NaN, offset: Number.NaN, lat: Number.NaN };
    let raf = 0;

    const rebuild = () => {
      const width = Math.floor(container.clientWidth);
      if (width < 50) return;
      palette = document.documentElement.classList.contains("dark") ? PALETTES.dark : PALETTES.light;
      colors = resolveColors(container, sites);
      scene = buildScene(width, land, sites);
      view.width = scene.base.width;
      view.height = scene.base.height;
      view.style.height = `${scene.height}px`;
      painted = { ms: Number.NaN, offset: Number.NaN, lat: Number.NaN };
    };

    function paintFlow(flow: Flow, flowColors: string[], now: number, moving: boolean) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = palette.flow;
      ctx.lineWidth = 0.75;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(...flow.from);
      ctx.quadraticCurveTo(...flow.control, ...flow.to);
      ctx.stroke();
      ctx.setLineDash([]);
      if (reducedMotion || !moving) return;
      const travelMs = (flow.length / FLOW_PX_PER_SECOND) * 1000;
      const count = Math.max(2, Math.round(flow.length / FLOW_DOT_SPACING));
      flowColors.forEach((color, j) => {
        ctx.fillStyle = color;
        for (let k = 0; k < count; k++) {
          const t = (now / travelMs + (k + j / flowColors.length) / count) % 1;
          const [x, y] = alongFlow(flow, t);
          ctx.globalAlpha = Math.min(1, t * 8, (1 - t) * 8);
          ctx.beginPath();
          ctx.arc(x, y, 1.3, 0, 2 * Math.PI);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
    }

    function paintMarker(x: number, y: number, markerColors: string[], intensity: number, alpha: number, now: number) {
      if (intensity > 0) {
        for (let k = 0; k < RINGS; k++) {
          const phase = reducedMotion ? 0.15 + k / RINGS : (now / RING_PERIOD_MS + k / RINGS) % 1;
          ctx.globalAlpha = alpha * intensity * (1 - phase) ** 2;
          ctx.strokeStyle = markerColors[k % markerColors.length];
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, 6 + phase * 30, 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = alpha * (intensity > 0 ? 1 : 0.55);
      const slice = (2 * Math.PI) / markerColors.length;
      markerColors.forEach((color, k) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, 5, -Math.PI / 2 + k * slice, -Math.PI / 2 + (k + 1) * slice);
        ctx.closePath();
        ctx.fill();
      });
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = palette.markerEdge;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Roman sits near Sun–Earth L2, always roughly opposite the Sun. Drawn far closer than
    // its real 1.5 million km so it fits beside the globe.
    function paintRoman(scene: Scene, frame: Frame, ms: number, now: number) {
      const { cx, cy, radius: r } = scene;
      const away: Vec = [-frame.sun[0], -frame.sun[1], -frame.sun[2]];
      const ax = dot(away, ...frame.e);
      const ay = dot(away, ...frame.n);
      const az = dot(away, ...frame.o);
      const spread = Math.hypot(ax, ay) || 1;
      const distance = ROMAN_DISTANCE / Math.max(spread, 0.35);
      const x = cx + r * distance * ax;
      const y = cy - r * distance * ay;
      const hidden = az < 0 && Math.hypot(x - cx, y - cy) < r;
      const alpha = hidden ? 0.25 : 1;

      ctx.globalAlpha = 0.6 * alpha;
      ctx.strokeStyle = ROMAN_COLOR;
      ctx.lineWidth = 0.75;
      ctx.setLineDash([1, 5]);
      ctx.beginPath();
      ctx.moveTo(cx + r * (ax / spread), cy - r * (ay / spread));
      ctx.lineTo(x, y);
      ctx.stroke();

      const haloX = r * 0.16;
      const haloY = r * 0.07;
      ctx.globalAlpha = 0.5 * alpha;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.ellipse(x, y, haloX, haloY, 0, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);

      const phase = (ms / HALO_PERIOD_MS) * 2 * Math.PI;
      const rx = x + haloX * Math.cos(phase);
      const ry = y + haloY * Math.sin(phase);
      paintFlow(flowTo([rx, ry], scene.hub), [ROMAN_COLOR], now, false);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = ROMAN_COLOR;
      ctx.fillRect(rx - 9, ry - 1.5, 5, 3);
      ctx.fillRect(rx + 4, ry - 1.5, 5, 3);
      ctx.beginPath();
      ctx.arc(rx, ry, 3.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = palette.markerEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      const label = romanRef.current;
      if (label) {
        label.style.left = `${x}px`;
        label.style.top = `${y + haloY + 8}px`;
        label.style.opacity = hidden ? "0" : "1";
      }
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      if (!scene) return;
      const ms = timeRef.current;
      const camera = cameraFrame(ms, viewRef.current);
      const { offset, lat } = viewRef.current;
      if (!(Math.abs(ms - painted.ms) < REPAINT_SIM_MS) || offset !== painted.offset || lat !== painted.lat) {
        paintBase(scene, palette, camera, ms);
        painted = { ms, offset, lat };
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(scene.base, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);

      paintRoman(scene, camera, ms, now);

      const sun = subsolarPoint(ms);
      const { cx, cy, radius: r } = scene;
      sites.forEach((site, i) => {
        const v = scene!.sites.subarray(i * 3, i * 3 + 3) as unknown as Vec;
        const x = cx + r * dot(v, ...camera.e);
        const y = cy - r * dot(v, ...camera.n);
        const visible = dot(v, ...camera.o) > 0;
        const state = skyState(sunAltitude(sun, site.lat, site.lon));
        if (state === "night") paintFlow(flowTo([x, y], scene!.hub), colors[i], now, true);
        const intensity = state === "night" ? 1 : state === "twilight" ? 0.35 : 0;
        paintMarker(x, y, colors[i], visible ? intensity : 0, visible ? 1 : 0.25, now);
        const label = labelRefs.current[i];
        if (label) {
          label.style.left = `${x}px`;
          label.style.top = `${y}px`;
          label.style.opacity = visible ? "1" : "0";
        }
      });
    }

    rebuild();
    raf = requestAnimationFrame(frame);

    let drag: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY };
      view.setPointerCapture(event.pointerId);
      view.style.cursor = "grabbing";
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || !scene) return;
      if (event.buttons === 0) {
        onUp();
        return;
      }
      const perPixel = 1 / scene.radius / DEG;
      const current = viewRef.current;
      viewRef.current = {
        offset: current.offset - (event.clientX - drag.x) * perPixel,
        lat: Math.max(-70, Math.min(70, current.lat + (event.clientY - drag.y) * perPixel)),
      };
      drag = { x: event.clientX, y: event.clientY };
    };
    const onUp = () => {
      drag = null;
      view.style.cursor = "";
    };
    const onReset = () => {
      viewRef.current = { ...DEFAULT_VIEW };
    };
    view.addEventListener("pointerdown", onDown);
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onUp);
    view.addEventListener("pointercancel", onUp);
    view.addEventListener("dblclick", onReset);

    let lastWidth = container.clientWidth;
    const resizeObserver = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastWidth) < 1) return;
      lastWidth = container.clientWidth;
      rebuild();
    });
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(rebuild);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      cancelAnimationFrame(raf);
      view.removeEventListener("pointerdown", onDown);
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onUp);
      view.removeEventListener("pointercancel", onUp);
      view.removeEventListener("dblclick", onReset);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [land, sites, timeRef]);

  const sun = subsolarPoint(time);
  const receiving = sites.some((site) => skyState(sunAltitude(sun, site.lat, site.lon)) === "night");

  return (
    <div ref={containerRef} className="relative overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block w-full cursor-grab touch-pan-y select-none"
        style={{ aspectRatio: "1000 / 520" }}
        title="Drag to turn the globe, double-click to reset"
      />
      {sites.map((site, i) => (
        <div
          key={site.id}
          ref={(el) => {
            labelRefs.current[i] = el;
          }}
          className="pointer-events-none absolute hidden translate-x-4 -translate-y-1/2 transition-opacity duration-300 sm:block"
        >
          <div className="bg-background/80 text-foreground rounded-md border px-2 py-1 text-[11px] leading-tight shadow-lg backdrop-blur-sm">
            <div className="font-medium">{site.name}</div>
            {site.telescopes.map((telescope) => (
              <div key={telescope.id} className="mt-0.5 flex items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: telescope.color }} />
                {telescope.name}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div
        ref={romanRef}
        className="pointer-events-none absolute hidden -translate-x-1/2 transition-opacity duration-300 sm:block"
      >
        <div className="bg-background/80 text-foreground rounded-md border px-2 py-1 text-center text-[11px] leading-tight shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-center gap-1 font-medium">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: ROMAN_COLOR }} />
            Roman
            <span className="text-muted-foreground font-normal">· planned</span>
          </div>
          <div className="text-muted-foreground">Sun–Earth L2 · 1.5 million km, not to scale</div>
        </div>
      </div>
      <div
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${HUB.x * 100}%`, top: `${HUB.y * 100}%` }}
      >
        <div
          className={`absolute -inset-1 rounded-full blur-lg transition-colors duration-700 ${receiving ? "bg-indigo-400/60" : "bg-indigo-400/25"}`}
        />
        {receiving && (
          <div className="absolute inset-0 animate-ping rounded-full ring-2 ring-indigo-300/60 [animation-duration:2.4s]" />
        )}
        <img
          src={boomLogo}
          alt="BOOM"
          className="relative size-10 max-w-none rounded-full shadow-2xl ring-2 ring-white/90 sm:size-14 lg:size-16"
        />
      </div>
    </div>
  );
}
