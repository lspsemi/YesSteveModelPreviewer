// Integrations that only apply when the page runs inside the Tauri desktop shell.
export async function setupDesktop(){
  if(!('__TAURI_INTERNALS__' in window))return;
  const [{ openUrl },{ getCurrentWindow }]=await Promise.all([import('@tauri-apps/plugin-opener'),import('@tauri-apps/api/window')]);
  // Open external links in the system browser instead of a new webview window.
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a[href]');
    if(!link||!/^https?:/i.test(link.href)||new URL(link.href).origin===location.origin)return;
    event.preventDefault();openUrl(link.href).catch(error=>console.error(error));
  });
  // The Fullscreen API only fills the webview, so also make the OS window fullscreen.
  document.addEventListener('fullscreenchange',()=>{getCurrentWindow().setFullscreen(Boolean(document.fullscreenElement)).catch(error=>console.error(error));});
}
