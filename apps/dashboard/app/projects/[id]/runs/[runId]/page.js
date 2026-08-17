'use client';
import {useEffect, useState} from 'react';
import {useParams} from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const stages = ['planner', 'human_approval', 'coder', 'runner', 'reviewer', 'fixer', 'git','report'];
const retryable=['planner','coder','runner','reviewer','fixer','git','report'];export default function Run() {
    const params = useParams();
    const [run, setRun] = useState(null), [events, setEvents] = useState([]), [feedback, setFeedback] = useState('');

        const [retrying,setRetrying]=useState(''),[retryError,setRetryError]=useState('');
  async function load(){const r=await
        fetch(`${API}/runs/${params.runId}`,{cache:'no-store'});const d=await r.json();
            setRun(d);
            setEvents(d.events || [])
        }
  useEffect(()=>{const runId=params.runId;if(!runId)return;load();
        const es = new EventSource(`${API}/runs/${runId}/events`);
        es.onmessage = e => {const item= JSON.parse(e.data);setEvents(v=>[...v,item]);if(['PLAN_READY','ACTION_RETRY_COMPLETED','ACTION_RETRY_FAILED'].includes(item.type))load()};
        return () => es.close()
    }, [params.runId]);
    if (!run) return <main className="wrap">Loading...</main>;

    async function approve() {
        await fetch(`${API}/runs/${run.id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({feedback})
        });
        location.reload()
    }
  async function retryAction(action){if(retrying)return;setRetrying(action);setRetryError('');try{const r=await fetch(`${API}/runs/${run.id}/actions/${action}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||`Retry failed (${r.status})`);await load()}catch(e){setRetryError(`${action}: ${e.message}`);await load()}finally{setRetrying('')}}
  const blocked=run.project_status==='archived'||run.status==='cancelled'||run.status==='succeeded';
  const currentRetryAction=retryable.includes(run.current_stage)?run.current_stage:null;

    return <main className="wrap"><a href={`/projects/${run.project_id}`} className="muted">← {run.project_name}</a>
        <div className="top">
            <div><h1>Run {run.id.slice(0, 8)}</h1>
                <div className="muted">{run.request}</div>
            </div>
            <div className="runControls"><span className="status">{run.status}</span>{currentRetryAction&&<button className="btn ghost" disabled={blocked||Boolean(retrying)} onClick={()=>retryAction(currentRetryAction)}>{retrying?`Retrying ${currentRetryAction}...`:`Retry current stage (${currentRetryAction})`}</button>}</div></div>
        <div className="pipeline">{stages.map(s => <div className={`stage ${s === run.current_stage ? 'active' : ''}`}
                                                        key={s}>{s}</div>)}</div>
        {retryError&&<div className="retryError">{retryError}</div>}{run.status === 'awaiting_approval' && <div className="card"><h3>Human approval</h3>
            <pre>{JSON.stringify(run.plan, null, 2)}</pre>
            <textarea className="area" value={feedback} onChange={e => setFeedback(e.target.value)}
                      placeholder="Optional feedback"/>
            <button className="btn" onClick={approve}>Approve & Continue</button>
        </div>}
        <div className="cols">
            <div className="card"><h3>Live events</h3>
                <div className="logs">{events.map((e, i) => <div className="log"
                                                                 key={i}>{e.created_at || e.ts} · <b>{e.type}</b> · {e.message}
                </div>)}</div>
            </div>
            <div className="card"><h3>Run state</h3>
                <pre>{JSON.stringify({stage: run.current_stage, status:run.status,fixAttempt: run.fix_attempt}, null, 2)}</pre>
            </div>
        </div>
    </main>
}
