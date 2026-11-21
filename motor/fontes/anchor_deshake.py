"""Remove a tremida localizada do ponto de enquadramento, sem atrasar o movimento.

Dois lugares concentram a tremida medida na bancada (cena com dois rostos encostados):
- a passagem entre a leitura do detector e a previsão do fluxo óptico (pulo médio de 6 px na volta);
- os quadros em que o contorno da cabeça não foi lido e foi copiado do rosto ('face-propagated'),
  quando a oscilação da caixa do rosto passa para o ponto.
Só esses quadros (e uma rampa curta em volta, para não criar degrau) recebem um ajuste local
quadrático, centrado e robusto, numa janela mais larga. O ajuste centrado não atrasa: segue movimento
com velocidade e aceleração constantes sem desvio. Os demais quadros ficam exatamente como estavam.
Cada trecho de rastreio é tratado sozinho: nada atravessa uma perda.
"""
import numpy as np

METHOD = 'localized-transition-deshake-v1'
WINDOW_SECONDS = .33        # janela do ajuste nos quadros marcados
TRANSITION_SECONDS = .07    # quadros marcados em volta de cada troca de origem
RAMP_SECONDS = .1           # rampa de entrada e saída do ajuste
MAX_FRACTION = .15          # correção máxima, em fração da altura da caixa do rosto


def _fit(times, values, center, radius_seconds):
    """Valor do ajuste local quadrático robusto no instante central."""
    t = times - center
    degree = min(2, len(t) - 1)
    design = np.column_stack([t ** k for k in range(degree + 1)])
    base = np.exp(-.5 * (t / max(1e-6, radius_seconds * .6)) ** 2)
    weights = base.copy()
    fit = None
    for _ in range(3):
        fit = np.linalg.lstsq(design * weights[:, None] ** .5, values * weights ** .5, rcond=None)[0]
        residual = values - design @ fit
        scale = max(.5, float(np.median(np.abs(residual - np.median(residual)))) * 1.4826)
        weights = base * np.minimum(1., 2.5 * scale / np.maximum(np.abs(residual), 1e-6))
    return float(fit[0])


def stabilize(run, fps):
    report = dict(method=METHOD, rows=0, transitions=0, propagatedRows=0, maxCorrectionPixels=0.)
    n = len(run)
    if n < 5:
        return report
    mark = np.zeros(n)
    k = max(2, round(fps * TRANSITION_SECONDS))
    for i in range(1, n):
        if run[i].get('source') != run[i - 1].get('source'):
            report['transitions'] += 1
            mark[max(0, i - k):min(n, i + k)] = 1.
    for i, row in enumerate(run):
        if (row.get('headBounds') or {}).get('source') == 'face-propagated':
            report['propagatedRows'] += 1
            mark[i] = 1.
    if not mark.any():
        return report
    ramp = max(1, round(fps * RAMP_SECONDS))
    weight = mark.copy()
    for i in np.flatnonzero(mark):
        lo, hi = max(0, i - ramp), min(n, i + ramp + 1)
        for j in range(lo, hi):
            weight[j] = max(weight[j], 1. - abs(j - i) / (ramp + 1))
    radius = max(3, round(fps * WINDOW_SECONDS / 2))
    times = np.array([r['time'] for r in run], float)
    points = np.array([[r['trackingPoint']['x'], r['trackingPoint']['y']] for r in run], float)
    for i in np.flatnonzero(weight > 0):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        if hi - lo < 5:
            continue
        target = np.array([_fit(times[lo:hi], points[lo:hi, a], times[i], radius / fps) for a in range(2)])
        delta = (target - points[i]) * weight[i]
        limit = MAX_FRACTION * float(run[i].get('height') or 0.)
        size = float(np.hypot(*delta))
        if limit > 0 and size > limit:
            delta *= limit / size
            size = limit
        if size <= 1e-9:
            continue
        run[i]['trackingPoint'] = {'x': float(points[i, 0] + delta[0]), 'y': float(points[i, 1] + delta[1])}
        report['rows'] += 1
        report['maxCorrectionPixels'] = max(report['maxCorrectionPixels'], round(size, 3))
    return report
