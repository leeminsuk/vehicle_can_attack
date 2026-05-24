/* ══════════════════════════════════════
   SIMULATION STATE
   ══════════════════════════════════════ */
let running=false, simInterval=null, tick=0;
let activeAtk='none';
let cntTotal=0, cntNormal=0, cntAtk=0, cntAnom=0;
let niIdx=0, aiIdx=0, fiIdx=0, miIdx=0; // normal/attack/fuzzy/malfunction index
let prevData={}; // prev bytes per arbId
let idsEventCount=0;
let seenIds=new Set();
let lastAtkLog=0;
let busHistory=Array(80).fill(0), atkHistory=Array(80).fill(0);
let chartObj=null;
let simuTime=0;
let capturedFrames=[];

/* ── CAPTURE STATE (15초 자동) ── */
let isCapturing=false;
let captureBuffer=[];
let captureStartTs=0;
let captureTimerId=null;
let captureCountdownId=null;
const CAPTURE_DURATION_SEC=15;

/* ── DYNAMIC & ATTACK STATE ── */
let dynIdIdx=0;           // NORMAL_ID_CYCLE 인덱스
let replayStore=[];       // 정상 프레임 스냅샷 (Replay 공격용)
let riIdx=0;              // replay index
let busoffEcus=new Set(); // Bus-Off 된 ECU ID 목록
const BUSOFF_TARGETS=['0350','0130','0131','0140','0329'];

/* ── SUSPENSION ATTACK STATE ── */
let suspensionPhase=0;    // 0~TWO_PI

/* ── MASQUERADE ATTACK STATE ── */
let masqTargetIdx=0;
const MASQ_TARGETS=['0316','0350','0140'];

/* ── IPS STATE ── */
let ipsActive=false;
let ipsStep=0;
let ipsInterval=null;
let ipsCurrentAtk='none';

const MAX_ROWS=18;
let shownRows=[];

/* ══════════════════════════════════════
   ATTACK DESCRIPTIONS
   ══════════════════════════════════════ */
const ATK_DESCS={
  none:'Normal 모드: Hyundai Sonata 실시간 CAN 데이터 생성 (R 레이블) — 물리 모델 기반 동적 트래픽',
  flood:'⚡ Flooding 공격 (실제 데이터): 0x0000 ID로 모든 제로 데이터 대량 주입. Bus Load >70%, 정상 ECU 프레임 지연. OTIDS 데이터셋 T 레이블 프레임 포함.',
  spoof:'🎭 Spoofing 공격 (시뮬): 0x0316 (Wheel Speed ECU)을 위장하여 200km/h+ 가짜 속도값 주입. 동일 Arb ID에 변조된 B1-B2 바이트 삽입.',
  fuzz:'🔀 Fuzzing 공격 (실제 데이터): 무작위 Arb ID + 완전 랜덤 데이터 프레임 주입. OTIDS Fuzzy_dataset_SONATA T 레이블 프레임 — 알 수 없는 ECU가 CAN 버스에 출현.',
  malfunc:'⚠ Malfunction 공격 (실제 데이터): 0x0316 (속도) 및 0x043F (클러스터) ECU 대상 오작동 유도. OTIDS Malfunction_dataset T 레이블 — ECU 이상 신호 주입.',
  replay:'🔁 Replay 공격 (시뮬): 이전에 캡처한 정상 CAN 프레임을 현재 타임스탬프로 재주입. ECU 인증 부재 악용 — 속도/조향 값 고정화, IDS 우회 시도.',
  busoff:'💀 Bus-Off 공격 (시뮬): 타겟 ECU에 에러 프레임을 반복 주입하여 TEC(Transmit Error Counter) 증가 → Bus-Off 상태 유도. 엔진/조향 ECU 강제 격리.',
  suspension:'🚗 Suspension Attack (시뮬): ECS(Electronic Control Suspension, 0x0236) ECU를 대상으로 댐퍼 및 차고 비정상값 고속 주입. 차체 진동 유발, 고속 주행 시 차량 안정성 심각하게 위협. 레이블: U',
  masquerade:'🕵️ Masquerade Attack (시뮬): 정품 ECU ID(0x0316, 0x0350, 0x0140)로 위장한 악성 프레임 주입. 동일 Arb ID에 교묘하게 변조된 데이터 — 시그니처/타이밍 핑거프린트 분석으로만 탐지 가능. 레이블: M',
};

/* ══════════════════════════════════════
   FRAME GENERATORS
   ══════════════════════════════════════ */

// Spoofing: inject fake 0316 frames with > 200 km/h (값 동적으로 변화)
function makeSpoofFrame(ts) {
  const spd = 200 + Math.floor(Math.random()*50) + Math.sin(simuTime*0.3)*15;
  const raw = Math.round(Math.max(200,spd) / 0.01);
  const steerRaw = Math.round((Math.sin(simuTime*0.5)*90) / 0.01) & 0xFFFF;
  return {ts, id:'0316', dlc:8,
    data:[0x45,(raw>>8)&0xFF,raw&0xFF,0x09,(steerRaw>>8)&0xFF,steerRaw&0xFF,0x00,0x7C], label:'S'};
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

// Replay Attack: 이전 정상 프레임을 현재 타임스탬프로 재주입
function makeReplayFrame(ts) {
  // replayStore가 비어 있으면 현재 dynState 기반으로 프리워밍
  if(replayStore.length === 0){
    for(let i=0;i<20;i++){
      const nid=NORMAL_ID_CYCLE[i%NORMAL_ID_CYCLE.length];
      replayStore.push(makeDynFrame(nid, ts-10+i*0.5));
    }
  }
  const pool = replayStore;
  const base = pool[riIdx % pool.length]; riIdx++;
  // 데이터는 "frozen" 상태 (변화 없음) — 현재 dynState와 불일치가 핵심
  return {...base, ts, label:'P', replayed:true};
}

// Bus-Off Attack: 타겟 ECU에 에러 프레임 주입 → TEC 증가 → Bus-Off
function makeBusOffFrame(ts) {
  // 에러 프레임: 모든 비트 도미넌트(0xFF) → CRC 오류 유발
  const tid = BUSOFF_TARGETS[Math.floor(tick/4) % BUSOFF_TARGETS.length];
  // 일정 시간 후 해당 ECU Bus-Off 처리
  if(tick % 20 === 0 && BUSOFF_TARGETS.includes(tid)){
    busoffEcus.add(tid);
  }
  return {ts, id:tid, dlc:8,
    data:[0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF], label:'B', busoff:true};
}

// Suspension Attack: ECS ECU(0x0236) 비정상 댐퍼/차고 값 고속 주입
function makeSuspensionFrame(ts) {
  suspensionPhase += 0.42; // 빠른 진동
  const SUSP_IDS = ['0236','05B0','02B0'];
  const tid = SUSP_IDS[Math.floor(tick/2) % SUSP_IDS.length];
  // 댐퍼 압력: 0~255 급격히 진동 (정상: 80~180)
  const damper = Math.round(127 + 127 * Math.sin(suspensionPhase));
  // 차고: 200~255 이상으로 급변 (정상: 100~150)
  const height = Math.round(200 + 55 * Math.cos(suspensionPhase * 0.7));
  return {ts, id:tid, dlc:8,
    data:[damper, height&0xFF, (height>>8)&0xFF, 0xFF,
          damper^0xFF, 0x00, (tick*5)&0xFF, 0x00],
    label:'U', suspension:true};
}

// Masquerade Attack: 정품 ECU ID로 위장한 악성 프레임 주입
function makeMasqueradeFrame(ts) {
  const tid = MASQ_TARGETS[masqTargetIdx % MASQ_TARGETS.length];
  masqTargetIdx++;
  if(tid === '0316'){
    // 속도 15% 부풀린 값 + 잘못된 B0 시그니처 (0x45 → 0x46)
    const fakeSpd = Math.min(255*100, (dynState.speed * 1.15 + 15));
    const raw = Math.round(fakeSpd / 0.01) & 0xFFFF;
    return {ts, id:tid, dlc:8,
      data:[0x46,(raw>>8)&0xFF,raw&0xFF,0x09,0x00,0x00,0x00,0x7C],
      label:'M', masquerade:true, masqTarget:tid};
  } else if(tid === '0350'){
    // 잘못된 체크섬 (원래: rc^0xC1, 위장: rc^0xC1^0x33)
    const rc = Math.round(dynState.rpm/62)&0xFF;
    return {ts, id:tid, dlc:8,
      data:[0x36,0x2B,rc,0x6C,0x74,0x00,0x00,(rc^0xC1^0x33)&0xFF],
      label:'M', masquerade:true, masqTarget:tid};
  } else { // 0140
    // 스로틀 30% 과장 + 잘못된 카운터 패턴
    const fakeThr = Math.min(255, Math.round(dynState.throttle * 1.3)) & 0xFF;
    return {ts, id:tid, dlc:8,
      data:[0x00,0x00,0x00,0x00,fakeThr,0x00,(tick*3)&0xFF,0x00],
      label:'M', masquerade:true, masqTarget:tid};
  }
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
    const isAtk=f.label==='T'||f.label==='S'||f.label==='F'||f.label==='P'||f.label==='B'||f.label==='U'||f.label==='M';
    const rowCls=f.label==='T'?'row-t':f.label==='S'?'row-spoof':f.label==='F'?'row-fuzz':
                 f.label==='P'?'row-replay':f.label==='B'?'row-busoff':
                 f.label==='U'?'row-suspension':f.label==='M'?'row-masquerade':'row-r new-frame';
    const prev=prevData[f.id];
    const changed=prev ? f.data.map((b,i)=>b!==prev[i]?i:-1).filter(i=>i>=0) : [];
    const atkCls=f.label==='F'?'fuzz':f.label==='S'?'injected':
                 f.label==='P'?'injected':f.label==='B'?'fuzzed':
                 f.label==='U'?'fuzzed':f.label==='M'?'injected':'changed';
    const bytes=Array(8).fill(0).map((_,i)=>i<f.dlc ? `<td><span class="byte-cell${isAtk&&changed.includes(i)?' '+atkCls:''}">${h2(f.data[i])}</span></td>` : '<td style="color:var(--text3)">—</td>');
    const lblCls=f.label==='T'?'lbl-T':f.label==='S'?'lbl-S':f.label==='F'?'lbl-F':
                 f.label==='P'?'lbl-P':f.label==='B'?'lbl-B':
                 f.label==='U'?'lbl-U':f.label==='M'?'lbl-M':'lbl-R';
    const ts=f.ts.toFixed(3);
    const decoded=decodeFrame(f.id, f.data);
    const idColor=f.label==='T'?'var(--red)':f.label==='S'?'var(--purple)':
                  f.label==='F'?'var(--orange)':f.label==='U'?'var(--suspension)':
                  f.label==='M'?'var(--masquerade)':'var(--blue)';
    return `<tr class="${rowCls}">
      <td style="color:var(--text3)">${ts}</td>
      <td style="color:${idColor}">0x${f.id}</td>
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
  const isAtk=frame.label!=='R';
  const atkColor=frame.label==='U'?'var(--suspension)':frame.label==='M'?'var(--masquerade)':'var(--red)';
  dot.style.background=isAtk?atkColor:'var(--green)';
  st.textContent=isAtk?'⚠ '+frame.label:'active';
  st.className='ecu-state'+(isAtk?' crit':'');
  if(chip) chip.className='ecu-chip'+(isAtk?' comp':'');
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
    const atkClass=frame.label==='F'?'fuzzed':frame.label==='S'||frame.label==='P'?'injected':
                   frame.label==='B'||frame.label==='U'?'fuzzed':frame.label==='M'?'injected':'changed';
    curEl.innerHTML=cur.map((b,i)=>`<span class="byte-cell${changed.includes(i)?' '+atkClass:''}" style="font-size:10px">${h2(b)}</span>`).join(' ');
    const n=changed.length;
    if(rowEl) rowEl.className='diff-row'+(n>0?(frame.label==='F'?' fuzz-row':frame.label==='S'?' spoof-row':
      frame.label==='P'?' replay-row':frame.label==='B'?' busoff-row':
      frame.label==='U'?' suspension-row':frame.label==='M'?' masquerade-row':' changed-row'):'');
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
                activeAtk==='fuzz'?30+Math.round(Math.random()*15):
                activeAtk==='malfunc'?20+Math.round(Math.random()*10):
                activeAtk==='replay'?14+Math.round(Math.random()*8):
                activeAtk==='busoff'?5+Math.round(Math.random()*8):
                activeAtk==='suspension'?35+Math.round(Math.random()*20): // 고속 주입
                activeAtk==='masquerade'?15+Math.round(Math.random()*8): // 정상처럼 보임
                10+Math.round(Math.random()*6);
  const fps=activeAtk==='flood'?700+Math.round(Math.random()*300):
            activeAtk==='spoof'?55+Math.round(Math.random()*15):
            activeAtk==='fuzz'?80+Math.round(Math.random()*40):
            activeAtk==='malfunc'?50+Math.round(Math.random()*20):
            activeAtk==='replay'?48+Math.round(Math.random()*12):
            activeAtk==='busoff'?15+Math.round(Math.random()*10):
            activeAtk==='suspension'?90+Math.round(Math.random()*30): // 빠른 주입
            activeAtk==='masquerade'?50+Math.round(Math.random()*10): // 정상 수준
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
                   activeAtk==='fuzz'?'rgba(255,166,87,0.4)':
                   activeAtk==='malfunc'?'rgba(253,200,0,0.4)':
                   activeAtk==='replay'?'rgba(86,212,212,0.4)':
                   activeAtk==='busoff'?'rgba(255,123,114,0.4)':
                   activeAtk==='suspension'?'rgba(232,121,249,0.4)':
                   activeAtk==='masquerade'?'rgba(163,230,53,0.4)':'rgba(63,185,80,0.15)';
    chartObj.data.datasets[1].data=[...atkHistory];
    chartObj.data.datasets[1].backgroundColor=atkColor;
    chartObj.update('none');
  }
}

function updateMetricsChartColor(atkColor) {
  if(chartObj) {
    chartObj.data.datasets[1].backgroundColor=atkColor;
  }
}

/* ══════════════════════════════════════
   MAIN SIMULATION TICK
   ══════════════════════════════════════ */
function simTick(){
  tick++;
  simuTime+=0.2;
  const frames=[];

  // 동적 물리 상태 업데이트
  tickDynState(activeAtk);

  // ── 모드별 프레임 생성 (실시간 동적) ──
  if(activeAtk==='flood'){
    // 동적 정상 프레임 3개 + flooding 5개
    for(let i=0;i<3;i++){
      const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
      frames.push(makeDynFrame(nid, simuTime));
    }
    for(let i=0;i<5;i++){
      frames.push(SONATA_DATA.attack[aiIdx%SONATA_DATA.attack.length]);
      aiIdx++;
    }
  } else if(activeAtk==='spoof'){
    for(let i=0;i<2;i++){
      const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
      frames.push(makeDynFrame(nid, simuTime));
    }
    if(Math.random()<0.4) frames.push(makeSpoofFrame(simuTime));
  } else if(activeAtk==='fuzz'){
    const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
    frames.push(makeDynFrame(nid, simuTime));
    frames.push(SONATA_DATA.fuzzy[fiIdx%SONATA_DATA.fuzzy.length]); fiIdx++;
    frames.push(SONATA_DATA.fuzzy[fiIdx%SONATA_DATA.fuzzy.length]); fiIdx++;
  } else if(activeAtk==='malfunc'){
    const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
    frames.push(makeDynFrame(nid, simuTime));
    frames.push(SONATA_DATA.malfunction[miIdx%SONATA_DATA.malfunction.length]); miIdx++;
  } else if(activeAtk==='replay'){
    // 정상 2개 + replay 2개 (매 틱 확정 주입)
    for(let i=0;i<2;i++){
      const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
      frames.push(makeDynFrame(nid, simuTime));
    }
    frames.push(makeReplayFrame(simuTime));
    frames.push(makeReplayFrame(simuTime));
  } else if(activeAtk==='busoff'){
    // Bus-Off되지 않은 ECU만 정상 프레임 생성
    const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
    if(!busoffEcus.has(nid)) frames.push(makeDynFrame(nid, simuTime));
    frames.push(makeBusOffFrame(simuTime));
  } else if(activeAtk==='suspension'){
    // 정상 1개 + suspension 공격 2개 (고속 주입)
    const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
    frames.push(makeDynFrame(nid, simuTime));
    frames.push(makeSuspensionFrame(simuTime));
    frames.push(makeSuspensionFrame(simuTime+0.005));
  } else if(activeAtk==='masquerade'){
    // 정상 2개 + 위장 2개 (같은 ID라서 눈에 잘 안 띔)
    for(let i=0;i<2;i++){
      const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
      frames.push(makeDynFrame(nid, simuTime));
    }
    frames.push(makeMasqueradeFrame(simuTime));
    frames.push(makeMasqueradeFrame(simuTime+0.014)); // 14ms 간격 (정상: 22ms)
  } else {
    // Normal: 동적 생성, replayStore에 저장
    for(let i=0;i<2;i++){
      const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
      const f=makeDynFrame(nid, simuTime);
      frames.push(f);
      // Replay 공격용 스냅샷 저장 (최근 50개)
      if(replayStore.length<50) replayStore.push(f);
      else replayStore[tick%50]=f;
    }
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
    if(isCapturing){
      captureBuffer.push(fWithTs);
      const cc=document.getElementById('captureCount');
      if(cc) cc.textContent=captureBuffer.length+' frames';
    }
    simuTime+=0.001;
  });

  // IDS triggers
  const now=Date.now();
  if(activeAtk==='flood' && now-lastAtkLog>800){
    lastAtkLog=now;
    addIDS('ID=0x0000 flooding 감지 — 단위시간 내 '+Math.round(35+Math.random()*20)+'회 반복','flood','crit');
  } else if(activeAtk==='spoof' && now-lastAtkLog>1400){
    lastAtkLog=now;
    const spd=(200+Math.random()*50).toFixed(1);
    addIDS(`0x0316 speed 이상값: ${spd} km/h (정상범위 초과)`,'spoof','crit');
  } else if(activeAtk==='fuzz' && now-lastAtkLog>1000){
    lastAtkLog=now;
    const rndId=SONATA_DATA.fuzzy[fiIdx%SONATA_DATA.fuzzy.length].id;
    addIDS(`미확인 ID 0x${rndId} 출현 — Fuzzy 주입 감지 (OTIDS 실제 데이터)`,'fuzz','warn');
  } else if(activeAtk==='malfunc' && now-lastAtkLog>1200){
    lastAtkLog=now;
    addIDS('0x0316 / 0x043F ECU 이상 신호 감지 — Malfunction 공격 (실제 데이터)','malfunc','crit');
  } else if(activeAtk==='replay' && now-lastAtkLog>1600){
    lastAtkLog=now;
    const ids=['0316','0350','0140'];
    const rid=ids[Math.floor(Math.random()*ids.length)];
    addIDS(`0x${rid} 재생 프레임 감지 — 타임스탬프 불일치 (Replay Attack)`,'replay','warn');
  } else if(activeAtk==='busoff' && now-lastAtkLog>1000){
    lastAtkLog=now;
    const bo=BUSOFF_TARGETS[Math.floor(tick/4)%BUSOFF_TARGETS.length];
    const tec=Math.min(255, Math.round(80+tick*0.5+(Math.random()*20)));
    if(busoffEcus.has(bo)){
      addIDS(`0x${bo} ECU Bus-Off 상태 — CAN 버스에서 격리됨`,'busoff','crit');
    } else {
      addIDS(`0x${bo} TEC 증가: ${tec}/255 — Bus-Off 임박`,'busoff','warn');
    }
  } else if(activeAtk==='suspension' && now-lastAtkLog>900){
    lastAtkLog=now;
    const SUSP_IDS=['0236','05B0','02B0'];
    const sid=SUSP_IDS[Math.floor(tick/3)%SUSP_IDS.length];
    const damper=Math.round(127+127*Math.sin(suspensionPhase));
    addIDS(`0x${sid} ECS 댐퍼 이상값: ${damper}/255 (정상범위: 80~180) — 차체 진동 위험`,'suspension','crit');
  } else if(activeAtk==='masquerade' && now-lastAtkLog>1200){
    lastAtkLog=now;
    const tid=MASQ_TARGETS[masqTargetIdx%MASQ_TARGETS.length];
    const interval=(14+Math.round(Math.random()*3)).toFixed(1);
    addIDS(`0x${tid} 핑거프린트 이상: 전송 주기 ${interval}ms (정상: 22ms) — 위장 프레임 의심`,'masquerade','warn');
  }

  if(tick%8===0) updateMetrics();
}

/* ══════════════════════════════════════
   ATK MODE
   ══════════════════════════════════════ */
function setAtk(mode){
  activeAtk=mode;
  if(mode!=='busoff') busoffEcus.clear();
  if(mode!=='suspension') suspensionPhase=0;
  if(mode!=='masquerade') masqTargetIdx=0;
  ['none','flood','spoof','fuzz','malfunc','replay','busoff','suspension','masquerade'].forEach(m=>{
    const btn=document.getElementById('btn_'+m);
    if(btn) btn.className='atk-btn'+(m===mode?' sel-'+mode:'');
  });
  document.getElementById('atkDesc').textContent=ATK_DESCS[mode]||'';
  document.getElementById('atkDesc').style.color=
    mode==='flood'?'rgba(248,81,73,.8)':
    mode==='spoof'?'rgba(188,140,255,.8)':
    mode==='fuzz'?'rgba(255,166,87,.8)':
    mode==='malfunc'?'rgba(253,200,0,.8)':
    mode==='replay'?'rgba(86,212,212,.8)':
    mode==='busoff'?'rgba(255,123,114,.8)':
    mode==='suspension'?'rgba(232,121,249,.8)':
    mode==='masquerade'?'rgba(163,230,53,.8)':'var(--text3)';
  updateStatus();
  if(running && mode!=='none'){
    const names={flood:'DoS Flooding',spoof:'Speed Spoofing',fuzz:'Data Fuzzing (real)',
                 malfunc:'Malfunction Injection (real)',replay:'Replay Attack',busoff:'Bus-Off Attack',
                 suspension:'Suspension Attack',masquerade:'Masquerade Attack'};
    addIDS('공격 시작: '+(names[mode]||mode),'ids','crit');
  }
  if(typeof vsUpdateMode==='function') vsUpdateMode(mode);
}

function updateStatus(){
  const dot=document.getElementById('statusDot');
  const txt=document.getElementById('statusTxt');
  if(!running){dot.className='dot stopped';txt.textContent='Stopped';return;}
  if(activeAtk==='none'){dot.className='dot running';txt.textContent='Running — Normal';}
  else{dot.className='dot atk';txt.textContent='Running — '+
    {flood:'Flooding',spoof:'Spoofing',fuzz:'Fuzzing',malfunc:'Malfunction',
     replay:'Replay',busoff:'Bus-Off',suspension:'Suspension',masquerade:'Masquerade'}[activeAtk];}
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
  if(activeAtk!=='none'){
    const names={flood:'DoS Flooding',spoof:'Speed Spoofing',fuzz:'Data Fuzzing (real)',
                 malfunc:'Malfunction Injection (real)',replay:'Replay Attack',busoff:'Bus-Off Attack'};
    addIDS('공격 모드 활성 상태로 시작: '+(names[activeAtk]||activeAtk),'ids','crit');
  }
  simInterval=setInterval(simTick, 200);
}

function stopSim(){
  running=false;
  clearInterval(simInterval);
  // 캡처 중이었다면 타이머 취소 후 자동 저장
  if(captureTimerId){ clearTimeout(captureTimerId); captureTimerId=null; }
  if(captureCountdownId){ clearInterval(captureCountdownId); captureCountdownId=null; }
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
  tick=0;simuTime=0;niIdx=0;aiIdx=0;fiIdx=0;miIdx=0;
  cntTotal=0;cntNormal=0;cntAtk=0;cntAnom=0;idsEventCount=0;
  shownRows=[];prevData={};seenIds.clear();capturedFrames=[];
  busHistory=Array(80).fill(0);atkHistory=Array(80).fill(0);
  // 새 상태 변수 초기화
  dynIdIdx=0; replayStore=[]; riIdx=0; busoffEcus.clear();
  suspensionPhase=0; masqTargetIdx=0;
  // IPS 초기화
  stopIPS(); hideIPS();
  // dynState 초기화
  if(typeof dynState!=='undefined'){
    dynState.speed=80;dynState.speedTarget=80;
    dynState.steer=0;dynState.steerTarget=0;
    dynState.rpm=2200;dynState.throttle=30;
    dynState.epsL=128;dynState.epsR=128;
    dynState.cgwCnt=0;dynState.seq=0;
  }
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
   CAPTURE & EXPORT (15초 자동)
   ══════════════════════════════════════ */
function toggleCapture(){
  if(!running) return;
  if(!isCapturing){
    // ── 캡처 시작 (15초 자동) ──
    isCapturing=true;
    captureBuffer=[];
    captureStartTs=simuTime;
    let remaining=CAPTURE_DURATION_SEC;

    const btn=document.getElementById('captureBtn');
    btn.textContent=`⏹ ${remaining}s`;
    btn.className='btn capture-on';
    const badge=document.getElementById('captureBadge');
    badge.className='capture-badge active';
    badge.innerHTML='<span class="rec-dot"></span><span id="captureCount" style="font-family:var(--mono)">0 frames</span>';
    addIDS(`캡처 시작 — ${CAPTURE_DURATION_SEC}초 자동 수집 중`,'sys','info');

    // 카운트다운 UI
    captureCountdownId=setInterval(()=>{
      remaining--;
      const b=document.getElementById('captureBtn');
      if(b && isCapturing) b.textContent=`⏹ ${remaining}s`;
      if(remaining<=0){ clearInterval(captureCountdownId); captureCountdownId=null; }
    },1000);

    // 15초 후 자동 종료
    captureTimerId=setTimeout(()=>{ if(isCapturing) autoStopCapture(); }, CAPTURE_DURATION_SEC*1000);

  } else {
    // ── 수동 조기 중지 ──
    if(captureTimerId){ clearTimeout(captureTimerId); captureTimerId=null; }
    if(captureCountdownId){ clearInterval(captureCountdownId); captureCountdownId=null; }
    autoStopCapture();
  }
}

function autoStopCapture(){
  isCapturing=false;
  if(captureTimerId){ clearTimeout(captureTimerId); captureTimerId=null; }
  if(captureCountdownId){ clearInterval(captureCountdownId); captureCountdownId=null; }
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
  addIDS(`캡처 완료 — ${captureBuffer.length}개 프레임 수집, 저장 중...`,'sys','ok');
  downloadCapture();
}

function downloadCapture(){
  // 원본 OTIDS 포맷으로 출력:
  // timestamp,ArbID,DLC,B0,B1,...,BN,Label
  const BASE_TS=1513920459.0; // 원본 데이터셋 기준 타임스탬프
  const modeLabel={none:'Normal',flood:'Flooding (OTIDS)',spoof:'Spoofing (sim)',
    fuzz:'Fuzzing (OTIDS)',malfunc:'Malfunction (OTIDS)',
    replay:'Replay Attack (sim)',busoff:'Bus-Off Attack (sim)'}[activeAtk]||activeAtk;
  const header=[
    '# CAN Bus Capture — Hyundai Sonata Simulator',
    '# Attack mode: '+modeLabel,
    '# Captured frames: '+captureBuffer.length,
    '# Capture duration: '+((captureBuffer[captureBuffer.length-1].ts - captureBuffer[0].ts)).toFixed(3)+'s',
    '# Format: timestamp,ArbID,DLC,B0,B1,...,BN,Label',
    '# Labels: R=Normal  T=Flooding  S=Spoofing  F=Fuzzing  P=Replay  B=Bus-Off',
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
  const atkLabel={none:'normal',flood:'flooding',spoof:'spoofing',fuzz:'fuzzing',
    malfunc:'malfunction',replay:'replay',busoff:'busoff'}[activeAtk]||'capture';
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
   IPS — INTRUSION PREVENTION SYSTEM
   ══════════════════════════════════════ */

const IPS_PLAYBOOK = {
  flood:{
    name:'DoS Flooding Attack',color:'var(--red)',icon:'⚡',
    threat:'버스 포화 공격 — ID=0x0000, 500+ 프레임/초 대량 주입',
    result:'총 차단 프레임: 2,847개. Bus Load 72% → 12% 복원. Rate-limiter 규칙 영구 등록.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'ID=0x0000 flooding 패턴 감지 — 버스 부하 72%, 정상 ECU 응답 지연 (>50ms) 확인'},
      {icon:'📊',phase:'ANALYZE',text:'단위시간 내 동일 ID 반복 횟수: 523회/초 (임계값: 50회/초 초과, 비율: 1046%)'},
      {icon:'🚧',phase:'FILTER',text:'Rate-limiter 적용: ID=0x0000 프레임 전송 속도를 초당 5회로 제한 → 나머지 차단'},
      {icon:'🛡️',phase:'BLOCK',text:'CAN 게이트웨이에 영구 필터링 규칙 등록 — 차단된 flood 프레임: 2,847개'},
      {icon:'🔄',phase:'RESTORE',text:'버스 부하 정상화: 72% → 12%. 정상 ECU 트래픽(0x0316, 0x0350 등) 응답 복원'},
      {icon:'✅',phase:'COMPLETE',text:'시스템 복원 완료 — 공격 소스 격리, 정상 500Kbps CAN 버스 트래픽 재개'},
    ]
  },
  spoof:{
    name:'Speed Spoofing Attack',color:'var(--purple)',icon:'🎭',
    threat:'속도 위장 공격 — 0x0316 ECU 위장, 200km/h+ 가짜 속도값 주입',
    result:'가짜 0x0316 프레임 전량 차단. 실제 속도값(72.3 km/h)으로 계기 복원. 속도 범위 필터 영구 적용.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'0x0316 프레임 속도값 이상 감지: 237.4 km/h (물리적 한계 200 km/h 초과)'},
      {icon:'📐',phase:'ANALYZE',text:'다중 ECU 교차 검증 — TCM(0x0545) 추정속도 72 km/h vs 0x0316 신고속도 237 km/h (165 km/h 불일치)'},
      {icon:'🔬',phase:'VERIFY',text:'바이트 시그니처 검증: B0=0x46 (정상 ECU 고유값: 0x45) — 가짜 ECU 발신 확인'},
      {icon:'🚧',phase:'FILTER',text:'속도 범위 필터 활성화: 200 km/h 초과 0x0316 프레임 전량 차단 (Zero Trust 적용)'},
      {icon:'🔄',phase:'RESTORE',text:'마지막 유효 속도값(72.3 km/h) 기반 ECU 복원. 차량 제어 시스템(ABS, ESP) 재동기화'},
      {icon:'✅',phase:'COMPLETE',text:'복원 완료 — 속도 계기 정상화, 가짜 0x0316 프레임 차단. B0 시그니처 기반 인증 강제'},
    ]
  },
  fuzz:{
    name:'Data Fuzzing Attack',color:'var(--orange)',icon:'🔀',
    threat:'무작위 ID 주입 — 알 수 없는 Arb ID 500+ 종류 출현, 버스 오염',
    result:'알 수 없는 ID 프레임 전량 차단 (2,134개). ECU 화이트리스트 기반 필터 영구 적용.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'미등록 Arb ID 출현: 0x07B1, 0x0032, 0x039D ... (화이트리스트 위반 87개/초)'},
      {icon:'📋',phase:'ANALYZE',text:'ECU 화이트리스트 조회: 17개 허용 ID 외 모두 불법. 랜덤 패턴 → Fuzzing 공격 확정 (OTIDS 시그니처 매치)'},
      {icon:'🛡️',phase:'FILTER',text:'CAN 버스 ID 화이트리스트 필터 활성화 — 등록되지 않은 모든 Arb ID 드롭 시작'},
      {icon:'🔒',phase:'BLOCK',text:'침입 차단 완료: 알 수 없는 ID 프레임 2,134개 폐기. 화이트리스트 17개 ECU만 통신 허용'},
      {icon:'✅',phase:'COMPLETE',text:'복원 완료 — 화이트리스트 필터 영구 적용, 버스 정상화. OTIDS T 레이블 프레임 0개'},
    ]
  },
  malfunc:{
    name:'Malfunction Injection Attack',color:'#fdc800',icon:'⚠',
    threat:'ECU 오작동 유도 — 0x0316/0x043F OTIDS 이상 신호 반복 주입',
    result:'오작동 시그니처 차단 완료. ECU 소프트 리셋 후 정상 신호 복원. OTIDS T 레이블 프레임 0개.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'0x0316 오작동 패턴: B1=0x29, B3=0xFF (비정상 조합) — OTIDS Malfunction 시그니처 감지'},
      {icon:'📊',phase:'ANALYZE',text:'ML 분류기 결과: 현재 프레임 Malfunction 패턴 매치 99.7%. 동일 패턴 연속 43회 확인'},
      {icon:'🔒',phase:'ISOLATE',text:'0x0316 / 0x043F ECU 임시 격리 — 마지막 유효 값(속도 88.5 km/h)으로 fallback 유지'},
      {icon:'🔄',phase:'RECOVER',text:'ECU 소프트 리셋 명령 전송 (UDS 0x11 서비스) — 0x0316 재기동 시퀀스 실행 중 (3.2초)'},
      {icon:'✅',phase:'COMPLETE',text:'ECU 재기동 완료 — 정상 시그니처(B1≤0x28, B3≠0xFF) 확인. 오작동 신호 소멸'},
    ]
  },
  replay:{
    name:'Replay Attack',color:'var(--teal)',icon:'🔁',
    threat:'이전 캡처 프레임 재주입 — 타임스탬프 불일치, ECU 카운터 고정',
    result:'롤링 카운터 인증 강제 적용. 재생 프레임 전량 폐기. 타임스탬프 시퀀스 재확립.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'타임스탬프 시퀀스 이상: 동일 페이로드가 +2.4초 후 재등장 — P 레이블 프레임 확인'},
      {icon:'🔢',phase:'ANALYZE',text:'CGW 롤링 카운터(0x0002) 분석: 현재 카운터 값이 예상 시퀀스보다 -17 뒤처짐 (오래된 프레임 증거)'},
      {icon:'⏱️',phase:'VERIFY',text:'0x0316 속도값 "frozen" 검증: 현재 ECU 기대값 84.2 km/h vs 재생값 73.5 km/h (10.7 km/h 불일치)'},
      {icon:'🛡️',phase:'FILTER',text:'롤링 카운터 기반 인증 강제: 카운터 불일치 프레임 전량 차단. 재생 창(window) 5초로 제한'},
      {icon:'🔄',phase:'RESTORE',text:'카운터 동기화 재확립 — 각 ECU 최신 롤링 카운터 학습. 스테일 프레임 전량 폐기'},
      {icon:'✅',phase:'COMPLETE',text:'복원 완료 — 타임스탬프+롤링카운터 이중 인증 활성화. 재생 공격 완전 차단'},
    ]
  },
  busoff:{
    name:'Bus-Off Attack',color:'var(--busoff)',icon:'💀',
    threat:'ECU 강제 격리 — 에러 프레임 반복으로 TEC 초과, 엔진/조향 ECU Bus-Off',
    result:'공격 노드 격리 완료. Bus-Off ECU 전원 재기동. CAN 버스 정상 복귀.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'에러 프레임 버스트 감지: 0x0350 TEC 223/255 — Bus-Off 임박 (임계값 255 초과 시 격리)'},
      {icon:'📊',phase:'ANALYZE',text:'에러 프레임 발생 패턴: 20ms 주기로 동일 ECU(0x0350, 0x0329) 반복 타겟 — 의도적 주입 확인'},
      {icon:'🔒',phase:'ISOLATE',text:'공격 노드 격리: 에러 프레임 발생 포트 비활성화. TEC 카운터 리셋 명령 전송'},
      {icon:'🔄',phase:'RECOVER',text:'Bus-Off 상태 ECU 강제 복구: 128 recessive bits 시퀀스 전송 → Bus-Off 해제 시도'},
      {icon:'🔧',phase:'RESTART',text:'타겟 ECU 전원 재기동 완료: 0x0350, 0x0329, 0x0130 — 정상 프레임 재등장 확인'},
      {icon:'✅',phase:'COMPLETE',text:'Bus-Off 공격 완전 차단 — 에러 카운터 리셋, 모든 ECU 정상 운영 재개'},
    ]
  },
  suspension:{
    name:'Suspension Attack',color:'var(--suspension)',icon:'🚗',
    threat:'ECS(전자제어 서스펜션) 이상값 주입 — 차체 진동·라이드하이트 급변',
    result:'비정상 ECS 프레임 전량 차단. Fail-safe 모드 → 적응형 제어 복원. 차체 안정화 완료.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'ECS ECU(0x0236) 댐퍼값 이상: 범위 0→255 급격 진동 (정상 범위: 80~180). AirSusp(0x05B0) 동시 이상'},
      {icon:'📐',phase:'ANALYZE',text:'변화율 분석: 200ms 이내 댐퍼 압력 175 units 변동 (물리 한계: 32 units/200ms) — 5.5배 초과'},
      {icon:'🚧',phase:'FILTER',text:'비정상 주기 패턴 차단: 8ms 간격 초고속 서스펜션 명령 드롭 (정상 주기: 100ms 이상)'},
      {icon:'🔒',phase:'SAFE',text:'Fail-safe 서스펜션 모드 전환 — 기본 감쇠력 고정(하드 스프링), 라이드하이트 70mm 유지'},
      {icon:'🔄',phase:'RESTORE',text:'ECS 정상 교정값으로 점진 복원: 차속·하중 기반 적응형 댐퍼 제어 재개 (3.8초 소요)'},
      {icon:'✅',phase:'COMPLETE',text:'서스펜션 시스템 완전 복원 — 차체 안정성 회복, 승차감 정상화. ECS 검증 로직 강화'},
    ]
  },
  masquerade:{
    name:'Masquerade Attack',color:'var(--masquerade)',icon:'🕵️',
    threat:'ECU 정체 위장 — 합법적 Arb ID로 악성 데이터 주입, 기존 IDS 탐지 회피',
    result:'물리 레이어 핑거프린트 인증 적용. 위장 프레임 전량 차단. 정품 ECU 통신 복원.',
    steps:[
      {icon:'🔍',phase:'DETECT',text:'ECU 타이밍 핑거프린트 이상: 0x0316 전송 주기 14ms (정상: 22ms) — 비정상 가속 감지'},
      {icon:'🔬',phase:'ANALYZE',text:'바이트 시그니처 분석: B0=0x46 (정상 ECU 고유값: 0x45) — 발신 ECU 불일치 확인'},
      {icon:'⚡',phase:'VERIFY',text:'CAN 물리 레이어 분석: rise time 3.2ns (정품 ECU: 2.1ns) — 다른 하드웨어 발신 확정'},
      {icon:'🚧',phase:'BLOCK',text:'위장 프레임 차단 규칙 적용: 핑거프린트 불일치 프레임 드롭, 정품 ECU 인증 우선 처리'},
      {icon:'🔄',phase:'RESTORE',text:'인증 ECU 목록 재확인 — 정품 0x0316, 0x0350, 0x0140 ECU 신호 정상 수신 확인'},
      {icon:'✅',phase:'COMPLETE',text:'위장 공격 완전 차단 — 타이밍+시그니처+물리 레이어 3중 인증 강제. 정품 ECU만 허용'},
    ]
  },
};

function activateIPS(){
  if(activeAtk==='none'){
    addIDS('IPS: 현재 공격 없음 — 공격 모드를 선택 후 IPS를 활성화하세요','ips','warn');
    return;
  }
  if(ipsActive) return; // 이미 실행 중
  const playbook=IPS_PLAYBOOK[activeAtk];
  if(!playbook){
    addIDS('IPS: 이 공격 유형에 대한 플레이북이 없습니다','ips','warn');
    return;
  }

  ipsActive=true;
  ipsCurrentAtk=activeAtk;
  ipsStep=0;

  // IPS 버튼 상태 변경
  const btn=document.getElementById('ipsBtn');
  if(btn){ btn.className='btn ips-active'; btn.textContent='🛡️ IPS 실행 중...'; btn.disabled=true; }

  // IPS 패널 표시
  showIPS(playbook);
  addIDS('=== IPS 활성화 — '+playbook.name+' 차단 시퀀스 시작 ===','ips','info');

  // 단계별 실행
  runIPSSteps(playbook);
}

function showIPS(playbook){
  const panel=document.getElementById('ipsPanel');
  if(!panel) return;
  panel.style.display='';
  panel.scrollIntoView({behavior:'smooth', block:'start'});

  document.getElementById('ipsThreatIcon').textContent=playbook.icon;
  document.getElementById('ipsThreatName').textContent=playbook.name;
  document.getElementById('ipsThreatDesc').textContent=playbook.threat;
  document.getElementById('ipsStatusBadge').textContent='ANALYZING...';
  document.getElementById('ipsStatusBadge').className='ips-status-badge analyzing';
  document.getElementById('ipsResult').style.display='none';
  document.getElementById('ipsProgressFill').style.width='0%';
  document.getElementById('ipsProgressPct').textContent='0%';
  document.getElementById('ipsProgressLabel').textContent='0 / '+playbook.steps.length+' 단계';

  // 단계 목록 초기화
  const list=document.getElementById('ipsStepsList');
  list.innerHTML=playbook.steps.map((s,i)=>`
    <div class="ips-step pending" id="ips_step_${i}">
      <div class="ips-step-icon">${s.icon}</div>
      <div class="ips-step-body">
        <div class="ips-step-phase ${s.phase.toLowerCase()}">${s.phase}</div>
        <div class="ips-step-text">${s.text}</div>
        <div class="ips-step-status" id="ips_status_${i}" style="display:none"></div>
      </div>
    </div>`).join('');

  // 약간 딜레이 후 step 0 보이기
  setTimeout(()=>{
    const el=document.getElementById('ips_step_0');
    if(el) el.classList.add('visible');
  }, 100);
}

function runIPSSteps(playbook){
  const steps=playbook.steps;
  const total=steps.length;

  steps.forEach((step, idx)=>{
    const delay=400 + idx*900;
    setTimeout(()=>{
      if(!ipsActive || ipsCurrentAtk!==activeAtk) return;

      // 이전 단계 done으로
      if(idx>0){
        const prev=document.getElementById('ips_step_'+(idx-1));
        if(prev){ prev.className='ips-step visible done'; }
        const prevSt=document.getElementById('ips_status_'+(idx-1));
        if(prevSt){ prevSt.textContent='✓ 완료'; prevSt.className='ips-step-status ok'; prevSt.style.display=''; }
      }

      // 현재 단계 active
      const cur=document.getElementById('ips_step_'+idx);
      if(cur){ cur.className='ips-step visible active'; }
      const curSt=document.getElementById('ips_status_'+idx);
      if(curSt){ curSt.textContent='⟳ 실행 중...'; curSt.className='ips-step-status running'; curSt.style.display=''; }

      // 다음 단계 visible (미리 보이기)
      if(idx+1<total){
        const next=document.getElementById('ips_step_'+(idx+1));
        if(next) next.classList.add('visible');
      }

      // 진행률 업데이트
      const pct=Math.round(((idx+1)/total)*100);
      document.getElementById('ipsProgressFill').style.width=pct+'%';
      document.getElementById('ipsProgressPct').textContent=pct+'%';
      document.getElementById('ipsProgressLabel').textContent=(idx+1)+' / '+total+' 단계';

      // ANALYZING → MITIGATING
      if(idx===1){
        document.getElementById('ipsStatusBadge').textContent='MITIGATING...';
        document.getElementById('ipsStatusBadge').className='ips-status-badge mitigating';
      }

      // IDS 로그에 단계별 메시지
      addIDS('[IPS] '+step.phase+': '+step.text.substring(0,60)+'...','ips','info');

      // 마지막 단계 완료 처리
      if(idx===total-1){
        setTimeout(()=>completeIPS(playbook, total), 700);
      }
    }, delay);
  });
}

function completeIPS(playbook, total){
  if(!ipsActive) return;

  // 마지막 단계 done
  const last=document.getElementById('ips_step_'+(total-1));
  if(last) last.className='ips-step visible done';
  const lastSt=document.getElementById('ips_status_'+(total-1));
  if(lastSt){ lastSt.textContent='✓ 완료'; lastSt.className='ips-step-status ok'; lastSt.style.display=''; }

  // 상태 배지 COMPLETE
  document.getElementById('ipsProgressFill').style.width='100%';
  document.getElementById('ipsProgressPct').textContent='100%';
  document.getElementById('ipsProgressLabel').textContent=total+' / '+total+' 단계';
  document.getElementById('ipsStatusBadge').textContent='✓ SECURED';
  document.getElementById('ipsStatusBadge').className='ips-status-badge complete';

  // 결과 표시
  document.getElementById('ipsResultDetail').textContent=playbook.result;
  document.getElementById('ipsResult').style.display='flex';

  // IDS 성공 메시지
  addIDS('=== IPS 완료 — '+playbook.name+' 차단 성공. 시스템 정상 복원 ===','ips','ok');

  // 공격 모드를 Normal로 복원
  setTimeout(()=>{
    setAtk('none');
    addIDS('IPS: 공격 모드 해제 → Normal 모드 복원','ips','ok');
  }, 800);

  // 버튼 상태 완료
  const btn=document.getElementById('ipsBtn');
  if(btn){ btn.className='btn ips-done'; btn.textContent='✓ IPS 완료'; btn.disabled=false; }

  ipsActive=false;
}

function stopIPS(){
  ipsActive=false;
  if(ipsInterval){ clearInterval(ipsInterval); ipsInterval=null; }
  const btn=document.getElementById('ipsBtn');
  if(btn){ btn.className='btn ips-idle'; btn.textContent='🛡️ IPS'; btn.disabled=false; }
}

function hideIPS(){
  const panel=document.getElementById('ipsPanel');
  if(panel) panel.style.display='none';
  const btn=document.getElementById('ipsBtn');
  if(btn){ btn.className='btn ips-idle'; btn.textContent='🛡️ IPS'; btn.disabled=false; }
}

/* ══════════════════════════════════════
   INIT
   ══════════════════════════════════════ */
buildVehGrid();
buildECUStatus();
buildDiffTable();
initChart();
// vsInit() is called from visualizer.js after DOMContentLoaded
