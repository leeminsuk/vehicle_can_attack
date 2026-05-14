/* ══════════════════════════════════════
   VISUAL SIMULATOR — Gauges & Canvas
   ══════════════════════════════════════ */

const VS = {
  spd: { cx:110, cy:95, r:74, min:0, max:260, startAngle:225, span:270, greens:100, yellows:150 },
  rpm: { cx:90,  cy:78, r:60, min:0, max:8000, startAngle:225, span:270, greens:4000, yellows:6000 }
};

let vs_rAF, vs_carCanvas, vs_carCtx, vs_currentMode='none', vs_currentSpeed=0, vs_normalSpeed=0;

function vsDescribeArc(cx, cy, r, startAngle, endAngle) {
  const toRad = a => (a - 90) * Math.PI / 180;
  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));
  const span = ((endAngle - startAngle) % 360 + 360) % 360;
  if (span < 0.2) return null;
  const la = span > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)},${y1.toFixed(2)} A ${r},${r} 0 ${la},1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

function vsValToAngle(cfg, val) {
  return cfg.startAngle + (Math.min(Math.max(val, cfg.min), cfg.max) / cfg.max) * cfg.span;
}

function vsInitGauges() {
  const setD = (id, d) => { if(d) { const el=document.getElementById(id); if(el) el.setAttribute('d', d); } };
  const s = VS.spd;
  const sGreenEnd = vsValToAngle(s, s.greens);
  const sYellowEnd = vsValToAngle(s, s.yellows);
  const sRedEnd = s.startAngle + s.span;
  setD('spdZoneGreen',  vsDescribeArc(s.cx, s.cy, s.r, s.startAngle, sGreenEnd));
  setD('spdZoneYellow', vsDescribeArc(s.cx, s.cy, s.r, sGreenEnd, sYellowEnd));
  setD('spdZoneRed',    vsDescribeArc(s.cx, s.cy, s.r, sYellowEnd, sRedEnd));

  const rp = VS.rpm;
  const rGreenEnd = vsValToAngle(rp, rp.greens);
  const rYellowEnd = vsValToAngle(rp, rp.yellows);
  const rRedEnd = rp.startAngle + rp.span;
  const toRad = a => (a-90)*Math.PI/180;
  const rBgD = `M ${(rp.cx+rp.r*Math.cos(toRad(rp.startAngle))).toFixed(2)},${(rp.cy+rp.r*Math.sin(toRad(rp.startAngle))).toFixed(2)} A ${rp.r},${rp.r} 0 1,1 ${(rp.cx+rp.r*Math.cos(toRad(rRedEnd))).toFixed(2)},${(rp.cy+rp.r*Math.sin(toRad(rRedEnd))).toFixed(2)}`;
  setD('rpmBgArc',      rBgD);
  setD('rpmZoneGreen',  vsDescribeArc(rp.cx, rp.cy, rp.r, rp.startAngle, rGreenEnd));
  setD('rpmZoneYellow', vsDescribeArc(rp.cx, rp.cy, rp.r, rGreenEnd, rYellowEnd));
  setD('rpmZoneRed',    vsDescribeArc(rp.cx, rp.cy, rp.r, rYellowEnd, rRedEnd));

  // Speed ticks
  const sTicksEl = document.getElementById('spdTicks');
  if(sTicksEl) {
    const majorSpeeds = [0,40,80,120,160,200,260];
    let html = '';
    for(let kmh=0; kmh<=260; kmh+=20) {
      const a = vsValToAngle(s, kmh);
      const rad = (a-90)*Math.PI/180;
      const isMajor = majorSpeeds.includes(kmh);
      const innerR = isMajor ? 52 : 58;
      const outerR = isMajor ? 64 : 62;
      const x1=s.cx+innerR*Math.cos(rad), y1=s.cy+innerR*Math.sin(rad);
      const x2=s.cx+outerR*Math.cos(rad), y2=s.cy+outerR*Math.sin(rad);
      html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${isMajor?'#8b949e':'#444c56'}" stroke-width="${isMajor?1.5:1}"/>`;
      if(isMajor) {
        const lx=s.cx+44*Math.cos(rad), ly=s.cy+44*Math.sin(rad);
        html += `<text x="${lx.toFixed(1)}" y="${(ly+3).toFixed(1)}" text-anchor="middle" fill="#6e7681" font-size="8" font-family="sans-serif">${kmh}</text>`;
      }
    }
    sTicksEl.innerHTML = html;
  }

  // RPM ticks
  const rTicksEl = document.getElementById('rpmTicks');
  if(rTicksEl) {
    let html = '';
    for(let rpm=0; rpm<=8000; rpm+=1000) {
      const a = vsValToAngle(rp, rpm);
      const rad = (a-90)*Math.PI/180;
      const x1=rp.cx+42*Math.cos(rad), y1=rp.cy+42*Math.sin(rad);
      const x2=rp.cx+52*Math.cos(rad), y2=rp.cy+52*Math.sin(rad);
      html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#8b949e" stroke-width="1.5"/>`;
      const lx=rp.cx+35*Math.cos(rad), ly=rp.cy+35*Math.sin(rad);
      html += `<text x="${lx.toFixed(1)}" y="${(ly+3).toFixed(1)}" text-anchor="middle" fill="#6e7681" font-size="8" font-family="sans-serif">${rpm/1000}</text>`;
    }
    rTicksEl.innerHTML = html;
  }
}

function vsUpdateSpeed(speed) {
  vs_currentSpeed = speed;
  const cfg = VS.spd;
  const angle = vsValToAngle(cfg, speed);
  const needleEl = document.getElementById('spdNeedleG');
  if(needleEl) needleEl.setAttribute('transform', `rotate(${angle.toFixed(2)},${cfg.cx},${cfg.cy})`);
  const fillEl = document.getElementById('spdActiveFill');
  if(fillEl) {
    const d = vsDescribeArc(cfg.cx, cfg.cy, cfg.r, cfg.startAngle, angle);
    if(d) { fillEl.setAttribute('d', d); fillEl.style.display=''; }
    else { fillEl.style.display='none'; }
    const c = speed>=180?'#f85149':speed>=130?'#d29922':'#3fb950';
    fillEl.setAttribute('stroke', c);
  }
  const spdText = document.getElementById('spdText');
  if(spdText) {
    spdText.textContent = Math.round(speed);
    spdText.setAttribute('fill', speed>=180?'#f85149':speed>=130?'#d29922':'#3fb950');
  }
}

function vsUpdateRpm(rpm) {
  const cfg = VS.rpm;
  const angle = vsValToAngle(cfg, rpm);
  const needleEl = document.getElementById('rpmNeedleG');
  if(needleEl) needleEl.setAttribute('transform', `rotate(${angle.toFixed(2)},${cfg.cx},${cfg.cy})`);
  const fillEl = document.getElementById('rpmActiveFill');
  if(fillEl) {
    const d = vsDescribeArc(cfg.cx, cfg.cy, cfg.r, cfg.startAngle, angle);
    if(d) { fillEl.setAttribute('d', d); fillEl.style.display=''; }
    else { fillEl.style.display='none'; }
    const c = rpm>=6000?'#f85149':rpm>=4000?'#d29922':'#3fb950';
    fillEl.setAttribute('stroke', c);
  }
  const rpmText = document.getElementById('rpmText');
  if(rpmText) {
    rpmText.textContent = (rpm/1000).toFixed(1);
    rpmText.setAttribute('fill', rpm>=6000?'#f85149':rpm>=4000?'#d29922':'#3fb950');
  }
}

function vsUpdateGauges(frame) {
  if(frame.id !== '0316') return;
  const speed = ((frame.data[1]<<8)|frame.data[2]) * 0.01;
  vs_currentSpeed = speed;
  // Track the last normal speed so spoof comparison shows real vs spoofed
  if(typeof activeAtk==='undefined' || activeAtk==='none') vs_normalSpeed = speed;
  vsUpdateSpeed(speed);
  let rpm;
  if(activeAtk==='flood') rpm = Math.random()*8000;
  else if(activeAtk==='spoof') rpm = 3000+speed*25+(Math.random()-0.5)*300;
  else if(activeAtk==='fuzz') rpm = speed*28+(Math.random()-0.5)*3000;
  else rpm = speed*28+(Math.random()-0.5)*200;
  rpm = Math.max(0, Math.min(8000, rpm));
  vsUpdateRpm(rpm);
  const gear = speed<5?'N':speed<30?'2':speed<60?'3':speed<100?'4':speed<150?'5':'6';
  const thrVal = frame.data[4]||0;
  const steerVal = (((frame.data[4]<<8)|frame.data[5])*0.01).toFixed(0);
  const gEl=document.getElementById('vs_gear'), tEl=document.getElementById('vs_thr'), sEl=document.getElementById('vs_steer');
  if(gEl) gEl.textContent=gear;
  if(tEl) tEl.textContent=thrVal+'%';
  if(sEl) sEl.textContent=steerVal+'°';
  const isAtk = activeAtk!=='none';
  [gEl,tEl,sEl].forEach(el=>{ if(el) { isAtk?el.classList.add('atk-val'):el.classList.remove('atk-val'); } });
}

function vsUpdateMode(mode) {
  vs_currentMode = mode;
  ['wl_ok','wl_abs','wl_eng','wl_str','wl_spd','wl_bus','wl_ids'].forEach(id=>{
    const el=document.getElementById(id); if(el){el.classList.remove('on','pulse');}
  });
  const on=(id,pulse=false)=>{const el=document.getElementById(id);if(!el)return;el.classList.add('on');if(pulse)el.classList.add('pulse');};
  const carTxt=document.getElementById('carStateTxt');
  const spdCmp=document.getElementById('spdCompare');
  if(mode==='none'){
    on('wl_ok');
    if(carTxt){carTxt.textContent='NORMAL';carTxt.style.color='#3fb950';}
    if(spdCmp)spdCmp.classList.remove('show');
  } else if(mode==='flood'){
    on('wl_abs',true);on('wl_eng',true);on('wl_str',true);on('wl_bus',true);on('wl_ids',true);
    if(carTxt){carTxt.textContent='⚡ FLOODING ATTACK';carTxt.style.color='#f85149';}
    if(spdCmp)spdCmp.classList.remove('show');
  } else if(mode==='spoof'){
    on('wl_spd',true);on('wl_ids',true);
    if(carTxt){carTxt.textContent='SPOOFING ACTIVE';carTxt.style.color='#bc8cff';}
    if(spdCmp)spdCmp.classList.add('show');
  } else if(mode==='fuzz'){
    on('wl_eng',true);on('wl_str',true);on('wl_ids',true);
    if(carTxt){carTxt.textContent='FUZZING ACTIVE';carTxt.style.color='#ffa657';}
    if(spdCmp)spdCmp.classList.remove('show');
  }
}

/* ── Canvas ── */
function vsInitCanvas(){
  vs_carCanvas=document.getElementById('carCanvas');
  vs_carCtx=vs_carCanvas.getContext('2d');
  vs_rAF=requestAnimationFrame(vsDrawLoop);
}

function vsDrawLoop(ts){
  vsDrawCarScene(vs_carCtx,vs_carCanvas.width,vs_carCanvas.height,activeAtk,vs_currentSpeed,ts);
  vs_rAF=requestAnimationFrame(vsDrawLoop);
}

function vsDrawCarScene(ctx,W,H,mode,speed,ts){
  ctx.clearRect(0,0,W,H);
  vsDrawRoad(ctx,W,H,speed,ts);
  vsDrawCar(ctx,W/2,H/2+10,'#2563eb');
  if(mode==='flood') vsDrawFloodEffect(ctx,W,H,ts);
  else if(mode==='spoof') vsDrawSpoofEffect(ctx,W,H,speed,ts);
  else if(mode==='fuzz') vsDrawFuzzEffect(ctx,W,H,ts);
}

function vsDrawRoad(ctx,W,H,speed,ts){
  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);
  const rW=200,rX=(W-rW)/2;
  ctx.fillStyle='#161b22'; ctx.fillRect(rX,0,rW,H);
  ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=2; ctx.setLineDash([]);
  ctx.beginPath();ctx.moveTo(rX,0);ctx.lineTo(rX,H);ctx.stroke();
  ctx.beginPath();ctx.moveTo(rX+rW,0);ctx.lineTo(rX+rW,H);ctx.stroke();
  const dashSpd=Math.max(speed,15);
  const offset=-((ts*dashSpd/180)%60);
  ctx.strokeStyle='rgba(255,255,255,0.1)';ctx.lineWidth=2;
  ctx.setLineDash([35,25]);ctx.lineDashOffset=offset;
  ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();
  ctx.setLineDash([]);
  if(speed>80){
    const alpha=Math.min((speed-80)/180,0.6);
    for(let i=0;i<6;i++){
      const sx=rX+10+Math.random()*(rW-20),sy=Math.random()*H,len=20+Math.random()*40;
      ctx.strokeStyle=`rgba(88,166,255,${alpha*Math.random()})`;
      ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(sx,sy+len);ctx.stroke();
    }
  }
}

function vsDrawCar(ctx,cx,cy,color){
  const CW=46,CH=88;
  ctx.save();
  ctx.shadowColor='rgba(0,0,0,0.8)';ctx.shadowBlur=10;ctx.shadowOffsetX=3;ctx.shadowOffsetY=4;
  ctx.fillStyle=color;
  ctx.beginPath();
  const r=10,x=cx-CW/2,y=cy-CH/2;
  if(ctx.roundRect){ctx.roundRect(x,y,CW,CH,r);}
  else{ctx.moveTo(x+r,y);ctx.lineTo(x+CW-r,y);ctx.quadraticCurveTo(x+CW,y,x+CW,y+r);ctx.lineTo(x+CW,y+CH-r);ctx.quadraticCurveTo(x+CW,y+CH,x+CW-r,y+CH);ctx.lineTo(x+r,y+CH);ctx.quadraticCurveTo(x,y+CH,x,y+CH-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);}
  ctx.fill();
  ctx.shadowColor='transparent';ctx.shadowBlur=0;
  ctx.fillStyle='rgba(150,200,255,0.22)';
  ctx.beginPath();ctx.ellipse(cx,cy-CH/2+18,16,10,0,0,Math.PI*2);ctx.fill();
  ctx.beginPath();ctx.ellipse(cx,cy+CH/2-16,13,8,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='rgba(0,0,0,0.12)';
  ctx.beginPath();ctx.ellipse(cx,cy,14,22,0,0,Math.PI*2);ctx.fill();
  const wheels=[[cx-CW/2-2,cy-CH/2+14],[cx+CW/2+2,cy-CH/2+14],[cx-CW/2-2,cy+CH/2-14],[cx+CW/2+2,cy+CH/2-14]];
  wheels.forEach(([wx,wy])=>{
    ctx.fillStyle='#1a1f24';ctx.strokeStyle='#444c56';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.ellipse(wx,wy,7,11,0,0,Math.PI*2);ctx.fill();ctx.stroke();
  });
  ctx.fillStyle='rgba(255,230,100,0.9)';ctx.shadowColor='rgba(255,220,0,0.8)';ctx.shadowBlur=8;
  [[cx-12,cy-CH/2+6],[cx+12,cy-CH/2+6]].forEach(([hx,hy])=>{ctx.beginPath();ctx.ellipse(hx,hy,6,4,0,0,Math.PI*2);ctx.fill();});
  ctx.shadowColor='transparent';ctx.shadowBlur=0;
  ctx.fillStyle='rgba(220,50,50,0.9)';
  [[cx-12,cy+CH/2-6],[cx+12,cy+CH/2-6]].forEach(([tx,ty])=>{ctx.beginPath();ctx.ellipse(tx,ty,6,4,0,0,Math.PI*2);ctx.fill();});
  ctx.restore();
}

function vsDrawFloodEffect(ctx,W,H,ts){
  for(let i=0;i<60;i++){
    ctx.fillStyle=`rgba(248,81,73,${0.3+Math.random()*0.5})`;
    ctx.fillRect(Math.random()*W,Math.random()*H,2,2);
  }
  const scanY=(ts/8)%H;
  const sg=ctx.createLinearGradient(0,scanY-20,0,scanY+20);
  sg.addColorStop(0,'rgba(248,81,73,0)');sg.addColorStop(0.5,'rgba(248,81,73,0.18)');sg.addColorStop(1,'rgba(248,81,73,0)');
  ctx.fillStyle=sg;ctx.fillRect(0,scanY-20,W,40);
  if(Math.floor(ts/400)%2===0){ctx.strokeStyle='rgba(248,81,73,0.6)';ctx.lineWidth=3;ctx.strokeRect(2,2,W-4,H-4);}
  ctx.fillStyle=`rgba(248,81,73,${0.08+Math.sin(ts*0.006)*0.05})`;ctx.fillRect(0,0,W,H);
}

function vsDrawSpoofEffect(ctx,W,H,speed,ts){
  const ghostAlpha=0.2+0.1*Math.sin(ts*0.004);
  ctx.globalAlpha=ghostAlpha;
  vsDrawCar(ctx,W/2,H/2-75,'#f85149');
  ctx.globalAlpha=1;
  ctx.save();
  ctx.strokeStyle='rgba(188,140,255,0.6)';ctx.lineWidth=2;
  ctx.setLineDash([8,6]);ctx.lineDashOffset=-(ts*0.05)%14;
  ctx.beginPath();ctx.moveTo(W/2,H/2-44);ctx.lineTo(W/2,H/2-75+44);ctx.stroke();
  ctx.setLineDash([]);ctx.restore();
  ctx.fillStyle=`rgba(210,153,34,${0.04+0.03*Math.abs(Math.sin(ts*0.003))})`;ctx.fillRect(0,0,W,H);
  const spoofedSpeed=200+Math.floor(Math.random()*30);
  // Use vs_normalSpeed as the real speed estimate (last known normal speed)
  const realSpeed=Math.max(0, vs_normalSpeed);
  const el1=document.getElementById('spdCmpSpoof'),el2=document.getElementById('spdCmpReal');
  const bar1=document.getElementById('spdCmpSpoofBar'),bar2=document.getElementById('spdCmpRealBar');
  if(el1)el1.textContent=spoofedSpeed+' km/h';
  if(el2)el2.textContent=realSpeed.toFixed(0)+' km/h';
  if(bar1)bar1.style.width=Math.min(100,spoofedSpeed/2.6)+'%';
  if(bar2)bar2.style.width=Math.min(100,realSpeed/2.6)+'%';
}

function vsDrawFuzzEffect(ctx,W,H,ts){
  if(Math.random()<0.3){
    const n=2+Math.floor(Math.random()*4);
    for(let i=0;i<n;i++){
      const sy=Math.random()*H,sh=4+Math.random()*20,shift=(Math.random()-0.5)*30;
      try{const d=ctx.getImageData(0,sy,W,sh);ctx.putImageData(d,shift,sy);}catch(e){}
      ctx.fillStyle=`rgba(${Math.floor(Math.random()*255)},${Math.floor(Math.random()*255)},${Math.floor(Math.random()*255)},0.08)`;
      ctx.fillRect(0,sy,W,sh);
    }
  }
  for(let i=0;i<30;i++){
    const r=Math.floor(Math.random()*255),g=Math.floor(Math.random()*255),b=Math.floor(Math.random()*255);
    ctx.fillStyle=`rgba(${r},${g},${b},0.4)`;
    ctx.fillRect(Math.random()*W,Math.random()*H,3+Math.random()*5,3+Math.random()*3);
  }
  ctx.fillStyle=`rgba(255,166,87,${0.06+Math.abs(Math.sin(ts*0.005))*0.07})`;ctx.fillRect(0,0,W,H);
}

function vsInit(){
  vsInitGauges();
  vsInitCanvas();
  vsUpdateSpeed(0);
  vsUpdateRpm(0);
  vsUpdateMode('none');
}

// Initialize after DOM is ready
if(document.readyState==='loading') {
  document.addEventListener('DOMContentLoaded', vsInit);
} else {
  vsInit();
}
