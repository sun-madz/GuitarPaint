// Guitar Paint — fluid watercolour engine.
//
// Ink is simulated as pigment carried by water: a small fluid simulation
// (velocity, pressure, swirl) moves a "dye" layer around. The dye stores how
// much light the pigment absorbs in red, green and blue, so overlapping
// colours mix the way real paint does (blue into yellow goes green) rather
// than just layering on top of each other. A final pass turns that into
// watercolour on paper: darker pooled edges, grain settling into the paper,
// and the paper colour showing through.
//
// Exposes window.InkFluid.create(canvas) -> engine, or null if WebGL isn't
// available (the app then falls back to its simpler canvas painter).
(function(){
  'use strict';

  const VERT = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main(){
      vUv = aPosition*0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const NOISE = `
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f*f*(3.0 - 2.0*f);
      return mix(mix(hash(i), hash(i + vec2(1.0,0.0)), u.x),
                 mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for(int i=0;i<4;i++){ v += a*vnoise(p); p *= 2.03; a *= 0.5; }
      return v;
    }`;

  const FRAG = {
    copy: `
      precision highp float; varying vec2 vUv; uniform sampler2D uTexture;
      void main(){ gl_FragColor = texture2D(uTexture, vUv); }`,

    scale: `
      precision highp float; varying vec2 vUv; uniform sampler2D uTexture; uniform float value;
      void main(){ gl_FragColor = value*texture2D(uTexture, vUv); }`,

    // pigment drop: adds absorbance in a ragged, mottled patch, and marks the
    // area as freshly painted (alpha = age in seconds, reset towards 0)
    dyeSplat: `
      precision highp float; varying vec2 vUv;
      uniform sampler2D uTarget; uniform float aspectRatio;
      uniform vec2 point; uniform float radius; uniform vec3 color; uniform float seed; uniform float rough;
      ${NOISE}
      void main(){
        vec2 p = vUv - point; p.x *= aspectRatio;
        float ang = atan(p.y, p.x);
        // cloud-like edge: how far the wash reaches wobbles softly around it
        vec2 q = p/max(radius, 1e-4);
        float edge = 1.0 + rough*(0.7*(fbm(q*1.3 + seed) - 0.5) + 0.12*sin(ang*2.0 + seed));
        float d = length(p)/(radius*max(edge, 0.3));
        // flat-topped: an even wash with a defined edge, not a soft dot
        float g = exp(-d*d*d*d*1.3);
        // mottled inside, like pigment that hasn't spread evenly
        float mott = 0.6 + 0.8*fbm(q*2.2 + seed*1.3);
        vec4 base = texture2D(uTarget, vUv);
        vec3 a = max(base.rgb + color*g*mott, 0.0);
        float fresh = clamp(g*4.0*step(0.0, color.r + color.g + color.b), 0.0, 1.0);
        gl_FragColor = vec4(a, mix(base.a, 0.0, fresh));
      }`,

    // water push: outward burst, a swirl, and a directional shove
    velSplat: `
      precision highp float; varying vec2 vUv;
      uniform sampler2D uTarget; uniform float aspectRatio;
      uniform vec2 point; uniform float radius; uniform float radial; uniform float swirl; uniform vec2 push;
      void main(){
        vec2 p = vUv - point; p.x *= aspectRatio;
        float r2 = dot(p,p)/(radius*radius);
        float g = exp(-r2);
        vec2 dir = length(p) > 1e-5 ? normalize(p) : vec2(0.0);
        vec2 perp = vec2(-dir.y, dir.x);
        vec2 v = (dir*radial*sqrt(r2) + perp*swirl*sqrt(r2) + push)*g;
        gl_FragColor = vec4(texture2D(uTarget, vUv).xy + v, 0.0, 1.0);
      }`,

    advection: `
      precision highp float; varying vec2 vUv;
      uniform sampler2D uVelocity, uSource; uniform vec2 texelSize, dyeTexelSize;
      uniform float dt, dissipation;
      uniform int manualFilter;
      vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize){
        vec2 st = uv/tsize - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5,0.5))*tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5,0.5))*tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5,1.5))*tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5,1.5))*tsize);
        return mix(mix(a,b,fuv.x), mix(c,d,fuv.x), fuv.y);
      }
      void main(){
        vec2 vel = manualFilter == 1 ? bilerp(uVelocity, vUv, texelSize).xy : texture2D(uVelocity, vUv).xy;
        vec2 coord = vUv - dt*vel*texelSize;
        vec4 r = manualFilter == 1 ? bilerp(uSource, coord, dyeTexelSize) : texture2D(uSource, coord);
        gl_FragColor = r/(1.0 + dissipation*dt);
      }`,

    // dye advection + ageing + fading
    dyeAdvection: `
      precision highp float; varying vec2 vUv;
      uniform sampler2D uVelocity, uSource; uniform vec2 texelSize, dyeTexelSize;
      uniform float dt, ageDt; uniform float fade, linger, tau;
      uniform int manualFilter;
      vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize){
        vec2 st = uv/tsize - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5,0.5))*tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5,0.5))*tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5,1.5))*tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5,1.5))*tsize);
        return mix(mix(a,b,fuv.x), mix(c,d,fuv.x), fuv.y);
      }
      void main(){
        vec2 vel = manualFilter == 1 ? bilerp(uVelocity, vUv, texelSize).xy : texture2D(uVelocity, vUv).xy;
        vec2 coord = vUv - dt*vel*texelSize;
        vec4 r = manualFilter == 1 ? bilerp(uSource, coord, dyeTexelSize) : texture2D(uSource, coord);
        // age and fading run on real seconds, even if frames are slow
        r.a = min(r.a + ageDt, 60000.0);
        if(fade > 0.5 && r.a > linger){
          r.rgb *= exp(-ageDt/tau);
          r.rgb = max(r.rgb - ageDt*0.02, 0.0);
        }
        gl_FragColor = r;
      }`,

    divergence: `
      precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
      void main(){
        float L = texture2D(uVelocity, vL).x, R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y, B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if(vL.x < 0.0) L = -C.x; if(vR.x > 1.0) R = -C.x;
        if(vT.y > 1.0) T = -C.y; if(vB.y < 0.0) B = -C.y;
        gl_FragColor = vec4(0.5*(R - L + T - B), 0.0, 0.0, 1.0);
      }`,

    curl: `
      precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
      void main(){
        float L = texture2D(uVelocity, vL).y, R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x, B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(0.5*(R - L - T + B), 0.0, 0.0, 1.0);
      }`,

    vorticity: `
      precision highp float; varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity, uCurl; uniform float curl, dt;
      void main(){
        float L = texture2D(uCurl, vL).x, R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x, B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5*vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl*C; force.y *= -1.0;
        vec2 v = texture2D(uVelocity, vUv).xy + force*dt;
        gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
      }`,

    pressure: `
      precision highp float; varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uPressure, uDivergence;
      void main(){
        float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
        float div = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - div)*0.25, 0.0, 0.0, 1.0);
      }`,

    gradientSubtract: `
      precision highp float; varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uPressure, uVelocity;
      void main(){
        float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
        vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,

    // watercolour on paper
    display: `
      precision highp float; varying vec2 vUv;
      uniform sampler2D uDye, uPaper, uGrain;
      uniform vec2 dyeTexel; uniform vec2 grainScale; uniform float edgeAmt, grainAmt;
      vec3 A(vec2 uv){ return texture2D(uDye, uv).rgb; }
      void main(){
        vec3 a = A(vUv);
        // local average a few texels out, to find the edges of the paint
        vec2 o = dyeTexel*6.0;
        vec3 avg = (A(vUv + vec2(o.x,0.0)) + A(vUv - vec2(o.x,0.0)) + A(vUv + vec2(0.0,o.y)) + A(vUv - vec2(0.0,o.y))
                  + A(vUv + o) + A(vUv - o) + A(vUv + vec2(o.x,-o.y)) + A(vUv + vec2(-o.x,o.y)))*0.125;
        // pigment piles up just inside the edge of a wash as it dries
        vec3 edge = max(a - avg, 0.0);
        a += edge*edgeAmt;
        // where the wet edge stopped: the faint outer haze is pulled in so
        // each wash has a defined boundary instead of an airbrushed fade
        float cov = dot(a, vec3(0.333));
        a *= mix(0.25, 1.0, smoothstep(0.02, 0.11, cov));
        // granulation: pigment settles into the dips in the paper
        float g = texture2D(uGrain, vUv*grainScale).r;
        float amount = clamp(dot(a, vec3(0.333)), 0.0, 1.0);
        a *= 1.0 + grainAmt*(g - 0.5)*(0.6 + amount);
        // overlapping washes deepen, but saturate rather than turning black
        a = 1.35*(1.0 - exp(-a/1.35));
        vec3 paper = texture2D(uPaper, vec2(vUv.x, 1.0 - vUv.y)).rgb;
        gl_FragColor = vec4(paper*exp(-a), 1.0);
      }`
  };

  function create(canvas){
    const params = { alpha:false, depth:false, stencil:false, antialias:false, preserveDrawingBuffer:true };
    let gl = canvas.getContext('webgl2', params);
    const isGL2 = !!gl;
    if(!gl) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    if(!gl) return null;

    let halfFloat, supportLinear;
    if(isGL2){
      if(!gl.getExtension('EXT_color_buffer_float')) return null;
      supportLinear = !!gl.getExtension('OES_texture_float_linear') || true; // RGBA16F filters linearly in WebGL2
      halfFloat = gl.HALF_FLOAT;
    }else{
      const ext = gl.getExtension('OES_texture_half_float');
      if(!ext) return null;
      halfFloat = ext.HALF_FLOAT_OES;
      supportLinear = !!gl.getExtension('OES_texture_half_float_linear');
    }
    const fmtRGBA = isGL2 ? gl.RGBA16F : gl.RGBA;
    const fmtRG   = isGL2 ? gl.RG16F : gl.RGBA;
    const fmtR    = isGL2 ? gl.R16F : gl.RGBA;
    const srcRG   = isGL2 ? gl.RG : gl.RGBA;
    const srcR    = isGL2 ? gl.RED : gl.RGBA;
    const filter  = supportLinear ? gl.LINEAR : gl.NEAREST;

    // can we actually render into half-float textures here?
    (function(){
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmtRGBA, 4, 4, 0, gl.RGBA, halfFloat, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.deleteFramebuffer(f); gl.deleteTexture(t);
      if(!ok) throw new Error('no half-float render targets');
    })();

    // ---------- programs ----------
    function compile(type, src){
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT);
    function program(fragSrc){
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
      gl.bindAttribLocation(p, 0, 'aPosition');
      gl.linkProgram(p);
      if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for(let i=0;i<n;i++){ const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      return { p, u };
    }
    const P = {};
    for(const k in FRAG) P[k] = program(FRAG[k]);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,1, 1,-1]), gl.STATIC_DRAW);
    const ebuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    function blit(target){
      if(target){ gl.viewport(0, 0, target.w, target.h); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
      else{ gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
    function use(prog){ gl.useProgram(prog.p); return prog.u; }

    // ---------- render targets ----------
    function fbo(w, h, internal, format){
      gl.activeTexture(gl.TEXTURE0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, halfFloat, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo:f, w, h, tx:1/w, ty:1/h,
        attach(id){ gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
    }
    function doubleFbo(w, h, internal, format){
      let a = fbo(w, h, internal, format), b = fbo(w, h, internal, format);
      return { w, h, tx:1/w, ty:1/h,
        get read(){ return a; }, get write(){ return b; },
        swap(){ const t = a; a = b; b = t; } };
    }
    function resample(old, w, h, internal, format){
      const n = doubleFbo(w, h, internal, format);
      const u = use(P.copy);
      gl.uniform2f(u.texelSize, 1/w, 1/h);
      gl.uniform1i(u.uTexture, old.read.attach(0));
      blit(n.read);
      return n;
    }

    // static textures: paper (from a 2D canvas) and a granulation grain tile
    function staticTex(wrap){
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return t;
    }
    const paperTex = staticTex(gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([236,228,211,255]));
    const grainTex = staticTex(gl.REPEAT);
    (function(){
      const N = 256, px = new Uint8Array(N*N*4);
      // clumpy grain: a few octaves of noise, like cold-press paper tooth
      const rnd = new Float32Array(N*N).map(()=>Math.random());
      const at = (x,y)=>rnd[((y+N)%N)*N + (x+N)%N];
      for(let y=0;y<N;y++) for(let x=0;x<N;x++){
        let v = at(x,y)*0.45 + (at(x>>1,y>>1) + at((x>>1)+1,y>>1))*0.15 + at(x>>2,y>>2)*0.25;
        v = Math.min(1, Math.max(0, v));
        const i = (y*N + x)*4; px[i] = px[i+1] = px[i+2] = v*255; px[i+3] = 255;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    })();

    // ---------- simulation state ----------
    const SIM_RES = 128, DYE_RES = 768;
    let velocity, dye, divergence, curlT, pressure;
    let W = 1, H = 1;

    function dims(res){
      const ar = W/H;
      return ar >= 1 ? [Math.round(res*ar), res] : [res, Math.round(res/ar)];
    }
    function initTargets(){
      const [sw, sh] = dims(SIM_RES), [dw, dh] = dims(DYE_RES);
      velocity = velocity ? resample(velocity, sw, sh, fmtRG, srcRG) : doubleFbo(sw, sh, fmtRG, srcRG);
      dye = dye ? resample(dye, dw, dh, fmtRGBA, gl.RGBA) : doubleFbo(dw, dh, fmtRGBA, gl.RGBA);
      divergence = fbo(sw, sh, fmtR, srcR);
      curlT = fbo(sw, sh, fmtR, srcR);
      pressure = doubleFbo(sw, sh, fmtR, srcR);
    }

    function resize(w, h, dpr){
      const cw = Math.max(1, Math.round(w*dpr)), ch = Math.max(1, Math.round(h*dpr));
      if(canvas.width !== cw || canvas.height !== ch){ canvas.width = cw; canvas.height = ch; }
      const changed = !velocity || Math.abs(w/h - W/H) > 0.01;
      W = w; H = h;
      if(changed) initTargets();
    }

    function setPaper(src){
      gl.bindTexture(gl.TEXTURE_2D, paperTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }

    // ---------- splats ----------
    const aspect = ()=>W/H;
    function dyeSplat(x, y, r, a, rough, seed){
      const u = use(P.dyeSplat);
      gl.uniform2f(u.texelSize, dye.tx, dye.ty);
      gl.uniform1i(u.uTarget, dye.read.attach(0));
      gl.uniform1f(u.aspectRatio, aspect());
      gl.uniform2f(u.point, x/W, 1 - y/H);
      gl.uniform1f(u.radius, r/H);
      gl.uniform3f(u.color, a[0], a[1], a[2]);
      gl.uniform1f(u.seed, seed ?? Math.random()*100);
      gl.uniform1f(u.rough, rough ?? 1);
      blit(dye.write); dye.swap();
    }
    // forces are in texels/second of the simulation grid
    function velSplat(x, y, r, radial, swirl, px, py){
      const u = use(P.velSplat);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform1i(u.uTarget, velocity.read.attach(0));
      gl.uniform1f(u.aspectRatio, aspect());
      gl.uniform2f(u.point, x/W, 1 - y/H);
      gl.uniform1f(u.radius, r/H);
      gl.uniform1f(u.radial, radial);
      gl.uniform1f(u.swirl, swirl);
      gl.uniform2f(u.push, px, -py);
      blit(velocity.write); velocity.swap();
    }

    // pigment colour (0..255 rgb) -> how much it absorbs per channel
    function absorb(rgb){
      const f = c=>-Math.log(Math.min(0.97, Math.max(0.03, c/255/0.94)));
      return [f(rgb.r), f(rgb.g), f(rgb.b)];
    }

    // ---------- pours ----------
    // A note doesn't stamp a finished blot: it pours pigment in over a short
    // time (most of it immediately — the drop hitting the paper) while the
    // water pushes outward and swirls, carrying it into what's already there.
    const pours = [];
    const simScale = ()=>velocity.h/H; // css px -> sim texels

    function pour(o){
      const R = o.radius;
      const subs = [];
      const n = 5 + (Math.random()*3|0);
      for(let i=0;i<n;i++){
        const ang = Math.random()*Math.PI*2, d = R*Math.sqrt(Math.random())*0.5;
        subs.push({ dx:Math.cos(ang)*d, dy:Math.sin(ang)*d, r:R*(0.35 + Math.random()*0.3),
                    w:0.6 + Math.random()*0.8, seed:Math.random()*100, tone:0 });
      }
      const ang = Math.random()*Math.PI*2;
      const h = {
        x:o.x, y:o.y, R, strength:o.strength,
        colors:o.colors.map(c=>({ a:absorb(c.rgb), w:c.w })),
        subs, t0:performance.now(), dur:o.duration || 420,
        poured:0, alive:true, pushed:0,
        push:[Math.cos(ang), Math.sin(ang)], swirl:(Math.random() < 0.5 ? -1 : 1)*(0.6 + Math.random()*0.8),
        history:[]
      };
      // assign each sub-splat a colour by weight, so a blot isn't one flat hue
      const total = h.colors.reduce((s,c)=>s + c.w, 0);
      subs.forEach((s,i)=>{
        let pick = (i === 0 ? 0 : Math.random()*total), k = 0;
        if(i > 0) for(; k<h.colors.length-1; k++){ pick -= h.colors[k].w; if(pick <= 0) break; }
        s.tone = k;
      });
      pours.push(h);
      return {
        setColors(colors){
          h.colors = colors.map(c=>({ a:absorb(c.rgb), w:c.w }));
          subs.forEach((s,i)=>{ s.tone = i === 0 ? 0 : (Math.random()*h.colors.length)|0; });
        },
        cancel(){
          if(!h.alive && !h.poured) return;
          h.alive = false;
          // lift the pigment back out where it went in
          for(const e of h.history) dyeSplat(e.x, e.y, e.r*1.3, e.a.map(v=>-v*1.3), e.rough, e.seed);
          h.history = [];
        }
      };
    }

    function stepPours(now){
      for(let i=pours.length-1;i>=0;i--){
        const h = pours[i];
        if(!h.alive){ pours.splice(i,1); continue; }
        const t = Math.min(1, (now - h.t0)/h.dur);
        // front-loaded: about half lands in the first instant
        const target = 1 - Math.pow(1 - t, 4);
        const delta = target - h.poured;
        if(delta > 0.001){
          h.poured = target;
          for(const s of h.subs){
            const c = h.colors[Math.min(s.tone, h.colors.length-1)];
            const amt = delta*s.w*(0.2 + 0.25*h.strength)*c.w/Math.max(...h.colors.map(q=>q.w));
            const a = c.a.map(v=>v*amt);
            // spread grows as it pours, like water carrying pigment outward
            const r = s.r*(0.7 + 0.5*t);
            const x = h.x + s.dx*(1 + 0.4*t), y = h.y + s.dy*(1 + 0.4*t);
            dyeSplat(x, y, r, a, 1, s.seed);
            if(h.history.length < 60) h.history.push({ x, y, r, a, rough:1, seed:s.seed });
          }
        }
        // the water: a hard outward burst on impact, then a gentler swirl and drift
        if(h.pushed < 3 || t < 0.6){
          const k = h.pushed === 0 ? 1 : Math.max(0, 1 - t)*0.35;
          const sc = simScale();
          const burst = 110*sc*k*(0.5 + h.strength), sw = 240*sc*k*h.swirl, pu = 170*sc*k;
          velSplat(h.x, h.y, h.R*1.1, burst, sw, h.push[0]*pu, h.push[1]*pu);
          h.pushed++;
        }
        if(t >= 1 && h.pushed >= 3){ h.alive = false; h.history = []; pours.splice(i,1); }
      }
    }

    // a fleck of paint flicked off the brush
    function fleck(x, y, r, rgb, strength){
      const a = absorb(rgb).map(v=>v*(0.5 + strength*0.5));
      dyeSplat(x, y, Math.max(r, 3), a, 0.15);
    }

    // ---------- simulation step ----------
    const CURL = 7, PRESSURE_ITERS = 20, VEL_DISSIPATION = 1.3;
    function simulate(dt, fade, ageDt){
      gl.disable(gl.BLEND);
      let u = use(P.curl);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform1i(u.uVelocity, velocity.read.attach(0));
      blit(curlT);

      u = use(P.vorticity);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform1i(u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(u.uCurl, curlT.attach(1));
      gl.uniform1f(u.curl, CURL);
      gl.uniform1f(u.dt, dt);
      blit(velocity.write); velocity.swap();

      u = use(P.divergence);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform1i(u.uVelocity, velocity.read.attach(0));
      blit(divergence);

      u = use(P.scale);
      gl.uniform2f(u.texelSize, pressure.tx, pressure.ty);
      gl.uniform1i(u.uTexture, pressure.read.attach(0));
      gl.uniform1f(u.value, 0.8);
      blit(pressure.write); pressure.swap();

      u = use(P.pressure);
      gl.uniform2f(u.texelSize, pressure.tx, pressure.ty);
      gl.uniform1i(u.uDivergence, divergence.attach(0));
      for(let i=0;i<PRESSURE_ITERS;i++){
        gl.uniform1i(u.uPressure, pressure.read.attach(1));
        blit(pressure.write); pressure.swap();
      }

      u = use(P.gradientSubtract);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform1i(u.uPressure, pressure.read.attach(0));
      gl.uniform1i(u.uVelocity, velocity.read.attach(1));
      blit(velocity.write); velocity.swap();

      u = use(P.advection);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform2f(u.dyeTexelSize, velocity.tx, velocity.ty);
      gl.uniform1i(u.manualFilter, supportLinear ? 0 : 1);
      gl.uniform1i(u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(u.uSource, velocity.read.attach(0));
      gl.uniform1f(u.dt, dt);
      gl.uniform1f(u.dissipation, VEL_DISSIPATION);
      blit(velocity.write); velocity.swap();

      u = use(P.dyeAdvection);
      gl.uniform2f(u.texelSize, velocity.tx, velocity.ty);
      gl.uniform2f(u.dyeTexelSize, dye.tx, dye.ty);
      gl.uniform1i(u.manualFilter, supportLinear ? 0 : 1);
      gl.uniform1i(u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(u.uSource, dye.read.attach(1));
      gl.uniform1f(u.dt, dt);
      gl.uniform1f(u.ageDt, ageDt ?? dt);
      gl.uniform1f(u.fade, fade.on ? 1 : 0);
      gl.uniform1f(u.linger, fade.lingerS);
      gl.uniform1f(u.tau, Math.max(0.05, fade.fadeS/4));
      blit(dye.write); dye.swap();
    }

    function render(){
      const u = use(P.display);
      gl.uniform2f(u.texelSize, dye.tx, dye.ty);
      gl.uniform2f(u.dyeTexel, dye.tx, dye.ty);
      gl.uniform1i(u.uDye, dye.read.attach(0));
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, paperTex); gl.uniform1i(u.uPaper, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, grainTex); gl.uniform1i(u.uGrain, 2);
      gl.uniform2f(u.grainScale, canvas.width/256/1.6, canvas.height/256/1.6);
      gl.uniform1f(u.edgeAmt, 3.2);
      gl.uniform1f(u.grainAmt, 0.7);
      blit(null);
    }

    let last = performance.now(), idleFrames = 0;
    function frame(now, fade){
      const real = Math.min(1, Math.max(0.001, (now - last)/1000));
      const dt = Math.min(0.033, real);
      last = now;
      stepPours(now);
      simulate(dt, fade, real);
      render();
    }

    function clear(){
      for(const t of [velocity.read, velocity.write, dye.read, dye.write, pressure.read, pressure.write]){
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.viewport(0, 0, t.w, t.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      pours.length = 0;
    }

    return { resize, setPaper, pour, fleck, frame, clear, isGL2 };
  }

  window.InkFluid = {
    create(canvas){
      try{ return create(canvas); }
      catch(e){ console.warn('fluid ink unavailable, using simple painter:', e); return null; }
    }
  };
})();
