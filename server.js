import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app=express(), PORT=process.env.PORT||10000;
const DIR=process.env.DATA_DIR||"/tmp/capivara-radio", FILE=path.join(DIR,"data.json");
app.use(cors({origin:true,methods:["GET","POST","PUT","DELETE","OPTIONS"],allowedHeaders:["Content-Type","Authorization"]}));
app.use(express.json({limit:"25mb"}));

const blank=()=>({version:1,settings:{},clients:{},playlists:{},jingles:{},backgrounds:{},updatedAt:new Date().toISOString()});
function ensure(){fs.mkdirSync(DIR,{recursive:true});if(!fs.existsSync(FILE))fs.writeFileSync(FILE,JSON.stringify(blank(),null,2))}
function read(){ensure();try{return JSON.parse(fs.readFileSync(FILE,"utf8"))}catch{let d=blank();write(d);return d}}
function write(d){ensure();d.updatedAt=new Date().toISOString();fs.writeFileSync(FILE,JSON.stringify(d,null,2));return d}
const code=v=>String(v||"").trim().replace(/[^a-zA-Z0-9_-]/g,"");

app.get("/",(_,r)=>r.json({ok:true,service:"Capivara Radio Server",version:"1.0.0"}));
app.get("/health",(_,r)=>r.json({ok:true,time:new Date().toISOString()}));

app.get("/api/public/config",(_,r)=>{
 const s=read().settings||{};
 r.json({ok:true,settings:{aiMode:s.aiMode||"hybrid",voxUrl:s.voxUrl||"https://capivara-vox-ai.onrender.com/generate",
 geminiModel:s.geminiModel||"",adsPerBlock:s.adsPerBlock??3,dailyLimit:s.dailyLimit??15,
 weeklyLimit:s.weeklyLimit??105,topDailyLimit:s.topDailyLimit??1,useJingles:s.useJingles??true}});
});
app.get("/api/client/:code",(q,r)=>{
 const c=read().clients?.[code(q.params.code)];
 if(!c)return r.status(404).json({ok:false,error:"cliente não encontrado"});
 if(c.active===false)return r.status(403).json({ok:false,error:"cliente bloqueado"});
 const {secrets,...safe}=c;r.json({ok:true,client:safe});
});
app.get("/api/admin/settings",(_,r)=>r.json({ok:true,settings:read().settings||{}}));
app.put("/api/admin/settings",(q,r)=>{let d=read();d.settings={...(d.settings||{}),...(q.body||{})};write(d);r.json({ok:true,settings:d.settings})});
app.get("/api/admin/clients",(_,r)=>r.json({ok:true,clients:Object.values(read().clients||{})}));
app.put("/api/admin/client/:code",(q,r)=>{let c=code(q.params.code);if(!c)return r.status(400).json({ok:false,error:"código inválido"});
 let d=read();d.clients||={};d.clients[c]={...(d.clients[c]||{}),...(q.body||{}),code:c};write(d);r.json({ok:true,client:d.clients[c]})});
app.delete("/api/admin/client/:code",(q,r)=>{let d=read();if(d.clients)delete d.clients[code(q.params.code)];write(d);r.json({ok:true})});
app.get("/api/client/:code/state",(q,r)=>{let c=read().clients?.[code(q.params.code)];if(!c)return r.status(404).json({ok:false,error:"cliente não encontrado"});
 r.json({ok:true,state:c.state||{ads:[],queue:[],counters:{},voiceTurn:0}})});
app.put("/api/client/:code/state",(q,r)=>{let c=code(q.params.code),d=read();if(!d.clients?.[c])return r.status(404).json({ok:false,error:"cliente não encontrado"});
 d.clients[c].state=q.body||{};write(d);r.json({ok:true})});
for(const k of ["playlists","jingles","backgrounds"]){
 app.get("/api/"+k,(_,r)=>r.json({ok:true,[k]:read()[k]||{}}));
 app.put("/api/admin/"+k,(q,r)=>{let d=read();d[k]=q.body||{};write(d);r.json({ok:true})});
}
app.listen(PORT,"0.0.0.0",()=>console.log("Capivara Radio Server ativo",PORT));
