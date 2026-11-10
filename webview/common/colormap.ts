// 256-entry RGB lookup tables (polynomial fits of the matplotlib / Google maps).

type Poly = [number, number, number][];

const VIRIDIS: Poly = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
];
const INFERNO: Poly = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];

function poly(c: Poly, t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = c[c.length - 1][k];
    for (let i = c.length - 2; i >= 0; i--) v = c[i][k] + t * v;
    out[k] = v;
  }
  return out;
}

function turbo(x: number): [number, number, number] {
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [r, g, b];
}

function jet(x: number): [number, number, number] {
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return [c(1.5 - Math.abs(4 * x - 3)), c(1.5 - Math.abs(4 * x - 2)), c(1.5 - Math.abs(4 * x - 1))];
}

function rainbow(x: number): [number, number, number] {
  // hue 240° (blue) -> 0° (red)
  const hue = (1 - x) * 240;
  const k = (n: number) => (n + hue / 60) % 6;
  const f = (n: number) => 1 - Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

export const COLORMAPS = ['turbo', 'rainbow', 'jet', 'viridis', 'inferno', 'gray'] as const;
const cache = new Map<string, Uint8Array>();

export function colormapLut(name: string): Uint8Array {
  const hit = cache.get(name);
  if (hit) return hit;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const rgb =
      name === 'gray'
        ? [t, t, t]
        : name === 'jet'
          ? jet(t)
          : name === 'rainbow'
            ? rainbow(t)
            : name === 'viridis'
              ? poly(VIRIDIS, t)
              : name === 'inferno'
                ? poly(INFERNO, t)
                : turbo(t);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = Math.round(Math.max(0, Math.min(1, rgb[k])) * 255);
  }
  cache.set(name, lut);
  return lut;
}

/** Applies a colormap to scalars in [lo, hi] -> RGB bytes. */
export function applyColormap(values: Float32Array, lo: number, hi: number, name: string, out?: Uint8Array): Uint8Array {
  const lut = colormapLut(name);
  const n = values.length;
  const rgb = out && out.length >= n * 3 ? out : new Uint8Array(n * 3);
  const scale = hi > lo ? 255 / (hi - lo) : 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let idx = Number.isFinite(v) ? Math.round((v - lo) * scale) : 0;
    idx = idx < 0 ? 0 : idx > 255 ? 255 : idx;
    rgb[i * 3] = lut[idx * 3];
    rgb[i * 3 + 1] = lut[idx * 3 + 1];
    rgb[i * 3 + 2] = lut[idx * 3 + 2];
  }
  return rgb;
}

/** CSS linear-gradient for a colormap legend. */
export function colormapGradient(name: string): string {
  const lut = colormapLut(name);
  const stops: string[] = [];
  for (let i = 0; i <= 8; i++) {
    const k = Math.round((i / 8) * 255) * 3;
    stops.push(`rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]}) ${(i / 8) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
