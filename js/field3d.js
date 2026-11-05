// Real-time field: physical sky, drifting clouds, and an instanced reed field.
// The page is one day: noon at the top, the sun setting to dusk as you scroll.
// Wind is tied to scrolling only (a soft constant breeze, plus gusts from scroll).
// If anything here fails, the page keeps its 2D canvas fallback.
import * as THREE from 'three';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = innerWidth < 720;
const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1 : 1.25));
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 30000);
camera.rotation.order = 'YXZ';
camera.position.set(0, 1.55, 0);

const sunDir = new THREE.Vector3(), cSunDir = new THREE.Vector3();

// ---------- Time-of-day keys (linear-ish light colors) ----------
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = x => x * x * (3 - 2 * x);
// Colors are sRGB, art-directed per time of day.
const KEYS = [
  { at: 0,   elev: 58,  zen: [.13, .36, .78], hor: [.70, .84, .96], glow: [1, .98, .92], sun: [1, .98, .94], sunI: 1.25, amb: [.42, .52, .66], fog: [.72, .84, .95], cloud: .55, cLit: [1, 1, 1],      cShade: [.70, .77, .88], back: .15 },
  { at: .4,  elev: 30,  zen: [.16, .36, .72], hor: [.78, .84, .90], glow: [1, .94, .80], sun: [1, .94, .82], sunI: 1.15, amb: [.42, .48, .60], fog: [.78, .84, .90], cloud: .52, cLit: [1, .97, .92],  cShade: [.68, .70, .80], back: .25 },
  { at: .72, elev: 8,   zen: [.20, .30, .56], hor: [1, .68, .52],   glow: [1, .70, .46], sun: [1, .80, .55], sunI: 1.0,  amb: [.40, .36, .42], fog: [.96, .72, .58], cloud: .48, cLit: [1, .80, .58],  cShade: [.58, .48, .58], back: .55 },
  { at: 1,   elev: -.5, zen: [.08, .10, .24], hor: [.92, .50, .40], glow: [1, .48, .30], sun: [1, .55, .36], sunI: .55,  amb: [.20, .18, .30], fog: [.62, .40, .44], cloud: .4,  cLit: [1, .62, .56], cShade: [.44, .34, .50], back: .45 }
];
function tod(p) {
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i], b = KEYS[i + 1];
    if (p <= b.at) {
      const t = smooth((p - a.at) / (b.at - a.at)), o = {};
      for (const k in a) o[k] = Array.isArray(a[k]) ? a[k].map((v, j) => lerp(v, b[k][j], t)) : lerp(a[k], b[k], t);
      return o;
    }
  }
  return KEYS[KEYS.length - 1];
}

// ---------- Shared shader bits ----------
const NOISE = /* glsl */`
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float s = 0.0, a = .5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
`;
const U = {
  uTime: { value: 0 }, uGust: { value: 0 }, uDolly: { value: 0 },
  uSunDir: { value: sunDir }, uCSunDir: { value: cSunDir }, uSunCol: { value: new THREE.Color() }, uAmb: { value: new THREE.Color() },
  uFogCol: { value: new THREE.Color() }, uFogDen: { value: .006 },
  uCLit: { value: new THREE.Color() }, uCShade: { value: new THREE.Color() }, uCover: { value: .5 },
  uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uBack: { value: .2 }
};

// ---------- Sky dome: zenith-to-horizon gradient, sun disc, warm glow ----------
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(18000, 48, 24), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, uniforms: U,
  vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position,1.); }`,
  fragmentShader: /* glsl */`
    uniform vec3 uZen, uHor, uGlow, uSunDir;
    varying vec3 vDir;
    void main(){
      vec3 d = normalize(vDir);
      float h = max(d.y, 0.0);
      vec3 col = mix(uHor, uZen, pow(h, .45));
      float s = max(dot(d, uSunDir), 0.0);
      float low = 1.0 - smoothstep(0.0, .5, uSunDir.y);                 // sunset: glow spreads along the horizon
      col += uGlow * (pow(s, 6.0) * (.25 + .6 * low) + pow(s, 64.0) * .6) * (1.0 - h * .5);
      col += uGlow * low * .35 * exp(-h * 9.0) * pow(max(dot(normalize(d.xz), normalize(uSunDir.xz + 1e-4)), 0.0), 3.0);
      col = mix(col, mix(vec3(1.0, .99, .96), uGlow * 1.1 + .1, low), smoothstep(.9993, .9996, s));  // sun disc
      if (d.y < 0.0) col = uHor;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`
}));
skyDome.renderOrder = 0; scene.add(skyDome);

// ---------- Volumetric cumulus: raymarched through a 3D noise volume ----------
// Billowy, light-scattering clouds in the spirit of the Disney cloud renders:
// Beer–Lambert extinction, a short march toward the sun for self-shadowing,
// a "powder" term for dark crevices, two-lobe phase for silver linings, and an
// octave approximation of multiple scattering. Rendered at reduced resolution
// and composited behind the reeds.
function makeNoise3D(N) {
  // Tileable mix of inverted Worley (billows) and value noise (wisps)
  const data = new Uint8Array(N * N * N);
  const rnd = (i, s) => { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };
  const worley = (cells, seed) => {
    const pts = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < cells ** 3; i++) for (let k = 0; k < 3; k++) pts[i * 3 + k] = rnd(i * 3 + k, seed);
    const out = new Float32Array(N * N * N), cs = N / cells;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = x / cs, fy = y / cs, fz = z / cs, cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
      let m = 9;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx, iy = cy + dy, iz = cz + dz;
        const wx = (ix + cells) % cells, wy = (iy + cells) % cells, wz = (iz + cells) % cells;
        const pi = ((wz * cells + wy) * cells + wx) * 3;
        const px = ix + pts[pi], py = iy + pts[pi + 1], pz = iz + pts[pi + 2];
        const d = (px - fx) ** 2 + (py - fy) ** 2 + (pz - fz) ** 2; if (d < m) m = d;
      }
      out[(z * N + y) * N + x] = 1 - Math.min(1, Math.sqrt(m));
    }
    return out;
  };
  const value = (cells, seed) => {
    const g = new Float32Array(cells ** 3); for (let i = 0; i < g.length; i++) g[i] = rnd(i, seed);
    const out = new Float32Array(N * N * N), cs = N / cells, sm = t => t * t * (3 - 2 * t);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = x / cs, fy = y / cs, fz = z / cs, x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
      const tx = sm(fx - x0), ty = sm(fy - y0), tz = sm(fz - z0);
      const G = (a, b, c) => g[(((c % cells) * cells + (b % cells)) * cells) + (a % cells)];
      const l = (a, b, t) => a + (b - a) * t;
      out[(z * N + y) * N + x] = l(l(l(G(x0, y0, z0), G(x0 + 1, y0, z0), tx), l(G(x0, y0 + 1, z0), G(x0 + 1, y0 + 1, z0), tx), ty),
                                   l(l(G(x0, y0, z0 + 1), G(x0 + 1, y0, z0 + 1), tx), l(G(x0, y0 + 1, z0 + 1), G(x0 + 1, y0 + 1, z0 + 1), tx), ty), tz);
    }
    return out;
  };
  const w1 = worley(4, 1), w2 = worley(8, 2), w3 = worley(16, 3), v1 = value(8, 4), v2 = value(16, 5);
  for (let i = 0; i < data.length; i++) {
    const wf = w1[i] * .625 + w2[i] * .25 + w3[i] * .125;
    const vf = v1[i] * .65 + v2[i] * .35;
    const pw = Math.min(1, Math.max(0, (vf - (1 - wf)) / (1 - (1 - wf) + 1e-4)));   // Perlin-Worley remap
    data[i] = Math.round(Math.min(1, Math.max(0, pw * .55 + wf * .45)) * 255);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat; tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping; tex.unpackAlignment = 1; tex.needsUpdate = true;
  return tex;
}
U.uNoise = { value: makeNoise3D(small ? 48 : 64) };
U.uInvProj = { value: new THREE.Matrix4() }; U.uCamWorld = { value: new THREE.Matrix4() };
U.uFrame = { value: 0 };
// Art-directed cumulus towers (cauliflower clusters of blobs), mostly right of the headline
const BLOBS = [];
{
  const rnd = (i) => { const x = Math.sin(i * 91.7 + 7.3) * 43758.5453; return x - Math.floor(x); };
  const towers = [
    { x: 4200, z: -11500, s: 1.0, n: 9 }, { x: -3600, z: -14500, s: .7, n: 5 }, { x: 10500, z: -16000, s: .8, n: 5 },
    { x: 900, z: -21000, s: .6, n: 4 }, { x: -9500, z: -18000, s: .55, n: 3 }, { x: 16500, z: -24000, s: .6, n: 3 }, { x: -1500, z: -9000, s: .35, n: 3 }
  ];
  let k = 0;
  if (small) for (const t of towers) t.x -= 2800;          // narrow screens: pull the big cumulus into frame
  for (const t of towers) {
    const R = 1250 * t.s;
    BLOBS.push(new THREE.Vector4(t.x, 1300 + R * .55, t.z, R));
    for (let i = 1; i < t.n; i++) {
      const up = i / t.n, r = R * (.85 - up * .45) * (.8 + rnd(k++) * .4);
      BLOBS.push(new THREE.Vector4(t.x + (rnd(k++) - .5) * R * 1.3, 1300 + R * .55 + up * R * 1.5 + rnd(k++) * R * .2, t.z + (rnd(k++) - .5) * R * .9, r));
    }
  }
}
const NB = Math.min(BLOBS.length, 32);
while (BLOBS.length < 32) BLOBS.push(new THREE.Vector4(0, -1e5, 0, 1));   // shader array is fixed at 32
BLOBS.length = 32;
U.uBlobs = { value: BLOBS }; U.uNB = { value: NB }; U.uCamPos = { value: new THREE.Vector3() };
const CLOUD_STEPS = small ? 32 : 56;
const cloudRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
let cloudScale = small ? .34 : .5;
const fsGeo = new THREE.PlaneGeometry(2, 2);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const cloudScene = new THREE.Scene();
cloudScene.add(new THREE.Mesh(fsGeo, new THREE.ShaderMaterial({
  uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float; precision highp sampler3D;
    uniform sampler3D uNoise; uniform mat4 uInvProj, uCamWorld; uniform vec3 uCamPos;
    uniform vec3 uSunDir, uCSunDir, uSunCol, uZen, uHor, uCShade, uCLit; uniform float uCover, uTime, uDolly, uFrame;
    varying vec2 vUv;
    const float BASE = 1300.0, TOP = 6000.0;
    uniform vec4 uBlobs[32]; uniform int uNB;
    float hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
    float density(vec3 p, bool hi){
      if (p.y < BASE - 50.0 || p.y > TOP) return 0.0;
      float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
      vec3 drift = vec3(uTime * 7.0 + uDolly * .8, 0.0, 0.0);
      vec3 q = (p + drift * 1.4) / 13000.0;
      // towers: union of squashed spheres, flat at the condensation level
      float m = 0.0;
      for (int i = 0; i < 32; i++) {
        if (i >= uNB) break;
        vec4 b = uBlobs[i];
        vec3 d = (p - b.xyz - drift) / b.w; d.y *= d.y < 0.0 ? 1.7 : 1.0;
        m = max(m, 1.0 - length(d));
      }
      float base = smoothstep(BASE - 50.0, BASE + 200.0, p.y);
      if (m < -.15) return 0.0;                              // away from the towers: clean empty sky
      vec3 pd = p + drift;
      float n1 = texture(uNoise, pd / 2600.0).r, n2 = texture(uNoise, pd / 1100.0 + .37).r, n3 = texture(uNoise, pd / 480.0 + .71).r;
      float bill = (n1 - .5) * .5 + (n2 - .5) * .3 + (n3 - .5) * .14;   // cauliflower billows, three octaves
      bill = min(bill, bill * smoothstep(-.15, .1, m));      // billows grow from a tower, never as stray puffs
      float d = clamp((m + bill) * 4.0, 0.0, 1.0) * base;
      if (hi && d > 0.0) {                                   // erode: wispy toward the base, crisp billows up top
        float det = texture(uNoise, pd / 190.0 + vec3(0.0, uTime * .004, 0.0)).r;
        float er = mix(.45, .22, smoothstep(BASE, BASE + 1500.0, p.y));
        d = clamp(d - (1.0 - det) * er * (1.0 - d * .6), 0.0, 1.0);
      }
      return d;
    }
    float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }  // interleaved gradient noise
    void main(){
      vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0); v /= v.w;
      vec3 ro = uCamPos, rd = normalize((uCamWorld * vec4(v.xyz, 0.0)).xyz);
      if (rd.y < .01) { gl_FragColor = vec4(0.0); return; }
      if (rd.y < .02) { gl_FragColor = vec4(0.0); return; }
      float t0 = (BASE - ro.y) / rd.y, t1 = min((TOP - ro.y) / rd.y, t0 + 9000.0);
      float steps = float(${CLOUD_STEPS});
      float dt = (t1 - t0) / steps;
      float t = t0 + dt * ign(gl_FragCoord.xy + uFrame * 5.588);
      float cosT = dot(rd, uCSunDir);
      float phase = mix(hg(cosT, .78), hg(cosT, -.22), .35) * 4.0 + .25;
      vec3 sun = uCLit * max(length(uSunCol), 1.1) * 1.45;   // clouds stay sunlit at dusk
      float T = 1.0; vec3 L = vec3(0.0);
      for (int i = 0; i < ${CLOUD_STEPS}; i++){
        vec3 p = ro + rd * t;
        float d = density(p, true);
        if (d > .002) {
          // march toward the sun for self-shadowing
          float ld = 0.0; vec3 lp = p; float ls = 140.0;
          for (int j = 0; j < 6; j++){ lp += uCSunDir * ls; ld += density(lp, false) * ls; ls *= 1.55; }
          float sigma = .0045;
          // multiple-scattering approximation: a few octaves with softer extinction and flatter phase
          float ls_ = .03;                                   // light extinction: carves shadowed bases and crevices
          float beer = exp(-ld * ls_) * .75 + exp(-ld * ls_ * .22) * .2 + exp(-ld * ls_ * .05) * .05;
          float powder = 1.0 - exp(-d * 6.0);
          float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
          vec3 skyA = mix(uHor, uZen, .55);
          vec3 amb = mix(uCShade * .30 + skyA * .10, (skyA * .6 + uCLit * .4) * .62, smoothstep(0.0, .7, h));
          amb *= 1.0 + .9 * (1.0 - smoothstep(.1, .5, uCSunDir.y));   // low sun: sky fill keeps backlit faces from going muddy
          vec3 S = sun * beer * phase * mix(1.0, powder, .7) + amb;
          // aerial perspective: distant clouds sink into the horizon haze
          float far = 1.0 - exp(-(t - t0) * .00007 - t0 * .00005);
          S = mix(S, uHor * 1.05, far * .7);
          float ext = d * sigma * dt;
          float Tn = exp(-ext);
          L += T * S * (1.0 - Tn);
          T *= Tn;
          if (T < .02) break;
        }
        t += dt;
      }
      float horizonFade = smoothstep(.01, .08, rd.y);
      gl_FragColor = vec4(L * horizonFade, (1.0 - T) * horizonFade);
    }`
})));
// composite pass: upsampled clouds, drawn behind anything nearer (depth = far plane)
const cloudComp = new THREE.Mesh(fsGeo, new THREE.ShaderMaterial({
  uniforms: { tClouds: { value: cloudRT.texture }, uTexel: { value: new THREE.Vector2() } }, transparent: true, depthWrite: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
  fragmentShader: /* glsl */`uniform sampler2D tClouds; uniform vec2 uTexel; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tClouds, vUv) * .4 + (texture2D(tClouds, vUv + vec2(uTexel.x, 0.)) + texture2D(tClouds, vUv - vec2(uTexel.x, 0.)) + texture2D(tClouds, vUv + vec2(0., uTexel.y)) + texture2D(tClouds, vUv - vec2(0., uTexel.y))) * .15; vec3 rgb = c.rgb / max(c.a, 1e-4);                  // un-premultiply so the sRGB curve doesn't halo the soft edges
      float mx = max(max(rgb.r, rgb.g), rgb.b);           // hue-preserving soft clip: silver linings stay gold/pink instead of bleaching
      if (mx > .8) rgb *= (.8 + .2 * (1.0 - exp(-(mx - .8) / .2))) / mx;
      gl_FragColor = vec4(rgb, c.a);
      #include <colorspace_fragment>
      gl_FragColor.rgb *= gl_FragColor.a;
    }`
}));
cloudComp.frustumCulled = false; cloudComp.renderOrder = 2; scene.add(cloudComp);
function renderClouds() {
  camera.updateMatrixWorld();
  U.uCamPos.value.copy(camera.position); U.uInvProj.value.copy(camera.projectionMatrixInverse); U.uCamWorld.value.copy(camera.matrixWorld);
  U.uFrame.value = (U.uFrame.value + 1) % 64;
  const w = Math.max(2, Math.round(innerWidth * renderer.getPixelRatio() * cloudScale)), h = Math.max(2, Math.round(innerHeight * renderer.getPixelRatio() * cloudScale));
  if (cloudRT.width !== w || cloudRT.height !== h) { cloudRT.setSize(w, h); cloudComp.material.uniforms.uTexel.value.set(1 / w, 1 / h); }
  renderer.setRenderTarget(cloudRT); renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(cloudScene, orthoCam);
  renderer.setRenderTarget(null);
}

// ---------- Ground ----------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000, 1, 1), new THREE.ShaderMaterial({
  uniforms: U,
  vertexShader: /* glsl */`varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSunCol, uAmb, uFogCol, uSunDir; uniform float uFogDen, uDolly; varying vec3 vW; ${NOISE}
    void main(){
      vec2 q = vW.xz + vec2(uDolly, 0.0);
      float n = fbm(q * .05) * .7 + fbm(q * .35) * .3;
      vec3 base = mix(vec3(.04, .12, .02), vec3(.10, .24, .04), n);
      vec3 col = base * (uAmb + uSunCol * max(uSunDir.y, 0.0) * .9);
      float dist = length(vW - cameraPosition);
      col = mix(col, uFogCol, 1.0 - exp(-dist * uFogDen));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
}));
ground.rotation.x = -Math.PI / 2; scene.add(ground);

// ---------- Reeds: instanced blades ----------
const COUNT = small ? 38000 : 110000;
const SEG = 4;
const blade = new THREE.InstancedBufferGeometry();
{
  const pos = [], idx = [];
  for (let i = 0; i <= SEG; i++) { const y = i / SEG, w = .5 * (1 - y * .92); pos.push(-w, y, 0, w, y, 0); }
  for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  blade.setIndex(idx);
  const off = new Float32Array(COUNT * 4), shape = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    const r = Math.random();
    const z = -(1.2 + 58 * Math.pow(r, 1.6));             // denser near the camera
    const half = Math.abs(z) * .62 + 3;                     // span matches the view width at that depth
    off[i * 4] = (Math.random() * 2 - 1) * half; off[i * 4 + 1] = z; off[i * 4 + 2] = half; off[i * 4 + 3] = Math.random();
    shape[i * 4] = .55 + Math.random() * .6;                // height (m)
    shape[i * 4 + 1] = .022 + Math.random() * .02;          // width (m)
    shape[i * 4 + 2] = Math.random() * Math.PI;             // facing
    shape[i * 4 + 3] = Math.random();                       // tint variation
  }
  blade.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  blade.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4));
  blade.instanceCount = COUNT;
}
const reeds = new THREE.Mesh(blade, new THREE.ShaderMaterial({
  uniforms: U, side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    uniform float uTime, uGust, uDolly; attribute vec4 aOff, aShape;
    varying float vH; varying float vTint; varying vec3 vW; varying vec3 vN;
    void main(){
      float h = position.y;
      float half_ = aOff.z;
      float x = mod(aOff.x + uDolly + half_, half_ * 2.0) - half_;   // endless lateral drift
      vec3 root = vec3(x, 0.0, aOff.y);
      float c = cos(aShape.z), s = sin(aShape.z);
      float wd = aShape.y * (1.0 + abs(aOff.y) * .035);
      vec3 p = vec3(position.x * wd * c, h * aShape.x, position.x * wd * s);
      // wind: soft breeze always, gusts from scrolling roll across the field
      vec2 wp = root.xz + vec2(uDolly, 0.0);
      float breeze = .22 + .12 * sin(wp.x * .45 + uTime * 1.4 + aOff.w * 6.0) + .1 * sin(wp.x * .11 + wp.y * .17 + uTime * .6);
      float wave = uGust * (.6 + .4 * sin(wp.x * .09 - wp.y * .05 - uTime * 2.2 * sign(uGust + 1e-4)));
      float bend = (breeze + wave) * h * h;
      p.x += bend * aShape.x * .65; p.z -= bend * aShape.x * .15; p.y -= bend * bend * aShape.x * .25;
      vec4 w = modelMatrix * vec4(root + p, 1.0);
      vH = h; vTint = aShape.w; vW = w.xyz; vN = normalize(vec3(s, .35, -c));
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSunCol, uAmb, uFogCol, uSunDir; uniform float uFogDen, uBack;
    varying float vH; varying float vTint; varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 rootC = vec3(.02, .07, .01), tipC = mix(vec3(.16, .36, .04), vec3(.28, .42, .06), vTint);
      vec3 albedo = mix(rootC, tipC, pow(vH, .8));
      vec3 V = normalize(cameraPosition - vW);
      float diff = abs(dot(normalize(vN), uSunDir)) * .6 + .4;
      float back = pow(max(dot(-V, uSunDir), 0.0), 6.0) * vH;          // light glowing through the blades
      vec3 col = albedo * (uAmb * (.6 + .4 * vH) + uSunCol * max(uSunDir.y + .05, 0.0) * diff)
               + uSunCol * back * vec3(.9, .8, .35) * uBack;
      float dist = length(vW - cameraPosition);
      col = mix(col, uFogCol, 1.0 - exp(-dist * uFogDen));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
}));
reeds.frustumCulled = false; scene.add(reeds);

// ---------- Scroll: time of day + gusts ----------
let gust = 0, lastY = scrollY, prog = 0;
addEventListener('scroll', () => { const d = scrollY - lastY; lastY = scrollY; gust = Math.max(-1.1, Math.min(1.1, gust + d * .006)); if (reduce) frame(performance.now()); }, { passive: true });
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

let last = performance.now(), dolly = 0, slowAcc = 16;
function frame(t) {
  const dt = Math.min(.05, (t - last) / 1000); last = t;
  const docH = document.documentElement.scrollHeight - innerHeight;
  prog = Math.min(1, Math.max(0, scrollY / Math.max(1, docH)));
  const k = tod(prog);
  // sun path: high noon to the right of frame, setting just right of center
  const elev = THREE.MathUtils.degToRad(k.elev), az = THREE.MathUtils.degToRad(lerp(200, 162, smooth(prog)));
  sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, az);
  // clouds sit kilometres up, so they keep catching sun after it leaves the field
  cSunDir.setFromSphericalCoords(1, Math.PI / 2 - Math.max(elev, THREE.MathUtils.degToRad(4)), az);
  const S = THREE.SRGBColorSpace;
  U.uSunCol.value.setRGB(...k.sun, S).multiplyScalar(k.sunI);
  U.uAmb.value.setRGB(...k.amb, S); U.uFogCol.value.setRGB(...k.hor, S);
  U.uCLit.value.setRGB(...k.cLit, S); U.uCShade.value.setRGB(...k.cShade, S); U.uCover.value = k.cloud;
  U.uZen.value.setRGB(...k.zen, S); U.uHor.value.setRGB(...k.hor, S); U.uGlow.value.setRGB(...k.glow, S); U.uBack.value = k.back;
  if (!reduce) { U.uTime.value += dt; dolly += dt * .35; }
  U.uDolly.value = dolly;
  gust *= Math.pow(.25, dt); U.uGust.value = lerp(U.uGust.value, gust, Math.min(1, dt * 4));
  // camera: low, wide, Dutch tilt; tilts down a touch as you scroll
  camera.rotation.set(THREE.MathUtils.degToRad(lerp(4, -2, Math.min(1, scrollY / innerHeight))), 0, THREE.MathUtils.degToRad(-5));
  // adaptive: if frames run slow, render the clouds at lower resolution
  slowAcc = slowAcc * .95 + dt * 1000 * .05; if (slowAcc > 24 && cloudScale > .26) { cloudScale -= .04; slowAcc = 16; }
  renderClouds();
  renderer.render(scene, camera);
  // share the sun's screen position so the page's light layer can let it burn through
  const sp = sunDir.clone().multiplyScalar(10000).add(camera.position).project(camera);
  window.__sun = { x: (sp.x + 1) / 2 * innerWidth, y: (1 - sp.y) / 2 * innerHeight, on: sp.z < 1 && Math.abs(sp.x) < 1.3 && Math.abs(sp.y) < 1.3,
                   low: 1 - smooth(Math.min(1, Math.max(0, k.elev / 30))), col: k.glow };
}
let running = !document.hidden;
document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(loop); });
function loop(t) { frame(t); if (running && !reduce) requestAnimationFrame(loop); }

frame(performance.now());
document.body.classList.add('webgl');
window.__field3d = true;
dispatchEvent(new Event('field3d'));
requestAnimationFrame(loop);
