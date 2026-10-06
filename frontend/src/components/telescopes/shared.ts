import { geoCircle } from "d3-geo";
import type { LineString } from "geojson";
import { feature } from "topojson-client";
import { type Site } from "@/lib/telescopes";

const DEG = Math.PI / 180;

export const DAYLIGHT_EDGES = [Math.sin(-16 * DEG), Math.sin(3 * DEG)] as const;

export const RINGS = 3;

export const RING_PERIOD_MS = 2600;

export const FLOW_PX_PER_SECOND = 70;

export const FLOW_DOT_SPACING = 56;

export const PALETTES = {
  dark: {
    nightOcean: "#050816",
    dayOcean: "#14335a",
    nightLand: "rgba(148, 163, 184, 0.3)",
    dayLand: "rgba(226, 232, 240, 0.9)",
    nightGrid: "rgba(148, 163, 184, 0.06)",
    dayGrid: "rgba(226, 232, 240, 0.1)",
    outline: "rgba(148, 163, 184, 0.25)",
    sunGlow: "rgba(255, 190, 110, 0.22)",
    terminator: "rgba(251, 191, 36, 0.45)",
    darkEdge: "rgba(129, 140, 248, 0.55)",
    markerEdge: "rgba(255, 255, 255, 0.9)",
    flow: "rgba(148, 163, 184, 0.45)",
  },
  light: {
    nightOcean: "#0b1433",
    dayOcean: "#dbe7f6",
    nightLand: "rgba(148, 163, 184, 0.42)",
    dayLand: "rgba(51, 65, 85, 0.7)",
    nightGrid: "rgba(148, 163, 184, 0.07)",
    dayGrid: "rgba(51, 65, 85, 0.07)",
    outline: "rgba(100, 116, 139, 0.35)",
    sunGlow: "rgba(255, 170, 80, 0.28)",
    terminator: "rgba(217, 119, 6, 0.6)",
    darkEdge: "rgba(129, 140, 248, 0.7)",
    markerEdge: "rgba(255, 255, 255, 0.95)",
    flow: "rgba(71, 85, 105, 0.4)",
  },
};

export type Palette = typeof PALETTES.dark;

export type LandTopology = Parameters<typeof feature>[0];

export type Point = [number, number];

export type Flow = { from: Point; control: Point; to: Point; length: number };

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function ring(center: [number, number], radius: number): LineString {
  return { type: "LineString", coordinates: geoCircle().center(center).radius(radius)().coordinates[0] };
}

export function flowTo(from: Point, to: Point): Flow {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const side = dx / length > 0 ? -1 : 1;
  const bend = length * 0.18 * side;
  return {
    from,
    control: [(from[0] + to[0]) / 2 - (dy / length) * bend, (from[1] + to[1]) / 2 + (dx / length) * bend],
    to,
    length,
  };
}

export function alongFlow({ from, control, to }: Flow, t: number): Point {
  const u = 1 - t;
  return [
    u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
    u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
  ];
}

export function resolveColors(container: HTMLElement, sites: Site[]): string[][] {
  const probe = document.createElement("span");
  container.appendChild(probe);
  const colors = sites.map((site) =>
    site.telescopes.map((telescope) => {
      probe.style.color = telescope.color;
      return getComputedStyle(probe).color;
    }),
  );
  probe.remove();
  return colors;
}
