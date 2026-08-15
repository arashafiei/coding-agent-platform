import express from 'express';
import cors from 'cors';
import pg from 'pg';
import Redis from 'ioredis';
import { simpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express(); app.use(cors()); app.use(express.json({limit:'5mb'}));
const port = Number(process.env.PORT||4000);
const db = new pg.Pool({connectionString:process.env.DATABASE_URL});
const redis = new Redis(process.env.REDIS_URL);
const workspace='/workspace/projects';
const systemLog='/app/system-logs/events.log';

const slugify=s=>s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
async function event(runId, projectId, source, type, message, data={}) {
  const payload={runId,projectId,source,type,message,data,ts:new Date().toISOString()};
  await db.query('INSERT INTO run_events(project_id,run_id,source,type,message,data) VALUES($1,$2,$3,$4,$5,$6)',[projectId,runId,source,type,message,data]);
  await redis.xadd(`run:${runId}:events`,'*','payload',JSON.stringify(payload));
  await fs.mkdir(path.dirname(systemLog),{recursive:true}); await fs.appendFile(systemLog,JSON.stringify(payload)+'\n');
}
async function trigger(pathname, body){
  const url=`${process.env.N8N_INTERNAL_URL||'http://n8n:5678'}/webhook/${pathname}`;
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`n8n ${r.status}: ${await r.text()}`); return r.json().catch(()=>({ok:true}));
}
async function ensureRepo(project){
  const dir=path.join(workspace,project.slug); await fs.mkdir(dir,{recursive:true}); const git=simpleGit(dir);
  try { await git.checkIsRepo(); } catch { await git.init(); await git.addConfig('user.name','Coding Agent'); await git.addConfig('user.email','coding-agent@local'); await fs.writeFile(path.join(dir,'.gitignore'),'node_modules\n.env\ndist\n'); await git.add('.'); await git.commit('chore: initialize generated project'); }
  if(process.env.GITHUB_AUTO_CREATE_REPO==='true' && process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && !project.github_repo){
    const octokit=new Octokit({auth:process.env.GITHUB_TOKEN}); const name=project.slug;
    await octokit.repos.createForAuthenticatedUser({name,private:process.env.GITHUB_DEFAULT_PRIVATE!=='false'});
    const url=`https://github.com/${process.env.GITHUB_OWNER}/${name}.git`; await git.addRemote('origin',url).catch(()=>{});
    await db.query('UPDATE projects SET github_repo=$1,github_url=$2 WHERE id=$3',[`${process.env.GITHUB_OWNER}/${name}`,url.replace('.git',''),project.id]);
  }
  return dir;
}

app.get('/health',(_q,r)=>r.json({ok:true}));
app.get('/projects',async(_q,r)=>r.json((await db.query('SELECT * FROM projects ORDER BY created_at DESC')).rows));
app.post('/projects',async(req,res)=>{
  try{const {name,description='',requirements}=req.body; const slug=`${slugify(name)}-${Date.now().toString(36)}`;
    const p=(await db.query('INSERT INTO projects(name,slug,description,requirements) VALUES($1,$2,$3,$4) RETURNING *',[name,slug,description,requirements])).rows[0]; await ensureRepo(p);
    const run=(await db.query("INSERT INTO runs(project_id,request,status,current_stage) VALUES($1,$2,'planning','planner') RETURNING *",[p.id,requirements])).rows[0];
    await event(run.id,p.id,'api','RUN_CREATED','Project and initial run created'); await trigger('coding-agent-plan',{projectId:p.id,runId:run.id,request:requirements});
    res.status(201).json({project:p,run});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/projects/:id',async(req,res)=>{const p=(await db.query('SELECT * FROM projects WHERE id=$1',[req.params.id])).rows[0]; if(!p)return res.sendStatus(404); const runs=(await db.query('SELECT * FROM runs WHERE project_id=$1 ORDER BY created_at DESC',[p.id])).rows; res.json({...p,runs});});
app.post('/projects/:id/changes',async(req,res)=>{try{const p=(await db.query('SELECT * FROM projects WHERE id=$1',[req.params.id])).rows[0]; const run=(await db.query("INSERT INTO runs(project_id,type,request,status,current_stage) VALUES($1,'CHANGE_REQUEST',$2,'planning','planner') RETURNING *",[p.id,req.body.request])).rows[0]; await event(run.id,p.id,'api','RUN_CREATED','Change request created'); await trigger('coding-agent-plan',{projectId:p.id,runId:run.id,request:req.body.request}); res.status(201).json(run);}catch(e){res.status(500).json({error:e.message})}});
app.get('/runs/:id',async(req,res)=>{const run=(await db.query('SELECT r.*,p.name project_name,p.slug FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1',[req.params.id])).rows[0]; if(!run)return res.sendStatus(404); const events=(await db.query('SELECT * FROM run_events WHERE run_id=$1 ORDER BY id',[run.id])).rows; res.json({...run,events});});
app.post('/runs/:id/plan',async(req,res)=>{const run=(await db.query('UPDATE runs SET plan=$1,status=$2,current_stage=$3 WHERE id=$4 RETURNING *',[req.body.plan,'awaiting_approval','human_approval',req.params.id])).rows[0]; await event(run.id,run.project_id,'planner','PLAN_READY','Plan ready for manager approval',req.body.plan); res.json(run);});
app.post('/runs/:id/approve',async(req,res)=>{try{const run=(await db.query("UPDATE runs SET human_feedback=human_feedback || $1::jsonb,status='running',current_stage='coder',started_at=COALESCE(started_at,NOW()) WHERE id=$2 RETURNING *",[JSON.stringify(req.body.feedback?[{message:req.body.feedback,at:new Date().toISOString()}]:[]),req.params.id])).rows[0]; await event(run.id,run.project_id,'human','HUMAN_APPROVED','Manager approved plan',{feedback:req.body.feedback||''}); await trigger('coding-agent-execute',{runId:run.id,projectId:run.project_id}); res.json(run);}catch(e){res.status(500).json({error:e.message})}});
app.post('/runs/:id/state',async(req,res)=>{const {status,currentStage,fixAttempt,finalReport}=req.body; const run=(await db.query('UPDATE runs SET status=COALESCE($1,status),current_stage=COALESCE($2,current_stage),fix_attempt=COALESCE($3,fix_attempt),final_report=COALESCE($4,final_report),finished_at=CASE WHEN $1 IN (\'succeeded\',\'failed\',\'cancelled\') THEN NOW() ELSE finished_at END WHERE id=$5 RETURNING *',[status,currentStage,fixAttempt,finalReport,req.params.id])).rows[0]; if(req.body.event) await event(run.id,run.project_id,req.body.event.source||'system',req.body.event.type,req.body.event.message,req.body.event.data||{}); res.json(run);});
app.post('/runs/:id/files',async(req,res)=>{try{const run=(await db.query('SELECT r.*,p.slug,p.github_repo FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1',[req.params.id])).rows[0]; const dir=path.join(workspace,run.slug); await fs.mkdir(dir,{recursive:true}); for(const f of req.body.files||[]){const safe=path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, ''); const full=path.join(dir,safe); if(!full.startsWith(dir)) throw new Error('Unsafe path'); await fs.mkdir(path.dirname(full),{recursive:true}); await fs.writeFile(full,f.content);}
 const git=simpleGit(dir); await git.add('.'); const msg=req.body.message||`agent: update run ${run.id}`; let sha=null; try{await git.commit(msg); sha=(await git.revparse(['HEAD'])).trim();}catch{} if(sha && run.github_repo && process.env.GITHUB_TOKEN){ const remote=`https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${run.github_repo}.git`; await git.push(remote,'HEAD:main',['--force-with-lease']).catch(()=>git.push(remote,'HEAD:main').catch(()=>{})); } await db.query('INSERT INTO code_versions(run_id,agent,attempt,files,commit_sha) VALUES($1,$2,$3,$4,$5)',[run.id,req.body.agent||'coder',req.body.attempt||0,req.body.files||[],sha]); await event(run.id,run.project_id,req.body.agent||'coder','FILES_WRITTEN',`${(req.body.files||[]).length} files written`,{commitSha:sha}); res.json({ok:true,commitSha:sha});}catch(e){res.status(500).json({error:e.message})}});
app.post('/runs/:id/execution',async(req,res)=>{const run=(await db.query('SELECT * FROM runs WHERE id=$1',[req.params.id])).rows[0]; await db.query('INSERT INTO execution_results(run_id,attempt,command,exit_code,stdout,stderr,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7)',[run.id,req.body.attempt||0,req.body.command||'',req.body.exitCode,req.body.stdout||'',req.body.stderr||'',req.body.durationMs]); await event(run.id,run.project_id,'runner',req.body.exitCode===0?'EXECUTION_PASSED':'EXECUTION_FAILED',`Execution finished with code ${req.body.exitCode}`,req.body); res.json({ok:true});});
app.get('/runs/:id/events',async(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive'); let last='$'; const key=`run:${req.params.id}:events`; const loop=async()=>{while(!res.writableEnded){try{const out=await redis.xread('BLOCK',15000,'COUNT',50,'STREAMS',key,last); if(!out){res.write(': ping\n\n');continue;} for(const [,items] of out) for(const [id,fields] of items){last=id; const i=fields.indexOf('payload'); if(i>=0)res.write(`data: ${fields[i+1]}\n\n`);}}catch{await new Promise(r=>setTimeout(r,1000));}}}; loop();});
app.listen(port,'0.0.0.0',()=>console.log(`api listening ${port}`));
