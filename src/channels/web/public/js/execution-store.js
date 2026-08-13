    // ===== Phase 3 — ephemeral execution store (PURE — no DOM) =====
    // One record per executionId (the mission marker from mission_start). Every
    // dynamic socket event reduces into the same record; nothing here is
    // persisted — permanent chat history stays in state.messages. This block is
    // delimited so verification can extract and unit-test it without a DOM.
    const executionStore={executions:new Map(),currentId:null};
    // version bumps on every applied event so the render layer can skip cards
    // whose execution has not changed (per-card dirty tracking instead of
    // re-rendering every mounted card on every socket event).
    function createExecution(id,event){return{id,scope:{projectId:String(event?.projectId||''),conversationId:String(event?.conversationId||'')},status:'running',startedAt:Date.now(),endedAt:null,currentTask:'',activeToolId:null,tools:[],agents:[],progress:null,artifacts:[],terminal:'',latestError:null,recoveryPhase:null,recoveryPhases:[],version:0,lastEventAt:Date.now(),runIds:[]}}
    function findTool(execution,toolCallId){return execution.tools.find(t=>t.id===toolCallId)}
    // Human work status for ONE execution — derived ONLY from real lifecycle
    // events (mission/tool/status), never from invented model reasoning.
    // Returns {state, label}: state drives the icon/animation class, label is
    // the user-facing "what Gitu is doing right now" line. Map of tool-name
    // fragments -> action phrases keeps the label an ACTION, not a tool name.
    const WORK_ACTION_HINTS={shell:['Running commands','Running tests','Verifying changes'],patch:['Applying changes','Editing files'],edit:['Applying changes','Editing files'],search:['Searching repository','Searching sources'],read:['Reading files','Inspecting code'],write:['Writing files'],test:['Running tests','Verifying changes'],playwright:['Checking the page'],browser:['Checking the page'],delegate:['Coordinating agents'],agent:['Coordinating agents'],project:['Updating the project'],memory:['Recalling project context'],skill:['Running a learned skill'],analy:['Analyzing dependencies'],web:['Researching sources'],research:['Researching sources']};
    function workLabelForTool(tool){const name=String(tool?.name||'').toLowerCase();for(const key of Object.keys(WORK_ACTION_HINTS)){if(name.includes(key))return WORK_ACTION_HINTS[key][0]}return tool?.label&&tool.label!==tool.name?String(tool.label):`Running ${String(tool?.name||'tool')}`}
    function executionWork(ex){
      if(!ex)return{state:'idle',label:'Ready'};
      if(ex.status==='completed')return{state:'completed',label:ex.tools.length?`Completed · ${ex.tools.filter(t=>t.status!=='running').length} tools`:'Completed'};
      if(ex.status==='failed')return{state:'failed',label:'Failed — unable to complete'};
      if(ex.status==='cancelled')return{state:'stopped',label:'Stopped'};
      if(ex.status==='blocked')return{state:'blocked',label:'Blocked — needs attention'};
      // running: the active tool is the dominant state; otherwise the current
      // task narration; otherwise a calm thinking placeholder.
      const active=ex.tools.find(t=>t.id===ex.activeToolId);
      if(active)return{state:'tool',label:workLabelForTool(active)};
      const task=String(ex.currentTask||'').trim();
      if(task)return{state:'working',label:task.slice(0,80)};
      return{state:'thinking',label:'Planning approach'};
    }
    function reduceExecution(execution,event){
      // Mission-level progress (progressPct) rides every mission event so the
      // ExecutionCard's bar tracks the backend's canonical estimate.
      if(event.progressPct!=null)execution.progress=Math.max(0,Math.min(100,Number(event.progressPct)));
      if(event.type==='mission_start'){execution.status='running';execution.startedAt=Date.now();return execution}
      if(event.type==='mission_end'){execution.status=event.status==='cancelled'?'cancelled':event.status==='failed'?'failed':event.status==='blocked'?'blocked':'completed';execution.endedAt=Date.now();return execution}
      if(event.type==='assistant_update'){if(event.text)execution.currentTask=String(event.text).slice(0,160);return execution}
      if(event.type==='assistant_error'){execution.latestError=String(event.error||event.text||'Unexpected error');execution.status='failed';return execution}
      if(event.type==='assistant_stopped'){execution.status='cancelled';execution.endedAt=Date.now();return execution}
      if(event.type==='recovery'){execution.recoveryPhase=event.phase||null;if(event.text)execution.currentTask=String(event.text).slice(0,160);if(event.phase)execution.recoveryPhases.push({phase:event.phase,at:Date.now(),text:String(event.text||'').slice(0,200)});return execution}
      if(event.type==='stream_chunk'){execution.terminal=(execution.terminal+String(event.chunk||'')).slice(-20000);return execution}
      if(event.type==='media'){execution.artifacts.unshift({caption:event.caption||event.filename||'Artifact',filename:event.filename||'',url:event.url||''});return execution}
      if(event.type==='tool_start'){
        const t=findTool(execution,event.toolCallId);
        if(t){t.status='running';if(event.label)t.label=event.label}
        else{execution.tools.push({id:event.toolCallId,name:event.name,label:event.label||event.name,status:'running',output:'',error:null,startedAt:Date.now(),endedAt:null})}
        execution.activeToolId=event.toolCallId;
        if(String(event.name||'').toLowerCase().includes('delegate')){execution.agents.push({id:event.toolCallId,name:event.name,status:'running'})}
        return execution;
      }
      if(event.type==='tool_delta'){
        const t=findTool(execution,event.toolCallId);
        if(t&&event.output)t.output=(t.output+String(event.output)).slice(-6000);
        return execution;
      }
      if(event.type==='tool_done'){
        const t=findTool(execution,event.toolCallId);
        if(t){t.status=event.status==='failed'?'failed':'completed';t.error=event.error||null;t.endedAt=Date.now();if(event.output)t.output=(t.output?t.output+'\n\n':'')+String(event.output).slice(0,3000)}
        if(event.status==='failed')execution.latestError=String(event.error||`${event.name||'tool'} failed`);
        if(execution.activeToolId===event.toolCallId)execution.activeToolId=null;
        const agent=execution.agents.find(a=>a.id===event.toolCallId);
        if(agent)agent.status=event.status==='failed'?'failed':'completed';
        return execution;
      }
      return execution;
    }
    function applyExecutionEvent(store,event){
      const id=event.executionId;
      if(!id)return null;
      if(!store.executions.has(id))store.executions.set(id,createExecution(id,event));
      store.currentId=id;
      const execution=store.executions.get(id);
      reduceExecution(execution,event);
      // Every runId observed for THIS execution is recorded so the summary
      // layer can bind a persisted snapshot to the assistant message that
      // actually belongs to this mission (never a neighbor's message).
      if(event.runId&&!execution.runIds.includes(String(event.runId)))execution.runIds.push(String(event.runId));
      execution.version=(execution.version||0)+1;
      execution.lastEventAt=Date.now();
      if(store.executions.size>20){const oldest=store.executions.keys().next().value;store.executions.delete(oldest)}
      scheduleExecutionRender();
      return execution;
    }
    // ===== /execution store =====
