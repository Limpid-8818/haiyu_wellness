import React from 'react';
import {businessText} from './lib/release-presentation.js';
export function SourceDetails({children,data,summary='来源与技术详情'}){return <details className="release-details"><summary>{summary}</summary>{children}{data!==undefined&&<pre>{JSON.stringify(data,null,2)}</pre>}</details>;}
export function BusinessReason({value}){const raw=String(value||''),readable=businessText(raw);return <><p>{readable}</p>{readable!==raw&&<SourceDetails summary="查看原始建议与来源"><p>{raw}</p></SourceDetails>}</>;}
