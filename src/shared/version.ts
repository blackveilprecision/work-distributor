// The release version, from package.json; bun build --compile embeds it. A release tag is v<this>.
import pkg from "../../package.json";
export const VERSION: string = pkg.version;

export const releaseUrl = (version: string, os: string, arch: string, base = process.env.WD_RELEASES || "https://github.com/blackveilprecision/work-distributor/releases/download") =>
  `${base}/v${version}/wd-${os}-${arch}`;

// Numeric compare of x.y.z; anything unparsable counts as 0.
export const newer = (a: string, b: string) => {
  const p = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
