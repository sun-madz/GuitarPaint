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

  // alternative pigment sets, still one colour per pitch class (C .. B)
  const PALETTES = {
    classic:  { label:'classic watercolour', hex: PIGMENTS.map(p=>p.hex) },
    earth:    { label:'earth & botanicals', hex:['#4a5d23','#6b4f2a','#8a6d3b','#a67c52','#7d8b4f','#c9a227','#b8742a','#8c3b22','#6e2f2f','#5c6b73','#3f5e4d','#2f4858'] },
    ocean:    { label:'ocean & dusk',       hex:['#1d3557','#274c77','#2a6f97','#3d8eae','#4f9dbb','#2b7a78','#5e548e','#7d6bb0','#9a6fa8','#b56a8f','#355070','#6d597a'] },
    sunset:   { label:'sunset',             hex:['#c1121f','#e85d04','#e9a21b','#f48c06','#dc2f02','#9d0208','#7a0f2e','#e5484d','#c9184a','#d9668a','#d98e48','#cf5c36'] },
    spectrum: { label:'rainbow',            hex:[0,1,2,3,4,5,6,7,8,9,10,11].map(i=>hslHex(i*30, 62, 44)) },
    sumi:     { label:'sumi ink',           hex:['#2b2b2b','#3a3633','#4a4a52','#565049','#5f5f66','#6b655e','#2f3540','#403a34','#494c55','#352f2a','#5a5550','#25282d'] },
  };

  // papers: base colours for the sheet (light papers only — watercolour
  // darkens what's under it, so it would vanish on black)
  const PAPERS = {
    cream:  { label:'cream',           c:['#efe8d8','#ece3d0','#e6dcc6'] },
    white:  { label:'white cold-press', c:['#faf9f5','#f6f4ee','#efece4'] },
    grey:   { label:'warm grey',       c:['#e2ded6','#dcd7cd','#d2ccc0'] },
    kraft:  { label:'kraft',           c:['#d8c09c','#d1b690','#c6a97f'] },
    blue:   { label:'pale blue',       c:['#e6ecee','#dfe7ea','#d4dee2'] },
  };

  function hslHex(h, s, l){
    s/=100; l/=100;
    const k = n=>(n + h/30) % 12, a = s*Math.min(l, 1-l);
    const f = n=>l - a*Math.max(-1, Math.min(k(n)-3, Math.min(9-k(n), 1)));
    return '#' + [f(0),f(8),f(4)].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
  }

  function hexToRgb(hex){
    const v = parseInt(hex.slice(1),16);
    return {r:(v>>16)&255, g:(v>>8)&255, b:v&255};
  }
  let PIG_RGB = PIGMENTS.map(p=>hexToRgb(p.hex));

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
  const DEFAULTS = { showNames:false, sensitivity:0.6, size:0.62, fade:true, linger:0.3, palette:'classic', paper:'cream' };
  const settings = Object.assign({}, DEFAULTS);
  try{
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if(saved && typeof saved === 'object'){
      // blots got a little bigger by default; move people still on the old default along
      if(saved.size === 0.5) delete saved.size;
      Object.assign(settings, saved);
    }
  }catch(e){}
  if(!PALETTES[settings.palette]) settings.palette = 'classic';
  if(!PAPERS[settings.paper]) settings.paper = 'cream';
  function applyPalette(){ PIG_RGB = PALETTES[settings.palette].hex.map(hexToRgb); }
  applyPalette();
  function saveSettings(){
    try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
  }

  // ---------- canvases ----------
  // Everything is composited by hand onto one visible canvas each frame.
  // (Letting the browser blend stacked canvases caused flicker and
  // scanline glitches on some machines.)
  //   tex: the sheet of paper        ink: dried, permanent paint
  //   view: what you see = paper x ink x dried/fading x wet blooms
  const wrap = document.getElementById('paperWrap');
  const viewCanvas = document.getElementById('view');
  const texCanvas = document.createElement('canvas');
  const inkCanvas = document.createElement('canvas');
  const viewCtx = viewCanvas.getContext('2d');
  const texCtx = texCanvas.getContext('2d');
  const inkCtx = inkCanvas.getContext('2d');

  let W = 0, H = 0;
  const DPR = Math.min(window.devicePixelRatio||1, 2);
  let dirty = true; // redraw the view even when nothing is animating

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
    [viewCanvas, texCanvas, inkCanvas].forEach(c=>{
      c.width = Math.round(W*DPR); c.height = Math.round(H*DPR);
    });
    [viewCtx, texCtx, inkCtx].forEach(ctx=>ctx.setTransform(DPR,0,0,DPR,0,0));
    drawPaperTexture();
    if(snapshot) inkCtx.drawImage(snapshot, 0, 0, W, H);
    dirty = true;
  }

  function drawPaperTexture(){
    texCtx.clearRect(0,0,W,H);
    const grad = texCtx.createLinearGradient(0,0,W,H);
    const pc = PAPERS[settings.paper].c;
    grad.addColorStop(0, pc[0]);
    grad.addColorStop(0.5, pc[1]);
    grad.addColorStop(1, pc[2]);
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
    dirty = true;
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
      this.impact = o.impact ?? 4;  // layers laid down the instant the drop lands
      this.cancelAt = 0;
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
      this.spread = false;  // finished spreading, now drying
      this.dryAt = 0;
      this.dryOps = null;
      this.dryApplied = 0;
      this.done = false;    // fully dry
    }

    step(now){
      if(now < this.start || this.done) return;
      if(!this.spread){
        const t = clamp((now - this.start)/this.duration, 0, 1);
        // water spreads fast as the drop lands, then slows as it soaks in
        const target = Math.max(Math.min(this.impact, this.layers), Math.round(this.layers*(1 - (1-t)*(1-t))));
        while(this.drawn < target) this.layer(this.drawn++);
        if(t >= 1){ this.spread = true; this.dryAt = now; this.dryOps = this.dryingOps(); }
        return;
      }
      // drying effects are applied a little at a time, so the edge darkens
      // and the grain appears gradually instead of popping in on one frame
      const d = clamp((now - this.dryAt)/DRY_MS, 0, 1);
      const target = Math.ceil(this.dryOps.length*Math.min(1, d*1.25));
      while(this.dryApplied < target) this.dryOps[this.dryApplied++]();
      if(d >= 1) this.done = true;
    }

    // rush through the rest (used when too many blooms pile up)
    finishNow(now){
      if(now < this.start) this.start = now;
      while(this.drawn < this.layers) this.layer(this.drawn++);
      if(!this.dryOps){ this.spread = true; this.dryOps = this.dryingOps(); }
      while(this.dryApplied < this.dryOps.length) this.dryOps[this.dryApplied++]();
      this.done = true;
    }

    // the fuller listen decided this was a different note: repaint the
    // layers laid so far in the right pigment (only a few, so it's invisible)
    recolor(rgb, tint, tintAmt){
      const c = this.ctx;
      c.save(); c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,this.cv.width,this.cv.height); c.restore();
      this.rgb = rgb; this.tint = tint; this.tintAmt = tintAmt;
      this.dark = mixRgb(rgb, {r:22,g:15,b:10}, 0.4);
      for(let i=0;i<this.drawn;i++) this.layer(i);
    }

    // it turned out not to be a guitar note: let the drop vanish quickly
    cancel(now){ if(!this.cancelAt) this.cancelAt = now; }
    cancelFade(now){ return this.cancelAt ? 1 - clamp((now - this.cancelAt)/220, 0, 1) : 1; }

    // how wet the bloom still looks: 1 while spreading, easing to DRY_ALPHA
    wetness(now){
      if(!this.spread) return 1;
      return lerp(1, DRY_ALPHA, clamp((now - this.dryAt)/DRY_MS, 0, 1));
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

    dryingOps(){
      const c = this.ctx, ops = [];
      const fx = this.flow.x, fy = this.flow.y;
      const half = this.half;

      // pooled rim: pigment collecting at the drying edge (kept inside the paint)
      for(let k=0;k<6;k++) ops.push(()=>{
        c.save();
        c.globalCompositeOperation = 'source-atop';
        tracePath(c, deform(this.base, 4, 0.2), 1, fx, fy);
        c.lineWidth = 1 + Math.random()*2.2;
        c.strokeStyle = rgba(this.dark, 0.03 + 0.05*this.strength);
        c.stroke();
        c.restore();
      });

      // backrun / "cauliflower": a pale patch with a dark frilly edge where
      // wetter paint pushed back into a drying area
      if(this.backrun && this.radius > 18){
        const ang = Math.random()*Math.PI*2, d = this.radius*Math.random()*0.35;
        const shape = deform(basePoly(this.radius*(0.2 + Math.random()*0.2), 9), 2, 0.28);
        const bx = Math.cos(ang)*d + fx*0.6, by = Math.sin(ang)*d + fy*0.6;
        for(let k=0;k<8;k++) ops.push(()=>{
          c.save();
          c.globalCompositeOperation = 'destination-out';
          tracePath(c, deform(shape, 3, 0.25), 0.75 + k*0.04, bx, by);
          c.fillStyle = 'rgba(0,0,0,0.06)';
          c.fill();
          c.restore();
        });
        for(let k=0;k<5;k++) ops.push(()=>{
          c.save();
          c.globalCompositeOperation = 'source-atop';
          tracePath(c, deform(shape, 3, 0.3), 1.05, bx, by);
          c.lineWidth = 0.7 + Math.random()*1.2;
          c.strokeStyle = rgba(this.dark, 0.06);
          c.stroke();
          c.restore();
        });
      }

      // granulation: pigment settles unevenly into the tooth of the paper —
      // a few pale pits and a few darker specks, built up in thin passes
      const pat = c.createPattern(grainTile, 'repeat');
      const ox1 = Math.random()*160, oy1 = Math.random()*160;
      const ox2 = Math.random()*160, oy2 = Math.random()*160;
      for(let k=0;k<4;k++) ops.push(()=>{
        c.save();
        c.globalCompositeOperation = 'destination-out';
        c.globalAlpha = 0.055;
        c.translate(ox1, oy1);
        c.fillStyle = pat;
        c.fillRect(-half-160, -half-160, half*2+320, half*2+320);
        c.restore();
        c.save();
        c.globalCompositeOperation = 'source-atop';
        c.globalAlpha = 0.05;
        c.translate(ox2, oy2);
        c.fillStyle = pat;
        c.fillRect(-half-160, -half-160, half*2+320, half*2+320);
        c.restore();
      });

      // interleave so rim, backrun and grain all develop together
      return ops.sort(()=>Math.random() - 0.5);
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

  // ---------- fading ----------
  // With fading on, dried blots aren't painted onto the page for good:
  // they're kept, held for a while, then slowly let go of until they vanish.
  const FADE_MS = 7000;
  let dried = [];

  // linger slider 0..1 -> about 8 s .. 2 min before a blot starts fading
  const lingerMs = ()=>lerp(8, 120, Math.pow(settings.linger, 1.6))*1000;

  function settle(b){
    if(settings.fade){
      dried.push({ b, at: performance.now() });
      if(dried.length > 160) dried[0].at = Math.min(dried[0].at, performance.now() - lingerMs());
    }else{
      b.drawTo(inkCtx, DRY_ALPHA);
      dirty = true;
    }
  }

  function fadeAlpha(item, now){
    const t = (now - item.at - lingerMs())/FADE_MS;
    if(t <= 0) return DRY_ALPHA;
    if(t >= 1) return 0;
    // eased so the pigment thins gently rather than switching off
    return DRY_ALPHA*(1 - t*t*(3 - 2*t));
  }

  // turning fading on lets go of everything already on the page as well;
  // turning it off fixes whatever is left in place at its current strength
  function setFade(on){
    const now = performance.now();
    if(on && !settings.fade){
      const snap = document.createElement('canvas');
      snap.width = inkCanvas.width; snap.height = inkCanvas.height;
      snap.getContext('2d').drawImage(inkCanvas, 0, 0);
      inkCtx.clearRect(0,0,W,H);
      const page = { half: 0, x: 0, y: 0, cv: snap, w: W, h: H,
        drawTo(ctx, a){
          ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = a/DRY_ALPHA;
          ctx.drawImage(this.cv, 0, 0, this.w, this.h); ctx.restore();
        } };
      dried.push({ b: page, at: now });
    }else if(!on && settings.fade){
      for(const it of dried){ const a = fadeAlpha(it, now); if(a > 0) it.b.drawTo(inkCtx, a); }
      dried = [];
    }
    settings.fade = on;
    dirty = true;
  }
  const MAX_BLOOMS = 48;

  function addBloom(o){
    // if things pile up (very fast playing) dry the oldest straight away
    while(blooms.length >= MAX_BLOOMS){
      const old = blooms.shift();
      const now = performance.now();
      if(now >= old.start){
        old.finishNow(now);
        settle(old);
      }
    }
    const b = new Bloom(o);
    blooms.push(b);
    return b;
  }

  // runs continuously, so blooms keep spreading and drying after the mic stops
  function animate(){
    const now = performance.now();
    if(dirty || blooms.length || dried.length){
      dirty = false;
      viewCtx.save();
      viewCtx.globalCompositeOperation = 'source-over';
      viewCtx.drawImage(texCanvas, 0, 0, W, H);
      viewCtx.globalCompositeOperation = 'multiply';
      viewCtx.drawImage(inkCanvas, 0, 0, W, H);
      viewCtx.restore();

      if(dried.length){
        dried = dried.filter(it=>{
          const a = fadeAlpha(it, now);
          if(a <= 0){ dirty = true; return false; }
          it.b.drawTo(viewCtx, a);
          return true;
        });
      }
      const keep = [];
      for(const b of blooms){
        if(now < b.start){ keep.push(b); continue; }
        b.step(now);
        if(b.cancelAt){
          const k = b.cancelFade(now);
          if(k <= 0) continue;
          b.drawTo(viewCtx, b.wetness(now)*k);
          keep.push(b); continue;
        }
        if(b.done){ settle(b); b.drawTo(viewCtx, DRY_ALPHA); continue; }
        b.drawTo(viewCtx, b.wetness(now));
        keep.push(b);
      }
      blooms = keep;
    }
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

  function tintFor(ev){
    const others = ev.tones.filter(t=>t !== ev.root);
    // a single note gets a hint of a neighbouring pigment for depth;
    // a chord's main wash is tinted by its next tone
    return others.length
      ? { tint: PIG_RGB[others[0]], amt: 0.25 }
      : { tint: PIG_RGB[(ev.root + (Math.random()<0.5 ? 1 : 11)) % 12], amt: 0.35 };
  }

  // the first drop: lands as soon as there's a confident first read
  function paintDrop(ev){
    const sizeMul = lerp(0.65, 1.5, settings.size);
    const radius = Math.min(W,H)*(0.045 + 0.075*ev.strength)*sizeMul;
    const {x, y} = pickSpot(radius);
    const {tint, amt} = tintFor(ev);
    const bloom = addBloom({ x, y, radius, rgb:PIG_RGB[ev.root], tint, tintAmt:amt, strength:ev.strength });
    return { bloom, x, y, radius, sizeMul, root: ev.root, tones: ev.tones };
  }

  // once the fuller listen is in: fix the colour if needed, bleed in the
  // other chord tones, flick a few droplets on hard hits, show the name
  function completeDrop(h, ev){
    if(ev.root !== h.root || ev.tones.join() !== h.tones.join()){
      const {tint, amt} = tintFor(ev);
      h.bloom.recolor(PIG_RGB[ev.root], tint, amt);
    }
    const {x, y, radius, sizeMul} = h;
    const rootRgb = PIG_RGB[ev.root];
    const others = ev.tones.filter(t=>t !== ev.root);

    others.slice(0, 2).forEach((pc, i)=>{
      const ang = Math.random()*Math.PI*2;
      const d = radius*(0.6 + Math.random()*0.45);
      addBloom({
        x: x + Math.cos(ang)*d, y: y + Math.sin(ang)*d,
        radius: radius*(0.42 + Math.random()*0.25),
        rgb: PIG_RGB[pc], tint: rootRgb, tintAmt: 0.3,
        strength: ev.strength*0.65,
        delay: i*90 + Math.random()*80,
        layers: 36
      });
    });

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
        alpha: 0.06, backrun:false, delay: Math.random()*60, impact: 2
      });
    }

    if(settings.showNames && ev.label){
      noteReadout.textContent = ev.label;
      noteReadout.classList.remove('fresh');
      void noteReadout.offsetWidth; // restart the fade-in
      noteReadout.classList.add('fresh');
    }
  }

  function paintEvent(ev){ completeDrop(paintDrop(ev), ev); }

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
    return { midi:r, midiF:midi, pc:((r%12)+12)%12, conf:1 - yinBuf[tau] };
  }

  // chroma: how much energy sits on each of the 12 pitch classes, built
  // from the spectral peaks (with sub-bin interpolation so the low strings
  // land on the right note). Two versions are kept: everything sounding,
  // and only what's *new* since the pluck — the second ignores whatever
  // was still ringing from the previous note or chord.
  const frameAll = new Float32Array(12), frameNew = new Float32Array(12);

  // one accumulator per analyser: the fast one gives the first read within
  // a few hundredths of a second, the slow one the more accurate final read
  function newAcc(an, buf){
    an.getFloatFrequencyData(buf);
    const pre = new Float32Array(buf.length);
    for(let k=0;k<buf.length;k++) pre[k] = Math.pow(10, buf[k]/20);
    return { an, buf, pre, chroma:new Float32Array(12), chromaNew:new Float32Array(12),
             newPeaks:0, peakSum:0, cf:0 };
  }

  function addChromaFrame(p){
    const an = p.an, sFreq = p.buf;
    an.getFloatFrequencyData(sFreq);
    const binHz = audioCtx.sampleRate/an.fftSize;
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
    p.peakSum += peaks.length;
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

  // Does this sound like a guitar? Each check rules out something else a
  // mic hears. `early` is the quick first read, with less to go on.
  function guitarLike(p, acc, early){
    // plucked strings are rich in overtones; whistles, beeps and hums
    // are close to a single pure tone
    if(acc.cf && acc.peakSum/acc.cf < 3) return false;
    // a string holds its pitch; a voice slides around
    const ps = p.pitches.map(q=>q.midiF);
    if(ps.length >= 3){
      const m = ps.reduce((a,v)=>a+v,0)/ps.length;
      const sd = Math.sqrt(ps.reduce((a,v)=>a+(v-m)*(v-m),0)/ps.length);
      if(sd > 0.45) return false;
    }else if(ps.length === 2 && Math.abs(ps[0]-ps[1]) > 0.8) return false;
    // a tap or knock is already gone by the time we look; a string isn't
    if(p.nowRms - p.preRms < 0.22*(p.peak - p.preRms)) return false;
    if(early) return true;
    // a pluck (or a strum across all six strings) peaks quickly;
    // speech and humming swell in
    if(p.peakAge > 185) return false;
    // and once it has peaked, a plucked string only ever dies away —
    // a held voice, a hum or a drone stays level or swells again
    const post = p.post;
    if(post.length >= 6){
      const k = Math.floor(post.length/3);
      const first = post.slice(0, k).reduce((a,v)=>a+v, 0)/k;
      const last = post.slice(-k).reduce((a,v)=>a+v, 0)/k;
      if(last > first*0.97) return false;
    }
    // a tap or knock dies away almost instantly; a plucked string is still
    // ringing well after the attack, louder than whatever was there before
    if(p.lateN){
      const late = p.lateSum/p.lateN;
      if(late - p.preRms*1.05 < 0.18*(p.peak - p.preRms)) return false;
    }
    return true;
  }

  function classify(p, early){
    const acc = (!early && p.slow.cf) ? p.slow : p.fast;
    if(acc.cf === 0) addChromaFrame(acc);
    if(!guitarLike(p, acc, early)) return null;
    // lean on what's new since the pluck (so the previous chord still ringing
    // doesn't leak in), with some of the full sound blended back for notes
    // the two chords share. If a re-strum left almost nothing "new", use all.
    let ch = acc.chroma;
    if(acc.newPeaks >= 3){
      const mn = Math.max(...acc.chromaNew), ma = Math.max(...acc.chroma);
      ch = Array.from(acc.chromaNew, (v,i)=>v/mn + 0.35*acc.chroma[i]/ma);
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
    if(p.pitches.length >= (early ? 1 : 2)){
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
    // tonal but doesn't match a note or a chord shape: probably not guitar
    return null;
  }

  // ---------- audio ----------
  let audioCtx = null, mediaStream = null, source = null;
  let onsetAn = null, fastAn = null, specAn = null;
  let tBuf, fFreq, sFreq, sTime;
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
      // ...a quick window for the first read of which notes are sounding...
      fastAn = audioCtx.createAnalyser();
      fastAn.fftSize = 2048;
      fastAn.smoothingTimeConstant = 0;
      // ...and a longer, more precise one for the final read
      specAn = audioCtx.createAnalyser();
      specAn.fftSize = 4096;
      specAn.smoothingTimeConstant = 0;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(onsetAn);
      lowpass.connect(fastAn);
      lowpass.connect(specAn);

      tBuf = new Float32Array(onsetAn.fftSize);
      fFreq = new Float32Array(fastAn.frequencyBinCount);
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
    source = onsetAn = fastAn = specAn = null;
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

  const EARLY_MS = 60;    // first drop lands this soon after the pluck
  const LISTEN_MS = 200;  // by now we've heard enough for the final read

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
      pending = { t0:now, peak:rms, peakAge:0, nowRms:rms, post:[], gate, preRms:recentMin, lateSum:0, lateN:0, pitches:[],
                  fast:newAcc(fastAn, fFreq), slow:newAcc(specAn, sFreq), drop:null, early:null };
    }

    if(pending){
      const age = now - pending.t0;
      pending.nowRms = rms;
      if(rms > pending.peak){ pending.peak = rms; pending.peakAge = age; pending.post = []; }
      else pending.post.push(rms);
      if(age > 110){ pending.lateSum += rms; pending.lateN++; }
      const sr = audioCtx.sampleRate;
      // only analyse audio that is entirely after the pluck
      if(age > 45){
        specAn.getFloatTimeDomainData(sTime);
        const y = yinDetect(sTime, sr);
        if(y) pending.pitches.push(y);
      }
      if(age >= fastAn.fftSize/sr*1000) addChromaFrame(pending.fast);
      if(age >= specAn.fftSize/sr*1000) addChromaFrame(pending.slow);
      if(!pending.early && age >= EARLY_MS && pending.fast.cf) earlyDrop(pending);
      if(age >= LISTEN_MS){
        resolvePending(pending);
        pending = null;
      }
    }

    requestAnimationFrame(listen);
  }

  function strengthOf(p){
    const loud = Math.log(Math.max(p.peak, p.gate)/p.gate)/Math.log(25);
    return 0.35 + 0.65*clamp(loud, 0, 1);
  }

  // quick first read: drop the ink straight away
  function earlyDrop(p){
    p.early = classify(p, true) || 'no';
    if(p.early === 'no') return;
    p.early.strength = strengthOf(p);
    p.drop = paintDrop(p.early);
  }

  // final read: confirm (and correct) the drop, or take it back
  function resolvePending(p){
    const res = classify(p, false);
    if(!res){ // didn't sound like a guitar note
      if(p.drop) p.drop.bloom.cancel(performance.now());
      return;
    }
    res.strength = p.drop ? p.early.strength : strengthOf(p);
    completeDrop(p.drop || paintDrop(res), res);
  }

  // ---------- controls ----------
  beginBtn.addEventListener('click', start);
  endBtn.addEventListener('click', ()=>stop());
  document.getElementById('clearBtn').addEventListener('click', ()=>{
    inkCtx.clearRect(0,0,W,H);
    dirty = true;
    blooms = [];
    dried = [];
    recentSpots = [];
    noteReadout.textContent = ' ';
  });

  // ---------- settings panel ----------
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const optNames = document.getElementById('optNames');
  const optSens = document.getElementById('optSens');
  const optSize = document.getElementById('optSize');
  // pigment rows show their 12 colours so you can see a palette before picking it
  const paletteList = document.getElementById('paletteList');
  const paperList = document.getElementById('paperList');
  const paperName = document.getElementById('paperName');
  for(const [k,v] of Object.entries(PALETTES)){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'palette-opt';
    btn.setAttribute('role', 'radio');
    btn.dataset.key = k;
    const name = document.createElement('span');
    name.textContent = v.label;
    const sw = document.createElement('span');
    sw.className = 'swatches';
    sw.setAttribute('aria-hidden', 'true');
    v.hex.forEach((hex, i)=>{
      const sq = document.createElement('i');
      sq.style.background = hex;
      sq.title = NOTE_NAMES[i];
      sw.appendChild(sq);
    });
    btn.append(name, sw);
    btn.addEventListener('click', ()=>{
      settings.palette = k; applyPalette(); syncChoices(); saveSettings();
    });
    paletteList.appendChild(btn);
  }
  for(const [k,v] of Object.entries(PAPERS)){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paper-opt';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', v.label);
    btn.title = v.label;
    btn.dataset.key = k;
    btn.style.background = `linear-gradient(135deg, ${v.c[0]}, ${v.c[2]})`;
    btn.addEventListener('click', ()=>{
      settings.paper = k; drawPaperTexture(); syncChoices(); saveSettings();
    });
    paperList.appendChild(btn);
  }
  function syncChoices(){
    paletteList.querySelectorAll('.palette-opt').forEach(b=>b.setAttribute('aria-checked', String(b.dataset.key === settings.palette)));
    paperList.querySelectorAll('.paper-opt').forEach(b=>b.setAttribute('aria-checked', String(b.dataset.key === settings.paper)));
    paperName.textContent = PAPERS[settings.paper].label;
  }
  const optFade = document.getElementById('optFade');
  const optLinger = document.getElementById('optLinger');
  const lingerRow = document.getElementById('lingerRow');
  const lingerVal = document.getElementById('lingerVal');
  function showLinger(){
    lingerRow.classList.toggle('disabled', !settings.fade);
    optLinger.disabled = !settings.fade;
    const sec = Math.round(lingerMs()/1000);
    lingerVal.textContent = sec >= 60 ? (Math.floor(sec/60) + 'm' + (sec%60 ? ' ' + sec%60 + 's' : '')) : sec + 's';
  }

  function applyNamesSetting(){
    noteReadout.classList.toggle('hidden', !settings.showNames);
    if(!settings.showNames) noteReadout.textContent = ' ';
  }
  function syncControls(){
    optNames.checked = !!settings.showNames;
    optSens.value = settings.sensitivity;
    optSize.value = settings.size;
    optFade.checked = !!settings.fade;
    optLinger.value = settings.linger;
    showLinger();
    applyNamesSetting();
    syncChoices();
  }
  syncControls();

  document.getElementById('resetBtn').addEventListener('click', ()=>{
    setFade(DEFAULTS.fade);
    Object.assign(settings, DEFAULTS);
    applyPalette();
    drawPaperTexture();
    syncControls();
    saveSettings();
  });

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
  optFade.addEventListener('change', ()=>{
    setFade(optFade.checked); showLinger(); saveSettings();
  });
  optLinger.addEventListener('input', ()=>{
    settings.linger = parseFloat(optLinger.value); showLinger(); saveSettings();
  });

})();
