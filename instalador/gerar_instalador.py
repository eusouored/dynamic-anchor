"""Gera o instalador padrão da família Dynamic para um plugin.
Uso: python gerar_instalador.py <config.json>
Escreve Config.cs ao lado de Instalador.cs e compila com o csc do .NET Framework 4.
Caminhos do JSON são relativos à pasta do JSON."""
import json, subprocess, sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

cfg_path = Path(sys.argv[1]).resolve(); here = cfg_path.parent
c = json.loads(cfg_path.read_text(encoding='utf-8'))
p = lambda k: (here / c[k]).resolve()
for k in ('pacote', 'logo', 'icone', 'licenca', 'terceiros'):
    assert p(k).exists(), '%s não encontrado: %s' % (k, p(k))

def s(v):
    return '"' + v.replace('\\', '\\\\').replace('"', '\\"') + '"'

config = '\n'.join([
    '// Gerado por gerar_instalador.py a partir de %s. Não editar à mão.' % cfg_path.name,
    'namespace DynamicSetup', '{', '    static class Config', '    {',
    '        public const string Nome = %s;' % s(c['nome']),
    '        public const string Versao = %s;' % s(c['versao']),
    '        public const string Tecnologia = %s;' % s(c['tecnologia']),
    '        public const string Acento = %s;' % s(c['acento']),
    '        public const string TintaAcento = %s;' % s(c['tintaAcento']),
    '        public const string Descricao = %s;' % s(c['descricao']),
    '        public const string Requisitos = %s;' % s(c['requisitos']),
    '        public const string Aviso = %s;' % s(c.get('aviso', '')),
    '        public const string Pacote = %s;' % s(p('pacote').name),
    '        public static readonly string[] Itens = { %s };' % ', '.join(s(i) for i in c['itens']),
    # modo "pacote" (.ccx/.zxp pelo agente da Adobe) ou "script" (zip com instalador próprio do plugin)
    '        public const string Modo = %s;' % s(c.get('modo', 'pacote')),
    '        public const bool ModoDev = %s;' % ('true' if c.get('modoDev') else 'false'),
    '        public const bool OpcoesUso = %s;' % ('true' if c.get('opcoesUso') else 'false'),
    '        public const string ScriptPasta = %s;' % s(c.get('script', {}).get('pasta', '')),
    '        public const string ScriptInstalar = %s;' % s(c.get('script', {}).get('instalar', '')),
    '        public const string ScriptDesinstalar = %s;' % s(c.get('script', {}).get('desinstalar', '')),
    '        public const string ScriptIcone = %s;' % s(c.get('script', {}).get('icone', '')),
    '        public const string ScriptChave = %s;' % s(c.get('script', {}).get('chave', '')),
    '        public static readonly string[] Atalhos = { %s };' % ', '.join(s(x) for par in c.get('script', {}).get('atalhos', []) for x in par),
    '    }', '}', ''])
(here / 'Config.cs').write_text(config, encoding='utf-8-sig')

info = '\n'.join([
    'using System.Reflection;',
    '[assembly: AssemblyTitle(%s)]' % s('Instalador do ' + c['nome']),
    '[assembly: AssemblyProduct(%s)]' % s(c['nome']),
    '[assembly: AssemblyDescription(%s)]' % s('Instala o plugin %s %s no Adobe Premiere Pro' % (c['nome'], c['versao'])),
    '[assembly: AssemblyVersion(%s)]' % s(c['versao'] + '.0'),
    '[assembly: AssemblyFileVersion(%s)]' % s(c['versao'] + '.0'), ''])
(here / 'AssemblyInfo.cs').write_text(info, encoding='utf-8-sig')

out = p('saida') if (here / c['saida']).parent.exists() else here / Path(c['saida']).name
csc = r'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
cmd = [csc, '/nologo', '/optimize+', '/target:winexe', '/codepage:65001', '/out:' + str(out), '/win32icon:' + str(p('icone')),
       '/resource:%s,payload' % p('pacote'), '/resource:%s,logo.png' % p('logo'),
       '/resource:%s,licenca.txt' % p('licenca'), '/resource:%s,terceiros.txt' % p('terceiros'),
       '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
       str(here / 'Instalador.cs'), str(here / 'Config.cs'), str(here / 'AssemblyInfo.cs')]
r = subprocess.run(cmd, capture_output=True, text=True, encoding='cp850', errors='replace')
print(r.stdout.strip() or '(csc sem mensagens)')
if r.returncode:
    raise SystemExit('csc falhou: %d' % r.returncode)
print('gerado: %s (%.1f MB)' % (out, out.stat().st_size / 1e6))
