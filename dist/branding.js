import { Resvg } from "@resvg/resvg-js";
/** Original "Pr"-style mark drawn in SVG (purple rounded square, lavender letters). */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect x="8" y="8" width="240" height="240" rx="52" fill="#00005B"/>
<rect x="8" y="8" width="240" height="240" rx="52" fill="none" stroke="#9999FF" stroke-width="10"/>
<path d="M62 186V70h40c26 0 42 13 42 36s-16 37-42 37H84v43z M84 124h17c13 0 21-6 21-18s-8-17-21-17H84z" fill="#9999FF"/>
<path d="M156 186V104h20v14c5-10 13-15 25-15v21c-15 0-25 6-25 22v40z" fill="#9999FF"/>
</svg>`;
let pngCache = null;
export function iconPngBase64() {
    if (!pngCache)
        pngCache = Buffer.from(new Resvg(ICON_SVG, { fitTo: { mode: "width", value: 128 } }).render().asPng()).toString("base64");
    return pngCache;
}
export function icons() {
    return [
        { src: `data:image/png;base64,${iconPngBase64()}`, mimeType: "image/png", sizes: ["128x128"] },
        { src: `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["any"] },
    ];
}
export const WIDGET_URI = "ui://premiere-pro-plus/activity.html";
/**
 * MCP App (SEP-1865) view rendered inline by Claude for every Premiere tool call:
 * shows the Premiere mark, the action being performed, live status, a short
 * result summary and any frame previews. Implements the ui/* postMessage
 * protocol directly so the page stays tiny (no 500 KB SDK bundle).
 */
export function widgetHtml() {
    const icon = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString("base64")}`;
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Premiere Pro</title>
<style>
:root{--bg:#ffffff;--fg:#1f1f24;--muted:#6b6b76;--line:#e6e6ec;--chip:#f1f1f6;--ok:#13a36b;--run:#7a5af8;--err:#d92d48;--acc:#9999ff;}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1f1f22;--fg:#ececf1;--muted:#a0a0ab;--line:#33333a;--chip:#2a2a30;}}
:root[data-theme=dark]{--bg:#1f1f22;--fg:#ececf1;--muted:#a0a0ab;--line:#33333a;--chip:#2a2a30;}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--bg)}
.row{display:flex;align-items:center;gap:10px}
.icon{width:28px;height:28px;border-radius:7px;flex:none}
.t{font-weight:600}.sub{color:var(--muted);font-size:12px}
.chip{margin-left:auto;font-size:11.5px;padding:3px 9px;border-radius:999px;background:var(--chip);display:flex;align-items:center;gap:6px;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--run)}
.run .dot{animation:p 1s ease-in-out infinite}@keyframes p{50%{opacity:.25}}
.ok .dot{background:var(--ok)}.err .dot{background:var(--err)}
.sum{margin-top:8px;color:var(--fg);font-size:12.5px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.sum:empty{display:none}
.err-text{color:var(--err)}
.imgs{display:flex;gap:6px;margin-top:8px;overflow-x:auto}
.imgs img{max-height:220px;max-width:100%;border-radius:8px;border:1px solid var(--line);background:#000}
.bar{height:2px;margin-top:9px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--acc),transparent);background-size:200% 100%;animation:s 1.2s linear infinite}
@keyframes s{from{background-position:200% 0}to{background-position:-200% 0}}
.done .bar{display:none}
</style></head>
<body>
<div class="card" id="card">
  <div class="row">
    <img class="icon" src="${icon}" alt="">
    <div><div class="t">Premiere Pro <span class="sub" id="tool"></span></div><div class="sub" id="what">Conectando…</div></div>
    <div class="chip run" id="chip"><span class="dot"></span><span id="state">Executando</span></div>
  </div>
  <div class="bar"></div>
  <div class="sum" id="sum"></div>
  <div class="imgs" id="imgs"></div>
</div>
<script>
(function(){
  var nextId=1, pending={}, started=Date.now(), toolName="", toolTitle="";
  var LABELS=${JSON.stringify(TOOL_LABELS)};
  function $(id){return document.getElementById(id)}
  function send(m){ try{ window.parent.postMessage(m,"*"); }catch(e){} }
  function request(method,params){ var id=nextId++; send({jsonrpc:"2.0",id:id,method:method,params:params||{}}); return new Promise(function(r){pending[id]=r;}); }
  function notify(method,params){ send({jsonrpc:"2.0",method:method,params:params||{}}); }
  function size(){ var c=$("card"); notify("ui/notifications/size-changed",{width:Math.ceil(c.scrollWidth),height:Math.ceil(c.getBoundingClientRect().height)+2}); }
  function theme(ctx){ if(ctx&&ctx.theme){document.documentElement.setAttribute("data-theme",ctx.theme);} if(ctx&&ctx.toolInfo&&ctx.toolInfo.tool){ setTool(ctx.toolInfo.tool.name, ctx.toolInfo.tool.title); } }
  function setTool(name,title){ if(!name) return; toolName=name; toolTitle=title||""; $("tool").textContent="· "+name; $("what").textContent=LABELS[name]||toolTitle||name.replace(/_/g," "); size(); }
  function setState(kind,text){ var c=$("chip"); c.className="chip "+kind; $("state").textContent=text; if(kind!=="run") $("card").className="card done"; size(); }
  function brief(v,depth){
    depth=depth||0;
    if(v===null||v===undefined) return "";
    if(typeof v!=="object") return String(v);
    if(Array.isArray(v)) return v.length+" item"+(v.length===1?"":"s");
    var out=[], keys=Object.keys(v);
    for(var i=0;i<keys.length&&out.length<6;i++){
      var k=keys[i], x=v[k];
      if(x===null||x===undefined||x==="") continue;
      if(Array.isArray(x)){ if(x.length||k!=="errors") out.push(k+": "+x.length); }
      else if(typeof x==="object"){ if(depth<1){ var b=brief(x,depth+1); if(b) out.push(k+" → "+b.replace(/\\n/g,", ")); } }
      else if(String(x).length<80) out.push(k+": "+x);
    }
    return out.join(depth?", ":"\\n");
  }
  function onInput(p){ var args=p&&p.arguments||{}; var hint=args.sequence||args.path||args.name||args.preset||""; if(hint&&typeof hint==="string") $("what").textContent=(LABELS[toolName]||$("what").textContent)+" — "+hint.split(/[\\\\/]/).pop(); size(); }
  function onResult(r){
    r=r||{};
    var secs=((Date.now()-started)/1000).toFixed(1)+"s";
    var meta=r._meta||{}, summary=meta["premiere-mcp-plus/summary"];
    var text=""; var imgs=$("imgs"); imgs.innerHTML="";
    (r.content||[]).forEach(function(c){
      if(c.type==="text"&&!text) text=c.text;
      if(c.type==="image"&&c.data){ var im=document.createElement("img"); im.src="data:"+(c.mimeType||"image/jpeg")+";base64,"+c.data; im.onload=size; imgs.appendChild(im); }
    });
    if(r.isError){
      setState("err","Erro · "+secs);
      var msg=text; try{ var j=JSON.parse(text); msg=(j.error||"")+(j.hint?"\\n"+j.hint:""); }catch(e){}
      $("sum").innerHTML=""; var s=document.createElement("span"); s.className="err-text"; s.textContent=msg.slice(0,600); $("sum").appendChild(s);
    } else {
      setState("ok","Concluído · "+secs);
      if(!summary){ try{ summary=brief(JSON.parse(text)); }catch(e){ summary=text.slice(0,300); } }
      $("sum").textContent=summary||"";
    }
    size();
  }
  window.addEventListener("message",function(e){
    var m=e.data; if(!m||m.jsonrpc!=="2.0") return;
    if(m.id!==undefined&&m.id!==null&&!m.method){ var cb=pending[m.id]; if(cb){ delete pending[m.id]; cb(m.result||{}); } return; }
    switch(m.method){
      case "ui/notifications/tool-input": onInput(m.params); break;
      case "ui/notifications/tool-input-partial": break;
      case "ui/notifications/tool-result": onResult(m.params); break;
      case "ui/notifications/tool-cancelled": setState("err","Cancelado"); break;
      case "ui/notifications/host-context-changed": theme(m.params); break;
    }
    if(m.method&&m.id!==undefined&&m.id!==null) send({jsonrpc:"2.0",id:m.id,result:{}});
  });
  request("ui/initialize",{appInfo:{name:"premiere-pro-plus-activity",version:"2.0.0"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"}).then(function(res){
    theme(res&&res.hostContext);
    $("what").textContent=toolName?(LABELS[toolName]||toolName):"Trabalhando no Premiere…";
    notify("ui/notifications/initialized",{});
    size();
  });
  if(window.ResizeObserver) new ResizeObserver(size).observe(document.body);
})();
</script>
</body></html>`;
}
/** Portuguese action labels shown in the widget. */
export const TOOL_LABELS = {
    premiere_status: "Verificando conexão com o Premiere",
    get_project: "Lendo o projeto",
    list_project_items: "Listando itens do projeto",
    get_item_info: "Lendo item do projeto",
    import_media: "Importando mídia",
    manage_bins: "Organizando bins",
    manage_project_items: "Editando itens do projeto",
    replace_media: "Substituindo mídia",
    project_file: "Abrindo / salvando projeto",
    list_sequences: "Listando sequências",
    open_sequence: "Abrindo sequência",
    create_sequence: "Criando sequência",
    manage_sequence: "Editando sequência",
    get_timeline: "Lendo a timeline",
    manage_tracks: "Editando trilhas",
    place_clips: "Colocando clipes na timeline",
    find_clips: "Procurando clipes",
    edit_clips: "Editando clipes",
    remove_clips: "Removendo clipes",
    razor: "Cortando (razor)",
    set_clip_speed: "Alterando velocidade",
    close_gaps: "Fechando buracos",
    select_clips: "Selecionando clipes",
    list_available_effects: "Listando efeitos",
    get_clip_effects: "Lendo efeitos do clipe",
    apply_effects: "Aplicando efeitos",
    remove_effects: "Removendo efeitos",
    set_properties: "Ajustando propriedades",
    set_transform: "Ajustando escala/posição",
    add_keyframes: "Criando keyframes",
    remove_keyframes: "Removendo keyframes",
    copy_effects: "Copiando efeitos",
    list_effect_presets: "Listando presets",
    apply_effect_preset: "Aplicando preset",
    add_transitions: "Adicionando transições",
    set_volume: "Ajustando volume",
    fade_audio: "Criando fades de áudio",
    markers: "Editando marcadores",
    playhead: "Movendo o playhead",
    export_frames: "Exportando frames",
    export_sequence: "Exportando vídeo",
    export_interchange: "Exportando XML / EDL / AAF",
    list_export_presets: "Listando presets de exportação",
    create_title_image: "Gerando título",
    mogrt: "Motion Graphics Template",
    import_captions: "Importando legendas",
    analyze_media: "Analisando mídia",
    run_extendscript: "Executando ExtendScript",
    batch: "Executando lote de operações",
    undo: "Desfazendo",
    sequence_tools: "Ferramentas de sequência",
};
