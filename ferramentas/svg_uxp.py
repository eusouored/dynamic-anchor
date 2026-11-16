"""O desenhador de SVG do UXP não herda atributos de apresentação da tag <svg> (nem de <g>)
para as formas: um fill="none" stroke="#fff" na raiz vira forma preenchida de preto.
Este script copia esses atributos para cada forma que não os declara e tira da raiz.

Uso: python svg_uxp.py <pasta-de-icones> [--aplicar]
Sem --aplicar, só lista os arquivos afetados.
"""
import re, sys
from pathlib import Path

ATRIBUTOS = ('fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'fill-rule')
FORMAS = ('path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon')


def attrs_de(tag):
    return dict(re.findall(r'\s([\w:-]+)="([^"]*)"', tag))


def corrigir(texto):
    herdados = {}
    def raiz(m):
        tag = m.group(0)
        a = attrs_de(tag)
        for k in ATRIBUTOS:
            if k in a:
                herdados[k] = a[k]
                tag = re.sub(r'\s%s="[^"]*"' % re.escape(k), '', tag)
        return tag
    texto = re.sub(r'<(svg|g)\b[^>]*>', raiz, texto)
    if not herdados:
        return texto, False
    def forma(m):
        tag = m.group(0)
        a = attrs_de(tag)
        extra = ''.join(' %s="%s"' % (k, v) for k, v in herdados.items() if k not in a)
        return tag[:-2] + extra + '/>' if tag.endswith('/>') else tag[:-1] + extra + '>'
    texto = re.sub(r'<(%s)\b[^>]*>' % '|'.join(FORMAS), forma, texto)
    return texto, True


if __name__ == '__main__':
    pasta, aplicar = Path(sys.argv[1]), '--aplicar' in sys.argv
    for p in sorted(pasta.rglob('*.svg')):
        novo, mudou = corrigir(p.read_text(encoding='utf-8'))
        if mudou:
            print(p.name)
            if aplicar:
                p.write_text(novo, encoding='utf-8')
