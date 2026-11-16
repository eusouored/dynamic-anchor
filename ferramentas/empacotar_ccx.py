"""Gera o .ccx do Dynamic Anchor (zip com manifest.json na raiz).
Uso: python empacotar_ccx.py <pasta-plugin> <pasta-motor-rosto> <saida.ccx>
- <pasta-motor-rosto> é a saída de motor/construir_motor.py (anchor-motor/ + .bat);
- caches __pycache__ ficam fora;
- no fim confere o pacote (arquivos obrigatórios, CRC, dados pessoais e nomes antigos)."""
import json, re, sys, zipfile
from pathlib import Path

plugin, motor, out = (Path(a) for a in sys.argv[1:4])
manifest = json.loads((plugin / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['id'] == 'com.dynamic.anchor', manifest['id']
assert not (plugin / 'motor-rosto').exists(), 'a cópia de trabalho não deve ter motor-rosto'
out.parent.mkdir(parents=True, exist_ok=True)
if out.exists():
    out.unlink()

count, skipped = 0, 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    z.write(plugin / 'manifest.json', 'manifest.json'); count += 1
    for f in sorted(plugin.rglob('*')):
        if f.is_file() and f.name != 'manifest.json':
            z.write(f, f.relative_to(plugin).as_posix()); count += 1
    for f in sorted(motor.rglob('*')):
        if not f.is_file():
            continue
        rel = f.relative_to(motor)
        if '__pycache__' in rel.parts:
            skipped += 1
            continue
        z.write(f, 'motor-rosto/' + rel.as_posix()); count += 1

PESSOAIS = re.compile(rb'(?i)C:[\/]Users[\/](?!Public)[^\/]+[\/]')
ANTIGOS = re.compile(rb'$^')
hits = []
with zipfile.ZipFile(out) as z:
    assert z.testzip() is None, 'CRC com erro'
    names = set(z.namelist())
    for n in names:
        data = z.read(n)
        for rotulo, padrao in (('pessoal', PESSOAIS), ('nome antigo', ANTIGOS)):
            alvo = n.encode() + b'\n' + data
            if n.endswith('.pyd') or n.endswith('.dll'):
                # binários de terceiros: só os nomes de arquivo contam
                alvo = n.encode()
            if padrao.search(alvo):
                hits.append((n, rotulo))
for need in ('manifest.json', 'index.html', 'dynamic-anchor.css', 'LICENSE.txt', 'TERCEIROS.txt', 'icons/da-lockup-dark.png',
             'motor-rosto/anchor-motor/anchor-motor.exe', 'motor-rosto/iniciar-motor.bat', 'motor-rosto/preparar-motor.bat',
             'motor-rosto/parar-motor.bat', 'assets/linear-dual/Anchor-linear-template.prproj'):
    assert need in names, need
print('%s: %d arquivos (%d caches __pycache__ fora), %.1f MB, %s %s' % (out.name, count, skipped, out.stat().st_size / 1e6, manifest['name'], manifest['version']))
print('dados pessoais / nomes antigos no pacote:', hits if hits else 'nenhum')
