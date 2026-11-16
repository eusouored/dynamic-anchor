"""Ícones do painel: apaga os que nenhum .js/.css/.html cita e tira dos PNG os blocos de metadados
(texto, EXIF, proveniência/C2PA etc.). Os pixels não mudam: ficam só os blocos que desenham a imagem.

Uso: python limpar_icones.py <pasta-plugin> [--aplicar]
"""
import re, struct, sys, zlib
from pathlib import Path

MANTER = {b'IHDR', b'PLTE', b'tRNS', b'IDAT', b'IEND', b'gAMA', b'sRGB', b'cHRM', b'iCCP', b'pHYs', b'sBIT'}


def limpar_png(dados):
    assert dados[:8] == b'\x89PNG\r\n\x1a\n'
    saida, pos, tirados = [dados[:8]], 8, []
    while pos < len(dados):
        n, tipo = struct.unpack('>I4s', dados[pos:pos + 8])
        bloco = dados[pos:pos + 12 + n]
        if tipo in MANTER:
            saida.append(bloco)
        else:
            tirados.append(tipo.decode('latin-1'))
        pos += 12 + n
        if tipo == b'IEND':
            break
    return b''.join(saida), tirados


def main(raiz, aplicar):
    raiz = Path(raiz)
    textos = '\n'.join(p.read_text(encoding='utf-8', errors='replace') for p in raiz.rglob('*') if p.suffix in ('.js', '.css', '.html', '.json'))
    usados = set(re.findall(r'icons/([\w@.\-]+\.(?:svg|png))', textos))
    usados |= {re.sub(r'\.(png|svg)$', r'@2x.\1', n) for n in usados}  # o UXP busca a versão @2x sozinho
    for p in sorted((raiz / 'icons').iterdir()):
        if p.name not in usados:
            print('sem uso, apagar:', p.name)
            if aplicar:
                p.unlink()
            continue
        if p.suffix == '.png':
            novo, tirados = limpar_png(p.read_bytes())
            if tirados:
                print('metadados tirados de %s: %s' % (p.name, ','.join(tirados)))
                if aplicar:
                    p.write_bytes(novo)
    # o ícone do manifesto e o da lista de plugins ficam fora de icons/? confere também a raiz
    for p in sorted(raiz.rglob('*.png')):
        if p.parent.name != 'icons':
            novo, tirados = limpar_png(p.read_bytes())
            if tirados:
                print('metadados tirados de %s: %s' % (p.relative_to(raiz), ','.join(tirados)))
                if aplicar:
                    p.write_bytes(novo)


if __name__ == '__main__':
    main(sys.argv[1], '--aplicar' in sys.argv)
