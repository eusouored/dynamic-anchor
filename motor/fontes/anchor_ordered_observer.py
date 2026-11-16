"""Bounded ordered observer: one head session, one worker, every selected read."""
import copy,queue,threading

_END=object()


class OrderedObserver:
    def __init__(self, callback, cancelled=None, cancel_error=None):
        self.callback=callback
        self.cancelled=cancelled
        self.cancel_error=cancel_error or (lambda: RuntimeError('Cancelled'))
        self.queue=queue.Queue(maxsize=1)
        self.stop=threading.Event()
        self.failure=None
        self.submitted=0
        self.completed=0
        self.high_water=0
        self.thread=threading.Thread(target=self._run,name='head-ordered',daemon=True)
        self.thread.start()

    def _check(self):
        if self.failure is not None:raise self.failure
        if self.cancelled and self.cancelled():raise self.cancel_error()
        if self.stop.is_set():raise RuntimeError('Head observer is closed')

    def _put(self,item):
        while True:
            self._check()
            try:
                self.queue.put(item,timeout=.05)
                self.high_water=max(self.high_water,self.queue.qsize())
                return
            except queue.Full:pass

    def __call__(self, observation, image, visual):
        # The decoder yields a distinct original array for each retrieve. Do not
        # duplicate full-resolution images; retain at most one queued reference.
        self._put((copy.deepcopy(observation),image,copy.deepcopy(visual)))
        self.submitted+=1

    def submit(self, *item):
        """Queue arguments already owned by the caller (no copy)."""
        self._put(item)
        self.submitted+=1

    def _run(self):
        try:
            while not self.stop.is_set():
                try:item=self.queue.get(timeout=.05)
                except queue.Empty:continue
                if item is _END:return
                self._check()
                self.callback(*item)
                self.completed+=1
        except BaseException as error:
            self.failure=error
            self.stop.set()

    def finish(self):
        self._put(_END)
        while self.thread.is_alive():
            self._check()
            self.thread.join(.05)
        self._check()
        if self.submitted!=self.completed:raise RuntimeError('Incomplete head observer')
        self.stop.set()

    def abort(self):
        self.stop.set()
        # Wait for the single in-flight inference before releasing its session.
        # No pending read is treated as a completed measurement.
        self.thread.join()
        while True:
            try:self.queue.get_nowait()
            except queue.Empty:break


class PreparedOrderedObserver:
    """Same contract as OrderedObserver, with a stateless preparation fanned out.

    Read i goes to preparation worker i % workers (prepare holds no ordering
    state); one finishing worker takes the prepared reads back in submission
    order, so every stateful step still runs exactly once and in order.
    """
    def __init__(self, prepare, finish, workers=2, cancelled=None, cancel_error=None):
        self.prepare=prepare
        self.finish_callback=finish
        self.cancelled=cancelled
        self.cancel_error=cancel_error or (lambda: RuntimeError('Cancelled'))
        self.inputs=[queue.Queue(maxsize=1) for _ in range(workers)]
        self.outputs=[queue.Queue(maxsize=1) for _ in range(workers)]
        self.stop=threading.Event()
        self.failure=None
        self.submitted=0
        self.completed=0
        self.high_water=0
        self.threads=[threading.Thread(target=self._prepare_loop,args=(j,),name='head-prepare-%d'%j,daemon=True) for j in range(workers)]
        self.threads.append(threading.Thread(target=self._finish_loop,name='head-ordered',daemon=True))
        for thread in self.threads:thread.start()

    def _check(self):
        if self.failure is not None:raise self.failure
        if self.cancelled and self.cancelled():raise self.cancel_error()
        if self.stop.is_set():raise RuntimeError('Head observer is closed')

    def _put(self,target,item):
        while True:
            self._check()
            try:
                target.put(item,timeout=.05)
                return
            except queue.Full:pass

    def _get(self,source):
        while True:
            self._check()
            try:return source.get(timeout=.05)
            except queue.Empty:pass

    def __call__(self, observation, image, visual):
        target=self.inputs[self.submitted%len(self.inputs)]
        self._put(target,(copy.deepcopy(observation),image,copy.deepcopy(visual)))
        self.high_water=max(self.high_water,sum(q.qsize() for q in self.inputs))
        self.submitted+=1

    def _fail(self,error):
        if self.failure is None:self.failure=error
        self.stop.set()

    def _prepare_loop(self,j):
        try:
            while True:
                item=self._get(self.inputs[j])
                if item is _END:
                    self._put(self.outputs[j],_END);return
                self._put(self.outputs[j],(item,self.prepare(*item)))
        except BaseException as error:
            if not self.stop.is_set():self._fail(error)

    def _finish_loop(self):
        try:
            i=0
            while True:
                entry=self._get(self.outputs[i%len(self.outputs)])
                if entry is _END:return
                item,prepared=entry
                self.finish_callback(*item,*prepared)
                self.completed+=1
                i+=1
        except BaseException as error:
            if not self.stop.is_set():self._fail(error)

    def finish(self):
        # The first end marker in order closes the sequence; the others only
        # let each preparation worker exit.
        for k in range(len(self.inputs)):
            self._put(self.inputs[(self.submitted+k)%len(self.inputs)],_END)
        while self.threads[-1].is_alive():
            self._check()
            self.threads[-1].join(.05)
        self._check()
        if self.submitted!=self.completed:raise RuntimeError('Incomplete head observer')
        self.stop.set()

    def abort(self):
        self.stop.set()
        for thread in self.threads:thread.join()
        for q in self.inputs+self.outputs:
            while True:
                try:q.get_nowait()
                except queue.Empty:break
