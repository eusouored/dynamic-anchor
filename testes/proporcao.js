'use strict';
// Teste numérico da proporção diferente: o resultado convertido para Movimento, aplicado pelo
// modelo do Premiere (saída = Posição + escala·(ponto_mídia − Âncora)), põe o rosto no alvo e cobre
// o quadro sem bordas. Casos: mesma proporção (referência de sempre), vertical, quadrada, 4:3, 21:9.
const path=require('path'),root=process.env.ANCHOR_TEST_ROOT||path.resolve(__dirname,'../plugin');
const C=require(path.join(root,'core.js')),M=require(path.join(root,'motion-geometry.js')),G=require(path.join(root,'framing-geometry.js'));
const casos=[['mesma proporção',3840,2160,1920,1080],['vertical 9:16',3840,2160,1080,1920],['quadrada 1:1',3840,2160,1080,1080],['4:3',1920,1080,1440,1080],['21:9 numa 16:9',2560,1080,1920,1080],['vertical numa vertical maior',1080,1920,2160,3840],['16:9 vertical em 4:5',3840,2160,1080,1350]];
let falhas=0;
for(const [nome,vw,vh,W,H] of casos){
 const media={width:vw,height:vh,pixelAspect:1},src=M.validateSourceFormat(media,W,H),SW=src.sourceWidth,SH=src.sourceHeight,r=src.ratio;
 // rosto andando no quadro do vídeo (coordenadas do rastreio), 60 quadros
 const rows=Array.from({length:60},(_,i)=>({x:SW*(.35+.25*i/59),y:SH*(.4+.1*Math.sin(i/9)),angle:0}));
 const anchorVirtual={x:SW/2,y:SH/2},K={scale:1,translations:rows.map(()=>({x:0,y:0}))};
 const opt={useX:true,useY:true,target:{x:W/2,y:H/2},targetOffset:{x:0,y:0},anchor:anchorVirtual,scaleMode:'auto',minimumCover:true,maxScale:10,frame:{w:W,h:H},source:{w:SW,h:SH}};
 const keys=G.checkedKeys(rows,0,opt);
 let erroAlvo=0,borda=0;
 keys.forEach((k,i)=>{
  const n=M.nativeValues(C,keys,i,{W,H,ratio:r,K,anchorVirtual,rotationBase:0});
  const s=n.scale/100,P={x:n.position.x*W,y:n.position.y*H},A={x:anchorVirtual.x*r,y:anchorVirtual.y*r};
  const out=p=>({x:P.x+s*(p.x-A.x),y:P.y+s*(p.y-A.y)});
  const f=out({x:rows[i].x*r,y:rows[i].y*r});erroAlvo=Math.max(erroAlvo,Math.hypot(f.x-W/2,f.y-H/2));
  const tl=out({x:0,y:0}),br=out({x:vw,y:vh});
  if(tl.x>1e-6||tl.y>1e-6||br.x<W-1e-6||br.y<H-1e-6)borda++;
 });
 const minimo=keys.meta.scale*100/r; // escala do Movimento em %
 const ok=erroAlvo<1e-6&&borda===0;if(!ok)falhas++;
 console.log((ok?'ok   ':'FALHA')+' '+nome.padEnd(30)+' vídeo '+vw+'x'+vh+' em '+W+'x'+H+' · quadro do vídeo '+SW.toFixed(1)+'x'+SH.toFixed(1)+' · erro no alvo '+erroAlvo.toExponential(1)+' px · quadros com borda '+borda+' · escala Movimento '+minimo.toFixed(1)+'%');
}
process.exit(falhas?1:0);
