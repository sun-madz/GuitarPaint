(function(){

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

  // ---------- canvases ----------
  const wrap = document.getElementById('paperWrap');
  const texCanvas = document.getElementById('paperTexture');
  const inkCanvas = document.getElementById('ink');
  const texCtx = texCanvas.getContext('2d');
  const inkCtx = inkCanvas.getContext('2d');

  let W = 0, H = 0, DPR = Math.min(window.devicePixelRatio||1, 2);

  function resize(){
    const rect = wrap.getBoundingClientRect();
    W = rect.width; H = rect.height;
    [texCanvas, inkCanvas].forEach(c=>{
      c.width = W*DPR; c.height = H*DPR;
    });
    texCtx.setTransform(DPR,0,0,DPR,0,0);
    inkCtx.setTransform(DPR,0,0,DPR,0,0);
    drawPaperTexture();
  }

  function drawPaperTexture(){
    texCtx.clearRect(0,0,W,H);
    const grad = texCtx.createLinearGradient(0,0,W,H);
    grad.addColorStop(0, '#efe8d8');
    grad.addColorStop(0.5, '#ece3d0');
    grad.addColorStop(1, '#e6dcc6');
    texCtx.fillStyle = grad;
    texCtx.fillRect(0,0,W,H);

    const n = 3200;
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

  // ---------- watercolor blob rendering ----------
  function blobPath(ctx, pts){
    ctx.beginPath();
    const n = pts.length;
    for(let i=0;i<n;i++){
      const p0 = pts[(i-1+n)%n];
      const p1 = pts[i];
      const p2 = pts[(i+1)%n];
      const mx = (p1.x+p2.x)/2, my = (p1.y+p2.y)/2;
      if(i===0){ ctx.moveTo((p0.x+p1.x)/2, (p0.y+p1.y)/2); }
      ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
    }
    ctx.closePath();
  }

  function easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }

  // a single, immediate concentrated dot — the "droplet hits the page" moment
  function paintDroplet(x, y, r, rgb, strength){
    inkCtx.save();
    inkCtx.globalCompositeOperation = 'multiply';
    const a = Math.min(0.9, 0.42*strength + 0.22);
    const grad = inkCtx.createRadialGradient(x,y,0, x,y, r*1.4);
    grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`);
    grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
    inkCtx.fillStyle = grad;
    inkCtx.beginPath();
    inkCtx.arc(x, y, r*1.4, 0, Math.PI*2);
    inkCtx.fill();
    inkCtx.restore();
  }

  // ---------- droplet + organic bleed/dissolve animation ----------
  // each blob is a small state object updated every frame; it paints a
  // little more ink each tick as its radius eases outward and its edges
  // wobble, so the accumulated result reads as a droplet spreading and
  // dissolving into the paper rather than a shape popping into place
  let activeBlobs = [];
  const POINT_COUNT = 12;
  const ALPHA_RATE = 0.95; // per second — tuned so the total wash lands near the old one-shot strength

  function spawnBlob(x, y, rgb, strength){
    const maxRadius = Math.min(W,H) * (0.05 + strength*0.09);
    const dropletRadius = maxRadius * 0.16;
    const duration = 650 + strength*650 + Math.random()*250;
    const angles = [], radiusJitter = [];
    for(let i=0;i<POINT_COUNT;i++){
      angles.push((i/POINT_COUNT)*Math.PI*2 + (Math.random()-0.5)*0.18);
      radiusJitter.push(0.78 + Math.random()*0.44);
    }
    paintDroplet(x, y, dropletRadius, rgb, strength);
    activeBlobs.push({
      x, y, rgb, strength, maxRadius, dropletRadius, duration,
      start: performance.now(), angles, radiusJitter
    });
  }

  function renderBlobFrame(b, now, dt){
    const elapsed = now - b.start;
    const t = Math.min(1, elapsed/b.duration);
    const radius = b.dropletRadius + (b.maxRadius - b.dropletRadius) * easeOutCubic(t);

    // slow random walk on each edge point so the boundary looks like it's
    // actively spreading/dissolving, not just scaling up uniformly
    for(let i=0;i<b.radiusJitter.length;i++){
      b.radiusJitter[i] += (Math.random()-0.5)*0.05;
      b.radiusJitter[i] = Math.min(1.4, Math.max(0.62, b.radiusJitter[i]));
    }
    const pts = b.angles.map((ang,i)=>({
      x: b.x + Math.cos(ang)*radius*b.radiusJitter[i],
      y: b.y + Math.sin(ang)*radius*b.radiusJitter[i]
    }));

    // ripple ring right at impact, fading fast — the "splash" of the drop
    if(elapsed < 260){
      const rt = elapsed/260;
      const rr = b.dropletRadius * (1 + rt*2.2);
      inkCtx.save();
      inkCtx.globalCompositeOperation = 'multiply';
      inkCtx.strokeStyle = `rgba(${b.rgb.r},${b.rgb.g},${b.rgb.b},${0.16*b.strength*(1-rt)})`;
      inkCtx.lineWidth = 1.2;
      inkCtx.beginPath();
      inkCtx.arc(b.x, b.y, rr, 0, Math.PI*2);
      inkCtx.stroke();
      inkCtx.restore();
    }

    // continuous bleed: a thin translucent wash painted every frame, so the
    // area covered longest (near the center) ends up darkest, and the
    // leading edge (reached only in the final frames) stays palest
    const frameAlpha = ALPHA_RATE * b.strength * (dt/1000) * (1 - t*0.35);
    const grad = inkCtx.createRadialGradient(b.x,b.y,0, b.x,b.y, radius*1.12);
    grad.addColorStop(0, `rgba(${b.rgb.r},${b.rgb.g},${b.rgb.b},${frameAlpha*1.5})`);
    grad.addColorStop(0.65, `rgba(${b.rgb.r},${b.rgb.g},${b.rgb.b},${frameAlpha})`);
    grad.addColorStop(1, `rgba(${b.rgb.r},${b.rgb.g},${b.rgb.b},0)`);
    inkCtx.save();
    inkCtx.globalCompositeOperation = 'multiply';
    inkCtx.fillStyle = grad;
    blobPath(inkCtx, pts);
    inkCtx.fill();
    inkCtx.restore();

    if(t >= 1){
      // settle with one soft pooled rim, like a finished watercolor edge
      inkCtx.save();
      inkCtx.globalCompositeOperation = 'multiply';
      inkCtx.strokeStyle = `rgba(${b.rgb.r*0.55|0},${b.rgb.g*0.55|0},${b.rgb.b*0.55|0},${0.11*b.strength})`;
      inkCtx.lineWidth = 1.4;
      blobPath(inkCtx, pts);
      inkCtx.stroke();
      inkCtx.restore();
      return false; // finished — drop from the active list
    }
    return true;
  }

  // this loop runs continuously regardless of mic/listening state, so a
  // blob started right before "end session" still finishes dissolving
  let lastAnimTick = performance.now();
  function animateBlobs(){
    const now = performance.now();
    const dt = Math.min(64, now - lastAnimTick); // clamp so a stalled tab doesn't dump ink
    lastAnimTick = now;
    if(activeBlobs.length){
      activeBlobs = activeBlobs.filter(b => renderBlobFrame(b, now, dt));
    }
    requestAnimationFrame(animateBlobs);
  }
  requestAnimationFrame(animateBlobs);

  // ---------- YIN pitch detection ----------
  // Far more reliable than basic autocorrelation for plucked-string tone.
  // Returns freq = -1 when the signal isn't periodic/tonal enough (taps,
  // consonants, breath noise, etc all fail this test and are rejected).
  const YIN_THRESHOLD = 0.12; // lower = stricter about how "clean" the pitch must be

  function yinDetectPitch(buf, sampleRate){
    const yinSize = Math.floor(buf.length/2);
    const yinBuffer = new Float32Array(yinSize);

    // difference function
    for(let tau=0; tau<yinSize; tau++){
      let sum=0;
      for(let i=0;i<yinSize;i++){
        const delta = buf[i]-buf[i+tau];
        sum += delta*delta;
      }
      yinBuffer[tau]=sum;
    }

    // cumulative mean normalized difference function
    yinBuffer[0]=1;
    let runningSum=0;
    for(let tau=1; tau<yinSize; tau++){
      runningSum += yinBuffer[tau];
      yinBuffer[tau] = runningSum === 0 ? 1 : yinBuffer[tau]*tau/runningSum;
    }

    // absolute threshold: first dip below threshold, refined to its local minimum
    let tauEstimate = -1;
    for(let tau=2; tau<yinSize; tau++){
      if(yinBuffer[tau] < YIN_THRESHOLD){
        while(tau+1 < yinSize && yinBuffer[tau+1] < yinBuffer[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if(tauEstimate === -1) return { freq:-1, confidence:0 };

    // parabolic interpolation around the minimum for a sub-sample estimate
    const x0 = tauEstimate>1 ? tauEstimate-1 : tauEstimate;
    const x2 = tauEstimate+1<yinSize ? tauEstimate+1 : tauEstimate;
    let betterTau = tauEstimate;
    if(x0!==tauEstimate && x2!==tauEstimate){
      const s0=yinBuffer[x0], s1=yinBuffer[tauEstimate], s2=yinBuffer[x2];
      const denom = (2*s1-s2-s0);
      if(denom !== 0) betterTau = tauEstimate + (s2-s0)/(2*denom);
    }

    const freq = sampleRate/betterTau;
    const confidence = 1 - yinBuffer[tauEstimate];
    return { freq, confidence };
  }

  function freqToNote(freq){
    const midi = 69 + 12*Math.log2(freq/440);
    const rounded = Math.round(midi);
    const name = NOTE_NAMES[((rounded%12)+12)%12];
    const octave = Math.floor(rounded/12) - 1;
    return { name, octave, midi: rounded, pitchClass: ((rounded%12)+12)%12 };
  }

  // guitar's practical range (low E to well past the highest frets/harmonics)
  const MIN_FREQ = 75;
  const MAX_FREQ = 1300;

  // ---------- audio ----------
  let audioCtx, analyser, source, highpass, lowpass, dataArray, mediaStream;
  let running = false;
  let lastOnsetTime = 0;
  let energyHistory = [];
  let recentPitches = []; // recent {freq, pitchClass, time} valid, tonal detections

  const noteReadout = document.getElementById('note-readout');
  const statusText = document.getElementById('statusText');
  const meterFill = document.getElementById('meterFill');
  const startOverlay = document.getElementById('startOverlay');
  const endBtn = document.getElementById('endBtn');

  async function start(){
    try{
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation:false, noiseSuppression:false, autoGainControl:true
      }});
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      if(audioCtx.state === 'suspended'){ await audioCtx.resume(); }

      source = audioCtx.createMediaStreamSource(mediaStream);

      // shape the signal toward guitar's tonal range before analysis:
      // cuts sub-bass rumble/breath and de-emphasizes high hiss/sibilance
      // that speech consonants and taps tend to carry
      highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 70;
      lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 1800;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(analyser);

      dataArray = new Float32Array(analyser.fftSize);
      running = true;
      lastOnsetTime = 0;
      energyHistory = [];
      recentPitches = [];
      startOverlay.classList.add('hidden');
      endBtn.classList.remove('hidden');
      statusText.textContent = 'listening…';
      requestAnimationFrame(loop);
    }catch(err){
      statusText.textContent = 'could not access the microphone — check permissions and try again.';
      console.error(err);
    }
  }

  function stop(){
    running = false;
    if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream = null; }
    if(audioCtx){ audioCtx.close(); audioCtx = null; }
    meterFill.style.width = '0%';
    noteReadout.textContent = '\u00a0';
    statusText.textContent = 'not listening';
    endBtn.classList.add('hidden');
    startOverlay.classList.remove('hidden');
  }

  function loop(){
    if(!running) return;
    analyser.getFloatTimeDomainData(dataArray);

    let rms = 0;
    for(let i=0;i<dataArray.length;i++){ rms += dataArray[i]*dataArray[i]; }
    rms = Math.sqrt(rms/dataArray.length);
    meterFill.style.width = Math.min(100, rms*400) + '%';

    energyHistory.push(rms);
    if(energyHistory.length > 40) energyHistory.shift();
    const avg = energyHistory.reduce((a,b)=>a+b,0)/energyHistory.length;

    const now = performance.now();

    // only spend cycles on the YIN pitch search when there's meaningful
    // signal — keeps things cheap while "quiet"
    if(rms > 0.006){
      const { freq } = yinDetectPitch(dataArray, audioCtx.sampleRate);
      if(freq >= MIN_FREQ && freq <= MAX_FREQ){
        const note = freqToNote(freq);
        recentPitches.push({ freq, pitchClass: note.pitchClass, octave: note.octave, time: now });
      }
    }
    // keep only the last ~150ms of valid tonal detections
    recentPitches = recentPitches.filter(p => now - p.time < 150);

    const isOnset = rms > Math.max(0.012, avg*1.6) && (now - lastOnsetTime) > 160;

    if(isOnset){
      // require an actual tonal, sustained pitch near this moment — this
      // is what rejects taps, claps and most speech (which rarely holds
      // a clean, stable pitch the way a plucked string does)
      const match = recentPitches.length
        ? recentPitches[recentPitches.length-1]
        : null;

      if(match){
        lastOnsetTime = now;
        const pigment = PIGMENTS[match.pitchClass];
        const rgb = hexToRgb(pigment.hex);

        const x = W*0.12 + Math.random()*W*0.76;
        const y = H*0.15 + Math.random()*H*0.7;

        const strength = Math.min(1, 0.4 + rms*5);

        spawnBlob(x, y, rgb, strength);

        noteReadout.textContent = pigment.name + match.octave;
        statusText.textContent = 'listening…';
      }
      // if there's no confident tonal match, we quietly skip painting —
      // the sound didn't look like a guitar note
    }

    requestAnimationFrame(loop);
  }

  document.getElementById('beginBtn').addEventListener('click', start);
  endBtn.addEventListener('click', stop);
  document.getElementById('clearBtn').addEventListener('click', ()=>{
    inkCtx.clearRect(0,0,W,H);
    activeBlobs = [];
  });

})();
