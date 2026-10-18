import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildBedrockModel } from './bedrock.js';
import { YsmControllerRuntime, mergeControllerFiles, normalizeControllers } from './ysm-controller.js';
import { YsmSkeleton } from './skeleton.js';
import { createYsmAnimationContext, advanceYsmPhysics, animationLength, animationLoopMode } from './ysm-animation.js';
import { YsmAudio } from './audio.js';

function parseJsonInWorker(file){
  if(typeof Worker==='undefined'||typeof URL.createObjectURL!=='function')return file.text().then(JSON.parse);
  const workerSource='self.onmessage=async e=>{try{const text=await e.data.text();self.postMessage({ok:true,value:JSON.parse(text)})}catch(error){self.postMessage({ok:false,error:error.message})}}';
  const workerUrl=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})),worker=new Worker(workerUrl);
  return new Promise((resolve,reject)=>{
    worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(workerUrl);if(event.data?.ok)resolve(event.data.value);else reject(new Error(event.data?.error||'动画 JSON 解析失败'));};
    worker.onerror=event=>{worker.terminate();URL.revokeObjectURL(workerUrl);reject(new Error(event.message||'动画 JSON 后台解析失败'));};
    worker.postMessage(file);
  });
}

async function loadLegacyTexture(url) {
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const bitmap=await createImageBitmap(await response.blob());
  const scanCanvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(bitmap.width,bitmap.height):Object.assign(document.createElement('canvas'),{width:bitmap.width,height:bitmap.height});
  const scanContext=scanCanvas.getContext('2d',{willReadFrequently:true});
  scanContext.drawImage(bitmap,0,0);
  const pixels=scanContext.getImageData(0,0,bitmap.width,bitmap.height).data;
  let hasTranslucency=false;
  for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0&&pixels[i]<255){hasTranslucency=true;break;}
  const texture=new THREE.Texture(bitmap);
  texture.flipY=false;
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.magFilter=THREE.NearestFilter;
  texture.minFilter=THREE.NearestFilter;
  texture.generateMipmaps=false;
  texture.needsUpdate=true;
  return {texture,hasTranslucency};
}

async function loadCardLayer(file,fallbackFile,declaredPath,id){
  const path=String(declaredPath||'').replaceAll('\\','/').replace(/^\/+/, '');
  if(!path)return null;
  const candidates=[file,fallbackFile].filter(Boolean);
  for(const candidate of candidates){
    let objectUrl;
    try{
      objectUrl=URL.createObjectURL(candidate);
      const image=new Image();image.src=objectUrl;await image.decode();
      return {url:objectUrl,image,owned:true};
    }catch(error){if(objectUrl)URL.revokeObjectURL(objectUrl);console.warn(`Could not load ${id}:`,error);}
  }
  return null;
}

export class ModelViewer {
  constructor(canvas, viewport, onTime) {
    this.canvas=canvas; this.viewport=viewport; this.onTime=onTime;
    this.playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.speed=1; this.time=0; this.elapsedTime=0; this.active=false; this.animationName='idle';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, preserveDrawingBuffer:true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.scene=new THREE.Scene();
    this.camera=new THREE.PerspectiveCamera(32,1,0.01,100);
    this.controls=new OrbitControls(this.camera,canvas);
    // Match the reference viewer: rotation and dragging stop immediately.
    this.controls.enableDamping=false;
    // The reference viewer handles wheel input itself: normalize the browser
    // delta mode, clamp one event's step, then scale camera distance by 1.15.
    // Disable OrbitControls' own wheel handling so the zoom is only applied once.
    this.controls.enableZoom=false;
    this.controls.minDistance=0.5; this.controls.maxDistance=20;
    this.onWheel=event=>{
      event.preventDefault();
      const unit=event.deltaMode===1?1/3:event.deltaMode===2?1:1/100;
      const exponent=THREE.MathUtils.clamp(event.deltaY*unit,-4,4);
      const distance=THREE.MathUtils.clamp(this.controls.getDistance()*Math.pow(1.15,exponent),0.5,20);
      const offset=this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(distance);
      this.camera.position.copy(this.controls.target).add(offset);
      this.controls.update();
    };
    canvas.addEventListener('wheel',this.onWheel,{passive:false});
    this.controls.autoRotateSpeed=1.3; this.controls.maxPolarAngle=Math.PI*0.92;
    this.grid=new THREE.GridHelper(16,64,0xd3bfd3,0xe3d5e2);
    this.grid.material.transparent=true; this.grid.material.opacity=0.5;
    this.grid.position.y=-0.035; this.scene.add(this.grid);
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x8d728d,2.8));
    const light=new THREE.DirectionalLight(0xffffff,1.8); light.position.set(-3,7,5); this.scene.add(light);
    this.resizeObserver=new ResizeObserver(()=>this.resize()); this.resizeObserver.observe(viewport);
    this.lastTime=0; this.tick=this.tick.bind(this);
  }

  async load() {
    const source=this.fileMap;
    if(!source?.model)throw new Error('未提供模型文件');
    this.time=0;this.elapsedTime=0;
    const metadata=source.metadata?await source.metadata.text().then(JSON.parse):{};
    const props=metadata.properties||metadata.metadata?.properties||{};
    this.releaseCardLayers();
    const cardLayers=await Promise.all([
      loadCardLayer(source.cardBackground,source.cardBackgroundFallback,props.gui_background,'gui_background'),
      loadCardLayer(source.cardForeground,source.cardForegroundFallback,props.gui_foreground,'gui_foreground'),
    ]);
    this.cardLayerObjectUrls=cardLayers.filter(Boolean).map(layer=>layer.url);
    this.cardBackgroundUrl=cardLayers[0]?.url||null;this.cardForegroundUrl=cardLayers[1]?.url||null;
    this.cardBackgroundImage=cardLayers[0]?.image||null;this.cardForegroundImage=cardLayers[1]?.image||null;
    const animationEntries=source.animationFiles?.length?source.animationFiles:[...(source.animation?[{id:'main',file:source.animation}]:[]),...(source.extraAnimation?[{id:'extra',file:source.extraAnimation}]:[])];
    const controllerEntries=source.controllerFiles||[];
    const loadEntry=async entry=>{
      return entry.file?parseJsonInWorker(entry.file):null;
    };
    const [model,animationFiles,controllerFiles]=await Promise.all([
      source.model.text().then(JSON.parse),
      Promise.all(animationEntries.map(entry=>loadEntry(entry).catch(error=>{console.warn(`Could not load animation file ${entry.path||entry.id}:`,error);return null;}))),
      Promise.all(controllerEntries.map(entry=>loadEntry(entry).catch(error=>{console.warn(`Could not load controller file ${entry.path}:`,error);return null;}))),
    ]);
    const animations={};for(const file of animationFiles)Object.assign(animations,file?.animations||{});
    const controllers=mergeControllerFiles(controllerFiles.filter(Boolean));
    const variants=textureSources(source);
    this.textureVariants=(await Promise.all(variants.map(async entry=>{
      let objectUrl;
      try{
        const url=objectUrl=URL.createObjectURL(entry.file);
        return {...entry,...await loadLegacyTexture(url)};
      }catch(error){console.warn(`Could not load texture ${entry.label}:`,error);return null;}
      finally{if(objectUrl)URL.revokeObjectURL(objectUrl);}
    }))).filter(Boolean);
    if(!this.textureVariants.length)throw new Error('模型包中没有可加载的贴图');
    const preferred=String(metadata.properties?.default_texture||'').trim().toLowerCase();
    const selectedByName=this.textureVariants.find(entry=>[entry.id,entry.label,entry.path].some(value=>String(value||'').toLowerCase()===preferred));
    const declaredTexture=metadata.files?.player?.texture;
    const firstDeclared=Array.isArray(declaredTexture)?declaredTexture[0]:declaredTexture;
    const declaredPath=typeof firstDeclared==='string'?firstDeclared:firstDeclared?.uv;
    const declaredKey=String(declaredPath||'').replaceAll('\\','/').replace(/^\/+/, '').toLowerCase();
    const selectedByDeclaration=this.textureVariants.find(entry=>String(entry.path||'').replaceAll('\\','/').toLowerCase()===declaredKey);
    const selected=selectedByName||selectedByDeclaration||this.textureVariants[0];
    this.currentTextureId=selected.id;
    // The original asset is unlit pixel artwork, so retain its authored colors.
    this.material=new THREE.MeshLambertMaterial({map:selected.texture,side:THREE.FrontSide,alphaTest:0.99,transparent:false,depthWrite:true});
    // YSM keeps depth writes enabled in its blended alpha pass. Disabling
    // them here lets translucent rear bone surfaces leak through front seams.
    this.translucentMaterial=new THREE.MeshLambertMaterial({map:selected.texture,side:THREE.FrontSide,alphaTest:0.1,transparent:true,depthWrite:true});
    this.translucentMaterial.onBeforeCompile=shader=>{
      shader.fragmentShader=shader.fragmentShader.replace('#include <alphatest_fragment>','#include <alphatest_fragment>\n#ifdef USE_ALPHATEST\nif ( diffuseColor.a >= 0.99 ) discard;\n#endif');
    };
    this.translucentMaterial.visible=selected.hasTranslucency;
    const bedrockGeometry=source?.bedrockModel||model['minecraft:geometry']?.[0];
    if(!bedrockGeometry?.bones)throw new Error('模型 JSON 中未找到 Bedrock 骨骼数据');
    this.root=buildBedrockModel({bedrockModel:bedrockGeometry},[this.material,this.translucentMaterial]);
    installGpuSkinning(this.material,this.root.userData.boneTexture);
    installGpuSkinning(this.translucentMaterial,this.root.userData.boneTexture);
    this.bones=this.root.userData.bones; this.animations=animations;
    this.skeleton=new YsmSkeleton(this.root.userData.skeletonBones);
    this.animationContext=createYsmAnimationContext();
    this.audio?.dispose();this.audio=new YsmAudio(source.soundFiles);this.animationContext.audio=this.audio;
    this.bindAnimationContext(this.animationContext);
    // YSM's folder schema places properties at the document root. Also accept
    // older metadata-wrapped exports so plugin options are not silently lost.
    this.customAnimationSlots=props.extra_animation&&typeof props.extra_animation==='object'?props.extra_animation:{};
    this.customAnimationGroups=Array.isArray(props.extra_animation_classify)?props.extra_animation_classify:[];
    this.customAnimationButtons=Array.isArray(props.extra_animation_buttons)?props.extra_animation_buttons:[];
    const slotNames=new Set();
    const collectSlotNames=value=>{if(typeof value==='string')slotNames.add(value);else if(Array.isArray(value))value.forEach(collectSlotNames);else if(value&&typeof value==='object')Object.entries(value).forEach(([key,item])=>{slotNames.add(key);collectSlotNames(item);});};
    collectSlotNames(this.customAnimationSlots);
    this.extraAnimationNames=new Set([...slotNames].filter(name=>Object.hasOwn(this.animations,name)));
    this.previewAnimationName=typeof props.preview_animation==='string'?props.preview_animation.trim():'';
    this.disablePreviewRotation=isYsmFlagEnabled(props.disable_preview_rotation??props.disablePreviewRotation);
    // Keep the interactive viewer straight-on. Model-card yaw/pitch and its
    // preview animation are applied only while rendering the generated cover.
    this.root.quaternion.identity();
    const widthScale=Number.isFinite(Number(props.width_scale))?Number(props.width_scale):0.7;
    const heightScale=Number.isFinite(Number(props.height_scale))?Number(props.height_scale):0.7;
    // IGeoRenderer applies height_scale to X/Z and width_scale to Y.
    this.modelScale=new THREE.Vector3(heightScale,widthScale,heightScale);
    this.rootPose=new THREE.Matrix4().makeScale(this.modelScale.x,this.modelScale.y,this.modelScale.z);
    this.controllerDefinitions=normalizeControllers(controllers);
    this.controllerRuntime=new YsmControllerRuntime(this.controllerDefinitions,this.animations);
    this.scene.add(this.root);
    // Render the authored model pose first. Animation sampling is kept out of
    // the base render path because YSM's Molang helper layers are not
    // equivalent to Blockbench keyframes.
    this.applyFrame(); this.reset(); this.resize();
    this.renderer.render(this.scene,this.camera);
  }

  async loadFiles(fileMap) {
    this.stopCardPreview();
    if(this.root){ this.scene.remove(this.root); this.root.traverse(node=>node.geometry?.dispose()); this.root.userData.boneTexture?.dispose(); this.root=null; }
    this.material?.dispose();this.translucentMaterial?.dispose();
    for(const entry of this.textureVariants||[]){entry.texture.dispose();entry.texture.image?.close?.();}
    this.releaseCardLayers();
    this.textureVariants=[];this.material=null;this.translucentMaterial=null;
    this.fileMap=fileMap;
    await this.load();
  }

  releaseCardLayers(){
    for(const url of this.cardLayerObjectUrls||[])URL.revokeObjectURL(url);
    this.cardLayerObjectUrls=[];this.cardBackgroundUrl=null;this.cardForegroundUrl=null;this.cardBackgroundImage=null;this.cardForegroundImage=null;
  }

  get duration() { return this.animations?.[this.animationName]?.animation_length || 1; }
  get autoRotate() { return this.controls.autoRotate; }
  set autoRotate(value) { this.controls.autoRotate=value; }
  get showGrid() { return this.grid.visible; }
  set showGrid(value) { this.grid.visible=value; }
  setTexture(id) {
    const entry=this.textureVariants?.find(item=>item.id===id);if(!entry||!this.material)return false;
    this.currentTextureId=entry.id;this.material.map=entry.texture;this.material.needsUpdate=true;
    if(this.translucentMaterial){this.translucentMaterial.map=entry.texture;this.translucentMaterial.visible=entry.hasTranslucency;this.translucentMaterial.needsUpdate=true;}
    this.renderer.render(this.scene,this.camera);return true;
  }
  setTheme(dark) {
    this.grid.material.color.set(dark?0x826b89:0xffffff);
    this.grid.material.opacity=dark?0.3:0.5;
    if(this.root)this.renderer.render(this.scene,this.camera);
  }
  resize() {
    const {width,height}=this.viewport.getBoundingClientRect();
    if(!width||!height)return;
    this.camera.aspect=width/height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(width,height,false);
  }
  reset() {
    // The source viewer frames the character around its torso rather than
    // the ground plane, which keeps the model visually centered in the tall
    // preview surface.
    this.controls.reset();this.controls.target.set(0,1.28,0);
    const distance=Math.max(6.8,4.5/Math.max(this.camera.aspect,0.6));
    this.camera.position.set(0,1.28,-distance);
    this.controls.update();
  }
  setView(view) {
    const distance=this.camera.position.distanceTo(this.controls.target);
    const center=this.controls.target;
    if(view==='side')this.camera.position.set(center.x+distance,center.y,center.z);
    else this.camera.position.set(center.x,center.y,center.z+(view==='back'?distance:-distance));
    this.controls.update();
  }
  /**
   * Plays a clip in the main slot. Locomotion loops; wheel actions pass
   * once:true to play the clip a single time (hold_on_last_frame clips then
   * keep their final pose, others report onAnimationEnd).
   */
  setAnimation(name,{once=false}={}) {
    const animation=this.animations[name];if(!animation)return;
    this.audio?.stopAll();this.controllerRuntime?.restartMain(name);
    this.animationName=name;this.time=0;this.playing=true;
    this.playMode=once?(animationLoopMode(animation)==='hold'?'hold':'once'):'loop';
    this.applyFrame();
  }
  bindAnimationContext(context) {
    context.boneRotationResolver=name=>{
      const id=this.skeleton?.index.get(name);if(id===undefined)return {x:0,y:0,z:0};
      const p=id*9,r=id*3,params=this.skeleton.params,rest=this.skeleton.rest;
      return {x:(rest[r]-params[p])*180/Math.PI,y:(rest[r+1]-params[p+1])*180/Math.PI,z:(params[p+2]-rest[r+2])*180/Math.PI};
    };
  }
  getMolangValue(expression) {
    const match=String(expression||'').trim().match(/^(?:v|variable)\.([\w$]+(?:\.[\w$]+)*)/);
    if(!match)return 0;
    let value=this.animationContext?.v;
    for(const key of match[1].split('.'))value=value?.[key];
    const number=Number(value);return Number.isFinite(number)?number:0;
  }
  setMolangVariable(expression,value) {
    const match=String(expression||'').trim().match(/^(?:v|variable)\.([\w$]+(?:\.[\w$]+)*)\s*(?:=\s*[-+]?\d+(?:\.\d+)?)?$/);
    if(!match)return false;
    const path=match[1].split('.');let target=this.animationContext?.v;
    if(!target)return false;
    for(const key of path.slice(0,-1))target=target[key];
    const inlineValue=String(expression).match(/=\s*([-+]?\d+(?:\.\d+)?)/);
    target[path.at(-1)]=inlineValue?Number(inlineValue[1]):value;
    this.applyFrame();this.renderer.render(this.scene,this.camera);return true;
  }
  // ---- Character card (YSM model picker preview) ----
  get cardAnimationName(){return this.previewAnimationName&&this.animations?.[this.previewAnimationName]?this.previewAnimationName:null;}
  createCardState(){
    // The GUI card uses the preview entity: its own Molang context and a
    // controller pipeline that skips armor controllers.
    const context=createYsmAnimationContext();this.bindAnimationContext(context);
    return {context,runtime:new YsmControllerRuntime(this.controllerDefinitions,this.animations,{preview:true}),time:0,elapsed:0};
  }
  // Applies the card animation state and ModelPreviewRenderer's pose, runs fn,
  // then restores the main viewer's state. The bone texture is left holding
  // the card pose; the main loop re-applies its own frame before rendering.
  withCardPose(state,guiHeight,fn){
    const saved={time:this.time,elapsedTime:this.elapsedTime,animationName:this.animationName,animationContext:this.animationContext,controllerRuntime:this.controllerRuntime,quaternion:this.root.quaternion.clone(),position:this.root.position.clone(),scale:this.root.scale.clone(),rootPose:this.rootPose.clone(),grid:this.grid.visible};
    // Match ModelPreviewRenderer.renderLivingEntityPreview and ModelButton:
    // the 52x90 button clips the preview to 52x70 and draws at GUI scale 30.
    // The entity yaw is 200° (180° with rotation disabled) and the outer
    // transform is pitched by -10° (0° when disabled).
    const pose=previewCardPose(this.disablePreviewRotation);
    this.animationName=this.cardAnimationName;this.animationContext=state.context;this.controllerRuntime=state.runtime;
    this.time=state.time;this.elapsedTime=state.elapsed;this.grid.visible=false;
    this.rootPose.identity();
    this.root.scale.set(this.modelScale.x*30,this.modelScale.y*30,this.modelScale.z*30);
    const tilt=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),THREE.MathUtils.degToRad(pose.pitch));
    const yaw=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(pose.yawOffset));
    this.root.quaternion.copy(tilt).multiply(yaw);
    // ModelButton renders at y + height/2 + 20, so the ground line sits 65 GUI
    // pixels below the clipped preview top (root.position is in GUI units).
    this.root.position.set(0,guiHeight/2-pose.baseline,0);
    try{return fn();}
    finally{
      this.time=saved.time;this.elapsedTime=saved.elapsedTime;this.animationName=saved.animationName;this.animationContext=saved.animationContext;this.controllerRuntime=saved.controllerRuntime;
      this.root.quaternion.copy(saved.quaternion);this.root.position.copy(saved.position);this.root.scale.copy(saved.scale);this.rootPose.copy(saved.rootPose);this.grid.visible=saved.grid;
    }
  }
  // Fixed GUI-scale orthographic view: 52 GUI pixels span the card width.
  cardCamera(width,height){
    const guiHeight=height/(width/52),camera=new THREE.OrthographicCamera(-26,26,guiHeight/2,-guiHeight/2,0.01,5000);
    // Bedrock's model front faces -Z; view the unmirrored model from the front.
    camera.position.set(0,0,-1000);camera.lookAt(0,0,0);camera.updateProjectionMatrix();
    return {camera,guiHeight};
  }
  /** Plays the preview animation live in the sidebar card canvas. */
  startCardPreview(canvas,{duration=5,onTime=null}={}){
    this.stopCardPreview();
    if(!this.cardAnimationName||!this.root)return false;
    const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false});
    renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x000000,0);
    this.card={canvas,renderer,duration:Math.max(0.1,Number(duration)||5),onTime,playing:true,dirty:true,state:this.createCardState(),camera:null,guiHeight:0};
    this.card.observer=new ResizeObserver(()=>this.resizeCard());this.card.observer.observe(canvas);
    this.resizeCard();this.ensureLoop();
    return true;
  }
  stopCardPreview(){
    if(!this.card)return;
    this.card.observer.disconnect();this.card.renderer.dispose();this.card=null;
  }
  resizeCard(){
    const card=this.card;if(!card)return;
    const bounds=card.canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
    const width=Math.max(1,Math.round(bounds.width*ratio)),height=Math.max(1,Math.round(bounds.height*ratio));
    card.renderer.setSize(width,height,false);
    Object.assign(card,this.cardCamera(width,height));card.dirty=true;this.ensureLoop();
  }
  setCardPlaying(playing){if(!this.card)return;this.card.playing=Boolean(playing);this.card.dirty=true;this.ensureLoop();}
  /** Jumps the card to a time without re-simulating physics or controllers. */
  seekCard(time){
    const card=this.card;if(!card)return;
    const target=Math.min(card.duration,Math.max(0,Number(time)||0));
    if(target<card.state.elapsed)card.state=this.createCardState();
    card.state.elapsed=target;card.state.time=target;card.dirty=true;this.ensureLoop();
  }
  advanceCard(delta){
    const card=this.card,state=card.state;
    state.elapsed+=delta;
    // Loop the (capped) preview duration from a fresh state, like the in-game
    // preview restarting its animation.
    if(state.elapsed>card.duration){card.state=this.createCardState();return;}
    state.time=state.elapsed;advanceYsmPhysics(state.context,delta);
  }
  renderCard(){
    const card=this.card;if(!card?.camera)return;
    this.withCardPose(card.state,card.guiHeight,()=>{this.applyFrame(true);card.renderer.render(this.scene,card.camera);});
    card.dirty=false;card.onTime?.(card.state.time,card.duration);
  }
  /**
   * Renders the card frame at `time` seconds (with background, foreground and
   * title) as a PNG.
   */
  async renderCardImage({width=300,height=400,fullCardHeight=null,includeCardChrome=true,title='',time=0}={}){
    if(!this.cardAnimationName||!this.root)return null;
    const cardHeight=includeCardChrome?Math.max(height,Number(fullCardHeight)||Math.round(height*9/7)):height;
    this.renderSuspended=true;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false,preserveDrawingBuffer:true});
    renderer.setPixelRatio(1);renderer.setSize(width,height,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x000000,0);
    try{
      const {camera,guiHeight}=this.cardCamera(width,height),state=this.createCardState();
      this.withCardPose(state,guiHeight,()=>this.applyFrame(true));
      // Jump to the requested time; timeline events in between still run once.
      const target=Math.max(0,Number(time)||0);
      if(target>0){state.elapsed=target;state.time=target;this.withCardPose(state,guiHeight,()=>this.applyFrame(true));}
      await renderer.compileAsync(this.scene,camera);
      this.withCardPose(state,guiHeight,()=>{this.applyFrame(false);renderer.render(this.scene,camera);});
      renderer.getContext().finish();
      const surface=document.createElement('canvas');surface.width=width;surface.height=cardHeight;
      const ctx=surface.getContext('2d');ctx.imageSmoothingEnabled=false;
      if(includeCardChrome&&this.cardBackgroundImage)ctx.drawImage(this.cardBackgroundImage,0,0,width,cardHeight);
      ctx.drawImage(canvas,0,0,width,height);
      if(includeCardChrome){if(this.cardForegroundImage)ctx.drawImage(this.cardForegroundImage,0,0,width,cardHeight);drawCardTitle(ctx,title,width,height,cardHeight);}
      return await new Promise((resolve,reject)=>surface.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成人物卡 PNG')),'image/png'));
    }finally{
      renderer.dispose();this.renderSuspended=false;
      if(this.card)this.card.dirty=true;
      this.applyFrame(false);this.ensureLoop();
    }
  }
  seek(time) { this.time=Math.max(0,Math.min(time,this.duration));this.playing=false;this.applyFrame();this.onTime(this.time,this.duration); }
  setActive(active) {
    if(this.active===active)return; this.active=active;
    if(!active)this.audio?.stopAll();
    if(active){this.resize();this.ensureLoop();}
  }
  // One animation loop drives both the 3D view (when its tab is visible) and
  // the sidebar card, which stays live on every tab.
  ensureLoop(){
    if(this.frame||(!this.active&&!this.card))return;
    this.lastTime=performance.now();this.frame=requestAnimationFrame(this.tick);
  }
  tick(now) {
    this.frame=0;
    if(!this.active&&!this.card)return;
    const delta=Math.max(0,Math.min((now-this.lastTime)/1000,0.1));this.lastTime=now;
    if(!document.hidden&&!this.renderSuspended){
      if(this.card){if(this.card.playing){this.advanceCard(delta);this.card.dirty=true;}if(this.card.dirty)this.renderCard();}
      if(this.active){
        if(this.playing){
          const elapsed=delta*this.speed;this.elapsedTime+=elapsed;advanceYsmPhysics(this.animationContext,elapsed);
          if(!this.playMode||this.playMode==='loop')this.time=(this.time+elapsed)%this.duration;
          else{
            // A clip without animation_length never ends (it simply holds its last keyframes).
            const length=animationLength(this.animations?.[this.animationName]);
            this.time+=elapsed;
            if(this.time>=length){this.time=length;if(this.playMode==='once'){this.playMode='hold';this.onAnimationEnd?.(this.animationName);}}
          }
        }
        this.applyFrame();this.controls.update(delta);this.renderer.render(this.scene,this.camera);
        this.onTime(this.time,this.duration);
      }
    }
    this.frame=requestAnimationFrame(this.tick);
  }
  applyFrame(advanceTimeline=true) {
    if(!this.skeleton||!this.root)return;
    // Layers follow the game's controller order (see ysm-controller.js).
    this.skeleton.reset();
    const context=this.animationContext;
    context.time=this.time;context.lifeTime=this.elapsedTime;context.query.anim_time=this.time;context.query.life_time=this.elapsedTime;
    context.ctrl.playing_extra_animation=this.extraAnimationNames?.has(this.animationName)?1:0;
    for(const name of ['idle','walk','run','jump'])context.ctrl[name]=this.animationName===name?1:0;
    this.controllerRuntime?.apply({skeleton:this.skeleton,context,now:this.elapsedTime,main:this.animationName?{name:this.animationName,time:this.time,loop:!this.playMode||this.playMode==='loop'}:null,advance:advanceTimeline});
    const matrices=this.skeleton.computeMatrices(this.rootPose);
    this.root.userData.setAnimationBoneVisibility(this.skeleton.visible);
    this.root.userData.updateBoneTexture(matrices,this.skeleton.normalMatrices);
  }
  /** Renders the current view without the grid and resolves to a PNG blob. */
  screenshot(watermark={}) {
    const gridVisible=this.grid.visible;let image;
    try{
      this.grid.visible=false;this.renderer.render(this.scene,this.camera);
      if(watermark.enabled&&String(watermark.text||'').trim()){
        const output=document.createElement('canvas');output.width=this.canvas.width;output.height=this.canvas.height;
        const context=output.getContext('2d');context.drawImage(this.canvas,0,0);drawTiledWatermark(context,watermark.text,watermark.color,watermark.opacity,output.width,output.height);image=output.toDataURL('image/png');
      }else image=this.canvas.toDataURL('image/png');
    }
    finally{this.grid.visible=gridVisible;this.renderer.render(this.scene,this.camera);}
    return fetch(image).then(response=>response.blob());
  }
  dispose() {
    this.setActive(false);this.stopCardPreview();this.audio?.dispose();this.audio=null;if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;this.resizeObserver.disconnect();this.canvas.removeEventListener('wheel',this.onWheel);this.controls.dispose();
    this.root?.traverse(o=>o.geometry?.dispose());this.root?.userData.boneTexture?.dispose();this.material?.dispose();this.translucentMaterial?.dispose();
    for(const entry of this.textureVariants||[]){entry.texture.dispose();entry.texture.image?.close?.();}
    this.releaseCardLayers();
    this.grid.geometry.dispose();this.grid.material.dispose();this.renderer.dispose();
  }
}

function isYsmFlagEnabled(value){
  return value===true||value===1||(typeof value==='string'&&/^(?:true|1)$/i.test(value.trim()));
}

function installGpuSkinning(material,boneTexture){
  const previousCompile=material.onBeforeCompile;
  const previousCacheKey=material.customProgramCacheKey.bind(material);
  material.onBeforeCompile=shader=>{
    previousCompile?.(shader,material.renderer);
    shader.uniforms.ysmBoneTexture={value:boneTexture};
    shader.uniforms.ysmBoneTextureHeight={value:boneTexture.image.height};
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
attribute float ysmBoneIndex;
uniform sampler2D ysmBoneTexture;
uniform float ysmBoneTextureHeight;
varying float vYsmBoneVisible;
vec4 ysmBoneTexel(float column){return texture2D(ysmBoneTexture,vec2((column+0.5)/8.0,(ysmBoneIndex+0.5)/ysmBoneTextureHeight));}`);
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
mat3 ysmBoneNormal=mat3(ysmBoneTexel(4.0).xyz,ysmBoneTexel(5.0).xyz,ysmBoneTexel(6.0).xyz);
objectNormal=normalize(ysmBoneNormal*objectNormal);
vYsmBoneVisible=ysmBoneTexel(7.0).r;`);
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
mat4 ysmBoneMatrix=mat4(ysmBoneTexel(0.0),ysmBoneTexel(1.0),ysmBoneTexel(2.0),ysmBoneTexel(3.0));
transformed=(ysmBoneMatrix*vec4(transformed,1.0)).xyz;`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying float vYsmBoneVisible;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif(vYsmBoneVisible<0.5)discard;');
  };
  material.customProgramCacheKey=()=>`${previousCacheKey()}|ysm-gpu-skin-v1`;
}

// Mirror the two ModelPreviewRenderer angle branches used by YSM's model picker.
// With disable_preview_rotation enabled, the model faces straight forward and
// the source renderer adds its 5.5 GUI-unit vertical offset.
function previewCardPose(disableRotation){
  return disableRotation?{yawOffset:0,pitch:0,baseline:70.5}:{yawOffset:-20,pitch:-10,baseline:65};
}

function drawCardTitle(ctx,value,width,previewHeight,cardHeight){
  const colors={0:'#000000',1:'#0000aa',2:'#00aa00',3:'#00aaaa',4:'#aa0000',5:'#aa00aa',6:'#ffaa00',7:'#aaaaaa',8:'#555555',9:'#5555ff',a:'#55ff55',b:'#55ffff',c:'#ff5555',d:'#ff55ff',e:'#ffff55',f:'#ffffff'};
  const runs=[];let style={color:'#f4edf4',bold:false,italic:false},buffer='';
  const flush=()=>{if(buffer){runs.push({text:buffer,...style});buffer='';}};
  const text=String(value??'');
  for(let i=0;i<text.length;i++){
    if(text[i]!=='§'||i+1>=text.length){buffer+=text[i];continue;}
    const hex=/^§x(?:§[0-9a-f]){6}/i.exec(text.slice(i));
    if(hex){flush();style={...style,color:'#'+[...hex[0].matchAll(/§([0-9a-f])/gi)].map(match=>match[1]).join(''),bold:false,italic:false};i+=hex[0].length-1;continue;}
    const code=text[i+1].toLowerCase();if(!/[0-9a-fk-or]/.test(code)){buffer+=text[i];continue;}flush();i++;
    if(colors[code])style={color:colors[code],bold:false,italic:false};else if(code==='r')style={color:'#f4edf4',bold:false,italic:false};else if(code==='l')style={...style,bold:true};else if(code==='o')style={...style,italic:true};
  }
  flush();
  const scale=width/300,size=22*scale,lineHeight=28*scale,maxWidth=width-28*scale,lines=[[]];
  const setFont=run=>{ctx.font=`${run.italic?'italic ':''}${run.bold?'700':'600'} ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;};
  for(const run of runs)for(const char of run.text){
    if(char==='\n'){lines.push([]);continue;}
    setFont(run);const current=lines.at(-1),lineWidth=current.reduce((sum,item)=>{setFont(item);return sum+ctx.measureText(item.text).width;},0);
    if(current.length&&lineWidth+ctx.measureText(char).width>maxWidth)lines.push([]);
    lines.at(-1).push({...run,text:char});
  }
  const visibleLines=lines.slice(0,Math.max(1,Math.floor((cardHeight-previewHeight-12*scale)/(24*scale)))),footerHeight=cardHeight-previewHeight,startY=previewHeight+(footerHeight-visibleLines.length*lineHeight)/2+size;
  ctx.save();ctx.textBaseline='alphabetic';ctx.shadowColor='#000b';ctx.shadowBlur=3;ctx.shadowOffsetY=1;
  visibleLines.forEach((line,index)=>{
    const lineWidth=line.reduce((sum,run)=>{setFont(run);return sum+ctx.measureText(run.text).width;},0);let x=(width-lineWidth)/2,y=startY+index*lineHeight;
    for(const run of line){setFont(run);ctx.fillStyle=run.color;ctx.fillText(run.text,x,y);x+=ctx.measureText(run.text).width;}
  });
  ctx.restore();
}

function drawTiledWatermark(ctx,value,color,opacity,width,height){
  const text=String(value||'').trim();if(!text)return;
  const size=Math.max(16,Math.round(width/34)),diagonal=Math.ceil(Math.hypot(width,height));
  ctx.save();ctx.translate(width/2,height/2);ctx.rotate(-Math.PI/6);ctx.font=`600 ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle=/^#[0-9a-f]{6}$/i.test(color||'')?color:'#ffffff';ctx.globalAlpha=Number.isFinite(Number(opacity))?Math.min(1,Math.max(0,Number(opacity))):.2;ctx.textAlign='center';ctx.textBaseline='middle';
  const textWidth=ctx.measureText(text).width,stepX=Math.max(textWidth+size*3,size*7),stepY=size*4.5;
  let row=0;for(let y=-diagonal;y<=diagonal;y+=stepY,row++){const offset=row%2?stepX/2:0;for(let x=-diagonal+offset;x<=diagonal;x+=stepX)ctx.fillText(text,x,y);}
  ctx.restore();
}

function extendCoverBounds(bounds,geometry,matrix){
  const p=geometry.attributes.position.array,point=new THREE.Vector3();
  for(const group of geometry.groups){if(!group.count)continue;const first=(group.start/6)*4,last=first+(group.count/6)*4;for(let v=first;v<last;v++){const i=v*3;point.set(p[i],p[i+1],p[i+2]).applyMatrix4(matrix);bounds.expandByPoint(point);}}
}

function textureSources(source){
  const provided=Array.isArray(source.textures)?source.textures:source.texture?[{file:source.texture}]:[];
  return provided.map((entry,index)=>{
    const file=entry.file||entry;
    const path=entry.path||file.webkitRelativePath?.split('/').slice(1).join('/')||file.name||`texture-${index+1}`;
    return {id:entry.id||path,path,label:entry.label||textureLabel(path),file};
  });
}

function textureLabel(path){
  const name=String(path).split(/[\\/]/).pop()||String(path);
  return name.replace(/\.[^.]+$/,'');
}

