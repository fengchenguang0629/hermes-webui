// workspace_selection_to_chat.js — "Send selected preview text to chat" (fork-local feature).
//
// PURPOSE
//   Right-click on selected text inside the workspace file preview (code /
//   markdown / CSV modes — the text-bearing preview surfaces) and add it as a
//   named context block. The block is injected into the NEXT outgoing message
//   by the existing selected-text-reply pipeline in messages.js
//   (the _addNamedContextBlock entry point, which stages named blocks as
//   chips above the composer and flushes them into the message on send).
//   This file deliberately does NOT reimplement the injection: it only feeds
//   the existing pipeline.
//
// DESIGN NOTES (fork-friendly / minimal-invasive)
//   - Self-contained: one file, one <script> line in index.html. No edits to
//     workspace.js / messages.js / i18n.js / style.css — the four most
//     merge-conflict-prone files stay untouched, so upstream merges stay clean.
//   - Loaded with `defer` AFTER messages.js, so the shared-globals namespace
//     (_addNamedContextBlock, showToast, _locale, …) is available at call time.
//   - Every dependency is typeof-guarded: if upstream renames or removes the
//     pipeline entry point, this feature degrades to a no-op (menu item shows
//     a gentle toast) instead of throwing a ReferenceError.
//   - i18n: a tiny built-in dictionary (en / zh / zh-Hant) with locale
//     detection via the active i18n.js `_locale._lang` tag (falling back to
//     <html lang>). Zero i18n.js footprint.
//   - All styling is inline on the created nodes — no style.css coupling.
//   - Stays out of the service-worker SHELL_ASSETS allowlist on purpose:
//     non-precached static files are still served network-first by the SW
//     fetch handler, and the ?v=__WEBUI_VERSION__ query keeps the browser
//     cache in sync with releases.
//   - Naming: every top-level symbol is prefixed `_wsSel2Chat` to avoid the
//     classic-shared-global collision class (see test_window_function_collision).
//
// SCOPE
//   - Active surfaces: #previewCode (code/plain-text), #previewMd (rendered
//     markdown AND csv table preview), #previewEditArea (the edit textarea).
//     Those are the text-bearing, selectable DOM nodes inside #previewArea.
//   - Explicitly out of scope: images, PDF/HTML iframes, audio/video — they
//     host cross-origin or non-text content the selection API cannot read.

(function _wsSel2ChatInit(){
  'use strict';

  // ── i18n — self-contained mini-dictionary ────────────────────────────────
  // Fork-local feature: copy lives HERE, not in i18n.js. i18n.js is the most
  // merge-conflict-prone file in the repo (16 locale blocks, hundreds of keys);
  // keeping our strings out of it means `git merge` with upstream never fights
  // over this feature. Locale detection mirrors i18n.js semantics: the active
  // locale object's `_lang` tag, falling back to the <html lang> attribute,
  // falling back to English.
  const _WS_SEL2CHAT_STRINGS={
    en:{
      label:'Add selection to chat',
      added:'Added to chat context: {0}',
      empty:'Select some text first',
      unavailable:'Add-to-chat is unavailable in this build',
      fallbackName:'Context'
    },
    zh:{
      label:'添加所选内容到对话',
      added:'已添加到对话上下文：{0}',
      empty:'请先选中一些文本',
      unavailable:'当前构建暂不支持添加到对话',
      fallbackName:'上下文'
    },
    'zh-Hant':{
      label:'新增所選內容到對話',
      added:'已新增到對話上下文：{0}',
      empty:'請先選取一些文字',
      unavailable:'目前建置暫不支援新增到對話',
      fallbackName:'上下文'
    }
  };

  function _wsSel2ChatLang(){
    try{
      // Preferred: the active locale's own _lang tag (set by i18n.js).
      const locale=(typeof _locale!=='undefined')?_locale:null;
      if(locale&&locale._lang&&_WS_SEL2CHAT_STRINGS[locale._lang])return locale._lang;
    }catch(_err){ /* fall through */ }
    try{
      // Fallback: <html lang="...">, normalized the same way i18n.js does
      // (zh-TW/zh-HK → zh-Hant, zh-CN/zh-SG/zh-Hans → zh).
      const raw=String((document.documentElement&&document.documentElement.lang)||'').trim().toLowerCase().replace(/_/g,'-');
      if(!raw)return 'en';
      if(raw==='zh'||raw.startsWith('zh-cn')||raw.startsWith('zh-sg')||raw.startsWith('zh-hans'))return 'zh';
      if(raw.startsWith('zh-hant')||raw.startsWith('zh-tw')||raw.startsWith('zh-hk')||raw.startsWith('zh-mo'))return 'zh-Hant';
    }catch(_err2){ /* fall through */ }
    return 'en';
  }

  function _wsSel2ChatStr(kind){
    const lang=_wsSel2ChatLang();
    const table=_WS_SEL2CHAT_STRINGS[lang]||_WS_SEL2CHAT_STRINGS.en;
    const val=table[kind];
    return (val!=null)?val:_WS_SEL2CHAT_STRINGS.en[kind];
  }

  function _wsSel2ChatLabel(){
    return _wsSel2ChatStr('label');
  }
  function _wsSel2ChatAddedToast(name){
    return String(_wsSel2ChatStr('added')).replace('{0}', name);
  }

  // ── Where are we allowed to act? ─────────────────────────────────────────
  const _WS_SEL2CHAT_SCOPES=['previewCode','previewMd','previewEditArea'];

  function _wsSel2ChatInScope(node){
    if(!node)return false;
    let el=(node.nodeType===1)?node:node.parentElement;
    while(el){
      if(_WS_SEL2CHAT_SCOPES.indexOf(el.id)!==-1)return true;
      el=el.parentElement;
    }
    return false;
  }

  // Selection snapshot captured on contextmenu (mousedown of the right click
  // can collapse the selection on some platforms BEFORE contextmenu fires, so
  // we also snapshot on mouseup as a safety net).
  let _wsSel2ChatSnapshot='';

  function _wsSel2ChatReadSelection(){
    if(!window.getSelection)return '';
    const sel=window.getSelection();
    if(!sel||sel.isCollapsed||!sel.rangeCount)return '';
    // Both endpoints must sit inside one of the scoped preview nodes.
    if(!_wsSel2ChatInScope(sel.anchorNode)||!_wsSel2ChatInScope(sel.focusNode))return '';
    const text=String(sel.toString()||'').replace(/\u00a0/g,' ').trim();
    return text;
  }

  // ── Human-friendly block name ────────────────────────────────────────────
  // Uses the currently previewed file path when available (module-global
  // _previewCurrentPath in workspace.js), else the selection's first words.
  function _wsSel2ChatBlockName(text){
    let file='';
    try{
      if(typeof _previewCurrentPath!=='undefined'&&_previewCurrentPath)file=String(_previewCurrentPath);
    }catch(_err){file='';}
    if(file){
      const base=file.split('/').pop()||file;
      return base.slice(0,120);
    }
    const first=String(text||'').replace(/\s+/g,' ').trim().slice(0,32);
    return first||_wsSel2ChatStr('fallbackName');
  }

  // ── The action ───────────────────────────────────────────────────────────
  function _wsSel2ChatAddToChat(){
    const text=_wsSel2ChatReadSelection()||_wsSel2ChatSnapshot;
    _wsSel2ChatSnapshot='';
    if(!text){
      if(typeof showToast==='function')showToast(_wsSel2ChatStr('empty'),2600,'info');
      return;
    }
    if(typeof _addNamedContextBlock!=='function'){
      // Upstream pipeline entry point missing (renamed/removed after a merge).
      if(typeof showToast==='function')showToast(_wsSel2ChatStr('unavailable'),3200,'warning');
      return;
    }
    const name=_wsSel2ChatBlockName(text);
    _addNamedContextBlock(text);
    if(typeof showToast==='function')showToast(_wsSel2ChatAddedToast(name),2600,'success');
  }

  // ── Context menu ─────────────────────────────────────────────────────────
  function _wsSel2ChatMenuItem(){
    const item=document.createElement('div');
    item.setAttribute('role','menuitem');
    item.tabIndex=0;
    item.textContent=_wsSel2ChatLabel();
    item.style.cssText='padding:7px 14px;cursor:pointer;font-size:13px;color:var(--text);white-space:nowrap;';
    item.onmouseenter=()=>{item.style.background='var(--hover-bg)';};
    item.onmouseleave=()=>{item.style.background='';};
    item.onclick=(e)=>{e.stopPropagation();_wsSel2ChatDismissMenu();_wsSel2ChatAddToChat();};
    item.onkeydown=(e)=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();_wsSel2ChatDismissMenu();_wsSel2ChatAddToChat();}
    };
    return item;
  }

  function _wsSel2ChatDismissMenu(){
    const menu=document.getElementById('wsSel2ChatMenu');
    if(menu)menu.remove();
    document.removeEventListener('click',_wsSel2ChatDismissMenu,true);
    window.removeEventListener('blur',_wsSel2ChatDismissMenu,true);
  }

  function _wsSel2ChatShowMenu(e){
    _wsSel2ChatDismissMenu();
    const menu=document.createElement('div');
    menu.id='wsSel2ChatMenu';
    menu.className='ws-sel2chat-menu';
    menu.setAttribute('role','menu');
    // Styling mirrors the existing .file-ctx-menu idiom in ui.js, but keeps
    // it inline so style.css never has to know about this fork-local feature.
    menu.style.cssText='position:fixed;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 0;z-index:9999;min-width:180px;box-shadow:0 4px 16px rgba(0,0,0,.35);';
    const vw=window.innerWidth,vh=window.innerHeight;
    const w=200,h=52;
    const left=(e.clientX+w>vw)?Math.max(8,e.clientX-w):e.clientX;
    const top=(e.clientY+h>vh)?Math.max(8,e.clientY-h):e.clientY;
    menu.style.left=left+'px';
    menu.style.top=top+'px';
    menu.appendChild(_wsSel2ChatMenuItem());
    document.body.appendChild(menu);
    // Dismiss on any outside click (capture phase so we win races with other
    // menus) and on window blur (alt-tab / open of the browser menu itself).
    setTimeout(()=>{
      document.addEventListener('click',_wsSel2ChatDismissMenu,true);
      window.addEventListener('blur',_wsSel2ChatDismissMenu,true);
    },0);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  if(typeof document==='undefined')return;

  // Snapshot on mouseup (right-button press can clear the selection first).
  document.addEventListener('mouseup',(e)=>{
    if(e.button===2)return; // right button: contextmenu handles it
    if(e.target&&e.target.closest&&e.target.closest('#wsSel2ChatMenu'))return;
    const text=_wsSel2ChatReadSelection();
    if(text)_wsSel2ChatSnapshot=text;
  });

  document.addEventListener('contextmenu',(e)=>{
    if(e.defaultPrevented)return;
    const text=_wsSel2ChatReadSelection();
    if(!text){
      // Nothing selected in scope (or selection collapsed by the right-click):
      // fall back to a recent in-scope snapshot so the menu still works after
      // the platform quirk that clears the selection on right mousedown.
      if(!_wsSel2ChatSnapshot)return;
      e.preventDefault();
      e.stopPropagation();
      _wsSel2ChatShowMenu(e);
      return;
    }
    _wsSel2ChatSnapshot=text;
    e.preventDefault();
    e.stopPropagation();
    _wsSel2ChatShowMenu(e);
  });
})();
