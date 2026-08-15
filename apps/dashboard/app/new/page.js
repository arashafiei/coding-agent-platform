'use client';
import {useRef,useState} from 'react';
const API=process.env.NEXT_PUBLIC_API_URL||'http://localhost:4000';
export default function NewProject(){
  const [busy,setBusy]=useState(false); const requestId=useRef(null);
  async function submit(e){
    e.preventDefault(); if(busy)return; setBusy(true);
    if(!requestId.current)requestId.current=crypto.randomUUID();
    try{
      const f=new FormData(e.currentTarget);
      const r=await fetch(`${API}/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.get('name'),description:f.get('description'),requirements:f.get('requirements'),requestId:requestId.current})});
      const d=await r.json(); if(!r.ok)throw new Error(d.error||'failed');
      if(d.project)location.href=`/projects/${d.project.id}`;
    }catch(err){alert(err.message);requestId.current=null;setBusy(false);}
  }
  return <main className="wrap"><a href="/" className="muted">← Projects</a><h1>New Project</h1><form className="form" onSubmit={submit}><input className="input" name="name" placeholder="Project name" required/><input className="input" name="description" placeholder="Short description"/><textarea className="area" name="requirements" placeholder="Describe requirements..." required/><button className="btn" disabled={busy}>{busy?'Starting...':'Create & Start'}</button></form></main>
}
