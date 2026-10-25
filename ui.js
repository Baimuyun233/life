/* 界面。所有数值都来自 engine，这里只负责显示和把操作转发过去。 */

(function(){
  var sim = null, speed = 1, selDrug = null, lastT = 0;
  var trendVars = [
    {k:'MAP', c:'#ff7070'}, {k:'HR', c:'#5aa9ff'},
    {k:'K',   c:'#ffd166'}, {k:'SpO2', c:'#31f0a0'}
  ];
  var LOGMAX = 160;

  var $ = function(id){ return document.getElementById(id); };
  function fmt(v, d){ return (v==null||isNaN(v)) ? '—' : Number(v).toFixed(d==null?0:d); }
  function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; }); }

  /* ── 数值砖 ─────────────────────────────── */
  var TILES = [
    {key:'HR',   lab:'心率',   unit:'bpm', g:function(s){
        if (s.rhythm==='vf'||s.rhythm==='asystole') return '—';
        return s.HR; }, d:0, lo:60, hi:100, axis:'chrono'},
    {key:'BP',   lab:'血压',   unit:'mmHg',g:function(s){return fmt(s.SBP,0)+'/'+fmt(s.DBP,0);}, raw:true, lo:90, hi:160, axis:'svr'},
    {key:'MAP',  lab:'平均压', unit:'mmHg',g:function(s){return s.MAP;}, d:0, lo:65, hi:105, axis:'svr'},
    {key:'CO',   lab:'心输出量',unit:'L/min',g:function(s){return s.CO;}, d:2, lo:4, hi:8, axis:'ino'},
    {key:'SVR',  lab:'外周阻力',unit:'dyn·s·cm⁻⁵',g:function(s){return s.SVR;}, d:0, lo:800, hi:1700, axis:'svr'},
    {key:'CVP',  lab:'中心静脉压',unit:'mmHg',g:function(s){return s.CVP;}, d:1, lo:4, hi:10, axis:'vcap'},
    {key:'SpO2', lab:'血氧',   unit:'%',   g:function(s){return s.SpO2;}, d:0, lo:92, hi:101, axis:'resp'},
    {key:'RR',   lab:'呼吸',   unit:'/min',g:function(s){return s.RR;},  d:0, lo:12, hi:20, axis:'respdrv'},
    {key:'pCO2', lab:'PaCO₂',  unit:'mmHg',g:function(s){return s.pCO2;},d:0, lo:35, hi:45, axis:'respdrv'},
    {key:'TEMP', lab:'体温',   unit:'℃',   g:function(s){return s.temp;},d:1, lo:36, hi:37.5, axis:null},
    {key:'CNS',  lab:'意识',   unit:'',    g:function(s){ return LIFE.stateText(s); }, raw:true, lo:0, hi:1, axis:'cns', cns:true},
    {key:'UO',   lab:'尿量',   unit:'ml/h',g:function(s){return s.urine;},d:0, lo:30, hi:400, axis:'urine'},

    {key:'K',    lab:'血钾',   unit:'mmol/L',g:function(s){return s.K;}, d:2, lo:3.5, hi:5.2, axis:'kal'},
    {key:'Na',   lab:'血钠',   unit:'mmol/L',g:function(s){return s.Na;},d:0, lo:135, hi:145, axis:'naex'},
    {key:'Ca',   lab:'血钙',   unit:'mmol/L',g:function(s){return s.Ca;},d:2, lo:1.10, hi:1.30, axis:'caex'},
    {key:'Mg',   lab:'血镁',   unit:'mmol/L',g:function(s){return s.Mg;},d:2, lo:0.70, hi:1.00, axis:null},
    {key:'HCO3', lab:'HCO₃⁻', unit:'mmol/L',g:function(s){return s.HCO3;},d:0, lo:22, hi:27, axis:null},
    {key:'pH',   lab:'pH',     unit:'',    g:function(s){return s.pH;},  d:2, lo:7.35, hi:7.45, axis:null, ph:true},
    {key:'LAC',  lab:'乳酸',   unit:'mmol/L',g:function(s){return s.lac;},d:1, lo:0, hi:2.0, axis:'do2'},
    {key:'GLU',  lab:'血糖',   unit:'mmol/L',g:function(s){return s.glu;},d:1, lo:3.9, hi:7.0, axis:'gluc'},
    {key:'HGB',  lab:'血红蛋白',unit:'g/L', g:function(s){return s.hgb;},d:0, lo:110, hi:165, axis:null},
    {key:'CR',   lab:'肌酐',   unit:'μmol/L',g:function(s){return s.cr;}, d:0, lo:40, hi:110, axis:null},
    {key:'DO2',  lab:'氧输送', unit:'ml/min',g:function(s){return s.DO2;},d:0, lo:600, hi:1400, axis:'do2'},
    {key:'AG',   lab:'阴离子间隙',unit:'', g:function(s){return s.Na-(s.HCO3+103);}, d:0, lo:8, hi:16, axis:null, ag:true}
  ];

  var tileEls = {};

  function buildTiles(){
    var v = $('vitals'), l = $('labs');
    v.innerHTML = ''; l.innerHTML = '';
    TILES.forEach(function(t, i){
      var el = document.createElement('div');
      el.className = 'tile';
      el.innerHTML = '<div class="k">'+t.lab+'</div><div class="v num"><span class="val">—</span><span class="u">'+t.unit+'</span></div>';
      el.onclick = function(){ explainTile(t); };
      (i<12 ? v : l).appendChild(el);
      tileEls[t.key] = el;
    });
  }

  function tileAbnormal(t, s){
    if (t.ph){ return s.pH<7.35 || s.pH>7.45; }
    if (t.cns){ return s.cns<0.7; }
    if (t.key==='BP'){ return s.SBP<90 || s.SBP>170; }
    var v = t.g(s);
    if (typeof v !== 'number') return false;
    return v < t.lo || v > t.hi;
  }

  function renderTiles(){
    TILES.forEach(function(t){
      var el = tileEls[t.key]; if (!el) return;
      var val = t.g(sim);
      var txt = (typeof val === 'number') ? fmt(val, t.d) : val;
      el.querySelector('.val').textContent = txt;
      var u = el.querySelector('.u');
      if (u) u.style.display = (txt==='—') ? 'none' : 'inline';
      var bad = tileAbnormal(t, sim);
      el.classList.toggle('bad', bad && !(t.key==='RR' && typeof val==='number' && val>20));
      el.classList.toggle('warn', bad && (t.key==='RR' && typeof val==='number' && val>20));
    });
  }

  /* ── 机制解释 ───────────────────────────── */
  function explainTile(t){
    var rows = [];
    var axes = t.axis ? [t.axis] : [];
    if (t.key==='MAP' || t.key==='BP') axes = ['svr','ino','chrono','vcap'];
    if (t.key==='CO') axes = ['ino','chrono','svr','vcap'];

    if (axes.length){
      axes.forEach(function(ax){
        var d = (sim.axDetail && sim.axDetail[ax]) || [];
        if (!d.length) return;
        var srt = d.slice().sort(function(a,b){ return Math.abs(b.v)-Math.abs(a.v); }).slice(0,7);
        var html = '<tr><td colspan="3" style="color:#9dffd4;padding-top:8px">'+
          (AXIS_N[ax]||ax)+'　合计 '+fmt(sim.axes[ax],2)+'</td></tr>';
        srt.forEach(function(x){
          html += '<tr><td>'+esc(x.d)+'</td><td style="color:#587084">'+esc(x.t)+'</td>'+
                  '<td class="num" style="color:'+(x.v>0?'#ff8f8f':'#7fd0ff')+'">'+
                  (x.v>0?'+':'')+x.v.toFixed(2)+'</td></tr>';
        });
        rows.push(html);
      });
    }

    var extra = [];
    if (t.key==='pH' || t.key==='HCO3') extra.push('pH 由 Henderson–Hasselbalch 算出：pH = 6.1 + log₁₀(HCO₃⁻ ÷ 0.03×PaCO₂)。HCO₃⁻ 靠肾脏慢代偿和补碱改变，PaCO₂ 靠通气改变。');
    if (t.key==='LAC' || t.key==='DO2') extra.push('氧输送 DO₂ = CO × 1.36 × Hb × SaO₂ × 10。DO₂ 掉到约 330 ml/min 以下，乳酸开始堆积；循环恢复后乳酸按半程自行清除。');
    if (t.key==='AG') extra.push('本版阴离子间隙按 Na⁺ − (HCO₃⁻ + 12) 粗算，只用于看趋势，不参与其他计算。');
    if (t.key==='TEMP' || t.key==='HGB' || t.key==='CR') extra.push('这个量目前只做显示与慢变化跟踪，不反向驱动其他通路。');
    if (t.key==='SpO2' || t.key==='RR' || t.key==='pCO2') extra.push('通气量 = 呼吸频率 ×（潮气量 − 死腔），潮气量受气道阻力与肺顺应性影响。PaCO₂ 与每分通气量成反比，氧合另受肺水、气道阻力和通气不足三重影响。');

    var body = '<table>'+(rows.join('') || '<tr><td style="color:#6b7c8f">这个指标没有药物靶点直接作用于它。</td></tr>')+'</table>';
    if (extra.length) body += '<p style="color:#8fa3b6;font-size:12px;margin:10px 0 0">'+extra.join('<br><br>')+'</p>';
    openModal(t.lab+'　'+fmt(t.g(sim), t.d)+' '+t.unit, body);
  }

  /* ── 药房 ───────────────────────────────── */
  function buildCats(){
    var cats = [];
    DRUGS.forEach(function(d){ if (cats.indexOf(d.cat)<0) cats.push(d.cat); });
    var sel = $('catSel');
    sel.innerHTML = '<option value="">全部</option>' + cats.map(function(c){
      return '<option value="'+c+'">'+c+'</option>';
    }).join('');
  }

  function renderDrugList(){
    var q = $('drugSearch').value.trim().toLowerCase();
    var cat = $('catSel').value;
    var html = '';
    DRUGS.forEach(function(d){
      if (cat && d.cat!==cat) return;
      if (q && d.name.toLowerCase().indexOf(q)<0 && d.id.indexOf(q)<0) return;
      html += '<div class="drug'+(d.id===selDrug?' sel':'')+'" data-id="'+d.id+'">'+
        '<div class="n"><span>'+esc(d.name)+'</span>'+
        '<span class="cf '+d.conf+'" title="'+esc(d.src||'')+'">'+d.conf+'</span></div>'+
        '<div class="cn">'+esc(d.cat)+'　'+d.unit+'</div></div>';
    });
    $('drugList').innerHTML = html || '<div class="hint" style="padding:8px">没有匹配的药</div>';
    Array.prototype.forEach.call($('drugList').querySelectorAll('.drug'), function(el){
      el.onclick = function(){ openDrug(el.getAttribute('data-id')); };
    });
  }

  function openDrug(id){
    selDrug = id;
    var d = LIFE.drugs[id];
    renderDrugList();
    var p = $('drugPanel');
    p.className = 'show';
    var doseMid = (d.dose[0]+d.dose[1])/2;
    var routes = d.routes || ['iv'];
    var h = '<div class="row" style="justify-content:space-between">'+
      '<b style="color:#cfe6f6">'+esc(d.name)+'</b>'+
      '<span class="cf '+d.conf+'">'+d.conf+' · '+esc(d.src||'')+'</span></div>';

    h += '<div class="row"><span>剂量</span>'+
      '<input id="doseIn" type="number" class="num" style="width:78px" value="'+doseMid+
      '" min="'+d.dose[0]+'" max="'+d.dose[1]+'" step="'+d.step+'">'+
      '<span>'+d.unit+'　范围 '+d.dose[0]+'~'+d.dose[1]+'</span></div>';

    if (d.inf){
      h += '<div class="row"><span>泵入</span>'+
        '<input id="rateIn" type="number" class="num" style="width:78px" value="'+d.inf[0]+
        '" min="'+d.inf[0]+'" max="'+d.inf[1]+'" step="'+((d.inf[1]-d.inf[0])/10).toFixed(3)+'">'+
        '<span>'+d.unit+'/min　'+d.inf[0]+'~'+d.inf[1]+'</span>'+
        '<button id="btnPump">开始泵入</button></div>';
    }
    h += '<div class="row">';
    routes.forEach(function(r){
      h += '<button class="routeBtn" data-r="'+r+'">'+routeName(r)+'</button>';
    });
    h += '</div>';

    var tg = [];
    for (var a in (d.ag||{})) tg.push(TG[a].n+'(激动)');
    for (var b in (d.ant||{})) tg.push(TG[b].n+'(阻断)');
    if (d.dir) for (var c in d.dir) tg.push('直接改变'+c);
    h += '<div class="hint" style="margin-top:2px">'+tg.join('　')+'</div>';

    p.innerHTML = h;
    var dose = function(){ return Number($('doseIn').value)||d.dose[0]; };
    Array.prototype.forEach.call(p.querySelectorAll('.routeBtn'), function(b){
      b.onclick = function(){
        var r = b.getAttribute('data-r');
        if (r==='inf'){ startPump(d, Number($('rateIn').value)||d.inf[0]); return; }
        LIFE.give(sim, d.id, dose(), r);
        renderRx(); renderLog();
      };
    });
    if ($('btnPump')) $('btnPump').onclick = function(){
      startPump(d, Number($('rateIn').value)||d.inf[0]);
    };
  }

  function startPump(d, rate){
    LIFE.give(sim, d.id, 0, 'inf', rate);
    renderRx(); renderLog();
  }

  function routeName(r){
    return {iv:'静推', inf:'持续泵入', po:'口服', im:'肌注', sl:'舌下', inh:'吸入'}[r] || r;
  }

  function renderRx(){
    var h = '';
    sim.rx.forEach(function(r, i){
      var amt = r.central>0.001 ? r.central.toFixed(r.central>10?0:2)+' '+r.unit : '—';
      h += '<div class="rx"><b>'+esc(r.name)+'</b><span class="c">'+amt+
        (r.infRate>0?'　'+r.infRate+'/min':'　'+routeName(r.route))+'</span>'+
        (r.infRate>0 ? '<button data-i="'+i+'" class="stopBtn">停</button>' : '')+'</div>';
    });
    $('rxList').innerHTML = h || '<div class="hint">空</div>';
    Array.prototype.forEach.call($('rxList').querySelectorAll('.stopBtn'), function(b){
      b.onclick = function(){ LIFE.stopInf(sim, Number(b.getAttribute('data-i'))); renderRx(); };
    });
  }

  /* ── 趋势图 ─────────────────────────────── */
  var TREND_ALL = ['MAP','SBP','DBP','HR','K','Na','Ca','pH','HCO3','lac','glu','SpO2','CO','pCO2','urine'];
  function buildTrendChips(){
    $('trendSel').innerHTML = TREND_ALL.map(function(k){
      var on = trendVars.some(function(t){ return t.k===k; });
      return '<b data-k="'+k+'" class="'+(on?'on':'')+'">'+k+'</b>';
    }).join('');
    Array.prototype.forEach.call($('trendSel').querySelectorAll('b'), function(el){
      el.onclick = function(){
        var k = el.getAttribute('data-k');
        var idx = -1;
        trendVars.forEach(function(t,i){ if (t.k===k) idx=i; });
        if (idx>=0) trendVars.splice(idx,1);
        else if (trendVars.length<5) trendVars.push({k:k, c:'#c9a6ff'});
        if (trendVars.length===0) trendVars.push({k:'MAP', c:'#ff7070'});
        buildTrendChips(); drawTrend();
      };
    });
  }

  var tcv, tctx;
  // 固定纵轴范围。自动缩放会把 0.01 的变化画成一座山，看着像出事了其实没事。
  var TREND_RANGE = {
    MAP:[30,170], SBP:[40,230], DBP:[15,140], HR:[15,200], K:[1.5,9.5],
    Na:[110,165], Ca:[0.5,2.2], pH:[6.9,7.75], HCO3:[3,40], lac:[0,16],
    glu:[0.5,26], SpO2:[45,101], CO:[0.2,13], pCO2:[8,115], urine:[0,320]
  };

  function drawTrend(){
    if (!tcv){ tcv = $('trendCv'); tctx = tcv.getContext('2d'); }
    var dpr = window.devicePixelRatio||1;
    var r = tcv.getBoundingClientRect();
    var W = r.width|0, H = r.height|0;
    if (tcv.width !== W*dpr){ tcv.width = W*dpr; tcv.height = H*dpr; }
    tctx.setTransform(dpr,0,0,dpr,0,0);
    tctx.fillStyle = '#0a0e13'; tctx.fillRect(0,0,W,H);

    var h = sim.hist;
    var N = Math.min(h.length, 600);
    var s0 = h.length-N;
    tctx.strokeStyle = '#141c24'; tctx.beginPath();
    for (var i=1;i<4;i++){ var y=H*i/4; tctx.moveTo(0,y+.5); tctx.lineTo(W,y+.5); }
    tctx.stroke();

    if (N<2){ return; }
    var padT = 16, padB = 4;
    trendVars.forEach(function(tv){
      var mn, mx;
      var fix = TREND_RANGE[tv.k];
      if (fix){ mn = fix[0]; mx = fix[1]; }
      else {
        mn = Infinity; mx = -Infinity;
        for (var i=s0;i<h.length;i++){
          var v0 = h[i][tv.k];
          if (v0<mn) mn=v0; if (v0>mx) mx=v0;
        }
        if (!isFinite(mn)) return;
        if (mx-mn < 1e-6){ mx = mn+1; mn = mn-1; }
        var pd = (mx-mn)*0.12; mn-=pd; mx+=pd;
      }
      tctx.strokeStyle = tv.c; tctx.lineWidth = 1.6;
      tctx.beginPath();
      for (var i2=s0;i2<h.length;i2++){
        var v2 = h[i2][tv.k];
        var x = (i2-s0)/(N-1)*W;
        var y = padT + (1-(v2-mn)/(mx-mn))*(H-padT-padB);
        y = Math.max(padT, Math.min(H-padB, y));
        if (i2===s0) tctx.moveTo(x,y); else tctx.lineTo(x,y);
      }
      tctx.stroke();
    });

    // 图例
    var lx = 8;
    var legendY = H-5;
    tctx.font = '10px Consolas, monospace';
    trendVars.forEach(function(tv){
      var v = sim[tv.k]!==undefined ? sim[tv.k] : (sim.hist.length?sim.hist[sim.hist.length-1][tv.k]:0);
      var label = tv.k+' '+fmt(v, v>100?0:1);
      tctx.fillStyle = tv.c;
      tctx.fillRect(lx, legendY-7, 6, 6);
      tctx.fillStyle = '#9fb3c6';
      tctx.fillText(label, lx+10, legendY);
      lx += tctx.measureText(label).width + 22;
    });
  }

  /* ── 日志 ───────────────────────────────── */
  function renderLog(){
    var h = '';
    var arr = sim.log.slice(-LOGMAX).reverse();
    arr.forEach(function(e){
      h += '<div class="lg"><span class="t">'+clockStr(e.t)+'</span>'+
        '<span class="k">'+esc(e.kind)+'</span><span class="m">'+esc(e.msg)+'</span></div>';
    });
    $('log').innerHTML = h || '<div class="hint">还没有操作</div>';
  }

  function clockStr(t){
    var m = Math.floor(t/60), s = Math.floor(t%60);
    return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
  }

  /* ── 危急值告警 ─────────────────────────── */
  var ALARMS = [
    {id:'vf',   p:100, on:function(s){return s.rhythm==='vf';},      txt:function(){return '<b>心室颤动</b>　立即除颤';}},
    {id:'asys', p:100, on:function(s){return s.rhythm==='asystole'&&!s.dead;}, txt:function(){return '<b>心室停搏</b>　开始按压';}},
    {id:'sine', p:96,  on:function(s){return s.rhythm==='sine';},    txt:function(s){return '<b>高钾正弦波</b>　血钾 '+fmt(s.K,2);}},
    {id:'khi',  p:90,  on:function(s){return s.K>6.5;},  txt:function(s){return '高钾　<b>'+fmt(s.K,2)+'</b> mmol/L';}},
    {id:'klo',  p:86,  on:function(s){return s.K<2.8;},  txt:function(s){return '低钾　<b>'+fmt(s.K,2)+'</b> mmol/L';}},
    {id:'spo2', p:88,  on:function(s){return s.SpO2<88;}, txt:function(s){return '血氧　<b>'+fmt(s.SpO2,0)+'</b> %';}},
    {id:'map',  p:80,  on:function(s){return s.MAP<55;}, txt:function(s){return '平均压　<b>'+fmt(s.MAP,0)+'</b> mmHg';}},
    {id:'hrlo', p:76,  on:function(s){return s.HR<40;},  txt:function(s){return '心动过缓　<b>'+fmt(s.HR,0)+'</b> /min';}},
    {id:'ph',   p:72,  on:function(s){return s.pH<7.20 || s.pH>7.55;}, txt:function(s){return 'pH　<b>'+fmt(s.pH,2)+'</b>';}},
    {id:'maphi',p:68,  on:function(s){return s.MAP>140;}, txt:function(s){return '平均压　<b>'+fmt(s.MAP,0)+'</b> mmHg';}},
    {id:'glulo',p:66,  on:function(s){return s.glu<3.0;},txt:function(s){return '低血糖　<b>'+fmt(s.glu,1)+'</b> mmol/L';}},
    {id:'lac',  p:60,  on:function(s){return s.lac>6;},  txt:function(s){return '乳酸　<b>'+fmt(s.lac,1)+'</b> mmol/L';}},
    {id:'hco3', p:58,  on:function(s){return s.HCO3<12;},txt:function(s){return 'HCO₃⁻　<b>'+fmt(s.HCO3,0)+'</b> mmol/L';}},
    {id:'hrhi', p:55,  on:function(s){return s.HR>150;}, txt:function(s){return '心动过速　<b>'+fmt(s.HR,0)+'</b> /min';}},
    {id:'gluhi',p:50,  on:function(s){return s.glu>22;}, txt:function(s){return '血糖　<b>'+fmt(s.glu,1)+'</b> mmol/L';}},
    {id:'temp', p:45,  on:function(s){return s.temp>39.5||s.temp<35;}, txt:function(s){return '体温　<b>'+fmt(s.temp,1)+'</b> ℃';}},
    {id:'hgb',  p:42,  on:function(s){return s.hgb<60;}, txt:function(s){return '血红蛋白　<b>'+fmt(s.hgb,0)+'</b> g/L';}},
    {id:'cvp',  p:40,  on:function(s){return s.CVP>18;}, txt:function(s){return '中心静脉压　<b>'+fmt(s.CVP,1)+'</b> mmHg';}},
    {id:'avb',  p:36,  on:function(s){return s.rhythm==='avblock';}, txt:function(s){return '房室传导阻滞　PR '+fmt(s.pr,0)+'ms';}}
  ];
  var alarmEls = {};

  function renderAlarms(){
    var list = [];
    for (var i=0;i<ALARMS.length;i++){
      var a = ALARMS[i];
      if (a.on(sim)) list.push(a);
    }
    list.sort(function(x,y){ return y.p-x.p; });
    list = list.slice(0,4);

    var key = list.map(function(a){ return a.id; }).join(',');
    var box = $('alarms');
    if (key !== renderAlarms._key){
      var old = (renderAlarms._key||'').split(',');
      renderAlarms._key = key;
      box.innerHTML = '';
      alarmEls = {};
      for (var j=0;j<list.length;j++){
        var el = document.createElement('div');
        el.className = 'alarm' + (list[j].p>=70 ? '' : ' amber');
        el.innerHTML = list[j].txt(sim);
        box.appendChild(el);
        alarmEls[list[j].id] = el;
        if (old.indexOf(list[j].id) < 0) pushToast(list[j]);
      }
    } else {
      for (var k=0;k<list.length;k++){
        var e2 = alarmEls[list[k].id];
        if (e2) e2.innerHTML = list[k].txt(sim);
      }
    }
  }

  // 新冒出来的危急值额外弹一下，8 秒自己消失
  function pushToast(a){
    var box = $('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (a.p>=70 ? '' : ' amber');
    el.innerHTML = a.txt(sim);
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function(){ if (el.parentNode) el.remove(); }, 8000);
  }

  function clearAlarms(){
    $('alarms').innerHTML = '';
    $('toasts').innerHTML = '';
    alarmEls = {};
    renderAlarms._key = '';
  }

  /* ── 心律显示 ───────────────────────────── */
  var RH = {sinus:'窦性心律', tachy:'窦性心动过速', junctional:'交界性心律',
            avblock:'房室传导阻滞', sine:'高钾正弦波', vf:'心室颤动', asystole:'心室停搏'};

  function setSpeed(v){
    speed = v;
    Array.prototype.forEach.call(document.querySelectorAll('#spdBtns button'), function(x){
      x.classList.toggle('on', Number(x.getAttribute('data-v'))===v);
    });
    renderHead();
  }

  function renderHead(){
    $('clock').textContent = clockStr(sim.t);
    $('rhythmName').textContent = (sim.dead ? '无生命体征' : (RH[sim.rhythm] || sim.rhythm));
    var col = sim.dead ? '#ff5c5c'
            : (sim.rhythm==='vf'||sim.rhythm==='asystole') ? '#ff5c5c'
            : (sim.rhythm==='sine'||sim.rhythm==='avblock') ? '#ffb347' : '#9dffd4';
    $('rhythmName').style.color = col;
    $('ecgright').innerHTML = 'QRS '+fmt(sim.qrs,0)+'ms　QTc '+fmt(sim.qtc,0)+
      'ms　PR '+fmt(sim.pr,0)+'ms';
    $('paused').style.display = (speed===0 && !sim.dead) ? 'block' : 'none';

    if (sim.dead){
      $('deathmask').className = 'show';
      $('deathT').textContent = '死亡时间 '+clockStr(sim.deathT||sim.t);
    } else {
      $('deathmask').className = '';
    }
  }

  /* ── 弹窗 ───────────────────────────────── */
  function openModal(title, body){
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = body;
    $('modal').className = 'show';
  }
  $('modalClose').onclick = function(){ $('modal').className = ''; };
  $('modal').onclick = function(e){ if (e.target===$('modal')) $('modal').className=''; };

  /* ── 待补清单与自检 ─────────────────────── */
  function showAudit(){
    var a = CHECKS.audit();
    var h = '<p style="color:#8fa3b6;font-size:12px;margin:0 0 8px">'+
      '共 '+a.total+' 条药物数据。每条都要有来源和置信度，缺了会列在下面。</p>';
    h += '<table><tr><th>类别</th><th>数量</th></tr>';
    for (var c in a.cats) h += '<tr><td>'+esc(c)+'</td><td class="num">'+a.cats[c]+'</td></tr>';
    h += '</table>';

    function list(title, arr, cls){
      if (!arr.length) return '<h3 style="font-size:13px;margin-top:12px">'+title+'　<span class="ok">无</span></h3>';
      return '<h3 style="font-size:13px;margin-top:12px">'+title+'　<span class="no">'+arr.length+'</span></h3>'+
        '<div style="font-size:12px;color:#9fb3c6">'+arr.map(function(x){
          return esc(typeof x==='string'?x:(x.name+'：'+x.why)); }).join('、')+'</div>';
    }
    h += list('缺字段', a.missing);
    h += list('靶点写错', a.targetBad);
    h += list('剂量范围有问题', a.noDose);
    h += list('只有定性参数的药（C 级）', a.lowConf);
    h += list('目前还没有药触碰的靶点', a.unused);
    openModal('待补清单', h);
  }

  function showCheck(){
    var r = CHECKS.selfTest();
    var h = '<p style="font-size:12px;color:'+(r.pass===r.total?'#4cd48a':'#ff6b6b')+';margin:0 0 10px">'+
      r.pass+' / '+r.total+' 项通过</p>';
    r.rows.forEach(function(row){
      h += '<h3 style="font-size:12.5px;margin:10px 0 3px">'+esc(row.name)+'</h3><table>';
      row.items.forEach(function(it){
        h += '<tr><td style="width:26px" class="'+(it.ok?'ok':'no')+'">'+(it.ok?'✓':'✗')+'</td>'+
             '<td>'+esc(it.t)+'</td><td class="num" style="color:#7d8fa2;width:120px">'+esc(it.v||'')+'</td></tr>';
      });
      h += '</table>';
    });
    openModal('回归自检', h);
  }

  /* ── 存档 / 导出 ────────────────────────── */
  function download(name, text, mime){
    var blob = new Blob([text], {type:mime||'text/plain;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  function saveSession(){
    var copy = {};
    for (var k in sim){
      if (k==='axDetail' || k==='blk' || k==='axes') continue;
      copy[k] = sim[k];
    }
    download('life-'+sim.pid+'-'+Math.floor(sim.t)+'s.json',
      JSON.stringify({v:1, savedAt:new Date().toISOString(), sim:copy}, null, 1),
      'application/json');
  }

  function loadSession(){
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = function(){
      var f = inp.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function(){
        try {
          var o = JSON.parse(rd.result);
          var s = o.sim || o;
          Object.keys(sim).forEach(function(k){ if (k==='rx') return; });
          for (var k in sim) if (!(k in s)) delete sim[k];
          for (var k2 in s) sim[k2] = s[k2];
          LIFE.computeAxes(sim);
          sim._lastRec = sim.t;
          WAVES.clear();
          WAVES.prime(sim);
          clearAlarms();
          $('deathmask').className = '';
          $('presetSel').value = sim.pid;
          renderTiles(); renderRx(); renderLog(); renderHead();
        } catch(e){ openModal('读档失败', '<p class="no">'+esc(e.message||e)+'</p>'); }
      };
      rd.readAsText(f, 'utf-8');
    };
    inp.click();
  }

  function exportCsv(){
    var cols = ['t','HR','SBP','DBP','MAP','SpO2','RR','K','Na','Ca','pH','HCO3',
                'lac','glu','CO','pCO2','urine'];
    var out = [cols.join(',')];
    sim.hist.forEach(function(r){
      out.push(cols.map(function(c){
        var v = r[c];
        return (v==null||isNaN(v)) ? '' : (Math.round(v*1000)/1000);
      }).join(','));
    });
    download('life-'+sim.pid+'-'+Math.floor(sim.t)+'s.csv', out.join('\n'), 'text/csv;charset=utf-8');

    // 操作日志单独一份，方便对时间
    var lg = ['t,kind,msg'];
    sim.log.forEach(function(e){ lg.push([Math.round(e.t*10)/10, e.kind, '"'+e.msg.replace(/"/g,'""')+'"'].join(',')); });
    download('life-'+sim.pid+'-日志.csv', lg.join('\n'), 'text/csv;charset=utf-8');
  }

  /* ── 主循环 ─────────────────────────────── */
  function startPreset(id){
    sim = LIFE.newSim(id);
    WAVES.clear();
    WAVES.prime(sim);
    clearAlarms();
    $('deathmask').className = '';
    selDrug = null;
    $('drugPanel').className = '';
    $('drugPanel').innerHTML = '';
    renderTiles(); renderRx(); renderLog(); renderHead(); drawTrend();
  }

  function loop(now){
    try {
      var dtReal = Math.min(0.12, (now-lastT)/1000 || 0.016);
      lastT = now;
      if (speed>0 && !$('modal').classList.contains('show')){
        var g = dtReal*speed;
        var n = Math.max(1, Math.min(24, Math.ceil(g/0.1)));
        for (var i=0;i<n;i++) LIFE.update(sim, g/n);
        if (sim.ops.cpr>0) sim.ops.cpr += g;
      }
      WAVES.draw(sim);
      if (now - (loop._tr||0) > 110){
        loop._tr = now;
        renderTiles(); renderHead(); renderAlarms();
        if (now - (loop._tr2||0) > 900){ loop._tr2 = now; drawTrend(); renderRx(); }
      }
    } catch(err){
      var d = $('errbar');
      d.style.display = 'block';
      d.textContent = '运行时出错：' + (err && err.message ? err.message : err) + '　可截图发给我\n';
    }
    requestAnimationFrame(loop);
  }

  /* ── 事件绑定 ───────────────────────────── */
  function bind(){
    $('presetSel').innerHTML = PRESETS.map(function(p){
      return '<option value="'+p.id+'">'+p.name+'</option>';
    }).join('');
    $('presetSel').onchange = function(){ startPreset(this.value); };

    Array.prototype.forEach.call(document.querySelectorAll('#spdBtns button'), function(b){
      b.onclick = function(){
        var v = Number(b.getAttribute('data-v'));
        if (v>0) lastT = performance.now();
        setSpeed(sim.dead ? 0 : v);
      };
    });

    $('btnStep').onclick = function(){
      for (var i=0;i<50;i++) LIFE.update(sim, 0.1);
      renderTiles(); drawTrend(); renderHead();
    };
    $('btnReset').onclick = function(){ startPreset($('presetSel').value); };
    $('btnAudit').onclick = showAudit;
    $('btnCheck').onclick = showCheck;
    $('btnSave').onclick = saveSession;
    $('btnLoad').onclick = loadSession;
    $('btnCsv').onclick = exportCsv;

    $('drugSearch').oninput = renderDrugList;
    $('catSel').onchange = renderDrugList;

    // 走纸与增益
    Array.prototype.forEach.call(document.querySelectorAll('#ecgfoot > b'), function(b){
      b.onclick = function(){
        var p = b.getAttribute('data-paper');
        var g = b.getAttribute('data-gain');
        if (p){
          WAVES.setPaper(Number(p));
          Array.prototype.forEach.call(document.querySelectorAll('#ecgfoot > b[data-paper]'), function(x){ x.classList.remove('on'); });
          b.classList.add('on');
        } else if (g){
          WAVES.setGain(Number(g));
          Array.prototype.forEach.call(document.querySelectorAll('#ecgfoot > b[data-gain]'), function(x){ x.classList.remove('on'); });
          b.classList.add('on');
        }
      };
    });

    buildWaveChips();

    $('btnRestart2').onclick = function(){
      startPreset($('presetSel').value);
      if (speed === 0) setSpeed(1);
    };

    // 手机上药房是上拉面板
    $('fab').onclick = function(){ document.body.classList.add('pharm-open'); };
    $('pharmClose').onclick = function(){ document.body.classList.remove('pharm-open'); };
    $('scrim').onclick = function(){ document.body.classList.remove('pharm-open'); };
    window.addEventListener('resize', function(){
      if (window.innerWidth > 860) document.body.classList.remove('pharm-open');
    });

    $('btnShock').onclick = function(){ LIFE.shock(sim); renderLog(); };
    $('btnCpr').onclick = function(){
      var on = sim.ops.cpr>0;
      sim.ops.cpr = on ? 0 : 1;
      this.classList.toggle('on', !on);
      LIFE.log(sim,'操作', on?'停止按压':'开始胸外按压');
      renderLog();
    };
    $('btnVent').onclick = function(){
      sim.ops.vent = sim.ops.vent ? 0 : 1;
      if (sim.ops.vent) sim.ops.fio2 = Number(($('fio2Sel')||{}).value)||0.4;
      this.classList.toggle('on', !!sim.ops.vent);
      LIFE.log(sim,'操作', sim.ops.vent?'接呼吸机':'脱机');
      renderLog();
    };
    $('btnTube').onclick = function(){
      sim.ops.tube = sim.ops.tube ? 0 : 1;
      this.classList.toggle('on', !!sim.ops.tube);
      $('opsHint').textContent = sim.ops.tube ? '已插管' : '未插管';
      LIFE.log(sim,'操作', sim.ops.tube?'气管插管':'拔管');
      renderLog();
    };

    var fs = document.createElement('select');
    fs.id = 'fio2Sel';
    fs.innerHTML = '<option value="0.21">FiO₂ 21%</option><option value="0.4" selected>FiO₂ 40%</option>'+
      '<option value="0.6">FiO₂ 60%</option><option value="1.0">FiO₂ 100%</option>';
    fs.style.fontSize = '11px';
    fs.onchange = function(){ if (sim.ops.vent) sim.ops.fio2 = Number(fs.value); };
    $('btnVent').parentNode.insertBefore(fs, $('btnVent').nextSibling);

    window.addEventListener('resize', function(){
      WAVES.resize(); drawTrend();
    });
    window.addEventListener('keydown', function(e){
      if (e.target.tagName==='INPUT' || e.target.tagName==='SELECT') return;
      if (e.code==='Space'){ e.preventDefault(); var b = document.querySelector('#spdBtns button[data-v="0"]');
        b.click(); }
    });
  }

  /* ── 波形通道选择 ─────────────────────────── */
  function buildWaveChips(){
    var box = $('waveChips');
    if (!box) return;
    var act = WAVES.activeList();
    box.innerHTML = WAVES.list().map(function(c){
      var on = act.indexOf(c.id) >= 0;
      return '<b data-ch="'+c.id+'" class="'+(on?'on':'')+'">'+c.name+'</b>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('b'), function(el){
      el.onclick = function(){
        WAVES.toggle(el.getAttribute('data-ch'));
        buildWaveChips();
      };
    });
  }

  function boot(){
    buildTiles();
    buildCats();
    buildTrendChips();
    bind();
    WAVES.init($('waveStack'));
    renderDrugList();
    startPreset('healthy');
    lastT = performance.now();
    requestAnimationFrame(loop);
    if (location.hash === '#check') showCheck();
    if (location.hash === '#audit') showAudit();
  }

  // 给外部脚本留一个口子，方便自动测试；平时用不到
  window.LIFE_UI = {
    get sim(){ return sim; },
    advance: function(sec){
      var n = Math.round(sec/0.1);
      for (var i=0;i<n;i++) LIFE.update(sim, 0.1);
      renderTiles(); renderHead(); renderAlarms(); drawTrend(); renderRx(); renderLog();
      return sim;
    },
    give: function(id, dose, route, rate){ return LIFE.give(sim, id, dose, route, rate); },
    audit: function(){ return CHECKS.audit(); },
    check: function(){ return CHECKS.selfTest(); }
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
