/* ══════════════════════════════════════
   AI ANALYSIS PANEL
   ══════════════════════════════════════ */

function onApiKeyChange(){
  const key=document.getElementById('aiKeyInput').value.trim();
  if(key)localStorage.setItem('vs_oai_key',key);
  const btn=document.getElementById('aiAnalyzeBtn');
  if(btn)btn.disabled=!key;
}

function toggleKeyVis(){
  const inp=document.getElementById('aiKeyInput');
  const chk=document.getElementById('aiVisCheck');
  if(inp)inp.type=chk&&chk.checked?'text':'password';
}

function clearAiHistory(){
  const area=document.getElementById('aiResponseArea');
  if(!area)return;
  area.innerHTML='';
  addAIBubble('\u{1F511} 기록이 지워졌습니다. API 키를 입력하고 Analyze를 눌러 분석을 시작하세요.','sys');
}

function addAIBubble(text,type='ai'){
  const area=document.getElementById('aiResponseArea');
  if(!area)return null;
  const div=document.createElement('div');
  div.className='ai-bubble '+type;
  div.textContent=text;
  area.appendChild(div);
  area.scrollTop=area.scrollHeight;
  return div;
}

function addAITyping(){
  const area=document.getElementById('aiResponseArea');
  if(!area)return null;
  const typingRow=document.createElement('div');
  typingRow.className='ai-typing-row';
  typingRow.innerHTML='<div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div>';
  area.appendChild(typingRow);
  area.scrollTop=area.scrollHeight;
  return typingRow;
}

async function analyzeWithAI(){
  const key=document.getElementById('aiKeyInput').value.trim();
  const model=document.getElementById('aiModel').value;
  const lang=document.getElementById('aiLang').value;
  const btn=document.getElementById('aiAnalyzeBtn');
  if(btn){btn.disabled=true;btn.classList.add('loading');btn.textContent='⏳ Analyzing...';}

  const typingRow=addAITyping();

  const modeNames={none:'Normal (no attack)',flood:'DoS Flooding Attack',spoof:'Speed Spoofing Attack',fuzz:'Data Fuzzing Attack'};
  const attackMode=typeof activeAtk!=='undefined'?activeAtk:'none';
  const busLoad=document.getElementById('m_busload').textContent;
  const fps=document.getElementById('m_fps').textContent;
  const anomalies=document.getElementById('m_anom').textContent;
  const speedVal=document.getElementById('m_speed').textContent;
  const totalFrames=document.getElementById('m_total').textContent;
  const attackFrames=document.getElementById('m_attack').textContent;

  // Determine if we should try backend first
  const useBackend = window.location.protocol !== 'file:' && window.location.hostname !== '';

  let result=null;
  let backendFailed=false;

  if(useBackend){
    try{
      const resp=await fetch('/api/analyze',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({attackMode,busLoad,frameRate:fps,totalFrames,attackFrames,anomalies,speed:speedVal,model,lang})
      });
      if(resp.ok){
        const data=await resp.json();
        if(typingRow&&typingRow.parentNode)typingRow.remove();
        if(data.error){addAIBubble('Backend error: '+data.error.message,'err');}
        else if(data.choices&&data.choices[0]){addAIBubble(data.choices[0].message.content,'ai');}
        else{addAIBubble('Unexpected backend response.','err');}
        result='done';
      } else if(resp.status===503){
        // No API key on server — fall through to client-side
        backendFailed=true;
      } else {
        const errData=await resp.json().catch(()=>({detail:'Unknown error'}));
        if(typingRow&&typingRow.parentNode)typingRow.remove();
        addAIBubble('Backend error '+resp.status+': '+(errData.detail||resp.statusText),'err');
        result='done';
      }
    }catch(e){
      backendFailed=true;
    }
  }

  // Fall back to direct OpenAI call if backend failed/unavailable and user has a key
  if(!result && (backendFailed || !useBackend)){
    if(!key){
      if(typingRow&&typingRow.parentNode)typingRow.remove();
      addAIBubble('API 키가 없습니다. 키를 입력하거나 백엔드 서버를 설정하세요.','err');
    } else {
      const langInstr=lang==='ko'?'반드시 한국어로 답변하세요.':'Reply in English.';
      const prompt=`You are a CAN bus cybersecurity expert analyzing a Hyundai Sonata vehicle network attack simulation.\n\nCurrent state:\n- Attack mode: ${modeNames[attackMode]||attackMode}\n- Bus load: ${busLoad}\n- Frame rate: ${fps} frames/sec\n- Total frames: ${totalFrames}\n- Attack frames: ${attackFrames}\n- IDS anomalies detected: ${anomalies}\n- Vehicle speed (from 0x0316): ${speedVal} km/h\n\nProvide a concise technical analysis (3-5 sentences) covering:\n1. What this attack does to the CAN bus\n2. Observed metrics and what they indicate\n3. Potential real-world vehicle safety impact\n4. One recommended IDS countermeasure\n\n${langInstr}`;
      try{
        const resp=await fetch('https://api.openai.com/v1/chat/completions',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
          body:JSON.stringify({model:model,messages:[{role:'user',content:prompt}],max_tokens:400,temperature:0.7})
        });
        const data=await resp.json();
        if(typingRow&&typingRow.parentNode)typingRow.remove();
        if(data.error){addAIBubble('Error: '+data.error.message,'err');}
        else{addAIBubble(data.choices[0].message.content,'ai');}
      }catch(e){
        if(typingRow&&typingRow.parentNode)typingRow.remove();
        addAIBubble('Network error: '+e.message,'err');
      }
    }
  }

  if(btn){btn.disabled=false;btn.classList.remove('loading');btn.innerHTML='\u{1F50D} Analyze Current Attack with AI';}
}

// Restore API key from localStorage on load
(function() {
  const saved = localStorage.getItem('vs_oai_key');
  if(saved) {
    const inp = document.getElementById('aiKeyInput');
    if(inp) inp.value = saved;
    const btn = document.getElementById('aiAnalyzeBtn');
    if(btn) btn.disabled = false;
  }
})();
