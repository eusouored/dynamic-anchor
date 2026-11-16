"""Teste A/B dos executáveis do motor pelo HTTP, como o painel faz (127.0.0.1, perfil isolado, sem cache).

Para cada motor: liga com LOCALAPPDATA/APPDATA/TEMP próprios e porta própria, pede /v1/rostos,
escolhe o maior rosto e roda a análise do painel (cabeça inteira, 960 px, passo 1, sem proxy).
Compara as linhas (trajeto) entre os motores e mede o tempo de parede.

Uso: python testar_http.py <saida.json> <perfis> <clipes.json> <motor> [<motor> ...]
  motor = rotulo:caminho-do-exe:prefixo   (prefixo do formato do pedido e da variável de porta; o atual é anchor)
  clipes.json = [{"path":..., "in":..., "out":..., "width":3840, "height":2160, "fps":59.94}]
"""
import json, os, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

saida, perfis, clipes_json = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
motores = [(m.split(':', 1)[0],) + tuple(m.split(':', 1)[1].rsplit(':', 1)) for m in sys.argv[4:]]
clipes = json.loads(clipes_json.read_text(encoding='utf-8'))


def http(porta, caminho, corpo=None, tempo=30):
    dados = None if corpo is None else json.dumps(corpo).encode('utf-8')
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (porta, caminho), data=dados,
                                 method='POST' if corpo is not None else 'GET')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=tempo) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'httpStatus': e.code, **json.loads(e.read().decode('utf-8') or '{}')}


def ligar(exe, prefixo, porta, perfil):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('PYTHON', 'VIRTUAL_ENV', 'CONDA'))}
    env['PATH'] = ';'.join(p for p in env.get('PATH', '').split(';') if 'python' not in p.lower())
    for d in ('local', 'roaming', 'temp'):
        (perfil / d).mkdir(parents=True, exist_ok=True)
    env.update(LOCALAPPDATA=str(perfil / 'local'), APPDATA=str(perfil / 'roaming'), TEMP=str(perfil / 'temp'),
               TMP=str(perfil / 'temp'))
    env[prefixo.upper() + '_PORTA'] = str(porta)
    proc = subprocess.Popen([str(exe)], cwd=str(perfil), env=env)
    fim = time.time() + 120
    while time.time() < fim:
        if proc.poll() is not None:
            raise RuntimeError('motor saiu com código %s' % proc.returncode)
        try:
            st = http(porta, '/v1/status', tempo=2)
            if st.get('service'):
                return proc, st
        except Exception:
            time.sleep(0.5)
    proc.kill()
    raise RuntimeError('motor não respondeu')


def analisar(porta, corpo):
    t0 = time.perf_counter()
    r = http(porta, '/v1/analises', corpo)
    if 'id' not in r:
        return {'erro': r, 'parede': time.perf_counter() - t0}
    while True:
        st = http(porta, '/v1/analises/' + r['id'])
        if st.get('state') not in ('queued', 'running'):
            st['parede'] = time.perf_counter() - t0
            return st
        time.sleep(0.25)


resultado = {}
for i, (rotulo, exe, prefixo) in enumerate(motores):
    porta = 47950 + i
    proc, status = ligar(Path(exe), prefixo, porta, perfis / ('%s-%s' % (rotulo, uuid.uuid4().hex[:6])))
    out = {'status': status, 'diagnostico': http(porta, '/v1/diagnostico'), 'casos': []}
    try:
        for c in clipes:
            job = dict(format=prefixo + '-face-job', version=1, mediaPath=c['path'], inPoint=c['in'], outPoint=c['out'],
                       width=c['width'], height=c['height'], fps=c['fps'], requestId='teste-' + uuid.uuid4().hex[:16],
                       selection={'name': 'teste local'})
            rostos = http(porta, '/v1/rostos', {'job': job, 'options': {'perfil': 'equilibrado'}})
            op = dict(perfil='equilibrado', referencia='cabeca', analise=960, passo=1, usar_proxy=False)
            if rostos.get('faces'):
                f = max(rostos['faces'], key=lambda f: f['width'] * f['height'])
                op.update(alvo=[f['x'], f['y']], alvo_tempo=rostos['time'])
            res = analisar(porta, {'job': job, 'options': op})
            r = res.get('result') or {}
            out['casos'].append({'clipe': Path(c['path']).name, 'in': c['in'], 'estado': res.get('state'), 'parede': round(res['parede'], 2),
                                 'linhas': r.get('rows'), 'erro': res.get('erro') or res.get('message') if res.get('state') != 'done' else None,
                                 'rostos': len(rostos.get('faces') or [])})
            print('%-8s %-14s %-6s %6.2fs linhas=%s' % (rotulo, Path(c['path']).name, res.get('state'), res['parede'], len(r.get('rows') or [])), flush=True)
    finally:
        http(porta, '/v1/encerrar', {})
        try:
            proc.wait(20)
        except subprocess.TimeoutExpired:
            proc.kill()
    out['codigoSaida'] = proc.returncode
    resultado[rotulo] = out

rotulos = list(resultado)
if len(rotulos) >= 2:
    a, b = resultado[rotulos[0]]['casos'], resultado[rotulos[1]]['casos']
    for x, y in zip(a, b):
        print('%s: linhas iguais=%s  tempo %s -> %s s' % (x['clipe'], x['linhas'] == y['linhas'], x['parede'], y['parede']))
for r in rotulos:
    st = resultado[r]['status']
    print(r, {k: st.get(k) for k in ('service', 'version', 'api', 'engine')})
saida.write_text(json.dumps(resultado, ensure_ascii=False), encoding='utf-8')
