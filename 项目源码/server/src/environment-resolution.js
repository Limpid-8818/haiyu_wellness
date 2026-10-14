import crypto from 'node:crypto';
import {createBusinessClock} from './clock.js';
import {numberOrNull,normalizeProviderInstant,validDate} from './environment-providers.js';

export const ENVIRONMENT_DOMAINS=['weather','tide','marine'];
export function environmentInstant(value,record={}){
  if(value instanceof Date)return Number.isFinite(value.getTime())?value.toISOString():null;
  if(typeof value!=='string'||!value.trim())return null;
  const text=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)?value.replace(' ','T')+'Z':value;
  const date=text.slice(0,10);if(!validDate(date))return null;
  try{return normalizeProviderInstant(text,{timeZone:record.timezone||record.timeZone,utcOffsetSeconds:record.utcOffsetSeconds})}catch{return null}
}
export function environmentQueryMatches(payload,context){
  const q=payload?.queryLocation,l=context.location;
  return Boolean(q&&l&&q.id===l.id&&q.latitude===l.latitude&&q.longitude===l.longitude&&q.timeZone===l.timeZone
    &&payload.sourceMode===context.mode&&(context.mode!=='demo'||q.mockScenario===context.mockScenario)
    &&(context.mode!=='live'||q.tideProvider===context.tideProvider));
}
export function environmentPoint(record,{targetDate,location,instant}){
  if(!record||!location?.timeZone||!validDate(targetDate)||!environmentInstant(instant))return null;
  let clock;try{clock=createBusinessClock({timeZone:location.timeZone,now:()=>new Date(instant)})}catch{return null}
  const today=clock.dateKey(),sameDay=targetDate===today,localTime=`${targetDate}T${sameDay?clock.timeKey().slice(0,2):'12'}:00`;
  const targetInstant=environmentInstant(localTime,{timezone:location.timeZone});
  const rows=Array.isArray(record.hourly)?record.hourly:[];
  const pointClock={...record,timezone:record.timezone||record.queryLocation?.timeZone||location.timeZone};
  const row=rows.find(r=>environmentInstant(r.timeInstant||r.localTime||r.time,pointClock)===targetInstant);
  if(!row)return null;
  return {...row,time:localTime,instant:targetInstant,timeZone:location.timeZone,
    kind:targetDate>today?'target_day_forecast':targetDate<today?'historical_day_forecast':'current_hour_forecast',
    label:targetDate>today?'目标日期12点预报':targetDate<today?'历史日期12点预报':'当前业务小时预报点'};
}
const STATUS_LABELS={missing:'当前地点/模式没有匹配记录',unavailable:'来源不可用',stale:'资料已过期',invalid_payload:'快照内容无效',invalid_time:'时间或有效期无法核实',no_point:'该日期/小时数据点缺失',dependency_mismatch:'模式潮汐与当前海况响应来源不一致',disabled:'环境服务未启用'};
export function resolveEnvironmentRecords(rows,context){
  const domains={};
  for(const domain of ENVIRONMENT_DOMAINS){
    const candidates=[];
    for(const row of rows){if(row.domain!==domain||String(row.target_date).slice(0,10)!==context.targetDate||row.location_id!==context.location?.id)continue;let payload;try{payload=typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json}catch{payload=null}
      // A bad newest matching payload stays selected and fails closed. Old records
      // without persisted query identity cannot prove that changed coordinates match.
      if(payload?.queryLocation&&!environmentQueryMatches(payload,context))continue;
      if(!payload?.queryLocation&&row.status!== (context.mode==='demo'?'demo':'available'))continue;
      candidates.push({row,payload});}
    candidates.sort((a,b)=>String(b.row.updated_at).localeCompare(String(a.row.updated_at))
      ||String(b.payload?.retrievedAt||'').localeCompare(String(a.payload?.retrievedAt||''))
      ||(Number(b.payload?.recordSequence)||0)-(Number(a.payload?.recordSequence)||0)||b.row.snapshot_key.localeCompare(a.row.snapshot_key));
    const selected=candidates[0],row=selected?.row,p=selected?.payload;
    let state=context.mode==='unavailable'?'disabled':!row?'missing':!p||typeof p!=='object'||Array.isArray(p)?'invalid_payload'
      :!environmentQueryMatches(p,context)?'invalid_payload':!['available','demo'].includes(row.status)?'unavailable'
        :context.mode==='live'&&(row.status!=='available'||p.status==='demo')?'invalid_payload'
        :p.status==='unavailable'?'unavailable':p.status==='stale'?'stale':!['available','demo'].includes(p.status)?'invalid_payload':'valid';
    const expiresAt=environmentInstant(row?.expires_at),retrievedAt=environmentInstant(p?.retrievedAt||p?.updatedAt),observedAt=row?.observed_at?environmentInstant(row.observed_at):null;
    if(state==='valid'&&(!expiresAt||!retrievedAt||!environmentInstant(row.updated_at)||!environmentInstant(context.instant)||(row.observed_at&&!observedAt)
      ||Date.parse(retrievedAt)>Date.parse(context.instant)||Date.parse(expiresAt)<=Date.parse(retrievedAt)))state='invalid_time';
    if(state==='valid'&&Date.parse(expiresAt)<=Date.parse(context.instant))state='stale';
    const point=p?environmentPoint(p,context):null;
    const required=domain==='weather'?['temperatureC','windSpeedKmh','uvIndex']:domain==='marine'?['waveHeightM']:['heightM'];
    const fields=point?Object.fromEntries(required.map(k=>[k,numberOrNull(point[k])])):{};
    // Missing UV does not erase present temperature: value presence is per field.
    const anyValue=required.some(k=>fields[k]!==null&&fields[k]!==undefined);
    if(state==='valid'&&(!point||!anyValue))state='no_point';
    const status=state==='valid'?(context.mode==='demo'?'demo':'available'):state==='stale'?'stale':'unavailable';
    domains[domain]={...(p||{}),domain,snapshotKey:row?.snapshot_key||null,sourceMode:context.mode,
      sourceName:row?.source_name||p?.sourceName||'暂无来源',sourceUrl:row?.source_url||p?.sourceUrl||'',
      status,available:state==='valid',currentness:state,missingNote:state==='valid'?'':STATUS_LABELS[state]||'资料不可用',
      retrievedAt,observedAt,expiresAt,selectedPoint:point?{...point,...fields}:null,
      current:domain==='weather'&&point?{...point,...fields}:null};
  }
  const tide=domains.tide,marine=domains.marine;
  if(tide.available&&tide.mode==='modeled-sea-level-including-tides'&&(!marine.available||tide.sourceResponseHash!==marine.providerResponseHash||tide.sourceMarineSnapshotKey!==marine.snapshotKey))Object.assign(tide,{status:'unavailable',available:false,currentness:'dependency_mismatch',missingNote:STATUS_LABELS.dependency_mismatch});
  for(const domain of ENVIRONMENT_DOMAINS)domains[domain].summary=environmentSummary(domain,domains[domain]);
  const all=ENVIRONMENT_DOMAINS.map(d=>domains[d]);const status=all.every(d=>d.available)?context.mode==='demo'?'demo':'available':all.some(d=>d.status==='stale')?'stale':'unavailable';
  const sources=all.filter(d=>d.snapshotKey).map(d=>({type:'environment_snapshot',domain:d.domain,id:d.snapshotKey,label:d.sourceName,status:d.status,retrievedAt:d.retrievedAt,dataAt:d.selectedPoint?.instant||null}));
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({mode:context.mode,location:context.location,keys:all.map(d=>[d.snapshotKey,d.currentness])})).digest('hex').slice(0,20);
  return {snapshotId:`environment:${context.location?.id||'unconfigured'}:${context.targetDate}:${fingerprint}`,
    targetDate:context.targetDate,location:context.location,timeZone:context.location?.timeZone||null,sourceMode:context.mode,status,
    resolvedAt:context.instant,expiresAt:all.map(d=>d.expiresAt).filter(Boolean).sort()[0]||null,
    ...domains,domains,sources,missingConfig:context.missingConfig||[],
    ...(context.mock?{mock:context.mock}:{}),...(context.providerFixture?{providerFixture:context.providerFixture}:{}),
    limitations:['环境数据不是临床、海事或航海安全批准；缺失或过期资料不放行下海。',
      context.mode==='demo'?'合成/mock资料，非实时、非机构批准。':'地区代表点及供应商网格不是机构精确地点或台站实测。',
      '含潮汐模式海面高度参考全球平均海平面，不提供官方精确满干潮时刻。']};
}
export function environmentSummary(domain,record){
  const p=record.selectedPoint;if(!record.available||!p)return `${record.missingNote||'数据点缺失'}；历史记录不能当当前有效资料。`;
  const when=`${p.time.replace('T',' ')}（${p.timeZone}，${p.label}）`;
  if(domain==='weather'){const uv=numberOrNull(p.uvIndex);return `${when}；气温${p.temperatureC??'缺失'}°C；紫外线${uv===null?'指数缺失':`指数${uv}`}，${record.sourceMode==='demo'?'仅合成示例分级':'机构分级未设置'}。`;}
  if(domain==='marine')return `${when}；波高${p.waveHeightM} ${record.units?.waveHeight||'m'}。`;
  return `${when}；${record.mode==='modeled-sea-level-including-tides'?'含潮汐的模式海面高度（预测）':'合成/站点潮位'}${p.heightM} ${record.unit||record.units?.height||'m'}；${record.verticalDatum==='global mean sea level'?'全球平均海平面基准；非台站实测、不提供精确满干潮':'垂直基准未说明；不作实测安全依据'}。`;
}
export function briefEnvironment(snapshot){return ENVIRONMENT_DOMAINS.map(domain=>{const r=snapshot[domain];return {domain,available:r.available,status:r.status,currentness:r.currentness,sourceId:r.snapshotKey,sourceName:r.sourceName,
  retrievedAt:r.retrievedAt,observedAt:r.observedAt,expiresAt:r.expiresAt,dataAt:r.selectedPoint?.instant||null,summary:environmentSummary(domain,r),missingNote:r.available?'':environmentSummary(domain,r),payload:r};});}
