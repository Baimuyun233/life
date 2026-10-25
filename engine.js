/* 生理引擎。不碰 DOM，不碰界面，可以在 node 里直接跑，方便调参和回归测试。
   一次 tick 做七件事：药代、靶点占据、呼吸酸碱、肾脏电解质、血糖、循环、心律与心电参数。
*/

var CFG = {
  tauHR: 8, tauSVR: 10, tauCO2: 50, tauGlu: 40,
  // 钾：游戏时间压缩过，速率比真实快约十倍，方向与相对快慢不变
  kLoad: 0.62, kExcr: 0.62, kShiftMax: 2.4, acidK: 2.2, kalGain: 1.8,
  // 乳酸
  do2Crit: 330, lacRate: 0.32, lacClear: 0.07,
  bloodVol: 5.0
};

// 内源性基础张力。拮抗剂先削掉它，才谈得上"阻断交感"。
var TONE = {
  b1:0.36, b2:0.42, a1:0.30, a2:0.16, M2:0.50, M3:0.45,
  LCaL:0.50, NaCh:0.50, IKr:0.50, IK1:0.50, KATP:0.20, KATPb:0.30,
  NKCC2:0.40, NCC:0.30, ENaC:0.30, MR:0.40, NaK:0.50, ACE:0.40,
  AT1:0.40, renin:0.35, COX:0.40, PDE3:0.40, PDE5:0.35, ACHE:0.50,
  mu:0, GABA:0, H1:0.20, V1:0.20, V2:0.30, inslR:0.30, glucR:0.15,
  GR:0.30, D1:0.15, D2:0.20, NO:0.35, osm:0, thyR:0.30,
  HT2A:0.06, CB1:0.05, NMDA:0.90, nACh:0.30, ADO:0.40, a2c:0.30, NMJ:1.0
};

function clamp(x,a,b){ return x<a?a:(x>b?b:x); }

var LIFE = { drugs:{}, presets:[] };
function indexKB(){
  LIFE.drugs = {};
  for (var i=0;i<DRUGS.length;i++) LIFE.drugs[DRUGS[i].id] = DRUGS[i];
  LIFE.presets = PRESETS;
}
indexKB();

function getPreset(id){
  for (var i=0;i<PRESETS.length;i++) if (PRESETS[i].id===id) return PRESETS[i];
  return PRESETS[0];
}

function newSim(presetId, overrides){
  var p = getPreset(presetId);
  var st = {};
  for (var k in p.st) st[k] = p.st[k];
  if (overrides) for (var k2 in overrides) st[k2] = overrides[k2];

  var sim = {
    t:0, wt:p.w||70, age:p.age||40, pid:p.id, pname:p.name, note:p.note||'',
    hr0: st.HR||72, rr0: st.RR||16, svr0: st.svr||1400, ino0: st.ino==null?1:st.ino,
    vol: st.vol==null?1:st.vol, K: st.K==null?4.2:st.K, Na: st.Na||140,
    Ca: st.Ca==null?1.2:st.Ca, Mg: st.Mg||0.85, HCO3: st.HCO3||24,
    pCO2: st.pCO2||40, pH: 7.40, glu: st.glu||5.0, lac: st.lac||1.0,
    hgb: st.hgb||140, gfr0: st.gfr||100, gfr: st.gfr||100,
    airway: st.airway||1, compliance: st.compliance||1, temp: st.temp||36.6,
    cns: st.cns==null?1:st.cns,
    HR: st.HR||72, RR: st.RR||16, SV:70, CO:5, SVR: st.svr||1400,
    MAP:93, SBP:120, DBP:78, CVP:10, SpO2:98, PaO2:95, urine:60, cr:80, DO2:900,
    icp: 12, etco2: 38,
    rx:[], axes:{}, axDetail:{},
    rhythm:'sinus', qrs:88, pr:150, qt:400, qtc:400, tamp:0.35, pamp:0.2,
    stSeg:0, uWave:0, arrh:0, vfT:0, riskRate:0,
    ops:{ cpr:0, vent:0, fio2:0.21, rrSet:14, vtSet:450 },
    dead:false, deathT:null, flatT:0, lowT:0,
    respPhase:0, noise:0, noise2:0, noise3:0,
    hist:[], log:[], respDrive:1
  };
  for (var a=0;a<AXES.length;a++) sim.axes[AXES[a]] = 0;
  sim.cns0 = st.cns==null ? 1 : st.cns;
  computeAxes(sim);
  respStep(sim, 0.5);
  sim.pH = 6.1 + Math.log10(sim.HCO3/(0.03*sim.pCO2));
  circStep(sim, 0.5);
  sim.mapRef = sim.MAP;
  rhythmStep(sim, 0.001);
  record(sim);
  return sim;
}

/* ── 给药 ─────────────────────────────────── */

function give(sim, drugId, dose, route, rate){
  var d = LIFE.drugs[drugId];
  if (!d) return null;
  if (sim.dead){ log(sim,'给药','病人已死亡，'+d.name+' 没有意义'); return null; }
  var rec = {
    id:d.id, name:d.name, unit:d.unit, route:route||'iv', dose:dose,
    ag:d.ag||{}, ant:d.ant||{}, dir:d.dir||{}, toxK:d.toxK||false,
    t12:d.pk.t12, vd:d.pk.vd, depot:0, central:0, infRate:0, t0:sim.t, cum:0
  };
  var f = route==='po'?0.6 : route==='im'?0.85 : route==='sl'?0.8 : 1;   // 吸入按即入血算，不再走口服那一套吸收

  if (route==='inf'){
    rec.infRate = rate || (d.inf?d.inf[0]:dose);
    if (dose) rec.depot = dose*f;
  } else if (route==='po'||route==='im'||route==='sl'){
    rec.depot = dose*f;
  } else {
    // 静推与吸入都算即刻入血，吸入药起效本来就快
    rec.central = dose;
  }
  if (d.dir && route!=='inf'){
    for (var k in d.dir){
      if (k==='vol') sim.vol += d.dir[k]*dose;
      else sim[k] += d.dir[k]*dose;
    }
  }
  sim.rx.push(rec);
  log(sim,'给药', d.name+' '+(route==='inf'?(rec.infRate+' '+d.unit+'/min'):(dose+' '+d.unit))+'　'+route);
  computeAxes(sim);
  return rec;
}

function stopInfusion(sim, i){
  var r = sim.rx[i];
  if (r){ r.infRate = 0; log(sim,'停泵', r.name); }
}

function pkStep(sim, dt){
  var dtm = dt/60;
  for (var i=sim.rx.length-1;i>=0;i--){
    var r = sim.rx[i];
    if (r.depot>0){
      var abs = r.depot*(1-Math.exp(-Math.LN2/20*dtm));
      r.depot -= abs; r.central += abs;
    }
    if (r.infRate>0){
      var add = r.infRate*dtm;
      r.central += add; r.cum += add;
      if (r.dir) for (var k in r.dir){
        if (k==='vol') sim.vol += r.dir[k]*add; else sim[k] += r.dir[k]*add;
      }
    }
    r.central *= Math.exp(-Math.LN2/r.t12*dtm);
    if (r.central<1e-7 && r.infRate===0 && r.depot<1e-7) sim.rx.splice(i,1);
  }
}

/* ── 靶点占据 → 生理轴 ───────────────────────── */

function computeAxes(sim){
  for (var a=0;a<AXES.length;a++) sim.axes[AXES[a]] = 0;
  var detail = {};
  for (var a2=0;a2<AXES.length;a2++) detail[AXES[a2]] = [];

  var blk = {};
  for (var i=0;i<sim.rx.length;i++){
    var r = sim.rx[i];
    var amt = r.central*(70/sim.wt);
    for (var t in r.ag){
      var p = r.ag[t], g = TG[t];
      if (!g) continue;
      var occ = amt>0 ? (amt/p)/(1+amt/p) : 0;
      for (var ax in g.g){
        var v = g.g[ax]*occ;
        sim.axes[ax] += v;
        detail[ax].push({d:r.name, t:TG[t].n, v:v});
      }
    }
    for (var t2 in r.ant){
      var p2 = r.ant[t2];
      var occ2 = amt>0 ? (amt/p2)/(1+amt/p2) : 0;
      blk[t2] = 1-(1-(blk[t2]||0))*(1-occ2);
    }
  }
  for (var t3 in blk){
    var g3 = TG[t3]; if (!g3) continue;
    var tone = TONE[t3]==null?0.3:TONE[t3];
    var dr = -blk[t3]*tone;
    if (t3==='NaK'){
      // 低钾、低镁、高钙都会加重强心苷毒性
      dr *= clamp(4.0/Math.max(2.4,sim.K), 0.8, 2.2);
    }
    for (var ax2 in g3.g){
      var v2 = g3.g[ax2]*dr;
      sim.axes[ax2] += v2;
      detail[ax2].push({d:'阻断 '+g3.n, t:g3.n, v:v2});
    }
  }
  for (var a3=0;a3<AXES.length;a3++){
    var key = AXES[a3];
    sim.axes[key] = clamp(sim.axes[key], -2.2, 2.2);
  }
  sim.axDetail = detail;
  sim.blk = blk;
  sim.respDrive = clamp(1 + sim.axes.respdrv + 2.4*(7.40-sim.pH), 0.08, 2.4);

  // 意识：镇静药拉低，缺氧、低灌注、高碳酸、低血糖、酸中毒也一起拉低
  var cnsT = sim.cns0 - sim.axes.cns;   // cns 轴是"抑制"，正值让意识下降
  cnsT -= clamp((sim.pCO2-55)/28, 0, 1.2)*0.90;
  cnsT -= clamp((7.30-sim.pH)/0.30, 0, 1.2)*0.55;
  cnsT -= clamp((3.5-sim.glu)/2.0, 0, 1.2)*0.70;
  cnsT -= clamp((55-sim.MAP)/40, 0, 1.2)*0.85;
  cnsT -= clamp((88-sim.SpO2)/30, 0, 1.2)*0.80;
  sim.cns = clamp(cnsT, 0, 1.2);
  if (sim.dead) sim.cns = 0;
}

/* ── 内在变异 ───────────────────────────────── */
// 没有这三个噪声，所有数字会精确地停在同一个值上，看着像死机
function vibeStep(sim, dt){
  sim.respPhase = (sim.respPhase + sim.RR/60*dt) % 1;
  var k = Math.min(1, dt/4);
  sim.noise  += (-sim.noise)*k*0.12 + (Math.random()-0.5)*0.07;
  sim.noise2 += (-sim.noise2)*k*0.12 + (Math.random()-0.5)*0.07;
  sim.noise3 += (-sim.noise3)*k*0.35 + (Math.random()-0.5)*0.11;
  sim.noise  = clamp(sim.noise, -2, 2);
  sim.noise2 = clamp(sim.noise2, -2, 2);
  sim.noise3 = clamp(sim.noise3, -2, 2);
}

/* ── 呼吸与酸碱 ─────────────────────────────── */

function respStep(sim, dt){
  // 肌松：呼吸肌一并麻痹，化学驱动再高也喘不动
  var nj = (sim.blk && sim.blk.NMJ) ? sim.blk.NMJ : 0;
  var njE = clamp(nj*1.5, 0, 1);          // 神经肌肉接头受体储备很大，占位七八成就全麻了
  var musc = 1 - 0.99*njE;
  var rd = clamp(1 + sim.axes.respdrv + 2.4*(7.40-sim.pH), 0.08, 2.4)*musc;
  sim.respDrive = rd;
  var rrT = sim.rr0*rd*(1+0.20*Math.max(0,(sim.lac-2)/6));
  // 呼吸本身不是节拍器，有慢一点的起伏
  rrT *= (1 + 0.045*Math.sin(sim.t*0.31) + 0.025*sim.noise2);
  if (sim.ops.vent) rrT = sim.ops.rrSet;
  rrT = clamp(rrT, 2, 46);
  sim.RR += (rrT-sim.RR)*Math.min(1, dt/8);

  var airwayR = clamp(sim.airway*(1+0.85*sim.axes.broncho), 0.30, 8);
  sim.airwayR = airwayR;
  var vt = 450*Math.sqrt(sim.compliance)*Math.pow(1/airwayR, 0.55);
  if (sim.ops.vent) vt = sim.ops.vtSet;
  var va = sim.RR*Math.max(20, vt-150)/1000;
  va = Math.max(va, 0.12);
  var co2prod = 200*(1+0.15*Math.max(0,sim.temp-37)+0.05*Math.max(0,sim.lac-2));
  var co2Eq = clamp(0.863*co2prod/va, 10, 160);
  sim.pCO2 += (co2Eq-sim.pCO2)*Math.min(1, dt/CFG.tauCO2);

  // 氧合。肺水与气道阻力是主要两个坑，通气不足另算
  var water = clamp((sim.vol-1.06)*2.4, 0, 1);
  var hypovent = clamp(1-(sim.RR/9), 0, 1);
  var o2 = (1/airwayR)*0.42 + 0.58;
  o2 *= (1-0.60*water);
  o2 *= (1-0.55*hypovent*(sim.ops.vent?0.2:1));
  o2 *= (1-0.12*Math.max(0,(1.16-sim.Ca))*4);
  if (sim.ops.vent) o2 = clamp(o2*(1-0.5*water*(1-sim.ops.fio2)) + 0.55*sim.ops.fio2, 0.1, 1.1);
  if (sim.ops.cpr>0) o2 *= 0.80;
  var pao2 = clamp(96*clamp(o2,0.05,1.08), 12, 105);
  sim.PaO2 += (pao2-sim.PaO2)*Math.min(1, dt/10);
  var n=2.7, p50=26.7;
  var sp = 100*Math.pow(sim.PaO2,n)/(Math.pow(sim.PaO2,n)+Math.pow(p50,n));
  sp += 0.25*sim.noise3;                       // 探头本身就在抖
  sim.SpO2 += (clamp(sp,5,100)-sim.SpO2)*Math.min(1, dt/10);

  var ph = 6.1 + Math.log10(clamp(sim.HCO3,2,45)/(0.03*Math.max(10,sim.pCO2)));
  sim.pH += (ph-sim.pH)*Math.min(1, dt/25);
  if (sim.lac>3) sim.HCO3 -= 0.010*(sim.lac-3)*dt/60;
  var comp = clamp(24+0.30*(sim.pCO2-40), 10, 38);
  sim.HCO3 += (comp-sim.HCO3)*Math.min(1, dt/60/45);
  sim.HCO3 = clamp(sim.HCO3, 2, 45);

  // 颅内压：目前只做了 CO₂ 反应性这一条通路，别的高级机制还没有
  var icpT = clamp(12 + 0.30*(sim.pCO2-40), 4, 48);
  sim.icp += (icpT-sim.icp)*Math.min(1, dt/90);
  // 呼末二氧化碳：肺通气越好越接近 PaCO₂，循环崩了会明显低于 PaCO₂
  var perfC = clamp((sim.CO||5)/5, 0.10, 1.05);
  sim.etco2 += (clamp(sim.pCO2*perfC - 2, 0, 95)-sim.etco2)*Math.min(1, dt/15);
}

/* ── 肾脏与电解质 ───────────────────────────── */

function renalStep(sim, dt){
  var dtm = dt/60;
  var press = clamp(sim.MAP/88, 0.12, 1.2);
  sim.gfr = clamp(sim.gfr0*press, 0.5, 130);

  var u = clamp(sim.gfr/100,0.01,1.3)*(1+1.6*Math.max(-0.6,sim.axes.urine))*clamp(sim.MAP/85,0.05,1.2);
  u = clamp(u, 0, 7);
  var urineT = 70*u*(sim.wt/70);
  sim.urine += (urineT-sim.urine)*Math.min(1, dt/30);
  sim.vol -= sim.urine/1000/(60*CFG.bloodVol)*dtm;   // ml/h → L/min
  sim.vol += 0.00020*dtm;
  sim.vol = clamp(sim.vol, 0.30, 2.0);

  var kRenal = CFG.kExcr*clamp(sim.gfr/100,0,1.3)*(1+CFG.kalGain*sim.axes.kal)*(sim.K/4.2);
  kRenal = Math.max(0, kRenal);
  var kShift = CFG.kShiftMax*sim.axes.kshift;
  var acidK = -CFG.acidK*(sim.pH-7.40);
  var ecf = 0.2*sim.wt;
  sim.K = clamp(sim.K + (CFG.kLoad - kRenal - kShift + acidK)/ecf*dtm, 1.2, 12);

  sim.Na += (-0.02*(sim.Na-140) - 0.05*sim.axes.naex)*dtm;
  sim.Na = clamp(sim.Na, 108, 168);
  sim.Ca += (-0.05*(sim.Ca-1.20) + 0.03*sim.axes.caex)*dtm;
  sim.Ca = clamp(sim.Ca, 0.40, 3.0);
  sim.Mg = clamp(sim.Mg + 0.02*(0.85-sim.Mg)*dtm, 0.2, 3);

  var crT = clamp(900/Math.max(8,sim.gfr), 40, 1200);
  sim.cr += (crT-sim.cr)*Math.min(1,dtm/30);
}

/* ── 血糖 ───────────────────────────────────── */

function gluStep(sim, dt){
  var dtm = dt/60;
  var insEndo = clamp((sim.glu-4.5)/4, 0, 1);
  var driveDown = Math.max(0, -sim.axes.gluc);          // 胰岛素类
  var driveUp = Math.max(0, sim.axes.gluc);             // 胰高血糖素、糖皮质激素、β₂
  var uptake = (driveDown*0.55 + insEndo*0.10)*(0.35+sim.glu/5);
  var dg = driveUp*0.45 - uptake - 0.10*(sim.glu-5.2);
  sim.glu = clamp(sim.glu + dg*dtm, 0.7, 42);
}

/* ── 循环 ───────────────────────────────────── */

function circStep(sim, dt){
  var dtm = dt/60;
  // 压力感受器反射：血压掉到哪儿，心率就补到哪儿
  var bb = (sim.blk && sim.blk.b1) ? sim.blk.b1 : 0;
  var bf = sim.mapRef ? clamp(1.3*(sim.mapRef-sim.MAP)/sim.mapRef, -0.50, 0.90)*(1-bb) : 0;
  var hrT = clamp(sim.hr0*(1+0.62*(sim.axes.chrono+bf)), 12, 220);
  if (sim.hrBase == null) sim.hrBase = sim.HR;
  sim.hrBase += (hrT-sim.hrBase)*Math.min(1, dt/CFG.tauHR);
  // 真实的心率不是一条直线：呼吸性窦性心律不齐 + 极低频起伏
  var rsa = Math.sin(sim.respPhase*Math.PI*2);
  sim.hrVar = 0.038*rsa + 0.010*sim.noise + 0.005*Math.sin(sim.t*0.63);
  sim.HR = clamp(sim.hrBase*(1+sim.hrVar), 10, 230);
  sim.SVR += (clamp(sim.svr0*(1+0.50*sim.axes.svr), 220, 4800)-sim.SVR)*Math.min(1, dt/CFG.tauSVR);

  sim.CVP = 2 + 6*sim.vol + 2.4*sim.axes.vcap;
  var v = sim.vol;
  var pre = v<=1 ? clamp(Math.pow(v,1.8), 0.10, 1.0)
                 : clamp(1 + 0.35*(v-1) - 0.90*(v-1)*(v-1), 0.20, 1.08);
  var aft = clamp(Math.pow(1400/sim.SVR, 0.5), 0.62, 1.30);
  var inoF = clamp(sim.ino0*(1+0.55*sim.axes.ino), 0.10, 2.8);
  var hrc = clamp(Math.sqrt(72/sim.HR), 0.75, 1.45);   // 慢心率时每搏量更大
  sim.SV = 70*(sim.wt/70)*(0.40+0.65*inoF)*pre*aft*hrc;
  sim.SV *= (1 - 0.032*rsa);                            // 吸气时回心血量少一点，血压跟着起伏

  // 心律本身决定泵血能力：正弦波几乎不产生有效心输出，室颤和停搏基本为零
  var perf = 1;
  if (sim.rhythm==='sine') perf = 0.45;
  if (sim.rhythm==='vf' || sim.rhythm==='asystole') perf = 0.05;
  sim.CO = clamp(sim.HR*sim.SV/1000, 0.3, 22)*perf;
  sim.MAP = clamp(sim.CO*sim.SVR/80, 8, 200);

  if (sim.ops.cpr>0){
    sim.MAP = Math.max(sim.MAP, 38+16*Math.min(1,sim.ops.cpr/90));
    sim.CO = Math.max(sim.CO, 2.0);
  }
  var ppMax = Math.max(6, 0.85*sim.MAP);
  var pp = clamp(46*(sim.SV/74)*Math.pow(1400/sim.SVR,0.35), 4, ppMax);
  sim.SBP = sim.MAP+pp/3;
  sim.DBP = Math.max(2, Math.min(sim.MAP-2*pp/3, sim.SBP-3));

  sim.DO2 = sim.CO*1.36*sim.hgb*sim.SpO2/100;
  var def = clamp((CFG.do2Crit-sim.DO2)/CFG.do2Crit, 0, 1.4);
  sim.lac += (CFG.lacRate*def - CFG.lacClear*Math.max(0,sim.lac-0.8))*dtm;
  sim.lac = clamp(sim.lac, 0.3, 22);
}

/* ── 心律与心电参数 ──────────────────────────── */

function rhythmStep(sim, dt){
  var dtm = dt/60;
  var K = sim.K, Ca = sim.Ca, pit = sim.pH;
  var avcF = clamp(1+sim.axes.avc, 0.05, 1.8);
  // 钙剂不降钾，但它稳定心肌膜，高钾的心电改变会被压下去一截
  var kEff = K*clamp(Math.pow(1.20/Math.max(1.20,Ca), 0.65), 0.76, 1.0);

  sim.pr  = clamp(150 + 11*Math.pow(Math.max(0,kEff-5.0),2) + 62*(1/avcF-1) + 120*Math.max(0,7.40-pit), 90, 560);
  sim.qrs = clamp(88 + 16*Math.pow(Math.max(0,kEff-5.2),1.4) + 240*sim.axes.qrs + 34*Math.max(0,1.16-Ca), 60, 340);
  var qtBase = clamp(400 + 240*(1.20-Ca) + 200*sim.axes.qt - 22*Math.max(0,K-5.5), 240, 700);
  sim.qt = qtBase*Math.sqrt(60/Math.max(30,sim.HR));
  sim.qtc = qtBase;
  sim.tamp = clamp(0.20 + 0.42*Math.max(0,K-4.6), 0.1, 1.05);
  sim.pamp = clamp(0.20*(1-0.22*Math.max(0,K-5.5)), 0.02, 0.22);
  sim.stSeg = clamp(-(pit-7.40)*170, -3.2, 3.2);
  sim.uWave = clamp((3.4-K)*0.35, 0, 0.65);

  var risk = 0;
  risk += Math.max(0, K-6.7)*0.028;
  risk += Math.max(0, K-7.8)*0.130;
  risk += Math.max(0, 7.35-pit)*0.060;
  risk += Math.max(0, 3.3-K)*0.050;
  risk += Math.max(0, sim.qtc-480)*0.0012;
  risk += Math.max(0, sim.qrs-160)*0.004;
  if (sim.SpO2<70) risk += (70-sim.SpO2)/70*0.04;
  risk += Math.max(0, 45-sim.HR)*0.0015;
  sim.riskRate = risk;

  if (sim.rhythm==='vf' || sim.rhythm==='asystole'){
    sim.vfT += dt;
    if (sim.rhythm==='vf' && sim.vfT>90){ sim.rhythm='asystole'; log(sim,'心律','室颤退化为停搏'); }
    return;
  }
  sim.arrh += risk*dtm;
  if (sim.arrh>1){
    sim.arrh = 0; sim.rhythm='vf'; sim.vfT=0;
    log(sim,'心律','自发室颤');
    return;
  }
  if (K>7.6 && sim.qrs>150){ sim.rhythm='sine'; return; }
  if (sim.pr>200 && sim.HR<52) sim.rhythm='avblock';
  else if (sim.HR<40) sim.rhythm='junctional';
  else if (sim.HR>125) sim.rhythm='tachy';
  else if (K<3.0) sim.rhythm='sinus';
  else sim.rhythm='sinus';
}

function shock(sim){
  if (sim.dead){ log(sim,'操作','电除颤 200J'); log(sim,'结果','病人已死亡，除颤无意义'); return; }
  log(sim,'操作','电除颤 200J');
  if (sim.rhythm==='vf'){
    if (Math.random()<0.78){ sim.rhythm='sinus'; sim.vfT=0; sim.arrh=0; log(sim,'结果','除颤成功，恢复心律'); }
    else log(sim,'结果','除颤未成功，继续按压');
  } else if (sim.rhythm==='sine'){
    if (Math.random()<0.2){ sim.rhythm='sinus'; log(sim,'结果','短暂恢复'); }
    else log(sim,'结果','无效：正弦波不能靠除颤解决');
  } else {
    log(sim,'结果','无效：当前节律不可除颤');
  }
}

function update(sim, dt){
  // 死亡以后只让时间继续走，心电图变成会滚动的直线
  if (sim.dead){
    sim.t += dt;
    if (sim.t-(sim._lastRec||0)>=1){ record(sim); sim._lastRec=sim.t; }
    return;
  }
  sim.t += dt;
  vibeStep(sim, dt);
  pkStep(sim, dt);
  computeAxes(sim);
  respStep(sim, dt);
  renalStep(sim, dt);
  gluStep(sim, dt);
  circStep(sim, dt);
  rhythmStep(sim, dt);
  checkDeath(sim, dt);
  if (sim.t-(sim._lastRec||0)>=1){ record(sim); sim._lastRec=sim.t; }
}

// 多久算死：停搏且没人按压 30 秒；有人按压也最多撑 4 分钟；平均压长时间在 16 以下
function checkDeath(sim, dt){
  if (sim.dead) return;
  if (sim.rhythm==='asystole') sim.flatT += dt; else sim.flatT = 0;
  if (sim.MAP < 16) sim.lowT += dt; else sim.lowT = 0;
  var lim = sim.ops.cpr>0 ? 240 : 30;
  if (sim.flatT > lim || sim.lowT > 45){
    sim.dead = true;
    sim.deathT = sim.t;
    sim.rhythm = 'asystole';
    sim.cns = 0;
    log(sim,'结局','病人死亡');
    record(sim);
  }
}

function record(sim){
  sim.hist.push({t:sim.t, HR:sim.HR, SBP:sim.SBP, DBP:sim.DBP, MAP:sim.MAP,
    SpO2:sim.SpO2, RR:sim.RR, K:sim.K, Na:sim.Na, Ca:sim.Ca, pH:sim.pH,
    HCO3:sim.HCO3, lac:sim.lac, glu:sim.glu, CO:sim.CO, pCO2:sim.pCO2, urine:sim.urine});
  if (sim.hist.length>5400) sim.hist.shift();
}

function log(sim, kind, msg){
  sim.log.push({t:sim.t, kind:kind, msg:msg});
  if (sim.log.length>600) sim.log.shift();
}

// 意识状态的统一说法，界面和脑电通道都用这一个
function stateText(sim){
  if (sim.dead || sim.cns < 0.10) return '无意识';
  var h = (sim.axes && sim.axes.halluc) || 0;
  var base = sim.cns>=0.90 ? '清醒' : sim.cns>=0.70 ? '嗜睡' : sim.cns>=0.45 ? '昏睡' : '昏迷';
  if (h > 0.35 && sim.cns >= 0.60) return base+'·致幻';
  return base;
}

LIFE.newSim = newSim;
LIFE.update = update;
LIFE.give = give;
LIFE.stopInf = stopInfusion;
LIFE.shock = shock;
LIFE.computeAxes = computeAxes;
LIFE.clamp = clamp;
LIFE.log = log;
LIFE.stateText = stateText;
LIFE.TONE = TONE;
LIFE.CFG = CFG;

if (typeof module!=='undefined' && module.exports) module.exports = LIFE;
