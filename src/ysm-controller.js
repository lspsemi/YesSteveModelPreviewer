import { evaluateMolang, executeMolangStatements, animationLength, animationLoopMode, animationBlendWeight, executeTimeline, sampleAnimationBones } from './ysm-animation.js';

const DEG=Math.PI/180;
const BUILTIN_STATE='ysm-builtin';
const ENTRY_STATE_PREFIX='ysm-entry-';
// EquipmentSlot.values() order in Minecraft 1.20.
const EQUIPMENT_SLOTS=['mainhand','offhand','feet','legs','chest','head'];

export function mergeControllerFiles(files=[]){
  const merged={};
  for(const file of files){
    const controllers=file?.animation_controllers||file?.['minecraft:animation_controllers']||{};
    for(const [name,controller] of Object.entries(controllers))merged[name]=controller;
  }
  return merged;
}

// Convert Bedrock/YSM controller JSON into ordered states. State and
// transition order matters because the first true transition wins.
export function normalizeControllers(rawControllers={}){
  const normalized=new Map();
  for(const [name,controller] of Object.entries(rawControllers||{})){
    const states=new Map();
    for(const [stateName,state] of Object.entries(controller?.states||{})){
      const transitions=[];
      for(const entry of state?.transitions||[]){
        if(!entry||typeof entry!=='object')continue;
        for(const [target,condition] of Object.entries(entry))transitions.push({target,condition:String(condition??'')});
      }
      const animations=[];
      for(const entry of Array.isArray(state?.animations)?state.animations:[]){
        if(typeof entry==='string'){if(entry)animations.push({name:entry,condition:null});continue;}
        if(!entry||typeof entry!=='object')continue;
        for(const [animation,condition] of Object.entries(entry))if(animation)animations.push({name:animation,condition:typeof condition==='string'||typeof condition==='number'?condition:null});
      }
      const soundEffects=(Array.isArray(state?.sound_effects)?state.sound_effects:state?.sound_effects?[state.sound_effects]:[]).map(item=>String(item?.effect??item??'')).filter(Boolean);
      states.set(stateName,{animations,transitions,on_entry:Array.isArray(state?.on_entry)?state.on_entry:[],on_exit:Array.isArray(state?.on_exit)?state.on_exit:[],sound_effects:soundEffects});
    }
    normalized.set(name,{initial_state:controller?.initial_state||controller?.initial||'default',states});
  }
  return normalized;
}

// Per-controller bone accumulator. Inside one controller state YSM sums the
// weighted rotations/positions of all active animations and multiplies their
// scales (AnimationControllerRuntime.BoneBlendState). Layers then overwrite
// earlier layers channel by channel (AnimationProcessor.applyTransform).
class BoneLayer {
  constructor(count){this.rotation=new Float32Array(count*3);this.position=new Float32Array(count*3);this.scale=new Float32Array(count*3);this.flags=new Uint8Array(count);this.touched=[];}
  clear(){for(const id of this.touched)this.flags[id]=0;this.touched.length=0;}
  add(id,rotation,position,scale,weight){
    const o=id*3;
    if(!this.flags[id]){this.touched.push(id);this.rotation.fill(0,o,o+3);this.position.fill(0,o,o+3);this.scale.fill(1,o,o+3);}
    if(rotation){this.flags[id]|=1;for(let i=0;i<3;i++)this.rotation[o+i]+=rotation[i]*weight;}
    if(position){this.flags[id]|=2;for(let i=0;i<3;i++)this.position[o+i]+=position[i]*weight;}
    if(scale){this.flags[id]|=4;for(let i=0;i<3;i++)this.scale[o+i]*=1+(scale[i]-1)*weight;}
  }
  // additiveRotation mirrors the deprecated parallel mode, which adds its
  // rotation on top of the layers below instead of replacing it.
  writeTo(skeleton,additiveRotation=false){
    const params=skeleton.params,rest=skeleton.rest;
    for(const id of this.touched){
      const p=id*9,o=id*3,flags=this.flags[id];
      if(flags&1){
        const x=this.rotation[o]*DEG,y=this.rotation[o+1]*DEG,z=this.rotation[o+2]*DEG;
        if(additiveRotation){params[p]-=x;params[p+1]-=y;params[p+2]+=z;}
        else{params[p]=rest[o]-x;params[p+1]=rest[o+1]-y;params[p+2]=rest[o+2]+z;}
      }
      if(flags&2){params[p+3]=this.position[o];params[p+4]=this.position[o+1];params[p+5]=this.position[o+2];}
      if(flags&4){params[p+6]=this.scale[o];params[p+7]=this.scale[o+1];params[p+8]=this.scale[o+2];}
    }
  }
}

function sampleInto(layer,animation,time,loopMode,context,index){
  const length=animationLength(animation);
  let t=time;
  if(loopMode==='loop'){if(length>0&&Number.isFinite(length))t=((time%length)+length)%length;else if(length===0)t=0;}
  else if(time>=length&&loopMode==='once')return false;
  else t=Math.min(time,length);
  const weight=animationBlendWeight(animation,context);
  sampleAnimationBones(animation,t,context,index,(id,rotation,position,scale)=>layer.add(id,rotation,position,scale,weight));
  return true;
}

// AnimationControllerInstance marks a clip finished once its local time
// passes the end; a looping clip stays "finished" after its first pass.
function slotFinished(animation,loopMode,elapsed){
  const length=animationLength(animation);
  return loopMode==='once'?elapsed>=length:elapsed>length;
}

// One Bedrock animation controller (AnimationControllerRuntime). Each state's
// clips start at the moment the state is entered.
class ControllerInstance {
  constructor(name,definition,builtin=null){this.name=name;this.definition=definition;this.builtin=builtin;this.reset();}
  reset(){this.stateName=null;this.state=null;this.enterTime=0;this.slots=[];}
  snapshot(){return {stateName:this.stateName,state:this.state,enterTime:this.enterTime,slots:this.slots.map(slot=>({...slot,timeline:{...slot.timeline}}))};}
  restore(saved){Object.assign(this,saved);}
  enter(stateName,state,context,now){
    if(this.state)executeMolangStatements(this.state.on_exit,context);
    executeMolangStatements(state.on_entry,context);
    for(const effect of state.sound_effects||[])context.audio?.play(effect);
    this.stateName=stateName;this.state=state;this.enterTime=now;
    const playsClips=stateName!==BUILTIN_STATE&&!stateName.startsWith(ENTRY_STATE_PREFIX);
    this.slots=playsClips?state.animations.map(entry=>({name:entry.name,condition:entry.condition,active:true,timeline:{last:-1,cycle:0}})):[];
  }
  update(context,now,animations){
    const visited=new Set();
    for(let guard=0;guard<64&&this.step(context,now,animations,visited);guard++)if(this.slots.length)break;
    for(const slot of this.slots){
      if(slot.condition!==null)slot.active=evaluateMolang(slot.condition,context)!==0;
      const animation=animations[slot.name];
      if(!slot.active||!animation)continue;
      const loopMode=animationLoopMode(animation),elapsed=now-this.enterTime;
      if(loopMode==='once'&&elapsed>animationLength(animation))continue;
      context.query.anim_time=elapsed;
      executeTimeline(animation,elapsed,context,slot.timeline,loopMode==='loop');
    }
  }
  step(context,now,animations,visited){
    const states=this.definition.states;
    if(!this.state){
      const initial=states.get(this.definition.initial_state);if(!initial)return false;
      visited.add(this.definition.initial_state);this.enter(this.definition.initial_state,initial,context,now);return true;
    }
    // query.all_animations_finished / any_animation_finished (PlaybackFlags).
    let active=0,allFinished=true,anyFinished=false;
    for(const slot of this.slots){
      const animation=animations[slot.name];if(!slot.active)continue;active++;
      if(!animation||slotFinished(animation,animationLoopMode(animation),now-this.enterTime))anyFinished=true;else allFinished=false;
    }
    if(!active)anyFinished=true;
    const query=context.query;query.all_animations_finished=allFinished?1:0;query.any_animation_finished=anyFinished?1:0;
    try{
      for(const transition of this.state.transitions){
        if(transition.condition&&evaluateMolang(transition.condition,context)===0)continue;
        const next=states.get(transition.target);
        if(!next||visited.has(transition.target))return false;
        visited.add(transition.target);this.enter(transition.target,next,context,now);return true;
      }
      return false;
    }finally{query.all_animations_finished=0;query.any_animation_finished=0;}
  }
  contribute(layer,context,now,animations,index){
    if(this.stateName===BUILTIN_STATE){this.builtin?.(layer,context,now);return;}
    for(const slot of this.slots){
      const animation=animations[slot.name];if(!slot.active||!animation)continue;
      sampleInto(layer,animation,now-this.enterTime,animationLoopMode(animation),context,index);
    }
  }
}

// Recreates PlayerAnimationController's processor pipeline for a third-person
// player without held items or armor: the controller order, which controller
// names claim which slot, and how plain parallelN clips fill unclaimed slots.
export class YsmControllerRuntime {
  constructor(controllers=new Map(),animations={},{preview=false}={}){
    this.controllers=controllers instanceof Map?controllers:normalizeControllers(controllers);
    this.animations=animations||{};
    this.layers=[];this.timelines=new Map();
    const names=[...this.controllers.keys()];
    const controller=(name,builtin=null)=>{const definition=this.controllers.get(name);if(definition)this.layers.push({instance:new ControllerInstance(name,definition,builtin)});};
    // ControllerSlotBinder: "player.<slot>" plus "player.<slot>_*", sorted.
    const slotGroup=slot=>{const pattern=new RegExp(`^player\\.${slot}(_.+)?$`);for(const name of names.filter(item=>pattern.test(item)).sort())controller(name);};
    // ParallelProcessor: controllers "player.<slot>_*" and clips "<slot>0".."<slot>7".
    const parallelGroup=slot=>{
      const slots=new Map(),pattern=new RegExp(`^player\\.${slot}_.+`),clipPattern=new RegExp(`^${slot}[0-7]$`);
      for(const name of names)if(pattern.test(name))slots.set(name,null);
      for(const [name,clip] of Object.entries(this.animations))if(clipPattern.test(name)&&!isEmptyAnimation(clip))slots.set(`player.${slot}_${name.slice(slot.length)}`,name);
      for(const key of [...slots.keys()].sort()){
        const linked=slots.get(key),builtin=linked?(layer,context,now)=>this.sampleBuiltin(layer,key,linked,context,now):null;
        if(this.controllers.has(key))this.layers.push({instance:new ControllerInstance(key,this.controllers.get(key),builtin),additive:true});
        else if(linked)this.layers.push({builtin,builtinKey:key,linked,additive:true});
      }
    };
    parallelGroup('pre_parallel');
    controller('player.vehicle');
    slotGroup('pre_main');
    if(this.controllers.has('player.main'))controller('player.main',(layer,context,now)=>this.sampleMain(layer,context));
    else this.layers.push({main:true});
    slotGroup('post_main');
    slotGroup('pre_hold');controller('player.hold_offhand');controller('player.hold_mainhand');slotGroup('post_hold');
    slotGroup('pre_swing');controller('player.swing');slotGroup('post_swing');
    slotGroup('pre_use');controller('player.use');slotGroup('post_use');
    controller('player.passenger');
    parallelGroup('parallel');
    // ArmorSlotProcessor only runs outside the GUI preview.
    if(!preview)for(const slot of EQUIPMENT_SLOTS)controller(`player.armor_${slot}`);
    this.layer=null;this.mainRequest=null;
  }
  reset(){for(const layer of this.layers)layer.instance?.reset();this.timelines.clear();}
  snapshot(){return {instances:this.layers.map(layer=>layer.instance?.snapshot()),timelines:new Map([...this.timelines].map(([key,value])=>[key,{...value}]))};}
  restore(saved){this.layers.forEach((layer,i)=>{if(layer.instance&&saved.instances[i])layer.instance.restore(saved.instances[i]);});this.timelines=saved.timelines;}
  timeline(key){let state=this.timelines.get(key);if(!state){state={last:-1,cycle:0};this.timelines.set(key,state);}return state;}
  // Built-in parallel clips are always played as LOOP (NamedAnimationPredicate).
  sampleBuiltin(layer,key,name,context,now){
    const animation=this.animations[name];if(!animation)return;
    if(this.advance){context.query.anim_time=now;executeTimeline(animation,now,context,this.timeline(key),true);}
    sampleInto(layer,animation,now,'loop',context,this.index);
  }
  // The main slot's built-in AnimationManager plays the selected clip as LOOP;
  // a request with loop:false plays it once and holds the end pose.
  sampleMain(layer,context){
    const request=this.mainRequest,animation=request&&this.animations[request.name];if(!animation)return;
    const loop=request.loop!==false;
    if(this.advance){context.query.anim_time=request.time;executeTimeline(animation,request.time,context,this.timeline(`main:${request.name}`),loop);}
    sampleInto(layer,animation,request.time,loop?'loop':'hold',context,this.index);
  }
  /** Restarts the main clip's timeline so its events and sounds fire again. */
  restartMain(name){this.timelines.delete(`main:${name}`);}
  apply({skeleton,context,now,main,advance=true}){
    if(!this.layer||this.layer.flags.length!==skeleton.count)this.layer=new BoneLayer(skeleton.count);
    this.index=skeleton.index;this.advance=advance;this.mainRequest=main;
    const layer=this.layer,animations=this.animations;
    for(const entry of this.layers){
      layer.clear();
      if(entry.instance){if(advance)entry.instance.update(context,now,animations);entry.instance.contribute(layer,context,now,animations,this.index);}
      else if(entry.main)this.sampleMain(layer,context);
      else entry.builtin(layer,context,now);
      layer.writeTo(skeleton,entry.additive&&(!entry.instance||entry.instance.stateName===BUILTIN_STATE));
    }
    context.query.anim_time=main?.time??now;
  }
}

// Animation.isEmpty(): no bone channels and no timeline/sound events.
function isEmptyAnimation(animation){
  const has=value=>value&&typeof value==='object'&&Object.keys(value).length>0;
  return !has(animation?.bones)&&!has(animation?.timeline)&&!has(animation?.sound_effects)&&!has(animation?.particle_effects);
}
