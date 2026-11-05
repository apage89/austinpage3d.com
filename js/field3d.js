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

const sunDir = new THREE.Vector3();

// ---------- Time-of-day keys (linear-ish light colors) ----------
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = x => x * x * (3 - 2 * x);
// Colors are sRGB, art-directed per time of day.
const KEYS = [
  { at: 0,   elev: 58,  zen: [.13, .36, .78], hor: [.70, .84, .96], glow: [1, .98, .92], sun: [1, .98, .94], sunI: 1.25, amb: [.42, .52, .66], fog: [.72, .84, .95], cloud: .5,  cLit: [1, 1, 1],      cShade: [.70, .77, .88], back: .15 },
  { at: .4,  elev: 30,  zen: [.16, .36, .72], hor: [.78, .84, .90], glow: [1, .94, .80], sun: [1, .94, .82], sunI: 1.15, amb: [.42, .48, .60], fog: [.78, .84, .90], cloud: .47, cLit: [1, .97, .92],  cShade: [.68, .70, .80], back: .25 },
  { at: .72, elev: 8,   zen: [.20, .30, .56], hor: [1, .72, .42],   glow: [1, .72, .36], sun: [1, .80, .55], sunI: 1.0,  amb: [.40, .36, .42], fog: [.96, .74, .52], cloud: .42, cLit: [1, .80, .58],  cShade: [.58, .48, .58], back: .55 },
  { at: 1,   elev: -.5, zen: [.08, .10, .24], hor: [.92, .50, .40], glow: [1, .48, .30], sun: [1, .55, .36], sunI: .55,  amb: [.20, .18, .30], fog: [.62, .40, .44], cloud: .3,  cLit: [.96, .58, .50], cShade: [.30, .24, .36], back: .45 }
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
  uSunDir: { value: sunDir }, uSunCol: { value: new THREE.Color() }, uAmb: { value: new THREE.Color() },
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

// ---------- Clouds: cumulus projected on a dome ----------
const clouds = new THREE.Mesh(new THREE.SphereGeometry(15000, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.BackSide, uniforms: U,
  vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position,1.); }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uCover, uDolly; uniform vec3 uCLit, uCShade, uSunDir; varying vec3 vDir; ${NOISE}
    float dens(vec2 p){ float n = fbm(p) * .7 + fbm(p * 2.3 + 9.0) * .3; return smoothstep(1.0 - uCover, 1.0 - uCover + .18, n); }
    void main(){
      vec3 d = normalize(vDir);
      if (d.y < 0.0) discard;
      vec2 p = d.xz / (d.y + .12) * .85 + vec2(uTime * .012 + uDolly * .002, uTime * .004);
      float c = dens(p);
      if (c < .01) discard;
      float c2 = dens(p + normalize(uSunDir.xz + 1e-4) * .18);          // density toward the sun: self-shadowing
      float lit = clamp(1.0 - (c2 - c * .6) * 1.4, 0.0, 1.0);
      float rim = pow(max(dot(d, uSunDir), 0.0), 8.0) * (1.0 - c) * 1.5;  // silver lining near the sun
      vec3 col = mix(uCShade, uCLit, lit) + uCLit * rim;
      float horizon = smoothstep(.0, .12, d.y);
      gl_FragColor = vec4(col, c * horizon * .95);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
}));
clouds.renderOrder = 1; scene.add(clouds);

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

let last = performance.now(), dolly = 0;
function frame(t) {
  const dt = Math.min(.05, (t - last) / 1000); last = t;
  const docH = document.documentElement.scrollHeight - innerHeight;
  prog = Math.min(1, Math.max(0, scrollY / Math.max(1, docH)));
  const k = tod(prog);
  // sun path: high noon to the right of frame, setting just right of center
  const elev = THREE.MathUtils.degToRad(k.elev), az = THREE.MathUtils.degToRad(lerp(200, 162, smooth(prog)));
  sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, az);
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
