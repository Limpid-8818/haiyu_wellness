import {readCurrentEnvironmentSnapshot} from './environment.js';

// New drafts persist only an exactly matching, already-stored snapshot. This
// read never fetches providers or fills historical gaps with current values.
export async function captureDraftEnvironmentHistory(items) {
  const snapshots=[];
  const dateOf=item=>item.businessDate||item.date;
  for(const date of [...new Set(items.filter(i=>i.environmentSnapshotId).map(dateOf).filter(Boolean))]){
    const current=await readCurrentEnvironmentSnapshot(date);
    for(const snapshotId of [...new Set(items.filter(i=>dateOf(i)===date).map(i=>i.environmentSnapshotId).filter(Boolean))]){
      if(snapshotId!==current.snapshotId){snapshots.push({snapshotId,targetDate:date,
        metadataNote:'未能以当前记录核对生成时快照；仅保留原编号和规则理由，不回填新值。'});continue;}
      snapshots.push({snapshotId,targetDate:date,location:current.location,status:current.status,
        sourceMode:current.sourceMode,recordedAt:current.resolvedAt,sources:current.sources,
        domainStates:Object.fromEntries(Object.entries(current.domains).map(([d,r])=>[d,{currentness:r.currentness,status:r.status,expiresAt:r.expiresAt,dataAt:r.selectedPoint?.instant||null}]))});
    }
  }
  return snapshots;
}

export async function draftEnvironmentHistory(draft) {
  const saved=Array.isArray(draft.evidence?.environmentSnapshots)?draft.evidence.environmentSnapshots:[];
  const ids=[...new Set((draft.items||[]).map(i=>i.environmentSnapshotId).filter(Boolean))];
  if(!ids.length&&!saved.length)return null;
  const dates=[...new Set([...(draft.items||[]).filter(i=>i.environmentSnapshotId).map(i=>i.businessDate),...saved.map(s=>s.targetDate).filter(Boolean)])];
  const generated=saved.length?saved:ids.map(snapshotId=>({snapshotId,
    location:{id:snapshotId.startsWith('environment:')?snapshotId.split(':')[1]:null},
    recordedAt:draft.createdAt,metadataNote:'仅保留原快照编号和规则理由；旧版未保存的值不推测或回填。'}));
  const current=[];
  for(const date of dates){const s=await readCurrentEnvironmentSnapshot(date);current.push({targetDate:date,
    snapshotId:s.snapshotId,location:s.location,sourceMode:s.sourceMode,status:s.status,
    sources:s.sources,resolvedAt:s.resolvedAt,domainStates:Object.fromEntries(Object.entries(s.domains).map(([d,r])=>[d,{status:r.status,currentness:r.currentness,missingNote:r.missingNote}]))});}
  return {generatedAt:draft.createdAt,generated,current,
    changed:current.some(s=>!generated.some(old=>old.snapshotId===s.snapshotId)),
    notice:'以下是生成时的历史环境与原规则理由；当前来源是另行读取的对照，未更新旧版或自动批准/预约。',
    reEvaluation:{guestEntry:'生成新版本草案',staffEntry:'保存新待审版本',automatic:false}};
}
