// Plays a model pack's sounds (sounds/<name>.ogg) for animation sound
// keyframes and Molang ysm.play_sound, mirroring YSM's AudioPlayerManager:
// a sound with an id replaces the previous sound using that id.
export class YsmAudio {
  constructor(files=new Map()){
    this.files=files instanceof Map?files:new Map();
    this.buffers=new Map();this.voices=new Set();this.byId=new Map();
    this.context=null;this.muted=false;
  }
  get size(){return this.files.size;}
  ensureContext(){
    if(!this.context){const AudioContextClass=window.AudioContext||window.webkitAudioContext;if(!AudioContextClass)return null;this.context=new AudioContextClass();}
    if(this.context.state==='suspended')this.context.resume().catch(()=>{});
    return this.context;
  }
  buffer(name){
    const key=String(name).replace(/\\/g,'/').replace(/\.(ogg|wav|mp3)$/i,'');
    if(this.buffers.has(key))return this.buffers.get(key);
    const file=this.files.get(key)||this.files.get(key.toLowerCase());
    const context=file&&this.ensureContext();
    const promise=context?file.arrayBuffer().then(bytes=>context.decodeAudioData(bytes)).catch(()=>null):Promise.resolve(null);
    this.buffers.set(key,promise);return promise;
  }
  /** Returns false when the sound is unknown or audio is muted/unavailable. */
  play(name,{id=null,loop=false,volume=1,pitch=1}={}){
    if(this.muted||!name)return false;
    const key=String(name).replace(/\\/g,'/').replace(/\.(ogg|wav|mp3)$/i,'');
    if(!this.files.has(key)&&!this.files.has(key.toLowerCase()))return false;
    const context=this.ensureContext();if(!context)return false;
    if(id!==null&&id!==undefined)this.stop(id);
    const voice={source:null,stopped:false,id};
    this.voices.add(voice);if(id!==null&&id!==undefined)this.byId.set(id,voice);
    this.buffer(key).then(buffer=>{
      if(!buffer||voice.stopped){this.release(voice);return;}
      const source=context.createBufferSource(),gain=context.createGain();
      source.buffer=buffer;source.loop=Boolean(loop);source.playbackRate.value=Math.max(0.1,Number(pitch)||1);
      gain.gain.value=Math.max(0,Math.min(4,Number(volume)||0));
      source.connect(gain).connect(context.destination);
      source.onended=()=>this.release(voice);
      voice.source=source;source.start();
    });
    return true;
  }
  release(voice){this.voices.delete(voice);if(voice.id!==null&&voice.id!==undefined&&this.byId.get(voice.id)===voice)this.byId.delete(voice.id);}
  stopVoice(voice){voice.stopped=true;try{voice.source?.stop();}catch{}this.release(voice);}
  stop(id){const voice=this.byId.get(id);if(!voice)return false;this.stopVoice(voice);return true;}
  stopAll(){for(const voice of [...this.voices])this.stopVoice(voice);}
  setMuted(muted){this.muted=Boolean(muted);if(this.muted)this.stopAll();}
  dispose(){this.stopAll();this.context?.close().catch(()=>{});this.context=null;this.buffers.clear();}
}
