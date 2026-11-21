import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import anchor_deshake as D


def run(n, fps=30., point=lambda i: (100. + 4 * i, 300. + 2 * i), source=lambda i: 'detected', head=lambda i: 'segmented'):
    return [dict(time=i / fps, x=point(i)[0], y=point(i)[1], width=200., height=240., source=source(i),
                 trackingPoint=dict(x=point(i)[0], y=point(i)[1]), headBounds=dict(source=head(i))) for i in range(n)]


class DeshakeTests(unittest.TestCase):
    def test_unmarked_rows_are_untouched(self):
        rows = run(60, point=lambda i: (100. + (-1) ** i * 3, 300.))
        before = [dict(r['trackingPoint']) for r in rows]
        report = D.stabilize(rows, 30.)
        self.assertEqual(report['rows'], 0)
        self.assertEqual([r['trackingPoint'] for r in rows], before)

    def test_smooth_motion_through_a_transition_is_not_delayed(self):
        # aceleração constante: o ajuste centrado quadrático não pode deslocar nada
        rows = run(60, point=lambda i: (100. + 4 * i + .05 * i * i, 300. + 2 * i),
                   source=lambda i: 'tracked' if 25 <= i < 30 else 'detected')
        before = [(r['trackingPoint']['x'], r['trackingPoint']['y']) for r in rows]
        D.stabilize(rows, 30.)
        for r, (x, y) in zip(rows, before):
            self.assertAlmostEqual(r['trackingPoint']['x'], x, delta=1e-6)
            self.assertAlmostEqual(r['trackingPoint']['y'], y, delta=1e-6)

    def test_jump_at_detector_return_is_reduced(self):
        def point(i):
            return (100. + 4 * i + (6. if i == 30 else 0.), 300.)
        rows = run(60, point=point, source=lambda i: 'tracked' if 25 <= i < 30 else 'detected')
        D.stabilize(rows, 30.)
        self.assertLess(abs(rows[30]['trackingPoint']['x'] - (100. + 120.)), 2.)

    def test_propagated_head_chatter_is_reduced_but_bounded(self):
        rows = run(60, point=lambda i: (500. + (-1) ** i * 4, 300.), head=lambda i: 'face-propagated' if 20 <= i < 40 else 'segmented')
        report = D.stabilize(rows, 30.)
        self.assertGreater(report['rows'], 0)
        for r in rows[22:38]:
            self.assertLess(abs(r['trackingPoint']['x'] - 500.), 2.)
        self.assertEqual(rows[0]['trackingPoint']['x'], 504.)
        self.assertLessEqual(report['maxCorrectionPixels'], .15 * 240 + 1e-9)


if __name__ == '__main__':
    unittest.main()
