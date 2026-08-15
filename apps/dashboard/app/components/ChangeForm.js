'use client';
import {useState} from 'react';
const API=process.env.NEXT_PUBLIC_API_URL||'http://localhost:4000';
export default function ChangeForm({projectId}){
  const [request,setRequest]=useState(''); const [busy,setBusy]=useState(false);
  async function submit(e){e.preventDefault();setBusy(true);const r=await fetch(`${API}/projects/${projectId}/changes`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request})});const d=await r.json();if(d.id)location.href=`/projects/${projectId}/runs/${d.id}`;else alert(d.error||'Failed');setBusy(false)}
  return <form className="form" onSubmit={submit}><textarea className="area" value={request} onChange={e=>setRequest(e.target.value)} placeholder="Describe a new feature, modification, or bug fix..." required/><button className="btn" disabled={busy}>{busy?'Starting...':'Start Change Run'}</button></form>
}
