// Production sidecar script under HTTP and an opaque sandboxed iframe. The
// iframe has no module CORS access; its fake SDK bridge serves synthetic data.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {bindWindowFactory} from '../compat/runtime-ui.mjs';
import {panelAppSource,panelPageSource} from '../sidecars/panel/panel-source.mjs';
import {trajectoryMetrics} from '../sidecars/panel/metrics.mjs';
import {isDirectEntry,launchTestBrowser} from './ui-runner.mjs';
const createTheme=createRequire(import.meta.url)('../compat/theme.cjs');
const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
export async function runCheck(args=process.argv.slice(2)) {
const preview=args.includes('--preview');
const html=panelPageSource();
const code=panelAppSource(),requests=[],errors=[],results=[];
const id='11111111-1111-1111-1111-111111111111';
let prefs={language:'en',revision:1,modelTimelineEnabled:false,debugLaunchEnabled:false,usageFontScale:1,sidebarFontScale:1,inlineFontScale:1},debugLaunchState={enabled:false,configured:false,activePortPresent:false,platform:'linux'},metricsCalls=0,failMetrics=false,rate=38.7,scenario='default',timelineCleared=false,clearTimelineCalls=0;
const todayIso=new Date().toISOString().slice(0,10);
const usageSample=()=>({
 accountKey:'default',viewScope:'default',timeZone:'UTC',today:todayIso,
 todayHours:[0,0,0,0,0,0,0,0,1200,2400,1500,0,0,0,0,0,0,0,0,0,0,0,0,0],
 days:[{date:todayIso,models:{'Gemini 3.8 Flash':{uncached:1200,cacheRead:3000,cacheWrite:0,output:900,total:5100,requests:4}},users:{default:{name:'Local User',userKey:'default',isLegacy:false,uncached:1200,cacheRead:3000,cacheWrite:0,output:900,total:5100,requests:4}},hours:[0,0,0,0,0,0,0,0,1200,2400,1500,0,0,0,0,0,0,0,0,0,0,0,0,0],legacyTokens:0}],
 models:['Gemini 3.8 Flash'],users:['default'],
 userMeta:{default:{name:'Local User',email:'local@example.com',isLegacy:false}},
 usersSummary:{default:{name:'Local User',userKey:'default',isLegacy:false,uncached:1200,cacheRead:3000,cacheWrite:0,output:900,total:5100,requests:4}},
 legacyTokens:0,todayTokens:5100,weekTokens:5100,monthTokens:5100,totalTokens:5100,unknownTokens:0,unknownRequests:0,partialRequests:0,unreadableFiles:0,manualEntries:[],requests:4,firstDate:todayIso
});
const transcriptSample={version:1,status:'ready',complete:true,userTokens:100,assistantTokens:200,toolTokens:50,systemTokens:10,totalTokens:360,matchedSteps:4,compactionMarkers:1,imageSteps:0};
const orchestratorTimeline=()=>timelineCleared?{enabled:true,cascadeId:id,planModel:'Orchestrator (Argon)',activeModel:'Gemini Flash',startedAt:new Date(Date.now()-8000).toISOString(),endedAt:new Date().toISOString(),durationMs:8000,swimlanes:[],nodes:[],truncated:false,savedAt:null}:{
 enabled:true,cascadeId:id,planModel:'Orchestrator (Argon)',activeModel:'Gemini Flash',
 startedAt:'2026-11-14T08:00:00.000Z',endedAt:'2026-11-14T08:00:08.500Z',durationMs:8500,
 swimlanes:[
  {kind:'plan',model:'Orchestrator (Argon)',label:'Plan (Orchestrator (Argon))',startMs:0,endMs:2200,startRatio:0,widthRatio:0.2588,stepStart:1,stepEnd:2,calls:1},
  {kind:'handoff',model:'Gemini Flash',label:'Orchestrator (Argon) -> Gemini Flash',startMs:2200,endMs:2300,startRatio:0.2588,widthRatio:0.0118,stepStart:2,stepEnd:3,calls:0},
  {kind:'worker',model:'Gemini Flash',label:'Worker (Gemini Flash)',startMs:2300,endMs:6200,startRatio:0.2706,widthRatio:0.4588,stepStart:3,stepEnd:5,calls:2},
  {kind:'tool',model:'Tools',label:'Tools x4',startMs:3500,endMs:5100,startRatio:0.4118,widthRatio:0.1882,stepStart:4,stepEnd:4,calls:4},
  {kind:'subagent',model:'Hydrogen',label:'worker-sub',startMs:5200,endMs:8500,startRatio:0.6118,widthRatio:0.3882,stepStart:5,stepEnd:6,calls:1}
 ],
 nodes:[{
  id:'turn-1',kind:'turn',time:'2026-11-14T08:00:00.000Z',durationMs:8500,model:'Gemini Flash',role:null,event:'turn',
  meta:{turnIndex:1,stepStart:1,stepEnd:6},tokens:{inputTokens:1500,outputTokens:650,thinkingTokens:120,cachedTokens:900,totalTokens:2150},childConversationId:null,
  children:[
   {id:'phase-plan-1',kind:'phase',time:'2026-11-14T08:00:00.000Z',durationMs:2200,model:'Orchestrator (Argon)',role:'plan',event:'plan',meta:{stepStart:1,stepEnd:2},tokens:{inputTokens:500,outputTokens:150,thinkingTokens:40,cachedTokens:200,totalTokens:650},childConversationId:null,children:[
    {id:'call-1',kind:'model_call',time:'2026-11-14T08:00:00.200Z',durationMs:2000,model:'Orchestrator (Argon)',role:'plan',event:'model_call',meta:{stepIndex:2},tokens:{inputTokens:500,outputTokens:150,thinkingTokens:40,cachedTokens:200,totalTokens:650},childConversationId:null,children:[]}
   ]},
   {id:'handoff-1',kind:'handoff',time:'2026-11-14T08:00:02.200Z',durationMs:0,model:'Gemini Flash',role:'worker',event:'handoff',meta:{fromModel:'Orchestrator (Argon)',toModel:'Gemini Flash',stepIndex:2},tokens:null,childConversationId:null,children:[]},
   {id:'phase-worker-1',kind:'phase',time:'2026-11-14T08:00:02.300Z',durationMs:6200,model:'Gemini Flash',role:'worker',event:'worker',meta:{stepStart:3,stepEnd:6},tokens:{inputTokens:1000,outputTokens:500,thinkingTokens:80,cachedTokens:700,totalTokens:1500},childConversationId:null,children:[
    {id:'call-2',kind:'model_call',time:'2026-11-14T08:00:02.500Z',durationMs:1800,model:'Gemini Flash',role:'worker',event:'model_call',meta:{stepIndex:3},tokens:{inputTokens:600,outputTokens:300,thinkingTokens:50,cachedTokens:400,totalTokens:900},childConversationId:null,children:[]},
    {id:'tool-1',kind:'tool_group',time:'2026-11-14T08:00:03.500Z',durationMs:1600,model:null,role:null,event:'tool_group',meta:{category:'file_ops',calls:4,stepStart:4,stepEnd:4},tokens:null,childConversationId:null,children:[]},
    {id:'sub-1',kind:'subagent',time:'2026-11-14T08:00:05.200Z',durationMs:3300,model:'Hydrogen',role:'subagent',event:'subagent',meta:{role:'worker-sub',status:'DONE',stepIndex:5},tokens:{inputTokens:400,outputTokens:200,thinkingTokens:30,cachedTokens:150,totalTokens:600},childConversationId:'22222222-2222-2222-2222-222222222222',children:[]}
   ]}
  ]
 }],
 truncated:true,savedAt:'2026-11-14T08:00:08.500Z'
};
const orchestratorSample=()=>{
 const base=trajectoryMetrics({trajectory:{cascadeId:id,steps:[{type:'USER_INPUT'},{type:'PLANNER_RESPONSE',metadata:{generatorModel:'MODEL_PLACEHOLDER_M668'}},{type:'PLANNER_RESPONSE',metadata:{generatorModel:'MODEL_PLACEHOLDER_M669'}}],generatorMetadata:[
  {chatModel:{model:'MODEL_PLACEHOLDER_M668',streamingDuration:'2.0s',timeToFirstToken:'0.6s',usage:{messageId:'orch-1',inputTokens:300,cacheReadTokens:200,outputTokens:150,responseOutputTokens:110,thinkingOutputTokens:40,cacheWriteTokens:0,apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:12000,maxContextTokens:100000}}}},
  {chatModel:{model:'MODEL_PLACEHOLDER_M669',streamingDuration:'1.8s',timeToFirstToken:'0.4s',usage:{messageId:'orch-2',inputTokens:200,cacheReadTokens:400,outputTokens:300,responseOutputTokens:250,thinkingOutputTokens:50,cacheWriteTokens:0,apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:18000,maxContextTokens:100000}}}},
  {chatModel:{model:'MODEL_PLACEHOLDER_M669',streamingDuration:'1.2s',timeToFirstToken:'0.3s',usage:{messageId:'orch-3',inputTokens:100,cacheReadTokens:300,outputTokens:200,responseOutputTokens:170,thinkingOutputTokens:30,cacheWriteTokens:0,apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:24000,maxContextTokens:100000}}}}
 ]}});
 const taskModelUsage={planModel:base.planModel,activeModel:base.activeModel,totalTokens:base.modelUsage.totalTokens+600,outputTokens:base.modelUsage.outputTokens+200,totalRequests:base.modelUsage.totalRequests+1,models:[...base.modelUsage.models,{id:'subagent:Hydrogen',name:'Hydrogen',role:'subagent',requests:1,inputTokens:400,uncachedTokens:250,cachedTokens:150,cacheWriteTokens:0,outputTokens:200,thinkingTokens:30,totalTokens:600}]};
 return {
  ...base,
  planModel:'Orchestrator (Argon)',activeModel:'Gemini Flash',
  taskUsage:{cascadeId:id,state:'ready',subagents:1,subagentTokens:600,tokens:{totalTokens:base.tokens.totalTokens+600,outputTokens:base.tokens.outputTokens+200,inputTokens:base.tokens.inputTokens+400,uncachedTokens:base.tokens.uncachedTokens+250,cachedTokens:base.tokens.cachedTokens+150,cacheWriteTokens:0},modelUsage:taskModelUsage,items:[{id:'22222222-2222-2222-2222-222222222222',role:'worker-sub',model:'Hydrogen',tps:42.5,latestTps:42.5,steps:2,totalTokens:600,status:'DONE'}]},
  modelTimeline:prefs.modelTimelineEnabled===true?orchestratorTimeline():null
 };
};
const sample=()=>({connection:'live',serverTime:new Date().toISOString(),quotaUpdatedAt:new Date().toISOString(),preferences:prefs,integration:{state:'disconnected',activePortPresent:debugLaunchState.activePortPresent,debugLaunchEnabled:debugLaunchState.enabled,debugLaunchConfigured:debugLaunchState.configured},usage:usageSample(),groups:[{id:'gemini',name:'Gemini',windows:{'5h':{available:true,remaining:.8,resetAt:new Date(Date.now()+3600000).toISOString()},weekly:{available:true,remaining:.75,resetAt:new Date(Date.now()+86400000).toISOString()}}}],speed:scenario==='orchestrator'?orchestratorSample():{transcriptStats:transcriptSample,...trajectoryMetrics({trajectory:{cascadeId:id,steps:[{type:'USER_INPUT'}],generatorMetadata:Array.from({length:23},(_,i)=>({chatModel:{modelDisplayName:'Gemini 3.8 Flash',streamingDuration:(100/rate)+'s',timeToFirstToken:'1.2s',usage:{messageId:'fixture-'+i,inputTokens:100,cacheReadTokens:300,outputTokens:100,responseOutputTokens:100,cacheWriteTokens:0,apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:20000,maxContextTokens:100000}}}}))}}),modelTimeline:null}});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),path=url.pathname;requests.push(path);
 if(path==='/api/metrics'||path==='/api/preferences'||path==='/api/timeline/clear'||path==='/api/debug-launch'||path==='/api/usage/open'||path.startsWith('/api/usage/')){
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.end();return;}
  res.setHeader('Content-Type','application/json');
  if(path==='/api/metrics'){metricsCalls++;res.statusCode=failMetrics?503:200;res.end(JSON.stringify(failMetrics?{error:'Fixture unavailable'}:sample()));return;}
  if(path==='/api/timeline/clear'){
   if(req.method!=='POST'){res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed'}));return;}
   for await(const _ of req){}
   clearTimelineCalls++;timelineCleared=true;res.end(JSON.stringify({cleared:true}));return;
  }
  if(path==='/api/debug-launch'){
   if(req.method==='POST'){
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text||'{}');
    debugLaunchState={...debugLaunchState,enabled:Boolean(body.enabled),configured:Boolean(body.enabled)};
    prefs={...prefs,debugLaunchEnabled:Boolean(body.enabled),revision:prefs.revision+1};
   }
   res.end(JSON.stringify({...debugLaunchState,preferences:prefs}));return;
  }
  if(path==='/api/usage/open'){for await(const _ of req){}res.end(JSON.stringify({openedInHost:false}));return;}
  if(path==='/api/usage/accounts'){for await(const _ of req){}res.end(JSON.stringify({accounts:[{id:'default',name:'Local User',email:'local@example.com',active:true}],active:'default'}));return;}
  if(path.startsWith('/api/usage/')){for await(const _ of req){}res.end(JSON.stringify({ok:true,projects:[],totals:{},months:[],availableMonths:[]}));return;}
  if(req.method==='POST'){let text='';for await(const chunk of req)text+=chunk;prefs={...prefs,...JSON.parse(text),revision:prefs.revision+1};}
  res.end(JSON.stringify(prefs));return;
 }
 if(path==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end(url.searchParams.has('v')?code:'throw new Error("Fixture stale unversioned script");');return;}
 if(path==='/usage-ui.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(bindWindowFactory('__agPulseUsageFactory',await readFile(join(repo,'compat/usage-ui.cjs'),'utf8'),'usage-ui'));return;}
 if(path==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(url.searchParams.has('v')?await readFile(join(repo,'sidecars/panel/styles.css')):'');return;}
 if(path==='/theme.css'){res.setHeader('Content-Type','text/css');res.end(createTheme().css(':root'));return;}
 if(path==='/logo.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(await readFile(join(repo,'assets/logo.svg')));return;}
 if(path==='/preload.js'){res.setHeader('Content-Type','application/javascript');res.end(url.searchParams.has('sdk')?`window.sidecar={conversationId:${JSON.stringify(id)},fetch:(p,init)=>fetch(${JSON.stringify(base)}+p,init)};document.addEventListener('DOMContentLoaded',()=>document.body.style.background='#fafafa');`:'');return;}
 if(path==='/frame'){
  const inner=html.replace('<head>',`<head><base href="${base}/">`).replace('/preload.js','/preload.js?sdk');
  res.setHeader('Content-Type','text/html');res.end(`<iframe title="Dashboard sidecar" style="width:400px;height:640px;border:0" sandbox="allow-scripts" srcdoc="${inner.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></iframe>`);return;
 }
 if(path==='/'){
  let content=url.searchParams.has('sync')?html.replace('<script defer src=','<script src='):html;
  if(preview){const light=url.searchParams.get('theme')==='light';content=content.replace('</head>',`<style>:root{--background:${light?'#f5f6f8':'#16181c'};--foreground:${light?'#242830':'#e2e4e8'}}.preview-note{position:fixed;top:12px;left:16px;font:12px sans-serif;color:${light?'#606978':'#9ca5b4'}}.preview-note a{color:inherit}</style></head>`).replace('<body>',`<body><aside class="preview-note">侧栏本地预览 · 示例数据 · <a href="/?theme=dark">Dark</a> / <a href="/?theme=light">Light</a></aside>`);}
  res.setHeader('Content-Type','text/html');res.end(content);return;
 }
 // Intentionally no CORS-enabled module endpoints.
 res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(preview?17913:0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
if(preview){console.log('Side panel preview: '+base);await new Promise(()=>{});}
const browser=await launchTestBrowser();
try{
 for(const mode of ['deferred','early-classic','opaque-iframe']){
  scenario='default';prefs={language:'en',revision:1,modelTimelineEnabled:false,debugLaunchEnabled:false,usageFontScale:1,sidebarFontScale:1,inlineFontScale:1};debugLaunchState={enabled:false,configured:false,activePortPresent:false,platform:'linux'};rate=38.7;
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+(mode==='opaque-iframe'?'/frame':mode==='early-classic'?'/?sync':''));
  const view=mode==='opaque-iframe'?page.frameLocator('iframe'):page;
  // Provider reference and unknown compaction must not change the fixture's
  // active 100K host window / 20% occupancy in either language.
  await view.locator('#strip-tps').waitFor();
  await view.locator('#strip-context-size').filter({hasText:'20K / 100K'}).waitFor();
  assert.equal(await view.locator('#panel-model-mix').isVisible(),false,'Single-model baseline hides multi-model donut');
  assert.equal(await view.locator('#context-orchestrator-row').isVisible(),false,'Single-model baseline hides orchestrator row');
  assert.equal(await view.locator('#timeline-off-bar').isVisible(),true,'Default timeline renders compact OFF bar');
  assert.equal(await view.locator('#timeline-panel').isVisible(),false);
  assert.equal(await view.locator('#timeline-tree .timeline-node, #timeline-swimlanes .timeline-seg').count(),0,'Zero timeline nodes rendered when OFF');
  assert.equal(await view.locator('#context-tokens').textContent(),'20K / 100K tok');
  assert.equal(await view.locator('#context-provider-limit,#context-compaction-limit,#context-host-limit,#context-note,#transcript-details,.quota-overview,#context-card .quota-details').count(),0,'Compact context omits duplicate capacities, quota details, and diagnostic prose');
  await view.locator('#strip-tps').filter({hasText:'38.7'}).waitFor();
  assert.deepEqual(await view.locator('.metric-label span').allTextContents(),['Speed','Cache','Context']);
  assert.ok(await view.locator('#strip-tps').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=18);
  assert.equal(await view.locator('#strip-cache').textContent(),'75.0%');assert.equal(await view.locator('#strip-context-size').textContent(),'20K / 100K');
  assert.ok(await view.locator('#quota-rings-pill .quota-ring-item').count()>=1,'Quota rings render in header');
  await view.locator('#quota-rings-pill').hover();
  await view.locator('#quota-popover').waitFor({state:'visible'});
  const popText=await view.locator('#quota-popover').textContent();
  assert.ok(popText.includes('80.0%')&&popText.includes('75.0%'),`Expected quota balances in popover, got: ${popText}`);
  await view.locator('#quota-rings-pill').click();
  await page.keyboard.press('Escape');
  await view.locator('#quota-popover').waitFor({state:'hidden'});
  const frame=()=>view.locator('.widget').evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  const initialFrame=await frame();assert.equal(await view.locator('#speed-card').isVisible(),true,'Default view shows statistics, not an empty hover prompt');
  assert.equal(await view.locator('.widget').getAttribute('data-pin-bottom'),'true','Collapsed lower sections pin to bottom when a top detail card is open');
  for(const name of ['cache','context','speed']){
   await view.locator(`[data-card=${name}]`).click();assert.equal(await view.locator(`#${name}-card`).isVisible(),true);
   await page.mouse.move(0,0);await page.waitForTimeout(250);assert.equal(await view.locator(`#${name}-card`).isVisible(),true,'Selection remains after pointer leaves');
   assert.deepEqual(await frame(),initialFrame,'Metric selection must preserve the outer frame');
  }
  await view.locator('#speed-tab').click();
  await view.locator('#card-stage[hidden]').waitFor({state:'attached'});
  assert.equal(await view.locator('#card-stage').isVisible(),false,'Clicking active card tab collapses detail stage');
  await view.locator('.widget[data-pin-bottom="false"]').waitFor({state:'attached'});
  assert.equal(await view.locator('.widget').getAttribute('data-pin-bottom'),'false','Collapsing top card unpins lower sections');
  await view.locator('#speed-tab').click();
  await view.locator('#speed-card').waitFor({state:'visible'});
  assert.equal(await view.locator('#speed-card').isVisible(),true,'Clicking collapsed card tab expands it again');
  await view.locator('.widget[data-pin-bottom="true"]').waitFor({state:'attached'});
  assert.equal(await view.locator('.widget').getAttribute('data-pin-bottom'),'true');
  await view.locator('#speed-tab').focus();await page.keyboard.press('ArrowRight');assert.equal(await view.locator('#cache-tab').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');assert.equal(await view.locator('#context-tab').getAttribute('aria-selected'),'true');
  if(mode==='opaque-iframe'){
   assert.equal(await view.locator('html').evaluate(()=>self.origin),'null');
   assert.equal(await view.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor===getComputedStyle(document.querySelector('.widget')).backgroundColor),true,'SDK inline body background follows the dashboard theme');
  }
  assert.equal(await view.locator('#integration-note').isVisible(),false,'Default OFF debug launch hides bottom-bar reconnecting notice');
  await view.locator('#settings-button').click();
  await view.locator('#settings-popover').waitFor({state:'visible'});
  assert.equal(await view.locator('#debug-launch-toggle').getAttribute('aria-checked'),'false');
  await view.locator('#debug-launch-toggle').click();
  await view.locator('#debug-launch-toggle[aria-checked="true"]').waitFor();
  assert.equal(debugLaunchState.enabled,true);
  await view.locator('#debug-launch-toggle').click();
  await view.locator('#debug-launch-toggle[aria-checked="false"]').waitFor();
  assert.equal(debugLaunchState.enabled,false);
  await view.locator('#lang-opt-zh').click();
  await view.locator('html[lang="zh-CN"]').waitFor();
  assert.deepEqual(await view.locator('#settings-popover .font-row-label').allTextContents(),['统计页','侧边栏','底部状态卡片']);
  await view.locator('#settings-popover .font-row[data-font-key="sidebarFontScale"] .font-step-btn[data-font-step="5"]').click();
  await page.waitForTimeout(80);
  const pctInput=view.locator('#settings-popover .font-row[data-font-key="sidebarFontScale"] input.font-pct-input');
  await pctInput.fill('115');await pctInput.press('Enter');
  await page.waitForTimeout(80);
  assert.equal(await view.locator('html').evaluate(h=>h.style.getPropertyValue('--pulse-sidebar-font-scale')),'1.15');
  assert.equal(await view.locator('.widget').evaluate(e=>e.scrollWidth>e.clientWidth),false,'Font scaling keeps sidebar free of horizontal overflow');
  await pctInput.fill('100');await pctInput.press('Enter');
  await view.locator('#settings-button').click();
  await view.locator('#settings-popover').waitFor({state:'hidden'});
  assert.equal(await view.locator('#context-tokens').textContent(),'20K / 100K tok');
  assert.equal(await view.locator('#strip-context-size').textContent(),'20K / 100K');
  assert.deepEqual(await view.locator('.metric-label span').allTextContents(),['速度','缓存','上下文']);
  assert.deepEqual(await frame(),initialFrame,'Language switches must not resize the frame');
  await mkdir(join(repo,'.data/sidebar-design'),{recursive:true});
  for(const name of ['speed','cache','context']){await view.locator(`[data-card=${name}]`).click();await view.locator(`#${name}-card`).evaluate(e=>e.scrollTop=0);await page.waitForTimeout(180);await page.screenshot({path:join(repo,`.data/sidebar-design/${mode}-${name}-zh.png`)});}
  rate=51.2;await view.locator('#refresh-button').click();await view.locator('#strip-tps').filter({hasText:'51.2'}).waitFor();
  await view.locator('#open-usage-button').click();
  await view.locator('#panel-usage-host #usage-dashboard:popover-open').waitFor({state:'visible'});
  assert.ok((await view.locator('#panel-usage-host #usage-dashboard #title').textContent()).length>0);
  await view.locator('#panel-usage-host #usage-dashboard #close').click();
  await view.locator('#panel-usage-host #usage-dashboard').waitFor({state:'hidden'});
  const installed=await view.locator('html').evaluate(()=>window.__agPulsePanelInstalled);assert.equal(installed,true);
  results.push({mode,tokens:true,context:true,language:true,manualRefresh:true,settingsPopover:true,usageButton:true});await page.close();
 }
 for(const width of [280,360,440]){
  scenario='default';const page=await browser.newPage({viewport:{width,height:800}});page.on('pageerror',e=>errors.push(e.message));prefs={language:'en',revision:1,modelTimelineEnabled:false,debugLaunchEnabled:false};
  await page.goto(base);await viewOrPageWait(page);
  async function viewOrPageWait(p){await p.locator('#strip-tps').filter({hasText:'51.2'}).waitFor();}
  const size=()=>page.locator('.widget').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,overflow:e.scrollWidth>e.clientWidth}));const initial=await size();assert.equal(initial.overflow,false);
  for(const name of ['cache','context','speed']){await page.locator(`[data-card=${name}]`).click();assert.deepEqual(await size(),initial);}
  if(width===360){
   await page.locator('#open-usage-button').click();
   await page.locator('#panel-usage-host #usage-dashboard:popover-open').waitFor({state:'visible'});
   const dlgBox=await page.locator('#panel-usage-host #usage-dashboard').boundingBox();
   assert.ok(dlgBox&&dlgBox.width<=360,'Narrow sidebar usage modal fits viewport width');
   await page.locator('#panel-usage-host #usage-dashboard #close').click();
  }
  await page.screenshot({path:join(repo,`.data/sidebar-design/width-${width}.png`)});await page.close();
 }
 {
  scenario='orchestrator';prefs={language:'en',revision:1,modelTimelineEnabled:false};timelineCleared=false;clearTimelineCalls=0;
  const page=await browser.newPage({viewport:{width:360,height:800}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.locator('#strip-model').filter({hasText:'Orchestrator (Argon)'}).waitFor();
  const stripText=await page.locator('#strip-model').textContent();
  assert.ok(stripText.includes('Orchestrator (Argon)')&&stripText.includes('Gemini Flash'),`Expected hybrid strip label, got: ${stripText}`);
  const orchSize=()=>page.locator('.widget').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,overflow:e.scrollWidth>e.clientWidth}));
  const offInitial=await orchSize();
  assert.equal(offInitial.overflow,false);
  assert.equal(await page.locator('#timeline-off-bar').isVisible(),true);
  assert.equal(await page.locator('#timeline-tree .timeline-node, #timeline-swimlanes .timeline-seg').count(),0);
  await page.locator('[data-card=context]').click();
  assert.deepEqual(await orchSize(),offInitial,'Context tab preserves fixed outer height in multi-model OFF state');
  assert.equal(await page.locator('#context-orchestrator-row').isVisible(),true);
  assert.equal(await page.locator('#context-orchestrator').textContent(),'Orchestrator (Argon)');
  assert.equal(await page.locator('#context-orchestrator-note').isVisible(),true);
  await page.locator('[data-card=cache]').click();
  assert.deepEqual(await orchSize(),offInitial,'Cache tab preserves fixed outer height in multi-model OFF state');
  assert.equal(await page.locator('#panel-model-mix').isVisible(),true);
  assert.equal(await page.locator('#model-mix-segments circle.model-mix-segment').count(),2);
  assert.equal(await page.locator('#model-mix-scope').isVisible(),true);
  await page.locator('[data-mix-metric=output]').click();
  assert.equal(await page.locator('#model-mix-center-value').textContent(),'650');
  await page.locator('[data-mix-metric=calls]').click();
  assert.equal(await page.locator('#model-mix-center-value').textContent(),'3');
  await page.locator('[data-mix-metric=total]').click();
  await page.locator('[data-mix-scope=task]').click();
  assert.equal(await page.locator('#model-mix-segments circle.model-mix-segment').count(),3);
  assert.ok((await page.locator('#model-mix-list').textContent()).includes('Hydrogen'));
  await page.locator('#model-mix-list .model-mix-row').first().click();
  assert.match(await page.locator('#model-mix-center-value').textContent(),/%$/);
  await page.locator('#timeline-enable-btn').click();
  await page.locator('#timeline-panel').waitFor({state:'visible'});
  assert.equal(prefs.modelTimelineEnabled,true);
  assert.equal(await page.locator('#timeline-off-bar').isVisible(),false);
  assert.equal(await page.locator('#timeline-truncated').isVisible(),true);
  assert.equal(await page.locator('#timeline-swimlanes .timeline-lane').count(),3);
  assert.ok(await page.locator('#timeline-swimlanes .timeline-seg').count()>=4);
  await page.locator('#timeline-swimlanes .timeline-seg').first().click();
  assert.equal(await page.locator('#timeline-lane-tip').isVisible(),true);
  assert.ok((await page.locator('#timeline-lane-tip').textContent()).includes('Orchestrator'));
  const turnToggle=page.locator('#timeline-tree .timeline-node[data-kind=turn] > .timeline-node-row > .timeline-toggle-btn').first();
  assert.equal(await turnToggle.getAttribute('aria-expanded'),'true');
  await turnToggle.click();
  assert.equal(await turnToggle.getAttribute('aria-expanded'),'false');
  await turnToggle.click();
  assert.equal(await turnToggle.getAttribute('aria-expanded'),'true');
  assert.equal((await orchSize()).overflow,false);
  await page.locator('#settings-button').click();
  await page.locator('#lang-opt-zh').click();
  await page.locator('html[lang="zh-CN"]').waitFor();
  assert.ok((await page.locator('#timeline-swimlanes').textContent()).includes('规划'));
  await page.locator('#lang-opt-en').click();
  await page.locator('html[lang="en"]').waitFor();
  await page.locator('#settings-button').click();
  await page.locator('#timeline-clear-btn').click();
  await page.locator('#timeline-empty').waitFor({state:'visible'});
  assert.equal(clearTimelineCalls,1);
  assert.equal(await page.locator('#timeline-tree .timeline-node').count(),0);
  await page.locator('#timeline-disable-btn').click();
  await page.locator('#timeline-off-bar').waitFor({state:'visible'});
  assert.equal(prefs.modelTimelineEnabled,false);
  assert.equal(await page.locator('#timeline-panel').isVisible(),false);
  assert.equal(await page.locator('#timeline-tree .timeline-node, #timeline-swimlanes .timeline-seg').count(),0);
  results.push({mode:'orchestrator',hybridStrip:true,donutMetricsAndScope:true,timelineOptInClearDisable:true});
  await page.close();
 }
 {
  scenario='orchestrator';prefs={language:'en',revision:1,modelTimelineEnabled:true,debugLaunchEnabled:false,usageFontScale:1,sidebarFontScale:1,inlineFontScale:1};timelineCleared=false;clearTimelineCalls=0;
  const page=await browser.newPage({viewport:{width:900,height:800}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/frame');
  const view=page.frameLocator('iframe');
  await view.locator('#timeline-panel').waitFor({state:'visible'});
  const before=await view.locator('.widget').evaluate(e=>({rectH:Math.round(e.getBoundingClientRect().height),ch:e.clientHeight,sh:e.scrollHeight,st:e.scrollTop}));
  assert.ok(before.rectH<=622,`Expected bounded sidecar .widget height inside 640px iframe, got ${before.rectH}`);
  assert.ok(before.sh>before.ch,`Expected .widget vertical overflow inside 640px iframe, got ch=${before.ch} sh=${before.sh}`);
  const iframeBox=await page.locator('iframe').boundingBox();
  assert.ok(iframeBox);
  await page.mouse.move(iframeBox.x+iframeBox.width/2,iframeBox.y+iframeBox.height/2);
  await page.mouse.wheel(0,300);
  await page.waitForTimeout(120);
  const after=await view.locator('.widget').evaluate(e=>({st:e.scrollTop,bodySt:document.body.scrollTop,deSt:document.documentElement.scrollTop}));
  assert.ok(after.st>0,`Expected mouse wheel to scroll .widget inside opaque iframe, got scrollTop=${after.st}`);
  assert.equal(after.bodySt,0,'Outer body must not capture wheel scroll');
  assert.equal(after.deSt,0,'Document root must not capture wheel scroll');
  results.push({mode:'opaque-iframe-wheel',bounded:true,scrolledTop:after.st});
  await page.close();
 }
 scenario='default';
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));prefs={language:'en',revision:1,modelTimelineEnabled:false};failMetrics=true;
 await page.goto(base);await page.waitForFunction(()=>document.getElementById('health-note').textContent.length>0);
 failMetrics=false;rate=61.3;await page.locator('#strip-tps').filter({hasText:'61.3'}).waitFor();
 // A duplicate script must not start another poll/listener tree.
 const appUrl=await page.locator('script[src*="/app.js"]').getAttribute('src');await page.addScriptTag({url:base+appUrl});await page.waitForTimeout(300);
 const before=metricsCalls;rate=62.4;await page.locator('#refresh-button').click();await page.locator('#strip-tps').filter({hasText:'62.4'}).waitFor();
 assert.equal(metricsCalls-before,1);assert.deepEqual(errors,[]);
 assert.equal(requests.some(p=>['/format.mjs','/i18n.js','/theme.js'].includes(p)),false);
 await mkdir(join(repo,'.data/issue11'),{recursive:true});await page.screenshot({path:join(repo,'.data/issue11/panel-regression.png')});
 console.log(JSON.stringify({checks:results,automaticRecovery:true,duplicateInitSafe:true,moduleRequests:0,pageErrors:errors}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
}
if (isDirectEntry(import.meta.url)) await runCheck();
