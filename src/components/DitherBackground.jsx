import { useEffect, useRef } from "react";

// DitherBackground — a faithful port of React Bits' <Dither /> wave shader
// (reactbits.dev/backgrounds/dither): Perlin `cnoise` → turbulence fbm with a
// domain warp, a mouse dent, then 8×8 ordered-Bayer quantisation on pixelated
// coordinates. Ported into a plain WebGL canvas instead of pulling in three +
// @react-three/fiber + postprocessing (~600 kB) for a background layer.
//
// Sits behind all content (z-index -2, see .dither-bg in glass.css) and is
// tinted with the theme's accent token. No WebGL → renders nothing; the ambient
// gradient + grain still carry the background.

const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

const FS = `precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uBg;
uniform vec3 uWave;
uniform float uColorNum;
uniform float uPixelSize;
uniform float uWaveSpeed;
uniform float uWaveFrequency;
uniform float uWaveAmplitude;
uniform float uMouseRadius;
uniform float uMouseStrength;

vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }

float cnoise(vec2 P){
  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fade_xy = fade(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
}

float fbm(vec2 p){
  float value = 0.0;
  float amp = 1.0;
  float freq = uWaveFrequency;
  for (int i = 0; i < 4; i++) {
    value += amp * abs(cnoise(p));
    p *= freq;
    amp *= uWaveAmplitude;
  }
  return value;
}

float pattern(vec2 p){
  vec2 p2 = p - uTime * uWaveSpeed;
  return fbm(p + fbm(p2));
}

/* 8×8 ordered Bayer, built recursively — WebGL1 has no array indexing. */
float Bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float Bayer4(vec2 a){ return Bayer2(0.5 * a) * 0.25 + Bayer2(a); }
float Bayer8(vec2 a){ return Bayer4(0.5 * a) * 0.25 + Bayer2(a); }

void main(){
  /* pixelate, then centre + aspect-correct exactly like the reference */
  vec2 fc = floor(gl_FragCoord.xy / uPixelSize) * uPixelSize;
  vec2 uv = fc / uRes;
  uv -= 0.5;
  uv.x *= uRes.x / uRes.y;

  float f = pattern(uv);

  /* cursor dents the wave — tighter radius, slightly deeper than the reference */
  vec2 mNDC = (uMouse / uRes - 0.5) * vec2(1.0, -1.0);
  mNDC.x *= uRes.x / uRes.y;
  float effect = 1.0 - smoothstep(0.0, uMouseRadius, length(uv - mNDC));
  f -= uMouseStrength * effect;

  /* The reference computes col = mix(black, waveColor, f) with f UNCLAMPED and
     a mid-grey waveColor, so bright crests overshoot and saturate to full
     white; only the colour is clamped afterwards. f * 0.5 reproduces that
     value. Clamping f first (what I did before) flattened every crest to 50%
     grey and killed the contrast. */
  float v = clamp(f * 0.5, 0.0, 1.0);

  /* ordered dithering + bias, then quantise to uColorNum levels */
  float threshold = Bayer8(gl_FragCoord.xy / uPixelSize) - 0.25;
  float stepSize = 1.0 / (uColorNum - 1.0);
  v += threshold * stepSize;
  v = clamp(v - 0.2, 0.0, 1.0);
  v = floor(v * (uColorNum - 1.0) + 0.5) / (uColorNum - 1.0);

  /* OPAQUE, like the reference: the wave IS the page background. v = 1 lands
     on the ink colour — white on the dark theme, near-black on the light one. */
  gl_FragColor = vec4(mix(uBg, uWave, v), 1.0);
}`;

export default function DitherBackground() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return;

    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const U = (n) => gl.getUniformLocation(prog, n);
    const uRes = U("uRes"), uTime = U("uTime"), uMouse = U("uMouse"), uBg = U("uBg"), uWave = U("uWave");
    gl.uniform1f(U("uColorNum"), 4.0);
    gl.uniform1f(U("uPixelSize"), 2.0 * dpr); // 2 CSS px, like the reference at dpr 1
    gl.uniform1f(U("uWaveSpeed"), 0.05);
    gl.uniform1f(U("uWaveFrequency"), 3.0);
    gl.uniform1f(U("uWaveAmplitude"), 0.3);
    // Cursor dial: radius 0.18 is the size that landed; 0.8 depth keeps the
    // dent strong without burning a hole at the centre.
    gl.uniform1f(U("uMouseRadius"), 0.18);
    gl.uniform1f(U("uMouseStrength"), 0.8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // Base = the theme's ground; crest = HALFWAY to the ink. Full ink gave the
    // reference's hard black↔white contrast, which read as too loud behind a
    // data UI — the softer mid-tone crest is the deliberate choice here.
    let bg = [0.05, 0.05, 0.06], wave = [0.5, 0.5, 0.5];
    const readTheme = () => {
      const cs = getComputedStyle(document.documentElement);
      const parse = (name, fallback) => {
        const v = cs.getPropertyValue(name).trim().split(/\s+/).map((n) => parseFloat(n) / 255);
        return v.length === 3 && v.every((n) => !Number.isNaN(n)) ? v : fallback;
      };
      bg = parse("--c-bg", bg);
      const ink = parse("--c-text", [0.5, 0.5, 0.5]);
      wave = bg.map((c, i) => c + (ink[i] - c) * 0.5);
    };
    readTheme();
    const obs = new MutationObserver(readTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const mouse = { x: -1, y: -1 };
    const onMove = (e) => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; };
    window.addEventListener("pointermove", onMove);

    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    let rz;
    const onResize = () => { clearTimeout(rz); rz = setTimeout(resize, 120); };
    window.addEventListener("resize", onResize);

    let raf = 0;
    const frame = (t) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduce ? 0 : t * 0.001);
      gl.uniform2f(uMouse, mouse.x < 0 ? canvas.width / 2 : mouse.x, mouse.y < 0 ? canvas.height * 0.4 : mouse.y);
      gl.uniform3f(uBg, bg[0], bg[1], bg[2]);
      gl.uniform3f(uWave, wave[0], wave[1], wave[2]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    };
  }, []);

  return <canvas ref={ref} className="dither-bg" aria-hidden="true" />;
}
