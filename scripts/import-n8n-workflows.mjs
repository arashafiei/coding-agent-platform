import fs from 'node:fs/promises'; import path from 'node:path';
const base=process.env.N8N_PUBLIC_URL||'http://localhost:5678'; const key=process.env.N8N_API_KEY;
if(!key) throw new Error('Set N8N_API_KEY before importing workflows');
for(const file of await fs.readdir('n8n/workflows')){if(!file.endsWith('.json')) continue; const raw=JSON.parse(await fs.readFile(path.join('n8n/workflows',file),'utf8')); const body={name:raw.name,nodes:raw.nodes,connections:raw.connections,settings:raw.settings||{}}; const r=await fetch(`${base}/api/v1/workflows`,{method:'POST',headers:{'content-type':'application/json','X-N8N-API-KEY':key},body:JSON.stringify(body)}); console.log(file,r.status,await r.text());}
