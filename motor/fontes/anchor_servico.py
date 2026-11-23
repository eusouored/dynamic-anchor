#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dynamic Anchor — serviço local do motor de rosto.

O painel UXP não consegue iniciar processos com argumentos nem ler a saída de
programas. Por isso o motor roda como um pequeno serviço HTTP que só escuta em
127.0.0.1. O painel envia o pedido do take, acompanha o progresso, pode
cancelar e recebe o trajeto pronto para validar e aplicar.

- Só lê vídeos; nunca altera projeto, mídia ou máscaras.
- Uma análise por vez. Resultados ficam em cache por mídia, intervalo,
  formato, opções e versão do motor.
- Recusa requisições vindas de páginas da web (cabeçalho Origin http/https).

Início: iniciar-motor.bat (ou o botão "Iniciar motor" do painel).
"""
import hashlib
import inspect
import json
import math
import os
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from anchor_lifecycle import PremiereLifetime, METHOD as LIFETIME_METHOD

# Capture the original host before importing the heavier runtime. A Premiere
# opened later must not adopt a service whose original owner has already exited.
_STARTUP_LIFETIME = None
if __name__ == '__main__' and (len(sys.argv) < 2 or sys.argv[1] not in ('--versao', '--diagnostico', '--preparar')):
    try:
        _STARTUP_LIFETIME = PremiereLifetime()
        if _STARTUP_LIFETIME.should_stop():
            _STARTUP_LIFETIME.close()
            sys.exit(5)
    except OSError:
        sys.exit(5)

PASTA = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PASTA)
import anchor_rosto as R  # noqa: E402

API = 1
PORTA = int(os.environ.get('ANCHOR_PORTA', '47833'))
VERSAO_SERVICO = '0.5.3'  # versão empacotada; o cache usa o epoch dos dados em R.EPOCAS_ANALISE
EXTENSOES = {'.mp4', '.mov', '.mxf', '.m4v', '.avi', '.mts', '.m2ts', '.mkv', '.wmv', '.mpg', '.mpeg'}
MAX_CORPO = 1024 * 1024
MAX_TAREFAS = 8
MAX_CACHE_MEMORIA = 16
MAX_CACHE_DISCO = 200
MODELO_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'


def pasta_dados():
    base = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    pasta = os.path.join(base, 'Dynamic Anchor', 'motor-rosto')
    os.makedirs(os.path.join(pasta, 'cache'), exist_ok=True)
    return pasta


DADOS = None
LOG_LOCK = threading.Lock()


def registrar(texto):
    linha = time.strftime('%Y-%m-%d %H:%M:%S ') + texto + '\n'
    try:
        caminho = os.path.join(DADOS or pasta_dados(), 'servico.log')
        with LOG_LOCK:
            if os.path.isfile(caminho) and os.path.getsize(caminho) > 1024 * 1024:
                os.replace(caminho, caminho + '.1')
            with open(caminho, 'a', encoding='utf-8') as f:
                f.write(linha)
    except OSError:
        pass


class ErroPedido(Exception):
    def __init__(self, mensagem, status=400):
        Exception.__init__(self, mensagem)
        self.status = status


def numero(valor, nome, minimo=None, maximo=None):
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        raise ErroPedido('Campo %s inválido.' % nome)
    try:
        finito = math.isfinite(float(valor))
    except (OverflowError, ValueError):
        finito = False
    if not finito:
        raise ErroPedido('Campo %s inválido.' % nome)
    if (minimo is not None and valor < minimo) or (maximo is not None and valor > maximo):
        raise ErroPedido('Campo %s fora do intervalo.' % nome)
    return valor


def validar_pedido(pedido):
    if not isinstance(pedido, dict) or pedido.get('format') != 'anchor-face-job' or pedido.get('version') != 1:
        raise ErroPedido('Pedido incompatível. Atualize o painel e o motor juntos.')
    req = pedido.get('requestId')
    if not isinstance(req, str) or not 8 <= len(req) <= 128:
        raise ErroPedido('Pedido sem identificador.')
    if not isinstance(pedido.get('selection'), dict):
        raise ErroPedido('Pedido sem a identidade do take.')
    for chave in ('mediaPath', 'proxyPath'):
        caminho = pedido.get(chave)
        if caminho is None:
            continue
        if not isinstance(caminho, str) or len(caminho) > 4096:
            raise ErroPedido('Caminho de mídia inválido.')
        if os.path.splitext(caminho)[1].lower() not in EXTENSOES:
            raise ErroPedido('Tipo de arquivo não suportado pelo motor: %s' % os.path.basename(caminho))
    if not pedido.get('mediaPath') or not os.path.isfile(pedido['mediaPath']):
        raise ErroPedido('Mídia não encontrada no disco: %s' % pedido.get('mediaPath'), 404)
    numero(pedido.get('inPoint'), 'inPoint', 0)
    numero(pedido.get('outPoint'), 'outPoint', 0)
    if not pedido['outPoint'] > pedido['inPoint']:
        raise ErroPedido('Intervalo do take vazio.')
    numero(pedido.get('width'), 'width', 16, 16384)
    numero(pedido.get('height'), 'height', 16, 16384)
    numero(pedido.get('fps'), 'fps', 1, 240)
    return pedido


def assinatura_arquivo(caminho):
    if not caminho or not os.path.isfile(caminho):
        return None
    st = os.stat(caminho)
    # Nanosegundos distinguem edições de mesmo tamanho feitas no mesmo segundo.
    return [os.path.normcase(os.path.abspath(caminho)), st.st_size, st.st_mtime_ns]


def chave_cache(pedido, opcoes):
    referencia = opcoes.get('referencia', 'caixa')
    if referencia not in R.EPOCAS_ANALISE:
        raise R.ErroMotor('Referência sem epoch de análise explícito.')
    excluir = set(R.SO_EXECUCAO)
    if referencia == 'caixa':
        excluir.add('referencia')  # referência padrão não altera opções de análise
    base = {
        'motor': R.MOTOR, 'versao': R.EPOCAS_ANALISE[referencia],
        'midia': assinatura_arquivo(pedido['mediaPath']),
        'proxy': assinatura_arquivo(pedido.get('proxyPath')) if opcoes.get('usar_proxy', True) else None,
        'in': round(pedido['inPoint'], 6), 'out': round(pedido['outPoint'], 6),
        'w': pedido['width'], 'h': pedido['height'], 'fps': round(pedido['fps'], 6),
        # Opções que só mudam a execução (prévia, paralelo) não entram: o resultado é o mesmo.
        'opcoes': {k: v for k, v in sorted(opcoes.items()) if k not in excluir},
    }
    if referencia == 'video15':
        base['video15'] = {'method': R.Dense.METHOD_V3, 'modelSha256': R.Dense.MODEL_SHA256,
                           'runtimeVersion': R.Dense.RUNTIME_VERSION, 'analysisWidth': 960,
                           'resize': 'INTER_AREA', 'step': 1 if opcoes.get('passo') == 'auto' else opcoes['passo'], 'timestampPolicy': 'decoder-pts-monotonic',
                           'smoothing': 'centered-mean-15-split', 'driftCorrection': 'centered-box-offset-2s',
                           'association': R.Sampling.ASSOCIATION, 'sampling': 'fixed-stride-v1'}
    return hashlib.sha256(json.dumps(base, sort_keys=True).encode('utf-8')).hexdigest()


def resultado_video15_atual(resultado, opcoes):
    """Do not serve an old, wrong-stride or incomplete result under a v2 key."""
    if not isinstance(resultado, dict):
        return False
    ref = resultado.get('trackingReference') or {}
    coverage = resultado.get('referenceCoverage') or {}
    stats = resultado.get('stats') or {}
    if not all(isinstance(value, dict) for value in (ref, coverage, stats)):
        return False
    step = 1 if opcoes.get('passo') == 'auto' else opcoes.get('passo')
    return (type(stats.get('step')) is int and stats['step'] in (1, 2, 3)
            and resultado.get('version') == 2 and resultado.get('engineVersion') == R.VERSAO_MOTOR
            and ref.get('schema') == 3 and ref.get('method') == R.Dense.METHOD_V3
            and ref.get('sampling') == {'method': 'fixed-stride-v1', 'step': step,
                                      'interpolation': 'valid-adjacent-endpoints', 'recoveryFrames': 0}
            and ref.get('driftCorrection') == {'method': 'centered-box-offset', 'windowSeconds': 2}
            and isinstance(coverage.get('interpolatedFrames'), list)
            and isinstance(coverage.get('missing'), list)
            and stats['step'] == step)


class Cache:
    def __init__(self, pasta):
        self.pasta = pasta
        self.memoria = {}
        self.lock = threading.Lock()

    def obter(self, chave):
        with self.lock:
            if chave in self.memoria:
                return json.loads(self.memoria[chave])
        caminho = os.path.join(self.pasta, chave + '.json')
        try:
            with open(caminho, 'r', encoding='utf-8') as f:
                texto = f.read()
            resultado = json.loads(texto)
        except (OSError, ValueError):
            return None
        self._lembrar(chave, texto)
        return resultado

    def guardar(self, chave, resultado):
        texto = json.dumps(resultado, ensure_ascii=False)
        self._lembrar(chave, texto)
        try:
            tmp = os.path.join(self.pasta, chave + '.tmp')
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(texto)
            os.replace(tmp, os.path.join(self.pasta, chave + '.json'))
            arquivos = sorted((os.path.getmtime(os.path.join(self.pasta, n)), n) for n in os.listdir(self.pasta) if n.endswith('.json'))
            for _, nome in arquivos[:-MAX_CACHE_DISCO]:
                os.remove(os.path.join(self.pasta, nome))
        except OSError as erro:
            registrar('CACHE: não gravado: %s' % erro)

    def _lembrar(self, chave, texto):
        with self.lock:
            self.memoria.pop(chave, None)
            self.memoria[chave] = texto
            while len(self.memoria) > MAX_CACHE_MEMORIA:
                self.memoria.pop(next(iter(self.memoria)))


def _aceita(funcao, nome):
    """executar injetado (testes) pode não ter os parâmetros novos."""
    try:
        p = inspect.signature(funcao).parameters
    except (TypeError, ValueError):
        return False
    return nome in p or any(v.kind == inspect.Parameter.VAR_KEYWORD for v in p.values())


class Tarefa:
    def __init__(self, pedido, opcoes):
        self.id = uuid.uuid4().hex
        self.pedido = pedido
        self.opcoes = opcoes
        self.estado = 'queued'
        self.progresso = 0.0
        self.quadros = 0
        self.qps = 0.0
        self.mensagem = 'Na fila.'
        self.resultado = None
        self.cache = False
        self.inicio = time.time()
        self.fim = None
        self.cancelar = threading.Event()
        self.fonte = None  # o que o motor usa de fato (fonte, backend, aceleração, perfil, passo)

    def resumo(self, com_resultado=False):
        d = {'id': self.id, 'requestId': self.pedido.get('requestId'), 'state': self.estado,
             'progress': round(self.progresso, 4), 'frames': self.quadros, 'framesPerSecond': round(self.qps, 1),
             'elapsed': round((self.fim or time.time()) - self.inicio, 2), 'message': self.mensagem, 'cached': self.cache}
        if self.fonte is not None:
            d['source'] = self.fonte
        if com_resultado and self.estado == 'done':
            d['result'] = self.resultado
        return d


class Servico:
    def __init__(self, executar=None, pasta=None, rostos_iniciais=None):
        self.executar = executar or R.executar
        self.rostos_iniciais = rostos_iniciais or R.rostos_iniciais
        self.cache = Cache(os.path.join(pasta or pasta_dados(), 'cache'))
        self.tarefas = {}
        self.lock = threading.Lock()
        self.ativa = None
        self.parar = threading.Event()
        self.lifetime = None

    def status(self):
        with self.lock:
            ativa = self.ativa.resumo() if self.ativa and self.ativa.estado in ('queued', 'running') else None
        from anchor_head import capability as head_capability
        whole_head=head_capability()
        references = ['caixa', 'media5', 'adaptativo'] + (['cabeca'] if whole_head else [])
        if R.Dense.capability() is True:
            references.append('video15')
        return {'service': 'anchor-rosto', 'api': API, 'version': VERSAO_SERVICO, 'engine': R.MOTOR,
                'busy': ativa is not None, 'task': ativa, 'pid': os.getpid(),
                'features': ['rostos', 'diagnostico', 'qualidade', 'adaptive-center-v1'] + (['whole-head-v1'] if whole_head else []) + ([LIFETIME_METHOD] if self.lifetime is not None else []), 'references': references,
                'samplingModes': ['normal', 'fast', 'ultra'] if 'adaptativo' in references or 'video15' in references else []}

    def iniciar(self, corpo):
        pedido = validar_pedido(corpo.get('job') if isinstance(corpo, dict) else None)
        opcoes_recebidas = corpo.get('options', {})
        if not isinstance(opcoes_recebidas, dict):
            raise ErroPedido('Opções inválidas.')
        try:
            opcoes = R.opcoes_validas({k: v for k, v in opcoes_recebidas.items() if k != 'previa'})
        except R.ErroMotor as erro:
            raise ErroPedido(str(erro))
        if opcoes.get('referencia') == 'video15' and R.Dense.capability() is not True:
            detalhe = R.Dense.capability_detail()
            raise ErroPedido('video15 indisponível: runtime/modelo não verificado (%s).' % detalhe.get('reason', 'indisponível'))
        tarefa = Tarefa(pedido, opcoes)
        chave = chave_cache(pedido, opcoes)
        with self.lock:
            if self.ativa and self.ativa.estado in ('queued', 'running'):
                raise ErroPedido('Outra análise está em andamento. Aguarde ou cancele.', 409)
            self.tarefas[tarefa.id] = tarefa
            while len(self.tarefas) > MAX_TAREFAS:
                antiga = next(iter(self.tarefas))
                if self.tarefas[antiga] is tarefa:
                    break
                self.tarefas.pop(antiga)
            pronto = self.cache.obter(chave)
            if (pronto is not None and opcoes.get('referencia') == 'video15'
                    and not resultado_video15_atual(pronto, opcoes)):
                pronto = None
            if pronto is not None:
                self._concluir(tarefa, pronto, cache=True)
                registrar('CACHE: %s %.3f–%.3f' % (os.path.basename(pedido['mediaPath']), pedido['inPoint'], pedido['outPoint']))
                return tarefa
            self.ativa = tarefa
        threading.Thread(target=self._rodar, args=(tarefa, chave), daemon=True).start()
        return tarefa

    def _concluir(self, tarefa, resultado, cache=False):
        # O trajeto depende só de mídia, intervalo e formato; a identidade do
        # take e o identificador do pedido são sempre os do pedido atual.
        resultado = dict(resultado)
        resultado['selection'] = tarefa.pedido.get('selection')
        resultado['requestId'] = tarefa.pedido.get('requestId')
        tarefa.resultado = resultado
        tarefa.cache = cache
        tarefa.progresso = 1.0
        tarefa.quadros = resultado.get('stats', {}).get('decodedFrames', tarefa.quadros)
        tarefa.estado = 'done'
        tarefa.mensagem = 'Concluído (resultado reaproveitado).' if cache else 'Concluído.'
        tarefa.fim = time.time()

    def _rodar(self, tarefa, chave):
        tarefa.estado = 'running'
        tarefa.mensagem = 'Analisando.'
        registrar('INÍCIO: %s %.3f–%.3f' % (tarefa.pedido['mediaPath'], tarefa.pedido['inPoint'], tarefa.pedido['outPoint']))

        def progresso(fracao, n, qps):
            tarefa.progresso, tarefa.quadros, tarefa.qps = fracao, n, qps

        def informar(info):
            tarefa.fonte = info
            registrar('FONTE: %s' % R.resumo_tempos({'video': info})[0][len('Fonte: '):])

        extra = {'informar': informar} if _aceita(self.executar, 'informar') else {}
        try:
            resultado = self.executar(tarefa.pedido, tarefa.opcoes, progresso=progresso, cancelado=tarefa.cancelar.is_set, **extra)
            if tarefa.opcoes.get('referencia') == 'video15':
                if not resultado_video15_atual(resultado, tarefa.opcoes):
                    raise R.ErroMotor('Resultado video15 incompleto; não será armazenado no cache.')
            limpo = dict(resultado)
            limpo.pop('selection', None)
            limpo.pop('requestId', None)
            self.cache.guardar(chave, limpo)
            self._concluir(tarefa, resultado)
            registrar('FIM: %d linhas, %.1f q/s' % (len(resultado.get('rows', [])), tarefa.qps))
            st = resultado.get('stats') or {}
            if st.get('timing') or st.get('cpu'):
                for linha in R.resumo_tempos(st)[1:]:
                    registrar(linha.upper().split(':')[0] + ':' + linha.split(':', 1)[1])
        except R.Cancelado:
            tarefa.estado, tarefa.mensagem, tarefa.fim = 'cancelled', 'Análise cancelada.', time.time()
            registrar('CANCELADA')
        except R.ErroMotor as erro:
            tarefa.estado, tarefa.mensagem, tarefa.fim = 'error', str(erro), time.time()
            registrar('ERRO: %s' % erro)
        except Exception as erro:  # pragma: no cover - erro inesperado com detalhe no log
            tarefa.estado, tarefa.mensagem, tarefa.fim = 'error', 'Falha inesperada no motor: %s' % erro, time.time()
            registrar('FALHA: %s' % traceback.format_exc())
        finally:
            with self.lock:
                if self.ativa is tarefa:
                    self.ativa = None

    def rostos(self, corpo):
        pedido = validar_pedido(corpo.get('job') if isinstance(corpo, dict) else None)
        opcoes_recebidas = corpo.get('options', {})
        if not isinstance(opcoes_recebidas, dict):
            raise ErroPedido('Opções inválidas.')
        try:
            opcoes = R.opcoes_validas({k: v for k, v in opcoes_recebidas.items() if k not in ('previa', 'alvo', 'alvo_tempo')})
            resultado = self.rostos_iniciais(pedido, opcoes)
        except R.ErroMotor as erro:
            raise ErroPedido(str(erro), 422)
        resultado['requestId'] = pedido.get('requestId')
        resultado['selection'] = pedido.get('selection')
        registrar('ROSTOS: %s %.3f s -> %d' % (os.path.basename(pedido['mediaPath']), resultado.get('time') or -1, len(resultado.get('faces') or [])))
        return resultado

    def diagnostico(self):
        info = {'service': 'anchor-rosto', 'version': VERSAO_SERVICO, 'python': sys.version.split()[0],
                'executable': sys.executable, 'frozen': bool(getattr(sys, 'frozen', False)), 'pid': os.getpid()}
        try:
            info['opencv'] = R.cv2.__version__
            info['numpy'] = R.np.__version__
            info['faceDetector'] = hasattr(R.cv2, 'FaceDetectorYN')
            info.update(R.info_ambiente())
            info['instrumentation'] = R.VERSAO_INSTRUMENTACAO
        except Exception as erro:  # pragma: no cover
            info['opencvError'] = str(erro)
        dense = R.Dense.capability_detail()
        info['referenceCapabilities'] = {'video15': dense}
        from anchor_head import capability as head_capability
        whole_head = head_capability()
        info['referenceCapabilities']['cabeca'] = {'available': whole_head}
        info['samplingModes'] = ['normal', 'fast', 'ultra']
        info['references'] = ['caixa', 'media5', 'adaptativo'] + (['cabeca'] if whole_head else []) + (['video15'] if dense.get('available') is True else [])
        try:
            with open(R.MODELO, 'rb') as f:
                info['modelSha256'] = hashlib.sha256(f.read()).hexdigest()
            info['modelOk'] = info['modelSha256'] == MODELO_SHA256
        except OSError as erro:
            info['modelOk'] = False
            info['modelError'] = str(erro)
        dados = DADOS or pasta_dados()
        try:
            teste = os.path.join(dados, 'cache', '.escrita')
            with open(teste, 'w') as f:
                f.write('ok')
            os.remove(teste)
            info['cacheWritable'] = True
        except OSError:
            info['cacheWritable'] = False
        info['dataFolder'] = dados
        info['ok'] = bool(info.get('faceDetector') and info.get('modelOk') and info.get('cacheWritable'))
        return info

    def consultar(self, ident):
        tarefa = self.tarefas.get(ident)
        if tarefa is None:
            raise ErroPedido('Análise não encontrada (o motor pode ter sido reiniciado).', 404)
        return tarefa.resumo(com_resultado=True)

    def cancelar(self, ident):
        tarefa = self.tarefas.get(ident)
        if tarefa is None:
            raise ErroPedido('Análise não encontrada.', 404)
        tarefa.cancelar.set()
        if tarefa.estado in ('queued', 'running'):
            tarefa.mensagem = 'Cancelando…'
        return tarefa.resumo()

    def encerrar(self):
        with self.lock:
            if self.ativa and self.ativa.estado in ('queued', 'running'):
                self.ativa.cancelar.set()
        self.parar.set()


def origem_permitida(origem):
    # Páginas da web enviam Origin http(s). O painel UXP não é uma página web.
    return not origem or (origem.lower() != 'null' and not origem.lower().startswith(('http://', 'https://')))


def criar_manipulador(servico):
    class Manipulador(BaseHTTPRequestHandler):
        server_version = 'AnchorRosto/' + VERSAO_SERVICO
        protocol_version = 'HTTP/1.1'

        def log_message(self, formato, *args):
            pass

        def _responder(self, status, dados):
            corpo = json.dumps(dados, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(corpo)))
            self.send_header('Cache-Control', 'no-store')
            if self.close_connection:
                self.send_header('Connection', 'close')
            origem = self.headers.get('Origin')
            if origem and origem_permitida(origem):
                self.send_header('Access-Control-Allow-Origin', origem)
            self.end_headers()
            self.wfile.write(corpo)

        def _verificar_origem(self):
            origem = self.headers.get('Origin')
            if not origem_permitida(origem):
                # O corpo rejeitado não foi consumido; feche para ele não ser
                # interpretado como um próximo pedido HTTP nesta conexão.
                self.close_connection = True
                registrar('RECUSADO: origem %s' % origem)
                self._responder(403, {'error': 'Origem recusada: %s' % origem})
                return False
            return True

        def _corpo(self):
            tamanhos = self.headers.get_all('Content-Length', [])
            if self.headers.get_all('Transfer-Encoding', []):
                self.close_connection = True
                raise ErroPedido('Transfer-Encoding não suportado.')
            if len(tamanhos) > 1:
                self.close_connection = True
                raise ErroPedido('Content-Length duplicado.')
            if not tamanhos:
                tamanho = 0
            elif not tamanhos[0] or any(ch < '0' or ch > '9' for ch in tamanhos[0]):
                self.close_connection = True
                raise ErroPedido('Content-Length inválido.')
            else:
                texto_tamanho = tamanhos[0].lstrip('0') or '0'
                limite = str(MAX_CORPO)
                if (len(texto_tamanho) > len(limite) or
                        (len(texto_tamanho) == len(limite) and texto_tamanho > limite)):
                    self.close_connection = True
                    raise ErroPedido('Pedido grande demais.', 413)
                tamanho = int(texto_tamanho)
            if tamanho > MAX_CORPO:
                self.close_connection = True
                raise ErroPedido('Pedido grande demais.', 413)
            try:
                bruto = self.rfile.read(tamanho)
                if len(bruto) != tamanho:
                    self.close_connection = True
                    raise ErroPedido('Corpo do pedido truncado.')
                dados = json.loads(bruto.decode('utf-8') or '{}')
            except (ValueError, UnicodeDecodeError):
                self.close_connection = True
                raise ErroPedido('Pedido não é JSON válido.')
            if not isinstance(dados, dict):
                self.close_connection = True
                raise ErroPedido('Pedido JSON deve ser um objeto.')
            return dados

        def _verificar_sem_corpo(self):
            tamanhos = self.headers.get_all('Content-Length', [])
            erro = None
            if self.headers.get_all('Transfer-Encoding', []):
                erro = 'Transfer-Encoding não suportado.'
            elif len(tamanhos) > 1:
                erro = 'Content-Length duplicado.'
            elif tamanhos and (not tamanhos[0] or any(ch != '0' for ch in tamanhos[0])):
                erro = 'Esta rota não aceita corpo.'
            if erro:
                self.close_connection = True
                self._responder(400, {'error': erro})
                return False
            return True

        def do_OPTIONS(self):
            if not self._verificar_origem():
                return
            if not self._verificar_sem_corpo():
                return
            self.send_response(204)
            origem = self.headers.get('Origin')
            if origem:
                self.send_header('Access-Control-Allow-Origin', origem)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def do_GET(self):
            if not self._verificar_origem():
                return
            if not self._verificar_sem_corpo():
                return
            try:
                partes = [p for p in self.path.split('?')[0].split('/') if p]
                if partes == ['v1', 'status']:
                    return self._responder(200, servico.status())
                if partes == ['v1', 'diagnostico']:
                    return self._responder(200, servico.diagnostico())
                if len(partes) == 3 and partes[:2] == ['v1', 'analises']:
                    return self._responder(200, servico.consultar(partes[2]))
                self._responder(404, {'error': 'Rota desconhecida.'})
            except ErroPedido as erro:
                self._responder(erro.status, {'error': str(erro)})

        def do_POST(self):
            if not self._verificar_origem():
                return
            try:
                partes = [p for p in self.path.split('?')[0].split('/') if p]
                corpo = self._corpo()
                if partes == ['v1', 'analises']:
                    return self._responder(202, servico.iniciar(corpo).resumo(com_resultado=True))
                if partes == ['v1', 'rostos']:
                    return self._responder(200, servico.rostos(corpo))
                if len(partes) == 4 and partes[:2] == ['v1', 'analises'] and partes[3] == 'cancelar':
                    return self._responder(200, servico.cancelar(partes[2]))
                if partes == ['v1', 'encerrar']:
                    self._responder(200, {'ok': True})
                    servico.encerrar()
                    return
                self._responder(404, {'error': 'Rota desconhecida.'})
            except ErroPedido as erro:
                self._responder(erro.status, {'error': str(erro)})
            except Exception as erro:  # pragma: no cover
                registrar('FALHA HTTP: %s' % traceback.format_exc())
                self._responder(500, {'error': 'Falha interna do motor: %s' % erro})

    return Manipulador


def ja_rodando(porta):
    import urllib.request
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/v1/status' % porta, timeout=1.5) as r:
            return json.loads(r.read().decode('utf-8')).get('service') == 'anchor-rosto'
    except Exception:
        return False


class Servidor(ThreadingHTTPServer):
    """Servidor HTTP local. No Windows, SO_REUSEADDR deixa DUAS cópias do motor
    escutarem a mesma porta ao mesmo tempo (cada pedido cai numa delas). Por isso
    o bind é feito sem SO_REUSEADDR no Windows: uma segunda cópia falha no bind e
    sai como "já em execução"."""
    allow_reuse_address = os.name != 'nt'
    daemon_threads = True


def pedir_desempenho():
    """Pede ao Windows para não pôr o motor em modo de economia (EcoQoS).

    Sem isso, com o Premiere em primeiro plano o Windows pode deixar o motor (processo
    sem janela) só nos núcleos de eficiência, e a mesma análise fica bem mais lenta.
    É a opção documentada pela Microsoft para trabalho sensível a desempenho
    (SetProcessInformation / ProcessPowerThrottling, controle EXECUTION_SPEED com estado
    desligado). Não mexe em prioridade, afinidade nem plano de energia, e falhar não
    impede o motor de funcionar."""
    if os.name != 'nt':
        return 'não se aplica'
    try:
        import ctypes
        from ctypes import wintypes

        class Estado(ctypes.Structure):
            _fields_ = [('Version', wintypes.ULONG), ('ControlMask', wintypes.ULONG), ('StateMask', wintypes.ULONG)]

        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k.SetProcessInformation.restype = wintypes.BOOL
        k.GetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k.GetProcessInformation.restype = wintypes.BOOL
        process_power_throttling, execution_speed = 4, 0x1
        pedido = Estado(1, execution_speed, 0)
        if not k.SetProcessInformation(k.GetCurrentProcess(), process_power_throttling, ctypes.byref(pedido), ctypes.sizeof(pedido)):
            return 'recusado pelo Windows (erro %d)' % ctypes.get_last_error()
        lido = Estado(1, 0, 0)
        if k.GetProcessInformation(k.GetCurrentProcess(), process_power_throttling, ctypes.byref(lido), ctypes.sizeof(lido)):
            return 'economia desligada (controle %d, estado %d)' % (lido.ControlMask, lido.StateMask)
        return 'economia desligada'
    except Exception as erro:  # nunca derruba o motor
        return 'não aplicado: %s' % erro


def servir(porta=PORTA, servico=None, espera_porta=6.0, lifetime=None):
    global DADOS
    DADOS = pasta_dados()
    try:
        lifetime = lifetime if lifetime is not None else PremiereLifetime()
    except OSError:
        registrar('ERRO: monitor do Premiere indisponível; motor não iniciado.')
        return 5
    try:
        registrar('DESEMPENHO: %s' % pedir_desempenho())
        servico = servico or Servico()
        servico.lifetime = lifetime
        if lifetime.should_stop():
            registrar('ENCERRADO: ' + str(lifetime.reason))
            return 5
        fim = time.time() + espera_porta
        while True:
            try:
                httpd = Servidor(('127.0.0.1', porta), criar_manipulador(servico))
                break
            except OSError:
                if ja_rodando(porta):
                    registrar('Já em execução; nada a fazer.')
                    return 0
                if time.time() >= fim:
                    registrar('ERRO: porta %d ocupada por outro programa.' % porta)
                    return 4
                time.sleep(0.5)
        registrar('PRONTO: motor %s em 127.0.0.1:%d (pid %d); proteção %s' % (VERSAO_SERVICO, porta, os.getpid(), LIFETIME_METHOD))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            while not servico.parar.wait(0.5):
                if lifetime.should_stop():
                    registrar('ENCERRANDO: ' + str(lifetime.reason))
                    servico.encerrar()
        except KeyboardInterrupt:
            servico.encerrar()
        finally:
            httpd.shutdown()
            httpd.server_close()
        registrar('ENCERRADO')
        return 0
    finally:
        lifetime.close()


def _http(caminho, corpo=None, porta=PORTA, tempo=2.0):
    import urllib.request
    dados = None if corpo is None else json.dumps(corpo).encode('utf-8')
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (porta, caminho), data=dados,
                                 method='POST' if corpo is not None else 'GET')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=tempo) as r:
        return json.loads(r.read().decode('utf-8'))


def _estado_porta(porta):
    """('livre'|'anchor'|'outro', status). Primeiro testa a conexão TCP: no Windows,
    um pedido HTTP preso no backlog de outro programa pode fazer a porta parecer livre."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        aberta = s.connect_ex(('127.0.0.1', porta)) == 0
    if not aberta:
        return 'livre', None
    for _ in range(2):
        try:
            st = _http('/v1/status', porta=porta, tempo=2.5)
            if st.get('service') == 'anchor-rosto':
                return 'anchor', st
            return 'outro', None
        except Exception:
            time.sleep(0.2)
    return 'outro', None


def comando_servico():
    """Como ligar este mesmo motor em segundo plano (empacotado ou com Python)."""
    if getattr(sys, 'frozen', False):
        return [sys.executable]
    exe = sys.executable
    pyw = os.path.join(os.path.dirname(exe), 'pythonw.exe')
    return [pyw if os.name == 'nt' and os.path.isfile(pyw) else exe, os.path.abspath(__file__)]


def ligar_em_segundo_plano(cmd):
    import subprocess
    extra = {}
    if os.name == 'nt':
        extra['creationflags'] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        extra['start_new_session'] = True
    filho = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             close_fds=True, cwd=os.path.dirname(os.path.abspath(cmd[-1])), **extra)
    # Processo independente, que continua depois deste terminar: não será esperado.
    # Marcar como encerrado evita o aviso "subprocess is still running" do coletor.
    filho.returncode = 0
    return filho.pid


def preparar(relatorio=None, porta=PORTA, ligar=ligar_em_segundo_plano, espera=20.0):
    """Confere o motor passo a passo, liga (ou troca uma versão antiga) e grava o relatório.
    Idempotente: com tudo pronto, só confere. Não instala nada e não acessa a rede externa."""
    linhas, ok = [], True

    def passo(bom, texto):
        nonlocal ok
        ok = ok and bom
        linhas.append(('[OK]    ' if bom else '[FALHA] ') + texto)

    modo = 'empacotado' if getattr(sys, 'frozen', False) else 'Python'
    passo(True, 'Motor de rosto %s (%s): %s' % (VERSAO_SERVICO, modo, sys.executable))
    diag = Servico().diagnostico()
    passo(bool(diag.get('faceDetector')), 'OpenCV %s, NumPy %s, detector YuNet %s' % (
        diag.get('opencv', '?'), diag.get('numpy', '?'), 'disponível' if diag.get('faceDetector') else 'AUSENTE (OpenCV antigo: rode preparar-motor.bat)'))
    passo(bool(diag.get('modelOk')), 'Modelo do detector ' + ('confere (SHA-256)' if diag.get('modelOk') else
          'ausente ou alterado: copie de novo a pasta motor-rosto (%s)' % (diag.get('modelError') or 'hash diferente')))
    passo(bool(diag.get('cacheWritable')), 'Pasta de dados %s %s' % (diag.get('dataFolder'), 'gravável' if diag.get('cacheWritable') else 'SEM permissão de gravação'))
    if ok:
        estado, st = _estado_porta(porta)
        if estado == 'anchor' and st.get('version') != VERSAO_SERVICO:
            linhas.append('        Motor %s ligado; trocando pela versão %s.' % (st.get('version'), VERSAO_SERVICO))
            if st.get('busy'):
                passo(False, 'O motor antigo está analisando um take. Espere terminar (ou cancele no painel) e rode de novo.')
            else:
                # Pede para encerrar até a porta não responder mais com a versão antiga.
                # No Windows pode haver mais de uma cópia antiga na mesma porta.
                pedidos, fim = 0, time.time() + 20
                while time.time() < fim:
                    estado, st = _estado_porta(porta)
                    if estado == 'livre' or (estado == 'anchor' and (st.get('version') == VERSAO_SERVICO or st.get('busy'))):
                        break
                    if estado == 'anchor':
                        try:
                            _http('/v1/encerrar', {}, porta=porta, tempo=3.0)
                            pedidos += 1
                        except Exception:
                            pass
                    time.sleep(0.6)  # 'outro' logo após encerrar: a cópia antiga ainda está liberando a porta
                linhas.append('        Pedidos de encerramento enviados: %d%s.' % (
                    pedidos, ' (havia mais de uma cópia antiga escutando a mesma porta)' if pedidos > 1 else ''))
                registrar('PREPARAR: %d pedido(s) de encerramento para a versão antiga' % pedidos)
                if estado == 'anchor' and st.get('busy') and st.get('version') != VERSAO_SERVICO:
                    passo(False, 'Uma cópia antiga do motor está analisando um take. Espere terminar (ou cancele no painel) e rode de novo.')
        if not ok:
            pass
        elif estado == 'outro':
            passo(False, 'A porta 127.0.0.1:%d está ocupada por outro programa. Feche-o ou reinicie o Windows.' % porta)
        elif estado == 'anchor' and st.get('version') == VERSAO_SERVICO:
            passo(True, 'Motor já estava ligado em 127.0.0.1:%d (pid %s)' % (porta, _http('/v1/diagnostico', porta=porta).get('pid')))
        elif estado == 'anchor':
            passo(False, 'Não foi possível desligar o motor %s. Rode parar-motor.bat e depois este arquivo de novo.' % st.get('version'))
        else:
            try:
                ligar(comando_servico())
            except Exception as erro:
                passo(False, 'Não foi possível ligar o motor: %s' % erro)
            else:
                fim, st = time.time() + espera, None
                while time.time() < fim:
                    estado, st = _estado_porta(porta)
                    if estado == 'anchor':
                        break
                    time.sleep(0.3)
                if estado == 'anchor' and st.get('version') == VERSAO_SERVICO:
                    passo(True, 'Motor ligado em 127.0.0.1:%d (pid %s)' % (porta, _http('/v1/diagnostico', porta=porta).get('pid')))
                else:
                    passo(False, 'O motor não respondeu em %d s. Veja o registro em %s' % (espera, os.path.join(diag.get('dataFolder') or '', 'servico.log')))
    linhas.append('')
    linhas.append('RESULTADO: ' + ('PRONTO. Volte ao painel do Dynamic Anchor e clique em "Analisar rosto" (ou "Rastrear rosto e aplicar").' if ok else
                                   'NÃO PRONTO. Corrija o item marcado com [FALHA] e rode preparar-motor.bat de novo.'))
    texto = 'Dynamic Anchor — preparação do motor de rosto (%s)\n\n' % time.strftime('%Y-%m-%d %H:%M:%S') + '\n'.join(linhas) + \
        '\n\nDiagnóstico:\n' + json.dumps(diag, ensure_ascii=False, indent=2) + '\n'
    destino = relatorio or os.path.join(diag.get('dataFolder') or pasta_dados(), 'diagnostico.txt')
    try:
        with open(destino, 'w', encoding='utf-8') as f:
            f.write(texto)
    except OSError:
        pass
    if sys.stdout is not None:
        try:
            sys.stdout.write(texto)
            sys.stdout.flush()
        except Exception:
            pass
    return 0 if ok else 1


def principal(argv):
    if argv and argv[0] == '--preparar':
        return preparar(argv[1] if len(argv) > 1 else None)
    if argv and argv[0] == '--diagnostico':
        diag = Servico().diagnostico()
        texto = json.dumps(diag, ensure_ascii=False, indent=2)
        if len(argv) > 1:
            with open(argv[1], 'w', encoding='utf-8') as f:
                f.write(texto + '\n')
        elif sys.stdout is not None:
            print(texto)
        return 0 if diag.get('ok') else 1
    if argv and argv[0] == '--versao':
        if sys.stdout is not None:
            print(VERSAO_SERVICO)
        return 0
    return servir(lifetime=_STARTUP_LIFETIME)


if __name__ == '__main__':
    sys.exit(principal(sys.argv[1:]))
