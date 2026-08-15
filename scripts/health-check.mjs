const services = [
  ['dashboard','http://localhost:3000'],
  ['api','http://localhost:4000/health'],
  ['agent','http://localhost:4100/health'],
  ['runner','http://localhost:4200/health'],
  ['n8n','http://localhost:5678/healthz']
];
let failed=false;
for (const [name,url] of services) {
  try { const r=await fetch(url); console.log(`${r.ok?'✓':'✗'} ${name} ${r.status}`); if(!r.ok) failed=true; }
  catch(e){ failed=true; console.log(`✗ ${name}: ${e.message}`); }
}
process.exitCode=failed?1:0;
