"""Bounded, private temporary storage for completed grayscale windows."""
import os,tempfile,zlib
from pathlib import Path

class SpoolCapacityError(RuntimeError):
 pass

class Spool:
 def __init__(self,max_bytes=2*1024**3,cancelled=None):
  self.temp=None;self.path=None
  self.max_bytes=max_bytes;self.used=0;self.files=[];self.cancelled=cancelled or (lambda:False)
 def put(self,items):
  if self.cancelled():raise RuntimeError('Visual continuity cancelled')
  if self.temp is None:
   self.temp=tempfile.TemporaryDirectory(prefix='anchor-visual-');self.path=Path(self.temp.name)
  index=len(self.files);path=self.path/(str(index)+'.bin');size=0
  try:
   with path.open('xb') as f:
    for data in items:
     if self.cancelled():raise RuntimeError('Visual continuity cancelled')
     # Lossless storage framing, without CPU-heavy compression of video noise.
     data=zlib.compress(data,0);size+=4+len(data)
     if self.used+size>self.max_bytes:raise SpoolCapacityError('Visual spool disk limit exceeded')
     f.write(len(data).to_bytes(4,'big'));f.write(data)
   self.files.append((path,size));self.used+=size;return index
  except BaseException:
   path.unlink(missing_ok=True);raise
 def get(self,index):
  path,_=self.files[index]
  with path.open('rb') as f:
   while True:
    if self.cancelled():raise RuntimeError('Visual continuity cancelled')
    header=f.read(4)
    if not header:break
    if len(header)!=4:raise RuntimeError('Corrupt visual spool')
    length=int.from_bytes(header,'big');blob=f.read(length)
    if len(blob)!=length:raise RuntimeError('Corrupt visual spool')
    yield zlib.decompress(blob)
 def close(self):
  if self.temp is not None:self.temp.cleanup()
  self.files=[];self.used=0
