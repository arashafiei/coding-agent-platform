'use client';
import {useEffect, useState} from 'react';
import {useParams} from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const stages = ['planner', 'human_approval', 'coder', 'runner', 'reviewer', 'fixer', 'report'];
export default function Run() {
    const params = useParams();
    const [run, setRun] = useState(null), [events, setEvents] = useState([]), [feedback, setFeedback] = useState('');
    useEffect(() => {
        const runId = params.runId;
        if (!runId) return;
        fetch(`${API}/runs/${runId}`).then(r => r.json()).then(d => {
            setRun(d);
            setEvents(d.events || [])
        });
        const es = new EventSource(`${API}/runs/${runId}/events`);
        es.onmessage = e => setEvents(v => [...v, JSON.parse(e.data)]);
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

    return <main className="wrap"><a href={`/projects/${run.project_id}`} className="muted">← {run.project_name}</a>
        <div className="top">
            <div><h1>Run {run.id.slice(0, 8)}</h1>
                <div className="muted">{run.request}</div>
            </div>
            <span className="status">{run.status}</span></div>
        <div className="pipeline">{stages.map(s => <div className={`stage ${s === run.current_stage ? 'active' : ''}`}
                                                        key={s}>{s}</div>)}</div>
        {run.status === 'awaiting_approval' && <div className="card"><h3>Human approval</h3>
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
                <pre>{JSON.stringify({stage: run.current_stage, fixAttempt: run.fix_attempt}, null, 2)}</pre>
            </div>
        </div>
    </main>
}
