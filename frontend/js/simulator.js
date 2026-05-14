/* ══════════════════════════════════════
   SIMULATION STATE
   ══════════════════════════════════════ */
let running=false, simInterval=null, tick=0;
let activeAtk='none';
let cntTotal=0, cntNormal=0, cntAtk=0, cntAnom=0;
let niIdx=0, aiIdx=0; // normal/attack index
let prevData={}; // prev bytes per arbId
let idsEventCount=0;
let seenIds=new Set();
let lastAtkLog=0;
let busHistory=Array(80).fill(0), atkHistory=Array(80).fill(0);
let chartObj=null;
let simuTime=0;
let capturedFrames=[];

/* ── CAPTURE STATE ── */
let isCapturing=false;
let captureBuffer=[];   // 캡처된 프레임 저장
let captureStartTs=0;   // 캡처 시작 시각 (simuTime)

const MAX_ROWS=18;
let shownRows=[];

/* ══════════════════════════════════════
   ATTACK DESCRIPTIONS
   ══════════════════════════════════════ */
const ATK_DESCS={
  none:'Normal 모드: Hyundai Sonata 실제 CAN 데이터 (R 레이블) 재생 — 정상 트래픽',
  flood:'⚡ Flooding 공격 (실제 데이터): 0x0000 ID로 모든 제로 데이터 대량 주입. Bus Load >70%, 정상 ECU 프레임 지연. OTIDS 데이터셋 T 레이블 프레임 포함.',
  spoof:'🎭 Spoofing 공격 (시뮬): 0x0316 (Wheel Speed ECU)을 위장하여 200km/h+ 가짜 속도값 주입. 동일 Arb ID에 변조된 B1-B2 바이트 삽입.',
  fuzz:'🔀 Fuzzing 공격 (시뮬): 정상 ECU 프레임의 2-4개 바이트를 무작위로 변조하여 전송. 다양한 ID에 걸쳐 데이터 무결성을 파괴.',
};

/* ══════════════════════════════════════
   FRAME GENERATORS
   ══════════════════════════════════════ */

// Spoofing: inject fake 0316 frames with > 200 km/h
function makeSpoofFrame(ts) {
  // Speed: 200 km/h = 20000 in 0.01 units = 0x4E20
  const spd=200+Math.floor(Math.random()*30);
  const raw=Math.round(spd/0.01);
  return {ts, id:'0316', dlc:8, data:[0x45,(raw>>8)&0xFF,raw&0xFF,0x09,(raw>>8)&0xFF,0x24,0x00,0x7C], label:'S'};
}

// Fuzzing: take a normal frame and randomize some bytes
function makeFuzzFrame(base) {
  const d=[...base.data];
  const numCorrupt=2+Math.floor(Math.random()*3);
  const changed=[];
  for(let i=0;i<numCorrupt;i++){
    const bi=Math.floor(Math.random()*d.length);
    d[bi]=Math.floor(Math.random()*256);
    changed.push(bi);
  }
  return {ts:base.ts, id:base.id, dlc:base.dlc, data:d, label:'F', fuzzedBytes:changed};
}

/* ══════════════════════════════════════
   UTILITY
   ══════════════════════════════════════ */
function h2(n){return n.toString(16).toUpperCase().padStart(2,'0');}

function renderBytes(bytes, changed, atkType){
  return bytes.map((b,i)=>{
    const hex=h2(b);
    let cls='byte-cell';
    if(changed && changed.includes(i)) cls+=' '+(atkType==='fuzz'?'fuzzed':'changed');
    return `<span class="${cls}">${hex}</span>`;
  }).join(' ');
}

/* ══════════════════════════════════════
   UI BUILD
   ══════════════════════════════════════ */
function buildVehGrid(){
  const el=document.getElementById('vehGrid');
  el.innerHTML=VEH_ITEMS.map(v=>`
    <div class="veh-item" id="vi_${v.key}">
      <div class="vi-label">${v.label}</div>
      <div class="vi-val" id="vv_${v.key}">—</div>
      <div class="vi-unit">${v.unit}</div>
      <div class="vi-src">0x${v.src}</div>
    </div>`).join('');
}

function buildECUStatus(){
  const el=document.getElementById('ecuStatus');
  const ids=['0316','0350','0130','0131','0140','0329','0545','0260','02A0','0002','043F','0000'];
  el.innerHTML=ids.map(id=>{
    const e=ECU_MAP[id]||{name:id,desc:''};
    return `<div class="ecu-chip" id="ec_${id}">
      <div class="ecu-dot" id="edot_${id}"></div>
      <span class="ecu-name">${e.name} (${id})</span>
      <span class="ecu-state" id="est_${id}">offline</span>
    </div>`;
  }).join('');
}

function buildDiffTable(){
  const el=document.getElementById('diffBody');
  const ids=['0316','0350','0130','0131','0140','0329','0545','0260','02A0','0002'];
  el.innerHTML=ids.map(id=>{
    const e=ECU_MAP[id]||{name:id};
    return `<div class="diff-row" id="dr_${id}">
      <span style="color:var(--text3);font-family:var(--mono)">0x${id}</span>
      <span style="color:var(--text2)">${e.name}</span>
      <span id="dprev_${id}" style="color:var(--text3)">—</span>
      <span id="dcur_${id}">—</span>
      <span id="ddelta_${id}" class="delta-badge delta-ok">—</span>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════
   FRAME RENDERING
   ══════════════════════════════════════ */
function addFrame(frame){
  const tbody=document.getElementById('frameTbody');
  shownRows.unshift(frame);
  if(shownRows.length>MAX_ROWS)shownRows.pop();

  tbody.innerHTML=shownRows.map(f=>{
    const isAtk=f.label==='T'||f.label==='S'||f.label==='F';
    const rowCls=f.label==='T'?'row-t':f.label==='S'?'row-spoof':f.label==='F'?'row-fuzz':'row-r new-frame';
    const prev=prevData[f.id];
    const changed=prev ? f.data.map((b,i)=>b!==prev[i]?i:-1).filter(i=>i>=0) : [];
    const atkCls=f.label==='F'?'fuzz':f.label==='S'?'injected':'changed';
    const bytes=Array(8).fill(0).map((_,i)=>i<f.dlc ? `<td><span class="byte-cell${isAtk&&changed.includes(i)?' '+atkCls:''}">${h2(f.data[i])}</span></td>` : '<td style="color:var(--text3)">—</td>');
    const lblCls=f.label==='T'?'lbl-T':f.label==='S'?'lbl-S':f.label==='F'?'lbl-F':'lbl-R';
    const ts=f.ts.toFixed(3);
    const decoded=decodeFrame(f.id, f.data);
    return `<tr class="${rowCls}">
      <td style="color:var(--text3)">${ts}</td>
      <td style="color:${f.label==='T'?'var(--red)':f.label==='S'?'var(--purple)':f.label==='F'?'var(--orange)':'var(--blue)'}">0x${f.id}</td>
      <td>${f.dlc}</td>
      ${bytes.join('')}
      <td><span class="lbl ${lblCls}">${f.label}</span></td>
      <td style="font-size:10px;color:var(--text3);max-width:140px;overflow:hidden;text-overflow:ellipsis">${decoded}</td>
    </tr>`;
  }).join('');

  document.getElementById('frameCount').textContent=cntTotal+' frames';
}

/* ══════════════════════════════════════
   VEHICLE STATE UPDATE
   ══════════════════════════════════════ */
function updateVehState(frame){
  VEH_ITEMS.forEach(v=>{
    if(v.src===frame.id){
      try{
        const val=v.decode(frame.data);
        const el=document.getElementById('vv_'+v.key);
        const card=document.getElementById('vi_'+v.key);
        if(el){
          el.textContent=val;
          const anomaly=frame.label!=='R';
          card.className='veh-item'+(anomaly?' anomaly':'');
        }
      }catch(e){}
    }
  });
  if(frame.id==='0316'){
    const spd=(((frame.data[1]<<8)|frame.data[2])*0.01).toFixed(1);
    document.getElementById('m_speed').textContent=spd;
    document.getElementById('m_speed').className='metric-val'+(parseFloat(spd)>180?' crit':parseFloat(spd)>130?' warn':'');
  }
  if(typeof vsUpdateGauges==='function') vsUpdateGauges(frame);
}

/* ══════════════════════════════════════
   ECU STATUS UPDATE
   ══════════════════════════════════════ */
function updateECUStatus(frame){
  const dot=document.getElementById('edot_'+frame.id);
  const st=document.getElementById('est_'+frame.id);
  const chip=document.getElementById('ec_'+frame.id);
  if(!dot||!st)return;
  dot.style.background=frame.label!=='R'?'var(--red)':'var(--green)';
  st.textContent=frame.label!=='R'?'⚠ '+frame.label:'active';
  st.className='ecu-state'+(frame.label!=='R'?' crit':'');
  if(chip) chip.className='ecu-chip'+(frame.label!=='R'?' comp':'');
}

/* ══════════════════════════════════════
   DIFF TABLE UPDATE
   ══════════════════════════════════════ */
function updateDiff(frame){
  const id=frame.id;
  const prev=prevData[id];
  const cur=frame.data;
  const prevEl=document.getElementById('dprev_'+id);
  const curEl=document.getElementById('dcur_'+id);
  const deltaEl=document.getElementById('ddelta_'+id);
  const rowEl=document.getElementById('dr_'+id);
  if(!prevEl)return;

  if(prev){
    prevEl.innerHTML=prev.slice(0,8).map(b=>`<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">${h2(b)}</span>`).join(' ');
    const changed=cur.map((b,i)=>b!==(prev[i]||0)?i:-1).filter(i=>i>=0);
    const atkClass=frame.label==='F'?'fuzzed':frame.label==='S'?'injected':'changed';
    curEl.innerHTML=cur.map((b,i)=>`<span class="byte-cell${changed.includes(i)?' '+atkClass:''}" style="font-size:10px">${h2(b)}</span>`).join(' ');
    const n=changed.length;
    if(rowEl) rowEl.className='diff-row'+(n>0?(frame.label==='F'?' fuzz-row':frame.label==='S'?' spoof-row':' changed-row'):'');
    if(deltaEl){
      if(n===0){deltaEl.textContent='≡';deltaEl.className='delta-badge delta-ok';}
      else if(n<=2){deltaEl.textContent=n+'B↑';deltaEl.className='delta-badge delta-warn';}
      else{deltaEl.textContent=n+'B↑';deltaEl.className='delta-badge delta-crit';}
    }
  } else {
    prevEl.textContent='(new)';
    curEl.innerHTML=cur.map(b=>`<span style="font-size:10px;font-family:var(--mono)">${h2(b)}</span>`).join(' ');
  }
  prevData[id]=[...cur.slice(0,8)].concat(Array(8-cur.length).fill(0));
}

/* ══════════════════════════════════════
   IDS LOG
   ══════════════════════════════════════ */
function addIDS(msg, type='ids', cls='info'){
  const el=document.getElementById('idsLog');
  const now=new Date();
  const ts=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0')+':'+now.getSeconds().toString().padStart(2,'0')+'.'+now.getMilliseconds().toString().padStart(3,'0').slice(0,2);
  const row=document.createElement('div');
  row.className='ids-row';
  row.innerHTML=`<span class="ids-ts">${ts}</span><span class="ids-tag tag-${type}">[${type.toUpperCase()}]</span><span class="ids-msg ${cls}">${msg}</span>`;
  el.insertBefore(row, el.firstChild.nextSibling||null);
  while(el.children.length>60)el.removeChild(el.lastChild);
  idsEventCount++;
  document.getElementById('idsCount').textContent=idsEventCount+' events';
}

/* ══════════════════════════════════════
   METRICS UPDATE
   ══════════════════════════════════════ */
function updateMetrics(){
  const busLoad=activeAtk==='flood'?72+Math.round(Math.random()*20):
                activeAtk==='spoof'?18+Math.round(Math.random()*8):
                activeAtk==='fuzz'?22+Math.round(Math.random()*12):
                10+Math.round(Math.random()*6);
  const fps=activeAtk==='flood'?700+Math.round(Math.random()*300):
            activeAtk==='spoof'?55+Math.round(Math.random()*15):
            activeAtk==='fuzz'?60+Math.round(Math.random()*20):
            45+Math.round(Math.random()*15);

  const bl=document.getElementById('m_busload');
  bl.textContent=busLoad+'%';
  bl.className='metric-val'+(busLoad>70?' crit':busLoad>35?' warn':' ok');
  document.getElementById('m_fps').textContent=fps;
  document.getElementById('m_total').textContent=cntTotal;
  document.getElementById('m_normal').textContent=cntNormal;
  const atkEl=document.getElementById('m_attack');
  atkEl.textContent=cntAtk;
  atkEl.className='metric-val'+(cntAtk>0?' crit':'');
  document.getElementById('m_atkpct').textContent=cntTotal>0?((cntAtk/cntTotal*100).toFixed(1))+'% of traffic':'0%';
  document.getElementById('m_anom').textContent=cntAnom;
  document.getElementById('m_ids').textContent=seenIds.size;

  busHistory.push(busLoad); busHistory.shift();
  const atkVal=activeAtk!=='none'?busLoad*0.9:0;
  atkHistory.push(atkVal); atkHistory.shift();

  if(chartObj){
    chartObj.data.datasets[0].data=[...busHistory];
    const atkColor=activeAtk==='flood'?'rgba(248,81,73,0.4)':
                   activeAtk==='spoof'?'rgba(188,140,255,0.4)':
                   activeAtk==='fuzz'?'rgba(255,166,87,0.4)':'rgba(63,185,80,0.15)';
    chartObj.data.datasets[1].data=[...atkHistory];
    chartObj.data.datasets[1].backgroundColor=atkColor;
    chartObj.update('none');
  }
}

/* ══════════════════════════════════════
   MAIN SIMULATION TICK
   ══════════════════════════════════════ */
function simTick(){
  tick++;
  simuTime+=0.2;
  const frames=[];

  // Pick base frames depending on mode
  if(activeAtk==='flood'){
    // Mix normal + T-labeled flooding frames
    for(let i=0;i<3;i++){
      frames.push(SONATA_DATA.normal[niIdx%SONATA_DATA.normal.length]);
      niIdx++;
    }
    for(let i=0;i<5;i++){
      frames.push(SONATA_DATA.attack[aiIdx%SONATA_DATA.attack.length]);
      aiIdx++;
    }
  } else if(activeAtk==='spoof'){
    for(let i=0;i<2;i++){
      frames.push(SONATA_DATA.normal[niIdx%SONATA_DATA.normal.length]);
      niIdx++;
    }
    if(Math.random()<0.35) frames.push(makeSpoofFrame(simuTime));
  } else if(activeAtk==='fuzz'){
    for(let i=0;i<2;i++){
      const base=SONATA_DATA.normal[niIdx%SONATA_DATA.normal.length];
      if(Math.random()<0.4) frames.push(makeFuzzFrame(base));
      else frames.push(base);
      niIdx++;
    }
  } else {
    for(let i=0;i<2;i++){
      frames.push(SONATA_DATA.normal[niIdx%SONATA_DATA.normal.length]);
      niIdx++;
    }
    if(capturedFrames.length<30) capturedFrames.push(...frames);
  }

  frames.forEach(f=>{
    if(!f) return;
    const fWithTs={...f, ts:parseFloat(simuTime.toFixed(3))};
    cntTotal++;
    seenIds.add(f.id);
    if(f.label==='R') cntNormal++;
    else { cntAtk++; cntAnom++; }
    updateVehState(fWithTs);
    updateECUStatus(fWithTs);
    updateDiff(fWithTs);
    addFrame(fWithTs);
    // ── 캡처 중이면 버퍼에 추가 ──
    if(isCapturing) {
      captureBuffer.push(fWithTs);
      document.getElementById('captureCount').textContent=captureBuffer.length+' frames';
    }
    simuTime+=0.001;
  });

  // IDS triggers
  const now=Date.now();
  if(activeAtk==='flood' && now-lastAtkLog>800){
    lastAtkLog=now;
    addIDS('ID=0x0000 flooding 감지 — 단위시간 내 '+Math.round(35+Math.random()*15)+'회 반복','flood','crit');
  } else if(activeAtk==='spoof' && now-lastAtkLog>1400){
    lastAtkLog=now;
    const spd=(200+Math.random()*30).toFixed(1);
    addIDS(`0x0316 speed 이상값: ${spd} km/h (정상범위 초과)`,'spoof','crit');
  } else if(activeAtk==='fuzz' && now-lastAtkLog>1000){
    lastAtkLog=now;
    addIDS('랜덤 바이트 패턴 감지 — CAN 프레임 데이터 무결성 실패','fuzz','warn');
  }

  if(tick%8===0) updateMetrics();
}

/* ══════════════════════════════════════
   ATK MODE
   ══════════════════════════════════════ */
function setAtk(mode){
  activeAtk=mode;
  ['none','flood','spoof','fuzz'].forEach(m=>{
    document.getElementById('btn_'+m).className='atk-btn'+(m===mode?' sel-'+mode:'');
  });
  document.getElementById('atkDesc').textContent=ATK_DESCS[mode];
  document.getElementById('atkDesc').style.color=
    mode==='flood'?'rgba(248,81,73,.8)':
    mode==='spoof'?'rgba(188,140,255,.8)':
    mode==='fuzz'?'rgba(255,166,87,.8)':'var(--text3)';
  updateStatus();
  if(running && mode!=='none'){
    addIDS('공격 시작: '+{flood:'DoS Flooding',spoof:'Speed Spoofing',fuzz:'Data Fuzzing'}[mode],'ids','crit');
  }
  if(typeof vsUpdateMode==='function') vsUpdateMode(mode);
}

function updateStatus(){
  const dot=document.getElementById('statusDot');
  const txt=document.getElementById('statusTxt');
  if(!running){dot.className='dot stopped';txt.textContent='Stopped';return;}
  if(activeAtk==='none'){dot.className='dot running';txt.textContent='Running — Normal';}
  else{dot.className='dot atk';txt.textContent='Running — '+{flood:'Flooding',spoof:'Spoofing',fuzz:'Fuzzing'}[activeAtk];}
}

/* ══════════════════════════════════════
   SIM CONTROL
   ══════════════════════════════════════ */
function startSim(){
  running=true;
  document.getElementById('startBtn').style.display='none';
  document.getElementById('stopBtn').style.display='';
  document.getElementById('captureBtn').disabled=false;
  document.getElementById('captureBtn').title='클릭하여 캡처 시작';
  updateStatus();
  addIDS('시뮬레이터 시작됨 — Sonata OTIDS 데이터셋 로드','sys','ok');
  simInterval=setInterval(simTick, 200);
}

function stopSim(){
  running=false;
  clearInterval(simInterval);
  // 캡처 중이었다면 자동 종료
  if(isCapturing){
    isCapturing=false;
    if(captureBuffer.length>0) downloadCapture();
    captureBuffer=[];
  }
  document.getElementById('startBtn').style.display='';
  document.getElementById('stopBtn').style.display='none';
  const btn=document.getElementById('captureBtn');
  btn.disabled=true; btn.className='btn capture-off'; btn.textContent='⏺ Capture';
  btn.title='Start 후 사용 가능';
  document.getElementById('captureBadge').innerHTML='<span id="captureCount" style="font-family:var(--mono)">0 frames</span>';
  updateStatus();
  addIDS('시뮬레이터 정지','sys','info');
}

function resetSim(){
  stopSim();
  tick=0;simuTime=0;niIdx=0;aiIdx=0;
  cntTotal=0;cntNormal=0;cntAtk=0;cntAnom=0;idsEventCount=0;
  shownRows=[];prevData={};seenIds.clear();capturedFrames=[];
  busHistory=Array(80).fill(0);atkHistory=Array(80).fill(0);
  document.getElementById('frameTbody').innerHTML='';
  document.getElementById('diffBody').innerHTML='';
  document.getElementById('idsLog').innerHTML='<div class="ids-row" style="color:var(--text3)"><span class="ids-ts">—</span><span class="ids-tag tag-sys">[SYS]</span><span class="ids-msg">리셋됨 — Start를 눌러 시작하세요</span></div>';
  document.getElementById('idsCount').textContent='0 events';
  document.getElementById('frameCount').textContent='0 frames';
  isCapturing=false; captureBuffer=[];
  const cbtn=document.getElementById('captureBtn');
  cbtn.disabled=true; cbtn.className='btn capture-off'; cbtn.textContent='⏺ Capture';
  cbtn.title='Start 후 사용 가능';
  document.getElementById('captureBadge').innerHTML='<span id="captureCount" style="font-family:var(--mono)">0 frames</span>';
  updateMetrics();
  setAtk('none');
  // rebuild veh grid
  buildVehGrid();
  buildECUStatus();
  buildDiffTable();
  if(typeof vsUpdateMode==='function') { vsUpdateMode('none'); vs_currentSpeed=0; }
}

/* ══════════════════════════════════════
   CAPTURE & EXPORT
   ══════════════════════════════════════ */
function toggleCapture(){
  if(!running) return;
  if(!isCapturing){
    // ── 캡처 시작 ──
    isCapturing=true;
    captureBuffer=[];
    captureStartTs=simuTime;
    const btn=document.getElementById('captureBtn');
    btn.textContent='⏹ Stop & Save';
    btn.className='btn capture-on';
    const badge=document.getElementById('captureBadge');
    badge.className='capture-badge active';
    badge.innerHTML='<span class="rec-dot"></span><span id="captureCount" style="font-family:var(--mono)">0 frames</span>';
    addIDS('캡처 시작 — CAN 프레임 기록 중','sys','info');
  } else {
    // ── 캡처 중지 → TXT 다운로드 ──
    isCapturing=false;
    const btn=document.getElementById('captureBtn');
    btn.textContent='⏺ Capture';
    btn.className='btn capture-off';
    const badge=document.getElementById('captureBadge');
    badge.className='capture-badge';
    badge.innerHTML=`<span id="captureCount" style="font-family:var(--mono)">${captureBuffer.length} frames</span>`;
    if(captureBuffer.length===0){
      addIDS('캡처된 프레임 없음 — 저장 취소','sys','warn');
      return;
    }
    downloadCapture();
  }
}

function downloadCapture(){
  // 원본 OTIDS 포맷으로 출력:
  // timestamp,ArbID,DLC,B0,B1,...,BN,Label
  const BASE_TS=1513920459.0; // 원본 데이터셋 기준 타임스탬프
  const header=[
    '# CAN Bus Capture — Hyundai Sonata Simulator',
    '# Attack mode: '+({none:'Normal',flood:'Flooding (OTIDS)',spoof:'Spoofing (sim)',fuzz:'Fuzzing (sim)'}[activeAtk]||activeAtk),
    '# Captured frames: '+captureBuffer.length,
    '# Capture duration: '+((captureBuffer[captureBuffer.length-1].ts - captureBuffer[0].ts)).toFixed(3)+'s',
    '# Format: timestamp,ArbID,DLC,B0,B1,...,BN,Label',
    '# Labels: R=Normal  T=Flooding  S=Spoofing  F=Fuzzing',
    '# Generated: '+new Date().toISOString(),
    '#',
  ].join('\n');

  const lines=captureBuffer.map(f=>{
    const ts=(BASE_TS + f.ts).toFixed(6);
    const bytes=f.data.slice(0, f.dlc).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(',');
    return `${ts},${f.id},${f.dlc},${bytes},${f.label}`;
  });

  const content=header+'\n'+lines.join('\n')+'\n';
  const blob=new Blob([content],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const atkLabel={none:'normal',flood:'flooding',spoof:'spoofing',fuzz:'fuzzing'}[activeAtk]||'capture';
  const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const defaultName=`sonata_can_${atkLabel}_${captureBuffer.length}frames_${ts}.txt`;
  const userInput=prompt('저장할 파일 이름을 입력하세요 (.txt 자동 추가):', defaultName.replace('.txt',''));
  if(userInput===null) { URL.revokeObjectURL(url); addIDS('캡처 저장 취소됨','sys','warn'); return; }
  const finalName=(userInput.trim()||defaultName.replace('.txt',''))+'.txt';
  a.href=url;
  a.download=finalName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addIDS(`캡처 저장 완료 — ${captureBuffer.length}개 프레임 → ${finalName}`,'sys','ok');
}

/* ══════════════════════════════════════
   CHART INIT
   ══════════════════════════════════════ */
function initChart(){
  const ctx=document.getElementById('loadChart').getContext('2d');
  chartObj=new Chart(ctx,{
    type:'line',
    data:{
      labels:Array(80).fill(''),
      datasets:[
        {label:'Bus Load',data:[...busHistory],borderColor:'#3fb950',backgroundColor:'rgba(63,185,80,0.06)',borderWidth:1.5,fill:true,tension:.3,pointRadius:0},
        {label:'Attack',  data:[...atkHistory],backgroundColor:'rgba(248,81,73,0.25)',borderColor:'transparent',fill:true,tension:.3,pointRadius:0},
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      plugins:{legend:{display:false}},
      scales:{
        x:{display:false},
        y:{min:0,max:100,display:true,
           ticks:{font:{size:9},color:'#6e7681',stepSize:25,callback:v=>v+'%'},
           grid:{color:'rgba(48,54,61,1)'},
           border:{color:'var(--border)'}}
      }
    }
  });
}

/* ══════════════════════════════════════
   INIT
   ══════════════════════════════════════ */
buildVehGrid();
buildECUStatus();
buildDiffTable();
initChart();
// vsInit() is called from visualizer.js after DOMContentLoaded
