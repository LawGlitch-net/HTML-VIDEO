const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let dbPromise;
function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const request=indexedDB.open('AnnotationVideoStudio',1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('work'))db.createObjectStore('work',{keyPath:'key'});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Could not open local storage.'));
    request.onblocked=()=>reject(new Error('IndexedDB is blocked by another open tab.'));
  });
  return dbPromise;
}
async function idbGet(key) {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('work','readonly'),req=tx.objectStore('work').get(key);
    req.onsuccess=()=>resolve(req.result?.value);
    req.onerror=()=>reject(req.error||new Error('Could not read IndexedDB.'));
  });
}
async function idbSet(key,value) {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('work','readwrite');tx.objectStore('work').put({key,value});
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not save to IndexedDB.'));
    tx.onabort=()=>reject(tx.error||new Error('The IndexedDB save was cancelled.'));
  });
}
async function idbDelete() {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('work','readwrite'),store=tx.objectStore('work');
    ['images','scenes','render'].forEach(key=>store.delete(key));
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Could not clear IndexedDB.'));
  });
}
async function idbDeleteKey(key) {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('work','readwrite');tx.objectStore('work').delete(key);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Could not delete IndexedDB record.'));
  });
}
let mutationEpoch=0;
let writeChain=Promise.resolve();
function enqueueIdbWrite(key,value,guard=()=>true) {
  const epoch=mutationEpoch;
  const operation=writeChain.catch(()=>{}).then(async()=>{
    if(epoch!==mutationEpoch||!guard())return false;
    await idbSet(key,value);
    return epoch===mutationEpoch&&guard();
  }).catch(error=>{throw error});
  writeChain=operation.catch(()=>false);
  return operation;
}
function enqueueIdbDeleteKey(key,guard=()=>true) {
  const epoch=mutationEpoch;
  const operation=writeChain.catch(()=>{}).then(async()=>{
    if(epoch!==mutationEpoch||!guard())return false;
    await idbDeleteKey(key);
    return epoch===mutationEpoch&&guard();
  }).catch(error=>{throw error});
  writeChain=operation.catch(()=>false);
  return operation;
}
function setStatus(id,msg,bad=false,state='') {
  const el=$(id);el.textContent=msg;el.className='save-status'+(bad?' error':state?' '+state:'');
}
function storageFailure(section,error) {
  const msg='Storage error: '+(error?.message||String(error))+' — progress was not saved.';
  setStatus(section==='annotation'?'status-annotation':'status-video',msg,true);
  $('storage-detail').textContent=msg;
}

function nav(section) {
  $('sec-annotation').hidden=section!=='annotation';
  $('sec-video').hidden=section!=='video';
  $('nav-annotation').setAttribute('aria-pressed',section==='annotation');
  $('nav-video').setAttribute('aria-pressed',section==='video');
  if(section==='video'&&!V.scenes.length)addScene(true);
  requestAnimationFrame(()=>document.querySelectorAll('.stage iframe').forEach(sizePreview));
}
$('nav-annotation').onclick=()=>nav('annotation');
$('nav-video').onclick=()=>nav('video');

/* ================= IMAGE ANNOTATION ================= */
const COLORS={Red:'#f02d24',Lime:'#69bd45',Cyan:'#23a7b7',Yellow:'#e8b500',Magenta:'#d33d98',Orange:'#df751c'};
const TOOLS=[['select','Select / move'],['rectangle','Rectangle'],['square','Square'],['circle','Ellipse'],['line','Line'],['arrow','Arrow'],['freehand','Freehand']];
const A={imgs:[],cur:-1,tool:'rectangle',color:COLORS.Red,width:4,sel:null,drag:null,uid:0,pasteN:0};
const cv=$('annotation-canvas'),ctx=cv.getContext('2d');
const curImg=()=>A.imgs[A.cur];
const curShapes=()=>curImg()?curImg().shapes:[];
const selShape=()=>curShapes().find(s=>s.id===A.sel);

let annotationSaveTimer;
function scheduleAnnotationSave(message='Saving…') {
  clearTimeout(annotationSaveTimer);
  setStatus('status-annotation',message,false,'saving');
  annotationSaveTimer=setTimeout(saveAnnotation,180);
}
async function saveAnnotation() {
  const epoch=mutationEpoch;
  try {
    const payload=A.imgs.map(({name,mime,url,shapes,uid})=>({name,mime,url,shapes,uid}));
    const saved=await enqueueIdbWrite('images',payload,()=>mutationEpoch===epoch);
    if(saved&&mutationEpoch===epoch)setStatus('status-annotation','Saved locally','', '');
  } catch(error){storageFailure('annotation',error);}
}

TOOLS.forEach(([key,label])=>{
  const b=document.createElement('button');b.type='button';b.id='shape-tool-'+key;b.textContent=label;
  b.onclick=()=>{A.tool=key;if(key!=='select')A.sel=null;refreshTools();refreshUI();};
  $('tools').append(b);
});
Object.entries(COLORS).forEach(([name,color])=>{
  const b=document.createElement('button');b.type='button';b.id='color-'+name.toLowerCase();b.className='swatch';b.textContent=name;b.style.background=color;
  b.onclick=()=>{A.color=color;const s=selShape();if(s){snapshot();s.color=color;scheduleAnnotationSave();}refreshTools();draw();};
  $('colors').append(b);
});
function refreshTools(){
  TOOLS.forEach(([key])=>$('shape-tool-'+key).setAttribute('aria-pressed',A.tool===key));
  Object.entries(COLORS).forEach(([name,color])=>$('color-'+name.toLowerCase()).style.outline=A.color===color?'3px solid var(--ink)':'none');
}
refreshTools();

$('line-width').oninput=e=>{
  A.width=+e.target.value;$('line-width-value').textContent=A.width;
  const s=selShape();if(s){snapshot();s.w=A.width;scheduleAnnotationSave();}draw();
};

function addImageFile(file,pasted) {
  const reader=new FileReader();
  reader.onload=()=>{
    const url=reader.result,mime=(String(url).match(/^data:([^;,]+)/)||[])[1]||file.type||'image/png';
    const ext=(mime.split('/')[1]||'png').replace('jpeg','jpg').replace(/\+.*/,'');
    const name=pasted?`pasted-image-${++A.pasteN}.${ext}`:(file.name||`image-${A.imgs.length+1}.${ext}`);
    const image=new Image();
    image.onload=()=>{
      A.imgs.push({name,mime,url,img:image,shapes:[],undo:[],uid:++A.uid});
      A.cur=A.imgs.length-1;A.sel=null;refreshUI();scheduleAnnotationSave(`Added ${name}`);setStatus('status-annotation',`Added ${name}`,'','saving');
    };
    image.onerror=()=>setStatus('status-annotation',`Error: ${name} is not a readable image.`,true);
    image.src=url;
  };
  reader.onerror=()=>setStatus('status-annotation','Error: could not read the file.',true);
  reader.readAsDataURL(file);
}
$('image-upload').onchange=e=>{[...e.target.files].forEach(file=>addImageFile(file,false));e.target.value='';};
document.addEventListener('paste',e=>{
  if($('sec-annotation').hidden)return;
  const items=[...(e.clipboardData?.items||[])].filter(item=>item.type.startsWith('image/'));
  if(!items.length)return;e.preventDefault();items.forEach(item=>addImageFile(item.getAsFile(),true));
});
const pasteZone=$('image-paste-area');
pasteZone.addEventListener('dragover',e=>{e.preventDefault();pasteZone.classList.add('dragging');});
pasteZone.addEventListener('dragleave',()=>pasteZone.classList.remove('dragging'));
pasteZone.addEventListener('drop',e=>{
  e.preventDefault();pasteZone.classList.remove('dragging');
  if($('sec-annotation').hidden)return;
  [...(e.dataTransfer?.files||[])].filter(file=>file.type.startsWith('image/')).forEach(file=>addImageFile(file,false));
});
pasteZone.addEventListener('click',()=>pasteZone.focus());

function refreshUI() {
  const list=$('image-list');list.innerHTML='';
  if(!A.imgs.length)list.innerHTML='<li class="empty">No images yet.</li>';
  A.imgs.forEach((model,index)=>{
    const li=document.createElement('li');
    li.innerHTML=`<button type="button" id="image-item-${index+1}" class="${index===A.cur?'sel':''}" aria-pressed="${index===A.cur}"><img src="${model.url}" alt=""><span class="name">${index+1}: ${esc(model.name)}</span></button><button type="button" id="image-remove-${index+1}" aria-label="Remove ${esc(model.name)}">Remove</button>`;
    li.children[0].onclick=()=>{A.cur=index;A.sel=null;refreshUI();};
    li.children[1].onclick=()=>{
      const removed=model.name;
      A.imgs.splice(index,1);
      if(index<A.cur)A.cur--;
      else if(index===A.cur)A.cur=Math.min(index,A.imgs.length-1);
      A.sel=null;refreshUI();scheduleAnnotationSave(`Removed ${removed}`);
    };
    const copy=document.createElement('button');
    copy.type='button';copy.dataset.copyImage='true';copy.textContent='Copy PNG';
    copy.setAttribute('aria-label','Copy edited '+model.name+' as PNG');
    copy.title='Copy this image with its annotations to the clipboard';
    copy.onclick=()=>copyEditedImages([model]);
    li.append(copy);
    list.append(li);
  });
  $('copy-all-images').disabled=!A.imgs.length;
  const annotationList=$('annotation-list');annotationList.innerHTML='';
  curShapes().forEach((shape,index)=>{
    const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.id='annotation-item-'+(index+1);
    if(shape.id===A.sel)button.className='sel';
    const b=bbox(shape);button.textContent=`#${index+1} ${shape.type} — ${shape.tag||'(no tag)'}`;
    button.style.borderLeft='8px solid '+shape.color;
    button.onclick=()=>{A.tool='select';A.sel=shape.id;refreshTools();refreshUI();};
    li.append(button);annotationList.append(li);
  });
  const tagInput=$('shape-tag-input'),selected=selShape();tagInput.disabled=!selected;
  if(document.activeElement!==tagInput)tagInput.value=selected?selected.tag:'';
  if(curImg()){cv.width=curImg().img.naturalWidth;cv.height=curImg().img.naturalHeight;}
  draw();
}
$('shape-tag-input').oninput=e=>{
  const shape=selShape();if(!shape)return;shape.tag=e.target.value;draw();
  const index=curShapes().indexOf(shape),button=$('annotation-item-'+(index+1));if(button)button.textContent=`#${index+1} ${shape.type} — ${shape.tag||'(no tag)'}`;
  scheduleAnnotationSave();
};

function bbox(shape) {
  const points=shape.pts||[[shape.x1,shape.y1],[shape.x2,shape.y2]],xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  return{x1:Math.min(...xs),y1:Math.min(...ys),x2:Math.max(...xs),y2:Math.max(...ys)};
}
const K=()=>Math.max(1,cv.width/800);
function shapePath(shape,target=ctx,k=K()) {
  target.beginPath();const b=bbox(shape);
  if(shape.type==='rectangle'||shape.type==='square')target.rect(b.x1,b.y1,b.x2-b.x1,b.y2-b.y1);
  else if(shape.type==='circle'){target.ellipse((b.x1+b.x2)/2,(b.y1+b.y2)/2,Math.max(1,(b.x2-b.x1)/2),Math.max(1,(b.y2-b.y1)/2),0,0,7);}
  else if(shape.type==='freehand'){shape.pts.forEach((p,i)=>i?target.lineTo(p[0],p[1]):target.moveTo(p[0],p[1]));}
  else {target.moveTo(shape.x1,shape.y1);target.lineTo(shape.x2,shape.y2);
    if(shape.type==='arrow'){const angle=Math.atan2(shape.y2-shape.y1,shape.x2-shape.x1),head=(12+shape.w*2)*k;[2.7,-2.7].forEach(delta=>{target.moveTo(shape.x2,shape.y2);target.lineTo(shape.x2+head*Math.cos(angle+delta),shape.y2+head*Math.sin(angle+delta));});}
  }
}
function drawAnnotations(target,model,k,selectedId=null,showSelection=false) {
  target.lineJoin=target.lineCap='round';
  model.shapes.forEach((shape,index)=>{
    const lw=shape.w*k;shapePath(shape,target,k);target.strokeStyle='#000';target.lineWidth=lw+3*k;target.stroke();
    shapePath(shape,target,k);target.strokeStyle=shape.color;target.lineWidth=lw;target.stroke();
    const b=bbox(shape),text=`#${index+1}`+(shape.tag?' '+shape.tag:''),fs=15*k;
    target.font=`bold ${fs}px system-ui`;const tw=target.measureText(text).width+10*k,th=fs+8*k;
    let lx=Math.max(0,Math.min(b.x1,model.img.naturalWidth-tw)),ly=b.y1-th-2*k;if(ly<0)ly=b.y1+2*k;
    target.fillStyle=shape.color;target.fillRect(lx,ly,tw,th);target.strokeStyle='#000';target.lineWidth=1.5*k;target.strokeRect(lx,ly,tw,th);
    target.fillStyle='#000';target.textBaseline='middle';target.fillText(text,lx+5*k,ly+th/2);target.textBaseline='alphabetic';
    if(showSelection&&shape.id===selectedId){target.setLineDash([8*k,6*k]);target.strokeStyle='#fff';target.lineWidth=2*k;target.strokeRect(b.x1,b.y1,b.x2-b.x1,b.y2-b.y1);target.setLineDash([]);handles(shape).forEach(h=>{target.fillStyle='#fff';target.strokeStyle='#000';target.fillRect(h.x-6*k,h.y-6*k,12*k,12*k);target.strokeRect(h.x-6*k,h.y-6*k,12*k,12*k);});}
  });
}
function draw() {
  ctx.clearRect(0,0,cv.width,cv.height);const model=curImg();
  if(!model){ctx.fillStyle='#667180';ctx.font='24px system-ui';ctx.fillText('Import an image to begin',40,60);return;}
  ctx.drawImage(model.img,0,0);drawAnnotations(ctx,model,K(),A.sel,true);
}
function handles(shape){
  if(shape.type==='line'||shape.type==='arrow')return[{x:shape.x1,y:shape.y1,k:'p1'},{x:shape.x2,y:shape.y2,k:'p2'}];
  const b=bbox(shape);return[{x:b.x1,y:b.y1,k:'nw'},{x:b.x2,y:b.y1,k:'ne'},{x:b.x1,y:b.y2,k:'sw'},{x:b.x2,y:b.y2,k:'se'}];
}
function snapshot(){
  const model=curImg();if(!model)return;model.undo.push(JSON.stringify(model.shapes));if(model.undo.length>100)model.undo.shift();
}
const pos=e=>{const r=cv.getBoundingClientRect();return[(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height];};
function dseg(px,py,a,b,c,d){const dx=c-a,dy=d-b,l=dx*dx+dy*dy;let t=l?((px-a)*dx+(py-b)*dy)/l:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-a-t*dx,py-b-t*dy);}
function hit(shape,x,y){
  const tol=10*K(),b=bbox(shape);
  if(shape.type==='line'||shape.type==='arrow')return dseg(x,y,shape.x1,shape.y1,shape.x2,shape.y2)<tol;
  if(shape.type==='freehand')return shape.pts.some((p,i)=>i&&dseg(x,y,shape.pts[i-1][0],shape.pts[i-1][1],p[0],p[1])<tol);
  return x>=b.x1-tol&&x<=b.x2+tol&&y>=b.y1-tol&&y<=b.y2+tol;
}
cv.addEventListener('pointerdown',e=>{
  const model=curImg();if(!model)return setStatus('status-annotation','Import or paste an image first.',true);
  cv.setPointerCapture(e.pointerId);const[x,y]=pos(e),k=K();
  if(A.tool==='select'){
    const selected=selShape();if(selected){const handle=handles(selected).find(h=>Math.abs(h.x-x)<10*k&&Math.abs(h.y-y)<10*k);if(handle){snapshot();A.drag={mode:'resize',h:handle.k,orig:JSON.parse(JSON.stringify(selected)),id:selected.id};return;}}
    const found=[...model.shapes].reverse().find(shape=>hit(shape,x,y));A.sel=found?found.id:null;
    if(found){snapshot();A.drag={mode:'move',sx:x,sy:y,orig:JSON.parse(JSON.stringify(found)),id:found.id};}refreshUI();return;
  }
  snapshot();const id=++A.uid,type=A.tool,shape={id,type,color:A.color,w:A.width,tag:'',x1:x,y1:y,x2:x,y2:y};if(type==='freehand')shape.pts=[[x,y]];
  model.shapes.push(shape);A.sel=id;A.drag={mode:'create',id,sx:x,sy:y};
});
cv.addEventListener('pointermove',e=>{
  const drag=A.drag;if(!drag)return;const shape=selShape();if(!shape)return;const[x,y]=pos(e);
  if(drag.mode==='create'){if(shape.type==='freehand')shape.pts.push([x,y]);else if(shape.type==='square'){const length=Math.max(Math.abs(x-drag.sx),Math.abs(y-drag.sy));shape.x2=drag.sx+Math.sign(x-drag.sx||1)*length;shape.y2=drag.sy+Math.sign(y-drag.sy||1)*length;}else{shape.x2=x;shape.y2=y;}}
  else if(drag.mode==='move'){const dx=x-drag.sx,dy=y-drag.sy,o=drag.orig;if(o.pts)shape.pts=o.pts.map(p=>[p[0]+dx,p[1]+dy]);else{shape.x1=o.x1+dx;shape.x2=o.x2+dx;shape.y1=o.y1+dy;shape.y2=o.y2+dy;}}
  else {const o=drag.orig,h=drag.h;if(h==='p1'){shape.x1=x;shape.y1=y;}else if(h==='p2'){shape.x2=x;shape.y2=y;}else{const b=bbox(o);let nx1=b.x1,ny1=b.y1,nx2=b.x2,ny2=b.y2;if(h[1]==='w')nx1=x;else nx2=x;if(h[0]==='n')ny1=y;else ny2=y;if(o.pts){const sx=(nx2-nx1)/Math.max(1,b.x2-b.x1),sy=(ny2-ny1)/Math.max(1,b.y2-b.y1);shape.pts=o.pts.map(p=>[nx1+(p[0]-b.x1)*sx,ny1+(p[1]-b.y1)*sy]);}else{shape.x1=nx1;shape.y1=ny1;shape.x2=nx2;shape.y2=ny2;}}}
  draw();
});
cv.addEventListener('pointerup',()=>{
  const drag=A.drag;A.drag=null;if(!drag)return;const shape=selShape();
  if(shape&&drag.mode==='create'){const b=bbox(shape);if(b.x2-b.x1<4&&b.y2-b.y1<4){curImg().shapes=curImg().shapes.filter(s=>s!==shape);curImg().undo.pop();A.sel=null;}else setStatus('status-annotation',`Drew ${shape.type}. Add a tag if needed.`);}
  scheduleAnnotationSave();refreshUI();
});
function deleteSelected(){
  const shape=selShape();if(!shape)return setStatus('status-annotation','Select a shape first.',true);
  snapshot();curImg().shapes=curImg().shapes.filter(s=>s!==shape);A.sel=null;refreshUI();scheduleAnnotationSave('Shape deleted');
}
$('delete-shape').onclick=deleteSelected;
document.addEventListener('keydown',e=>{
  if((e.key==='Delete'||e.key==='Backspace')&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)&&!$('sec-annotation').hidden&&A.sel){e.preventDefault();deleteSelected();}
});
$('undo-action').onclick=()=>{
  const model=curImg();if(!model||!model.undo.length)return setStatus('status-annotation','Nothing to undo.',true);
  model.shapes=JSON.parse(model.undo.pop());A.sel=null;refreshUI();scheduleAnnotationSave('Undid last action');
};
$('clear-annotations').onclick=()=>{
  const model=curImg();if(!model)return;snapshot();model.shapes=[];A.sel=null;refreshUI();scheduleAnnotationSave('Cleared all annotations');
};

function renderEditedPng(model) {
  return new Promise((resolve,reject)=>{
    const canvas=document.createElement('canvas');
    const width=model.img.naturalWidth,height=model.img.naturalHeight;
    if(!width||!height)return reject(new Error('Image dimensions are unavailable for '+model.name+'.'));
    canvas.width=width;canvas.height=height;
    try {
      const target=canvas.getContext('2d');
      if(!target)throw new Error('Could not create an image canvas for '+model.name+'.');
      target.drawImage(model.img,0,0);
      drawAnnotations(target,model,Math.max(1,width/800));
      canvas.toBlob(blob=>{
        canvas.width=1;canvas.height=1;
        if(!blob)reject(new Error('Could not encode '+model.name+' as PNG.'));
        else resolve(blob);
      },'image/png');
    } catch(error) {
      canvas.width=1;canvas.height=1;reject(error);
    }
  });
}

async function copyEditedImages(models) {
  if(!models.length)return setStatus('status-annotation','Import at least one image before copying.',true);
  if(!navigator.clipboard||typeof navigator.clipboard.write!=='function'||typeof ClipboardItem==='undefined') {
    return setStatus('status-annotation','This browser cannot write image data to the clipboard. Use a secure browser context (HTTPS or localhost) and allow clipboard access.',true);
  }
  const buttons=[$('copy-all-images'),...$('image-list').querySelectorAll('[data-copy-image]')];
  buttons.forEach(button=>button.disabled=true);
  let chain=Promise.resolve();
  try {
    const items=models.map(model=>{
      const blob=chain.then(()=>renderEditedPng(model));
      chain=blob.then(()=>undefined);
      return new ClipboardItem({'image/png':blob});
    });
    await navigator.clipboard.write(items);
    setStatus('status-annotation',models.length===1
      ? 'Copied '+models[0].name+' with its annotations to the clipboard as a PNG image.'
      : 'Copied '+models.length+' edited PNG images to the clipboard. Paste them into an app that accepts multiple images.',false);
  } catch(error) {
    const message=error?.message||String(error);
    if(models.length>1&&/multiple ClipboardItems|multiple.*not implemented|only one ClipboardItem/i.test(message)) {
      try {
        const composite=await renderEditedPngComposite(models);
        await navigator.clipboard.write([new ClipboardItem({'image/png':composite})]);
        setStatus('status-annotation','This browser cannot copy multiple clipboard images separately, so all '+models.length+' edited images were copied together as one PNG. Your originals and annotations are unchanged.');
      } catch(fallbackError) {
        setStatus('status-annotation','This browser cannot copy multiple images separately, and the combined PNG fallback failed: '+(fallbackError?.message||String(fallbackError))+' Try the individual Copy PNG buttons. Your images and annotations are unchanged.',true);
      }
    } else {
      setStatus('status-annotation','Could not copy image'+(models.length===1?'':'s')+' to the clipboard: '+message+' Your images and annotations are unchanged.',true);
    }
  } finally {
    buttons.forEach(button=>button.disabled=false);
  }
}

async function renderEditedPngComposite(models) {
  const padding=16,maxDimension=12000,maxPixels=16000000;
  const widths=models.map(model=>model.img.naturalWidth);
  const heights=models.map(model=>model.img.naturalHeight);
  if(widths.some(width=>!width)||heights.some(height=>!height))throw new Error('One or more image dimensions are unavailable.');
  const naturalWidth=Math.max(...widths)+padding*2;
  const naturalHeight=heights.reduce((sum,height)=>sum+height,0)+padding*(models.length+1);
  const naturalPixels=widths.reduce((sum,width,index)=>sum+width*heights[index],0);
  const scale=Math.min(1,maxDimension/naturalWidth,maxDimension/naturalHeight,Math.sqrt(maxPixels/naturalPixels));
  const width=Math.max(1,Math.floor(naturalWidth*scale));
  const height=Math.max(1,Math.floor(naturalHeight*scale));
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  try {
    const target=canvas.getContext('2d');
    if(!target)throw new Error('Could not create the combined PNG canvas.');
    const gap=Math.max(1,Math.round(padding*scale));
    let y=gap;
    for(let i=0;i<models.length;i++) {
      const blob=await renderEditedPng(models[i]);
      const bitmap=await createImageBitmap(blob);
      const drawWidth=Math.round(bitmap.width*scale),drawHeight=Math.round(bitmap.height*scale);
      target.drawImage(bitmap,gap,y,drawWidth,drawHeight);
      bitmap.close();
      y+=drawHeight+gap;
    }
    const result=await new Promise((resolve,reject)=>canvas.toBlob(blob=>
      blob?resolve(blob):reject(new Error('Could not encode the combined image as PNG.')),'image/png'));
    return result;
  } finally {
    canvas.width=1;canvas.height=1;
  }
}
$('copy-all-images').onclick=()=>copyEditedImages(A.imgs.slice());

/* Base64 export in an isolated full-payload tab */
$('export-base64').onclick=()=>{
  const payload=A.imgs.map(m=>({name:m.name,mimeType:m.mime||'',dataUrl:m.url}));
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Complete Image Export JSON</title><style>
  :root{color-scheme:light;font-family:ui-monospace,Consolas,monospace;color:#17202b;background:#fff}*{box-sizing:border-box}body{margin:0;padding:24px clamp(16px,4vw,48px)}h1{margin:0 0 16px;font:600 16px/1.4 system-ui,sans-serif}main{max-width:100%}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;font:13px/1.5 ui-monospace,Consolas,monospace}</style></head>
  <body><main><h1>Complete image export</h1><pre id="base64-json" data-format="json" aria-label="Complete image export JSON"></pre></main>
  <script>const images=${JSON.stringify(payload).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')};document.getElementById('base64-json').textContent=JSON.stringify({images},null,2);<\/script></body></html>`;
  const blob=new Blob([html],{type:'text/html'}),url=URL.createObjectURL(blob),tab=window.open(url,'_blank');
  if(!tab)setStatus('status-annotation','The export tab was blocked. Allow pop-ups and try again.',true);else setStatus('status-annotation',payload.length?'Opened complete Base64 export in a new tab.':'Opened empty JSON export (no images available).');
  setTimeout(()=>URL.revokeObjectURL(url),60000);
};

/* ================= HTML TO VIDEO ================= */
const V={scenes:[],active:0,uid:0,url:null,renderRevision:0,audio:null};
const BASE='html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff;font-family:system-ui,sans-serif}';
const blank=n=>({id:++V.uid,name:'Scene '+n,tts:'',voice:'',html:'',css:'',js:'',duration:5});
const srcdoc=scene=>`<!doctype html><html><head><meta charset="utf-8"><style>${BASE}</style><style>${scene.css}</style></head><body>${scene.html}<script>${scene.js}<`+`/script></body></html>`;
let sceneSaveTimer;
function scheduleSceneSave(message='Saving…') {
  clearTimeout(sceneSaveTimer);setStatus('status-video',message,false,'saving');
  sceneSaveTimer=setTimeout(saveScenes,180);
}
async function saveScenes() {
  const epoch=mutationEpoch;
  try{const saved=await enqueueIdbWrite('scenes',V.scenes,()=>mutationEpoch===epoch);if(saved&&mutationEpoch===epoch)setStatus('status-video','Saved locally','', '');}
  catch(error){storageFailure('video',error);}
}
function clearSceneAudio() {
  if(V.audio){try{URL.revokeObjectURL(V.audio.url);}catch(_){}V.audio=null;}
  const audio=$('scene-generated-audio'),download=$('download-scene-audio');
  if(audio){audio.pause();audio.removeAttribute('src');audio.load();audio.hidden=true;}
  if(download){download.removeAttribute('href');download.hidden=true;}
}
window.addEventListener('beforeunload',clearSceneAudio);
function invalidateRenderedOutput() {
  V.renderRevision++;
  if(V.url){URL.revokeObjectURL(V.url);V.url=null;}
  $('video-output').removeAttribute('src');
  $('video-output').load();
  $('download-video').disabled=true;
  enqueueIdbDeleteKey('render').catch(error=>storageFailure('video',error));
}
function sizePreview(frame){
  if(!frame)return;
  const config=window.PerformanceManager?.getPreviewConfig();
  if(!config)return;
  const stage=frame.closest('.stage');
  if(!stage)return;
  stage.style.aspectRatio=`${config.width} / ${config.height}`;
  const fit=()=> {
    const scale=stage.clientWidth?stage.clientWidth/config.width:0.5;
    frame.style.width=config.width+'px';
    frame.style.height=config.height+'px';
    frame.style.transform=`scale(${scale})`;
  };
  fit();
}
function play(frameId,scene,msg){
  const frame=$(frameId);frame.srcdoc='';sizePreview(frame);
  requestAnimationFrame(()=>{frame.srcdoc=srcdoc(scene);sizePreview(frame);});
  if(msg)setStatus('status-video',msg);
}
window.addEventListener('resize',()=>document.querySelectorAll('.stage iframe').forEach(sizePreview));
document.addEventListener('performancechange',()=>document.querySelectorAll('.stage iframe').forEach(sizePreview));
document.addEventListener('performanceslow',()=>setStatus('status-video','Preview capture is slow. Lower preview quality in Device & Performance; export quality is unchanged.',true));
function addScene(initial=false) {
  const previous=V.scenes[V.active];V.scenes.push(blank(V.scenes.length+1));V.active=V.scenes.length-1;
  invalidateRenderedOutput();
  scheduleSceneSave('Adding scene…');renderScenes();
  if(!initial&&previous){$('auto-preview-box').hidden=false;$('auto-preview-title').textContent=`Previous: ${previous.name}`;play('last-scene-preview',previous);}
}
$('add-scene').onclick=()=>addScene(false);
function renderScenes(){
  clearSceneAudio();
  if(!V.scenes.length)V.scenes.push(blank(1));V.active=Math.min(V.active,V.scenes.length-1);
  const list=$('scene-list');list.innerHTML='';
  V.scenes.forEach((scene,index)=>{
    const button=document.createElement('button');button.type='button';button.id='scene-tab-'+(index+1);button.className='scene-tab';button.setAttribute('role','tab');button.setAttribute('aria-selected',index===V.active);button.setAttribute('aria-controls','scene-editor');button.textContent=`${index+1}: ${scene.name}`;
    button.onclick=()=>{V.active=index;renderScenes();};list.append(button);
  });
  const index=V.active,scene=V.scenes[index],number=index+1,editor=$('scene-editor');
  const taskBusy=Boolean(window.PerformanceManager?.getTask());
  editor.innerHTML=`<section id="scene-${number}" data-scene="${number}" aria-label="Scene ${number} editor">
  <div class="scene-header"><h3>Editing scene ${number} of ${V.scenes.length}</h3>
    <button type="button" id="scene-move-up" ${index?'':'disabled'}>Move up</button><button type="button" id="scene-move-down" ${index<V.scenes.length-1?'':'disabled'}>Move down</button><button type="button" id="scene-delete" class="danger-quiet">Delete scene</button></div>
  <div class="scene-meta"><div><label for="scene-name">Scene name</label><input type="text" id="scene-name" value="${esc(scene.name)}">
    <label for="scene-duration">Duration (seconds)</label><input type="number" id="scene-duration" min="1" max="120" step="0.5" value="${scene.duration}"></div>
    <div><label for="scene-tts">TTS transcript</label><textarea id="scene-tts">${esc(scene.tts)}</textarea>
      <div class="scene-audio-actions"><button type="button" id="generate-scene-audio" class="primary" ${scene.tts.trim()&&!taskBusy?'':'disabled'}>Generate transcript audio</button>
        <a id="download-scene-audio" class="button-link" download="scene-${number}-transcript.wav" hidden>Download transcript audio (WAV)</a></div>
      <audio id="scene-generated-audio" controls aria-label="Generated audio for scene ${number} transcript" hidden></audio>
      <p id="scene-audio-status" class="field-help" role="status" aria-live="polite">Generated WAV is separate from the rendered WebM and is not embedded in the video.</p></div></div>
  <div class="editors"><div><label for="scene-html">HTML</label><textarea id="scene-html" spellcheck="false">${esc(scene.html)}</textarea></div>
    <div><label for="scene-css">CSS</label><textarea id="scene-css" spellcheck="false">${esc(scene.css)}</textarea></div>
    <div><label for="scene-js">JavaScript</label><textarea id="scene-js" spellcheck="false">${esc(scene.js)}</textarea></div></div>
  <h3>Scene preview</h3><div class="preview-actions"><button type="button" id="play-preview" class="primary">Play preview</button><button type="button" id="restart-preview">Restart preview</button></div>
  <div class="stage"><iframe id="scene-preview" title="Scene ${number} preview" sandbox="allow-scripts allow-same-origin"></iframe></div></section>`;
  [['name','name'],['tts','tts'],['html','html'],['css','css'],['js','js']].forEach(([id,key])=>{
    $('scene-'+id).oninput=e=>{
      scene[key]=e.target.value;if(key==='name')$('scene-tab-'+number).textContent=`${number}: ${scene.name}`;
      if(key==='tts'){
        clearSceneAudio();
        $('generate-scene-audio').disabled=!scene.tts.trim()||Boolean(window.PerformanceManager?.getTask());
      }
      invalidateRenderedOutput();
      scheduleSceneSave();
    };
  });
  $('generate-scene-audio').onclick=async()=>{
    const transcript=$('scene-tts').value.trim(),sceneId=scene.id;
    if(!transcript)return;
    clearSceneAudio();
    $('generate-scene-audio').disabled=true;
    $('scene-audio-status').textContent='Generating transcript audio…';
    try{
      const result=await window.PerformanceManager.generateTranscript(transcript);
      if(V.scenes[V.active]?.id!==sceneId||scene.tts.trim()!==transcript)return;
      if(result.browserSpeech){
        $('scene-audio-status').textContent='Browser speech spoke this transcript, but browser speech cannot provide a downloadable WAV. Choose a neural engine for a separate WAV file.';
        return;
      }
      const url=URL.createObjectURL(result.blob);
      V.audio={sceneId,url};
      const audio=$('scene-generated-audio'),download=$('download-scene-audio');
      audio.src=url;audio.hidden=false;download.href=url;download.hidden=false;
      $('scene-audio-status').textContent='Transcript audio is ready. Play it here or download the separate WAV; it is not included in the rendered WebM.';
    }catch(error){
      if(V.scenes[V.active]?.id===sceneId&&scene.tts.trim()===transcript){
        $('scene-audio-status').textContent='Transcript audio was not generated: '+(error?.message||String(error))+' Your transcript and project remain unchanged.';
      }
    }finally{
      const generate=$('generate-scene-audio');
      if(generate)generate.disabled=!$('scene-tts').value.trim()||Boolean(window.PerformanceManager?.getTask());
    }
  };
  $('scene-duration').oninput=e=>{scene.duration=Math.max(1,+e.target.value||5);invalidateRenderedOutput();scheduleSceneSave();};
  let previewTimer;
  const go=()=>{clearTimeout(previewTimer);play('scene-preview',scene,`Playing scene ${number} for ${scene.duration}s.`);previewTimer=setTimeout(()=>setStatus('status-video',`Scene ${number} preview finished.`),scene.duration*1000);};
  $('play-preview').onclick=go;$('restart-preview').onclick=go;
  const move=delta=>{[V.scenes[index],V.scenes[index+delta]]=[V.scenes[index+delta],V.scenes[index]];V.active=index+delta;invalidateRenderedOutput();scheduleSceneSave(`Moved scene to position ${V.active+1}`);renderScenes();};
  $('scene-move-up').onclick=()=>move(-1);$('scene-move-down').onclick=()=>move(1);
  $('scene-delete').onclick=()=>{
    V.scenes.splice(index,1);V.active=Math.max(0,index-1);invalidateRenderedOutput();scheduleSceneSave(`Deleted scene ${number}`);renderScenes();
  };
}

async function snap(doc,width,height){
  const win=doc.defaultView,root=doc.documentElement.cloneNode(true);
  const source=[doc.documentElement,...doc.documentElement.querySelectorAll('*')],destination=[root,...root.querySelectorAll('*')],swaps=[];
  source.forEach((element,i)=>{
    const css=win.getComputedStyle(element);let style='';
    for(const property of css)style+=property+':'+css.getPropertyValue(property)+';';
    destination[i].setAttribute('style',style);
    if(element.tagName==='CANVAS'){try{const image=doc.createElement('img');image.setAttribute('src',element.toDataURL());image.setAttribute('style',style);swaps.push([destination[i],image]);}catch(_){}}
  });
  swaps.forEach(([oldNode,newNode])=>oldNode.replaceWith(newNode));
  root.querySelectorAll('script,style,head').forEach(element=>element.remove());
  const xml=new XMLSerializer().serializeToString(root),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
  const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});return image;
}
$('render-video').onclick=async()=>{
  const manager=window.PerformanceManager;
  if(V.rendering||manager?.getTask())return setStatus('status-video','Another performance-heavy task is already running.',true);
  if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream)return setStatus('status-video','This browser lacks MediaRecorder or canvas capture. Rendering is unavailable; your scenes are unchanged.',true);
  const mime=manager?.getCapabilities().mimeTypes?.[0]||
    ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mime)return setStatus('status-video','This browser cannot record WebM video.',true);
  if(!V.scenes.length)return setStatus('status-video','Add a scene before rendering.',true);
  if(manager?.ready)await manager.ready;
  let taskStarted=false,recorder=null,stream=null,frame=null,canvas=null,chunks=[];
  const renderRevision=V.renderRevision,renderEpoch=mutationEpoch;
  const button=$('render-video');
  button.disabled=true;$('add-scene').disabled=true;$('download-video').disabled=true;
  V.rendering=true;
  try{
    if(manager){await manager.beginTask('export');taskStarted=true;}
    const config=manager?manager.getExportConfig():{width:1280,height:720,fps:30};
    setStatus('status-video',`Preparing ${config.width}×${config.height} at ${config.fps} FPS (${mime}). Export quality will not be changed automatically.`);
    canvas=document.createElement('canvas');canvas.width=config.width;canvas.height=config.height;
    const graphics=canvas.getContext('2d');
    if(!graphics)throw new Error('Could not create an export canvas.');
    stream=canvas.captureStream(config.fps);
    recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:Math.max(2500000,Math.round(config.width*config.height*config.fps*0.08))});
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    let recorderError;
    recorder.onerror=e=>{recorderError=e.error||new Error('MediaRecorder failed.');};
    const stopped=new Promise(resolve=>{recorder.onstop=resolve;});
    frame=document.createElement('iframe');
    frame.setAttribute('sandbox','allow-scripts allow-same-origin');
    frame.style.cssText=`position:fixed;left:-10000px;top:0;width:${config.width}px;height:${config.height}px;border:0`;
    document.body.append(frame);
    graphics.fillStyle='#fff';graphics.fillRect(0,0,config.width,config.height);
    recorder.start(250);
    let failures=0,frames=0,firstCaptureError='';
    const framePeriod=1000/config.fps;
    for(let i=0;i<V.scenes.length;i++){
      if(renderRevision!==V.renderRevision||renderEpoch!==mutationEpoch)break;
      const scene=V.scenes[i];
      setStatus('status-video',`Rendering scene ${i+1} of ${V.scenes.length}: ${scene.name} (${scene.duration}s), ${config.width}×${config.height} / ${config.fps} FPS…`);
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Scene preview did not finish loading.')),10000);
        frame.onload=()=>{clearTimeout(timer);resolve();};
        frame.onerror=()=>{clearTimeout(timer);reject(new Error('Could not load scene for rendering.'));};
        frame.srcdoc=srcdoc(scene);
      });
      await sleep(100);
      const end=performance.now()+scene.duration*1000;
      while(performance.now()<end){
        if(renderRevision!==V.renderRevision||renderEpoch!==mutationEpoch)break;
        const started=performance.now();
        try{
          const image=await snap(frame.contentDocument,config.width,config.height);
          graphics.fillStyle='#fff';graphics.fillRect(0,0,config.width,config.height);
          graphics.drawImage(image,0,0,config.width,config.height);frames++;
        }catch(error){
          failures++;
          if(!firstCaptureError)firstCaptureError=error?.message||String(error);
          if(failures===1)setStatus('status-video','Some scene frames could not be captured; continuing sequentially: '+firstCaptureError);
        }
        const captureMs=performance.now()-started;
        manager?.recordFrame(captureMs,config.fps);
        await sleep(Math.max(0,framePeriod-captureMs));
      }
    }
    if(recorderError)throw recorderError;
    if(recorder.state==='recording')recorder.stop();
    await stopped;
    if(renderRevision!==V.renderRevision||renderEpoch!==mutationEpoch)return setStatus('status-video','Scenes changed during rendering. Render again to create updated output; selected export settings are unchanged.',true);
    if(!frames)throw new Error('No frames were captured. First capture error: '+(firstCaptureError||'unknown'));
    const blob=new Blob(chunks,{type:recorder.mimeType||mime});
    const saved=await enqueueIdbWrite('render',blob,()=>renderRevision===V.renderRevision&&renderEpoch===mutationEpoch);
    if(!saved||renderRevision!==V.renderRevision||renderEpoch!==mutationEpoch)return;
    if(V.url)URL.revokeObjectURL(V.url);V.url=URL.createObjectURL(blob);
    $('video-output').src=V.url;$('download-video').disabled=false;
    setStatus('status-video',`Video ready and saved locally: ${V.scenes.length} scene(s), ${config.width}×${config.height} at ${config.fps} FPS (${mime}).${failures?` ${failures} frame(s) could not be captured.`:''}`,failures>frames);
  }catch(error){
    if(recorder?.state==='recording'){
      try{recorder.stop();await new Promise(resolve=>{recorder.onstop=resolve;setTimeout(resolve,1500);});}catch(_){}
    }
    setStatus('status-video','Render error: '+(error?.message||error)+' Selected export settings were preserved.',true);
  }finally{
    if(stream)stream.getTracks().forEach(track=>{try{track.stop();}catch(_){}});
    if(frame){frame.srcdoc='';frame.remove();}
    if(canvas){canvas.width=1;canvas.height=1;}
    chunks.length=0;
    V.rendering=false;
    if(taskStarted)manager.endTask();
    button.disabled=false;$('add-scene').disabled=false;
  }
};
$('download-video').onclick=()=>{
  if(!V.url)return;const link=document.createElement('a');link.href=V.url;link.download='final-video.webm';document.body.append(link);link.click();link.remove();setStatus('status-video','Download started: final-video.webm');
};

$('clear-local-data').onclick=async()=>{
  if(!confirm('Clear all locally saved images, annotations, and scenes?'))return;
  clearTimeout(annotationSaveTimer);
  clearTimeout(sceneSaveTimer);
  mutationEpoch++;
  setStatus('status-annotation','Clearing local work…',false,'saving');
  setStatus('status-video','Clearing local work…',false,'saving');
  V.renderRevision++;
  if(V.url){URL.revokeObjectURL(V.url);V.url=null;}
  $('video-output').removeAttribute('src');$('video-output').load();$('download-video').disabled=true;
  try{
    await writeChain.catch(()=>{});
    await idbDelete();A.imgs=[];A.cur=-1;A.sel=null;V.scenes=[];V.active=0;refreshUI();renderScenes();
    setStatus('status-annotation','Local annotation work cleared.');
    setStatus('status-video','Local scenes cleared.');
    $('storage-detail').textContent='Project images, scenes, and rendered output were cleared. Device & Performance settings are preserved.';
  }catch(error){storageFailure('annotation',error);}
};

async function restore(){
  setStatus('status-annotation','Restoring local work…');setStatus('status-video','Restoring local scenes…');
  try{
    const [images,scenes,render]=await Promise.all([idbGet('images'),idbGet('scenes'),idbGet('render')]);
    if(Array.isArray(images)&&images.length){
      A.imgs=[];
      for(const record of images){
        const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=record.url;});
        const shapes=Array.isArray(record.shapes)?record.shapes:[];
        A.uid=Math.max(A.uid,Number(record.uid)||0,...shapes.map(shape=>Number(shape.id)||0));
        A.imgs.push({name:record.name,mime:record.mime,url:record.url,img:image,shapes,undo:[],uid:Number(record.uid)||++A.uid});
      }
      A.cur=0;
    }
    if(Array.isArray(scenes)){V.scenes=scenes.map((scene,index)=>{
      const clean={...blank(1),...scene};
      clean.name=clean.name||`Scene ${index+1}`;
      clean.tts=clean.tts||'';clean.voice=clean.voice||'';clean.html=clean.html||'';clean.css=clean.css||'';clean.js=clean.js||'';clean.duration=clean.duration||5;
      return clean;
    });V.uid=Math.max(0,...V.scenes.map(scene=>scene.id||0));}
    if(render instanceof Blob&&render.size){
      if(V.url)URL.revokeObjectURL(V.url);V.url=URL.createObjectURL(render);
      $('video-output').src=V.url;$('download-video').disabled=false;
    }else{
      $('video-output').removeAttribute('src');$('video-output').load();$('download-video').disabled=true;
    }
    setStatus('status-annotation','Saved locally');
    setStatus('status-video','Saved locally');
    $('storage-detail').textContent='Images, scenes, rendered video, and separate performance settings are saved with IndexedDB. Clearing browser site data removes them.';
  }catch(error){
    storageFailure('annotation',error);storageFailure('video',error);
  }
  refreshUI();renderScenes();
}
refreshUI();
restore();
window.addEventListener('beforeunload',()=>{
  clearTimeout(annotationSaveTimer);
  clearTimeout(sceneSaveTimer);
  saveAnnotation();
  saveScenes();
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden'){
    clearTimeout(annotationSaveTimer);
    clearTimeout(sceneSaveTimer);
    saveAnnotation();
    saveScenes();
  }
});
