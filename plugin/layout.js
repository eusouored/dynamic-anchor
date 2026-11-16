'use strict';
// Whole CSS pixels avoid resampling small controls at half-pixel origins in UXP.
function panelGeometry(viewport) {
  const width=Math.min(viewport>=720?960:480,Math.max(0,Math.floor(viewport)));
  return {width,left:Math.max(0,Math.floor((viewport-width)/2))};
}
function previewGeometry(W,H,available) {
  const ratio=W>0&&H>0?W/H:16/9;
  const width=Math.max(24,Math.floor(Math.min(120*ratio,available)));
  return {width,height:Math.max(24,Math.round(width/ratio))};
}
function markerPosition(offset,extent) {
  // Only the visual marker is inset; the actual requested framing stays unchanged.
  return Math.round(Math.max(12,Math.min(extent-12,extent*(50+Number(offset||0))/100)));
}
module.exports={panelGeometry,previewGeometry,markerPosition};
