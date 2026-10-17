// Numeric Bedrock animation channels only. Molang expressions are intentionally
// not evaluated: game-dependent channels remain at their default values.
function vector(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return vector(value.post ?? value.pre, fallback);
  const values = Array.isArray(value) ? value : [value, value, value];
  return values.map((v, i) => typeof v === 'number' && Number.isFinite(v) ? v : fallback[i]);
}

export function sampleChannel(channel, time, fallback = [0, 0, 0]) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return vector(channel, fallback);
  if ('post' in channel || 'pre' in channel) return vector(channel, fallback);
  const keys = Object.keys(channel).map(Number).filter(Number.isFinite).sort((a,b) => a-b);
  if (!keys.length) return fallback;
  const values = new Map(Object.entries(channel).map(([k,v]) => [Number(k),v]));
  if (time <= keys[0]) return vector(values.get(keys[0]), fallback);
  const end = keys.findIndex(k => k > time);
  if (end < 0) return vector(values.get(keys.at(-1)), fallback);
  const first = values.get(keys[end-1]), second = values.get(keys[end]);
  const a = vector(first?.post ?? first, fallback), b = vector(second?.pre ?? second, fallback);
  // YSMFolderDeserializer also accepts "step": hold the start value.
  if (first?.lerp_mode === 'step') return a;
  const fraction = (time-keys[end-1])/(keys[end]-keys[end-1]);
  // GeckoLib/YSM selects the destination keyframe's easing when it is
  // Catmull-Rom, otherwise it inherits the start keyframe's easing. Either
  // endpoint can therefore make this segment a spline.
  if (second?.lerp_mode === 'catmullrom' || first?.lerp_mode === 'catmullrom') {
    const left=values.get(keys[Math.max(0,end-2)]),right=values.get(keys[Math.min(keys.length-1,end+1)]);
    const before=vector(left?.post??left,fallback);
    const after=vector(right?.pre??right,fallback);
    return a.map((v,i) => 0.5*((2*v)+(-before[i]+b[i])*fraction+(2*before[i]-5*v+4*b[i]-after[i])*fraction**2+(-before[i]+3*v-3*b[i]+after[i])*fraction**3));
  }
  return a.map((v,i)=>v+(b[i]-v)*fraction);
}
