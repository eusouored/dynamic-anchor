"""Head-only ORT configuration. No global monkeypatch or cross-session lock.

YuNet stays on OpenCV CPU. The head worker owns its session; its caller runs
one inference at a time, as in the original pipeline.
"""


def session_options(ort, dml=False):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 6
    options.inter_op_num_threads = 1
    if dml:
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_free_dimension_override_by_name('batch_size', 1)
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
    return options


def create_session(ort, path, dml=False):
    providers = ['DmlExecutionProvider', 'CPUExecutionProvider'] if dml else ['CPUExecutionProvider']
    session = ort.InferenceSession(str(path), session_options(ort, dml), providers=providers)
    # Keep CPU fallback explicit in HeadParser's metadata.
    session.disable_fallback()
    if dml:
        if session.get_providers()[0] != 'DmlExecutionProvider':
            raise RuntimeError('Head DML was not selected')
        if session.get_inputs()[0].shape != [1, 3, 512, 512]:
            raise RuntimeError('Head fixed input shape mismatch')
    return session
