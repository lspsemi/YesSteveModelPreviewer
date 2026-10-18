// Plays a model pack's sounds (sounds/<name>.ogg). Sounds are grouped in
// channels like YSM's AudioPlayerManager: every controller (and the main slot)
// owns one, so a state change or a new clip stops only that source's sounds,
// and a global channel serves ysm.play_sound's "global" flag.
export class YsmAudio {
  constructor(files=new Map()){
    this.files=files instanceof Map?files:new Map();
    this.buffers=new Map();this.channels=new Set();
    this.context=null;this.muted=false;
    this.global=this.createChannel();
  }
  get size(){return this.files.size;}
  key(name){return String(name??'').replace(/\\/g,'/').replace(/\.(ogg|wav|mp3)$/i,'');}
  has(name){const key=this.key(name);return Boolean(key)&&(this.files.has(key)||this.files.has(key.toLowerCase()));}
  createChannel(){const channel=new YsmAudioChannel(this);this.channels.add(channel);return channel;}
  ensureContext(){
    if(!this.context){const AudioContextClass=window.AudioContext||window.webkitAudioContext;if(!AudioContextClass)return null;this.context=new AudioContextClass();}
    if(this.context.state==='suspended')this.context.resume().catch(()=>{});
    return this.context;
  }
  buffer(name){
    const key=this.key(name);
    if(this.buffers.has(key))return this.buffers.get(key);
    const file=this.files.get(key)||this.files.get(key.toLowerCase()),context=file&&this.ensureContext();
    const promise=context?file.arrayBuffer().then(bytes=>context.decodeAudioData(bytes)).catch(()=>null):Promise.resolve(null);
    this.buffers.set(key,promise);return promise;
  }
  // Starts one voice; onEnd runs once when it finishes, fails or is stopped.
  startVoice(name,{loop=false,volume=1,pitch=1},onEnd){
    const context=this.ensureContext();
    const voice={source:null,ended:false,stop(){if(this.ended)return;this.ended=true;try{this.source?.stop();}catch{}onEnd(this);}};
    if(!context){voice.stop();return voice;}
    this.buffer(name).then(buffer=>{
      if(voice.ended)return;if(!buffer){voice.stop();return;}
      const source=context.createBufferSource(),gain=context.createGain();
      source.buffer=buffer;source.loop=Boolean(loop);source.playbackRate.value=Math.max(0.1,Number(pitch)||1);
      gain.gain.value=Math.max(0,Math.min(4,Number(volume)||0));
      source.connect(gain).connect(context.destination);
      source.onended=()=>{if(!voice.ended){voice.ended=true;onEnd(voice);}};
      voice.source=source;source.start();
    });
    return voice;
  }
  stopAll(){for(const channel of this.channels)channel.stopAll();}
  setMuted(muted){this.muted=Boolean(muted);if(this.muted)this.stopAll();}
  dispose(){this.stopAll();this.context?.close().catch(()=>{});this.context=null;this.buffers.clear();this.channels.clear();}
}

class YsmAudioChannel {
  constructor(audio){this.audio=audio;this.voices=new Set();this.byId=new Map();}
  /**
   * AudioPlayerManager.playSound: id 0 is untracked and plays alongside other
   * sounds; a non-zero id replaces its previous sound only with `force`,
   * otherwise the new sound is skipped while the old one is still playing.
   */
  play(name,{id=0,force=false,loop=false,volume=1,pitch=1}={}){
    const audio=this.audio;if(audio.muted||!audio.has(name))return false;
    const tracked=id!==0&&id!==null&&id!==undefined;
    if(tracked){const previous=this.byId.get(id);if(previous&&!previous.ended){if(!force)return false;previous.stop();}}
    const voice=audio.startVoice(name,{loop,volume,pitch},ended=>{this.voices.delete(ended);if(tracked&&this.byId.get(id)===ended)this.byId.delete(id);});
    if(voice.ended)return false;
    this.voices.add(voice);if(tracked)this.byId.set(id,voice);
    return true;
  }
  stop(id){const voice=this.byId.get(id);if(!voice)return false;voice.stop();return true;}
  stopAll(){for(const voice of [...this.voices])voice.stop();this.voices.clear();this.byId.clear();}
}
