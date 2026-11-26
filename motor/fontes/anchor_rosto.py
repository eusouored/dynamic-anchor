#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dynamic Anchor — Motor de Rosto (experimental)

Detecta rostos com YuNet (OpenCV, licença MIT), segue um único alvo ao longo do
take e grava um trajeto que o painel Dynamic Anchor importa em
"Mais ferramentas > Importar trajeto do motor de rosto".

Princípios (iguais aos do plugin):
- Não inventa movimento: lacunas curtas são interpoladas entre detecções reais;
  lacunas longas encerram o trecho acompanhado.
- Não troca de pessoa por suposição: candidatos ambíguos são descartados.
- Não altera vídeo, projeto ou máscaras. Só lê o vídeo e grava um JSON.

Uso típico (pedido gerado pelo painel):
    python anchor_rosto.py --pedido "Anchor-pedido-rosto.json"

Uso manual:
    python anchor_rosto.py --video take.mp4 --inicio 12.5 --fim 20 \
        --fps-sequencia 59.94 --resolucao 3840x2160 --saida trajeto.json
"""
import argparse
import json
import math
import os
import queue
import sys
import threading
import time
import anchor_dense as Dense
import anchor_sampling as Sampling

# Silencia avisos internos do OpenCV 5 (ex.: "Targets are not supported by the
# new graph engine"), que não afetam o resultado. Erros continuam visíveis.
os.environ.setdefault('OPENCV_LOG_LEVEL', 'ERROR')

try:
    import numpy as np
    import cv2
except ImportError:  # pragma: no cover - mensagem para o usuário final
    sys.stderr.write('Faltam bibliotecas. Rode instalar.bat (ou: python -m pip install opencv-python numpy).\n')
    sys.exit(3)

MAX_THREADS_OPENCV = 12


def _limitar_threads_opencv(cv2_module, max_threads=MAX_THREADS_OPENCV):
    """Cap a global OpenCV pool once at import, before models/workers exist."""
    current = int(cv2_module.getNumThreads())
    if current > max_threads:
        cv2_module.setNumThreads(max_threads)
    return int(cv2_module.getNumThreads())


# Global OpenCV settings are not changed per request: the HTTP service may
# process requests concurrently. Apply the tested host cap exactly once here.
OPENCV_THREADS_AT_STARTUP = _limitar_threads_opencv(cv2)

VERSAO_MOTOR = '0.5.4'
# Epoch do RESULTADO, separado da versão empacotada e da execução paralela.
# BUMPAR o epoch correspondente sempre que modelo, pixels/pré-processamento,
# detecção, associação, interpolação, grade ou referência mudarem os dados.
# Caixa mantém o algoritmo legado0.3.2; média5 preserva seu namespace0.3.5/v2.
# 0.5.1: a associação ganhou a guarda de identidade (outras pessoas vistas junto com o alvo,
# aparência com a cabeça). Todas as referências usam o Rastreador: nenhum cache antigo vale.
EPOCAS_ANALISE = {k: v + '+identity-guard-0.5.1' for k, v in {
    'caixa': '0.4.3-box-linear-v1', 'media5': '0.4.3-mean5-linear-v1', 'video15': '0.4.3',
    'adaptativo': '0.4.4-guarded-handoff-v1', 'cabeca': '0.4.4-cap-reacquisition-handoff-v1+deshake-v1'}.items()}
VERSAO_INSTRUMENTACAO = 1
EPOCAS_ANALISE['cabeca'] += '+instance-crop-separation-v1'
EPOCAS_ANALISE['cabeca'] += '+face-reference-fallback-0.5.3'
EPOCAS_ANALISE['cabeca'] += '+head-top-reference-0.5.4'
FORMATO = 'anchor-face-track'
MOTOR = 'face-yunet-v1'
PASTA = os.path.dirname(os.path.abspath(__file__))
def _modelo():
    nome = 'face_detection_yunet_2023mar.onnx'
    for base in (PASTA, getattr(sys, '_MEIPASS', None), os.path.dirname(os.path.abspath(sys.executable))):
        if base and os.path.isfile(os.path.join(base, nome)):
            return os.path.join(base, nome)
    return os.path.join(PASTA, nome)


MODELO = _modelo()


class ErroMotor(Exception):
    pass


class Cronometro:
    """Soma o tempo de parede por etapa (time.perf_counter). Só observa."""
    ETAPAS = ('abrir', 'posicionar', 'grab', 'retrieve', 'redimensionar', 'yunet', 'mediapipe', 'aparencia',
              'rastreio', 'previa', 'pos', 'espera_deteccao', 'espera_decodificacao')

    def __init__(self, ativo=True):
        self.ativo = ativo
        self.segundos = dict.fromkeys(self.ETAPAS, 0.0)
        self.vezes = dict.fromkeys(self.ETAPAS, 0)

    def somar(self, etapa, t0):
        if self.ativo:
            self.segundos[etapa] += time.perf_counter() - t0
            self.vezes[etapa] += 1

    def resumo(self, parede, paralelo=False):
        etapas = {e: {'seconds': round(self.segundos[e], 3), 'count': self.vezes[e]} for e in self.ETAPAS}
        # Em paralelo, decodificação e detecção se sobrepõem: a soma das etapas passa do
        # tempo real, e "fora das etapas" não tem sentido (fica 0).
        medido = sum(v for e, v in self.segundos.items() if not e.startswith('espera_'))
        return {'version': VERSAO_INSTRUMENTACAO, 'wallSeconds': round(parede, 3), 'stages': etapas, 'parallel': bool(paralelo),
                'unaccountedSeconds': 0.0 if paralelo else round(max(0.0, parede - medido), 3)}


SEM_CRONOMETRO = Cronometro(False)

_ACELERACOES = {}
for _nome in ('NONE', 'ANY', 'D3D11', 'VAAPI', 'MFX', 'DRM'):
    if hasattr(cv2, 'VIDEO_ACCELERATION_' + _nome):
        _ACELERACOES[int(getattr(cv2, 'VIDEO_ACCELERATION_' + _nome))] = _nome.lower()


def _fourcc(cap):
    try:
        v = int(cap.get(cv2.CAP_PROP_FOURCC))
    except Exception:
        return None
    if v <= 0:
        return None
    texto = ''.join(chr((v >> 8 * i) & 0xFF) for i in range(4))
    return texto if texto.isprintable() and texto.strip() else str(v)


def info_ambiente():
    """O que este OpenCV oferece de fato (não promete uso de GPU)."""
    info = {'opencv': cv2.__version__, 'opencvThreads': int(cv2.getNumThreads()), 'cpus': os.cpu_count()}
    try:
        info['openclAvailable'] = bool(cv2.ocl.haveOpenCL())
        info['openclInUse'] = bool(cv2.ocl.useOpenCL())
    except Exception:
        info['openclAvailable'] = info['openclInUse'] = None
    try:
        info['cudaDevices'] = int(cv2.cuda.getCudaEnabledDeviceCount())
    except Exception:
        info['cudaDevices'] = 0
    # FaceDetectorYN é criado com backend/target padrão do DNN = CPU.
    info['detectorBackend'] = 'opencv-dnn-cpu'
    return info


# ---------------------------------------------------------------- vídeo ----

def caminho_curto(caminho):
    """No Windows, alguns builds do OpenCV não abrem caminhos com acentos
    (ex.: uma pasta com acento no nome). O nome curto 8.3 do mesmo arquivo contorna isso."""
    if os.name != 'nt':
        return caminho
    try:
        caminho.encode('ascii')
        return caminho
    except UnicodeEncodeError:
        pass
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.kernel32.GetShortPathNameW(caminho, buf, 32768):
            return buf.value
    except Exception:
        pass
    return caminho


def abrir_video(caminho, aceleracao=True):
    cap, fps, largura, altura, _ = abrir_video_info(caminho, aceleracao)
    return cap, fps, largura, altura


def abrir_video_info(caminho, aceleracao=True):
    """Como abrir_video, mais o que foi usado de fato: backend, codec e aceleração lida de volta."""
    if not caminho or not os.path.isfile(caminho):
        raise ErroMotor('Vídeo não encontrado: %s' % caminho)
    caminho = caminho_curto(os.path.abspath(caminho))
    cap = None
    pedida = bool(aceleracao and hasattr(cv2, 'CAP_PROP_HW_ACCELERATION'))
    reserva = False
    if pedida:
        try:
            cap = cv2.VideoCapture(caminho, cv2.CAP_FFMPEG,
                                   [cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_ANY])
        except Exception:
            cap = None
    if cap is None or not cap.isOpened():
        reserva = pedida
        cap = cv2.VideoCapture(caminho)
    if not cap.isOpened():
        raise ErroMotor('O OpenCV não conseguiu abrir o vídeo (codec ou arquivo incompatível).')
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    largura = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    altura = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if not (fps > 1 and largura > 0 and altura > 0):
        raise ErroMotor('Não foi possível ler FPS e resolução do vídeo.')
    info = {'width': largura, 'height': altura, 'fps': round(fps, 5), 'codec': _fourcc(cap),
            'accelerationRequested': 'any' if pedida else 'none', 'fallbackOpen': reserva}
    try:
        info['backend'] = cap.getBackendName()
    except Exception:
        info['backend'] = None
    if hasattr(cv2, 'CAP_PROP_HW_ACCELERATION'):
        try:
            v = int(cap.get(cv2.CAP_PROP_HW_ACCELERATION))
            info['acceleration'] = _ACELERACOES.get(v, str(v))
            info['accelerationDevice'] = int(cap.get(cv2.CAP_PROP_HW_DEVICE))
        except Exception:
            info['acceleration'] = None
    else:
        info['acceleration'] = None
    from anchor_video_reader import maybe_select
    return maybe_select(caminho, cap, fps, largura, altura, info)


def _retrieve_buffer_for_analysis(width, height):
    """Reusable full-resolution destination only when reduction owns its output."""
    return np.empty((height, width, 3), dtype=np.uint8) if width > 960 else None


def _retrieve_frame(cap, buffer=None):
    """Retrieve a valid BGR frame, whether or not the backend uses the destination."""
    if buffer is None:
        return cap.retrieve()
    ok, image = cap.retrieve(buffer)
    if not ok:
        return ok, image
    if (not isinstance(image, np.ndarray) or image.shape != buffer.shape
            or image.dtype != buffer.dtype or not image.flags.c_contiguous):
        raise ErroMotor('VideoCapture.retrieve retornou quadro BGR incompatível com o buffer.')
    return ok, image


def quadros(cap, fps, inicio, fim, precisa_imagem, crono=SEM_CRONOMETRO, strict_pts=False,
            retrieve_buffer=None):
    """Gera (tempo_midia, imagem|None) para cada quadro com inicio <= t < fim.

    O tempo vem do próprio decodificador (POS_MSEC), não de uma contagem
    presumida, para que o trajeto fique preso aos quadros reais da mídia.
    """
    meio = 0.5 / fps
    if inicio > 1.0:
        t0 = time.perf_counter()
        cap.set(cv2.CAP_PROP_POS_MSEC, (inicio - 1.0) * 1000.0)
        crono.somar('posicionar', t0)
    anterior = None
    while True:
        t0 = time.perf_counter()
        pegou = cap.grab()
        crono.somar('grab', t0)
        if not pegou:
            return
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if strict_pts:
            if not math.isfinite(t) or t < 0 or (anterior is not None and t <= anterior + 1e-6):
                # PTS inválido não é sintetizado para VIDEO. Antes da seleção
                # ainda podemos ignorar o pre-roll; dentro dela vira amostra perdida.
                if anterior is None or anterior < inicio - 1.5 / fps:
                    continue
                t = None
            else:
                anterior = t
        else:
            if anterior is not None and t <= anterior + 1e-6:
                # Alguns contêineres repetem o carimbo; deduz do quadro anterior.
                t = anterior + 1.0 / fps
            anterior = t
        if t is None:
            imagem = None
            if precisa_imagem(t):
                t0 = time.perf_counter()
                ok, imagem = _retrieve_frame(cap, retrieve_buffer)
                crono.somar('retrieve', t0)
                if not ok:
                    raise ErroMotor('Falha ao decodificar quadro com PTS inválido em video15.')
            yield None, imagem
            continue
        if t < inicio - meio:
            continue
        # VIDEO consumes a ceil-sized frame grid. A half-frame end cutoff
        # wrongly drops its last slot when the selection ends between frames.
        at_end = (int(round((t - inicio) * fps)) >=
                  int(math.ceil((fim - inicio) * fps - 1e-7))) if strict_pts else t >= fim - meio
        if at_end:
            return
        imagem = None
        if precisa_imagem(t):
            t0 = time.perf_counter()
            ok, imagem = _retrieve_frame(cap, retrieve_buffer)
            crono.somar('retrieve', t0)
            if not ok:
                raise ErroMotor('Falha ao decodificar o quadro em %.3f s.' % t)
        yield t, imagem


# Leitores do mesmo vídeo em paralelo (cada um converte metade dos quadros). Em
# máquinas com poucos núcleos o segundo leitor só disputaria CPU.
DECODIFICADORES = 2 if (os.cpu_count() or 1) >= 12 else 1


def quadros_intercalados(cap, fps, inicio, fim, precisa_n, parte, partes, crono=SEM_CRONOMETRO):
    """quadros() (carimbos não estritos) para um de vários decodificadores do mesmo arquivo.

    Todos posicionam no mesmo ponto e passam (grab) por todos os quadros, com as
    mesmas regras de carimbo e de corte; cada um só decodifica a imagem (retrieve,
    a etapa cara) dos quadros n % partes == parte, onde n conta os quadros do
    trecho como o enumerate() do modo de um decodificador. Gera (n, t, imagem|None)
    só para os quadros da sua parte.
    """
    meio = 0.5 / fps
    if inicio > 1.0:
        t0 = time.perf_counter()
        cap.set(cv2.CAP_PROP_POS_MSEC, (inicio - 1.0) * 1000.0)
        crono.somar('posicionar', t0)
    anterior = None
    n = 0
    while True:
        t0 = time.perf_counter()
        pegou = cap.grab()
        crono.somar('grab', t0)
        if not pegou:
            return
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if anterior is not None and t <= anterior + 1e-6:
            t = anterior + 1.0 / fps
        anterior = t
        if t < inicio - meio:
            continue
        if t >= fim - meio:
            return
        if n % partes == parte:
            imagem = None
            if precisa_n(n, t):
                t0 = time.perf_counter()
                ok, imagem = _retrieve_frame(cap)
                crono.somar('retrieve', t0)
                if not ok:
                    raise ErroMotor('Falha ao decodificar o quadro em %.3f s.' % t)
            yield n, t, imagem
        n += 1


def abrir_decodificadores_extras(fonte, aceleracao, info, quantos):
    """Abre mais leitores do mesmo arquivo. Só servem se lerem exatamente igual ao
    principal (backend, codec, tamanho, FPS e aceleração efetiva); senão, nenhum."""
    extras = []
    chaves = ('backend', 'codec', 'width', 'height', 'fps', 'acceleration')
    try:
        for _ in range(quantos):
            cap, _, _, _, outro = abrir_video_info(fonte, aceleracao)
            extras.append(cap)
            if any(outro.get(k) != info.get(k) for k in chaves):
                raise ErroMotor('leitor extra diferente do principal')
    except Exception:
        for cap in extras:
            cap.release()
        return []
    return extras


def _intercalar(partes):
    """Junta as partes na ordem n = 0, 1, 2... (parte n % len)."""
    iteradores = [iter(p) for p in partes]
    n = 0
    while True:
        item = next(iteradores[n % len(iteradores)], _FIM)
        if item is _FIM:
            return
        if item[0] != n:
            raise ErroMotor('Os leitores do vídeo saíram de sincronia (quadro %d).' % n)
        yield item
        n += 1


# ------------------------------------------------------------- detecção ----

def histograma(hsv, x, y, w, h):
    H, W = hsv.shape[:2]
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(W, int(x + w)), min(H, int(y + h))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    hist = cv2.calcHist([hsv[y0:y1, x0:x1]], [0, 1], None, [18, 8], [0, 180, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return hist


def semelhanca(a, b):
    if a is None or b is None:
        return None
    return 1.0 - float(cv2.compareHist(a, b, cv2.HISTCMP_BHATTACHARYYA))


class Detector:
    def __init__(self, largura_analise, limiar, referencia='caixa'):
        if not os.path.isfile(MODELO):
            raise ErroMotor('Modelo YuNet ausente: %s' % MODELO)
        if not hasattr(cv2, 'FaceDetectorYN'):
            raise ErroMotor('Este OpenCV não tem FaceDetectorYN. Atualize: python -m pip install -U opencv-python')
        self.largura = largura_analise
        self.referencia = referencia
        self.detector = cv2.FaceDetectorYN.create(MODELO, '', (320, 320), limiar, 0.3, 5000)
        self.tamanho = None

    def detectar(self, imagem, escala_x, escala_y, crono=SEM_CRONOMETRO):
        pequeno, f = self.reduzir(imagem, crono)
        return self.detectar_reduzido(pequeno, f, escala_x, escala_y, crono)

    def reduzir(self, imagem, crono=SEM_CRONOMETRO):
        """Imagem de análise (largura <= self.largura). Pode rodar em outra thread."""
        h, w = imagem.shape[:2]
        f = min(1.0, self.largura / float(w))
        t0 = time.perf_counter()
        pequeno = cv2.resize(imagem, (max(1, round(w * f)), max(1, round(h * f))),
                             interpolation=cv2.INTER_AREA) if f < 1.0 else imagem
        crono.somar('redimensionar', t0)
        return pequeno, f

    def detectar_reduzido(self, pequeno, f, escala_x, escala_y, crono=SEM_CRONOMETRO):
        ph, pw = pequeno.shape[:2]
        if self.tamanho != (pw, ph):
            self.detector.setInputSize((pw, ph))
            self.tamanho = (pw, ph)
        t0 = time.perf_counter()
        _, faces = self.detector.detect(pequeno)
        crono.somar('yunet', t0)
        t0 = time.perf_counter()
        hsv = cv2.cvtColor(pequeno, cv2.COLOR_BGR2HSV)
        saida = []
        if faces is None:
            crono.somar('aparencia', t0)
            return saida, pequeno
        k = 1.0 / f
        for linha in faces:
            x, y, bw, bh = [float(v) for v in linha[:4]]
            if bw < 4 or bh < 4:
                continue
            saida.append({
                # coordenadas na resolução de saída (sequência)
                'x': (x + bw / 2) * k * escala_x, 'y': (y + bh / 2) * k * escala_y,
                'w': bw * k * escala_x, 'h': bh * k * escala_y, 'score': float(linha[14]),
                # aparência: rosto, tronco (roupa) e cabeça (cabelo, boné, chapéu: a faixa
                # logo acima da caixa do YuNet, que começa na testa) na imagem de análise
                'rosto': histograma(hsv, x, y, bw, bh),
                'tronco': histograma(hsv, x - bw * 0.5, y + bh * 1.3, bw * 2.0, bh * 2.0),
                'cabeca': histograma(hsv, x - bw * 0.1, y - bh * 0.5, bw * 1.2, bh * 0.6),
                'caixa': (x, y, bw, bh),
            })
            if self.referencia == 'media5':
                try:
                    pontos = np.asarray(linha[4:14], dtype=float).reshape(5, 2)
                except (TypeError, ValueError):
                    raise ErroMotor('Landmarks YuNet ausentes ou inválidos na referência experimental média5.')
                if (not np.isfinite(pontos).all() or np.any(pontos < 0)
                        or np.any(pontos[:, 0] > pw) or np.any(pontos[:, 1] > ph)):
                    raise ErroMotor('Landmark YuNet inválido ou fora da imagem na referência experimental média5.')
                media = pontos.mean(axis=0)
                saida[-1]['trackingPoint'] = {'x': float(media[0]) * k * escala_x,
                                             'y': float(media[1]) * k * escala_y}
        crono.somar('aparencia', t0)
        return saida, pequeno


# ------------------------------------------------------------ associação ----

class Rastreador:
    """Segue um único alvo. Prefere perder o alvo a trocá-lo de pessoa."""

    def __init__(self, modo_alvo, largura, altura, tempo_inicial=None):
        self.modo = modo_alvo
        # Pessoa escolhida no painel num instante do take: o alvo só é assumido a
        # partir desse instante, quando as posições são as que o editor viu.
        self.tempo_inicial = tempo_inicial
        self.W, self.H = largura, altura
        self.ativo = False
        self.c = None
        self.s = None
        self.v = (0.0, 0.0)
        self.t = None
        self.ref_rosto = None
        self.ref_tronco = None
        self.ref_cabeca = None
        self.ambiguos = 0
        self.tempos_ambiguos = []
        # Guarda de identidade (0.5.1). Todo rosto visto no MESMO quadro que o alvo
        # confirmado é outra pessoa: fica acompanhado em self.outros (posição, tamanho e
        # aparência própria) e nunca é assumido como o alvo, nem no reencontro.
        self.outros = []
        self.ap_recente = None
        self.recusas = {'outraPessoa': 0, 'quedaAparencia': 0}
        self.tempos_recusa = []

    PESOS_APARENCIA = (('tronco', 0.45), ('rosto', 0.3), ('cabeca', 0.25))

    @staticmethod
    def comparar(refs, d):
        """Semelhança ponderada entre as referências (tronco, rosto, cabeça) e uma detecção.
        Componentes ausentes (fora da imagem) ficam de fora e os pesos se redistribuem."""
        soma = peso = 0.0
        for nome, w in Rastreador.PESOS_APARENCIA:
            s = semelhanca(refs.get(nome), d.get(nome))
            if s is not None:
                soma += w * s
                peso += w
        return soma / peso if peso else 0.5

    def aparencia(self, d):
        return self.comparar({'tronco': self.ref_tronco, 'rosto': self.ref_rosto, 'cabeca': self.ref_cabeca}, d)

    def _registrar_recusa(self, motivo, t):
        self.recusas[motivo] += 1
        if len(self.tempos_recusa) < 200:
            self.tempos_recusa.append((round(t, 4), motivo))

    def outra_pessoa(self, d, t, ap=None):
        """True se a detecção continua uma das outras pessoas vistas junto com o alvo.

        Exige posição coerente com essa pessoa e aparência pelo menos tão parecida com
        ela quanto com o alvo: um rosto que se parece mais com o alvo não é recusado só
        por estar perto de alguém."""
        if not self.outros:
            return False
        ap = self.aparencia(d) if ap is None else ap
        sd = math.sqrt(d['w'] * d['h'])
        for o in self.outros:
            dt = t - o['t']
            if dt < 0 or dt > self.MEMORIA_OUTROS:
                continue
            razao = max(sd / o['s'], o['s'] / sd)
            dist = math.hypot(d['x'] - o['c'][0], d['y'] - o['c'][1]) / o['s']
            if razao > 1.8 or dist > 0.5 + 2.0 * min(dt, 1.0):
                continue
            if self.comparar(o['refs'], d) >= ap - 0.05:
                return True
        return False

    MEMORIA_OUTROS = 2.0

    @staticmethod
    def sobreposicao(a, b):
        """Interseção das caixas (centro, w, h) sobre a área da menor."""
        ix = min(a['x'] + a['w'] / 2, b['x'] + b['w'] / 2) - max(a['x'] - a['w'] / 2, b['x'] - b['w'] / 2)
        iy = min(a['y'] + a['h'] / 2, b['y'] + b['h'] / 2) - max(a['y'] - a['h'] / 2, b['y'] - b['h'] / 2)
        if ix <= 0 or iy <= 0:
            return 0.0
        return ix * iy / max(1e-6, min(a['w'] * a['h'], b['w'] * b['h']))

    # Caixa que cobre essa fração da caixa do alvo pode ser uma segunda caixa da mesma
    # cabeça (o YuNet às vezes devolve duas num rosto de perfil). Medido na bancada:
    # caixas repetidas cobrem 0,43 a 0,67; pessoas diferentes encostadas, 0 a 0,12.
    SOBREPOSICAO_MESMA_CABECA = 0.25

    def _atualizar_outros(self, deteccoes, alvo, t):
        """Acompanha as outras pessoas. Com o alvo confirmado no quadro, toda outra
        detecção separada dele é outra pessoa (nova ou já conhecida). Sem o alvo, só
        continua quem já era conhecido e está claramente no mesmo lugar: um rosto novo
        pode ser o alvo."""
        livres = [o for o in self.outros if t - o['t'] <= self.MEMORIA_OUTROS]
        if alvo is not None:
            # Uma "outra pessoa" em cima do alvo confirmado era, na verdade, o alvo.
            livres = [o for o in livres if self.sobreposicao(alvo, {'x': o['c'][0], 'y': o['c'][1], 'w': o['s'], 'h': o['s']}) < 0.5]
        usados = set()
        for d in deteccoes:
            if d is alvo:
                continue
            sd = math.sqrt(d['w'] * d['h'])
            if alvo is not None and self.sobreposicao(alvo, d) >= self.SOBREPOSICAO_MESMA_CABECA:
                continue  # possível segunda caixa da cabeça do próprio alvo
            melhor = None
            for i, o in enumerate(livres):
                if i in usados:
                    continue
                dt = max(0.0, t - o['t'])
                razao = max(sd / o['s'], o['s'] / sd)
                dist = math.hypot(d['x'] - o['c'][0], d['y'] - o['c'][1]) / o['s']
                limite = (0.6 + 1.5 * min(dt, 1.0)) if alvo is not None else (0.35 + 1.0 * min(dt, 1.0))
                if razao <= (1.7 if alvo is not None else 1.5) and dist <= limite and (melhor is None or dist < melhor[0]):
                    melhor = (dist, i)
            refs = {k: d.get(k) for k, _ in self.PESOS_APARENCIA}
            if melhor is not None:
                o = livres[melhor[1]]
                usados.add(melhor[1])
                o['c'], o['s'], o['t'] = (d['x'], d['y']), 0.7 * o['s'] + 0.3 * sd, t
                if alvo is not None and d['score'] >= 0.8:
                    for k, v in refs.items():
                        if v is not None:
                            o['refs'][k] = v.copy() if o['refs'].get(k) is None else cv2.addWeighted(o['refs'][k], 0.9, v, 0.1, 0)
            elif alvo is not None:
                livres.append({'c': (d['x'], d['y']), 's': sd, 't': t, 'refs': {k: (v.copy() if v is not None else None) for k, v in refs.items()}})
                usados.add(len(livres) - 1)
        self.outros = livres

    def escolher_inicial(self, deteccoes):
        if not deteccoes:
            return None
        if self.modo == 'maior':
            return max(deteccoes, key=lambda d: d['w'] * d['h'])
        if self.modo == 'centro':
            cx, cy = self.W / 2.0, self.H / 2.0
            return min(deteccoes, key=lambda d: math.hypot(d['x'] - cx, d['y'] - cy) / max(1.0, math.sqrt(d['w'] * d['h'])))
        px, py = self.modo
        dentro = [d for d in deteccoes if abs(d['x'] - px) <= d['w'] * 0.75 and abs(d['y'] - py) <= d['h'] * 0.9]
        # Posição escolhida pelo editor: só aceita um rosto sobre esse ponto. Antes,
        # um rosto "perto" (até 3x o tamanho) podia ser assumido no lugar de outra pessoa.
        if not dentro:
            return None
        return min(dentro, key=lambda d: math.hypot(d['x'] - px, d['y'] - py))

    def assumir(self, d, t):
        self.ativo = True
        self.c = (d['x'], d['y'])
        self.s = math.sqrt(d['w'] * d['h'])
        self.v = (0.0, 0.0)
        self.t = t
        self.ref_rosto = d.get('rosto')
        self.ref_tronco = d.get('tronco')
        self.ref_cabeca = d.get('cabeca')
        self.ap_recente = None

    def atualizar(self, deteccoes, t):
        """Devolve a detecção do alvo neste quadro ou None."""
        if not self.ativo:
            if self.tempo_inicial is not None and t < self.tempo_inicial - 1e-3:
                return None
            d = self.escolher_inicial(deteccoes)
            if d is not None:
                self.assumir(d, t)
                self.iniciais = [(x['x'] / self.W, x['y'] / self.H, x is d) for x in deteccoes]
                self._atualizar_outros(deteccoes, d, t)
            return d
        if not deteccoes:
            return None
        d = self._associar(deteccoes, t)
        self._atualizar_outros(deteccoes, d, t)
        return d

    def _associar(self, deteccoes, t):
        dt = max(1e-6, t - self.t)
        dtv = min(dt, 0.5)
        px, py = self.c[0] + self.v[0] * dtv, self.c[1] + self.v[1] * dtv
        perdido = dt > 0.35
        portao = self.s * (0.6 + 2.0 * min(dt, 1.0))
        opcoes = []
        for d in deteccoes:
            sd = math.sqrt(d['w'] * d['h'])
            razao = max(sd / self.s, self.s / sd)
            dist = math.hypot(d['x'] - px, d['y'] - py)
            ap = self.aparencia(d)
            if perdido:
                # Reencontro: exige aparência parecida, tolera posição distante.
                if ap < 0.55 or razao > 2.2:
                    continue
            elif dist > portao or razao > 1.7:
                continue
            # Guarda de identidade: quem já foi visto junto com o alvo é outra pessoa.
            if self.outra_pessoa(d, t, ap):
                self._registrar_recusa('outraPessoa', t)
                continue
            # Queda brusca de aparência (rosto, roupa e cabeça juntos) em relação ao que
            # o alvo vinha mostrando: outra pessoa entrou onde o alvo estava. Prefere perder.
            if self.ap_recente is not None and ap < min(0.6, self.ap_recente - (0.25 if perdido else 0.2)):
                self._registrar_recusa('quedaAparencia', t)
                continue
            custo = dist / self.s + 1.5 * (1.0 - ap) + 0.8 * abs(math.log(razao))
            opcoes.append((custo, ap, d))
        if not opcoes:
            return None
        opcoes.sort(key=lambda o: o[0])
        melhor = opcoes[0]
        if len(opcoes) > 1:
            segundo = opcoes[1]
            if segundo[0] - melhor[0] < 0.25 and melhor[1] - segundo[1] < 0.15:
                self.ambiguos += 1
                if len(self.tempos_ambiguos) < 200:
                    self.tempos_ambiguos.append(round(t, 4))
                return None
        d = melhor[2]
        nc = (d['x'], d['y'])
        if dt <= 0.5:
            nv = ((nc[0] - self.c[0]) / dt, (nc[1] - self.c[1]) / dt)
            self.v = (0.5 * self.v[0] + 0.5 * nv[0], 0.5 * self.v[1] + 0.5 * nv[1])
        else:
            self.v = (0.0, 0.0)
        self.c = nc
        self.s = 0.7 * self.s + 0.3 * math.sqrt(d['w'] * d['h'])
        self.t = t
        self.ap_recente = melhor[1] if self.ap_recente is None else 0.8 * self.ap_recente + 0.2 * melhor[1]
        if d['score'] >= 0.8 and melhor[1] >= 0.6:
            for nome in ('rosto', 'tronco', 'cabeca'):
                novo = d.get(nome)
                ref = getattr(self, 'ref_' + nome)
                if novo is not None:
                    setattr(self, 'ref_' + nome, novo.copy() if ref is None else cv2.addWeighted(ref, 0.95, novo, 0.05, 0))
        return d


# ------------------------------------------------------- pós-processamento ----

def _ponto_referencia(valor):
    """Ponto obrigatório no modo experimental; nunca substitui pela caixa."""
    if (not isinstance(valor, dict) or any(isinstance(valor.get(e), bool)
            or not isinstance(valor.get(e), (int, float)) or not math.isfinite(valor[e]) for e in ('x', 'y'))):
        raise ErroMotor('Ponto dos landmarks ausente ou inválido na referência experimental média5.')
    return {'x': valor['x'], 'y': valor['y']}


_VIDEO15_SAMPLE_BOX_FIELDS = ('x', 'y', 'w', 'h', 'score')


def _compactar_box_amostra_video15(deteccao):
    """Retain serialized box scalars after association, not per-frame appearance histograms."""
    return {field: deteccao[field] for field in _VIDEO15_SAMPLE_BOX_FIELDS}


def _video15_resultado(pedido, o, cap, fps, vw, vh, W, H, info_video, sx, sy,
                       progresso, cancelado, informar, medir, crono, relogio_total, cpu_total):
    """VIDEO + MM15 path; optional bounded producer overlaps decode/resize only."""
    inicio, fim = float(pedido['inPoint']), float(pedido['outPoint'])
    fps_seq = float(pedido.get('fps') or fps)
    if abs(fps - fps_seq) > max(1e-5, fps_seq * 1e-6):
        raise ErroMotor('video15 exige FPS da mídia igual ao FPS da sequência.')
    if abs(vw / float(vh) - W / float(H)) > 1e-6:
        raise ErroMotor('video15 exige a mesma proporção entre mídia e sequência.')
    if vw < 960:
        raise ErroMotor('video15 exige mídia original com pelo menos 960 px de largura.')
    if Dense.capability() is not True:
        detail = Dense.capability_detail()
        raise ErroMotor('video15 indisponível: runtime/modelo não verificado (%s).' % detail.get('reason', 'indisponível'))

    passo = 1 if o['passo'] == 'auto' else o['passo']
    # Fixed scheduling has no inference feedback shared with the decoder.
    parallel = bool(o['paralelo'])
    alvo = interpretar_alvo(o['alvo'], W, H) if isinstance(o['alvo'], str) else tuple(o['alvo'])
    info_video.update({'source': 'original', 'fileName': os.path.basename(pedido['mediaPath']),
                       'analysisWidth': 960, 'step': passo, 'stepMode': 'fixo',
                       # Execution provenance; cache hits keep the original analysis stats.
                       'previewVideo': False, 'pipeline': parallel, 'reference': 'video15'})
    info_video.update(info_ambiente())
    if informar is not None:
        informar(dict(info_video))
    detector = Detector(960, o['limiar'])
    rastreador = Rastreador(alvo, W, H)
    session = None
    samples, reasons = {}, {}
    expected = max(0, int(math.ceil((fim - inicio) * fps_seq - 1e-7)))
    last_index = -1
    alignment = None
    decoder_count = analyzed_count = recovered_count = 0
    planned_skips = set()
    previous = None
    last_progress = 0.0
    t_start, cpu_start = time.perf_counter(), time.process_time()
    produtor = None

    retrieve_buffer = None

    def needs_image(pts):
        if pts is None:
            return True
        idx = int(round((pts - inicio) * fps_seq))
        # Fixed stride is a user choice: no hidden warm-up or adaptive reads.
        if idx % passo == 0:
            return True
        planned_skips.add(idx)
        return False

    def preparados():
        # Capture/PTS/resize have one owner. Inference remains on the consumer.
        for pts, image in quadros(cap, fps, inicio, fim, needs_image, crono,
                                  strict_pts=True, retrieve_buffer=retrieve_buffer):
            if pts is None or image is None:
                yield pts, None, None
                continue
            reduced, factor = detector.reduzir(image, crono)
            if retrieve_buffer is not None and np.shares_memory(reduced, retrieve_buffer):
                raise ErroMotor('Resize video15 retornou uma vista do buffer de captura reutilizado.')
            yield pts, reduced, factor

    try:
        # Keep allocation inside the resource-cleanup boundary: even MemoryError
        # must release the caller-owned capture if this helper is invoked directly.
        # Reuse is safe only when reduction creates an independent queued image.
        retrieve_buffer = _retrieve_buffer_for_analysis(vw, vh)
        session = Dense.create_video15_session(cv2, W, H)
        quadros_prontos = preparados()
        produtor = _Produtor(quadros_prontos, crono) if parallel else None
        for pts, image, factor in (produtor if produtor is not None else quadros_prontos):
            if cancelado is not None and cancelado():
                raise Cancelado('Análise cancelada.')
            decoder_count += 1
            if pts is None:
                idx = last_index + 1
                if idx < expected:
                    reasons.setdefault(idx, 'invalid-timestamp')
                    last_index = idx
                continue
            idx = int(round((pts - inicio) * fps_seq))
            if idx < 0:
                continue
            if idx >= expected:
                continue
            grid_time = inicio + idx / fps_seq
            if abs(pts - grid_time) > 0.5 / fps_seq + 1e-6 or idx <= last_index:
                reasons.setdefault(max(0, last_index + 1), 'invalid-timestamp')
                last_index = max(last_index, idx)
                continue
            for gap in range(last_index + 1, idx):
                if gap < expected:
                    reasons.setdefault(gap, 'decoder-gap')
            last_index = idx
            if image is None:
                if idx not in planned_skips:
                    reasons[idx] = 'decoder-gap'
                continue
            analyzed_count += 1
            if image.shape[1] != 960:
                raise ErroMotor('video15 exige imagem de análise com exatamente 960 px de largura.')
            detections, _ = detector.detectar_reduzido(image, factor, sx, sy, crono)
            t0 = time.perf_counter()
            selected = rastreador.atualizar(detections, pts)
            crono.somar('rastreio', t0)
            t0 = time.perf_counter()
            mp_sample, mp_reason = session.detect(image, pts, selected)
            crono.somar('mediapipe', t0)
            reason, recovered = Sampling.associate(detections, selected, mp_sample,
                                                    previous, pts, initial=idx == 0)
            if reason == 'mediapipe-missing':
                reason = mp_reason or reason
            if reason is not None:
                reasons[idx] = reason
                if idx == 0:
                    raise ErroMotor('video15 exige YuNet selecionado e ambos os cantos MediaPipe contidos no primeiro quadro.')
            else:
                midpoint = mp_sample['midpoint']
                if idx == 0:
                    alignment = {'raw': midpoint, 'box': {'x': selected['x'], 'y': selected['y']}, 'pts': pts}
                    offset = {'x': selected['x'] - midpoint['x'], 'y': selected['y'] - midpoint['y']}
                    if any(not math.isfinite(v) or abs(v) > max(W, H) for v in offset.values()):
                        raise ErroMotor('video15 não conseguiu calibrar o offset no primeiro quadro.')
                if alignment is None:
                    raise ErroMotor('video15 perdeu a calibração inicial.')
                offset = {'x': alignment['box']['x'] - alignment['raw']['x'],
                          'y': alignment['box']['y'] - alignment['raw']['y']}
                samples[idx] = {'rawPoint': midpoint,
                                'point': {'x': midpoint['x'] + offset['x'], 'y': midpoint['y'] + offset['y']},
                                'box': _compactar_box_amostra_video15(selected),
                                'time': grid_time, 'sourceTime': pts}
                recovered_count += int(recovered)
                previous = dict(samples[idx], index=idx)
            now = time.time()
            if progresso is not None and (now - last_progress > 0.4 or idx == expected - 1):
                last_progress = now
                elapsed_progress = max(1e-6, time.perf_counter() - t_start)
                progresso(min(1.0, (idx + 1) / max(1, expected)), idx + 1, decoder_count / elapsed_progress)
        if alignment is None:
            raise ErroMotor('video15 não encontrou referência válida no primeiro quadro do trecho.')
    finally:
        try:
            if produtor is not None:
                produtor.fechar()
        finally:
            try:
                if session is not None:
                    session.close()
            finally:
                cap.release()

    if 0 not in samples:
        raise ErroMotor('video15 exige uma medição válida no primeiro quadro do trecho.')
    measured_count = len(samples)
    samples, interpolated = Sampling.reconstruct(samples, planned_skips, reasons, passo)
    for idx in range(expected):
        if idx not in samples:
            reasons.setdefault(idx, 'sampling-gap' if idx in planned_skips else 'decoder-gap')
    runs, run = [], []
    for idx in sorted(samples):
        if run and idx != run[-1] + 1:
            runs.append(run)
            run = []
        run.append(idx)
    if run:
        runs.append(run)
    kept = [r for r in runs if len(r) >= 2]
    if not kept:
        raise ErroMotor('video15 não encontrou corrida contínua de pelo menos dois quadros.')
    primary = max(kept, key=lambda r: (len(r), -r[0]))
    offset = {'x': alignment['box']['x'] - alignment['raw']['x'],
              'y': alignment['box']['y'] - alignment['raw']['y']}
    tracking_reference = Dense.reference(offset, alignment['raw'], alignment['box'], alignment['pts'], step=passo)
    serialized_runs = []
    primary_rows = []
    for indices in kept:
        unsmoothed = [samples[i]['point'] for i in indices]
        smooth = Dense.centered_mean(unsmoothed, radius=7)
        smooth = Sampling.correct_drift(smooth, [samples[i]['box'] for i in indices], fps_seq,
                                       [samples[i].get('source') != 'sampled' for i in indices])
        rows = []
        for idx, tracking in zip(indices, smooth):
            sample = samples[idx]
            box = sample['box']
            rows.append({'time': sample['time'], 'x': box['x'], 'y': box['y'],
                         'width': box['w'], 'height': box['h'], 'confidence': box['score'],
                         'source': sample.get('source', 'detected'), 'trackingPoint': tracking})
        is_primary = indices is primary
        if is_primary:
            primary_rows = rows
        serialized_runs.append({'start': inicio + indices[0] / fps_seq,
                                'end': inicio + indices[-1] / fps_seq,
                                'samples': len(rows), 'primary': is_primary,
                                'rows': [] if is_primary else rows})
    missing = [{'frame': idx, 'time': inicio + idx / fps_seq, 'reason': reasons[idx]}
               for idx in sorted(set(range(expected)) - set(samples))]
    unretained = [r[0] for r in runs if len(r) == 1]
    coverage = len(primary_rows) / float(expected) if expected else 0.0
    elapsed = max(1e-6, time.perf_counter() - t_start)
    cpu_elapsed = time.process_time() - cpu_start
    quality = medir_qualidade(primary_rows, fps_seq, rastreador.tempos_ambiguos)
    wall = time.perf_counter() - relogio_total
    cpu = time.process_time() - cpu_total
    return {'format': FORMATO, 'version': 2, 'engine': MOTOR, 'engineVersion': VERSAO_MOTOR,
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S'), 'requestId': pedido.get('requestId'),
            'fileName': os.path.basename(pedido['mediaPath']), 'mediaPath': os.path.abspath(pedido['mediaPath']),
            'analysisSource': 'original', 'width': W, 'height': H, 'fps': fps_seq, 'mediaFps': fps,
            'inPoint': inicio, 'outPoint': fim, 'selection': pedido.get('selection'),
            'target': o['alvo'] if isinstance(o['alvo'], str) else list(o['alvo']),
            'initialFaces': [{'x': round(x, 4), 'y': round(y, 4), 'chosen': c}
                             for x, y, c in sorted(getattr(rastreador, 'iniciais', []))],
            'coverage': coverage, 'warnings': ['video15 registra perdas sem preenchimento; somente corridas contíguas são exportadas.'] if missing else [],
            'quality': quality,
            'stats': {'decodedFrames': decoder_count, 'analyzedFrames': analyzed_count,
                      'detectedFrames': measured_count, 'ambiguousFrames': rastreador.ambiguos,
                      'segments': len(serialized_runs), 'interpolatedRows': len(interpolated),
                      'associationRecoveredFrames': recovered_count,
                      'targetCropFrames': getattr(session, 'target_crop_frames', 0),
                      'seconds': round(elapsed, 2), 'framesPerSecond': round(decoder_count / elapsed, 1),
                      'step': passo, 'analysisWidth': 960,
                      'timing': crono.resumo(wall, parallel) if medir else None,
                      'cpu': {'processSeconds': round(cpu, 3), 'wallSeconds': round(wall, 3),
                              'ratio': round(cpu / max(1e-6, wall), 2)} if medir else None,
                      'video': info_video},
            'segments': serialized_runs, 'rows': primary_rows,
            'trackingReference': tracking_reference,
            'referenceCoverage': {'expectedFrames': expected, 'measuredFrames': measured_count,
                                  'missing': missing, 'unretainedFrames': unretained,
                                  'interpolatedFrames': interpolated}}


def _interpolar_referencia(a, b, u):
    a, b = _ponto_referencia(a), _ponto_referencia(b)
    return {e: a[e] + (b[e] - a[e]) * u for e in ('x', 'y')}


def montar_segmentos(amostras, max_lacuna, referencia='caixa'):
    """amostras: lista ordenada de dicts com t e det (ou None).
    Interpola lacunas curtas entre detecções reais e corta nas longas."""
    idx = [i for i, a in enumerate(amostras) if a['det'] is not None]
    segmentos = []
    atual = None
    for n, i in enumerate(idx):
        a = amostras[i]
        ponto = {'t': a['t'], 'x': a['det']['x'], 'y': a['det']['y'], 'w': a['det']['w'], 'h': a['det']['h'],
                 'conf': a['det']['score'], 'origem': 'fluxo' if a['det'].get('trackingMethod') == 'flow' else 'deteccao'}
        if referencia in ('media5','adaptativo'):
            ponto['trackingPoint'] = _ponto_referencia(a['det'].get('trackingPoint'))
        if atual is None:
            atual = [ponto]
            continue
        j = idx[n - 1]
        anterior = amostras[j]
        if a['t'] - anterior['t'] <= max_lacuna + 1e-9:
            p0 = atual[-1]
            for k in range(j + 1, i):
                u = (amostras[k]['t'] - anterior['t']) / (a['t'] - anterior['t'])
                atual.append({'t': amostras[k]['t'],
                              'x': p0['x'] + (ponto['x'] - p0['x']) * u, 'y': p0['y'] + (ponto['y'] - p0['y']) * u,
                              'w': p0['w'] + (ponto['w'] - p0['w']) * u, 'h': p0['h'] + (ponto['h'] - p0['h']) * u,
                              'conf': min(p0['conf'], ponto['conf']), 'origem': 'interpolado'})
                if referencia in ('media5','adaptativo'):
                    atual[-1]['trackingPoint'] = _interpolar_referencia(p0.get('trackingPoint'), ponto.get('trackingPoint'), u)
            atual.append(ponto)
        else:
            segmentos.append(atual)
            atual = [ponto]
    if atual:
        segmentos.append(atual)
    return [s for s in segmentos if len(s) >= 2]


def reamostrar(segmento, inicio, fim, fps_seq, fps_midia=None, referencia='caixa'):
    """Leva o trecho para a grade de quadros da sequência: inicio + k/fps."""
    if referencia in ('media5','adaptativo'):
        for ponto in segmento:
            _ponto_referencia(ponto.get('trackingPoint'))
    # Meio quadro de tolerância nas bordas: o quadro da mídia mais próximo
    # representa o instante da grade (sem extrapolar movimento).
    meio = 0.5 / fps_seq
    # No fim, o último quadro da mídia continua na tela por 1/fps_midia: numa
    # sequência com FPS maior (29,97 em 59,94), os quadros da grade nesse intervalo
    # mostram a MESMA imagem detectada. Manter o valor dela não inventa movimento.
    fim_quadro = 1.0 / fps_midia if fps_midia and fps_midia > 0 else 0.0
    # (estritamente antes do próximo quadro da mídia, que já é outra imagem)
    t0, t1 = segmento[0]['t'] - meio, segmento[-1]['t'] + max(meio, fim_quadro - 3e-6) - 1e-9
    k0 = max(0, math.ceil((t0 - inicio) * fps_seq - 1e-6))
    linhas = []
    j = 0
    k = k0
    while True:
        tg = inicio + k / fps_seq
        if tg > t1 + 1e-6 or tg >= fim - 1e-7:
            break
        while j + 1 < len(segmento) and segmento[j + 1]['t'] < tg - 1e-9:
            j += 1
        a = segmento[j]
        b = segmento[min(j + 1, len(segmento) - 1)]
        if tg >= b['t']:
            u = 1.0
        elif b['t'] <= a['t'] + 1e-12 or tg <= a['t']:
            u = 0.0
        else:
            u = min(1.0, (tg - a['t']) / (b['t'] - a['t']))
        pr = b if u > 0.5 else a
        linhas.append({
            'time': round(tg, 9),
            'x': a['x'] + (b['x'] - a['x']) * u, 'y': a['y'] + (b['y'] - a['y']) * u,
            'width': a['w'] + (b['w'] - a['w']) * u, 'height': a['h'] + (b['h'] - a['h']) * u,
            'confidence': round(min(a['conf'], b['conf']), 4),
            'source': ({'fluxo': 'tracked', 'deteccao': 'detected'}.get(pr['origem'], 'interpolated')
                       if min(abs(tg-a['t']),abs(tg-b['t'])) < 1e-6 else 'interpolated')
                      if referencia == 'adaptativo' else 'detected' if pr['origem'] == 'deteccao' else 'interpolated',
        })
        if referencia in ('media5','adaptativo'):
            linhas[-1]['trackingPoint'] = _interpolar_referencia(a.get('trackingPoint'), b.get('trackingPoint'), u)
        k += 1
    return linhas


# ------------------------------------------------------------------ main ----

def ler_pedido(caminho):
    try:
        with open(caminho, 'r', encoding='utf-8-sig') as f:
            pedido = json.load(f)
    except OSError as erro:
        raise ErroMotor('Não foi possível abrir o pedido: %s' % erro)
    except ValueError:
        raise ErroMotor('O pedido não é um JSON válido.')
    if pedido.get('format') != 'anchor-face-job' or pedido.get('version') != 1:
        raise ErroMotor('Pedido inválido: gere-o pelo painel Dynamic Anchor.')
    for chave in ('inPoint', 'outPoint', 'width', 'height', 'fps'):
        if not isinstance(pedido.get(chave), (int, float)):
            raise ErroMotor('Pedido sem o campo %s.' % chave)
    return pedido


def interpretar_alvo(texto, W, H):
    if texto in ('maior', 'centro'):
        return texto
    try:
        x, y = [float(v) for v in texto.replace(';', ',').split(',')]
    except ValueError:
        raise ErroMotor('Use --alvo maior, centro ou X,Y (0–1 ou pixels).')
    if 0 <= x <= 1 and 0 <= y <= 1:
        x, y = x * W, y * H
    return (x, y)


def _trechos(linhas, condicao, fps, minimo):
    """Intervalos (tempo da mídia) em que condicao(linha) vale por >= minimo s."""
    saida, inicio, anterior = [], None, None
    for r in linhas:
        if condicao(r):
            if inicio is None:
                inicio = r['time']
            anterior = r['time']
        elif inicio is not None:
            if anterior - inicio + 1.0 / fps >= minimo:
                saida.append([round(inicio, 4), round(anterior + 1.0 / fps, 4)])
            inicio = None
    if inicio is not None and anterior - inicio + 1.0 / fps >= minimo:
        saida.append([round(inicio, 4), round(anterior + 1.0 / fps, 4)])
    return saida


def medir_qualidade(linhas, fps, ambiguos):
    """Confiança do detector YuNet (não é probabilidade de identidade)."""
    detectadas = [r['confidence'] for r in linhas if r.get('source') == 'detected']
    base = detectadas or [r['confidence'] for r in linhas]
    return {
        'meanConfidence': round(sum(base) / len(base), 4) if base else None,
        'minConfidence': round(min(base), 4) if base else None,
        'detectedRows': len(detectadas),
        'interpolatedRows': sum(1 for r in linhas if r.get('source') == 'interpolated'),
        'lowConfidence': _trechos(linhas, lambda r: r['confidence'] < 0.7, fps, 0.2),
        'interpolatedRuns': _trechos(linhas, lambda r: r.get('source') == 'interpolated', fps, 0.15),
        'ambiguousTimes': list(ambiguos[:200]),
    }


def numerar_rostos(deteccoes, W, H):
    """Rostos ordenados da esquerda para a direita, numerados a partir de 1."""
    # Rostos muito menores que o maior (fotos, telas, figurantes ao fundo)
    # ficam fora da escolha; o rastreamento continua vendo todos.
    # All validated detections remain selectable. A foreground face must not
    # hide the smaller background person explicitly chosen by the editor.
    visiveis = list(deteccoes)
    ordem = sorted(visiveis, key=lambda d: d['x'])
    return [{'id': i + 1, 'x': round(d['x'], 2), 'y': round(d['y'], 2), 'width': round(d['w'], 2), 'height': round(d['h'], 2),
             'score': round(d['score'], 4), 'nx': round(d['x'] / W, 4), 'ny': round(d['y'] / H, 4)} for i, d in enumerate(ordem[:8])]


def rostos_iniciais(pedido, opcoes=None, busca=4.0, intervalo=0.25, largura_imagem=640):
    """Primeiro quadro do take (até `busca` s) em que aparecem rostos.

    Devolve o tempo, os rostos numerados e uma imagem JPEG reduzida com as
    caixas e números, para o editor escolher a pessoa.
    """
    import base64
    o = opcoes_validas(opcoes)
    video = pedido.get('mediaPath')
    proxy = pedido.get('proxyPath') if o['usar_proxy'] else None
    if proxy and not os.path.isfile(proxy):
        proxy = None
    if o['referencia'] == 'video15' and proxy:
        raise ErroMotor('video15 aceita somente a mídia original; desative o uso de proxy.')
    inicio, fim = pedido.get('inPoint'), pedido.get('outPoint')
    if not isinstance(inicio, (int, float)) or not isinstance(fim, (int, float)) or not fim > inicio:
        raise ErroMotor('Intervalo inválido no pedido.')
    cap, fps, vw, vh = abrir_video(proxy or video, o['aceleracao'])
    try:
        # Quadro do vídeo pode ser fracionário (sequência com outra proporção): float, não int.
        W, H = float(pedido.get('width') or vw), float(pedido.get('height') or vh)
        if abs(vw / float(vh) - W / float(H)) > 0.01:
            raise ErroMotor('Proporção do vídeo (%dx%d) diferente da sequência (%dx%d).' % (vw, vh, W, H))
        detector = Detector(o['analise'], o['limiar'])
        sx, sy = W / float(vw), H / float(vh)
        limite = min(fim, inicio + busca)
        proximo = [inicio]

        def precisa(t):
            if t + 0.5 / fps >= proximo[0]:
                proximo[0] = t + intervalo
                return True
            return False

        for t, imagem in quadros(cap, fps, inicio, limite, precisa):
            if imagem is None:
                continue
            deteccoes, pequeno = detector.detectar(imagem, sx, sy)
            if not deteccoes:
                continue
            rostos = numerar_rostos(deteccoes, W, H)
            k = largura_imagem / float(imagem.shape[1])
            mini = cv2.resize(imagem, (largura_imagem, max(1, round(imagem.shape[0] * k))), interpolation=cv2.INTER_AREA)
            ex, ey = mini.shape[1] / float(W), mini.shape[0] / float(H)
            for r in rostos:
                x0, y0 = int((r['x'] - r['width'] / 2) * ex), int((r['y'] - r['height'] / 2) * ey)
                x1, y1 = int((r['x'] + r['width'] / 2) * ex), int((r['y'] + r['height'] / 2) * ey)
                cv2.rectangle(mini, (x0, y0), (x1, y1), (60, 220, 60), 2)
                rotulo = str(r['id'])
                (tw, th), _ = cv2.getTextSize(rotulo, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
                cv2.rectangle(mini, (x0, max(0, y0 - th - 8)), (x0 + tw + 8, y0), (60, 220, 60), -1)
                cv2.putText(mini, rotulo, (x0 + 4, y0 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 20, 20), 2)
            ok, jpeg = cv2.imencode('.jpg', mini, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if not ok:
                raise ErroMotor('Não foi possível gerar a imagem de escolha.')
            return {'time': round(t, 6), 'faces': rostos, 'width': W, 'height': H,
                    'image': {'format': 'jpeg', 'width': mini.shape[1], 'height': mini.shape[0],
                              'base64': base64.b64encode(jpeg.tobytes()).decode('ascii')}}
    finally:
        cap.release()
    return {'time': None, 'faces': [], 'width': W, 'height': H, 'image': None}


class Cancelado(ErroMotor):
    pass


# Padrões equilibrados: rostos de entrevista em 4K/1080p a ~30 detecções/s.
PADROES = {'alvo': 'maior', 'alvo_tempo': None, 'analise': 960, 'passo': 'auto', 'limiar': 0.6, 'lacuna': 0.4,
           'previa': None, 'aceleracao': True, 'usar_proxy': True, 'paralelo': True, 'referencia': 'caixa'}
# Opções que não mudam o resultado (ficam fora da chave do cache).
SO_EXECUCAO = ('previa', 'paralelo')
PERFIS = {'rapido': {'analise': 640}, 'equilibrado': {'analise': 960}, 'preciso': {'analise': 1280, 'passo': 1}}


def opcoes_validas(opcoes):
    o = dict(PADROES)
    perfil = (opcoes or {}).get('perfil')
    if perfil:
        if perfil not in PERFIS:
            raise ErroMotor('Perfil de análise desconhecido: %s' % perfil)
        o.update(PERFIS[perfil])
    for chave, valor in (opcoes or {}).items():
        if chave == 'perfil':
            continue
        if chave not in PADROES:
            raise ErroMotor('Opção desconhecida: %s' % chave)
        o[chave] = valor
    alvo = o['alvo']
    if isinstance(alvo, str):
        if alvo not in ('maior', 'centro') and ',' not in alvo:
            raise ErroMotor('Alvo deve ser maior, centro ou X,Y.')
    elif not (isinstance(alvo, (list, tuple)) and len(alvo) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v == v for v in alvo)):
        raise ErroMotor('Alvo inválido: use [x, y] em pixels da sequência.')
    tempo = o['alvo_tempo']
    if tempo is not None and (isinstance(tempo, bool) or not isinstance(tempo, (int, float)) or tempo != tempo or tempo < 0):
        raise ErroMotor('alvo_tempo inválido: use o tempo da mídia (s) em que a pessoa foi escolhida.')
    if not isinstance(o['analise'], int) or not 240 <= o['analise'] <= 3840:
        raise ErroMotor('Largura de análise fora de 240–3840.')
    if o['passo'] != 'auto' and (isinstance(o['passo'], bool) or not isinstance(o['passo'], int) or not 1 <= o['passo'] <= 8):
        raise ErroMotor('Passo deve ser auto ou 1–8.')
    if not isinstance(o['limiar'], (int, float)) or not 0.3 <= o['limiar'] <= 0.95:
        raise ErroMotor('Limiar fora de 0,3–0,95.')
    if not isinstance(o['lacuna'], (int, float)) or not 0 <= o['lacuna'] <= 2:
        raise ErroMotor('Lacuna fora de 0–2 s.')
    if not isinstance(o['paralelo'], bool):
        raise ErroMotor('paralelo deve ser verdadeiro ou falso.')
    if o['referencia'] not in ('caixa', 'media5', 'video15', 'adaptativo', 'cabeca'):
        raise ErroMotor('Referência deve ser caixa, media5 ou video15 (experimental).')
    if o['referencia'] in ('adaptativo','cabeca') and o['passo'] not in ('auto', 1, 2, 3):
        raise ErroMotor('Referência adaptativa exige passo 1, 2 ou 3.')
    if o['referencia'] == 'video15':
        if o['analise'] != 960:
            raise ErroMotor('video15 exige análise a 960 px.')
        if o['passo'] not in ('auto', 1, 2, 3):
            raise ErroMotor('video15 exige passo 1, 2 ou 3.')
        if o['alvo_tempo'] is not None:
            raise ErroMotor('video15 exige seleção no primeiro quadro do trecho.')
        if o['previa'] is not None:
            raise ErroMotor('video15 não oferece prévia durante a análise.')
    return o


_FIM = object()


class _Produtor:
    """Roda um gerador de quadros (decodificar + reduzir) em outra thread, com fila curta.

    A ordem dos quadros e as operações feitas em cada um são as mesmas do modo
    sequencial: só a decodificação de um quadro passa a acontecer enquanto o
    anterior está no detector. O OpenCV libera o GIL nessas chamadas.
    """

    def __init__(self, gerador, crono, tamanho=4):
        self.fila = queue.Queue(maxsize=tamanho)
        self.parar = threading.Event()
        self.crono = crono
        self.thread = threading.Thread(target=self._rodar, args=(gerador,), daemon=True)
        self.thread.start()

    def _rodar(self, gerador):
        try:
            for item in gerador:
                t0 = time.perf_counter()
                while not self.parar.is_set():
                    try:
                        self.fila.put(item, timeout=0.1)
                        break
                    except queue.Full:
                        continue
                self.crono.somar('espera_deteccao', t0)
                if self.parar.is_set():
                    return
            self.fila.put(_FIM)
        except BaseException as erro:  # repassa ao consumidor (ex.: falha ao decodificar)
            self.fila.put(('__erro__', erro))

    def __iter__(self):
        while True:
            t0 = time.perf_counter()
            item = self.fila.get()
            self.crono.somar('espera_decodificacao', t0)
            if item is _FIM:
                return
            if isinstance(item, tuple) and len(item) == 2 and item[0] == '__erro__':
                raise item[1]
            yield item

    def fechar(self):
        self.parar.set()
        while self.thread.is_alive():
            try:
                self.fila.get(timeout=0.05)
            except queue.Empty:
                pass
        self.thread.join()



def executar(pedido, opcoes=None, progresso=None, cancelado=None, informar=None, medir=True, _observations=None, _reference_motion="translation", _image_observer=None, _visual_missing_observer=None):
    """Analisa o intervalo do pedido e devolve o trajeto (dict anchor-face-track).

    pedido: mediaPath, inPoint, outPoint e, quando vier do painel, proxyPath,
    width, height, fps, selection e requestId. Não grava arquivos, exceto a
    prévia opcional. progresso(fracao, quadros, quadros_por_segundo) e
    cancelado() são chamados durante a decodificação. informar(dict) é chamado
    uma vez, logo depois de abrir o vídeo, com a fonte, o backend, a aceleração
    lida de volta, o perfil e o passo efetivos. medir=False desliga só o
    cronômetro (o resultado é o mesmo; usado nos testes).
    """
    crono = Cronometro(medir)
    relogio_total, cpu_total = time.perf_counter(), time.process_time()
    o = opcoes_validas(opcoes)
    if o['referencia']=='cabeca':
        from anchor_head import execute_head
        return execute_head(pedido,o,progresso,cancelado,informar,medir)
    video = pedido.get('mediaPath')
    proxy = pedido.get('proxyPath') if o['usar_proxy'] else None
    if proxy and not os.path.isfile(proxy):
        proxy = None
    if not video and not proxy:
        raise ErroMotor('O pedido não trouxe o caminho da mídia.')
    video = video or proxy
    inicio, fim = pedido.get('inPoint'), pedido.get('outPoint')
    if not isinstance(inicio, (int, float)) or not isinstance(fim, (int, float)) or not fim > inicio:
        raise ErroMotor('Intervalo inválido no pedido.')

    fonte = proxy or video
    t0 = time.perf_counter()
    cap, fps, vw, vh, info_video = abrir_video_info(fonte, o['aceleracao'])
    crono.somar('abrir', t0)
    try:
        if pedido.get('width') and pedido.get('height'):
            W, H = float(pedido['width']), float(pedido['height'])
        elif proxy and video != proxy:
            c2, _, W, H = abrir_video(video, False)
            c2.release()
        else:
            W, H = vw, vh
        if abs(vw / float(vh) - W / float(H)) > 0.01:
            raise ErroMotor('Proporção do vídeo (%dx%d) diferente da sequência (%dx%d). Não há conversão automática.' % (vw, vh, W, H))
        fps_seq = pedido.get('fps') or fps
        passo = max(1, round(fps / 30.0)) if o['passo'] == 'auto' else int(o['passo'])
        if o['referencia'] == 'video15':
            return _video15_resultado(pedido, o, cap, fps, vw, vh, W, H, info_video, W / float(vw), H / float(vh),
                                      progresso, cancelado, informar, medir, crono, relogio_total, cpu_total)
        alvo = interpretar_alvo(o['alvo'], W, H) if isinstance(o['alvo'], str) else tuple(o['alvo'])
        sx, sy = W / float(vw), H / float(vh)
        info_video.update({'source': 'proxy' if proxy else 'original', 'fileName': os.path.basename(fonte),
                           'analysisWidth': o['analise'], 'step': passo, 'stepMode': 'auto' if o['passo'] == 'auto' else 'fixo',
                           'previewVideo': bool(o['previa']), 'pipeline': o['paralelo']})
        info_video.update(info_ambiente())
        if informar is not None:
            informar(dict(info_video))

        def novo_detector():
            return (Detector(o['analise'], o['limiar'], referencia='media5') if o['referencia'] == 'media5'
                    else Detector(o['analise'], o['limiar']))

        detector = novo_detector()
        rastreador = Rastreador(alvo, W, H, o['alvo_tempo'] - 0.5 / fps if o['alvo_tempo'] is not None else None)
        adaptive = None
        if o['referencia'] == 'adaptativo':
            from anchor_adaptive import SelectedVisualTrack
            adaptive = SelectedVisualTrack(rastreador, W, H, reference_motion=_reference_motion)
        escritor = None
        amostras = []
        referencia_saida = None
        contador = {'n': 0}
        # O último quadro do take sempre é analisado: com passo > 1 ele poderia
        # ficar depois da última detecção e o trajeto terminaria um quadro antes.
        limite_ultimo = fim - 1.5 / fps

        def analisar(n, t):
            return n % passo == 0 or t >= limite_ultimo

        def precisa(t):
            contador['n'] += 1
            return o['previa'] is not None or analisar(contador['n'] - 1, t)

        def reduzidos():
            # Decodificação + redução: as mesmas operações do modo sequencial, na mesma ordem.
            for n, (t, imagem) in enumerate(quadros(cap, fps, inicio, fim, precisa, crono)):
                detectou = imagem is not None and analisar(n, t)
                pequeno, f = detector.reduzir(imagem, crono) if detectou else (None, None)
                yield n, t, detectou, pequeno, f, imagem if _image_observer is not None else None

        def detectados(fonte, det=detector):
            # YuNet + aparência não dependem do alvo seguido: em paralelo rodam numa
            # etapa própria, entre a decodificação e o rastreio, na mesma ordem.
            for n, t, detectou, pequeno, f, imagem in fonte:
                deteccoes = None
                if detectou:
                    deteccoes, pequeno = det.detectar_reduzido(pequeno, f, sx, sy, crono)
                yield n, t, detectou, pequeno, f, imagem, deteccoes

        def reduzidos_parte(c, parte, partes):
            for n, t, imagem in quadros_intercalados(c, fps, inicio, fim, analisar, parte, partes, crono):
                detectou = imagem is not None and analisar(n, t)
                pequeno, f = detector.reduzir(imagem, crono) if detectou else (None, None)
                yield n, t, detectou, pequeno, f, imagem if _image_observer is not None else None

        produtor = deteccao = None
        partes = []
        etapas = []
        if o['paralelo']:
            # Sem prévia, precisa(t) é analisar(n, t): cada leitor decide sozinho.
            extras = abrir_decodificadores_extras(fonte, o['aceleracao'], info_video, DECODIFICADORES - 1) \
                if DECODIFICADORES > 1 and o['previa'] is None else []
            if extras:
                caps = [cap] + extras
                partes = [_Produtor(reduzidos_parte(c, i, len(caps)), crono, tamanho=3) for i, c in enumerate(caps)]
                # Um detector por leitor: o YuNet não guarda nada de um quadro para o outro.
                etapas = [_Produtor(detectados(p, detector if i == 0 else novo_detector()), crono, tamanho=3)
                          for i, p in enumerate(partes)]
            else:
                produtor = _Produtor(reduzidos(), crono)
                deteccao = _Produtor(detectados(produtor), crono)
            info_video['decoders'] = max(1, len(partes))
        relogio = time.time()
        duracao = fim - inicio
        ultimo_aviso = 0.0
        fluxo = _intercalar(etapas) if etapas else deteccao if deteccao is not None else detectados(reduzidos())
        for n, t, detectou, pequeno, f, imagem_original, deteccoes in fluxo:
            if cancelado is not None and cancelado():
                raise Cancelado('Análise cancelada.')
            det = None
            if detectou:
                t0 = time.perf_counter()
                det = adaptive.update(deteccoes, t, pequeno) if adaptive is not None else rastreador.atualizar(deteccoes, t)
                if det is not None and o['referencia'] == 'media5':
                    ponto_fisico = _ponto_referencia(det.get('trackingPoint'))
                    if not (0 <= ponto_fisico['x'] <= W and 0 <= ponto_fisico['y'] <= H):
                        raise ErroMotor('Ponto dos landmarks fora da resolução de saída na referência experimental média5.')
                    if referencia_saida is None:
                        offset = {'x': det['x'] - ponto_fisico['x'], 'y': det['y'] - ponto_fisico['y']}
                        if (not all(math.isfinite(v) for v in offset.values())
                                or abs(offset['x']) > W or abs(offset['y']) > H):
                            raise ErroMotor('Offset dos landmarks fora da resolução na referência experimental média5.')
                        referencia_saida = {'method': 'yunet-mean5-aligned-v1', 'offset': offset}
                    det['trackingPoint'] = {e: ponto_fisico[e] + referencia_saida['offset'][e] for e in ('x', 'y')}
                crono.somar('rastreio', t0)
                if o['previa']:
                    t0 = time.perf_counter()
                    if escritor is None:
                        previa = os.path.abspath(o['previa'])
                        pasta = caminho_curto(os.path.dirname(previa))
                        escritor = cv2.VideoWriter(os.path.join(pasta, os.path.basename(previa)), cv2.VideoWriter_fourcc(*'mp4v'),
                                                   fps / passo, (pequeno.shape[1], pequeno.shape[0]))
                    quadro = pequeno.copy()
                    for d in deteccoes:
                        x, y, bw, bh = [int(v) for v in d['caixa']]
                        cor = (60, 220, 60) if d is det else (150, 150, 150)
                        cv2.rectangle(quadro, (x, y), (x + bw, y + bh), cor, 3 if d is det else 1)
                    if det is None:
                        cv2.putText(quadro, 'ALVO NAO CONFIRMADO', (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 40, 230), 2)
                    cv2.putText(quadro, '%.3f s' % t, (12, quadro.shape[0] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
                    escritor.write(quadro)
                    crono.somar('previa', t0)
            amostras.append({'t': t, 'det': det, 'analisado': detectou})
            if (_observations is not None or _image_observer is not None) and detectou and det is not None:
                observation = dict(time=t,x=float(det['x']),y=float(det['y']),width=float(det['w']),height=float(det['h']),source='tracked'if det.get('trackingMethod')=='flow'else'detected',otherFaces=[dict(x=float(f['x']),y=float(f['y']),width=float(f['w']),height=float(f['h']))for f in deteccoes if math.hypot((f['x']-det['x'])/det['w'],(f['y']-det['y'])/det['h'])>=.4 or not .6<f['w']/det['w']<1.7])
                if _observations is not None:_observations.append(observation)
                if _image_observer is not None:_image_observer(observation, imagem_original, det.get('trackingPoint'))
            if detectou and det is None and _visual_missing_observer is not None:
                missing = dict(time=t, _visual_missing=True, otherFaces=[dict(x=float(f['x']), y=float(f['y']), width=float(f['w']), height=float(f['h'])) for f in deteccoes])
                _visual_missing_observer(missing, imagem_original, None)
            agora = time.time()
            if progresso is not None and agora - ultimo_aviso > 0.4:
                ultimo_aviso = agora
                progresso(min(1.0, max(0.0, (t - inicio) / duracao)), n + 1, (n + 1) / max(1e-6, agora - relogio))
    finally:
        if 'deteccao' in locals() and deteccao is not None:
            deteccao.fechar()
        if 'produtor' in locals() and produtor is not None:
            produtor.fechar()
        for parte in (locals().get('etapas') or []) + (locals().get('partes') or []):
            parte.fechar()
        for extra in locals().get('extras') or []:
            extra.release()
        cap.release()
    if escritor is not None:
        escritor.release()
    gasto = time.time() - relogio

    if len(amostras) < 2:
        raise ErroMotor('Nenhum quadro decodificado no intervalo %.3f–%.3f s. Confira os tempos e o arquivo.' % (inicio, fim))
    analisadas = [x for x in amostras if x['analisado']]
    t_pos = time.perf_counter()
    # Quadros pulados pelo passo entram na interpolação como lacunas curtas.
    segmentos = montar_segmentos(amostras, max(o['lacuna'], (passo + 0.5) / fps), referencia=o['referencia'])
    if not segmentos:
        raise ErroMotor('Nenhum rosto foi acompanhado com segurança neste take. Confira se o rosto aparece de frente no início.')
    principal = max(segmentos, key=lambda s: s[-1]['t'] - s[0]['t'])
    linhas = reamostrar(principal, inicio, fim, fps_seq, fps, referencia=o['referencia'])
    if len(linhas) < 2:
        raise ErroMotor('Trecho acompanhado curto demais para o Dynamic Anchor.')
    cobertura = min(1.0, (linhas[-1]['time'] - linhas[0]['time'] + 1.0 / fps_seq) / duracao)
    qualidade = medir_qualidade(linhas, fps_seq, rastreador.tempos_ambiguos)
    avisos = []
    if len(segmentos) > 1:
        avisos.append('O rosto foi perdido por mais de %.1f s; apenas o trecho contínuo mais longo foi usado.' % o['lacuna'])
    if rastreador.ambiguos:
        avisos.append('%d detecção(ões) ambígua(s) descartada(s).' % rastreador.ambiguos)
    if progresso is not None:
        progresso(1.0, len(amostras), len(amostras) / max(1e-6, gasto))
    segmentos_saida = [{'start': s[0]['t'], 'end': s[-1]['t'], 'samples': len(s), 'primary': s is principal,
                        'rows': [] if s is principal else reamostrar(s, inicio, fim, fps_seq, fps, referencia=o['referencia'])} for s in segmentos]
    crono.somar('pos', t_pos)
    parede, cpu = time.perf_counter() - relogio_total, time.process_time() - cpu_total
    resultado = {
        'format': FORMATO, 'version': 1, 'engine': MOTOR, 'engineVersion': VERSAO_MOTOR,
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'requestId': pedido.get('requestId'),
        'fileName': os.path.basename(video), 'mediaPath': os.path.abspath(video),
        'analysisSource': 'proxy' if proxy else 'original',
        'width': W, 'height': H, 'fps': fps_seq, 'mediaFps': fps,
        'inPoint': inicio, 'outPoint': fim,
        'selection': pedido.get('selection'),
        'target': o['alvo'] if isinstance(o['alvo'], str) else list(o['alvo']),
        'initialFaces': [{'x': round(x, 4), 'y': round(y, 4), 'chosen': c} for x, y, c in sorted(getattr(rastreador, 'iniciais', []))],
        'coverage': round(cobertura, 4), 'warnings': avisos, 'quality': qualidade,
        'stats': {
            'decodedFrames': len(amostras), 'analyzedFrames': len(analisadas),
            'detectedFrames': sum(1 for x in amostras if x['det'] is not None),
            'ambiguousFrames': rastreador.ambiguos, 'segments': len(segmentos),
            'identityGuard': {'method': 'co-visible-others-head-appearance-v1', 'refused': dict(rastreador.recusas),
                              'times': [list(x) for x in rastreador.tempos_recusa[:50]]},
            'interpolatedRows': sum(1 for r in linhas if r['source'] == 'interpolated'),
            'seconds': round(gasto, 2), 'framesPerSecond': round(len(amostras) / max(1e-6, gasto), 1),
            'step': passo, 'analysisWidth': o['analise'],
            # Instrumentação (só observa): tempo por etapa, CPU do processo e o que foi usado de fato.
            'timing': crono.resumo(parede, o['paralelo']) if medir else None,
            'cpu': {'processSeconds': round(cpu, 3), 'wallSeconds': round(parede, 3),
                    'ratio': round(cpu / max(1e-6, parede), 2)} if medir else None,
            'video': info_video,
        },
        # Todos os trechos encontrados, já na grade da sequência. O painel usa
        # 'rows' (o mais longo); os demais ficam para revisão e versões futuras.
        'segments': segmentos_saida,
        'rows': linhas,
    }
    if o['referencia'] == 'media5':
        resultado['version'] = 2
        resultado['trackingReference'] = referencia_saida
    if o['referencia'] == 'adaptativo':
        resultado['version'] = 2
        resultado['trackingReference'] = {'method': 'selected-face-center-v1', 'offset': {'x': 0., 'y': 0.}, 'sampling': {'method': 'fixed-stride-v1', 'step': passo}, 'fallback': {'method': 'bidirectional-lk', 'maxSeconds': .25}, 'smoothing': {'method': 'robust-local-quadratic-v1', 'windowSeconds': .14}}
        resultado['trackingReference']['stabilization'] = {'method':'visual-prediction-detector-correction-v1','correctionSeconds':.35,'maxBoxFraction':.25}
        resultado['stats']['faceMeasurements'] = adaptive.detector_samples
        resultado['stats']['visualMeasurements'] = adaptive.flow_samples
        resultado['stats']['rejectedVisualPredictions'] = adaptive.rejected_flow
        resultado['stats']['detectedFrames'] = adaptive.detector_samples
        for rows in [resultado['rows']] + [segment['rows'] for segment in resultado['segments'] if not segment['primary']]:
            from anchor_adaptive import smooth_reference
            smooth_reference(rows, fps_seq)
        resultado['stats']['referenceStrategy'] = 'selected-face-center-v1'
    return resultado


def resumo_tempos(st):
    """Linhas legíveis da instrumentação (CLI e registro do serviço)."""
    v, tm, cpu = st.get('video') or {}, st.get('timing') or {}, st.get('cpu') or {}
    linhas = ['Fonte: %s %sx%s %s fps · codec %s · backend %s · aceleração pedida %s, efetiva %s%s' % (
        v.get('source'), v.get('width'), v.get('height'), v.get('fps'), v.get('codec'), v.get('backend'),
        v.get('accelerationRequested'), v.get('acceleration'), ' (abriu sem aceleração)' if v.get('fallbackOpen') else '')]
    if tm.get('stages'):
        partes = ['%s %.1f s' % (e, d['seconds']) for e, d in tm['stages'].items() if d['count']]
        linhas.append('Tempos: ' + ' · '.join(partes) + ' · fora das etapas %.1f s · total %.1f s' % (
            tm.get('unaccountedSeconds', 0), tm.get('wallSeconds', 0)))
    if cpu:
        linhas.append('CPU do processo: %.1f s em %.1f s (%.2f× · %s threads OpenCV · %s CPUs) · OpenCL %s · CUDA %s · detector %s' % (
            cpu.get('processSeconds', 0), cpu.get('wallSeconds', 0), cpu.get('ratio', 0), v.get('opencvThreads'), v.get('cpus'),
            'em uso' if v.get('openclInUse') else ('disponível' if v.get('openclAvailable') else 'não'), v.get('cudaDevices'), v.get('detectorBackend')))
    return linhas


def main(argv=None):
    p = argparse.ArgumentParser(description='Dynamic Anchor — motor de rosto experimental')
    p.add_argument('--pedido', help='JSON gerado pelo painel (take, tempos, formato da sequência)')
    p.add_argument('--video', help='vídeo original (substitui o caminho do pedido)')
    p.add_argument('--proxy', help='proxy para análise mais rápida (mesma duração e proporção)')
    p.add_argument('--inicio', type=float, help='segundo inicial na mídia (entrada do take)')
    p.add_argument('--fim', type=float, help='segundo final na mídia (saída do take)')
    p.add_argument('--fps-sequencia', type=float, help='FPS da sequência (padrão: FPS do vídeo)')
    p.add_argument('--resolucao', help='LxA da sequência, ex.: 3840x2160 (padrão: resolução do vídeo original)')
    p.add_argument('--alvo', default='maior', help='maior (padrão), centro ou X,Y no primeiro quadro')
    p.add_argument('--perfil', choices=sorted(PERFIS), help='rapido, equilibrado (padrão) ou preciso')
    p.add_argument('--analise', type=int, help='largura usada na detecção (padrão 960)')
    p.add_argument('--passo', default='auto', help='detectar a cada N quadros (auto = ~30 detecções/s)')
    p.add_argument('--limiar', type=float, default=0.6, help='confiança mínima do detector (padrão 0,6)')
    p.add_argument('--lacuna', type=float, default=0.4, help='maior lacuna interpolada em segundos (padrão 0,4)')
    p.add_argument('--referencia', choices=('caixa', 'media5', 'video15'), default='caixa',
                   help='caixa/media5 (legados) ou video15 (EXPERIMENTAL: MediaPipe VIDEO + MM15)')
    p.add_argument('--saida', help='arquivo JSON de saída')
    p.add_argument('--previa', help='grava um MP4 pequeno com as caixas para conferência visual')
    p.add_argument('--sem-aceleracao', action='store_true', help='não tenta decodificação por hardware')
    p.add_argument('--sem-proxy', action='store_true', help='ignora o proxy informado pelo pedido')
    execucao = p.add_mutually_exclusive_group()
    execucao.add_argument('--paralelo', dest='paralelo', action='store_true',
                         help='decodifica enquanto detecta (padrão; compatibilidade com chamadas anteriores)')
    execucao.add_argument('--sequencial', dest='paralelo', action='store_false',
                         help='desliga a sobreposição de decodificação e detecção')
    p.set_defaults(paralelo=PADROES['paralelo'])
    a = p.parse_args(argv)

    pedido = dict(ler_pedido(a.pedido)) if a.pedido else {}
    if a.video:
        pedido['mediaPath'] = a.video
    if a.proxy:
        pedido['proxyPath'] = a.proxy
    if a.inicio is not None:
        pedido['inPoint'] = a.inicio
    if a.fim is not None:
        pedido['outPoint'] = a.fim
    if a.fps_sequencia:
        pedido['fps'] = a.fps_sequencia
    if a.resolucao:
        pedido['width'], pedido['height'] = [int(v) for v in a.resolucao.lower().split('x')]
    if not pedido.get('mediaPath') and not pedido.get('proxyPath'):
        raise ErroMotor('Informe --video (o pedido não trouxe o caminho da mídia).')
    if pedido.get('inPoint') is None or pedido.get('outPoint') is None:
        raise ErroMotor('Informe --inicio e --fim (segundos da mídia) ou use --pedido.')
    if pedido.get('proxyPath') and not a.sem_proxy and os.path.isfile(pedido['proxyPath']):
        print('Usando o proxy para a análise: %s' % pedido['proxyPath'])
    opcoes = {'alvo': a.alvo, 'passo': a.passo if a.passo == 'auto' else int(a.passo), 'limiar': a.limiar,
              'lacuna': a.lacuna, 'previa': a.previa, 'aceleracao': not a.sem_aceleracao, 'usar_proxy': not a.sem_proxy,
              'paralelo': a.paralelo, 'referencia': a.referencia}
    if a.perfil:
        opcoes['perfil'] = a.perfil
    if a.analise:
        opcoes['analise'] = a.analise

    def mostrar(fracao, n, qps):
        sys.stdout.write('\r%5.1f%%  %d quadros  %.1f quadros/s   ' % (fracao * 100, n, qps))
        sys.stdout.flush()

    resultado = executar(pedido, opcoes, progresso=mostrar)
    sys.stdout.write('\n')
    saida = a.saida or (os.path.splitext(a.pedido)[0] + '.rosto.json' if a.pedido else 'Anchor-rosto.json')
    with open(saida, 'w', encoding='utf-8') as f:
        json.dump(resultado, f, ensure_ascii=False)
    linhas, st = resultado['rows'], resultado['stats']
    print('Trajeto gravado: %s' % saida)
    print('Acompanhado: %.2f–%.2f s (%.0f%% do take) · %d linhas · %d trecho(s) encontrado(s)' % (
        linhas[0]['time'], linhas[-1]['time'], resultado['coverage'] * 100, len(linhas), st['segments']))
    print('Velocidade: %.1f quadros/s (%.1f s no total) · passo %d · análise %d px' % (
        st['framesPerSecond'], st['seconds'], st['step'], st['analysisWidth']))
    for linha in resumo_tempos(st):
        print(linha)
    if len(resultado['initialFaces']) > 1:
        print('Rostos no início do take (use --alvo X,Y para escolher outro):')
        for f in resultado['initialFaces']:
            print('  %s --alvo %.3f,%.3f' % ('-> ALVO' if f['chosen'] else '        ', f['x'], f['y']))
    for aviso in resultado['warnings']:
        print('AVISO: ' + aviso)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ErroMotor as erro:
        sys.stderr.write('ERRO: %s\n' % erro)
        sys.exit(2)
