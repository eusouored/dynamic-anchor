import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import anchor_reference_occlusion as O


def row(i, source, occluded, head='face-propagated', offset=0.):
    return dict(time=i / 30., source=source, trackingPoint=dict(x=500. + offset, y=300.),
                headBounds=dict(left=400., top=150., right=600., bottom=450., source=head),
                headVisibility=dict(occluded=occluded, groups=2))


class ReferenceOcclusionTests(unittest.TestCase):
    def test_occluded_rows_after_the_last_measurement_do_not_crash(self):
        # fim do take: últimas linhas interpoladas/propagadas com a cabeça encoberta e o ponto
        # longe do centro do contorno (dispara a verificação), depois da última leitura real
        rows = [row(i, 'detected', False, 'segmented') for i in range(10)]
        rows += [row(i, 'interpolated', True, offset=80.) for i in range(10, 14)]
        out, report = O.repair(rows)
        self.assertEqual(len(out), len(rows))
        self.assertEqual(report['correctedRows'], 0)

    def test_occluded_measured_row_at_the_end_does_not_crash(self):
        rows = [row(i, 'detected', False, 'segmented') for i in range(10)]
        rows += [row(10, 'detected', True, offset=80.)]
        out, report = O.repair(rows)
        self.assertEqual(len(out), len(rows))


if __name__ == '__main__':
    unittest.main()
