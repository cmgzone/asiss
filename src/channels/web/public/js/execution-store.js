    // ===== Phase 3 — ephemeral execution store (PURE — no DOM) =====
    // One record per executionId (the mission marker from mission_start). Every
    // dynamic socket event reduces into the same record; nothing here is
    // persisted — permanent chat history stays in state.messages. This block is
    // delimited so verification can extract and unit-test it without a DOM.
    const executionStore={executions:new Map(),currentId:null};
    function createExecution(id,event){return{id,scope:{projectId:String(event?.projectId||''),conversationId:String(event?.conversationId||'')},status:'running',startedAt:Date.now(),endedAt:null,currentTask:'',activeToolId:null,tools:[],agents:[],progress:null,artifacts:[],terminal:'',latestError:null,recoveryPhase:null,recoveryPhases:[]}}
    function findTool(execution,toolCallId){return execution.tools.find(t=>t.id===toolCallId)}
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
      if(store.executions.size>20){const oldest=store.executions.keys().next().value;store.executions.delete(oldest)}
      scheduleExecutionRender();
      return execution;
    }
    // ===== /execution store =====
