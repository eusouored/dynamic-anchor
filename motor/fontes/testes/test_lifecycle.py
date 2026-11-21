import importlib.util
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from anchor_lifecycle import PremiereLifetime, ProcessOwner, METHOD


class Owner:
    def __init__(self, pid=1):
        self.pid, self.live, self.closed = pid, True, 0

    def alive(self):
        return self.live

    def close(self):
        self.closed += 1


class Source:
    def __init__(self, *owners):
        self.owners, self.calls = list(owners), 0

    def open_owners(self):
        self.calls += 1
        return self.owners[:]


class LifetimeTests(unittest.TestCase):
    def test_does_not_close_a_running_premiere(self):
        owner = Owner()
        source = Source(owner)
        life = PremiereLifetime(source)
        for _ in range(20):
            self.assertFalse(life.should_stop())
        self.assertEqual(source.calls, 1)
        self.assertEqual(owner.closed, 0)
        life.close()
        self.assertEqual(owner.closed, 1)

    def test_normal_close_and_crash_both_end_the_service(self):
        for kind in ['normal-close', 'crash', 'force-close']:
            with self.subTest(kind=kind):
                owner = Owner()
                life = PremiereLifetime(Source(owner))
                self.assertFalse(life.should_stop())
                owner.live = False
                self.assertTrue(life.should_stop())
                self.assertEqual(life.reason, 'premiere-closed')
                life.close()

    def test_reused_pid_and_new_instances_cannot_adopt_old_service(self):
        owner, replacement = Owner(7), Owner(7)
        source = Source(owner)
        life = PremiereLifetime(source)
        self.assertFalse(life.should_stop())
        owner.live = False
        source.owners = [replacement]
        self.assertTrue(life.should_stop())
        self.assertEqual(source.calls, 1)

    def test_multiple_initial_owners_must_all_close(self):
        a, b = Owner(1), Owner(2)
        life = PremiereLifetime(Source(a, b))
        self.assertFalse(life.should_stop())
        a.live = False
        self.assertFalse(life.should_stop())
        b.live = False
        self.assertTrue(life.should_stop())
        life.close()
        self.assertEqual([a.closed, b.closed], [1, 1])

    def test_manual_start_without_premiere_stops_immediately(self):
        life = PremiereLifetime(Source())
        self.assertTrue(life.should_stop())
        self.assertEqual(life.reason, 'no-premiere')

    def test_a_later_premiere_cannot_adopt_a_start_without_an_owner(self):
        source = Source()
        life = PremiereLifetime(source)
        self.assertTrue(life.should_stop())
        source.owners = [Owner()]
        self.assertTrue(life.should_stop())
        self.assertEqual(source.calls, 1)

    def test_monitor_failure_does_not_leave_an_uncontrolled_service(self):
        source = Source()
        source.open_owners = lambda: (_ for _ in ()).throw(OSError('unavailable'))
        life = PremiereLifetime(source)
        self.assertTrue(life.should_stop())
        self.assertEqual(life.reason, 'monitor-unavailable')

    def test_handle_failure_is_not_treated_as_a_live_premiere(self):
        owner = Owner()
        owner.alive = lambda: (_ for _ in ()).throw(OSError('invalid handle'))
        life = PremiereLifetime(Source(owner))
        self.assertTrue(life.should_stop())
        self.assertEqual(life.reason, 'monitor-unavailable')

    def test_close_is_idempotent_and_releases_all_handles(self):
        a, b = Owner(), Owner()
        life = PremiereLifetime(Source(a, b))
        self.assertFalse(life.should_stop())
        life.close()
        life.close()
        self.assertTrue(life.should_stop())
        self.assertEqual([a.closed, b.closed], [1, 1])

    def test_kernel_wait_uses_zero_timeout_and_does_not_terminate_owner(self):
        calls = []
        kernel = types.SimpleNamespace(WaitForSingleObject=lambda h, ms: (calls.append((h, ms)) or 0x102),
                                       CloseHandle=lambda h: calls.append(('close', h)))
        owner = ProcessOwner(kernel, 99, 7)
        self.assertTrue(owner.alive())
        self.assertEqual(calls, [(99, 0)])
        owner.close()
        owner.close()
        self.assertEqual(calls, [(99, 0), ('close', 99)])

    def test_server_closes_and_cancels_work_when_premiere_disappears(self):
        # Real server loop and cancellation; model execution, HTTP and Windows are simulated.
        stub = types.SimpleNamespace()
        spec = importlib.util.spec_from_file_location('lifecycle_service_test', Path(__file__).resolve().parents[1] / 'anchor_servico.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'anchor_rosto': stub}):
            spec.loader.exec_module(module)
        ready, stopped = threading.Event(), threading.Event()

        class Server:
            def __init__(self, *args):
                self.closed = False

            def serve_forever(self):
                ready.set()
                stopped.wait(3)

            def shutdown(self):
                stopped.set()

            def server_close(self):
                self.closed = True

        owner = Owner()
        life = PremiereLifetime(Source(owner))
        server = Server()
        logs, result = [], []
        with tempfile.TemporaryDirectory() as folder:
            service = module.Servico(executar=lambda: None, pasta=folder, rostos_iniciais=lambda: None)
            active = types.SimpleNamespace(estado='running', cancelar=threading.Event())
            service.ativa = active
            with patch.object(module, 'pasta_dados', return_value=folder), patch.object(module, 'pedir_desempenho', return_value='test'), patch.object(module, 'registrar', side_effect=logs.append), patch.object(module, 'Servidor', return_value=server):
                thread = threading.Thread(target=lambda: result.append(module.servir(porta=0, servico=service, lifetime=life)), daemon=True)
                thread.start()
                self.assertTrue(ready.wait(2))
                # No panel callback or HTTP request is needed to stop.
                owner.live = False
                thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result, [0])
            self.assertTrue(active.cancelar.is_set())
            self.assertTrue(service.parar.is_set())
            self.assertTrue(server.closed)
            self.assertEqual(owner.closed, 1)
            self.assertTrue(any('premiere-closed' in line for line in logs))

    def test_server_does_not_listen_without_a_premiere_owner(self):
        spec = importlib.util.spec_from_file_location('lifecycle_no_owner_test', Path(__file__).resolve().parents[1] / 'anchor_servico.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'anchor_rosto': types.SimpleNamespace()}):
            spec.loader.exec_module(module)
        life = PremiereLifetime(Source())
        service = types.SimpleNamespace()
        with tempfile.TemporaryDirectory() as folder, patch.object(module, 'pasta_dados', return_value=folder), patch.object(module, 'pedir_desempenho', return_value='test'), patch.object(module, 'registrar'), patch.object(module, 'Servidor') as server:
            self.assertEqual(module.servir(servico=service, lifetime=life), 5)
            server.assert_not_called()
        self.assertTrue(life.closed)


if __name__ == '__main__':
    unittest.main()
