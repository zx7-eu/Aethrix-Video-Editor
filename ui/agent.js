"use strict";

function requireValue(test, message) {
  if (!test) throw Error(message);
}
function inRange(value, lo, hi) {
  return Number.isFinite(value) && value >= lo && value <= hi;
}
function requireRevision(revision) {
  requireValue(revision === editRevision, "The timeline changed. Inspect the project and retry with its new revision.");
}
function snapshot() {
  let cursor = 0;
  const timeline = p.clips.map(c => {
    const start = cursor;
    cursor += duration(c);
    return {clip: c.id, start, end: cursor};
  });
  return {revision: editRevision, project: p, timeline, duration: cursor, playhead: time, selectedClip: selected};
}
function applySettings(c, settings, source) {
  requireValue(settings && typeof settings === "object" && !Array.isArray(settings), "Expected clip settings.");
  const limits = {start:[0,source.duration], end:[.04,source.duration+.001], speed:[.5,2], zoom:[1,2],
    brightness:[.5,1.5],contrast:[.5,1.5],saturation:[0,2],volume:[0,1],titleSize:[.4,1.8],fadeIn:[0,60],fadeOut:[0,60]};
  for (const [key,value] of Object.entries(settings)) {
    if(key==="motion")requireValue(value===""||Object.hasOwn(motionPresets,value),"Unknown motion preset.");
    else if (key==="title" || key==="subtitle") requireValue(typeof value==="string" && value.length <= (key==="title"?160:180), "Invalid "+key);
    else requireValue(Object.hasOwn(limits,key) && inRange(value,...limits[key]), "Invalid "+key);
    c[key]=value;
  }
  requireValue(c.end-c.start >= .04, "Trim points must leave at least 0.04 seconds of source media.");
}
function editBatch({revision,operations}) {
  requireRevision(revision);
  requireValue(Array.isArray(operations) && inRange(operations.length,1,200), "Supply 1 to 200 operations.");
  const draft=structuredClone(p), created=[];
  const findAsset=id=>{const a=draft.assets.find(a=>a.id===id);requireValue(a,"Unknown asset ID.");return a;};
  const indexIn=(i,max)=>{requireValue(Number.isInteger(i)&&inRange(i,0,max),"Index outside the timeline.");return i;};
  for(const op of operations){
    if(op.op==="marker"){
      const len=draft.clips.reduce((n,c)=>n+duration(c),0);
      requireValue(inRange(op.time,0,len)&&typeof op.name==="string"&&op.name.trim()&&op.name.length<=100,"Invalid marker name or time.");
      (draft.markers??=[]).push({id:uid(),time:op.time,name:op.name.trim()});continue;
    }
    if(op.op==="remove_marker"){
      requireValue(draft.markers?.some(m=>m.id===op.id),"Unknown marker ID.");
      draft.markers=draft.markers.filter(m=>m.id!==op.id);continue;
    }
    if(op.op==="project"){
      if(op.name!==undefined){requireValue(typeof op.name==="string"&&op.name.trim(),"Provide a project name.");draft.name=op.name.trim();}
      if(op.ratio!==undefined){requireValue(["16:9","9:16","1:1"].includes(op.ratio),"Unsupported aspect ratio.");draft.ratio=op.ratio;}
      continue;
    }
    if(op.op==="soundtrack"){
      if(op.asset===null){draft.music=null;continue;}
      const a=findAsset(op.asset),m={asset:a.id,volume:op.volume??.65,start:op.start??0,offset:op.offset??0};
      requireValue(a.kind==="audio"&&inRange(m.volume,0,1)&&inRange(m.start,0,1e7)&&inRange(m.offset,0,a.duration)&&m.offset<a.duration,"Invalid soundtrack.");
      draft.music=m;continue;
    }
    if(op.op==="insert"){
      const a=findAsset(op.asset);requireValue(a.kind!=="audio","Use soundtrack for audio assets.");
      const c=clip(a);applySettings(c,op.settings??{},a);
      draft.clips.splice(indexIn(op.index??draft.clips.length,draft.clips.length),0,c);created.push(c.id);continue;
    }
    const i=draft.clips.findIndex(c=>c.id===op.clip);
    requireValue(i>=0,"Unknown clip ID.");const c=draft.clips[i];
    switch(op.op){
      case "update":applySettings(c,op.settings,findAsset(c.asset));break;
      case "remove":draft.clips.splice(i,1);break;
      case "move":{
        const dest=indexIn(op.index,draft.clips.length-1);
        draft.clips.splice(i,1);draft.clips.splice(dest,0,c);break;
      }
      case "split":{
        requireValue(inRange(op.at,.04/c.speed,duration(c)-.04/c.speed),"Split leaves too little media.");
        const next=splitClip(c,op.at);
        draft.clips.splice(i+1,0,next);created.push(next.id);break;
      }
      default:throw Error("Unknown edit operation.");
    }
  }
  validate(draft);
  change(()=>{p=draft;if(created.length)selected=created.at(-1);});
  toast("Agent applied "+operations.length+" edit"+(operations.length===1?"":"s")+" · Ctrl+Z to undo");
  return {revision:editRevision,created,duration:total(),clipCount:p.clips.length};
}
async function captureFrame(seconds) {
  requireValue(p.clips.length && inRange(seconds,0,total()), "Choose a time inside the sequence.");
  seek(seconds);
  const revision=editRevision,deadline=performance.now()+8000;
  const {c}=at(seconds),a=asset(c.asset);
  while(performance.now()<deadline){
    requireValue(editRevision===revision && Math.abs(time-seconds)<.001,"Preview moved during capture. Retry.");
    const ready=a.kind==="image"?img.complete&&img.naturalWidth>0:
      vid.readyState>=2&&!vid.seeking&&Math.abs(vid.currentTime-pendingSeek)<.09;
    if(ready){draw();return {time:seconds,image:cv.toDataURL("image/jpeg",.82).split(",")[1]};}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error("The selected frame could not be decoded.");
}
async function agentTool(tool,args){
  await motionReady;
  switch(tool){
    case "inspect_project":return snapshot();
    case "edit_timeline":return editBatch(args);
    case "import_media":
      change(()=>{p.assets.push(args.asset);filter="All";});toast("Agent imported "+args.asset.name);
      return {asset:args.asset,revision:editRevision};
    case "preview_frame":return captureFrame(args.seconds);
    case "export_video":
      requireRevision(args.revision);requireValue([720,1080,2160].includes(args.size)&&p.clips.length,"Choose a resolution and add a clip.");
      return startExport(structuredClone(p),args.size);
    case "export_status":{
      requireValue(typeof args.id==="string"&&/^[a-f0-9]{32}$/.test(args.id),"Invalid render ID.");
      const status=await (await fetch("/jobs/"+args.id)).json();
      if(status.error)throw Error(status.error);
      return status;
    }
    default:throw Error("Unknown Aethrix tool.");
  }
}
let agentQueue=Promise.resolve();
window.aethrixAgent=call=>{
  agentQueue=agentQueue.then(async()=>{
    let result;
    try {result={value:await agentTool(call.tool,call.args??{})};}
    catch(e){result={error:e.message||String(e)};}
    window.ipc.postMessage(JSON.stringify({id:call.id,...result}));
  });
};
