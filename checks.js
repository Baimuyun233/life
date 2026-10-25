/* 数据审计 + 回归自检。改知识库之后打开自检，红了就说明有东西被改坏了。 */

var CHECKS = (function(){

  function runSim(preset, secs, before){
    var s = LIFE.newSim(preset);
    if (before) before(s);
    var step = 0.25;
    for (var t=0; t<secs; t+=step) LIFE.update(s, step);
    return s;
  }

  var CASES = [
    {name:'健康人静息稳定', run:function(){ return runSim('healthy',90); },
     test:function(s){ return [
       ['HR 在 60~95', s.HR>60 && s.HR<95, s.HR.toFixed(0)],
       ['MAP 在 75~110', s.MAP>75 && s.MAP<110, s.MAP.toFixed(0)],
       ['SpO₂ > 94', s.SpO2>94, s.SpO2.toFixed(0)],
       ['血钾 3.6~4.8', s.K>3.6 && s.K<4.8, s.K.toFixed(2)]
     ];}},

    {name:'肾上腺素 0.1mg 升压', run:function(){ return runSim('healthy',120,function(s){LIFE.give(s,'epi',0.1,'iv');}); },
     test:function(s){ return [['MAP 比基线高 8 以上', s.MAP>101, s.MAP.toFixed(0)]]; }},

    {name:'普萘洛尔 5mg 降心率', run:function(){ return runSim('healthy',300,function(s){LIFE.give(s,'propr',5,'iv');}); },
     test:function(s){ return [['HR 低于 68', s.HR<68, s.HR.toFixed(0)]]; }},

    {name:'β 阻滞药用在 COPD 上加重', run:function(){
        var a = runSim('copd',300,function(s){LIFE.give(s,'propr',5,'iv');});
        var b = runSim('copd',300);
        a.baseSpO2 = b.SpO2; a.baseCO2 = b.pCO2; return a; },
     test:function(s){ return [
       ['SpO₂ 低于不放药时', s.SpO2 < s.baseSpO2-0.5, s.SpO2.toFixed(0)+' vs '+s.baseSpO2.toFixed(0)],
       ['CO₂ 高于不放药时', s.pCO2 > s.baseCO2+1, s.pCO2.toFixed(0)+' vs '+s.baseCO2.toFixed(0)]
     ];}},

    {name:'阿托品 1mg 提心率', run:function(){ return runSim('healthy',300,function(s){LIFE.give(s,'atro',1,'iv');}); },
     test:function(s){ return [['HR 高于 80', s.HR>80, s.HR.toFixed(0)]]; }},

    {name:'呋塞米 40mg 排钾利尿', run:function(){ return runSim('healthy',900,function(s){LIFE.give(s,'furo',40,'iv');}); },
     test:function(s){ return [
       ['血钾下降 0.1 以上', s.K<4.10, s.K.toFixed(2)],
       ['尿量上升', s.urine>90, s.urine.toFixed(0)]
     ];}},

    {name:'维拉帕米+美托洛尔 双重抑制', run:function(){
        return runSim('healthy',300,function(s){LIFE.give(s,'vera',10,'iv');LIFE.give(s,'meto',10,'iv');}); },
     test:function(s){ return [
       ['HR 低于 68', s.HR<68, s.HR.toFixed(0)],
       ['MAP 低于 88', s.MAP<88, s.MAP.toFixed(0)]
     ];}},

    {name:'高钾 20 分钟自然恶化', run:function(){ return runSim('ckd_hk',1200); },
     test:function(s){ return [
       ['血钾升到 7.8 以上', s.K>7.8, s.K.toFixed(2)],
       ['QRS 宽于 140', s.qrs>140, s.qrs.toFixed(0)]
     ];}},

    {name:'钙剂让高钾心电图变好但不降钾', run:function(){
        var s = runSim('ckd_hk',600,function(x){LIFE.give(x,'cagl',20,'iv');});
        var b = runSim('ckd_hk',600); s.noCa = b.qrs; s.noCaK = b.K; return s; },
     test:function(s){ return [
       ['QRS 比不用药窄 10 以上', s.qrs < s.noCa-10, s.qrs.toFixed(0)+' vs '+s.noCa.toFixed(0)],
       ['血钾没有因此下降', Math.abs(s.K-s.noCaK)<0.03, s.K.toFixed(2)+' vs '+s.noCaK.toFixed(2)]
     ];}},

    {name:'葡萄糖+胰岛素 降钾', run:function(){
        return runSim('ckd_hk',600,function(s){LIFE.give(s,'insu',10,'iv');LIFE.give(s,'g50',25,'iv');}); },
     test:function(s){ return [
       ['血钾比 7.65 低 0.4 以上', s.K<7.25, s.K.toFixed(2)],
       ['血糖没有掉到 3.0 以下', s.glu>3.0, s.glu.toFixed(1)]
     ];}},

    {name:'碳酸氢钠纠酸并轻微降钾', run:function(){
        return runSim('ckd_hk',600,function(s){LIFE.give(s,'nahco3',100,'iv');}); },
     test:function(s){ return [
       ['pH 升到 7.38 以上', s.pH>7.38, s.pH.toFixed(2)],
       ['血钾只小幅下降', s.K<7.62 && s.K>7.40, s.K.toFixed(2)]
     ];}},

    {name:'肾衰病人用呋塞米几乎排不动钾', run:function(){
        var s = runSim('ckd_hk',600,function(x){LIFE.give(x,'furo',80,'iv');});
        var b = runSim('ckd_hk',600); s.noDrugK = b.K; return s; },
     test:function(s){ return [
       ['血钾和不给药的差别不到 0.15', Math.abs(s.K-s.noDrugK)<0.15,
        s.K.toFixed(2)+' vs '+s.noDrugK.toFixed(2)]
     ];}},

    {name:'失血性休克补液升压', run:function(){ return runSim('hs',600,function(s){LIFE.give(s,'ns',1000,'iv');}); },
     test:function(s){ return [
       ['MAP 比 69 高 12 以上', s.MAP>81, s.MAP.toFixed(0)],
       ['乳酸开始下降', s.lac<5.4, s.lac.toFixed(1)]
     ];}},

    {name:'去甲肾上腺素在感染性休克升压', run:function(){
        return runSim('sepsis',600,function(s){LIFE.give(s,'norepi',0,'inf',0.05);}); },
     test:function(s){ return [['MAP 高于 70', s.MAP>70, s.MAP.toFixed(0)]]; }},

    {name:'氟哌啶醇延长 QTc', run:function(){ return runSim('healthy',600,function(s){LIFE.give(s,'halo',10,'iv');}); },
     test:function(s){ return [['QTc 延长 30ms 以上', s.qtc>430, s.qtc.toFixed(0)]]; }},

    {name:'硝酸甘油+西地那非 血压下降', run:function(){
        return runSim('healthy',120,function(s){LIFE.give(s,'sild',100,'po');LIFE.give(s,'ntg',0.5,'iv');}); },
     test:function(s){ return [
       ['SVR 低于 1200', s.SVR<1200, s.SVR.toFixed(0)],
       ['MAP 低于 88', s.MAP<88, s.MAP.toFixed(0)]
     ];}},

    {name:'吗啡抑制呼吸', run:function(){ return runSim('healthy',300,function(s){LIFE.give(s,'morph',10,'iv');}); },
     test:function(s){ return [
       ['呼吸频率下降', s.RR<14, s.RR.toFixed(0)],
       ['PaCO₂ 上升', s.pCO2>45, s.pCO2.toFixed(0)]
     ];}},

    {name:'丙泊酚让意识消失', run:function(){ return runSim('healthy',300,function(s){LIFE.give(s,'propof',60,'iv');}); },
     test:function(s){ return [
       ['意识水平掉到 0.5 以下', s.cns<0.5, s.cns.toFixed(2)],
       ['状态不是清醒', LIFE.stateText(s)!=='清醒', LIFE.stateText(s)]
     ];}},

    {name:'乙醇：镇静加血管扩张', run:function(){ return runSim('healthy',1800,function(s){LIFE.give(s,'eth',80,'po');}); },
     test:function(s){ return [
       ['意识下降', s.cns<0.7, s.cns.toFixed(2)],
       ['平均压下降', s.MAP<92, s.MAP.toFixed(0)],
       ['心率代偿性上升', s.HR>74, s.HR.toFixed(0)]
     ];}},

    {name:'尼古丁升心率升血压', run:function(){ return runSim('healthy',600,function(s){LIFE.give(s,'nico',1.5,'iv');}); },
     test:function(s){ return [
       ['心率高于 76', s.HR>76, s.HR.toFixed(0)],
       ['平均压高于 97', s.MAP>97, s.MAP.toFixed(0)]
     ];}},

    {name:'致幻剂：会致幻但不会把人放倒', run:function(){ return runSim('healthy',1800,function(s){LIFE.give(s,'lsd',150,'po');}); },
     test:function(s){ return [
       ['致幻轴升到 0.5 以上', (s.axes.halluc||0)>0.5, (s.axes.halluc||0).toFixed(2)],
       ['意识仍然清醒', s.cns>0.8, s.cns.toFixed(2)],
       ['呼吸不受抑制', s.RR>13, s.RR.toFixed(0)]
     ];}},

    {name:'氯胺酮：分离麻醉', run:function(){ return runSim('healthy',600,function(s){LIFE.give(s,'keta',150,'iv');}); },
     test:function(s){ return [
       ['致幻轴明显升高', (s.axes.halluc||0)>0.35, (s.axes.halluc||0).toFixed(2)]
     ];}},

    {name:'肌松药让呼吸停掉', run:function(){ return runSim('healthy',300,function(s){LIFE.give(s,'rocu',50,'iv');}); },
     test:function(s){ return [
       ['呼吸频率掉到 5 以下', s.RR<5, s.RR.toFixed(1)],
       ['PaCO₂ 明显升高', s.pCO2>70, s.pCO2.toFixed(0)]
     ];}},

    {name:'肌松药配合呼吸机就没事', run:function(){
        return runSim('healthy',600,function(s){LIFE.give(s,'rocu',50,'iv'); s.ops.vent=1;}); },
     test:function(s){ return [
       ['PaCO₂ 维持正常', s.pCO2<50, s.pCO2.toFixed(0)],
       ['意识保留（这正是肌松未镇静的场面）', s.cns>0.8, s.cns.toFixed(2)]
     ];}},

    {name:'死亡后意识归零', run:function(){ return runSim('healthy',600,function(s){LIFE.give(s,'kcl',30,'iv');}); },
     test:function(s){ return [
       ['确实死了', s.dead===true, String(s.dead)],
       ['意识是 0', s.cns===0, s.cns.toFixed(2)]
     ];}},
  ];

  function selfTest(){
    var rows = [];
    for (var i=0;i<CASES.length;i++){
      var c = CASES[i], out;
      try {
        var s = c.run();
        out = c.test(s);
      } catch(e){
        rows.push({name:c.name, items:[['运行异常', false, String(e.message||e)]]});
        continue;
      }
      var items = out.map(function(x){ return {t:x[0], ok:!!x[1], v:x[2]}; });
      rows.push({name:c.name, items:items});
    }
    var pass = 0, total = 0;
    rows.forEach(function(r){ r.items.forEach(function(it){ total++; if (it.ok) pass++; }); });
    return {rows:rows, pass:pass, total:total};
  }

  function audit(){
    var missing = [], targetBad = [], noDose = [], lowConf = [];
    var ids = {};
    DRUGS.forEach(function(d){
      if (ids[d.id]) missing.push({name:d.name, why:'id 重复：'+d.id});
      ids[d.id] = 1;
      if (!d.conf || !d.src) missing.push({name:d.name, why:'缺 conf 或 src'});
      if (!d.unit) missing.push({name:d.name, why:'缺单位'});
      if (!d.dose || d.dose.length!==2 || d.dose[0]>=d.dose[1]) noDose.push(d.name);
      if (d.conf==='C') lowConf.push(d.name);
      var tg = {};
      for (var a in (d.ag||{})) tg[a]=1;
      for (var b in (d.ant||{})) tg[b]=1;
      for (var t in tg) if (!TG[t]) targetBad.push(d.name+' → '+t);
      if (!d.ag && !d.ant && !d.dir) missing.push({name:d.name, why:'既没有靶点也没有直接效应'});
    });
    var catCount = {};
    DRUGS.forEach(function(d){ catCount[d.cat]=(catCount[d.cat]||0)+1; });

    // 靶点没有被任何药使用，说明这个靶点目前是空槽
    var used = {};
    DRUGS.forEach(function(d){
      for (var a in (d.ag||{})) used[a]=1;
      for (var b in (d.ant||{})) used[b]=1;
    });
    var unused = [];
    for (var t in TG) if (!used[t]) unused.push(TG[t].n);

    return {
      total: DRUGS.length, cats: catCount,
      missing: missing, targetBad: targetBad, noDose: noDose,
      lowConf: lowConf, unused: unused
    };
  }

  return {selfTest:selfTest, audit:audit, runSim:runSim};
})();
