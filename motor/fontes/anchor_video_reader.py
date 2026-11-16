"""Leitura de vídeo da análise de cabeça.

Até o motor anterior havia aqui um leitor MJPEG opcional feito com PyAV, que só
decodificava os quadros usados. A FFmpeg que vinha com o PyAV era ligada a
libx264/libx265 (GPL), então o PyAV saiu do motor. Todo vídeo, de qualquer codec,
passa pelo leitor do OpenCV (FFmpeg LGPL de opencv_videoio_ffmpeg): o mesmo que já
lia os outros codecs e que era a reserva do MJPEG quando o leitor opcional recusava.

As duas funções continuam com a mesma assinatura para anchor_head e anchor_rosto.
"""


def execute_head(callback, *args):
    return callback(*args)


def maybe_select(path, original, fps, width, height, info):
    return original, fps, width, height, info
