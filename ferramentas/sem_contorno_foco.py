"""Tira do CSS do painel os seletores que pintam contorno/borda amarela em foco (:focus) e no
seletor aberto (.b-dd.open). Regras que ficam sem nenhum seletor são apagadas; as demais
perdem só esses seletores. Respeita blocos @media (um nível).

Uso: python sem_contorno_foco.py <arquivo.css> [...]
"""
import re, sys

TIRAR = re.compile(r':focus|\.b-dd\.open')


def limpar_bloco(texto):
    saida, pos, tirados = [], 0, 0
    for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', texto):
        saida.append(texto[pos:m.start()])
        prefixo = re.match(r'\s*(/\*.*?\*/\s*)*', m.group(1), re.S).group(0)
        seletores = m.group(1)[len(prefixo):]
        partes = [s for s in seletores.split(',')]
        ficam = [s for s in partes if not TIRAR.search(s)]
        tirados += len(partes) - len(ficam)
        if ficam:
            saida.append(prefixo + ','.join(ficam).rstrip() + (' ' if seletores.endswith(' ') else '') + '{' + m.group(2) + '}')
        else:
            saida.append(prefixo)
        pos = m.end()
    saida.append(texto[pos:])
    return ''.join(saida), tirados


def limpar(texto):
    total, saida, pos = 0, [], 0
    for m in re.finditer(r'@media[^{]*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}', texto):
        antes, n = limpar_bloco(texto[pos:m.start()])
        dentro, k = limpar_bloco(m.group(1))
        saida += [antes, texto[m.start():m.start(1)], dentro, '}']
        total += n + k
        pos = m.end()
    resto, n = limpar_bloco(texto[pos:])
    saida.append(resto)
    return ''.join(saida), total + n


if __name__ == '__main__':
    for arq in sys.argv[1:]:
        t = open(arq, encoding='utf-8').read()
        novo, n = limpar(t)
        open(arq, 'w', encoding='utf-8', newline='').write(novo)
        print('%s: %d seletores retirados; sobrou ":focus"/".b-dd.open"? %s' % (arq, n, bool(TIRAR.search(re.sub(r'/\*.*?\*/', '', novo, flags=re.S)))))
