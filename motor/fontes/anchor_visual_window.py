"""Bounded visual gap candidate. Experimental; never imported by production."""
import copy, math

class WindowCollector:
    """One trusted anchor and one weak window; no cross-overflow bridging."""
    def __init__(self, on_window, max_seconds=8.0, max_bytes=96*1024*1024, cancelled=None, spill=None):
        self.on_window=on_window; self.max_seconds=max_seconds; self.max_bytes=max_bytes
        self.cancelled=cancelled or (lambda:False); self.anchor=None; self.pending=[]
        self.bytes=0; self.last_time=None; self.discarded=0; self.processed=0
        self.spill=spill
    def _check(self):
        if self.cancelled():raise RuntimeError('Visual continuity cancelled')
    def _clear(self):self.anchor=None;self.pending=[];self.bytes=0
    def add(self, time, image, bounds, visibility, hair_count, others):
        self._check()
        if not math.isfinite(time) or (self.last_time is not None and time<=self.last_time):raise ValueError('Non-increasing analysis time')
        self.last_time=time
        trusted=bounds is not None and (visibility or {}).get('groups',0)>=2
        record={'time':time,'image':image,'bounds':copy.deepcopy(bounds),'hair_count':hair_count,'others':copy.deepcopy(others)}
        size=image.nbytes
        if self.anchor is not None and self.bytes+size>self.max_bytes and self.spill is not None:
            for item in [self.anchor,*self.pending]:
                if item['image'].nbytes:item['image']=self.spill(item['image'])
            self.bytes=sum(item['image'].nbytes for item in [self.anchor,*self.pending])
        if trusted:
            if self.anchor is not None and self.pending:
                if time-self.anchor['time']<=self.max_seconds and self.bytes+size<=self.max_bytes and self.anchor['hair_count']>=128 and hair_count>=128:
                    self._check();self.on_window([self.anchor,*self.pending,record]);self.processed+=1
                else:self.discarded+=1
            self._clear()
            if size<=self.max_bytes:self.anchor=record;self.bytes=size
            return
        if self.anchor is None:return
        if time-self.anchor['time']>self.max_seconds or self.bytes+size>self.max_bytes:
            self.discarded+=1;self._clear();return
        self.pending.append(record);self.bytes+=size
    def finish(self):self._check();self._clear()
    def abort(self):self._clear()
