'use client';
import {useState} from 'react';
const API=process.env.NEXT_PUBLIC_API_URL||'http://localhost:4000';
export default function ProjectActions({project}){
  const [busy,setBusy]=useState(false); const [editing,setEditing]=useState(false);
  async function action(kind){
    if(busy)return;
    if(kind==='delete' && !confirm(`Delete ${project.name}? Local project files, runs and logs stored in PostgreSQL will be removed. The GitHub repository will NOT be deleted.`))return;
    setBusy(true);
    try{
      const method=kind==='delete'?'DELETE':'POST';
      const suffix=kind==='delete'?'':`/${kind}`;
      const r=await fetch(`${API}/projects/${project.id}${suffix}`,{method});
      const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||'Request failed');
      location.href=kind==='delete'?'/':`/projects/${project.id}`;
    }catch(e){alert(e.message);setBusy(false);}
  }
  async function save(e){
    e.preventDefault(); if(busy)return; setBusy(true);
    try{
      const f=new FormData(e.currentTarget);
      const r=await fetch(`${API}/projects/${project.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.get('name'),description:f.get('description'),requirements:f.get('requirements')})});
      const d=await r.json();if(!r.ok)throw new Error(d.error||'Update failed');location.reload();
    }catch(e){alert(e.message);setBusy(false);}
  }
  return <div className="management">
    <div className="actions">
      <button className="btn ghost" onClick={()=>setEditing(v=>!v)} disabled={busy}>{editing?'Cancel edit':'Edit'}</button>
      {project.status==='archived'
        ? <button className="btn ghost" onClick={()=>action('restore')} disabled={busy}>Restore</button>
        : <button className="btn ghost" onClick={()=>action('archive')} disabled={busy}>Archive</button>}
      <button className="btn danger" onClick={()=>action('delete')} disabled={busy}>Delete</button>
    </div>
    {editing&&<form className="form managementForm" onSubmit={save}>
      <input className="input" name="name" defaultValue={project.name} required/>
      <input className="input" name="description" defaultValue={project.description||''} placeholder="Short description"/>
      <textarea className="area" name="requirements" defaultValue={project.requirements} required/>
      <button className="btn" disabled={busy}>{busy?'Saving...':'Save changes'}</button>
    </form>}
  </div>
}
