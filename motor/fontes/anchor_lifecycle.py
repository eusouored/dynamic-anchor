"""Lifetime of the local service, independent of UXP callbacks or HTTP activity.

Only observes process handles. Never starts, suspends or terminates Premiere.
Holding the original handle prevents a reused PID or a newly opened instance
from silently keeping an old service alive.
"""
import os

METHOD = 'premiere-process-lifetime-v1'


class ProcessOwner:
    def __init__(self, kernel, handle, pid):
        self.kernel, self.handle, self.pid = kernel, handle, pid

    def alive(self):
        result = self.kernel.WaitForSingleObject(self.handle, 0)
        if result == 0x102:
            return True
        if result == 0:
            return False
        raise OSError('Could not observe the owning process')

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class WindowsPremiereProcesses:
    def __init__(self):
        if os.name != 'nt':
            raise OSError('The Premiere lifetime monitor requires Windows')
        import ctypes as c
        self.c = c
        k = self.kernel = c.WinDLL('kernel32', use_last_error=True)
        dword, boolean, handle = c.c_uint32, c.c_int32, c.c_void_p

        class Entry(c.Structure):
            _fields_ = [('size', dword), ('usage', dword), ('pid', dword),
                        ('heap', c.c_size_t), ('module', dword), ('threads', dword),
                        ('parent', dword), ('priority', c.c_int32), ('flags', dword),
                        ('name', c.c_wchar * 260)]

        self.Entry = Entry
        k.CreateToolhelp32Snapshot.argtypes = [dword, dword]
        k.CreateToolhelp32Snapshot.restype = handle
        for name in ('Process32FirstW', 'Process32NextW'):
            fn = getattr(k, name)
            fn.argtypes, fn.restype = [handle, c.POINTER(Entry)], boolean
        k.OpenProcess.argtypes, k.OpenProcess.restype = [dword, boolean, dword], handle
        k.WaitForSingleObject.argtypes, k.WaitForSingleObject.restype = [handle, dword], dword
        k.CloseHandle.argtypes, k.CloseHandle.restype = [handle], boolean
        k.ProcessIdToSessionId.argtypes, k.ProcessIdToSessionId.restype = [dword, c.POINTER(dword)], boolean
        k.QueryFullProcessImageNameW.argtypes = [handle, dword, c.c_wchar_p, c.POINTER(dword)]
        k.QueryFullProcessImageNameW.restype = boolean
        self.session = self._session(os.getpid())

    def _session(self, pid):
        value = self.c.c_uint32()
        if not self.kernel.ProcessIdToSessionId(pid, self.c.byref(value)):
            raise OSError('Could not verify process session')
        return value.value

    def open_owners(self):
        c, k = self.c, self.kernel
        snapshot = k.CreateToolhelp32Snapshot(2, 0)
        if snapshot in (None, c.c_void_p(-1).value):
            raise OSError('Could not enumerate Premiere processes')
        owners = []
        try:
            entry = self.Entry()
            entry.size = c.sizeof(entry)
            more = k.Process32FirstW(snapshot, c.byref(entry))
            if not more and c.get_last_error() != 18:
                raise OSError('Could not read process snapshot')
            while more:
                if entry.name.casefold() == 'adobe premiere pro.exe':
                    try:
                        same_session = self._session(entry.pid) == self.session
                    except OSError:
                        same_session = False
                    if same_session:
                        # SYNCHRONIZE + QUERY_LIMITED_INFORMATION; no write/debug rights.
                        handle = k.OpenProcess(0x100000 | 0x1000, False, entry.pid)
                        if handle:
                            size = c.c_uint32(32768)
                            path = c.create_unicode_buffer(size.value)
                            if k.QueryFullProcessImageNameW(handle, 0, path, c.byref(size)) and os.path.basename(path.value).casefold() == 'adobe premiere pro.exe':
                                owners.append(ProcessOwner(k, handle, entry.pid))
                            else:
                                k.CloseHandle(handle)
                more = k.Process32NextW(snapshot, c.byref(entry))
            if c.get_last_error() != 18:
                raise OSError('Process enumeration was incomplete')
            return owners
        except Exception:
            for owner in owners:
                owner.close()
            raise
        finally:
            k.CloseHandle(snapshot)


class PremiereLifetime:
    def __init__(self, source=None):
        self.source = source if source is not None else WindowsPremiereProcesses()
        self.owners, self.reason, self.closed = [], None, False

    def should_stop(self):
        if self.closed:
            return True
        if self.reason:
            return True
        try:
            if not self.owners:
                self.owners = list(self.source.open_owners())
                if not self.owners:
                    self.reason = 'no-premiere'
                    return True
            if not any(owner.alive() for owner in self.owners):
                self.reason = 'premiere-closed'
        except Exception:
            self.reason = 'monitor-unavailable'
        return self.reason is not None

    def close(self):
        if self.closed:
            return
        self.closed = True
        for owner in self.owners:
            owner.close()
        self.owners = []
