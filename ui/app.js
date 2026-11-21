"use strict";
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const icon = name => '<i class="icon" aria-hidden="true" style="--img:url(/ui/icons/'+name+'.svg)"></i>';
function icons(root=document) {
  root.querySelectorAll("[data-icon]").forEach(el=>{
    if(el.classList.contains("icon")) el.style.setProperty("--img","url(/ui/icons/"+el.dataset.icon+".svg)");
    else el.insertAdjacentHTML("afterbegin",icon(el.dataset.icon));
    el.removeAttribute("data-icon");
  });
}
icons();
const uid = () => crypto.randomUUID();
const duration = c => (c.end-c.start)/c.speed;
const stamp = t => Math.floor(t/60).toString().padStart(2,"0")+":"+Math.floor(t%60).toString().padStart(2,"0");
const precise = t => stamp(t)+":"+Math.floor((t%1)*24+.00001).toString().padStart(2,"0");
const defaults = {speed:1,zoom:1,brightness:1,contrast:1,saturation:1,volume:1,title:"",subtitle:"",titleSize:1,fadeIn:0,fadeOut:0};
function clip(a){return {id:uid(),asset:a.id,start:0,end:a.duration,...defaults};}
function demo(){
  const assets=["summit","lake","woodland","night"].map((id,i)=>({id,name:["Summit ridge.mp4","Stillwater.mp4","Forest light.mp4","After dusk.mp4"][i],url:"/media/"+id+".mp4",thumb:"/media/"+id+".jpg",duration:6,kind:"video"}));
  const clips=assets.map(clip);
  Object.assign(clips[0],{title:"Alpine Passage",subtitle:"A   M O U N T A I N   S T U D Y"});
  assets.push({id:"ambient",name:"Alpine ambience.m4a",url:"/media/ambience.m4a",duration:24,kind:"audio",thumb:""});
  return {version:1,name:"Alpine Passage",ratio:"16:9",assets,clips,music:{asset:"ambient",volume:.6,start:0,offset:0}};
}
let p=demo(), restored=false;
const mediaURL = /^\/media\/[\w.-]+$/;
function validate(q){
  if(q?.version!==1 || typeof q.name!=="string" || !["16:9","9:16","1:1"].includes(q.ratio)|| !Array.isArray(q.assets)||!Array.isArray(q.clips)) throw Error("Choose a valid Aethrix project.");
  if(q.markers!==undefined && (!Array.isArray(q.markers)||q.markers.some(m=>!m||typeof m.id!=="string"||typeof m.name!=="string"||!Number.isFinite(m.time)||m.time<0)))throw Error("Invalid timeline marker.");
  const ids=new Set();
  for(const a of q.assets){
    if(!mediaURL.test(a.url)||(a.thumb&&!mediaURL.test(a.thumb))||!["audio","image","video"].includes(a.kind)||!(a.duration>0)||typeof a.name!=="string"||typeof a.id!=="string"||ids.has(a.id)) throw Error("Invalid project asset.");
    ids.add(a.id);
  }
  for(const c of q.clips){
    const a=q.assets.find(a=>a.id===c.asset);
    if(!a||a.kind==="audio"||!(c.start>=0&&c.end-c.start>=.04&&c.end<=a.duration+.01)||!(c.speed>=.5&&c.speed<=2)) throw Error("Invalid clip timing.");
    c.fadeIn??=0;c.fadeOut??=0;
    for(const [k,v] of Object.entries(defaults)) if(typeof c[k]!==typeof v) throw Error("Invalid clip settings.");
  }
  if(q.music && (!q.assets.some(a=>a.id===q.music.asset&&a.kind==="audio")||!(q.music.volume>=0&&q.music.volume<=1))) throw Error("Invalid audio track.");
}
try{const s=JSON.parse(localStorage.getItem("aethrix.v1")??localStorage.getItem("framecut.v1"));if(s){validate(s);p=s;restored=true;}}catch{}
let selected=p.clips[0]?.id, mode="video", filter="All", time=0, playing=false, zoom=1, px=40, startClock=0;
const undoStack=[],redoStack=[];
const asset=id=>p.assets.find(a=>a.id===id), current=()=>p.clips.find(c=>c.id===selected);
const total=()=>p.clips.reduce((n,c)=>n+duration(c),0);
const begin=id=>{let t=0;for(const c of p.clips){if(c.id===id)break;t+=duration(c);}return t;};
function at(t){let n=0;for(const c of p.clips){if(t<n+duration(c)-.000001)return {c,local:t-n};n+=duration(c);}const c=p.clips.at(-1);return c?{c,local:duration(c)}:null;}
let editRevision=uid();
function save(){editRevision=uid();try{localStorage.setItem("aethrix.v1",JSON.stringify(p));$("saved").textContent="Saved locally";}catch{$("saved").textContent="Save project to file";}}
function remember(){undoStack.push(JSON.stringify(p));if(undoStack.length>80)undoStack.shift();redoStack.length=0;}
function change(fn){pause();remember();fn();refresh();save();}
function history(back){const from=back?undoStack:redoStack,to=back?redoStack:undoStack;if(!from.length)return;pause();to.push(JSON.stringify(p));p=JSON.parse(from.pop());refresh();save();}
let toastTimer;
function toast(msg){clearTimeout(toastTimer);$("toast").textContent=msg;$("toast").style.display="block";toastTimer=setTimeout(()=>$("toast").style.display="none",3600);}
function modal(title,html){$("dialogtitle").textContent=title;$("dialogbody").innerHTML=html;if(!$("dialog").open)$("dialog").showModal();}
$("close").onclick=()=>$("dialog").close();
const vid=document.createElement("video"),img=new Image(),song=new Audio();
vid.playsInline=true;vid.preload="auto";song.preload="auto";
let loaded="",loadedMusic="",frame, pendingSeek=0;
const cv=$("preview"),ctx=cv.getContext("2d");
function dimensions(size){const [w,h]=p.ratio.split(":").map(Number);return w>=h?[Math.round(size*w/h/2)*2,size]:[size,Math.round(size*h/w/2)*2];}
function lettering(g,c,w,h){
  if(!c.title&&!c.subtitle)return;
  g.save();g.textAlign="center";g.fillStyle="#fffaf1";g.shadowColor="#131719aa";g.shadowBlur=h*.012;g.shadowOffsetY=h*.003;
  const unit=Math.min(w,h*1.78);
  const y=h*.53;
  if(c.subtitle){g.font="600 "+Math.round(unit*.011*c.titleSize)+"px Segoe UI, sans-serif";g.fillText(c.subtitle,w/2,y-unit*.077*c.titleSize,w*.88);}
  g.font="italic "+Math.round(unit*.091*c.titleSize)+"px Georgia,serif";g.fillText(c.title,w/2,y,w*.9);
  g.restore();
}
function fadeLevel(c,t){
  const len=duration(c),fi=Math.min(c.fadeIn||0,len),fo=Math.min(c.fadeOut||0,len);
  return Math.max(0,(fi?Math.min(1,t/fi):1)*(fo?Math.min(1,(len-t)/fo):1));
}
let motionPresets={};
const motionReady=fetch("/ui/motion.json").then(r=>r.json()).then(data=>{motionPresets=data;draw();inspector();});
function cameraAt(c,t){
  const m=motionPresets[c.motion];if(!m)return {scale:1,x:.5,y:.5};
  const u=Math.min(1,Math.floor(t*24+.00001)/m.frames);
  const ease=(1-(1+7*u)*Math.exp(-7*u))/(1-8*Math.exp(-7));
  return {scale:m.start*Math.pow(m.end/m.start,ease),x:m.anchorX,y:m.anchorY};
}
function draw(){
  const [w,h]=dimensions(720);if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
  ctx.fillStyle="#090a0b";ctx.fillRect(0,0,w,h);
  const point=at(time);if(!point)return;
  const c=point.c,a=asset(c.asset),src=a.kind==="image"?img:vid,sw=src.videoWidth||src.naturalWidth,sh=src.videoHeight||src.naturalHeight;
  if(sw&&sh&&(a.kind==="image"?img.complete:vid.readyState>=2)){
    const camera=cameraAt(c,point.local),base=Math.max(w/sw,h/sh)*c.zoom,scale=base*camera.scale;
    ctx.save();ctx.filter="saturate("+c.saturation+") brightness("+c.brightness+") contrast("+c.contrast+")";ctx.drawImage(src,(w-sw*base)*camera.scale/2+w*(1-camera.scale)*camera.x,(h-sh*base)*camera.scale/2+h*(1-camera.scale)*camera.y,sw*scale,sh*scale);ctx.restore();
    lettering(ctx,c,w,h);
    const level=fadeLevel(c,point.local);
    if(level<1){ctx.fillStyle="rgba(0,0,0,"+(1-level)+")";ctx.fillRect(0,0,w,h);}
  }
}
function syncMusic(force){
  const m=p.music;
  if(!m){song.pause();loadedMusic="";return;}
  const a=asset(m.asset),t=time-m.start+m.offset;
  if(loadedMusic!==a.url){song.src=a.url;loadedMusic=a.url;force=true;}
  song.volume=m.volume;
  if(time<m.start||t>=a.duration||!playing){song.pause();return;}
  if(force||Math.abs(song.currentTime-t)>.18)song.currentTime=t;
  if(song.paused)song.play().catch(()=>{});
}
function sync(force=true){
  const pt=at(time);
  if(!pt){vid.pause();loaded="";draw();syncMusic(true);return;}
  const {c,local}=pt,a=asset(c.asset);
  pendingSeek=Math.min(c.end-.001,c.start+local*c.speed);
  if(loaded!==c.id+"|"+a.url){
    vid.pause();loaded=c.id+"|"+a.url;
    if(a.kind==="image")img.src=a.url;
    else{vid.src=a.url;vid.load();}
    force=true;
  }
  if(a.kind==="video"){
    vid.volume=Math.min(1,c.volume)*fadeLevel(c,local);vid.playbackRate=c.speed;
    if(vid.readyState>=1&&force&&Math.abs(vid.currentTime-pendingSeek)>.015)vid.currentTime=pendingSeek;
    if(playing&&vid.paused)vid.play().catch(()=>{});
    if(!playing)vid.pause();
  }
  syncMusic(force);draw();
}
vid.onloadedmetadata=()=>{vid.currentTime=Math.max(0,pendingSeek);};
vid.onseeked=vid.onloadeddata=img.onload=draw;
vid.onerror=()=>{if(loaded){pause();toast("This video could not be loaded. Check its media file.");}};
function position(){const s=$("scroll");$("needle").style.left=Math.min(time*px,$("sequence").offsetWidth-2)+"px";$("time").textContent=precise(time);if(playing&&(time*px>s.scrollLeft+s.clientWidth||time*px<s.scrollLeft))s.scrollLeft=time*px;}
function tick(now){if(!playing)return;time=Math.min(total(),(now-startClock)/1000);sync(false);position();if(time>=total()){pause();return;}frame=requestAnimationFrame(tick);}
function pause(){playing=false;cancelAnimationFrame(frame);vid.pause();song.pause();$("play").innerHTML=icon("play");}
function seek(t){pause();time=Math.max(0,Math.min(t,total()));sync();position();}
function toggle(){if(playing)return pause();if(!total())return;if(time>=total()-.01)time=0;playing=true;startClock=performance.now()-time*1000;$("play").innerHTML=icon("pause");sync();frame=requestAnimationFrame(tick);}
function add(id,index=p.clips.length){const a=asset(id);change(()=>{if(a.kind==="audio"){p.music={asset:id,start:0,offset:0,volume:.65};mode="audio";}else{const c=clip(a);p.clips.splice(index,0,c);selected=c.id;mode="video";time=begin(c.id);}});}
function library(){
  $("filters").innerHTML=["All","Video","Audio","Images"].map(f=>'<button class="'+(filter===f?"active":"")+'">'+f+'</button>').join("");
  [...$("filters").children].forEach(b=>b.onclick=()=>{filter=b.textContent;library();});
  const list=p.assets.filter(a=>filter==="All"||a.kind===({Video:"video",Audio:"audio",Images:"image"})[filter]);
  $("assets").innerHTML=list.map(a=>'<div class="asset" draggable="true"><div class="assetpic '+(a.kind==="audio"?"sound":"")+'">'+(a.thumb?'<img draggable="false" src="'+esc(a.thumb)+'" alt="">':icon("audio-lines"))+'<small>'+stamp(Math.ceil(a.duration))+'</small><button title="Add to timeline" aria-label="Add '+esc(a.name)+' to timeline">'+icon("plus")+'</button></div><div class="assetname" title="'+esc(a.name)+'">'+esc(a.name)+'</div></div>').join("") || '<p class="empty">No media here yet.</p>';
  [...$("assets").querySelectorAll(".asset")].forEach((el,i)=>{el.ondragstart=e=>e.dataTransfer.setData("asset",list[i].id);el.ondblclick=()=>add(list[i].id);el.querySelector("button").onclick=()=>add(list[i].id);});
}
const waves=new Map();
async function waveform(a){
  if(waves.has(a.url))return;
  waves.set(a.url,[]);
  let ac;
  try{ac=new AudioContext();const buf=await ac.decodeAudioData(await (await fetch(a.url)).arrayBuffer());const ch=buf.getChannelData(0),peaks=[];
    for(let i=0;i<400;i++){let peak=0;const start=Math.floor(ch.length*i/400),end=Math.floor(ch.length*(i+1)/400);for(let n=start;n<end;n+=Math.max(1,Math.floor((end-start)/100)))peak=Math.max(peak,Math.abs(ch[n]));peaks.push(peak);}
    const max=Math.max(...peaks,.001);waves.set(a.url,peaks.map(v=>v/max));timeline();
  }catch{}finally{if(ac)ac.close();}
}
function timeline(){
  const len=total(),vw=$("scroll").clientWidth||800,extent=(p.markers||[]).reduce((max,m)=>Math.max(max,m.time+.25),Math.max(len,6));px=(vw-2)/extent*zoom;
  $("sequence").style.width=Math.max(vw,Math.ceil(extent*px)+2)+"px";
  const step=[.25,.5,1,2,5,10,20,30,60,120,300,600,3600].find(s=>s*px>=70)||7200;
  $("ruler").style.setProperty("--step",step*px/4+"px");let ticks="";
  for(let n=0;n<extent;n+=step)ticks+='<span style="left:'+n*px+'px">'+stamp(n)+(step<1?"."+Math.round((n%1)*100):"")+'</span>';
  $("ruler").innerHTML=ticks;
  for(const m of p.markers||[]){
    const b=document.createElement("button");b.className="cue";b.style.left=m.time*px+"px";
    b.title=precise(m.time)+" · "+m.name;b.setAttribute("aria-label",b.title);b.onpointerdown=e=>e.stopPropagation();
    b.onclick=()=>{seek(m.time);markerDialog(m);};$("ruler").append(b);
  }
  $("scale").textContent=Math.round(zoom*100)+"%";
  let t=0;const titles=[],videos=[];
  p.clips.forEach((c,i)=>{const a=asset(c.asset),style='left:'+t*px+'px;width:'+Math.max(1,duration(c)*px-2)+'px;',sel=c.id===selected;
    videos.push('<div draggable="true" data-i="'+i+'" class="block video '+(sel&&mode==="video"?"selected":"")+'" style="'+style+"background-image:linear-gradient(0deg,#141518bb,transparent 85%),url('"+esc(a.thumb)+"')"+'"><span>'+esc(a.name)+'</span><i class="trim left" data-edge="start" title="Drag to trim in point"></i><i class="trim right" data-edge="end" title="Drag to trim out point"></i></div>');
    if(c.title||c.subtitle)titles.push('<div data-i="'+i+'" class="block title '+(sel&&mode==="title"?"selected":"")+'" style="'+style+'">'+icon("type")+' &nbsp;'+esc(c.title||c.subtitle)+'</div>');t+=duration(c);
  });$("videos").innerHTML=videos.join("");$("titles").innerHTML=titles.join("");
  for(const el of document.querySelectorAll(".block[data-i]")){const c=p.clips[+el.dataset.i];el.onclick=e=>{selected=c.id;mode=el.classList.contains("title")?"title":"video";seek(clickTime(e));inspector();timeline();};el.ondragstart=e=>e.dataTransfer.setData("clip",c.id);}
  document.querySelectorAll(".trim").forEach(handle=>handle.onpointerdown=startTrim);
  $("music").innerHTML="";
  if(p.music){const m=p.music,a=asset(m.asset),width=Math.max(0,Math.min(a.duration-m.offset,len-m.start));if(width>0){
    const peaks=waves.get(a.url)||[],bars=peaks.slice(Math.floor(400*m.offset/a.duration),Math.ceil(400*(m.offset+width)/a.duration));
    const path=bars.map((v,i)=>"M"+i+" "+(16-14*v)+"v"+(28*v)).join("");
    $("music").innerHTML='<div class="block audio '+(mode==="audio"?"selected":"")+'" style="left:'+m.start*px+'px;width:'+width*px+'px"><svg class="wave" preserveAspectRatio="none" viewBox="0 0 '+Math.max(1,bars.length)+' 32"><path d="'+path+'" stroke="#76ad86" stroke-width=".7"/></svg><span>'+esc(a.name)+'</span></div>';$("music").firstChild.onclick=e=>{mode="audio";seek(clickTime(e));inspector();timeline();};waveform(a);
  }}
  $("status").textContent=p.clips.length+" clips   ·   "+precise(len)+" duration";
  position();
}
function startTrim(event){
  if(event.button!==0)return;
  event.preventDefault();event.stopPropagation();pause();
  const handle=event.currentTarget,block=handle.parentElement,c=p.clips[+block.dataset.i];
  const edge=handle.dataset.edge,revision=editRevision,origin=event.clientX,pixels=px;
  const minimum=edge==="start"?0:c.start+.05,maximum=edge==="start"?c.end-.05:asset(c.asset).duration;
  if(minimum>maximum)return;
  let value=c[edge];
  function update(e){
    const delta=Math.round((e.clientX-origin)/pixels*24)/24*c.speed;
    value=Math.max(minimum,Math.min(maximum,c[edge]+delta));
    const offset=(value-c[edge])/c.speed*pixels,left=begin(c.id)*pixels;
    block.style.left=(edge==="start"?left+offset:left)+"px";
    block.style.width=Math.max(1,duration(c)*pixels+(edge==="start"?-offset:offset)-2)+"px";
    block.querySelector("span").textContent=(edge==="start"?"In ":"Out ")+value.toFixed(2)+" s";
  }
  function finish(e){
    window.removeEventListener("pointermove",update);window.removeEventListener("pointerup",finish);window.removeEventListener("pointercancel",finish);
    if(e.type==="pointerup"&&revision===editRevision&&value!==c[edge]){
      change(()=>{c[edge]=value;selected=c.id;mode="video";time=begin(c.id)+(edge==="end"?Math.max(0,duration(c)-1/24):0);});
    }else timeline();
  }
  block.draggable=false;window.addEventListener("pointermove",update);window.addEventListener("pointerup",finish);window.addEventListener("pointercancel",finish);
}
function markerDialog(existing){
  pause();const when=existing?.time??time;
  modal(existing?"Timeline marker":"Add marker",'<label>Marker at '+precise(when)+'<input id="cueName" maxlength="100" placeholder="Marker name"></label><button id="saveCue" class="primary">Save marker</button>'+(existing?'<button id="removeCue">Remove marker</button>':''));
  const input=$("cueName");input.value=existing?.name??"Marker "+((p.markers?.length??0)+1);input.focus();input.select();
  const revision=editRevision;
  $("saveCue").onclick=()=>{if(revision!==editRevision){$("dialog").close();return toast("Timeline changed. Reopen the marker.");}
    const name=input.value.trim()||"Marker";change(()=>{if(existing)existing.name=name;else(p.markers??=[]).push({id:uid(),time:when,name});});$("dialog").close();};
  input.onkeydown=e=>{if(e.key==="Enter")$("saveCue").click();};
  if(existing)$("removeCue").onclick=()=>{change(()=>p.markers=p.markers.filter(m=>m.id!==existing.id));$("dialog").close();};
}
$("mark").onclick=()=>markerDialog();
function clickTime(e){return (e.clientX-$("sequence").getBoundingClientRect().left)/px;}
$("ruler").onpointerdown=e=>{const el=e.currentTarget;el.setPointerCapture(e.pointerId);seek(clickTime(e));el.onpointermove=ev=>seek(clickTime(ev));el.onpointerup=()=>el.onpointermove=null;};
$("sequence").ondragover=e=>e.preventDefault();
$("sequence").ondrop=e=>{e.preventDefault();const t=clickTime(e),pt=at(t),i=pt?p.clips.indexOf(pt.c)+(pt.local>=duration(pt.c)/2?1:0):0;
  const id=e.dataTransfer.getData("asset"),cid=e.dataTransfer.getData("clip");if(id)return add(id,i);
  if(cid)change(()=>{const from=p.clips.findIndex(c=>c.id===cid);if(from<0)return;const [c]=p.clips.splice(from,1);p.clips.splice(i-(i>from?1:0),0,c);selected=cid;time=begin(cid);mode="video";});
};
let inspectorTab="Edit";
function slider(label,key,value,min,max,step=.01){const format=key==="speed"?v=>Number(v).toFixed(2)+"×":v=>Math.round(v*100)+"%";return '<label class="control">'+label+'<input data-key="'+key+'" type="range" min="'+min+'" max="'+max+'" step="'+step+'" value="'+value+'"><output>'+format(value)+'</output></label>';}
function field(label,key,val,min,max){return '<label>'+label+'<input type="number" data-key="'+key+'" value="'+Number(val.toFixed(3))+'" min="'+min+'" max="'+max+'" step="0.01"></label>';}
function inspector(){
  const c=current(),audio=mode==="audio"&&p.music,model=audio?p.music:c,root=$("inspect");
  if(!model){root.innerHTML='<p class="empty">Add a clip to edit its settings.</p>';return;}
  const a=asset(model.asset),tab=mode==="title"?"Title":inspectorTab;
  const heading='<div class="selection">'+icon(audio?"audio-lines":"film")+'<div><b>'+esc(a.name)+'</b><small>'+(audio?"Soundtrack":a.kind==="image"?"Image clip":"Video clip")+'</small></div></div>';
  let html="";
  if(audio){
    html='<h3>Soundtrack</h3>'+slider("Volume","volume",model.volume,0,1)+'<div class="fields">'+field("Start on timeline","start",model.start,0,Math.max(0,total()-.05))+field("Source offset","offset",model.offset,0,a.duration-.05)+'</div>';
  }else{
    html='<div class="itabs">'+["Edit","Color","Title"].map(s=>'<button class="'+(tab===s?"active":"")+'">'+s+'</button>').join("")+'</div>';
    if(tab==="Edit")html+='<div class="group"><h3>Clip timing</h3><div class="fields">'+field("In point (s)","start",c.start,0,c.end-.05)+field("Out point (s)","end",c.end,c.start+.05,a.duration)+'</div>'+slider("Speed","speed",c.speed,.5,2,.05)+'</div><div class="group"><h3>Transform</h3>'+slider("Scale","zoom",c.zoom,1,2)+'</div><div class="group"><h3>Clip audio</h3>'+slider("Volume","volume",c.volume,0,1)+'</div><h3>Sequence order</h3><div class="fields"><button id="moveL" title="Move clip earlier">'+icon("move-left")+'Earlier</button><button id="moveR" title="Move clip later">Later'+icon("move-right")+'</button></div>';
    if(tab==="Edit")html+='<div class="group"><h3>Picture and sound fades</h3><div class="fields">'+field("Fade in (s)","fadeIn",c.fadeIn??0,0,Math.min(60,duration(c)))+field("Fade out (s)","fadeOut",c.fadeOut??0,0,Math.min(60,duration(c)))+'</div></div>';
    if(tab==="Edit")html+='<div class="group"><h3>Camera motion</h3><select id="motionPreset" aria-label="Camera motion"><option value="">Static</option>'+Object.entries(motionPresets).map(([id,m])=>'<option value="'+id+'" '+(c.motion===id?'selected':'')+'>'+esc(m.label)+'</option>').join("")+'</select> <button id="motionGuide">Editing guide</button></div>';
    if(tab==="Color")html+='<h3>Color adjustments</h3>'+slider("Brightness","brightness",c.brightness,.5,1.5)+slider("Contrast","contrast",c.contrast,.5,1.5)+slider("Saturation","saturation",c.saturation,0,2)+'<button id="resetColor">Reset color</button>';
    if(tab==="Title")html+='<h3>Title text</h3><input class="titlefield" aria-label="Title text" data-key="title" maxlength="160" placeholder="Add a title" value="'+esc(c.title)+'"><h3>Subtitle</h3><input class="titlefield" aria-label="Subtitle" data-key="subtitle" maxlength="180" placeholder="Add a subtitle" value="'+esc(c.subtitle)+'"><h3>Typography</h3>'+slider("Size","titleSize",c.titleSize,.4,1.8);
  }
  root.innerHTML=heading+html;
  root.querySelectorAll(".itabs button").forEach(b=>b.onclick=()=>{inspectorTab=b.textContent;mode=inspectorTab==="Title"?"title":"video";inspector();timeline();});
  root.querySelectorAll("input").forEach(input=>{
    const k=input.dataset.key;let checkpoint=false;
    function edit(final){
      if(input.type==="number"&&!final)return;
      if(!checkpoint){pause();remember();checkpoint=true;}
      const value=input.type==="text"?input.value:Math.min(+input.max,Math.max(+input.min,Number(input.value)));
      if(input.type==="number"&&!input.value.trim()){inspector();return;}
      model[k]=value;
      if(input.type==="range")input.nextElementSibling.textContent=k==="speed"?value.toFixed(2)+"×":Math.round(value*100)+"%";
      if(!audio&&(k==="start"||k==="end"||k==="speed"))time=begin(c.id);
      time=Math.min(time,total());sync();timeline();buttons();save();
      if(final){checkpoint=false;if(input.type==="number")inspector();}
    }
    input.oninput=()=>edit(false);input.onchange=()=>edit(true);
  });
  if($("motionPreset"))$("motionPreset").onchange=e=>change(()=>{c.motion=e.target.value;time=begin(c.id);});
  if($("motionGuide"))$("motionGuide").onclick=async()=>{const guide=await (await fetch("/ui/guides/editing.md")).text();modal("Editing guide",'<p>Shared Defaults · ericmjl / remotion-video · MIT</p><pre style="white-space:pre-wrap;max-height:55vh;overflow:auto">'+esc(guide)+'</pre>');};
  if($("resetColor"))$("resetColor").onclick=()=>change(()=>Object.assign(c,{brightness:1,contrast:1,saturation:1}));
  if($("moveL")){
    const i=p.clips.indexOf(c);$("moveL").disabled=i===0;$("moveR").disabled=i===p.clips.length-1;
    const move=dir=>change(()=>{p.clips.splice(i,1);p.clips.splice(i+dir,0,c);time=begin(c.id);});
    $("moveL").onclick=()=>move(-1);$("moveR").onclick=()=>move(1);
  }
}
function buttons(){$("undo").disabled=!undoStack.length;$("redo").disabled=!redoStack.length;$("duplicate").disabled=!current()||mode==="audio";$("delete").disabled=mode==="audio"?!p.music:!current();$("split").disabled=!p.clips.length;$("export").disabled=!p.clips.length;}
function refresh(){if(!current())selected=p.clips[0]?.id;if(mode==="audio"&&!p.music)mode="video";time=Math.min(time,total());$("projectName").value=p.name;$("ratio").value=p.ratio;library();inspector();timeline();sync();buttons();}
function splitClip(c, local){
  const cut=c.start+local*c.speed,next={...c,id:uid(),start:cut,fadeIn:0};
  c.end=cut;c.fadeOut=0;return next;
}
function split(){
  const pt=at(time);if(!pt||pt.local<.1||duration(pt.c)-pt.local<.1)return toast("Place the playhead inside a clip to split it.");
  change(()=>{const c=pt.c,next=splitClip(c,pt.local);p.clips.splice(p.clips.indexOf(c)+1,0,next);selected=next.id;mode="video";});
}
function remove(){if(!current()&&mode!=="audio")return;change(()=>{if(mode==="audio"){p.music=null;mode="video";}else if(mode==="title"){current().title="";current().subtitle="";mode="video";inspectorTab="Edit";}else{const i=p.clips.indexOf(current());p.clips.splice(i,1);selected=p.clips[Math.min(i,p.clips.length-1)]?.id;}});}
$("split").onclick=split;$("delete").onclick=remove;$("duplicate").onclick=()=>change(()=>{const c=current(),n={...c,id:uid()};p.clips.splice(p.clips.indexOf(c)+1,0,n);selected=n.id;time=begin(n.id);});
$("undo").onclick=()=>history(true);$("redo").onclick=()=>history(false);$("play").onclick=toggle;
$("back").onclick=()=>{let t=0;for(const c of p.clips){if(begin(c.id)<time-.05)t=begin(c.id);}seek(t);};
$("forward").onclick=()=>seek(p.clips.map(c=>begin(c.id)).find(t=>t>time+.05)??total());
$("fullscreen").onclick=()=>document.fullscreenElement?document.exitFullscreen():$("screen").requestFullscreen();
$("ratio").onchange=e=>change(()=>p.ratio=e.target.value);
$("projectName").onchange=e=>change(()=>p.name=e.target.value.trim()||"Untitled project");
$("less").onclick=()=>{zoom=Math.max(1,zoom/1.5);timeline();};$("more").onclick=()=>{zoom=Math.min(20,zoom*1.5);timeline();};
async function upload(files){
  if(!files.length)return;pause();const additions=[],errors=[];
  for(const f of files){$("saved").textContent="Importing "+f.name+"…";try{
    const res=await fetch("/import",{method:"POST",headers:{"X-Filename":encodeURIComponent(f.name)},body:f}),a=await res.json();if(!res.ok)throw Error(a.error);additions.push(a);
  }catch(e){errors.push(f.name+": "+e.message);}}
  if(additions.length){change(()=>{p.assets.push(...additions);filter="All";});toast("Imported "+additions.length+" file"+(additions.length===1?"":"s")+". Use + to add to the timeline.");}
  $("saved").textContent="Saved locally";if(errors.length)modal("Import problem","<p>"+esc(errors.join(" • "))+"</p>");
}
$("import").onclick=$("drop").onclick=()=>$("files").click();
$("files").onchange=async e=>{await upload([...e.target.files]);e.target.value="";};
const lib=document.querySelector(".library");lib.ondragover=e=>{e.preventDefault();lib.classList.add("drag");};lib.ondragleave=()=>lib.classList.remove("drag");lib.ondrop=e=>{e.preventDefault();lib.classList.remove("drag");upload([...e.dataTransfer.files]);};
function download(href,name){const link=document.createElement("a");link.href=href;link.download=name;link.click();}
function saveFile(){const url=URL.createObjectURL(new Blob([JSON.stringify(p,null,2)],{type:"application/json"}));download(url,p.name+".aethrix");setTimeout(()=>URL.revokeObjectURL(url),1000);}
$("projectMenu").onclick=()=>{modal("Project",'<button id="newproj">'+icon("file-plus-2")+'New empty project</button><button id="openproj">'+icon("folder-open")+'Open project file</button><button id="saveproj">'+icon("save")+'Save project file</button><button id="demo">'+icon("film")+'Open alpine sample</button>');$("newproj").onclick=()=>{change(()=>{p={version:1,name:"Untitled project",ratio:"16:9",assets:[],clips:[],music:null};time=0;});$("dialog").close();};$("demo").onclick=()=>{change(()=>{p=demo();mode="video";time=0;});$("dialog").close();};$("openproj").onclick=()=>$("openfile").click();$("saveproj").onclick=()=>{saveFile();$("dialog").close();};};
$("openfile").onchange=async e=>{try{const q=JSON.parse(await e.target.files[0].text());validate(q);change(()=>{p=q;mode="video";time=0;});$("dialog").close();}catch(err){toast(err.message);}e.target.value="";};
async function startExport(project,size){
  const [w,h]=dimensions(size);
  const titles=project.clips.map(c=>{if(!c.title&&!c.subtitle)return "";const cover=document.createElement("canvas");cover.width=w;cover.height=h;lettering(cover.getContext("2d"),c,w,h);return cover.toDataURL("image/png").split(",")[1];});
      const res=await fetch("/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project,size,titles})}),job=await res.json();if(!res.ok)throw Error(job.error||"Could not start the export.");
  return job;
}
let exporting=false;
$("export").onclick=()=>{
  if(exporting){toast("Your export is rendering.");return;}pause();
  modal("Export video",'<p>'+esc(p.name)+' · '+precise(total())+' · H.264 / AAC</p><label>Resolution<select id="quality"><option value="720">720p</option><option value="1080" selected>1080p</option><option value="2160">2160p</option></select></label><button class="primary" id="render">'+icon("download")+'Export MP4</button>');
  $("render").onclick=async()=>{
    const size=+$("quality").value,[w,h]=dimensions(size),project=structuredClone(p);
    exporting=true;const show=(v)=>modal("Exporting video",'<p>'+esc(project.name)+' · '+v+'%</p><progress style="width:100%" max="100" value="'+v+'"></progress>');
    show(0);
    try{const job=await startExport(project,size);
      while(true){await new Promise(resolve=>setTimeout(resolve,500));const state=await (await fetch("/jobs/"+job.id)).json();if(state.error)throw Error(state.error);
        if(state.url){modal("Export ready",'<p>'+esc(project.name)+' · '+w+' × '+h+' · MP4</p><button id="download" class="primary">'+icon("download")+'Save video</button>');$("download").onclick=()=>download(state.url,project.name+".mp4");break;}if($("dialog").open)show(state.progress);}
    }catch(e){modal("Export problem","<p>"+esc(e.message)+"</p>");}finally{exporting=false;}
  };
};
window.addEventListener("keydown",e=>{if($("dialog").open||["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName))return;
  const k=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
  if(mod&&k==="z"){e.preventDefault();history(!e.shiftKey);}
  else if(mod&&k==="s"){e.preventDefault();saveFile();}
  else if(mod&&k==="y"){e.preventDefault();history(false);}
  else if(e.code==="Space"){e.preventDefault();toggle();}
  else if(k==="m"&&!mod)markerDialog();else if(k==="s"&&!mod)split();else if(k==="delete"||k==="backspace"){e.preventDefault();remove();}
  else if(k==="arrowleft"||k==="arrowright"){e.preventDefault();seek(time+(k==="arrowleft"?-1:1)*(e.shiftKey?1:1/24));}
});
new ResizeObserver(timeline).observe($("scroll"));refresh();if(!restored)save();
