const isDesktop='__TAURI_INTERNALS__' in window;

// Saves a PNG blob. Desktop shows a system save dialog; the web build uses a browser download.
// Resolves to false when the user cancels the dialog.
export async function savePng(blob,filename){
  if(!isDesktop){
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    return true;
  }
  const [{ save },{ invoke }]=await Promise.all([import('@tauri-apps/plugin-dialog'),import('@tauri-apps/api/core')]);
  const path=await save({defaultPath:filename,filters:[{name:'PNG 图片',extensions:['png']}]});
  if(!path)return false;
  await invoke('save_file',new Uint8Array(await blob.arrayBuffer()),{headers:{path:encodeURIComponent(path)}});
  return true;
}
