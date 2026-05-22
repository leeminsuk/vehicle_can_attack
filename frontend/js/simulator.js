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
  const pool = replayStore.length > 0 ? replayStore : SONATA_DATA.normal;
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
    const isAtk=f.label==='T'||f.label==='S'||f.label==='F'||f.label==='P'||f.label==='B';
    const rowCls=f.label==='T'?'row-t':f.label==='S'?'row-spoof':f.label==='F'?'row-fuzz':
                 f.label==='P'?'row-replay':f.label==='B'?'row-busoff':'row-r new-frame';
    const prev=prevData[f.id];
    const changed=prev ? f.data.map((b,i)=>b!==prev[i]?i:-1).filter(i=>i>=0) : [];
    const atkCls=f.label==='F'?'fuzz':f.label==='S'?'injected':
                 f.label==='P'?'injected':f.label==='B'?'fuzzed':'changed';
    const bytes=Array(8).fill(0).map((_,i)=>i<f.dlc ? `<td><span class="byte-cell${isAtk&&changed.includes(i)?' '+atkCls:''}">${h2(f.data[i])}</span></td>` : '<td style="color:var(--text3)">—</td>');
    const lblCls=f.label==='T'?'lbl-T':f.label==='S'?'lbl-S':f.label==='F'?'lbl-F':
                 f.label==='P'?'lbl-P':f.label==='B'?'lbl-B':'lbl-R';
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
    const atkClass=frame.label==='F'?'fuzzed':frame.label==='S'||frame.label==='P'?'injected':
                   frame.label==='B'?'fuzzed':'changed';
    curEl.innerHTML=cur.map((b,i)=>`<span class="byte-cell${changed.includes(i)?' '+atkClass:''}" style="font-size:10px">${h2(b)}</span>`).join(' ');
    const n=changed.length;
    if(rowEl) rowEl.className='diff-row'+(n>0?(frame.label==='F'?' fuzz-row':frame.label==='S'?' spoof-row':
      frame.label==='P'?' replay-row':frame.label==='B'?' busoff-row':' changed-row'):'');
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
                activeAtk==='busoff'?5+Math.round(Math.random()*8): // 버스 사용률 급감
                10+Math.round(Math.random()*6);
  const fps=activeAtk==='flood'?700+Math.round(Math.random()*300):
            activeAtk==='spoof'?55+Math.round(Math.random()*15):
            activeAtk==='fuzz'?80+Math.round(Math.random()*40):
            activeAtk==='malfunc'?50+Math.round(Math.random()*20):
            activeAtk==='replay'?48+Math.round(Math.random()*12):
            activeAtk==='busoff'?15+Math.round(Math.random()*10): // ECU 격리로 감소
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
                   activeAtk==='busoff'?'rgba(255,123,114,0.4)':'rgba(63,185,80,0.15)';
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
    // 정상 1개 + replay 주입 (40% 확률)
    for(let i=0;i<2;i++){
      const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
      frames.push(makeDynFrame(nid, simuTime));
    }
    if(Math.random()<0.45) frames.push(makeReplayFrame(simuTime));
  } else if(activeAtk==='busoff'){
    // Bus-Off되지 않은 ECU만 정상 프레임 생성
    const nid=NORMAL_ID_CYCLE[dynIdIdx%NORMAL_ID_CYCLE.length]; dynIdIdx++;
    if(!busoffEcus.has(nid)) frames.push(makeDynFrame(nid, simuTime));
    frames.push(makeBusOffFrame(simuTime));
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
  }

  if(tick%8===0) updateMetrics();
}

/* ══════════════════════════════════════
   ATK MODE
   ══════════════════════════════════════ */
function setAtk(mode){
  activeAtk=mode;
  // Bus-Off 모드 전환 시 격리 ECU 초기화
  if(mode!=='busoff') busoffEcus.clear();
  ['none','flood','spoof','fuzz','malfunc','replay','busoff'].forEach(m=>{
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
    mode==='busoff'?'rgba(255,123,114,.8)':'var(--text3)';
  updateStatus();
  if(running && mode!=='none'){
    const names={flood:'DoS Flooding',spoof:'Speed Spoofing',fuzz:'Data Fuzzing (real)',
                 malfunc:'Malfunction Injection (real)',replay:'Replay Attack',busoff:'Bus-Off Attack'};
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
     replay:'Replay',busoff:'Bus-Off'}[activeAtk];}
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
   INIT
   ══════════════════════════════════════ */
buildVehGrid();
buildECUStatus();
buildDiffTable();
initChart();
// vsInit() is called from visualizer.js after DOMContentLoaded
