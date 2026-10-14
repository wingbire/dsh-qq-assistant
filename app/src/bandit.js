export const ARMS = ["terse", "standard", "detailed"];
export const ARM_POLICY = { terse: { maxChars: 20 }, standard: { maxChars: 60 }, detailed: { maxChars: 200 } };
export const BUCKETS = ["question", "banter", "game", "smalltalk", "general"];

export function bucketOf(buckets) {
  const list = buckets || [];
  for (const b of BUCKETS) if (list.includes(b)) return b;
  return "general";
}

function gidOf(gid) { return String(gid == null || gid === "" ? "default" : gid); }

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createBandit(opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  const PRIOR_VAR = o.priorVar == null ? 4 : o.priorVar;
  const cells = new Map();

  function key(gid, bucket, arm) { return gidOf(gid) + "|" + bucket + "|" + arm; }

  function cell(gid, bucket, arm) {
    const k = key(gid, bucket, arm);
    let c = cells.get(k);
    if (!c) { c = { gid: gidOf(gid), bucket: bucket, arm: arm, n: 0, mean: 0, m2: 0 }; cells.set(k, c); }
    return c;
  }

  function peek(gid, bucket, arm) {
    const c = cells.get(key(gid, bucket, arm));
    return c || { gid: gidOf(gid), bucket: bucket, arm: arm, n: 0, mean: 0, m2: 0 };
  }

  function choose(bucket, gid) {
    let best = null, bestSample = -Infinity;
    const detail = [];
    for (const arm of ARMS) {
      const c = peek(gid, bucket, arm);
      const varEst = c.n > 1 ? c.m2 / (c.n - 1) : PRIOR_VAR;
      const s = c.mean + gauss(rng) * Math.sqrt(varEst / (c.n + 1));
      detail.push({ arm: arm, sample: s, n: c.n, mean: c.mean });
      if (s > bestSample) { bestSample = s; best = arm; }
    }
    return { arm: best, gid: gidOf(gid), bucket: bucket, detail: detail };
  }

  function update(bucket, arm, r, gid) {
    const c = cell(gid, bucket, arm);
    c.n += 1;
    const d = r - c.mean;
    c.mean += d / c.n;
    c.m2 += d * (r - c.mean);
    return c;
  }

  function state() {
    const out = {};
    for (const [k, c] of cells) out[k] = { n: c.n, mean: Math.round(c.mean * 1000) / 1000 };
    return out;
  }

  function hydrate(state) {
    if (!state || typeof state !== "object") return 0;
    let n = 0;
    for (const [k, v] of Object.entries(state)) {
      const parts = String(k).split("|");
      if (parts.length !== 3) continue;
      const c = cell(parts[0], parts[1], parts[2]);
      c.n = Number(v.n) || 0;
      c.mean = Number(v.mean) || 0;
      c.m2 = 0;
      n += 1;
    }
    return n;
  }

  function groups() {
    const s = new Set();
    for (const c of cells.values()) s.add(c.gid);
    return Array.from(s);
  }

  return { choose: choose, update: update, state: state, hydrate: hydrate, groups: groups, ARMS: ARMS, BUCKETS: BUCKETS };
}
