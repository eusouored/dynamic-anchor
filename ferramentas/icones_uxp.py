"""Gera as caixas de marcar, rádios, bolinhas dos sliders e pontos de estado para o UXP.

O desenhador do Premiere ignora o canto arredondado de <rect rx> (sai quadrado) e corta a
última linha e coluna de uma forma que encosta na borda da imagem (escala do Windows não
inteira). Aqui toda forma é um <path> com arcos e fica 1 px longe das bordas: a imagem
cresce 2 px (o CSS acompanha) e o desenho visível mantém o tamanho e as cores de antes.
Uso: python icones_uxp.py <pasta-icons>
"""
import sys
from pathlib import Path


def svg(lado, corpo):
    return '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">%s</svg>' % (lado, lado, lado, lado, corpo)


def circulo(c, r, cor):
    return '<path d="M%g %g A%g %g 0 1 1 %g %g A%g %g 0 1 1 %g %gZ" fill="%s"/>' % (c, c - r, r, r, c, c + r, r, r, c, c - r, cor)


def retangulo(x0, y0, x1, y1, r, cor):
    return ('<path d="M%g %g H%g A%g %g 0 0 1 %g %g V%g A%g %g 0 0 1 %g %g H%g A%g %g 0 0 1 %g %g V%g A%g %g 0 0 1 %g %gZ" fill="%s"/>'
            % (x0 + r, y0, x1 - r, r, r, x1, y0 + r, y1 - r, r, r, x1 - r, y1, x0 + r, r, r, x0, y1 - r, y0 + r, r, r, x0 + r, y0, cor))


MARCA = '<path d="M4.4 8.1 L6.8 10.4 L11.8 5.5" fill="none" stroke="%s" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
ICONES = {
    # caixa: 14 px visíveis (1..15) numa imagem de 16
    'da-check-on.svg': svg(16, retangulo(1, 1, 15, 15, 3.5, '#FFBF48') + MARCA % '#1B1B1F'),
    'da-check-off-dark.svg': svg(16, retangulo(1, 1, 15, 15, 3.5, '#908A84') + retangulo(2.5, 2.5, 13.5, 13.5, 2.2, '#1B1B1F')),
    'da-check-off-light.svg': svg(16, retangulo(1, 1, 15, 15, 3.5, '#9B948B') + retangulo(2.5, 2.5, 13.5, 13.5, 2.2, '#F5F3F0')),
    # rádio e bolinha do slider: 16 px visíveis (1..17) numa imagem de 18
    'da-radio-on-dark.svg': svg(18, circulo(9, 8, '#FFBF48') + circulo(9, 3, '#1B1B1F')),
    'da-radio-on-light.svg': svg(18, circulo(9, 8, '#D89A22') + circulo(9, 3, '#F5F3F0')),
    'da-radio-off-dark.svg': svg(18, circulo(9, 8, '#908A84') + circulo(9, 6.5, '#1B1B1F')),
    'da-radio-off-light.svg': svg(18, circulo(9, 8, '#9B948B') + circulo(9, 6.5, '#F5F3F0')),
    'da-thumb-dark.svg': svg(18, circulo(9, 8, '#FFBF48') + circulo(9, 5, '#F5F3F0')),
    'da-thumb-light.svg': svg(18, circulo(9, 8, '#D89A22') + circulo(9, 5, '#FFFFFF')),
    'da-thumb-off.svg': svg(18, circulo(9, 8, '#85807A') + circulo(9, 5, '#B8B3AC')),
}
# pontos dos selos: 6 px visíveis (1..7) numa imagem de 8, cores de antes
for nome in ('da-dot-accent-dark', 'da-dot-accent-light', 'da-dot-muted-dark', 'da-dot-muted-light', 'da-dot-ok-dark', 'da-dot-ok-light', 'da-dot-warn'):
    ICONES[nome + '.svg'] = None

if __name__ == '__main__':
    import re
    pasta = Path(sys.argv[1])
    for nome, conteudo in ICONES.items():
        if conteudo is None:
            cor = re.search(r'fill="(#[0-9A-Fa-f]{6})"', (pasta / nome).read_text(encoding='utf-8')).group(1)
            conteudo = svg(8, circulo(4, 3, cor))
        (pasta / nome).write_text(conteudo, encoding='utf-8')
        print('gerado', nome)
