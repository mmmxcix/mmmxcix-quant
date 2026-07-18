import { useEffect, useRef } from "react";

// DitherBackground — a subtle flowing wave + ordered-dither field, cursor-
// reactive, rendered with raw WebGL (no dependency). Sits behind all content
// (z-index -2, see .dither-bg in glass.css); the frosted panels blur it as they
// pass over. Theme-aware: reads the --c-accent token and dims for light/dark.
// If WebGL is unavailable it renders nothing — the ambient gradient + grain
// still carry the background.

const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FS = `precision mediump float;
uniform vec2 uRes;uniform float uTime;uniform vec2 uMouse;uniform vec3 uCol;uniform float uAlpha;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*noise(p);p*=2.02;a*=.5;}return s;}
float B2(vec2 a){a=floor(a);return fract(a.x/2.+a.y*a.y*.75);}
void main(){
  float PX=5.0;                                  // chunky pixels, like the reference
  vec2 cell=floor(gl_FragCoord.xy/PX);
  vec2 res=uRes/PX;
  vec2 uv=cell/res;
  vec2 asp=vec2(res.x/res.y,1.0);
  vec2 p=uv*asp*2.2;
  float t=uTime*0.35;

  // flowing wave field — smooth bands rather than grain
  float f=fbm(p+vec2(t*0.12,t*0.08));
  f+=0.35*sin(p.x*2.6+t*0.9);
  f+=0.28*sin((p.x+p.y)*1.7-t*0.7);
  f=f*0.5+0.5;

  // cursor swells the wave locally
  vec2 m=(uMouse/uRes)*asp;
  f+=smoothstep(0.45,0.0,distance(uv*asp,m))*0.35;

  // ordered (Bayer) dithering into a few density levels
  float b4=B2(cell*0.5)*0.25+B2(cell);
  float levels=4.0;
  float q=floor(clamp(f,0.0,1.0)*levels+b4)/levels;
  gl_FragColor=vec4(uCol,clamp(q,0.0,1.0)*uAlpha);
}`;

export default function DitherBackground() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return; // no WebGL → gradient + grain remain

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

    const U = {
      res: gl.getUniformLocation(prog, "uRes"),
      time: gl.getUniformLocation(prog, "uTime"),
      mouse: gl.getUniformLocation(prog, "uMouse"),
      col: gl.getUniformLocation(prog, "uCol"),
      alpha: gl.getUniformLocation(prog, "uAlpha"),
    };
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // theme-driven colour/alpha, refreshed on data-theme changes
    let col = [0.05, 0.58, 0.53], alpha = 0.14;
    const readTheme = () => {
      const cs = getComputedStyle(document.documentElement);
      const rgb = cs.getPropertyValue("--c-accent").trim().split(/\s+/).map((n) => parseFloat(n) / 255);
      if (rgb.length === 3 && rgb.every((n) => !Number.isNaN(n))) col = rgb;
      // strong enough to read as texture through the frosted panels
      alpha = document.documentElement.dataset.theme === "dark" ? 0.32 : 0.2;
    };
    readTheme();
    const obs = new MutationObserver(readTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const mouse = { x: -1, y: -1 };
    const onMove = (e) => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; };
    window.addEventListener("pointermove", onMove);

    const resize = () => { canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr; gl.viewport(0, 0, canvas.width, canvas.height); };
    resize();
    let rz;
    const onResize = () => { clearTimeout(rz); rz = setTimeout(resize, 120); };
    window.addEventListener("resize", onResize);

    let raf = 0;
    const frame = (t) => {
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform1f(U.time, t * 0.001);
      gl.uniform2f(U.mouse, mouse.x < 0 ? canvas.width / 2 : mouse.x, mouse.y < 0 ? canvas.height * 0.4 : mouse.y);
      gl.uniform3f(U.col, col[0], col[1], col[2]);
      gl.uniform1f(U.alpha, alpha);
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
