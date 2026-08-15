import ChangeForm from '../../components/ChangeForm';
import ProjectActions from '../../components/ProjectActions';
const API=process.env.API_INTERNAL_URL||'http://api:4000';
export default async function Project({params}){
  const {id}=await params; const response=await fetch(`${API}/projects/${id}`,{cache:'no-store'});
  if(!response.ok)return <main className="wrap"><a href="/" className="muted">← Projects</a><h1>Project not found</h1></main>;
  const p=await response.json();
  return <main className="wrap"><a href="/" className="muted">← Projects</a><div className="top"><div><h1>{p.name}</h1><div className="muted">{p.requirements}</div><span className="status">{p.status}</span></div></div><ProjectActions project={p}/><h2>Runs</h2><div className="grid">{p.runs?.map(r=><a className="card" key={r.id} href={`/projects/${p.id}/runs/${r.id}`}><b>{r.type}</b><p>{r.request}</p><span className="status">{r.status} · {r.current_stage}</span></a>)}</div><h2>New change</h2>{p.status==='archived'?<div className="notice">Restore this project before starting another run.</div>:<ChangeForm projectId={p.id}/>}</main>
}
