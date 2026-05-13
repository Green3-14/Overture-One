// pages/app.js
function b64urlEncode(s){ return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') }
function proxyFor(url, tabId){ return '/p/' + b64urlEncode(url) + (tabId ? '?tab='+encodeURIComponent(tabId) : '') }

const state = { tabs: [], active: null, history: [], bookmarks: [] }
const tabsBar = document.getElementById('tabs-bar')
const tabViews = document.getElementById('tab-views')
const omnibox = document.getElementById('omnibox')
const form = document.getElementById('omnibox-form')
const backBtn = document.getElementById('back')
const forwardBtn = document.getElementById('forward')
const reloadBtn = document.getElementById('reload')
const newTabBtn = document.getElementById('newtab')
const sidebarTabs = document.getElementById('sidebar-tabs')
const historyList = document.getElementById('history-list')
const bookmarksList = document.getElementById('bookmarks-list')

let idCounter = Date.now() % 100000

function saveState(){ localStorage.setItem('mini_browser_state', JSON.stringify(state)) }
function loadState(){
  try {
    const s = JSON.parse(localStorage.getItem('mini_browser_state')||'null')
    if (s) { state.tabs = s.tabs || []; state.active = s.active || (state.tabs[0] && state.tabs[0].id); state.history = s.history || []; state.bookmarks = s.bookmarks || [] }
  } catch(e){}
}
loadState()

function newTab(url='https://example.com') {
  const id = 't' + (++idCounter)
  const tab = { id, title: url, url, history:[url], idx:0 }
  state.tabs.push(tab); state.active = id
  renderAll(); saveState()
}

function renderAll(){
  renderTabs(); renderSidebar(); renderViews(); renderHistory(); renderBookmarks()
}
function renderTabs(){
  tabsBar.innerHTML = ''
  for (const t of state.tabs){
    const el = document.createElement('div'); el.className = 'tab' + (state.active===t.id ? ' active':''); el.textContent = t.title
    el.onclick = ()=>{ state.active = t.id; renderAll(); saveState() }
    tabsBar.appendChild(el)
  }
}
function renderSidebar(){
  sidebarTabs.innerHTML = ''
  for (const t of state.tabs){
    const li = document.createElement('li'); li.textContent = t.title; li.onclick = ()=>{ state.active = t.id; renderAll(); saveState() }
    sidebarTabs.appendChild(li)
  }
}
function renderViews(){
  tabViews.innerHTML = ''
  for (const t of state.tabs){
    const view = document.createElement('div'); view.className = 'tabview' + (state.active===t.id ? ' active':''); view.id = 'view-'+t.id
    const iframe = document.createElement('iframe')
    iframe.src = proxyFor(t.url, t.id)
    iframe.onload = ()=>{ /* nothing - cross-origin limits access */ }
    view.appendChild(iframe)
    tabViews.appendChild(view)
  }
  const cur = state.tabs.find(x=>x.id===state.active)
  omnibox.value = cur ? cur.url : ''
}
function renderHistory(){
  historyList.innerHTML = ''
  for (const h of state.history.slice(0,50)){
    const li = document.createElement('li'); const a = document.createElement('a'); a.href='#'; a.textContent = h.url
    a.onclick = (e)=>{ e.preventDefault(); omnibox.value = h.url; form.dispatchEvent(new Event('submit')) }
    li.appendChild(a); historyList.appendChild(li)
  }
}
function renderBookmarks(){
  bookmarksList.innerHTML = ''
  for (const b of state.bookmarks){
    const li = document.createElement('li'); const a = document.createElement('a'); a.href='#'; a.textContent=b
    a.onclick=(e)=>{ e.preventDefault(); omnibox.value=b; form.dispatchEvent(new Event('submit')) }
    li.appendChild(a); bookmarksList.appendChild(li)
  }
}

form.addEventListener('submit', e=>{
  e.preventDefault()
  let text = omnibox.value.trim()
  if (!text) return
  if (!/^https?:\/\//i.test(text)) text = 'https://www.google.com/search?q=' + encodeURIComponent(text)
  const tab = state.tabs.find(t=>t.id===state.active)
  if (!tab) { newTab(text); return }
  tab.url = text; tab.history = tab.history.slice(0, tab.idx+1); tab.history.push(text); tab.idx = tab.history.length-1
  const view = document.getElementById('view-'+tab.id)
  if (view) view.querySelector('iframe').src = proxyFor(text, tab.id)
  state.history.unshift({url:text, time:Date.now()}); if (state.history.length>200) state.history.pop()
  renderAll(); saveState()
})

backBtn.onclick = ()=>{ const tab = state.tabs.find(t=>t.id===state.active); if(!tab) return; if(tab.idx>0){ tab.idx--; tab.url=tab.history[tab.idx]; document.getElementById('view-'+tab.id).querySelector('iframe').src = proxyFor(tab.url, tab.id); renderAll(); saveState() } }
forwardBtn.onclick = ()=>{ const tab = state.tabs.find(t=>t.id===state.active); if(!tab) return; if(tab.idx < tab.history.length-1){ tab.idx++; tab.url=tab.history[tab.idx]; document.getElementById('view-'+tab.id).querySelector('iframe').src = proxyFor(tab.url, tab.id); renderAll(); saveState() } }
reloadBtn.onclick = ()=>{ const tab = state.tabs.find(t=>t.id===state.active); if(!tab) return; document.getElementById('view-'+tab.id).querySelector('iframe').src = proxyFor(tab.url, tab.id) }
newTabBtn.onclick = ()=> newTab('https://example.com')

function addBookmark(){
  const tab = state.tabs.find(t=>t.id===state.active); if(!tab) return; if(!state.bookmarks.includes(tab.url)) state.bookmarks.unshift(tab.url); renderBookmarks(); saveState()
}
document.addEventListener('keydown', (e)=>{ if (e.ctrlKey && e.key==='d') { e.preventDefault(); addBookmark() } })

if (!state.tabs.length) newTab('https://example.com')
renderAll()
