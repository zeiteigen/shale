import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { GraphData, GraphNode } from './types';
import { graphAdjacency, graphLayout } from './graph-layout';
import { mapTransform, paintGraph, type MapView } from './graph-paint';
export {colorFor} from './graph-paint';

export const GraphMap=memo(function GraphMap({data,selected,visibleTypes,focusSelection,connectionDepth,onSelect}: {
  data:GraphData;selected:GraphNode|null;visibleTypes:Set<string>;focusSelection:boolean;connectionDepth:number;onSelect:(node:GraphNode)=>void;
}) {
  const canvas=useRef<HTMLCanvasElement>(null),frame=useRef<number|undefined>(undefined);
  const view=useRef<MapView>({width:1,height:1,zoom:1,x:0,y:0});
  const drag=useRef<{x:number;y:number;offsetX:number;offsetY:number;moved:boolean}|null>(null);
  const [zoom,setZoom]=useState(1),[hover,setHover]=useState('');
  const adjacency=useMemo(()=>graphAdjacency(data),[data]);
  const layout=useMemo(()=>graphLayout(data,adjacency,visibleTypes,selected?.id,focusSelection,connectionDepth),[data,adjacency,visibleTypes,selected?.id,focusSelection,connectionDepth]);
  const draw=useCallback(()=> {
    if(frame.current!==undefined)return;
    frame.current=requestAnimationFrame(()=>{frame.current=undefined;if(canvas.current)paintGraph(canvas.current,layout,view.current,selected?.id);});
  },[layout,selected?.id]);
  useEffect(()=> {
    const element=canvas.current;if(!element)return;
    const resize=()=>{const rect=element.getBoundingClientRect(),dpr=Math.min(2,devicePixelRatio || 1);view.current.width=rect.width;view.current.height=rect.height;element.width=Math.round(rect.width*dpr);element.height=Math.round(rect.height*dpr);draw();};
    const observer=new ResizeObserver(resize);observer.observe(element);resize();
    return()=>{observer.disconnect();if(frame.current!==undefined)cancelAnimationFrame(frame.current);frame.current=undefined;};
  },[draw]);
  const changeZoom=useCallback((next:number,x=view.current.width/2,y=view.current.height/2)=>{
    const v=view.current,t=mapTransform(layout,v),ratio=next/v.zoom;
    v.x+= (x-t.x)*(1-ratio);v.y+=(y-t.y)*(1-ratio);v.zoom=next;setZoom(next);draw();
  },[draw,layout]);
  useEffect(()=>{const element=canvas.current;if(!element)return;const wheel=(event:WheelEvent)=>{event.preventDefault();const rect=element.getBoundingClientRect();changeZoom(Math.min(8,Math.max(.35,view.current.zoom*(event.deltaY<0?1.14:.88))),event.clientX-rect.left,event.clientY-rect.top);};element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);},[changeZoom]);
  function point(event:{clientX:number;clientY:number}) {const rect=canvas.current!.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};}
  function hit(event:{clientX:number;clientY:number}) {
    const p=point(event),t=mapTransform(layout,view.current);let nearest:GraphNode|undefined,distance=Infinity;
    for(const entry of layout.points.values()){const d=Math.hypot(p.x-(entry.x*t.scale+t.x),p.y-(entry.y*t.scale+t.y));if(d<Math.max(6,entry.radius*t.scale+3)&&d<distance){nearest=entry.node;distance=d;}}
    return nearest;
  }
  return <div className="map-scroll">
    <div className="map-controls" aria-label="Graph zoom controls">
      <button onClick={()=>changeZoom(Math.min(8,view.current.zoom*1.2))} aria-label="Zoom in"><Plus size={16}/></button>
      <button onClick={()=>changeZoom(Math.max(.35,view.current.zoom/1.2))} aria-label="Zoom out"><Minus size={16}/></button>
      <button onClick={()=>{Object.assign(view.current,{zoom:1,x:0,y:0});setZoom(1);draw();}} aria-label="Reset graph view"><RotateCcw size={14}/></button><span>{Math.round(zoom*100)}%</span>
    </div>
    <canvas ref={canvas} className="graph-map" role="img" tabIndex={0} aria-label="Knowledge graph map. Scroll to zoom, drag to pan, click an entry to inspect it. Use arrow keys to select entries."
      onPointerDown={event=>{const p=point(event);drag.current={...p,offsetX:view.current.x,offsetY:view.current.y,moved:false};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{const p=point(event),start=drag.current;if(start){if(Math.hypot(p.x-start.x,p.y-start.y)>4)start.moved=true;if(start.moved){view.current.x=start.offsetX+p.x-start.x;view.current.y=start.offsetY+p.y-start.y;draw();}}else{const node=hit(event);setHover(node?`${node.name} · ${node.type}`:'');}}}
      onPointerUp={event=>{if(drag.current&&!drag.current.moved){const node=hit(event);if(node)onSelect(node);}drag.current=null;}}
      onPointerCancel={()=>{drag.current=null;}} onPointerLeave={()=>setHover('')}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||!layout.nodes.length)return;event.preventDefault();const current=layout.nodes.findIndex(n=>n.id===selected?.id),step=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1;onSelect(layout.nodes[(current+step+layout.nodes.length)%layout.nodes.length]);}} />
    {hover&&<div className="map-hover" role="status">{hover}</div>}
  </div>;
});
