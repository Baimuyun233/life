/* 多通道波形渲染。
   心电、动脉压、中心静脉压、颅内压、呼末二氧化碳、脉搏波、呼吸、脑电、肌电，
   共用一条仿真时间轴和一套走纸速度，哪几路显示由界面挑。

   所有通道的采样都按"仿真时间"推进，所以加速时是波形被推着走，不是被压扁；
   暂停时仿真时间不动，波形就停在原处。
*/

var WAVES = (function(){
  var MM = 6;                 // 1mm = 6px
  var mmS = 25;               // 走纸 mm/s
  var zoom = 1;               // 显示放大倍数，对应增益 10mm/mV
  var Fs = 250;               // 每仿真秒采样数
  var MAXCH = 6;

  var stack = null;
  var rows = {};              // id -> {el, cv, ctx, W, H}
  var buf = {};               // id -> [数值]
  var active = ['ecg','abp','co2'];
  var phase = 0, cprPhase = 0;
  var lastSimT = null, lastSim = null;
  var fib = [0,0,0,0], fibT = 0, emgFilt = 0;

  function clamp(x,a,b){ return x<a?a:(x>b?b:x); }
  function wrap(d){ if (d>0.5) d-=1; if (d<-0.5) d+=1; return d; }
  function gauss(d,s){ return Math.exp(-Math.pow(d/s,2)*0.5); }
  function pxPerSec(){ return mmS*MM; }

  /* ── 各通道的波形 ─────────────────────────── */

  // 心电
  function ecgBeat(u, sim){
    var hr = Math.max(20, sim.HR);
    var prF = clamp(sim.pr/1000*hr/60, 0.02, 0.5);
    var qtF = clamp(sim.qt/1000*hr/60, 0.10, 0.85);
    var qrsF = clamp(sim.qrs/1000*hr/60, 0.02, 0.4);
    var d = u > 0.6 ? u-1 : u;
    var y = 0;
    y += sim.pamp * gauss(d + prF, 0.018 + prF*0.03);
    var rSig = qrsF*0.16;
    y += 1.10*gauss(d, rSig);
    y -= 0.13*gauss(d + qrsF*0.42, rSig*0.9);
    y -= 0.30*gauss(d - qrsF*0.48, rSig*1.1);
    var st0 = qrsF*0.55, st1 = qtF*0.42;
    if (d>st0 && d<st1) y += sim.stSeg*0.12;
    y += sim.tamp*gauss(d - qtF*0.62, 0.040 + qtF*0.075);
    if (sim.uWave > 0.02) y += sim.uWave*gauss(d - qtF*1.28, 0.03);
    return y;
  }

  function sECG(sim,u){
    if (sim.rhythm==='vf'){
      fibT += 1/Fs;
      for (var i=0;i<4;i++) fib[i] += (Math.random()-0.5)*0.34;
      for (var j=0;j<4;j++) fib[j] *= 0.97;
      var t = fibT;
      return (Math.sin(t*17+fib[0]*3)*0.24 + Math.sin(t*11+fib[1]*2)*0.30
             + Math.sin(t*5.3+fib[2])*0.22 + fib[3]*0.6)*0.9;
    }
    if (sim.rhythm==='asystole') return (Math.random()-0.5)*0.02;
    if (sim.rhythm==='sine') return Math.sin(u*Math.PI*2)*0.85;
    return ecgBeat(u, sim) + Math.sin(sim.t*0.7)*0.02;
  }

  // 动脉压
  function abpShape(u){
    var s = gauss(u-0.13, 0.075) + 0.22*gauss(u-0.37, 0.055);
    return clamp(s, 0, 1.15);
  }
  function sABP(sim,u){
    var sbp = sim.SBP, dbp = Math.max(4, sim.DBP);
    var pp = Math.max(6, sbp - dbp);
    var noPulse = (sim.rhythm==='vf' || sim.rhythm==='asystole');
    if (noPulse){
      if (sim.ops.cpr > 0){
        var uc = cprPhase % 1;
        return sim.MAP*0.45 + pp*0.55*gauss(uc-0.16, 0.085);
      }
      return 8 + Math.random()*3;
    }
    return dbp + pp*abpShape(u);
  }

  // 中心静脉压
  function sCVP(sim,u){
    var base = sim.CVP;
    var a = 1.5*gauss(wrap(u-0.88), 0.05);
    var c = 0.8*gauss(wrap(u-0.02), 0.04);
    var v = 1.2*gauss(wrap(u-0.34), 0.06);
    return base + a + c + v;
  }

  // 颅内压：现在只做了 CO₂ 反应性这一条
  function sICP(sim,u){
    var base = sim.icp || 12;
    return base + 0.35*gauss(u-0.15, 0.06) + 0.4*Math.sin((sim.respPhase||0)*Math.PI*2);
  }

  // 呼末二氧化碳，呼吸周期 0 点算吸气开始
  function sCO2(sim,rp){
    var e = Math.max(2, sim.etco2 || 38);
    var v;
    if (rp < 0.16) v = 0.02*e;
    else if (rp < 0.24) v = e*((rp-0.16)/0.08);
    else if (rp < 0.80) v = e*(0.93 + 0.07*((rp-0.24)/0.56));
    else v = e*(1 - (rp-0.80)/0.20);
    return v + (Math.random()-0.5)*0.25;
  }

  // 脉搏波
  function sPleth(sim,u){
    if (sim.rhythm==='vf' || sim.rhythm==='asystole') return Math.random()*0.03;
    var amp = clamp((sim.SBP-sim.DBP)/45, 0.15, 1.3);
    return amp*(gauss(u-0.22, 0.10) + 0.35*gauss(u-0.46, 0.09));
  }

  // 呼吸（胸阻抗）
  function sResp(sim,rp){ return Math.sin(rp*Math.PI*2)*0.9; }

  // 脑电：清醒低幅快波，镇静深了变慢变大，致幻剂叠加快波串，脑死亡是等电位线
  function sEEG(sim,t){
    var c = clamp(sim.cns, 0, 1.2);
    if (sim.dead || c < 0.04) return (Math.random()-0.5)*0.8;
    var hal = clamp((sim.axes && sim.axes.halluc) || 0, 0, 1.5);
    var f = 6 + 15*c;
    var amp = 6 + 24*(1-Math.min(1,c));
    var y = amp*(0.55*Math.sin(t*f*2*Math.PI)
              + 0.28*Math.sin(t*f*0.47*2*Math.PI + 1.1)
              + 0.17*Math.sin(t*f*1.9*2*Math.PI + 2.3));
    y += (Math.random()-0.5)*amp*0.5;
    if (hal > 0.05){
      // 致幻：一串串快波压上来，频率自己在飘，不是一条干净的正弦
      var fh = 17 + 4*Math.sin(t*0.37) + 2*Math.sin(t*1.13);
      y += 12*hal*Math.sin(t*fh*2*Math.PI)*(0.50+0.50*Math.sin(t*0.83));
      y += 5*hal*Math.sin(t*(fh*1.7)*2*Math.PI + 0.7);
      y += (Math.random()-0.5)*11*hal;
    }
    if (c < 0.30) y *= 0.30 + 0.70*Math.abs(Math.sin(t*1.4));   // 爆发抑制
    return y;
  }

  // 肌电：肌松药下去就平了
  function sEMG(sim){
    var nj = (sim.blk && sim.blk.NMJ) ? sim.blk.NMJ : 0;
    if (sim.dead || nj > 0.6) return Math.random()*0.4;
    var c = clamp(sim.cns, 0, 1.2);
    var a = (2.5 + 13*Math.max(0,c-0.2))*(1-nj);
    emgFilt = emgFilt*0.35 + (Math.random()-0.5)*0.65;
    return Math.abs(emgFilt)*a*1.8;
  }

  /* ── 通道定义 ─────────────────────────────── */
  var DEFS = {
    ecg:   {name:'II 心电', color:'#31f0a0',
            range:function(){ return [-1.2/zoom, 1.2/zoom]; },
            val:function(s){ return (s.rhythm==='vf'||s.rhythm==='asystole') ? '—' : Math.round(s.HR)+' bpm'; }},
    abp:   {name:'ABP 动脉压', color:'#ff6b6b',
            range:function(s){ return [0, Math.max(150, s.SBP*1.18)]; },
            val:function(s){ return Math.round(s.SBP)+'/'+Math.round(s.DBP)+' mmHg'; }},
    cvp:   {name:'CVP 中心静脉压', color:'#7fc8ff',
            range:function(s){ return [0, Math.max(12, s.CVP*1.9)]; },
            val:function(s){ return s.CVP.toFixed(1)+' mmHg'; }},
    icp:   {name:'ICP 颅内压', color:'#c39bff',
            range:function(s){ return [0, Math.max(30, (s.icp||12)*1.7)]; },
            val:function(s){ return (s.icp||12).toFixed(1)+' mmHg'; }},
    co2:   {name:'CO₂ 呼末', color:'#ffd166',
            range:function(s){ return [0, Math.max(50, (s.etco2||38)*1.35)]; },
            val:function(s){ return Math.round(s.etco2||0)+' mmHg'; }},
    pleth: {name:'SpO₂ 脉搏波', color:'#5ce1e6',
            range:function(){ return [0, 1.35]; },
            val:function(s){ return Math.round(s.SpO2)+' %'; }},
    resp:  {name:'RESP 呼吸', color:'#8fe6c4',
            range:function(){ return [-1.1, 1.1]; },
            val:function(s){ return Math.round(s.RR)+' /min'; }},
    eeg:   {name:'EEG 脑电', color:'#a0d8ff',
            range:function(){ return [-45, 45]; },
            val:function(s){ return LIFE.stateText(s); }},
    emg:   {name:'EMG 肌电', color:'#ffa8d8',
            range:function(){ return [0, 50]; },
            val:function(s){ var nj=(s.blk&&s.blk.NMJ)||0; return (s.dead||nj>0.6)?'肌松':(s.cns>=0.8?'有活动':'低'); }}
  };
  var ORDER = ['ecg','abp','cvp','icp','co2','pleth','resp','eeg','emg'];

  /* ── 建 DOM ───────────────────────────────── */

  function init(container){
    stack = container;
    rebuild();
  }

  function rebuild(){
    if (!stack) return;
    stack.innerHTML = '';
    rows = {}; buf = {};
    for (var i=0;i<active.length;i++){
      var id = active[i];
      var row = document.createElement('div');
      row.className = 'wrow';
      row.innerHTML = '<div class="wlab">'+DEFS[id].name+'</div><div class="wval num">—</div>';
      var cv = document.createElement('canvas');
      row.appendChild(cv);
      stack.appendChild(row);
      rows[id] = {el:row, cv:cv, ctx:cv.getContext('2d'), W:0, H:0, dpr:1};
      buf[id] = [];
    }
    measure();
    if (lastSim) prime(lastSim);
  }

  function measure(){
    for (var id in rows){
      var r = rows[id];
      r.dpr = window.devicePixelRatio || 1;
      var rect = r.cv.getBoundingClientRect();
      r.W = Math.max(120, rect.width|0);
      r.H = Math.max(30, rect.height|0);
      r.cv.width = r.W*r.dpr;
      r.cv.height = r.H*r.dpr;
      r.ctx.setTransform(r.dpr,0,0,r.dpr,0,0);
    }
  }
  function resize(){ measure(); }

  /* ── 采样 ─────────────────────────────────── */

  function maxSamples(){ return Math.ceil((rows[active[0]] ? rows[active[0]].W : 900)/pxPerSec()*Fs) + 8; }

  // 推进 n 个采样点，所有在显示的通道共用同一个心搏相位
  function advance(sim, n, tEnd){
    for (var i=0;i<n;i++){
      var t = tEnd - (n-i)/Fs;
      phase += (Math.max(10, sim.HR)/60)/Fs;
      if (sim.ops.cpr > 0) cprPhase += (100/60)/Fs;
      var u = phase % 1;
      var rp = (sim.respPhase + (t - sim.t)*sim.RR/60) % 1;
      if (rp < 0) rp += 1;
      for (var k=0;k<active.length;k++){
        var id = active[k];
        var v;
        if (id==='ecg') v = sECG(sim,u);
        else if (id==='abp') v = sABP(sim,u);
        else if (id==='cvp') v = sCVP(sim,u);
        else if (id==='icp') v = sICP(sim,u);
        else if (id==='co2') v = sCO2(sim,rp);
        else if (id==='pleth') v = sPleth(sim,u);
        else if (id==='resp') v = sResp(sim,rp);
        else if (id==='eeg') v = sEEG(sim,t);
        else if (id==='emg') v = sEMG(sim);
        else v = 0;
        buf[id].push(v);
      }
    }
    var mx = maxSamples();
    for (var q=0;q<active.length;q++){
      var b = buf[active[q]];
      while (b.length > mx) b.shift();
    }
  }

  function prime(sim){
    lastSim = sim;
    for (var id in buf) buf[id] = [];
    if (!active.length) return;
    lastSimT = sim.t;
    var n = Math.ceil((rows[active[0]] ? rows[active[0]].W : 900)/pxPerSec()*Fs);
    phase = 0; cprPhase = 0; fibT = 0; fib = [0,0,0,0];
    advance(sim, n, sim.t);
  }

  /* ── 绘制 ─────────────────────────────────── */

  function drawGrid(ctx, W, H){
    ctx.fillStyle = '#08090c';
    ctx.fillRect(0,0,W,H);
    ctx.strokeStyle = 'rgba(0,120,90,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x=0;x<W;x+=MM*2){ ctx.moveTo(x+.5,0); ctx.lineTo(x+.5,H); }
    for (var y=0;y<H;y+=MM*2){ ctx.moveTo(0,y+.5); ctx.lineTo(W,y+.5); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,170,120,0.18)';
    ctx.beginPath();
    for (var x2=0;x2<W;x2+=MM*10){ ctx.moveTo(x2+.5,0); ctx.lineTo(x2+.5,H); }
    ctx.stroke();
  }

  function drawRow(sim, id){
    var r = rows[id];
    if (!r || !r.W) return;
    var ctx = r.ctx, W = r.W, H = r.H;
    drawGrid(ctx, W, H);

    var rg = DEFS[id].range(sim);
    var lo = rg[0], hi = rg[1];
    if (hi - lo < 1e-6) hi = lo + 1;
    var pad = 5;
    var stepX = pxPerSec()/Fs;
    var b = buf[id];
    var vis = Math.min(b.length, Math.ceil(W/pxPerSec()*Fs));
    var x0 = W - vis*stepX;

    ctx.strokeStyle = DEFS[id].color;
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.shadowColor = DEFS[id].color;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    for (var i=0;i<vis;i++){
      var v = b[b.length-vis+i];
      var x = x0 + i*stepX;
      var y = pad + (1 - (v-lo)/(hi-lo))*(H-pad*2);
      if (y<pad) y=pad; if (y>H-pad) y=H-pad;
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    var g = ctx.createLinearGradient(W-30,0,W,0);
    g.addColorStop(0,'rgba(8,9,12,0)');
    g.addColorStop(1,'rgba(8,9,12,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(W-30,0,30,H);

    var vu = r.el.querySelector('.wval');
    if (vu) vu.textContent = DEFS[id].val(sim);
  }

  function draw(sim){
    if (!stack) return;
    lastSim = sim;
    if (lastSimT === null){ prime(sim); }
    else {
      var d = sim.t - lastSimT;
      lastSimT = sim.t;
      if (d > 0){
        var n = Math.min(900, Math.round(d*Fs));
        if (n > 0) advance(sim, n, sim.t);
      }
    }
    for (var k=0;k<active.length;k++) drawRow(sim, active[k]);
  }

  /* ── 设置 ─────────────────────────────────── */

  function list(){ return ORDER.map(function(id){ return {id:id, name:DEFS[id].name}; }); }
  function activeList(){ return active.slice(); }

  function setActive(ids){
    var out = [];
    for (var i=0;i<ids.length && out.length<MAXCH;i++) if (DEFS[ids[i]]) out.push(ids[i]);
    if (!out.length) out = ['ecg'];
    active = out;
    rebuild();
  }
  function toggle(id){
    var i = active.indexOf(id);
    if (i >= 0){
      if (active.length === 1) return activeList();
      active.splice(i,1);
    } else {
      if (active.length >= MAXCH) return activeList();
      active.push(id);
    }
    active = ORDER.filter(function(x){ return active.indexOf(x)>=0; });
    rebuild();
    return activeList();
  }

  function setPaper(v){
    mmS = v;
    if (lastSim) prime(lastSim);
  }
  function setGain(v){
    zoom = v/10;
  }
  function paper(){ return mmS; }
  function gain(){ return Math.round(zoom*10); }
  function clear(){ for (var id in buf) buf[id] = []; lastSimT = null; phase = 0; cprPhase = 0; }

  return { init:init, draw:draw, resize:resize, clear:clear, prime:prime,
           setPaper:setPaper, setGain:setGain, paper:paper, gain:gain,
           list:list, activeList:activeList, setActive:setActive, toggle:toggle,
           MAXCH:MAXCH };
})();

// 旧名字，dev 里的页面还在用
var ECG = WAVES;
