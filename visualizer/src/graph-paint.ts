import type { MapLayout } from './graph-layout';

const colors:Record<string,string>={Note:'#8f4d35',Image:'#47786d',Vault:'#6a5a9b',WebPage:'#317b91',WebSession:'#76529d',Domain:'#aa7431',Topic:'#a54d69',BookmarkFolder:'#6d8339'};
export const colorFor=(type:string)=>colors[type] || '#68717a';
export interface MapView {width:number;height:number;zoom:number;x:number;y:number}
export function mapTransform(layout:MapLayout,view:MapView) {
  const fit=Math.min(view.width/layout.width,view.height/layout.height);
  return {scale:fit*view.zoom,x:(view.width-layout.width*fit)/2+view.x,y:(view.height-layout.height*fit)/2+view.y};
}

/** Batch paths into a few canvas strokes instead of thousands of DOM elements. */
export function paintGraph(canvas:HTMLCanvasElement,layout:MapLayout,view:MapView,selected:number|undefined) {
  const ctx=canvas.getContext('2d');if(!ctx)return;
  const dpr=canvas.width/Math.max(1,view.width),t=mapTransform(layout,view);
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,view.width,view.height);
  ctx.translate(t.x,t.y);ctx.scale(t.scale,t.scale);
  const bounds={left:-t.x/t.scale,right:(view.width-t.x)/t.scale,top:-t.y/t.scale,bottom:(view.height-t.y)/t.scale};
  for(const group of ['accepted','pending','selected']) {
    ctx.beginPath();ctx.setLineDash(group==='pending' ? [4/t.scale,3/t.scale] : []);
    ctx.strokeStyle=group==='selected' ? '#716552' : '#bab2a5';ctx.globalAlpha=group==='selected' ? .85 : .4;ctx.lineWidth=(group==='selected'?1.5:.6)/t.scale;
    for(const edge of layout.edges) {
      const active=selected===edge.source || selected===edge.target;
      if((active?'selected':edge.status==='accepted'?'accepted':'pending')!==group)continue;
      const a=layout.points.get(edge.source)!,b=layout.points.get(edge.target)!;
      if(Math.max(a.x,b.x)<bounds.left || Math.min(a.x,b.x)>bounds.right || Math.max(a.y,b.y)<bounds.top || Math.min(a.y,b.y)>bounds.bottom)continue;
      ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);ctx.globalAlpha=1;
  const groups=new Map<string,Array<{x:number;y:number;radius:number}>>();
  for(const point of layout.points.values()) {
    if(point.x+point.radius<bounds.left || point.x-point.radius>bounds.right || point.y+point.radius<bounds.top || point.y-point.radius>bounds.bottom)continue;
    const color=colorFor(point.node.type);let group=groups.get(color);if(!group)groups.set(color,group=[]);group.push(point);
  }
  for(const [color,points] of groups) {ctx.fillStyle=color;ctx.beginPath();for(const p of points){ctx.moveTo(p.x+p.radius,p.y);ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);}ctx.fill();}
  let labels=0;
  for(const p of layout.points.values()) {
    const active=p.node.id===selected;
    if(active){ctx.strokeStyle=colorFor(p.node.type);ctx.lineWidth=1.5/t.scale;ctx.beginPath();ctx.arc(p.x,p.y,p.radius+4/t.scale,0,Math.PI*2);ctx.stroke();}
    if(!active && (t.scale<.6 || p.node.degree<8 || labels>=150))continue;
    if(p.x<bounds.left || p.x>bounds.right || p.y<bounds.top || p.y>bounds.bottom)continue;
    labels++;ctx.fillStyle='#575147';ctx.font=`${11/t.scale}px system-ui`;ctx.fillText(p.node.name.length>28?p.node.name.slice(0,28)+'…':p.node.name,p.x+p.radius+6/t.scale,p.y+4/t.scale);
  }
}
