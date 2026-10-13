// Deterministic local test fixture. Never use for live acceptance.
import http from 'node:http';
export async function recordedProvider() {
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const p=JSON.parse(raw);
    let message;
    if(p.tool_choice==='required') message={role:'assistant',content:null,tool_calls:p.tools.map((tool,index)=>({id:'fixture-'+index,type:'function',function:{name:tool.function.name,arguments:tool.function.name==='get_exercise_context'?JSON.stringify({date:JSON.parse(p.messages[1].content).date}):'{}'}}))};
    else {
      const replies=p.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content).data);
      let candidateIds=[];
      for(const data of replies){
        if(data?.evaluations)candidateIds=data.evaluations.filter(item=>item.projectId==='project-sea-mud'&&item.outcome==='allow').map(item=>item.projectId);
        if(data?.candidates)candidateIds=data.candidates.map(item=>item.candidateId);
        if(data?.activities)candidateIds=data.activities.filter(item=>item.projectId==='stage2-indoor-exercise').map(item=>item.projectId);
        if(data?.resources)candidateIds=data.resources.filter(item=>item.audioUrl).slice(0,1).map(item=>item.id);
      }
      const payload=p.messages[0].content.includes('adoptedCandidateIds')
        ? {selectedCandidateIds:JSON.parse(p.messages[1].content).adoptedCandidateIds} : {candidateIds};
      message={role:'assistant',content:JSON.stringify(payload)};
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'recorded-stage3b',model:'local-recorded-fixture',choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:50}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
