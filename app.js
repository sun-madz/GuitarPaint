(function(){
  'use strict';

  // ---------- pigment palette, mapped by pitch class ----------
  // hand-picked watercolor pigments rather than a hue-wheel rainbow
  const PIGMENTS = [
    {name:'C',  hex:'#2c3e66'}, // indigo
    {name:'C#', hex:'#1b3b5f'}, // prussian blue
    {name:'D',  hex:'#1f6f63'}, // teal
    {name:'D#', hex:'#2e7d5b'}, // viridian
    {name:'E',  hex:'#5a7d2a'}, // sap green
    {name:'F',  hex:'#c08a2e'}, // ochre
    {name:'F#', hex:'#b5651d'}, // raw sienna
    {name:'G',  hex:'#a0522d'}, // burnt sienna
    {name:'G#', hex:'#a63a50'}, // alizarin crimson
    {name:'A',  hex:'#8e3b5d'}, // rose madder
    {name:'A#', hex:'#5b4b8a'}, // violet
    {name:'B',  hex:'#3b4e9e'}, // ultramarine
  ];
  const NOTE_NAMES = PIGMENTS.map(p=>p.name);

  function hexToRgb(hex){
    const v = parseInt(hex.slice(1),16);
    return {r:(v>>16)&255, g:(v>>8)&255, b:v&255};
  }
  const PIG_RGB = PIGMENTS.map(p=>hexToRgb(p.hex));

  // ---------- small helpers ----------
  const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
  const lerp = (a,b,t)=>a+(b-a)*t;
  const easeOutCubic = t=>1-Math.pow(1-t,3);
  const rgba = (c,a)=>`rgba(${c.r|0},${c.g|0},${c.b|0},${a})`;
  function mixRgb(a,b,t){ return {r:lerp(a.r,b.r,t), g:lerp(a.g,b.g,t), b:lerp(a.b,b.b,t)}; }
  function gauss(){
    let u=0, v=0;
    while(!u) u=Math.random();
    while(!v) v=Math.random();
    // clipped so a rare outlier can't fling an edge point across the shape
    return clamp(Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v), -2, 2);
  }

  // ---------- settings ----------
  const SETTINGS_KEY = 'soundOnPaper.settings.v1';
  const settings = { showNames:false, sensitivity:0.6, size:0.5 };
  try{
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if(saved && typeof saved === 'object') Object.assign(settings, saved);
  }catch(e){}
  function saveSettings(){
    try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
  }

  // ---------- canvases ----------
  // paperTexture: the sheet itself
  // ink: dried, finished paint (permanent)
  // wet: blooms that are still spreading/drying, redrawn every frame
  const wrap = document.getElementById('paperWrap');
  const texCanvas = document.getElementById('paperTexture');
  const inkCanvas = document.getElementById('ink');
  const wetCanvas = document.getElementById('wet');
  const texCtx = texCanvas.getContext('2d');
  const inkCtx = inkCanvas.getContext('2d');
  const wetCtx = wetCanvas.getContext('2d');

  let W = 0, H = 0;
  const DPR = Math.min(window.devicePixelRatio||1, 2);

  function resize(){
    const rect = wrap.getBoundingClientRect();
    // keep whatever has already been painted when the window changes size
    let snapshot = null;
    if(inkCanvas.width && inkCanvas.height && W && H){
      snapshot = document.createElement('canvas');
      snapshot.width = inkCanvas.width; snapshot.height = inkCanvas.height;
      snapshot.getContext('2d').drawImage(inkCanvas,0,0);
    }
    W = rect.width; H = rect.height;
    [texCanvas, inkCanvas, wetCanvas].forEach(c=>{
      c.width = Math.round(W*DPR); c.height = Math.round(H*DPR);
    });
    [texCtx, inkCtx, wetCtx].forEach(ctx=>ctx.setTransform(DPR,0,0,DPR,0,0));
    drawPaperTexture();
    if(snapshot) inkCtx.drawImage(snapshot, 0, 0, W, H);
  }

  function drawPaperTexture(){
    texCtx.clearRect(0,0,W,H);
    const grad = texCtx.createLinearGradient(0,0,W,H);
    grad.addColorStop(0, '#efe8d8');
    grad.addColorStop(0.5, '#ece3d0');
    grad.addColorStop(1, '#e6dcc6');
    texCtx.fillStyle = grad;
    texCtx.fillRect(0,0,W,H);

    const n = Math.round(W*H/150);
    for(let i=0;i<n;i++){
      const x = Math.random()*W, y = Math.random()*H;
      const a = Math.random()*0.035;
      texCtx.fillStyle = Math.random() > 0.5
        ? `rgba(60,50,35,${a})`
        : `rgba(255,250,235,${a})`;
      const w = 0.6 + Math.random()*1.6, h = 0.6 + Math.random()*1.6;
      texCtx.fillRect(x,y,w,h);
    }
    const vg = texCtx.createRadialGradient(W/2,H/2, Math.min(W,H)*0.35, W/2,H/2, Math.max(W,H)*0.75);
    vg.addColorStop(0,'rgba(0,0,0,0)');
    vg.addColorStop(1,'rgba(40,30,15,0.10)');
    texCtx.fillStyle = vg;
    texCtx.fillRect(0,0,W,H);
  }

  window.addEventListener('resize', resize);
  resize();

  // ---------- granulation grain ----------
  // a speckle tile punched out of each bloom as it dries, so pigment looks
  // like it settled into the tooth of the paper instead of a flat fill
  const grainTile = document.createElement('canvas');
  grainTile.width = grainTile.height = 160;
  (function(){
    const g = grainTile.getContext('2d');
    for(let i=0;i<1700;i++){
      g.fillStyle = `rgba(0,0,0,${Math.pow(Math.random(),2.2)*0.9})`;
      const s = 0.5 + Math.random()*1.7;
      g.fillRect(Math.random()*160, Math.random()*160, s, s);
    }
  })();

  // ---------- watercolor engine ----------
  // A bloom is built the way real washes are: dozens of very transparent,
  // slightly different irregular layers stacked on top of each other. Where
  // many layers overlap (the middle) the colour gets deep; at the ragged
  // edges only a few overlap, so the boundary goes soft and uneven. Thin
  // darker strokes on the outer layers mimic pigment pooling at the edge
  // as the water dries.

  function basePoly(r, n){
    const pts = [];
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + (Math.random()-0.5)*0.35;
      const rr = r*(0.84 + Math.random()*0.3);
      pts.push({x:Math.cos(a)*rr, y:Math.sin(a)*rr, v:0.4 + Math.random()*0.9});
    }
    return pts;
  }

  // recursive midpoint displacement; each vertex carries its own
  // "wildness" so some stretches of edge stay calm and others feather out
  function deform(pts, depth, amt){
    let cur = pts;
    for(let d=0; d<depth; d++){
      const n = cur.length, next = new Array(n*2);
      for(let i=0;i<n;i++){
        const a = cur[i], b = cur[(i+1)%n];
        const len = Math.hypot(b.x-a.x, b.y-a.y);
        const v = (a.v+b.v)*0.5;
        const sd = len*amt*v;
        next[2*i] = a;
        next[2*i+1] = {
          x:(a.x+b.x)/2 + gauss()*sd,
          y:(a.y+b.y)/2 + gauss()*sd,
          v: clamp(v*(0.8 + Math.random()*0.4), 0.3, 1.5)
        };
      }
      cur = next;
    }
    return cur;
  }

  function tracePath(c, pts, s, ox, oy){
    c.beginPath();
    for(let k=0;k<pts.length;k++){
      const x = pts[k].x*s + ox, y = pts[k].y*s + oy;
      if(k) c.lineTo(x,y); else c.moveTo(x,y);
    }
    c.closePath();
  }

  const DRY_MS = 900;      // how long a finished bloom takes to dry
  const DRY_ALPHA = 0.86;  // watercolour lightens a little as it dries

  class Bloom{
    constructor(o){
      this.x = o.x; this.y = o.y;
      this.radius = o.radius;
      this.rgb = o.rgb;
      this.tint = o.tint || o.rgb;
      this.tintAmt = o.tintAmt ?? 0.3;
      this.strength = o.strength ?? 0.7;
      this.layers = o.layers || 46;
      this.duration = o.duration || (900 + this.strength*900 + Math.random()*400);
      this.start = performance.now() + (o.delay||0);
      this.alpha = o.alpha ?? (0.012 + 0.019*this.strength);
      this.backrun = o.backrun ?? (Math.random() < 0.3);
      this.dark = mixRgb(this.rgb, {r:22,g:15,b:10}, 0.4);

      this.half = Math.ceil(this.radius*1.9);
      const px = Math.max(2, Math.ceil(this.half*2*DPR));
      this.cv = document.createElement('canvas');
      this.cv.width = this.cv.height = px;
      this.ctx = this.cv.getContext('2d');
      this.ctx.setTransform(DPR,0,0,DPR,this.half*DPR,this.half*DPR);

      this.base = deform(basePoly(this.radius*0.8, 8 + (Math.random()*5|0)), 2, 0.26);
      // a slight drift — wet paper never lets pigment spread perfectly evenly
      const ang = Math.random()*Math.PI*2;
      this.flow = {x:Math.cos(ang)*this.radius*0.14, y:Math.sin(ang)*this.radius*0.14};

      this.drawn = 0;
      this.done = false;
      this.doneAt = 0;
    }

    step(now){
      if(now < this.start || this.done) return;
      const t = clamp((now - this.start)/this.duration, 0, 1);
      const target = Math.round(this.layers*t);
      while(this.drawn < target) this.layer(this.drawn++);
      if(t >= 1) this.finish(now);
    }

    layer(i){
      const c = this.ctx;
      const p = this.layers > 1 ? i/(this.layers-1) : 1;
      // early layers are small and concentrated (the drop landing), later
      // ones reach further out as the water carries pigment outward
      const scale = 0.3 + 0.7*easeOutCubic(p);
      const pts = deform(this.base, 4, 0.24);
      const col = mixRgb(this.rgb, this.tint, Math.random()*this.tintAmt);
      const a = this.alpha * (p < 0.12 ? 1.9 : 1);
      tracePath(c, pts, scale, this.flow.x*p, this.flow.y*p);
      c.fillStyle = rgba(col, a);
      c.fill();
      if(p > 0.55){
        c.lineWidth = 0.6 + Math.random()*1.3;
        c.strokeStyle = rgba(this.dark, a*1.15);
        c.stroke();
      }
    }

    finish(now){
      const c = this.ctx;
      const fx = this.flow.x, fy = this.flow.y;

      // pooled rim: pigment collecting at the drying edge (kept inside the paint)
      c.save();
      c.globalCompositeOperation = 'source-atop';
      for(let k=0;k<6;k++){
        tracePath(c, deform(this.base, 4, 0.2), 1, fx, fy);
        c.lineWidth = 1 + Math.random()*2.2;
        c.strokeStyle = rgba(this.dark, 0.03 + 0.05*this.strength);
        c.stroke();
      }
      c.restore();

      // backrun / "cauliflower": a pale patch with a dark frilly edge where
      // wetter paint pushed back into a drying area
      if(this.backrun && this.radius > 18){
        const ang = Math.random()*Math.PI*2, d = this.radius*Math.random()*0.35;
        const shape = deform(basePoly(this.radius*(0.2 + Math.random()*0.2), 9), 2, 0.28);
        const bx = Math.cos(ang)*d + fx*0.6, by = Math.sin(ang)*d + fy*0.6;
        c.save();
        c.globalCompositeOperation = 'destination-out';
        for(let k=0;k<8;k++){
          tracePath(c, deform(shape, 3, 0.25), 0.75 + k*0.04, bx, by);
          c.fillStyle = 'rgba(0,0,0,0.06)';
          c.fill();
        }
        c.globalCompositeOperation = 'source-atop';
        for(let k=0;k<5;k++){
          tracePath(c, deform(shape, 3, 0.3), 1.05, bx, by);
          c.lineWidth = 0.7 + Math.random()*1.2;
          c.strokeStyle = rgba(this.dark, 0.06);
          c.stroke();
        }
        c.restore();
      }

      // granulation: pigment settles unevenly into the tooth of the paper —
      // a few pale pits and a few darker specks
      const pat = c.createPattern(grainTile, 'repeat');
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.globalAlpha = 0.2;
      c.translate(Math.random()*160, Math.random()*160);
      c.fillStyle = pat;
      c.fillRect(-this.half-160, -this.half-160, this.half*2+320, this.half*2+320);
      c.restore();
      c.save();
      c.globalCompositeOperation = 'source-atop';
      c.globalAlpha = 0.18;
      c.translate(Math.random()*160, Math.random()*160);
      c.fillStyle = pat;
      c.fillRect(-this.half-160, -this.half-160, this.half*2+320, this.half*2+320);
      c.restore();

      this.done = true;
      this.doneAt = now;
    }

    drawTo(ctx, alpha){
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.cv, this.x-this.half, this.y-this.half, this.half*2, this.half*2);
      ctx.restore();
    }
  }

  let blooms = [];
  const MAX_BLOOMS = 48;

  function addBloom(o){
    // if things pile up (very fast playing) dry the oldest straight away
    while(blooms.length >= MAX_BLOOMS){
      const old = blooms.shift();
      const now = performance.now();
      if(now >= old.start){
        while(old.drawn < old.layers) old.layer(old.drawn++);
        if(!old.done) old.finish(now);
        old.drawTo(inkCtx, DRY_ALPHA);
      }
    }
    blooms.push(new Bloom(o));
  }

  // runs continuously, so blooms keep spreading and drying after the mic stops
  function animate(){
    const now = performance.now();
    wetCtx.clearRect(0,0,W,H);
    const keep = [];
    for(const b of blooms){
      if(now < b.start){ keep.push(b); continue; }
      b.step(now);
      if(b.done){
        const dt = (now - b.doneAt)/DRY_MS;
        if(dt >= 1){ b.drawTo(inkCtx, DRY_ALPHA); continue; }
        b.drawTo(wetCtx, lerp(1, DRY_ALPHA, dt));
      }else{
        b.drawTo(wetCtx, 1);
      }
      keep.push(b);
    }
    blooms = keep;
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // ---------- placing blots on the page ----------
  let recentSpots = [];
  function pickSpot(radius){
    const mx = Math.min(W*0.42, radius*0.9 + 12);
    const top = Math.min(H*0.4, 50 + radius*0.6);
    const bottom = Math.min(H*0.4, 70 + radius*0.6);
    let best = null, bestScore = -1;
    for(let i=0;i<7;i++){
      const x = mx + Math.random()*(W - mx*2);
      const y = top + Math.random()*Math.max(1, H - top - bottom);
      let d = Infinity;
      for(const s of recentSpots) d = Math.min(d, Math.hypot(s.x-x, s.y-y));
      const score = d + Math.random()*radius;
      if(score > bestScore){ bestScore = score; best = {x,y}; }
    }
    recentSpots.push(best);
    if(recentSpots.length > 8) recentSpots.shift();
    return best;
  }

  function paintEvent(ev){
    const sizeMul = lerp(0.65, 1.5, settings.size);
    const radius = Math.min(W,H)*(0.045 + 0.075*ev.strength)*sizeMul;
    const {x, y} = pickSpot(radius);
    const rootRgb = PIG_RGB[ev.root];
    const others = ev.tones.filter(t=>t !== ev.root);

    // a single note gets a hint of a neighbouring pigment for depth;
    // a chord's main wash is tinted by its next tone
    const tint = others.length
      ? PIG_RGB[others[0]]
      : PIG_RGB[(ev.root + (Math.random()<0.5 ? 1 : 11)) % 12];

    addBloom({ x, y, radius, rgb:rootRgb, tint, tintAmt: others.length ? 0.25 : 0.35, strength:ev.strength });

    // the other chord tones bleed in wet-into-wet around the main wash
    others.slice(0, 2).forEach((pc, i)=>{
      const ang = Math.random()*Math.PI*2;
      const d = radius*(0.6 + Math.random()*0.45);
      addBloom({
        x: x + Math.cos(ang)*d, y: y + Math.sin(ang)*d,
        radius: radius*(0.42 + Math.random()*0.25),
        rgb: PIG_RGB[pc], tint: rootRgb, tintAmt: 0.3,
        strength: ev.strength*0.65,
        delay: 70 + i*110 + Math.random()*120,
        layers: 36
      });
    });

    // flicked droplets on harder hits
    const splats = ev.strength > 0.55 ? Math.floor(Math.random()*5*(ev.strength-0.4)) : 0;
    for(let i=0;i<splats;i++){
      const ang = Math.random()*Math.PI*2;
      const d = radius*(1.05 + Math.random()*0.9);
      const pc = (others.length && Math.random()<0.4) ? others[(Math.random()*others.length)|0] : ev.root;
      addBloom({
        x: x + Math.cos(ang)*d, y: y + Math.sin(ang)*d,
        radius: (2 + Math.random()*6)*sizeMul,
        rgb: PIG_RGB[pc], strength: ev.strength,
        layers: 14, duration: 350 + Math.random()*250,
        alpha: 0.06, backrun:false, delay: Math.random()*90
      });
    }

    if(settings.showNames && ev.label){
      noteReadout.textContent = ev.label;
      noteReadout.classList.remove('fresh');
      void noteReadout.offsetWidth; // restart the fade-in
      noteReadout.classList.add('fresh');
    }
  }

  // ---------- pitch + chord analysis ----------
  const MIN_FREQ = 70;    // a touch below low E (82 Hz) so drop-D still works
  const MAX_FREQ = 1400;

  // YIN: finds the period of a single, clean note. Chords don't have one,
  // which is exactly how we tell a single note from a chord below.
  const yinBuf = new Float32Array(1400);
  function yinDetect(buf, sr){
    const win = 1024;
    const maxTau = Math.min(Math.floor(sr/MIN_FREQ), yinBuf.length-1);
    const minTau = Math.max(2, Math.floor(sr/MAX_FREQ));
    const o = buf.length - win - maxTau - 1;
    if(o < 0) return null;

    yinBuf[0] = 1;
    let running = 0;
    for(let tau=1; tau<=maxTau; tau++){
      let sum = 0;
      for(let i=0;i<win;i++){
        const d = buf[o+i] - buf[o+i+tau];
        sum += d*d;
      }
      running += sum;
      yinBuf[tau] = running ? sum*tau/running : 1;
    }
    let tau = -1;
    for(let t=minTau; t<=maxTau; t++){
      if(yinBuf[t] < 0.15){
        while(t+1 <= maxTau && yinBuf[t+1] < yinBuf[t]) t++;
        tau = t; break;
      }
    }
    if(tau < 0) return null;
    let better = tau;
    if(tau > 1 && tau < maxTau){
      const s0 = yinBuf[tau-1], s1 = yinBuf[tau], s2 = yinBuf[tau+1];
      const den = 2*s1 - s2 - s0;
      if(den) better = tau + (s2 - s0)/(2*den);
    }
    const freq = sr/better;
    if(freq < MIN_FREQ || freq > MAX_FREQ) return null;
    const midi = 69 + 12*Math.log2(freq/440);
    const r = Math.round(midi);
    return { midi:r, pc:((r%12)+12)%12, conf:1 - yinBuf[tau] };
  }

  // chroma: how much energy sits on each of the 12 pitch classes, built
  // from the spectral peaks (with sub-bin interpolation so the low strings
  // land on the right note). Two versions are kept: everything sounding,
  // and only what's *new* since the pluck — the second ignores whatever
  // was still ringing from the previous note or chord.
  const frameAll = new Float32Array(12), frameNew = new Float32Array(12);

  function snapshotSpectrum(){
    specAn.getFloatFrequencyData(sFreq);
    const pre = new Float32Array(sFreq.length);
    for(let k=0;k<sFreq.length;k++) pre[k] = Math.pow(10, sFreq[k]/20);
    return pre;
  }

  function addChromaFrame(p){
    specAn.getFloatFrequencyData(sFreq);
    const binHz = audioCtx.sampleRate/specAn.fftSize;
    const kMin = Math.max(2, Math.ceil(75/binHz));
    const kMax = Math.min(sFreq.length-2, Math.floor(2600/binHz));
    let top = -Infinity;
    for(let k=kMin;k<=kMax;k++) if(sFreq[k] > top) top = sFreq[k];
    if(!isFinite(top) || top < -95) return;
    const floorDb = top - 42;
    const pre = p.pre;

    // collect the spectral peaks first
    const peaks = [];
    for(let k=kMin;k<=kMax;k++){
      const b = sFreq[k];
      if(b < floorDb) continue;
      const a = sFreq[k-1], c = sFreq[k+1];
      if(!(b > a && b >= c)) continue;
      const den = a - 2*b + c;
      const off = den ? 0.5*(a - c)/den : 0;
      const f = (k + off)*binHz;
      const midi = 69 + 12*Math.log2(f/440);
      const r = Math.round(midi);
      const dev = Math.abs(midi - r);
      if(dev > 0.4) continue;
      const mag = Math.pow(10, b/20);
      let fresh = 0;
      if(pre){
        const old = Math.max(pre[k-1], pre[k], pre[k+1]);
        fresh = mag - old*1.15;
        if(fresh <= mag*0.3) fresh = 0;
      }
      peaks.push({ f, mag, fresh, pc:((r%12)+12)%12,
                   shape:(1 - dev*1.2)*(f > 1200 ? 0.5 : 1) });
    }

    frameAll.fill(0); frameNew.fill(0);
    let newPeaks = 0;
    for(const pk of peaks){
      frameAll[pk.pc] += Math.pow(pk.mag, 0.7)*pk.shape;
      if(pk.fresh > 0){ frameNew[pk.pc] += Math.pow(pk.fresh, 0.7)*pk.shape; newPeaks++; }
    }
    let m = 0, mn = 0;
    for(let i=0;i<12;i++){ m = Math.max(m, frameAll[i]); mn = Math.max(mn, frameNew[i]); }
    if(m <= 0) return;
    for(let i=0;i<12;i++) p.chroma[i] += frameAll[i]/m;
    if(mn > 0) for(let i=0;i<12;i++) p.chromaNew[i] += frameNew[i]/mn;
    p.newPeaks += newPeaks;
    p.cf++;
  }

  const CHORD_TYPES = [
    {s:'',     iv:[0,4,7],    pen:0},
    {s:'m',    iv:[0,3,7],    pen:0},
    {s:'7',    iv:[0,4,7,10], pen:0.05},
    {s:'maj7', iv:[0,4,7,11], pen:0.07},
    {s:'m7',   iv:[0,3,7,10], pen:0.06},
    {s:'sus2', iv:[0,2,7],    pen:0.03},
    {s:'sus4', iv:[0,5,7],    pen:0.03},
    {s:'5',    iv:[0,7],      pen:0.05},
  ];

  const OVERTONES = [[0,1],[7,0.4],[4,0.18],[10,0.1]];
  const tplCache = new Map();
  function chordTemplate(root, iv){
    const key = root + ':' + iv.join(',');
    let tpl = tplCache.get(key);
    if(!tpl){
      tpl = new Float32Array(12);
      for(const i of iv) for(const [o,w] of OVERTONES) tpl[(root+i+o)%12] += w;
      tplCache.set(key, tpl);
    }
    return tpl;
  }

  function classify(p){
    if(p.cf === 0) addChromaFrame(p);
    // a tap or knock dies away almost instantly; a plucked string is still
    // ringing well after the attack, louder than whatever was there before
    if(p.lateN){
      const late = p.lateSum/p.lateN;
      if(late - p.preRms*1.05 < 0.18*(p.peak - p.preRms)) return null;
    }
    // lean on what's new since the pluck (so the previous chord still ringing
    // doesn't leak in), with some of the full sound blended back for notes
    // the two chords share. If a re-strum left almost nothing "new", use all.
    let ch = p.chroma;
    if(p.newPeaks >= 3){
      const mn = Math.max(...p.chromaNew), ma = Math.max(...p.chroma);
      ch = Array.from(p.chromaNew, (v,i)=>v/mn + 0.35*p.chroma[i]/ma);
    }
    let max = 0, sum = 0, argmax = 0;
    for(let i=0;i<12;i++){ sum += ch[i]; if(ch[i] > max){ max = ch[i]; argmax = i; } }
    if(max <= 0) return null;
    // a flat spread across all 12 pitch classes is a knock/tap/breath, not a note
    if(max/(sum/12) < 1.9) return null;
    const n = Array.from(ch, v=>v/max);

    // single note? YIN found one steady pitch (it can't on a chord), and
    // nothing strong sits outside that note's own overtones. A plucked
    // string's harmonics land on its octave, fifth, major third and flat
    // seventh, so those don't count against it.
    if(p.pitches.length >= 2){
      const counts = new Array(12).fill(0);
      p.pitches.forEach(q=>counts[q.pc]++);
      let pc = 0;
      for(let i=1;i<12;i++) if(counts[i] > counts[pc]) pc = i;
      if(counts[pc]/p.pitches.length >= 0.6){
        const overtones = [0,7,4,10].map(iv=>(pc+iv)%12);
        let foreign = 0;
        for(let i=0;i<12;i++) if(!overtones.includes(i)) foreign = Math.max(foreign, n[i]);
        if(foreign < 0.6){
          const midis = p.pitches.filter(q=>q.pc===pc).map(q=>q.midi).sort((a,b)=>a-b);
          const midi = midis[midis.length>>1];
          return { root:pc, tones:[pc], label: NOTE_NAMES[pc] + (Math.floor(midi/12)-1) };
        }
      }
    }

    // otherwise match against chord shapes. Each shape includes the
    // overtones its strings naturally produce (a string also sounds faintly
    // a fifth, a major third and a flat seventh above itself), so those
    // overtones support the right chord instead of suggesting a wrong one.
    const norm = Math.sqrt(n.reduce((a,v)=>a+v*v, 0));
    let best = null;
    for(let r=0;r<12;r++){
      for(const t of CHORD_TYPES){
        if(t.iv.length === 4 && n[(r+t.iv[3])%12] < 0.55) continue;
        const tpl = chordTemplate(r, t.iv);
        let dot = 0, tn = 0;
        for(let i=0;i<12;i++){ dot += n[i]*tpl[i]; tn += tpl[i]*tpl[i]; }
        const score = dot/(norm*Math.sqrt(tn)) - t.pen;
        if(!best || score > best.score) best = {score, r, t};
      }
    }
    if(best && best.score >= 0.62){
      return {
        root: best.r,
        tones: best.t.iv.map(iv=>(best.r+iv)%12),
        label: NOTE_NAMES[best.r] + best.t.s
      };
    }
    // tonal but unclear — paint the strongest pitch class
    return { root:argmax, tones:[argmax], label:NOTE_NAMES[argmax] };
  }

  // ---------- audio ----------
  let audioCtx = null, mediaStream = null, source = null;
  let onsetAn = null, specAn = null;
  let tBuf, sFreq, sTime;
  let running = false;
  let rmsHist = [], noiseFloor = 0, lastOnset = -1e9, pending = null;

  const noteReadout = document.getElementById('note-readout');
  const statusText = document.getElementById('statusText');
  const meterFill = document.getElementById('meterFill');
  const startOverlay = document.getElementById('startOverlay');
  const startError = document.getElementById('startError');
  const beginBtn = document.getElementById('beginBtn');
  const endBtn = document.getElementById('endBtn');

  function micErrorMessage(err){
    switch(err && err.name){
      case 'NotAllowedError':
      case 'SecurityError':
        return 'microphone access was blocked. Allow it for this page in your browser’s site settings, then try again.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'no microphone was found. Plug one in (or pick an input in your system settings) and try again.';
      case 'NotReadableError':
      case 'AbortError':
        return 'the microphone is busy or unavailable. Close other apps using it and try again.';
      default:
        return 'could not start the microphone. Try again, or reload the page.';
    }
  }

  async function start(){
    startError.textContent = '';
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      startError.textContent = window.isSecureContext
        ? 'this browser can’t use the microphone.'
        : 'the microphone only works when the page is opened over https (or from localhost).';
      return;
    }
    // create the audio context inside the click itself — Safari/iOS keep it
    // silent if it's created after an await
    const AC = window.AudioContext || window.webkitAudioContext;
    try{ audioCtx = new AC(); }catch(e){ audioCtx = null; }
    if(!audioCtx){ startError.textContent = 'this browser doesn’t support web audio.'; return; }

    beginBtn.disabled = true;
    statusText.textContent = 'waiting for microphone permission…';
    try{
      // processing off: auto-gain flattens your dynamics (so new notes stop
      // standing out) and noise suppression treats sustained notes as noise
      const raw = { echoCancellation:false, noiseSuppression:false, autoGainControl:false };
      try{
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: raw });
      }catch(e){
        if(e.name === 'OverconstrainedError' || e.name === 'TypeError'){
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }else throw e;
      }
      if(audioCtx.state !== 'running') await audioCtx.resume();

      source = audioCtx.createMediaStreamSource(mediaStream);
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 60;
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4000;

      // short window for catching the instant a note is played...
      onsetAn = audioCtx.createAnalyser();
      onsetAn.fftSize = 1024;
      onsetAn.smoothingTimeConstant = 0;
      // ...longer window for working out which notes are sounding
      specAn = audioCtx.createAnalyser();
      specAn.fftSize = 4096;
      specAn.smoothingTimeConstant = 0;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(onsetAn);
      lowpass.connect(specAn);

      tBuf = new Float32Array(onsetAn.fftSize);
      sFreq = new Float32Array(specAn.frequencyBinCount);
      sTime = new Float32Array(specAn.fftSize);

      const track = mediaStream.getAudioTracks()[0];
      if(track) track.addEventListener('ended', ()=>stop('the microphone was disconnected.'));

      running = true;
      rmsHist = []; noiseFloor = 0; lastOnset = -1e9; pending = null;
      startOverlay.classList.add('hidden');
      endBtn.classList.remove('hidden');
      statusText.textContent = 'listening…';
      requestAnimationFrame(listen);
    }catch(err){
      console.error(err);
      cleanupAudio();
      statusText.textContent = 'not listening';
      startError.textContent = micErrorMessage(err);
    }finally{
      beginBtn.disabled = false;
    }
  }

  function cleanupAudio(){
    if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream = null; }
    if(audioCtx){ audioCtx.close().catch(()=>{}); audioCtx = null; }
    source = onsetAn = specAn = null;
  }

  function stop(message){
    running = false;
    pending = null;
    cleanupAudio();
    meterFill.style.width = '0%';
    statusText.textContent = 'not listening';
    endBtn.classList.add('hidden');
    startOverlay.classList.remove('hidden');
    startError.textContent = typeof message === 'string' ? message : '';
  }

  // browsers suspend audio in background tabs; pick back up on return
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden && running && audioCtx && audioCtx.state !== 'running'){
      audioCtx.resume().catch(()=>{});
    }
  });

  const LISTEN_MS = 200;  // how long after a pluck we listen before painting

  function listen(){
    if(!running || !audioCtx) return;
    const now = performance.now();

    onsetAn.getFloatTimeDomainData(tBuf);
    let s = 0;
    for(let i=0;i<tBuf.length;i++) s += tBuf[i]*tBuf[i];
    const rms = Math.sqrt(s/tBuf.length);

    const db = 20*Math.log10(rms + 1e-9);
    meterFill.style.width = (clamp((db + 65)/50, 0, 1)*100) + '%';

    // background noise level: drops quickly, creeps up slowly
    if(!noiseFloor) noiseFloor = Math.max(rms, 3e-4);
    noiseFloor = rms < noiseFloor ? lerp(noiseFloor, rms, 0.2) : noiseFloor*1.0015;
    noiseFloor = Math.max(noiseFloor, 3e-4);

    // a new note = a clear jump above both the noise and the last ~100 ms.
    // comparing against the recent minimum (not an average) means a ringing
    // note decaying never re-triggers, but a fresh pluck on top of it does
    const sens = settings.sensitivity;
    const gate = Math.max(0.0015, noiseFloor*lerp(4.5, 1.8, sens));
    const recentMin = rmsHist.length ? Math.min.apply(null, rmsHist) : rms;
    const isOnset = rms > gate
      && rms > recentMin*lerp(2.1, 1.3, sens)
      && now - lastOnset > 120;
    rmsHist.push(rms);
    if(rmsHist.length > 6) rmsHist.shift();

    // a strum hits the strings one after another; if the next string lands
    // while we're still listening to the first, it's the same chord
    if(isOnset && pending && now - pending.t0 < 160){
      lastOnset = now;
    }else if(isOnset){
      if(pending) resolvePending(pending);
      lastOnset = now;
      pending = { t0:now, peak:rms, gate, preRms:recentMin, lateSum:0, lateN:0, chroma:new Float32Array(12), chromaNew:new Float32Array(12),
                  newPeaks:0, pre:snapshotSpectrum(), cf:0, pitches:[] };
    }

    if(pending){
      const age = now - pending.t0;
      pending.peak = Math.max(pending.peak, rms);
      if(age > 110){ pending.lateSum += rms; pending.lateN++; }
      const sr = audioCtx.sampleRate;
      // only analyse audio that is entirely after the pluck
      if(age > 45){
        specAn.getFloatTimeDomainData(sTime);
        const y = yinDetect(sTime, sr);
        if(y) pending.pitches.push(y);
      }
      if(age >= specAn.fftSize/sr*1000) addChromaFrame(pending);
      if(age >= LISTEN_MS){
        resolvePending(pending);
        pending = null;
      }
    }

    requestAnimationFrame(listen);
  }

  function resolvePending(p){
    const res = classify(p);
    if(!res) return; // didn't sound like a note — leave the page alone
    const loud = Math.log(Math.max(p.peak, p.gate)/p.gate)/Math.log(25);
    res.strength = 0.35 + 0.65*clamp(loud, 0, 1);
    paintEvent(res);
  }

  // ---------- controls ----------
  beginBtn.addEventListener('click', start);
  endBtn.addEventListener('click', ()=>stop());
  document.getElementById('clearBtn').addEventListener('click', ()=>{
    inkCtx.clearRect(0,0,W,H);
    wetCtx.clearRect(0,0,W,H);
    blooms = [];
    recentSpots = [];
    noteReadout.textContent = ' ';
  });

  // ---------- settings panel ----------
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const optNames = document.getElementById('optNames');
  const optSens = document.getElementById('optSens');
  const optSize = document.getElementById('optSize');

  function applyNamesSetting(){
    noteReadout.classList.toggle('hidden', !settings.showNames);
    if(!settings.showNames) noteReadout.textContent = ' ';
  }
  optNames.checked = !!settings.showNames;
  optSens.value = settings.sensitivity;
  optSize.value = settings.size;
  applyNamesSetting();

  function setPanel(open){
    settingsPanel.classList.toggle('hidden', !open);
    settingsBtn.setAttribute('aria-expanded', String(open));
  }
  settingsBtn.addEventListener('click', e=>{
    e.stopPropagation();
    setPanel(settingsPanel.classList.contains('hidden'));
  });
  settingsPanel.addEventListener('click', e=>e.stopPropagation());
  document.addEventListener('click', ()=>setPanel(false));
  document.addEventListener('keydown', e=>{ if(e.key === 'Escape') setPanel(false); });

  optNames.addEventListener('change', ()=>{
    settings.showNames = optNames.checked; applyNamesSetting(); saveSettings();
  });
  optSens.addEventListener('input', ()=>{
    settings.sensitivity = parseFloat(optSens.value); saveSettings();
  });
  optSize.addEventListener('input', ()=>{
    settings.size = parseFloat(optSize.value); saveSettings();
  });

})();
